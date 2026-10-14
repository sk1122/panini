import { describe, expect, it, vi } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { ContextFile } from "../src/domain/types.js";
import { PostgresContextCompiler } from "../src/retrieval/context-compiler.js";
import { EmbeddingDocumentRanker, type SemanticDocumentRanker } from "../src/retrieval/embedding-document-ranker.js";
import type { RelevanceRanker } from "../src/retrieval/jev-ranker.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const policy = new ProposalPolicy({
  autoApproveNewTasks: true,
  autoApproveContext: true,
  requireReviewForTaskChanges: true,
});

describe("embedding candidate selection followed by Jev", () => {
  it("sends Jev a semantic file shortlist plus accepted facts", async () => {
    const store = new MemoryLedgerStore();
    const seen: string[][] = [];
    const ranker: RelevanceRanker = {
      async rank(_question, entries) {
        seen.push(entries.map((entry) => entry.path));
        return { model: "jev-1.13.0", scores: new Map(entries.map((entry) => [entry.id, 0.8])) };
      },
    };
    const semantic: SemanticDocumentRanker = {
      model: "openai/text-embedding-3-small",
      async rank(_question, files) {
        return new Map(files.map((entry, index) => [entry.id, index / files.length]));
      },
    };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker, semantic));
    for (let index = 0; index < 22; index += 1) {
      await ledger.createContextEntry({
        kind: "file", path: `/notes/document-${String(index).padStart(2, "0")}.md`,
        title: `Document ${index}`, body: `Distinct source material ${index}.`,
      }, "user:reviewer");
    }
    await ledger.createContextEntry({
      kind: "fact", path: "/decisions/blueprint", title: "Blueprint decision",
      factType: "decision", value: "The blueprint is accepted.",
    }, "user:reviewer");

    const pack = await ledger.retrieve({ objective: "blueprint", query: "blueprint", characterBudget: 8_000 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(17);
    expect(seen[0]).toContain("/decisions/blueprint");
    expect(seen[0]).toContain("/notes/document-21.md");
    expect(seen[0]).not.toContain("/notes/document-00.md");
    expect(pack.provider).toBe("embedding_jev");
    expect(pack.manifest).toMatchObject({
      provider: "embedding_jev", rankingModel: "jev-1.13.0", embeddingModel: "openai/text-embedding-3-small",
    });
    expect(pack.omitted).toContainEqual({ reason: "candidate_limit", count: 6 });
  });

  it("never sends hidden context to the embedding search or Jev", async () => {
    const store = new MemoryLedgerStore();
    const seenSemantic: string[][] = [];
    const seenJev: string[][] = [];
    const semantic: SemanticDocumentRanker = {
      model: "openai/text-embedding-3-small",
      async rank(_question, files) {
        seenSemantic.push(files.map((entry) => entry.path));
        return new Map(files.map((entry) => [entry.id, 0.9]));
      },
    };
    const ranker: RelevanceRanker = {
      async rank(_question, entries) {
        seenJev.push(entries.map((entry) => entry.path));
        return { model: "jev-1.13.0", scores: new Map(entries.map((entry) => [entry.id, 0.9])) };
      },
    };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker, semantic));
    await ledger.createContextEntry({ kind: "file", path: "/allowed/plan.md", title: "Plan", body: "Allowed plan." }, "user:reviewer");
    await ledger.createContextEntry({ kind: "file", path: "/hidden/plan.md", title: "Hidden", body: "Hidden plan." }, "user:reviewer");
    const member = (await ledger.workspace()).members[0]!;
    const enrollment = await ledger.createAgentProfile({
      memberId: member.id, name: "Scoped agent", harness: "codex",
      capabilities: ["context:read", "work:read"],
      dataScope: { projects: [], contextPaths: ["/allowed"], sourceVisibilities: ["company"] },
    });
    const pack = await ledger.retrieve({
      objective: "plan", query: "plan", characterBudget: 8_000,
      access: {
        kind: "agent", organizationId: member.organizationId, memberId: member.id,
        agentProfileId: enrollment.profile.id, dataScope: enrollment.profile.dataScope,
      },
    });
    expect(seenSemantic).toEqual([["/allowed/plan.md"]]);
    expect(seenJev).toEqual([["/allowed/plan.md"]]);
    expect(pack.entries.map((entry) => entry.path)).toEqual(["/allowed/plan.md"]);
  });

  it("rechecks a file revoked during embedding before sending content to Jev", async () => {
    const store = new MemoryLedgerStore();
    let sourceEventId = "";
    const semantic: SemanticDocumentRanker = {
      model: "openai/text-embedding-3-small",
      async rank(_question, files) {
        await store.revokeSourceEvent(sourceEventId);
        return new Map(files.map((entry) => [entry.id, 0.9]));
      },
    };
    const ranker: RelevanceRanker = { rank: vi.fn(async () => ({ model: "jev-1.13.0", scores: new Map() })) };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker, semantic));
    const file = await ledger.createContextEntry({
      kind: "file", path: "/allowed/plan.md", title: "Plan", body: "Revocable plan.",
    }, "user:reviewer");
    sourceEventId = file.sourceEventId;
    const pack = await ledger.retrieve({ objective: "plan", query: "plan" });
    expect(ranker.rank).not.toHaveBeenCalled();
    expect(pack.entries).toEqual([]);
  });

  it("keeps Jev retrieval available when query embedding fails", async () => {
    const store = new MemoryLedgerStore();
    const seen: string[][] = [];
    const semantic: SemanticDocumentRanker = {
      model: "openai/text-embedding-3-small", async rank() { throw new Error("OpenRouter unavailable"); },
    };
    const ranker: RelevanceRanker = {
      async rank(_question, entries) {
        seen.push(entries.map((entry) => entry.path));
        return { model: "jev-1.13.0", scores: new Map(entries.map((entry) => [entry.id, 0.9])) };
      },
    };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker, semantic));
    await ledger.createContextEntry({ kind: "file", path: "/allowed/plan.md", title: "Plan", body: "Fallback plan." }, "user:reviewer");
    const pack = await ledger.retrieve({ objective: "plan", query: "plan" });
    expect(seen).toEqual([["/allowed/plan.md"]]);
    expect(pack.provider).toBe("jev");
  });
});

describe("query embedding", () => {
  it("embeds only the question and searches only authorized files", async () => {
    const files: ContextFile[] = [{
      kind: "file", id: "file-1", sourceEventId: "event-1", sourceRef: "source-1", path: "/allowed/plan.md",
      title: "Plan", body: "Private document text", sourceUrl: null, contentHash: "hash", evidenceIds: ["event-1"],
      lifecycleState: "accepted", effectiveFrom: "2026-01-01T00:00:00.000Z", effectiveTo: null, links: [],
      updatedAt: "2026-01-01T00:00:00.000Z",
    }];
    const embed = vi.fn(async () => [[1, 0]]);
    const search = vi.fn(async () => new Map([["file-1", 0.91]]));
    const ranker = new EmbeddingDocumentRanker({ search }, { model: "test-model", embed });
    expect(await ranker.rank("Which plan applies?", files)).toEqual(new Map([["file-1", 0.91]]));
    expect(embed).toHaveBeenCalledWith(["Which plan applies?"]);
    expect(search).toHaveBeenCalledWith("test-model", [1, 0], files);
    await expect(ranker.rank("password: thisisalongsecret123", files)).rejects.toThrow("credential screen");
    expect(embed).toHaveBeenCalledTimes(1);
  });
});
