import { describe, expect, it, vi } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { PostgresContextCompiler } from "../src/retrieval/context-compiler.js";
import { JevRelevanceRanker, type RelevanceRanker } from "../src/retrieval/jev-ranker.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const policy = new ProposalPolicy({
  autoApproveNewTasks: true,
  autoApproveContext: true,
  requireReviewForTaskChanges: true,
});

describe("Jev entry ranking", () => {
  it("sends only bounded accepted entry text and validates a pinned response", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store, policy);
    const entry = await ledger.createContextEntry({
      kind: "file", path: "/allowed/architecture.md", title: "Architecture", body: "Architecture ".repeat(300),
    }, "user:reviewer");
    const fetcher = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body));
      expect(payload.model).toBe("typesafe/jev-1.13");
      expect(payload.state.text.length).toBe(1_500);
      expect(payload.questions.relevant.type).toBe("noul");
      return new Response(JSON.stringify({ model: "typesafe/jev-1.13-20260917", answers: { relevant: { noul: 0.84 } } }), { status: 200 });
    });
    const ranker = new JevRelevanceRanker({ apiKey: "test-only", fetcher: fetcher as typeof fetch });
    const result = await ranker.rank("Which architecture applies?", [entry]);
    expect(result.scores.get(entry.id)).toBe(0.84);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("blocks credential-bearing text before any external request", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store, policy);
    const entry = await ledger.createContextEntry({
      kind: "fact", path: "/allowed/secret", title: "Credential", factType: "other",
      value: "password: abcdefghijklmnopqrstuvwxyz1234",
    }, "user:reviewer");
    const fetcher = vi.fn();
    const ranker = new JevRelevanceRanker({ apiKey: "test-only", fetcher: fetcher as typeof fetch });
    await expect(ranker.rank("password policy", [entry])).rejects.toThrow("credential screen");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("blocks credential-bearing questions before any external request", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store, policy);
    const entry = await ledger.createContextEntry({
      kind: "fact", path: "/allowed/decision", title: "Decision", factType: "decision", value: "Allowed.",
    }, "user:reviewer");
    const fetcher = vi.fn();
    const ranker = new JevRelevanceRanker({ apiKey: "test-only", fetcher: fetcher as typeof fetch });
    await expect(ranker.rank("What uses secret: abcdefghijklmnopqrstuvwxyz1234?", [entry])).rejects.toThrow("credential screen");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("ranks only authorized entries and leaves final authorization with Panini", async () => {
    const store = new MemoryLedgerStore();
    const seen: string[][] = [];
    const ranker: RelevanceRanker = {
      async rank(_question, entries) {
        seen.push(entries.map((entry) => entry.path));
        return { model: "jev-1.13.0", scores: new Map(entries.map((entry) => [entry.id, 0.9])) };
      },
    };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker));
    await ledger.createContextEntry({ kind: "fact", path: "/allowed/decision", title: "Allowed decision", factType: "decision", value: "Allowed." }, "user:reviewer");
    await ledger.createContextEntry({ kind: "fact", path: "/private/decision", title: "Private decision", factType: "decision", value: "Private." }, "user:reviewer");
    const member = (await ledger.workspace()).members[0]!;
    const enrollment = await ledger.createAgentProfile({
      memberId: member.id, name: "Scoped agent", harness: "codex",
      capabilities: ["context:read", "work:read"],
      dataScope: { projects: [], contextPaths: ["/allowed"], sourceVisibilities: ["company"] },
    });
    const pack = await ledger.retrieve({
      access: {
        kind: "agent", organizationId: member.organizationId, memberId: member.id,
        agentProfileId: enrollment.profile.id, dataScope: enrollment.profile.dataScope,
      },
      objective: "What is the decision?", query: "decision", characterBudget: 8_000,
    });
    expect(seen).toEqual([["/allowed/decision"]]);
    expect(pack.provider).toBe("jev");
    expect(pack.manifest.rankingModel).toBe("jev-1.13.0");
    expect(pack.entries.map((entry) => entry.path)).toEqual(["/allowed/decision"]);
    expect(pack.outline.flatMap((section) => section.entries.map((entry) => entry.path))).toEqual(["/allowed/decision"]);
  });

  it("falls back to PostgreSQL ranking on a model error", async () => {
    const store = new MemoryLedgerStore();
    const ranker: RelevanceRanker = { async rank() { throw new Error("simulated outage"); } };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker));
    await ledger.createContextEntry({ kind: "fact", path: "/decisions/edge", title: "Edge", factType: "decision", value: "No propagation." }, "user:reviewer");
    const pack = await ledger.retrieve({ objective: "edge", query: "edge" });
    expect(pack.provider).toBe("postgres");
    expect(pack.entries.map((entry) => entry.path)).toEqual(["/decisions/edge"]);
  });

  it("uses Jev relevance per character so one long file cannot crowd out a relevant fact", async () => {
    const store = new MemoryLedgerStore();
    const ranker: RelevanceRanker = {
      async rank(_question, entries) {
        return { model: "jev-1.13.0", scores: new Map(entries.map((entry) => [entry.id, entry.kind === "file" ? 0.9 : 0.8])) };
      },
    };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker));
    await ledger.createContextEntry({
      kind: "file", path: "/sources/context.md", title: "Long context", body: "Relevant source context. ".repeat(500),
    }, "user:reviewer");
    const fact = await ledger.createContextEntry({
      kind: "fact", path: "/decisions/edge", title: "Edge decision", factType: "decision", value: "No propagation before calibration.",
    }, "user:reviewer");
    const pack = await ledger.retrieve({ objective: "edge propagation", characterBudget: 8_000 });
    expect(pack.provider).toBe("jev");
    expect(pack.entries[0]?.id).toBe(fact.id);
  });

  it("fails closed if the agent is revoked while Jev ranks", async () => {
    const store = new MemoryLedgerStore();
    let revoke: () => Promise<void> = async () => {};
    const ranker: RelevanceRanker = {
      async rank(_question, entries) {
        await revoke();
        return { model: "jev-1.13.0", scores: new Map(entries.map((entry) => [entry.id, 0.9])) };
      },
    };
    const ledger = new TeamLedger(store, policy, new PostgresContextCompiler(store, undefined, ranker));
    await ledger.createContextEntry({ kind: "fact", path: "/allowed/decision", title: "Allowed", factType: "decision", value: "Yes." }, "user:reviewer");
    const member = (await ledger.workspace()).members[0]!;
    const enrollment = await ledger.createAgentProfile({
      memberId: member.id, name: "Scoped agent", harness: "codex",
      capabilities: ["context:read", "work:read"],
      dataScope: { projects: [], contextPaths: ["/allowed"], sourceVisibilities: ["company"] },
    });
    revoke = async () => { await ledger.revokeAgentProfile(enrollment.profile.id); };
    await expect(ledger.retrieve({
      access: {
        kind: "agent", organizationId: member.organizationId, memberId: member.id,
        agentProfileId: enrollment.profile.id, dataScope: enrollment.profile.dataScope,
      }, objective: "decision",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
