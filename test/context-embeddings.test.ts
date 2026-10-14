import { describe, expect, it, vi } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { ContextFile } from "../src/domain/types.js";
import type { ContextEmbeddingIndex, IndexedContextDocument } from "../src/retrieval/context-embedding-index.js";
import { ContextEmbeddingIndexer, chunkDocument } from "../src/retrieval/context-embedding-indexer.js";
import type { EmbeddingAdapter } from "../src/retrieval/embedding-adapter.js";
import { OpenRouterEmbeddingAdapter } from "../src/retrieval/openrouter-embedding-adapter.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

interface FakeRow extends IndexedContextDocument { model: string; vectors: number[][] }

class FakeIndex implements ContextEmbeddingIndex {
  readonly rows = new Map<string, FakeRow>();

  async list(model: string): Promise<IndexedContextDocument[]> {
    return [...this.rows.values()].filter((row) => row.entryId && row.model === model);
  }

  async replace(entry: ContextFile, model: string, inputHash: string, vectors: number[][]): Promise<boolean> {
    this.rows.set(entry.id, { entryId: entry.id, model, inputHash, vectors });
    return true;
  }

  async prune(model: string, ids: string[]): Promise<number> {
    let count = 0;
    for (const [id, row] of this.rows) {
      if (!ids.includes(id) || row.model !== model) {
        this.rows.delete(id);
        count += 1;
      }
    }
    return count;
  }

  async search(model: string, _queryVector: number[], files: ContextFile[]): Promise<Map<string, number>> {
    return new Map(files.flatMap((file) => {
      const row = this.rows.get(file.id);
      return row?.model === model ? [[file.id, 0.8] as const] : [];
    }));
  }
}

describe("OpenRouter embedding adapter", () => {
  it("sends a batch to the documented endpoint and restores index order", async () => {
    const fetcher = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.headers).toMatchObject({ authorization: "Bearer test-key" });
      expect(JSON.parse(options.body as string)).toEqual({
        model: "voyageai/voyage-4", input: ["first", "second"],
      });
      return new Response(JSON.stringify({
          model: "voyage-4",
        data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }],
      }), { status: 200 });
    });
    const adapter = new OpenRouterEmbeddingAdapter({ apiKey: "test-key", fetcher: fetcher as typeof fetch });
    expect(await adapter.embed(["first", "second"])).toEqual([[1, 0], [0, 1]]);
    expect(fetcher).toHaveBeenCalledWith("https://openrouter.ai/api/v1/embeddings", expect.any(Object));
  });

  it("rejects missing, mixed-dimension, and wrong-model responses", async () => {
    for (const data of [
      [{ index: 0, embedding: [1] }],
      [{ index: 0, embedding: [1] }, { index: 1, embedding: [1, 0] }],
    ]) {
      const adapter = new OpenRouterEmbeddingAdapter({
        apiKey: "test-key",
        fetcher: vi.fn(async () => new Response(JSON.stringify({
          model: "openai/text-embedding-3-small", data,
        }), { status: 200 })) as typeof fetch,
      });
      await expect(adapter.embed(["a", "b"])).rejects.toThrow();
    }
    const wrongModel = new OpenRouterEmbeddingAdapter({
      apiKey: "test-key",
      fetcher: vi.fn(async () => new Response(JSON.stringify({
        model: "different-model", data: [{ index: 0, embedding: [1] }],
      }), { status: 200 })) as typeof fetch,
    });
    await expect(wrongModel.embed(["a"])).rejects.toThrow();
  });
});

describe("context embedding indexer", () => {
  it("chunks long files without losing text between chunks", () => {
    const value = "x".repeat(6_200);
    const chunks = chunkDocument(value);
    expect(chunks.length).toBe(3);
    expect(chunks[0]!.slice(-200)).toBe(chunks[1]!.slice(0, 200));
    expect(chunks[1]!.slice(-200)).toBe(chunks[2]!.slice(0, 200));
  });

  it("indexes accepted files only, skips credentials, reindexes revisions, and prunes revocations", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store, new ProposalPolicy({
      autoApproveNewTasks: true, autoApproveContext: true, requireReviewForTaskChanges: true,
    }));
    const file = await ledger.createContextEntry({
      kind: "file", path: "/research/plan.md", title: "Plan", body: "The first accepted plan.",
    }, "user:reviewer");
    await ledger.createContextEntry({
      kind: "fact", path: "/decisions/plan", title: "Plan fact", factType: "decision", value: "Use the plan.",
    }, "user:reviewer");
    await ledger.createContextEntry({
      kind: "file", path: "/research/draft.md", title: "Draft", body: "Not yet accepted.", lifecycleState: "needs_review",
    }, "user:reviewer");
    await ledger.createContextEntry({
      kind: "file", path: "/research/secret.md", title: "Secret", body: "password: verylongsecretvalue12345",
    }, "user:reviewer");
    const index = new FakeIndex();
    const embed = vi.fn(async (texts: readonly string[]) => texts.map(() => [1, 2]));
    const adapter: EmbeddingAdapter = { model: "openai/text-embedding-3-small", embed };
    const log = { info: vi.fn(), error: vi.fn() };
    const indexer = new ContextEmbeddingIndexer(store, index, adapter, log);

    expect(await indexer.syncOnce()).toMatchObject({ indexed: 1, skippedSensitive: 1, failed: 0 });
    expect(index.rows.size).toBe(1);
    expect(embed).toHaveBeenCalledWith(["Plan\nThe first accepted plan."]);
    expect(await indexer.syncOnce()).toMatchObject({ indexed: 0, unchanged: 1 });

    const revised = await ledger.createContextEntry({
      kind: "file", path: "/research/plan.md", title: "Plan", body: "The revised accepted plan.",
    }, "user:reviewer");
    expect(revised.id).toBe(file.id);
    expect(await indexer.syncOnce()).toMatchObject({ indexed: 1, unchanged: 0 });
    expect(embed).toHaveBeenLastCalledWith(["Plan\nThe revised accepted plan."]);

    await ledger.revokeEvidence(revised.sourceEventId, "user:reviewer");
    expect(await indexer.syncOnce()).toMatchObject({ indexed: 0, pruned: 1 });
    expect(index.rows.size).toBe(0);
  });
});
