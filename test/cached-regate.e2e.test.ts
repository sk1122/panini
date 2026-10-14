import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { SourceEventInput } from "../src/domain/types.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import type { IntelligenceConfig, InterpretationFinding } from "../src/intelligence/types.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const config: IntelligenceConfig = {
  enabled: true, mode: "manual", intervalSeconds: 900, maxEventsPerRun: 10,
  maxEvidenceCharacters: 20_000, maxSourceDocumentCharacters: 20_000,
  maxContextCharacters: 10_000, minimumConfidence: 0.5,
  completionMinimumConfidence: 0.85, completionMinimumEvidenceItems: 2,
  completionEvidenceProviders: ["slack"], sourceProviders: ["slack"],
};

function source(text: string, id: string): SourceEventInput {
  return { provider: "slack", installationKey: "e2e", providerEventId: id,
    eventKind: "message.observed", occurredAt: "2026-09-20T10:00:00.000Z",
    fetchedAt: "2026-09-20T10:00:01.000Z", sourceRef: `slack:e2e:${id}`,
    sourceUrl: null, contentHash: id, visibility: "company", payloadVersion: "e2e",
    payload: { text } };
}

function finding(taskId: string, title: string, description: string,
  evidenceEventIds: string[]): InterpretationFinding {
  return { kind: "task_change", taskId, title, description, status: "in_progress",
    priority: "high", owner: null, project: null, dueDate: null, dependencyRefs: [],
    contextPath: null, contextTitle: null, contextBody: null,
    contextFactType: null, contextFactValue: null, rationale: "Cited progress on the outcome.",
    confidence: 0.95, evidenceEventIds, caveats: [] };
}

describe("cached finding re-gate E2E", () => {
  it("applies a saved partial-progress finding without another interpreter call", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: true,
      autoApproveContext: true, requireReviewForTaskChanges: true }));
    const task = await ledger.createTask({ title: "Integrate Polymarket and Kalshi markets",
      description: "Integrate both market sources.", status: "planned", priority: "high" }, "user:e2e");
    let interpreterCalls = 0;
    const original = new EvidenceIntelligence({ store, ledger, companyName: "Sozu E2E", config,
      log: { info() {}, error() {} }, interpreter: { name: "cached-e2e", async interpret(input) {
        interpreterCalls += 1;
        return { summary: "Polymarket progress", findings: [finding(task.id, task.title,
          "Polymarket is integrated; Kalshi remains open.", input.events.map((event) => event.id))] };
      } },
      workChangeJudge: { async judgeTaskChange() { return { relationship: "uncertain" as const,
        relationshipProbability: 0.9, changeSupportProbability: 0.2,
        statusSupportProbability: 0.2, completionSupportProbability: 0 }; } },
    });
    await original.record(source("polymarket is integrated", "polymarket-1"));
    expect((await original.run()).outcomes).toMatchObject([{ state: "rejected" }]);
    const [saved] = await store.listInterpretationRuns(1);
    expect(saved?.output).toMatchObject({ interpretation: { findings: [{ kind: "task_change" }] } });

    const regate = new EvidenceIntelligence({ store, ledger, companyName: "Sozu E2E", config,
      interpreter: null, log: { info() {}, error() {} },
      workChangeJudge: { async judgeTaskChange() { return { relationship: "same_outcome" as const,
        relationshipProbability: 0.94, changeSupportProbability: 0.93,
        statusSupportProbability: 0.91, completionSupportProbability: 0.1 }; } },
    });
    const result = await regate.rejudgeStoredFinding(saved!, 0);
    expect(result).toMatchObject({ state: "applied" });
    expect(await ledger.getTask(task.id)).toMatchObject({ status: "in_progress",
      description: "Polymarket is integrated; Kalshi remains open." });
    expect(interpreterCalls).toBe(1);
  });

  it("still rejects a cached heap-memory finding aimed at the product memory Task", async () => {
    const store = new MemoryLedgerStore();
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: true,
      autoApproveContext: true, requireReviewForTaskChanges: true }));
    const task = await ledger.createTask({ title: "Build memory capability",
      description: "Build persistent company memory.", status: "planned", priority: "high" }, "user:e2e");
    const original = new EvidenceIntelligence({ store, ledger, companyName: "Sozu E2E", config,
      log: { info() {}, error() {} }, interpreter: { name: "cached-heap-e2e", async interpret(input) {
        return { summary: "Heap memory", findings: [finding(task.id, task.title,
          "Bump Node heap for signal generation.", input.events.map((event) => event.id))] };
      } },
      workChangeJudge: { async judgeTaskChange() { return { relationship: "uncertain" as const,
        relationshipProbability: 0.9, changeSupportProbability: 0.2,
        statusSupportProbability: 0.2, completionSupportProbability: 0 }; } },
    });
    await original.record(source("bump memory; node --max-old-space-size=3072", "heap-1"));
    expect((await original.run()).outcomes).toMatchObject([{ state: "rejected" }]);
    const [saved] = await store.listInterpretationRuns(1);
    const regate = new EvidenceIntelligence({ store, ledger, companyName: "Sozu E2E", config,
      interpreter: null, log: { info() {}, error() {} },
      workChangeJudge: { async judgeTaskChange() { return { relationship: "unrelated" as const,
        relationshipProbability: 0.98, changeSupportProbability: 0.03,
        statusSupportProbability: 0.02, completionSupportProbability: 0 }; } },
    });
    expect(await regate.rejudgeStoredFinding(saved!, 0)).toMatchObject({ state: "rejected" });
    expect(await ledger.getTask(task.id)).toMatchObject({ status: "planned" });
  });
});
