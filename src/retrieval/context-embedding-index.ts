import { createHash } from "node:crypto";
import pg from "pg";
import type { ContextFile } from "../domain/types.js";

const { Pool } = pg;

export interface IndexedContextDocument {
  entryId: string;
  inputHash: string;
}

export interface ContextEmbeddingIndex {
  list(model: string): Promise<IndexedContextDocument[]>;
  replace(entry: ContextFile, model: string, inputHash: string, vectors: number[][]): Promise<boolean>;
  prune(model: string, eligibleEntryIds: string[]): Promise<number>;
  search(model: string, queryVector: number[], authorizedFiles: ContextFile[]): Promise<Map<string, number>>;
}

export function embeddingInput(entry: Pick<ContextFile, "title" | "body">): string {
  return `${entry.title}\n${entry.body}`;
}

export function embeddingInputHash(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

interface IndexRow extends pg.QueryResultRow {
  context_entry_id: string;
  input_hash: string;
}

interface VectorRow extends IndexRow {
  vectors: unknown;
}

function cosine(left: number[], right: number[], leftMagnitude: number): number | null {
  if (left.length !== right.length) return null;
  let dot = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    const value = right[index];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    dot += left[index]! * value;
    rightSquared += value * value;
  }
  return rightSquared > 0 ? dot / (leftMagnitude * Math.sqrt(rightSquared)) : null;
}

/** Rebuildable vectors only. Context text and authorization stay in the ledger. */
export class PostgresContextEmbeddingIndex implements ContextEmbeddingIndex {
  private readonly pool: pg.Pool;

  constructor(databaseUrl: string, private readonly organizationId: string) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async list(model: string): Promise<IndexedContextDocument[]> {
    const result = await this.pool.query<IndexRow>(
      "SELECT context_entry_id, input_hash FROM context_document_embeddings WHERE organization_id=$1 AND model=$2",
      [this.organizationId, model],
    );
    return result.rows.map((row) => ({ entryId: row.context_entry_id, inputHash: row.input_hash }));
  }

  async replace(entry: ContextFile, model: string, inputHash: string, vectors: number[][]): Promise<boolean> {
    if (vectors.length === 0 || vectors.some((vector) => vector.length !== vectors[0]!.length ||
        vector.some((value) => !Number.isFinite(value)))) {
      throw new Error("Cannot store empty or inconsistent document embeddings.");
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const current = await client.query<{ title: string; body: string; evidence_ids: string[]; source_event_id: string }>(
        `SELECT ce.title, ce.body, ce.evidence_ids, ce.source_event_id FROM context_entries ce
           JOIN source_events se ON se.id=ce.source_event_id AND se.content_state='active'
          WHERE ce.organization_id=$1 AND ce.id=$2 AND ce.kind='file'
            AND ce.lifecycle_state='accepted' AND ce.effective_from<=now()
            AND (ce.effective_to IS NULL OR ce.effective_to>now())
          FOR SHARE OF ce, se`,
        [this.organizationId, entry.id],
      );
      const row = current.rows[0];
      if (!row || embeddingInputHash(embeddingInput(row)) !== inputHash) {
        await client.query("ROLLBACK");
        return false;
      }
      const evidence = await client.query<{ id: string }>(
        "SELECT id FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[]) AND content_state='active' FOR SHARE",
        [this.organizationId, row.evidence_ids],
      );
      if (row.evidence_ids.length === 0 || !row.evidence_ids.includes(row.source_event_id) ||
          evidence.rows.length !== new Set(row.evidence_ids).size) {
        await client.query("ROLLBACK");
        return false;
      }
      await client.query(
        `INSERT INTO context_document_embeddings
          (organization_id, context_entry_id, model, input_hash, vectors, updated_at)
         VALUES ($1,$2,$3,$4,$5::jsonb,now())
         ON CONFLICT (organization_id, context_entry_id) DO UPDATE SET
           model=excluded.model, input_hash=excluded.input_hash,
           vectors=excluded.vectors, updated_at=now()`,
        [this.organizationId, entry.id, model, inputHash, JSON.stringify(vectors)],
      );
      await client.query("COMMIT");
      return true;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async prune(model: string, eligibleEntryIds: string[]): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM context_document_embeddings idx
        WHERE idx.organization_id=$1
          AND (idx.model<>$2 OR NOT (idx.context_entry_id=ANY($3::uuid[]))
            OR NOT EXISTS (
              SELECT 1 FROM context_entries ce
              JOIN source_events se ON se.id=ce.source_event_id AND se.content_state='active'
              WHERE ce.organization_id=$1 AND ce.id=idx.context_entry_id AND ce.kind='file'
                AND ce.lifecycle_state='accepted' AND ce.effective_from<=now()
                AND (ce.effective_to IS NULL OR ce.effective_to>now())
            ))`,
      [this.organizationId, model, eligibleEntryIds],
    );
    return result.rowCount ?? 0;
  }

  async search(model: string, queryVector: number[], authorizedFiles: ContextFile[]): Promise<Map<string, number>> {
    const scores = new Map<string, number>();
    if (authorizedFiles.length === 0) return scores;
    if (queryVector.length === 0 || queryVector.some((value) => !Number.isFinite(value))) {
      throw new Error("Invalid query embedding.");
    }
    const magnitude = Math.hypot(...queryVector);
    if (magnitude === 0) throw new Error("Zero query embedding.");
    const byId = new Map(authorizedFiles.map((entry) => [entry.id, entry]));
    const result = await this.pool.query<VectorRow>(
      `SELECT context_entry_id, input_hash, vectors FROM context_document_embeddings
        WHERE organization_id=$1 AND model=$2 AND context_entry_id=ANY($3::uuid[])`,
      [this.organizationId, model, [...byId.keys()]],
    );
    for (const row of result.rows) {
      const current = byId.get(row.context_entry_id);
      if (!current || row.input_hash !== embeddingInputHash(embeddingInput(current)) || !Array.isArray(row.vectors)) continue;
      let best = -Infinity;
      for (const vector of row.vectors) {
        if (!Array.isArray(vector)) continue;
        const similarity = cosine(queryVector, vector, magnitude);
        if (similarity !== null) best = Math.max(best, similarity);
      }
      if (Number.isFinite(best)) scores.set(row.context_entry_id, best);
    }
    return scores;
  }

  close(): Promise<void> { return this.pool.end(); }
}
