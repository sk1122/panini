import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { SourceEvent } from "../src/domain/types.js";
import type { JevWorkJudge } from "../src/reconciliation/jev-work-judge.js";
import { TaskStatusSuggestionEngine, statusEvidence } from "../src/reconciliation/task-status-suggestions.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

function setup() {
  const store = new MemoryLedgerStore();
  const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
    autoApproveContext: false, requireReviewForTaskChanges: true }));
  return { store, ledger };
}

async function add(store: MemoryLedgerStore, provider: string, id: string, text: string,
  eventKind = provider === "notion" ? "source.document.retrieved" : "message.observed"): Promise<SourceEvent> {
  const now = new Date().toISOString();
  return (await store.appendSourceEvent({ provider, installationKey: "test", providerEventId: id,
    eventKind, occurredAt: now, fetchedAt: now, sourceRef: `${provider}:${id}`, sourceUrl: null,
    contentHash: id, visibility: "company", payloadVersion: "test", payload: { text } })).event;
}

describe("generic task status suggestions", () => {
  it("ignores the old Notion board as status evidence", async () => {
    const { store, ledger } = setup();
    const task = await ledger.createTask({ title: "Verify trigger implementation" }, "user:reviewer");
    const row = await add(store, "notion", "row-1", "Verify trigger implementation. Status: Done", "snapshot.retrieved");
    expect(statusEvidence(task, [row], ["company"])).toEqual([]);
  });

  it("makes a pending done proposal only from supported cross-provider verification", async () => {
    const { store, ledger } = setup();
    const task = await ledger.createTask({ title: "Verify trigger implementation", status: "planned" }, "user:reviewer");
    const merged = await add(store, "github", "pr-1", "Trigger implementation merged with tests.", "pull_request.snapshot");
    const verified = await add(store, "slack", "message-1", "Verified trigger implementation end to end on real source data.");
    const judge = { judgeTaskStatus: async () => ({ status: { choice: "done", confidence: 0.94 },
      directMatchProbability: 0.96, statusSupportProbability: 0.96, completionSupportProbability: 0.96 }),
      supportsDraft: async () => 0.95 } as unknown as JevWorkJudge;
    let draftCalls = 0;
    const drafter = { draft: async () => { draftCalls++; return { text: "Trigger implementation was verified end to end on real source data.",
      evidenceEventIds: [merged.id, verified.id], model: "test" }; } };
    const engine = new TaskStatusSuggestionEngine(store, ledger, judge, drafter, ["company"]);
    expect((await engine.run(3))[0]?.outcome).toBe("proposal");
    expect(draftCalls).toBe(1);
    expect((await store.listProposals("pending"))[0]?.changes).toEqual({ status: "done" });
    expect((await store.listProposals("pending"))[0]?.evidenceIds).toEqual(expect.arrayContaining([merged.id, verified.id]));
    expect((await ledger.getTask(task.id))?.status).toBe("planned");
    expect(await engine.run(3)).toEqual([]);
  });

  it("does not draft completion from one provider or ambiguous identity", async () => {
    const { store, ledger } = setup();
    await ledger.createTask({ title: "Verify trigger implementation", status: "planned" }, "user:reviewer");
    await add(store, "slack", "message-1", "Verified trigger implementation end to end on real source data.");
    let draftCalls = 0;
    const judge = { judgeTaskStatus: async () => ({ status: { choice: "done", confidence: 0.94 },
      directMatchProbability: 0.96, statusSupportProbability: 0.96, completionSupportProbability: 0.96 }),
      supportsDraft: async () => 1 } as unknown as JevWorkJudge;
    const drafter = { draft: async () => { draftCalls++; throw new Error("LLM should not be called"); } };
    const engine = new TaskStatusSuggestionEngine(store, ledger, judge, drafter, ["company"]);
    expect((await engine.run(3))[0]?.outcome).toBe("skipped");
    expect(draftCalls).toBe(0);
    expect(await store.listProposals("pending")).toHaveLength(0);
  });
});
