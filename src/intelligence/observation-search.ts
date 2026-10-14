import { chunkDocument } from "../retrieval/context-embedding-indexer.js";
import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import { containsCredentialLikeText } from "../retrieval/external-text-policy.js";
import type { WorkEmbeddings } from "./work-embeddings.js";

function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) throw new Error("Embedding dimensions differ");
  let dot = 0, aa = 0, bb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i]! * b[i]!; aa += a[i]! ** 2; bb += b[i]! ** 2; }
  if (!aa || !bb) throw new Error("Embedding vector is empty");
  return dot / Math.sqrt(aa * bb);
}

/** Embeddings rank authorized canonical records. The observation agent decides their meaning. */
export async function searchObservationRecords<T extends { id: string }>(input: {
  store: LedgerStore; embeddings: WorkEmbeddings; kind: "task" | "context";
  candidates: T[]; text: (record: T) => string; sourceIds: (record: T) => Promise<string[]>;
  query: string; limit: number; runId: string; budgetId: string; eventId: string;
  allowedVisibilities: string[];
}): Promise<T[]> {
  if (!input.query.trim()) throw new Error("Embedding search requires a query");
  const safe = input.candidates.map(record => ({ record, text: input.text(record) }))
    .filter(item => item.text.trim() && !containsCredentialLikeText(item.text));
  if (!safe.length) return [];
  const embeddings = input.embeddings;
  const vectors = new Map<string, number[][]>();
  const add = (id: string, vector: number[]) => {
    const chunks = vectors.get(id) ?? []; chunks.push(vector); vectors.set(id, chunks);
  };
  const missing = [];
  for (const item of safe) {
    const sourceIds = [...new Set(await input.sourceIds(item.record))].sort();
    for (const text of chunkDocument(item.text)) {
      const key = { entityType: input.kind, entityId: item.record.id, model: embeddings.model,
        modelVersion: embeddings.modelVersion, inputHash: contentHash({ chunkVersion: 1, text }),
        permissionFingerprint: contentHash({ visibilities: [...input.allowedVisibilities].sort(), sourceIds }) };
      const cached = await input.store.getWorkEntityEmbedding(key);
      if (cached?.length === embeddings.dimensions) add(item.record.id, cached);
      else missing.push({ record: item.record, text, key, sourceIds });
    }
  }
  // Keep each input and the total request comfortably below Voyage's token limits.
  for (let start = 0; start < missing.length; start += 16) {
    const batch = missing.slice(start, start + 16);
    const embedded = await embeddings.embed({ texts: batch.map(item => item.text),
      runId: input.runId, budgetId: input.budgetId, purpose: "documents",
      contextualSourceEventIds: [...new Set(batch.flatMap(item => item.sourceIds))] });
    for (const [index, item] of batch.entries()) {
      const vector = embedded[index];
      if (!vector || vector.length !== embeddings.dimensions) throw new Error("Document embedding unavailable");
      await input.store.putWorkEntityEmbedding({ ...item.key, vector });
      add(item.record.id, vector);
    }
  }
  const queryKey = { entityType: "query" as const, entityId: input.eventId,
    model: embeddings.model, modelVersion: embeddings.modelVersion, inputHash: contentHash(input.query),
    permissionFingerprint: contentHash({ visibilities: [...input.allowedVisibilities].sort(),
      accessVersion: await input.store.getEvidenceAccessVersion() }) };
  let query = await input.store.getWorkEntityEmbedding(queryKey);
  if (!query || query.length !== embeddings.dimensions) {
    const [embeddedQuery] = await embeddings.embed({ texts: [input.query], runId: input.runId,
      budgetId: input.budgetId, purpose: "query" });
    query = embeddedQuery ?? null;
    if (!query || query.length !== embeddings.dimensions) throw new Error("Query embedding unavailable");
    await input.store.putWorkEntityEmbedding({ ...queryKey, vector: query });
  }
  return safe.map(item => ({ record: item.record, score: Math.max(...vectors.get(item.record.id)!.map(vector => cosine(query, vector))) }))
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))
    .slice(0, input.limit).map(item => item.record);
}
