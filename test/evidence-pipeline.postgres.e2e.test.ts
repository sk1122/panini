import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";
import { OpenAIClaimExtractor } from "../src/intelligence/claim-extractor.js";
import { OpenAIEvidenceJudge } from "../src/intelligence/evidence-judge.js";
import { OpenAITaskIdentityResolver } from "../src/intelligence/task-identity.js";
import { LUNA_PRICE_2026_10_01 } from "../src/intelligence/model-price.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 29).toString("base64");
const organizationId = randomUUID();

describe("Evidence pipeline with durable PostgreSQL", () => {
  let store: PostgresLedgerStore;
  let ledger: TeamLedger;
  let pool: pg.Pool;

  beforeAll(async () => {
    if (!databaseUrl || !databaseUrl.includes("panini_e2e")) throw new Error("Isolated panini_e2e database required");
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
      [organizationId, `pipeline-e2e-${organizationId}`, "Pipeline E2E"]);
    store = new PostgresLedgerStore(databaseUrl, key, organizationId);
    ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    expect((await pool.query<{ current_database: string }>("SELECT current_database()"))
      .rows[0]?.current_database).toBe("panini_e2e");
  });

  afterAll(async () => {
    await store?.close();
    await pool?.end();
  });

  it("turns a grounded progress inference into a review proposal without changing accepted state", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Pipe evidence into Bayesian graph and test it out", status: "in_progress" }, "user:e2e");
    const quote = "234 sources are live; the back half is ready for review.";
    const extractedStatement = "The speaker reports running the back half on 234 live sources.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1", payload: { text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 100_000, maxOutputTokens: 1_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let judgeInput: string | null = null;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `inferred-progress-${marker}`,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: extractedStatement, subjectRefs: [], speakerMemberId: null,
          assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] }; } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["same deliverable"],
        suggestedStatus: "review" as const, statusBasis: "back half is ready for review" }; } },
      judge: new OpenAIEvidenceJudge({ store, apiKey: "mock-key", model: "mock-model",
        allowedVisibilities: ["slack:channel:C1"],
        priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
          cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
        fetcher: async (_url, init) => {
          judgeInput = (JSON.parse(String(init?.body)) as { input: string }).input;
          return new Response(JSON.stringify({ id: `mock-judge-${marker}`,
            model: "mock-model", status: "completed", output: [{ type: "message",
              content: [{ type: "output_text", text: JSON.stringify({ verdict: "supported",
                reasonCodes: [], explanation: "The cited source supports review." }) }] }],
            usage: { input_tokens: 200, output_tokens: 40 } }), { status: 200 });
        } }),
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    expect((await store.getTask(task.id))?.status).toBe("in_progress");
    const proposal = (await store.listTaskProposals(task.id)).find((item) => item.assessmentId);
    expect(proposal).toMatchObject({ state: "pending", changes: { status: "review" } });
    const assessment = (await store.listAssessmentsForTask(task.id, 10))[0];
    expect(assessment?.reasonCodes).toContain("inferred_status_requires_review");
    expect(judgeInput).toContain("ready for review");
    expect(extractedStatement).not.toContain("ready for review");
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/inferred-progress-e2e.json",
      JSON.stringify({ case: "inferred-progress", claimId: assessment?.claimIds[0], taskId: task.id,
        proposalId: proposal?.id, proposedStatus: "review",
        acceptedStatus: (await store.getTask(task.id))?.status,
        citedSourceVisibleToJudge: String(judgeInput).includes("ready for review") }, null, 2) + "\n");
  });

  it("attributes a commit observation to work without treating it as completion", async () => {
    const marker = randomUUID();
    const sha = "d".repeat(40);
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Link causal cards", status: "in_progress" }, "user:e2e");
    const quote = "Implement causal card linking";
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "repo",
      providerEventId: `42:commit.snapshot:${marker}`, eventKind: "commit.snapshot",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `github:42:commit.snapshot:${sha}`, sourceUrl: null, contentHash: marker,
      visibility: "company", payloadVersion: "github-rest-v1",
      payload: { repositoryId: 42, repository: "example/repo", sha, message: quote,
        text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1_000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `commit-attribution-${marker}`,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "context_statement" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null,
          assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/message", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: ["commit_message_not_interpreted_as_task_state"] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] }; } },
      identityResolver: { supportsObservationAttribution: true,
        async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["commit concerns same work"],
        suggestedStatus: null, statusBasis: null }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 2, pendingProposalCount: 0 });
    expect((await store.listAssessmentsForTask(task.id, 10))[0]?.relationship).toBe("same_outcome");
    expect((await store.listTaskProposals(task.id)).filter((item) => item.assessmentId)).toHaveLength(0);
    expect((await store.getTask(task.id))?.status).toBe("in_progress");
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/commit-attribution-e2e.json",
      JSON.stringify({ case: "commit-attribution", taskId: task.id,
        taskAssessmentCount: (await store.listAssessmentsForTask(task.id, 10)).length,
        acceptedStatus: (await store.getTask(task.id))?.status }, null, 2) + "\n");
  });

  it("lets grounded component work suggest in-progress for review, without completing the parent", async () => {
    const marker = randomUUID();
    const sha = "e".repeat(40);
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Apply lint rules and clean up the code", status: "planned" }, "user:e2e");
    const quote = "Applied type-aware lint rules to db and graph-core; their checks passed.";
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "repo",
      providerEventId: `42:commit.snapshot:${marker}`, eventKind: "commit.snapshot",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `github:42:commit.snapshot:${sha}`, sourceUrl: null, contentHash: marker,
      visibility: "company", payloadVersion: "github-rest-v1",
      payload: { repositoryId: 42, repository: "example/repo", sha,
        message: quote, text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1_000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `component-progress-${marker}`,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "context_statement" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null,
          assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/message", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] }; } },
      identityResolver: { supportsObservationAttribution: true,
        async resolve() { return { relationship: "part_of" as const,
          targetId: task.id, alternativeTargetIds: [], reasons: ["component of lint work"],
          suggestedStatus: "in_progress" as const,
          statusBasis: "Applied type-aware lint rules to two packages" }; } },
      judge: { async assess() { return { verdict: "supported" as const, reasonCodes: [],
        explanation: "Actual implementation work started on a component." }; } },
    });
    const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null });
    expect(result).toMatchObject({ claimCount: 1, assessmentCount: 2, pendingProposalCount: 1 });
    expect((await store.getTask(task.id))?.status).toBe("planned");
    expect((await store.listTaskProposals(task.id)).find((item) => item.assessmentId))
      .toMatchObject({ state: "pending", changes: { status: "in_progress" } });
    const assessment = (await store.listAssessmentsForTask(task.id, 10))[0];
    expect(assessment?.reasonCodes).toEqual(expect.arrayContaining([
      "partial_scope", "inferred_status_requires_review"]));
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/component-progress-e2e.json",
      JSON.stringify({ case: "component-progress", taskId: task.id, proposalCount: 1,
        acceptedStatus: (await store.getTask(task.id))?.status }, null, 2) + "\n");
  });

  it("keeps an explicit progress status as a review proposal without changing accepted state", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Ship importer",
      description: "Ship the importer", status: "in_progress" }, "user:e2e");
    const quote = "The importer is blocked on credentials.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `progress-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: quote, subjectRefs: [task.id], speakerMemberId: null,
          assertedField: "status", assertedValue: "blocked", assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    const proposal = (await store.listTaskProposals(task.id)).find((item) => item.assessmentId);
    expect(proposal).toMatchObject({ state: "pending", changes: { status: "blocked" } });
    await ledger.approveProposal(proposal!.id, "user:e2e", "Reviewer verified the source and the bounded task.");
    const memberAccess = { kind: "member" as const, organizationId, memberId: "other" };
    expect((await ledger.board(memberAccess)).tasks.some((item) => item.id === task.id)).toBe(false);
    expect((await ledger.workGraph(memberAccess)).tasks.some((item) => item.id === task.id)).toBe(false);
    const memberContext = await ledger.retrieve({ objective: "What is the importer status?",
      access: memberAccess, query: "importer", limit: 20 });
    expect(memberContext.tasks.some((item) => item.id === task.id)).toBe(false);
    expect(JSON.stringify(memberContext)).not.toContain("The importer is blocked on credentials");
    await expect(ledger.retrieve({ objective: "What is the importer status?",
      access: memberAccess, taskId: task.id }))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ledger.getTaskForAccess(task.id, memberAccess)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ledger.taskHistoryForAccess(task.id, memberAccess)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ledger.proposalDetailForAccess(proposal!.id, memberAccess))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ledger.getProposalForAccess(proposal!.id, memberAccess))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    const agentMember = await ledger.syncMember({ subject: `agent:${marker}`,
      displayName: "Importer reviewer" }, "test:e2e");
    const agent = await ledger.createAgentProfile({ memberId: agentMember.id,
      name: "Importer reviewer", harness: "codex",
      capabilities: ["context:read", "work:read", "source:read"],
      dataScope: { projects: ["*"], contextPaths: ["/"],
        sourceVisibilities: ["slack:channel:C1"] } });
    const agentAccess = { kind: "agent" as const, organizationId,
      memberId: agentMember.id, agentProfileId: agent.profile.id,
      dataScope: agent.profile.dataScope };
    expect((await ledger.board(agentAccess)).tasks.find((item) => item.id === task.id)?.status).toBe("blocked");
    expect((await ledger.retrieve({ objective: "Importer status", access: agentAccess, query: "importer" }))
      .tasks.some((item) => item.id === task.id)).toBe(true);
    await store.revokeSourceEvent(event.id);
    expect((await ledger.retrieve({ objective: "Importer status", access: agentAccess, query: "importer" }))
      .tasks.some((item) => item.id === task.id)).toBe(false);
  });

  it("proposes a reported failed result separately from task status", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Run importer",
      description: "Run the importer and report the outcome", status: "in_progress" }, "user:e2e");
    const quote = "The importer run failed.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `result-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: quote, subjectRefs: [task.id], speakerMemberId: null,
          assertedField: "result", assertedValue: "failed", assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    const unchanged = await ledger.getTask(task.id);
    expect(unchanged?.status).toBe("in_progress");
    expect(unchanged?.result ?? "unknown").toBe("unknown");
    const proposal = (await store.listTaskProposals(task.id)).find((item) => item.assessmentId);
    expect(proposal).toMatchObject({ state: "pending", changes: { result: "failed" } });
  });

  it("accepts a completed failed diagnostic without completing the broader repair", async () => {
    const marker = randomUUID();
    const diagnostic = await ledger.createTask({ clientEventId: `${marker}:diagnostic`,
      title: "Run importer diagnostic", status: "in_progress" }, "user:e2e");
    const repair = await ledger.createTask({ clientEventId: `${marker}:repair`,
      title: "Repair the entire importer", status: "in_progress" }, "user:e2e");
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const assess = async (suffix: string, quote: string, kind: "progress_report" | "completion_report",
      field: string | null, value: string | null) => {
      const now = new Date().toISOString();
      const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: `${marker}:${suffix}`, eventKind: "message.observed",
        occurredAt: now, fetchedAt: now, sourceRef: `slack:T1:C1:${marker}:${suffix}`,
        sourceUrl: null, contentHash: `${marker}:${suffix}`, visibility: "company",
        payloadVersion: "test-v1", payload: { teamId: "T1", channel: "C1",
          messageTs: `${marker}:${suffix}`, text: quote } })).event;
      const pipeline = new EvidencePipeline({ store, ledger,
        pipelineVersion: `diagnostic-${marker}`,
        extractor: { name: "fixture-extractor", async extract() { return {
          claims: [{ schemaVersion: 1 as const, kind, statement: quote,
            subjectRefs: [diagnostic.id], speakerMemberId: null,
            assertedField: field, assertedValue: value, assertedAt: now,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: [{ eventId: event.id,
              originObservationKey: event.observationIdentity!.originObservationKey,
              sourceVersionKey: event.observationIdentity!.sourceVersionKey,
              locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
                endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
        } }, identityResolver: { async resolve() { return {
          relationship: "same_outcome" as const, targetId: diagnostic.id,
          alternativeTargetIds: [repair.id], reasons: ["narrow_diagnostic_scope"] }; } },
      });
      const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
        evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
      expect(result.pendingProposalCount).toBe(1);
      const proposal = (await store.listTaskProposals(diagnostic.id))
        .find((item) => item.state === "pending" && item.assessmentId
          && (field === "result" ? item.kind === "task_change" && item.changes.result === "failed"
            : item.kind === "task_change" && item.changes.status === "done"));
      expect(proposal).toBeDefined();
      await ledger.approveProposal(proposal!.id, "user:e2e", "Reviewer confirmed the diagnostic scope.");
    };
    await assess("failed", "The diagnostic result failed.", "progress_report", "result", "failed");
    await assess("done", "The diagnostic run is complete.", "completion_report", null, null);
    expect(await ledger.getTask(diagnostic.id)).toMatchObject({ status: "done", result: "failed" });
    expect((await ledger.getTask(repair.id))?.status).toBe("in_progress");
  });

  it("rejects old progress after a manual completion and records a later correction with both clocks", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Repair task with correction", status: "in_progress" }, "user:e2e");
    const manual = await ledger.propose({ taskId: task.id, baseRevision: task.version,
      changes: { status: "done" }, rationale: "Reviewer completed the task",
      requestedBy: "user:e2e", evidenceIds: [] });
    await ledger.approveProposal(manual.id, "user:e2e", "Completed after manual review.");
    const acceptedDone = (await store.listTaskRevisions(task.id)).at(-1)!;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const assess = async (suffix: string, occurredAt: string, quote: string) => {
      const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: `${marker}:${suffix}`, eventKind: "message.observed",
        occurredAt, fetchedAt: new Date().toISOString(),
        sourceRef: `slack:T1:C1:${marker}:${suffix}`, sourceUrl: null,
        contentHash: `${marker}:${suffix}`, visibility: "company", payloadVersion: "test-v1",
        payload: { teamId: "T1", channel: "C1", messageTs: `${marker}:${suffix}`, text: quote } })).event;
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `temporal-${marker}`,
        extractor: { name: "fixture-extractor", async extract() { return {
          claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
            statement: quote, subjectRefs: [task.id], speakerMemberId: null,
            assertedField: "status", assertedValue: "blocked", assertedAt: occurredAt,
            validFrom: null, validTo: null, temporalBasis: "explicit" as const,
            spans: [{ eventId: event.id,
              originObservationKey: event.observationIdentity!.originObservationKey,
              sourceVersionKey: event.observationIdentity!.sourceVersionKey,
              locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
                endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
        } }, identityResolver: { async resolve() { return {
          relationship: "same_outcome" as const, targetId: task.id,
          alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
      });
      const run = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
        evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
      expect(run.pendingProposalCount).toBe(1);
      const proposal = (await store.listTaskProposals(task.id))
        .find((item) => item.assessmentId && item.state === "pending"
          && item.kind === "task_change" && item.changes.status === "blocked"
          && item.evidenceIds.includes(event.id));
      expect(proposal).toBeDefined();
      return { event, proposal: proposal! };
    };
    const old = await assess("old", new Date(Date.now() - 3_600_000).toISOString(),
      "The task was blocked earlier.");
    await expect(ledger.approveProposal(old.proposal.id, "user:e2e", "Reviewer saw the old report."))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await ledger.getTask(task.id))?.status).toBe("done");
    await new Promise((resolve) => setTimeout(resolve, 5));
    const correctedAt = new Date().toISOString();
    const correction = await assess("correction", correctedAt,
      "Correction: the task is blocked now.");
    await ledger.approveProposal(correction.proposal.id, "user:e2e",
      "Reviewer accepted the new correction.");
    const revisions = await store.listTaskRevisions(task.id);
    expect(revisions.at(-1)?.current.status).toBe("blocked");
    expect(revisions.at(-1)?.decisionMetadata?.effectiveAtByField.status).toBe(correctedAt);
    expect(revisions.at(-1)?.decisionMetadata?.acceptedAt).not.toBe(correctedAt);
    expect(revisions.find((revision) => revision.id === acceptedDone.id)?.current.status).toBe("done");
    expect(revisions.at(-1)?.decisionMetadata?.acceptedAt)
      .toBe(revisions.at(-1)?.appliedAt);
  });

  it("keeps contradictory status reports in review", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Contradictory importer status", status: "in_progress" }, "user:e2e");
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const olderAt = new Date(Date.now() - 20_000).toISOString();
    const newerAt = new Date(Date.now() - 10_000).toISOString();
    const run = async (suffix: string, quote: string, status: "blocked" | "in_progress",
      assertedAt: string) => {
      const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: `${marker}:${suffix}`, eventKind: "message.observed",
        occurredAt: assertedAt, fetchedAt: new Date().toISOString(),
        sourceRef: `slack:T1:C1:${marker}:${suffix}`, sourceUrl: null,
        contentHash: `${marker}:${suffix}`, visibility: "company", payloadVersion: "test-v1",
        payload: { teamId: "T1", channel: "C1", messageTs: `${marker}:${suffix}`, text: quote } })).event;
      const pipeline = new EvidencePipeline({ store, ledger,
        pipelineVersion: `contradiction-${marker}`,
        extractor: { name: "fixture-extractor", async extract() { return {
          claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
            statement: quote, subjectRefs: [task.id], speakerMemberId: null,
            assertedField: "status", assertedValue: status, assertedAt,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: [{ eventId: event.id,
              originObservationKey: event.observationIdentity!.originObservationKey,
              sourceVersionKey: event.observationIdentity!.sourceVersionKey,
              locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
                endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
        } }, identityResolver: { async resolve() { return {
          relationship: "same_outcome" as const, targetId: task.id,
          alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
      });
      return pipeline.run({ eventIds: [event.id], budgetId: budget.id,
        evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    };
    await run("newer", "The importer is in progress.", "in_progress", newerAt);
    const older = await run("older", "The importer is blocked.", "blocked", olderAt);
    const assessment = (await store.listAssessmentsForTask(task.id, 20))
      .find((item) => item.runId === older.runId);
    expect(assessment?.reasonCodes).toContain("contradictory_evidence");
    expect(assessment?.disposition).toBe("review_required");
    expect(assessment?.body.fields[0]?.contradictions).toHaveLength(1);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
  });

  it("keeps a bounded completion and an atomic context fact in review", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Run importer retest",
      description: "Run the importer retest and report its result", status: "in_progress" }, "user:e2e");
    const quote = "The importer retest is complete. The importer uses a signed webhook.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote } })).event;
    const span = (text: string) => ({ eventId: event.id,
      originObservationKey: event.observationIdentity!.originObservationKey,
      sourceVersionKey: event.observationIdentity!.sourceVersionKey,
      locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: quote.indexOf(text),
        endUtf16: quote.indexOf(text) + text.length,
        spanHash: createHash("sha256").update(text).digest("hex") } });
    const completion = "The importer retest is complete.";
    const fact = "The importer uses a signed webhook.";
    const base = { schemaVersion: 1 as const, subjectRefs: [task.id], speakerMemberId: null,
      assertedAt: event.occurredAt, validFrom: null, validTo: null,
      temporalBasis: "relative_to_source" as const, derivedFromClaimIds: [],
      supersedesClaimIds: [], caveats: [] };
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `completion-context-${marker}`,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [
          { ...base, kind: "completion_report" as const, statement: completion,
            assertedField: null, assertedValue: null, spans: [span(completion)] },
          { ...base, kind: "context_statement" as const, statement: fact,
            assertedField: "policy", assertedValue: fact, spans: [span(fact)] },
        ], dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0, 1], reasonCode: null }] }; } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["bounded_scope_match"] }; } },
    });
    const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(result).toMatchObject({ claimCount: 2, assessmentCount: 2, pendingProposalCount: 2 });
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    expect((await store.listTaskProposals(task.id)).find((proposal) => proposal.assessmentId))
      .toMatchObject({ state: "pending", changes: { status: "done" } });
    expect((await store.listProposals()).filter((proposal) => proposal.kind === "context_fact_upsert"
      && proposal.evidenceIds.includes(event.id))).toHaveLength(1);
    expect((await store.listContextEntries()).some((entry) => entry.evidenceIds.includes(event.id))).toBe(false);
  });

  it("processes only the current edit when old deliveries share an episode", async () => {
    const marker = randomUUID();
    const sourceRef = `slack:T1:C1:${marker}`;
    const append = async (suffix: string, eventKind: string, text: string) =>
      (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: `${suffix}-${marker}`, eventKind,
        occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
        sourceRef, sourceUrl: null, contentHash: `${suffix}-${marker}`,
        visibility: "slack:channel:C1", payloadVersion: "test-v1",
        payload: { teamId: "T1", channel: "C1", messageTs: marker, text },
      })).event;
    const first = await append("socket", "message.observed", "Release is planned.");
    const duplicate = await append("history", "message.imported", "Release is planned.");
    const edit = await append("edit", "message.edited", "Release is blocked.");
    expect(first.observationIdentity?.originObservationKey)
      .toBe(duplicate.observationIdentity?.originObservationKey);
    expect(first.observationIdentity?.originObservationKey)
      .not.toBe(edit.observationIdentity?.originObservationKey);
    expect(first.observationIdentity?.sourceVersionKey)
      .not.toBe(edit.observationIdentity?.sourceVersionKey);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    const pipelineVersion = `versioned-episode-${marker}`;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion,
      extractor: { name: "fixture-no-claim", async extract({ events }) {
        extractionCalls += 1;
        return { claims: [], dispositions: events.map((event) => ({ eventId: event.id,
          state: "no_claim" as const, claimOrdinals: [], reasonCode: "fixture_no_work" })) };
      } }, identityResolver: { async resolve() { throw new Error("No claims require identity."); } },
    });
    const report = await pipeline.run({ eventIds: [first.id, duplicate.id, edit.id],
      budgetId: budget.id, evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(extractionCalls).toBe(1);
    expect(report.processedEventIds).toEqual([edit.id]);
    const rows = await pool.query<{ source_event_id: string; state: string }>(
      "SELECT source_event_id,state FROM observation_dispositions WHERE source_event_id=ANY($1::uuid[]) AND pipeline_version=$2",
      [[first.id, duplicate.id, edit.id], pipelineVersion]);
    expect(new Map(rows.rows.map((row) => [row.source_event_id, row.state])))
      .toEqual(new Map([[edit.id, "no_claim"]]));
  });

  it("records a duplicate receipt even when its canonical extraction is partial", async () => {
    const marker = randomUUID();
    const quote = "Importer status has one unresolved section.";
    const sourceRef = `slack:T1:C1:${marker}`;
    const append = async (suffix: string) => (await store.appendSourceEvent({ provider: "slack",
      installationKey: "T1", providerEventId: `${suffix}-${marker}`,
      eventKind: suffix === "socket" ? "message.observed" : "message.imported",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef, sourceUrl: null, contentHash: `${suffix}-${marker}`,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const first = await append("socket");
    const duplicate = await append("history");
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    const pipelineVersion = `partial-duplicate-${marker}`;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion,
      extractor: { name: "fixture-partial", async extract({ events }) {
        extractionCalls += 1;
        const event = events[0]!;
        return { claims: [{ schemaVersion: 1 as const, kind: "context_statement" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null,
          assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: ["section_unresolved"] }],
          dispositions: [{ eventId: event.id, state: "partial" as const,
            claimOrdinals: [0], reasonCode: "section_unresolved" }] };
      } }, identityResolver: { async resolve() { throw new Error("No work identity needed."); } },
    });
    await pipeline.run({ eventIds: [first.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    await pipeline.run({ eventIds: [duplicate.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:03.000Z", knowledgeCutoff: null });
    expect(extractionCalls).toBe(1);
    const rows = await pool.query<{ source_event_id: string; state: string }>(
      "SELECT source_event_id,state FROM observation_dispositions WHERE source_event_id=ANY($1::uuid[]) AND pipeline_version=$2",
      [[first.id, duplicate.id], pipelineVersion]);
    expect(new Map(rows.rows.map((row) => [row.source_event_id, row.state])))
      .toEqual(new Map([[first.id, "partial"], [duplicate.id, "duplicate"]]));
  });

  it("withholds a legacy source-backed accepted field when its receipt is private", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Private blocker case",
      description: "Check an ingestion blocker", status: "in_progress" }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: "Blocked privately" },
    })).event;
    const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
      changes: { status: "blocked" }, rationale: "Private Slack report", requestedBy: "user:e2e",
      evidenceIds: [event.id] });
    await ledger.approveProposal(proposal.id, "user:e2e", "Reviewer confirmed the private blocker.");
    const otherMember = { kind: "member" as const, organizationId, memberId: "other" };
    expect((await ledger.board(otherMember)).tasks.some((item) => item.id === task.id)).toBe(false);
    expect((await ledger.board({ kind: "admin" })).tasks.find((item) => item.id === task.id)?.status)
      .toBe("blocked");
    const publicCorrection = await ledger.propose({ taskId: task.id, baseRevision: task.version + 1,
      changes: { status: "in_progress" }, rationale: "Reviewer restored the public status",
      requestedBy: "user:e2e", evidenceIds: [] });
    await ledger.approveProposal(publicCorrection.id, "user:e2e", "Public status corrected manually.");
    expect((await ledger.board(otherMember)).tasks.find((item) => item.id === task.id)?.status)
      .toBe("in_progress");
    await expect(ledger.taskHistoryForAccess(task.id, otherMember))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(ledger.proposalDetailForAccess(publicCorrection.id, otherMember))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("withholds a mixed-source accepted field from a reader who can see only one source", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Mixed-source blocker",
      description: "Resolve the blocker", status: "in_progress" }, "user:e2e");
    const append = async (suffix: string, visibility: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId: `${marker}:${suffix}`,
      eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:${suffix}:${marker}`,
      sourceUrl: null, contentHash: `${marker}:${suffix}`, visibility, payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: suffix, messageTs: marker,
        text: suffix === "public" ? "The importer is delayed." : "The private credential is missing." },
    })).event;
    const publicSource = await append("public", "company");
    const privateSource = await append("private", "slack:channel:C-PRIVATE");
    const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
      changes: { status: "blocked" }, rationale: "Review of both reports",
      requestedBy: "user:e2e", evidenceIds: [publicSource.id, privateSource.id] });
    await ledger.approveProposal(proposal.id, "user:e2e", "Reviewer considered both reports.");
    const member = { kind: "member" as const, organizationId, memberId: "other" };
    expect((await ledger.board(member)).tasks.some((item) => item.id === task.id)).toBe(false);
    expect((await ledger.retrieve({ objective: "Importer status", access: member, query: "importer" }))
      .tasks.some((item) => item.id === task.id)).toBe(false);
    expect((await ledger.board({ kind: "admin" })).tasks.find((item) => item.id === task.id)?.status)
      .toBe("blocked");
  });

  it("withholds a project derived from a private receipt", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: "Launch private initiative" },
    })).event;
    const proposal = await ledger.proposeProjectCreation({
      changes: { name: `Private initiative ${marker.slice(0, 6)}`, outcome: "Deliver the initiative" },
      rationale: "Source names new project", requestedBy: "user:e2e", evidenceIds: [event.id],
    });
    const revision = await ledger.approveProjectProposal(proposal.id, "user:e2e", "Reviewer accepted scope.");
    const otherMember = { kind: "member" as const, organizationId, memberId: "other" };
    expect((await ledger.workGraph(otherMember)).projects.some((item) => item.id === revision.current.id))
      .toBe(false);
    await expect(ledger.projectDetail(revision.current.id, otherMember))
      .rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await ledger.workGraph({ kind: "admin" })).projects.some((item) =>
      item.id === revision.current.id)).toBe(true);
  });

  it("records a narrow completion claim without closing a broader task or processing twice", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Repair causal worker",
      description: "Implement the complete causal-worker repair", status: "in_progress" }, "user:e2e");
    const sourceText = "The bounded retest is done. The repair is still open.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: sourceText },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: "pipeline-e2e-v2",
      extractor: { name: "fixture-extractor", async extract(input) {
        extractionCalls += 1;
        const source = input.events[0]!;
        const quote = "The bounded retest is done.";
        const start = sourceText.indexOf(quote);
        return { claims: [{ schemaVersion: 1, kind: "completion_report", statement: quote,
          subjectRefs: [task.id], speakerMemberId: null, assertedField: "status",
          assertedValue: "done", assertedAt: source.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source",
          spans: [{ eventId: source.id, originObservationKey: source.observationIdentity!.originObservationKey,
            sourceVersionKey: source.observationIdentity!.sourceVersionKey,
            locator: { kind: "text", jsonPointer: "/text", startUtf16: start,
              endUtf16: start + quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: source.id, state: "extracted", claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "part_of" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["narrow_retest"] }; } },
    });
    const request = { eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null };
    const report = await pipeline.run(request);
    expect(report).toMatchObject({ state: "completed", processedEventIds: [event.id],
      claimCount: 1, assessmentCount: 1, pendingProposalCount: 0 });
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    const proposal = (await store.listTaskProposals(task.id)).find((item) => item.assessmentId);
    expect(proposal).toBeUndefined();
    const repeat = await pipeline.run(request);
    expect(repeat).toMatchObject({ state: "no_evidence", processedEventIds: [] });
    expect(extractionCalls).toBe(1);
    const persisted = await pool.query<{ state: string }>(
      "SELECT state FROM observation_dispositions WHERE source_event_id=$1 AND pipeline_version='pipeline-e2e-v2'",
      [event.id],
    );
    expect(persisted.rows.map((row) => row.state)).toEqual(["extracted"]);
  });

  it("keeps an unmatched completion visible for review instead of dropping it", async () => {
    const marker = randomUUID();
    const quote = "The new import is complete.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `unmatched-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null, assertedField: "status",
          assertedValue: "done", assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "uncertain" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["no_authorized_candidate"] }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 0 });
    const rows = await pool.query<{ id: string; target_type: string; target_id: string | null;
      disposition: string; reason_codes: string[] }>(
      "SELECT id,target_type,target_id,disposition,reason_codes FROM evidence_assessments WHERE run_id=$1",
      [report.runId]);
    expect(rows.rows).toMatchObject([{ target_type: "task_create", target_id: null,
      disposition: "review_required", reason_codes: expect.arrayContaining(["no_authorized_candidate"]) }]);
    const assessmentId = rows.rows[0]!.id;
    expect((await ledger.evidenceAssessmentForAccess(assessmentId, { kind: "admin" })).id)
      .toBe(assessmentId);
    const organizationId = (await store.getOrganization()).id;
    await expect(ledger.evidenceAssessmentForAccess(assessmentId, {
      kind: "member", organizationId, memberId: "outsider",
    })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await store.revokeSourceEvent(event.id);
    await expect(ledger.evidenceAssessmentForAccess(assessmentId, { kind: "admin" }))
      .rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("turns an unmatched explicit work request into one review-only creation proposal", async () => {
    const marker = randomUUID();
    const quote = "Please add a weekly importer health report.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `request-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract(input) {
        const source = input.events[0]!;
        return { claims: [{ schemaVersion: 1 as const, kind: "request" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null, assertedField: null,
          assertedValue: null, assertedAt: source.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: source.id,
            originObservationKey: source.observationIdentity!.originObservationKey,
            sourceVersionKey: source.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: source.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "unrelated" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["new_work"] }; } },
    });
    const beforeTasks = await pool.query<{ count: string }>(
      "SELECT count(*) FROM tasks WHERE organization_id=$1", [organizationId]);
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    const proposals = await pool.query<{ id: string; state: string; assessment_id: string | null;
      changes: { externalRef: string; status: string } }>(
      "SELECT id,state,assessment_id,changes FROM proposals WHERE organization_id=$1 AND requested_by='evidence-pipeline' AND kind='task_create' AND evidence_ids::text LIKE $2",
      [organizationId, `%${event.id}%`]);
    expect(proposals.rows).toMatchObject([{ state: "pending", assessment_id: expect.any(String),
      changes: { externalRef: expect.stringContaining("claim:"), status: "backlog" } }]);
    await expect(ledger.proposeTaskCreationForAccess({ clientEventId: `${marker}-forged`,
      externalRef: `claim:${marker}-forged`, title: "Forged request", status: "backlog",
      rationale: "Try to attach a different assessment.", requestedBy: "user:e2e",
      evidenceIds: [event.id], assessmentId: proposals.rows[0]!.assessment_id,
    }, { kind: "admin" })).rejects.toMatchObject({ code: "INVALID" });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM tasks WHERE organization_id=$1", [organizationId])).rows[0]?.count)
      .toBe(beforeTasks.rows[0]?.count);
    const proposalsBeforeEdit = (await pool.query<{ count: string }>(
      "SELECT count(*) FROM proposals WHERE organization_id=$1 AND requested_by='evidence-pipeline' AND kind='task_create'",
      [organizationId],
    )).rows[0]!.count;
    await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:03.000Z", knowledgeCutoff: null });
    const edited = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: `${marker}-edit`, eventKind: "message.edited",
      occurredAt: "2026-10-01T01:01:00.000Z", fetchedAt: "2026-10-01T01:01:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: `${marker}-edit`,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker,
        text: `${quote} FYI, this can wait until next week.` },
    })).event;
    expect(edited.observationIdentity?.canonicalObjectKey)
      .toBe(event.observationIdentity?.canonicalObjectKey);
    expect(edited.observationIdentity?.sourceVersionKey)
      .not.toBe(event.observationIdentity?.sourceVersionKey);
    await pipeline.run({ eventIds: [edited.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:01:02.000Z", knowledgeCutoff: null });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM proposals WHERE organization_id=$1 AND requested_by='evidence-pipeline' AND kind='task_create' AND changes->>'externalRef'=$2",
      [organizationId, proposals.rows[0]!.changes.externalRef])).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM proposals WHERE organization_id=$1 AND requested_by='evidence-pipeline' AND kind='task_create'",
      [organizationId],
    )).rows[0]?.count).toBe(proposalsBeforeEdit);
    await expect(ledger.approveProposal(proposals.rows[0]!.id, "user:e2e", null))
      .rejects.toMatchObject({ code: "CONFLICT" });
    await store.revokeSourceEvent(event.id);
    await expect(ledger.approveProposal(proposals.rows[0]!.id, "user:e2e", "Reviewed request"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    expect((await pool.query<{ count: string }>(
      "SELECT count(*) FROM tasks WHERE organization_id=$1", [organizationId])).rows[0]?.count)
      .toBe(beforeTasks.rows[0]?.count);
  });

  it("lets two workers process one initiating request with one proposal and accepted effect", async () => {
    const marker = randomUUID();
    const quote = "Please add a weekly importer recovery report.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 2000, maxOutputTokens: 1000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractorCalls = 0;
    const makePipeline = () => new EvidencePipeline({ store, ledger,
      pipelineVersion: `concurrent-request-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract(input) {
        extractorCalls += 1;
        await new Promise((resolve) => setTimeout(resolve, 25));
        const source = input.events[0]!;
        return { claims: [{ schemaVersion: 1 as const, kind: "request" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null, assertedField: null,
          assertedValue: null, assertedAt: source.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: source.id,
            originObservationKey: source.observationIdentity!.originObservationKey,
            sourceVersionKey: source.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: source.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "unrelated" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["new_work"] }; } },
    });
    const input = { eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null };
    const runs = await Promise.allSettled([makePipeline().run(input), makePipeline().run(input)]);
    expect(runs.filter((run) => run.status === "fulfilled" && run.value.claimCount === 1)).toHaveLength(1);
    expect(runs.filter((run) => run.status === "rejected" &&
      String(run.reason).includes("active observation lease"))).toHaveLength(1);
    expect(extractorCalls).toBe(1);
    const proposals = await pool.query<{ id: string; changes: { externalRef: string } }>(
      `SELECT id,changes FROM proposals WHERE organization_id=$1 AND kind='task_create'
        AND requested_by='evidence-pipeline' AND evidence_ids::text LIKE $2`,
      [organizationId, `%${event.id}%`]);
    expect(proposals.rows).toHaveLength(1);
    const proposal = proposals.rows[0]!;
    const accepted = await Promise.all([
      ledger.approveProposal(proposal.id, "user:e2e", "Reviewed one canonical request."),
      ledger.approveProposal(proposal.id, "user:e2e", "Reviewed one canonical request."),
    ]);
    expect(accepted[0]?.id).toBe(accepted[1]?.id);
    expect((await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM tasks WHERE organization_id=$1 AND external_ref=$2",
      [organizationId, proposal.changes.externalRef])).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM task_revisions WHERE organization_id=$1
        AND proposal_id=$2`, [organizationId, proposal.id])).rows[0]?.count).toBe("1");
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM outbox_jobs WHERE organization_id=$1
        AND topic='projection.task.revised' AND payload->>'proposalId'=$2`,
      [organizationId, proposal.id])).rows[0]?.count).toBe("1");
  });

  it("records a transient call request without creating a task proposal", async () => {
    const marker = randomUUID();
    const quote = "Can we have a call at 3 p.m. today?";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `transient-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "request" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null, assertedField: null,
          assertedValue: null, assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } }, identityResolver: { async resolve() { return { relationship: "unrelated" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["new_work"] }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 0 });
    const proposals = await pool.query<{ count: string }>(
      "SELECT count(*) FROM proposals WHERE organization_id=$1 AND requested_by='evidence-pipeline' AND evidence_ids::text LIKE $2",
      [organizationId, `%${event.id}%`]);
    expect(proposals.rows[0]?.count).toBe("0");
    const assessments = await pool.query<{ disposition: string; reason_codes: string[] }>(
      "SELECT disposition,reason_codes FROM evidence_assessments WHERE organization_id=$1 AND run_id=$2",
      [organizationId, report.runId]);
    expect(assessments.rows).toMatchObject([{ disposition: "no_change",
      reason_codes: expect.arrayContaining(["transient_coordination_not_work"]) }]);
  });

  it("keeps a branch-location question out of the durable task queue", async () => {
    const marker = randomUUID();
    const quote = "Asks which branch has the pairing code.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `branch-question-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "request" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null, assertedField: null,
          assertedValue: null, assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } }, identityResolver: { async resolve() { return { relationship: "unrelated" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["new_work"] }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 0 });
    const proposals = await pool.query<{ count: string }>(
      "SELECT count(*) FROM proposals WHERE organization_id=$1 AND requested_by='evidence-pipeline' AND evidence_ids::text LIKE $2",
      [organizationId, `%${event.id}%`]);
    expect(proposals.rows[0]?.count).toBe("0");
    const assessments = await pool.query<{ disposition: string; reason_codes: string[] }>(
      "SELECT disposition,reason_codes FROM evidence_assessments WHERE organization_id=$1 AND run_id=$2",
      [organizationId, report.runId]);
    expect(assessments.rows).toMatchObject([{ disposition: "no_change",
      reason_codes: expect.arrayContaining(["transient_coordination_not_work"]) }]);
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/branch-question-e2e.json",
      JSON.stringify({ case: "branch-location-question", sourceEventId: event.id,
        runId: report.runId, pendingProposalCount: report.pendingProposalCount,
        acceptedUnchanged: true }, null, 2) + "\n");
  });

  it("keeps a durable notification implementation request in review", async () => {
    const marker = randomUUID();
    const quote = "Please implement notification delivery tracking and add a dashboard.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `durable-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "request" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null, assertedField: null,
          assertedValue: null, assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } }, identityResolver: { async resolve() { return { relationship: "unrelated" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["new_work"] }; } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    const assessments = await pool.query<{ disposition: string; reason_codes: string[] }>(
      "SELECT disposition,reason_codes FROM evidence_assessments WHERE run_id=$1", [report.runId]);
    expect(assessments.rows).toMatchObject([{ disposition: "review_required",
      reason_codes: expect.arrayContaining(["new_work_requires_review"]) }]);
  });

  it("checks required CI evidence against the exact SHA and records the criterion result", async () => {
    const marker = randomUUID();
    const sha = "a".repeat(40);
    const makeTask = async (requiredSha: string) => {
      const task = await ledger.createTask({ clientEventId: `ci-${marker}-${requiredSha}`,
        title: `Validate repair ${requiredSha.slice(0, 4)}`,
        description: "Finish and validate the repair.", status: "in_progress" }, "user:e2e");
      const contract = { version: 1, statement: "Repair validated by CI", scope: "Exact change",
        exclusions: [], criteria: [{ id: "ci", description: "Required CI passed at the exact SHA",
          required: true, evidenceRule: { kind: "check_passed" as const, authorityPolicyId: null,
            artifactRefs: [requiredSha], requiredCheckNames: ["integration"],
            requiredEnvironment: null, maxMutableAgeSeconds: 900 },
          acceptedBy: "pending", acceptedAt: "2020-01-01T00:00:00.000Z" }],
        provenance: { proposalId: randomUUID(), evidenceIds: [], actor: "pending",
          acceptedAt: "2020-01-01T00:00:00.000Z" } };
      const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
        changes: { outcomeContract: contract }, rationale: "Set explicit CI criterion",
        requestedBy: "user:e2e", evidenceIds: [] });
      const accepted = await ledger.approveProposal(proposal.id, "user:e2e", "Reviewed criterion");
      if (!("outcomeContract" in accepted)) throw new Error("Expected task revision");
      return accepted;
    };
    const goodTask = await makeTask(sha);
    const wrongTask = await makeTask("b".repeat(40));
    const quote = "integration completed successfully";
    const observedAt = new Date().toISOString();
    const evaluationClock = new Date(Date.now() + 60_000).toISOString();
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "repo-one",
      providerEventId: `check-${marker}`, eventKind: "check_run.snapshot",
      occurredAt: observedAt, fetchedAt: observedAt,
      sourceRef: `github:123:check_run.snapshot:${marker}`, sourceUrl: null,
      contentHash: marker, visibility: "github:repository:example/repo", payloadVersion: "github-rest-v1",
      payload: { repositoryId: 123, repository: "example/repo", sha, checkId: 42,
        name: "integration", status: "completed", conclusion: "success", text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const assess = async (taskId: string, suffix: string,
      episodeEvents = [event]) => {
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `ci-e2e-${marker}-${suffix}`,
        extractor: { name: "fixture-extractor", async extract({ events }) {
          return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
            statement: quote, subjectRefs: [taskId], speakerMemberId: null,
            assertedField: "status", assertedValue: "done", assertedAt: event.occurredAt,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: episodeEvents.map((source) => { const text = String((source.payload as { text: string }).text);
              return { eventId: source.id,
                originObservationKey: source.observationIdentity!.originObservationKey,
                sourceVersionKey: source.observationIdentity!.sourceVersionKey,
                locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
                  endUtf16: text.length, spanHash: createHash("sha256").update(text).digest("hex") } }; }),
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
            dispositions: episodeEvents.map((source) => ({ eventId: source.id,
              state: "extracted" as const, claimOrdinals: [0], reasonCode: null })) };
        } }, identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
          targetId: taskId, alternativeTargetIds: [], reasons: [] }; } },
      });
      const report = await pipeline.run({ eventIds: episodeEvents.map((source) => source.id), budgetId: budget.id,
        evaluationClock, knowledgeCutoff: null });
      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM evidence_assessments WHERE run_id=$1", [report.runId]);
      return store.getAssessment(rows.rows[0]!.id);
    };
    const good = await assess(goodTask.id, "same-sha");
    const wrong = await assess(wrongTask.id, "wrong-sha");
    expect(good?.body.criteria).toMatchObject([{ criterionId: "ci", verdict: "satisfied",
      verifiedBy: "deterministic_artifact" }]);
    expect(wrong?.body.criteria).toMatchObject([{ criterionId: "ci", verdict: "insufficient" }]);
    expect(wrong?.body.coverage.gaps).toContain("missing_required_source");
    const failedText = "integration completed with failure";
    const failed = (await store.appendSourceEvent({ provider: "github", installationKey: "repo-one",
      providerEventId: `check-failed-${marker}`, eventKind: "check_run.snapshot",
      occurredAt: new Date(Date.parse(observedAt) + 10_000).toISOString(), fetchedAt: observedAt,
      sourceRef: `github:123:check_run.snapshot:failed-${marker}`, sourceUrl: null,
      contentHash: `${marker}-failed`, visibility: "github:repository:example/repo",
      payloadVersion: "github-rest-v1", payload: { repositoryId: 123, repository: "example/repo",
        sha, checkId: 43, name: "integration", status: "completed",
        conclusion: "failure", text: failedText },
    })).event;
    const contradicted = await assess(goodTask.id, "failed-retry", [event, failed]);
    expect(contradicted?.body.criteria).toMatchObject([{ criterionId: "ci",
      verdict: "contradicted", reasonCodes: expect.arrayContaining(["required_check_not_successful"]) }]);
    expect((await ledger.getTask(goodTask.id))?.status).toBe("in_progress");
    expect((await ledger.getTask(wrongTask.id))?.status).toBe("in_progress");
  });

  it("uses an exact-revision verification receipt for deployment criteria without auto-completing work", async () => {
    const marker = randomUUID();
    const sha = "d".repeat(40);
    const observedAt = new Date().toISOString();
    const makeTask = async (environment: string, kind: "deployed" | "merged" = "deployed",
      twoRequired = false) => {
      const task = await ledger.createTask({ title: `Deploy ${environment} ${twoRequired ? "two PRs" : "one PR"} ${marker}`,
        status: "in_progress" }, "user:e2e");
      const firstCriterion = { id: "deployment", description: `Deploy to ${environment}`,
        required: true, evidenceRule: { kind, authorityPolicyId: null, artifactRefs: [sha],
          requiredCheckNames: ["integration"], requiredEnvironment: kind === "deployed" ? environment : null,
          maxMutableAgeSeconds: 900 }, acceptedBy: "pending",
        acceptedAt: "2020-01-01T00:00:00.000Z" };
      const proposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
        changes: { outcomeContract: { version: 1, statement: "Release deployed",
          scope: "Exact revision", exclusions: [], criteria: [firstCriterion,
            ...(twoRequired ? [{ ...firstCriterion, id: "second_pr", description: "Merge the second required PR",
              evidenceRule: { ...firstCriterion.evidenceRule, artifactRefs: ["e".repeat(40)] } }] : [])],
          provenance: { proposalId: randomUUID(), evidenceIds: [], actor: "pending",
            acceptedAt: "2020-01-01T00:00:00.000Z" } } },
        rationale: "Require exact deployment", requestedBy: "user:e2e", evidenceIds: [] });
      return ledger.approveProposal(proposal.id, "user:e2e", "Reviewed release scope");
    };
    const production = await makeTask("production");
    const staging = await makeTask("staging");
    const merged = await makeTask("production", "merged");
    const twoPrs = await makeTask("production", "merged", true);
    if (!("status" in production) || !("status" in staging) || !("status" in merged)
      || !("status" in twoPrs)) {
      throw new Error("Expected tasks");
    }
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "repo-one",
      providerEventId: `verify-${marker}`, eventKind: "artifact.verification",
      occurredAt: observedAt, fetchedAt: observedAt,
      sourceRef: `github:verification:example/repo:pull:7:sha:${sha}`,
      sourceUrl: "https://github.com/example/repo/pull/7", contentHash: marker,
      visibility: "github:repository:example/repo", payloadVersion: "github-verification-v1",
      payload: { schemaVersion: 1, repository: "example/repo", pullNumber: 7,
        requiredHeadSha: sha, observedHeadSha: sha, requiredChecks: ["integration"],
        requiredDeploymentEnvironment: "production", mergeVerified: true,
        state: "verified", reasonCodes: [] },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const assess = async (taskId: string, suffix: string, episodeEvents = [event]) => {
      const pipeline = new EvidencePipeline({ store, ledger,
        pipelineVersion: `deployment-e2e-${marker}-${suffix}`,
        extractor: { name: "fixture-extractor", async extract({ events }) {
          return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
            statement: "Verified deployment", subjectRefs: [taskId], speakerMemberId: null,
            assertedField: "status", assertedValue: "done", assertedAt: observedAt,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: events.map((source) => { const text = String((source.payload as { state: string }).state);
              return { eventId: source.id,
                originObservationKey: source.observationIdentity!.originObservationKey,
                sourceVersionKey: source.observationIdentity!.sourceVersionKey,
                locator: { kind: "text" as const, jsonPointer: "/state", startUtf16: 0,
                  endUtf16: text.length, spanHash: createHash("sha256").update(text).digest("hex") } }; }),
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
            dispositions: events.map((source) => ({ eventId: source.id,
              state: "extracted" as const, claimOrdinals: [0], reasonCode: null })) };
        } }, identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
          targetId: taskId, alternativeTargetIds: [], reasons: [] }; } },
      });
      const report = await pipeline.run({ eventIds: episodeEvents.map((source) => source.id), budgetId: budget.id,
        evaluationClock: new Date(Date.parse(observedAt) + 60_000).toISOString(),
        knowledgeCutoff: null });
      const rows = await pool.query<{ id: string }>(
        "SELECT id FROM evidence_assessments WHERE run_id=$1", [report.runId]);
      return store.getAssessment(rows.rows[0]!.id);
    };
    const correct = await assess(production.id, "production");
    const oneOfTwo = await assess(twoPrs.id, "two-required");
    expect(oneOfTwo?.body.criteria).toMatchObject([
      { criterionId: "deployment", verdict: "satisfied" },
      { criterionId: "second_pr", verdict: "insufficient" },
    ]);
    expect(oneOfTwo?.body.coverage.complete).toBe(false);
    expect((await ledger.getTask(twoPrs.id))?.status).toBe("in_progress");
    const wrongEnvironment = await assess(staging.id, "staging");
    expect(correct?.body.criteria).toMatchObject([{ criterionId: "deployment",
      verdict: "satisfied", verifiedBy: "deterministic_artifact" }]);
    expect(wrongEnvironment?.body.criteria).toMatchObject([{ criterionId: "deployment",
      verdict: "insufficient" }]);
    const failed = (await store.appendSourceEvent({ provider: "github", installationKey: "repo-one",
      providerEventId: `verify-failed-${marker}`, eventKind: "artifact.verification",
      occurredAt: new Date(Date.parse(observedAt) + 10_000).toISOString(),
      fetchedAt: new Date(Date.parse(observedAt) + 10_000).toISOString(),
      sourceRef: `github:verification:example/repo:pull:7:sha:${sha}`,
      sourceUrl: "https://github.com/example/repo/pull/7", contentHash: `${marker}-failed`,
      visibility: "github:repository:example/repo", payloadVersion: "github-verification-v1",
      payload: { schemaVersion: 1, repository: "example/repo", pullNumber: 7,
        requiredHeadSha: sha, observedHeadSha: sha, requiredChecks: ["integration"],
        requiredDeploymentEnvironment: "production", mergeVerified: true, state: "insufficient",
        reasonCodes: ["deployment_missing"] },
    })).event;
    const laterFailure = await assess(production.id, "later-failure", [event, failed]);
    expect(laterFailure?.body.criteria).toMatchObject([{ criterionId: "deployment",
      verdict: "insufficient" }]);
    const mergeOnly = await assess(merged.id, "merge-only", [failed]);
    expect(mergeOnly?.body.criteria).toMatchObject([{ criterionId: "deployment",
      verdict: "insufficient" }]);
    const tied = (await store.appendSourceEvent({ provider: "github", installationKey: "repo-one",
      providerEventId: `verify-tied-${marker}`, eventKind: "artifact.verification",
      occurredAt: observedAt, fetchedAt: observedAt,
      sourceRef: `github:verification:example/repo:pull:7:sha:${sha}`,
      sourceUrl: "https://github.com/example/repo/pull/7", contentHash: `${marker}-tied`,
      visibility: "github:repository:example/repo", payloadVersion: "github-verification-v1",
      payload: { schemaVersion: 1, repository: "example/repo", pullNumber: 7,
        requiredHeadSha: sha, observedHeadSha: sha, requiredChecks: ["integration"],
        requiredDeploymentEnvironment: "production", mergeVerified: true,
        state: "insufficient", reasonCodes: ["deployment_missing"] },
    })).event;
    const laterFailedVersion = await assess(production.id, "tied-verifications", [event, tied]);
    expect(laterFailedVersion?.body.criteria).toMatchObject([{ criterionId: "deployment",
      verdict: "insufficient", reasonCodes: expect.arrayContaining(["artifact_verification_failed"]) }]);
    expect(correct?.body.coverage.complete).toBe(true);
    expect((await ledger.getTask(production.id))?.status).toBe("in_progress");
  });

  it("records a GitHub commit and its message exactly without a model call", async () => {
    const marker = randomUUID();
    const sha = "a".repeat(40);
    const message = "Implement durable claim storage";
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "app-1",
      providerEventId: `42:commit.snapshot:${marker}`, eventKind: "commit.snapshot",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `github:42:commit.snapshot:${sha}`, sourceUrl: `https://github.com/example/repo/commit/${sha}`,
      contentHash: marker, visibility: "github:repository:example/repo", payloadVersion: "github-rest-v1",
      payload: { repositoryId: 42, repository: "example/repo", sha,
        message, authorLogin: "contributor", text: message },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "unused", model: "mock-model",
      allowedVisibilities: [event.visibility],
      fetcher: async () => { throw new Error("Commit snapshots should not call the model."); } });
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `deterministic-commit-e2e-${marker}`, extractor,
      identityResolver: { async resolve() { throw new Error("Commit observations are not completion claims."); } },
    });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ state: "completed", claimCount: 2,
      assessmentCount: 1, pendingProposalCount: 0 });
    const claims = await pool.query<{ kind: string }>(
      "SELECT kind FROM evidence_claims WHERE extraction_run_id=$1 ORDER BY ordinal", [report.runId]);
    expect(claims.rows.map((row) => row.kind).sort()).toEqual(["artifact_observation", "context_statement"]);
    expect(await store.listModelCalls(report.runId!)).toEqual([]);
  });

  it("records every omitted field when a document exceeds the continuation limit", async () => {
    const marker = randomUUID();
    const properties = Object.fromEntries(Array.from({ length: 5_001 }, (_, index) =>
      [`field_${index}`, `value ${index}`]));
    const event = (await store.appendSourceEvent({ provider: "notion", installationKey: "e2e",
      providerEventId: marker, eventKind: "source.document.retrieved",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `notion:page:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "company", payloadVersion: "test-v1",
      payload: { page: { id: marker, properties },
        document: { title: "Large source", markdown: null } } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "unused", model: "mock-model",
      allowedVisibilities: ["company"],
      fetcher: async () => { throw new Error("Over-limit source must not dispatch a model call."); } });
    const pipelineVersion = `section-limit-${marker}`;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion, extractor,
      identityResolver: { async resolve() { throw new Error("No claim should be extracted."); } } });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ state: "completed", claimCount: 0 });
    expect((await store.getLatestObservationDisposition(event.id, pipelineVersion)))
      .toMatchObject({ state: "unresolved", reasonCode: "episode_section_limit" });
    const run = await store.getInterpretationRun(report.runId!);
    const output = run?.output as { omissions?: { eventId: string; reasonCode: string }[] } | null;
    expect(output?.omissions).toHaveLength(5_002);
    expect(output?.omissions?.every((item) => item.eventId === event.id
      && item.reasonCode === "episode_section_limit")).toBe(true);
    expect(await store.listModelCalls(report.runId!)).toEqual([]);
  });

  it("recovers an uncited logger commit for a later task as context only", async () => {
    const marker = randomUUID();
    const sha = "c".repeat(40);
    const message = `Repair logger result recording ${marker}`;
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "app-1",
      providerEventId: `42:commit.snapshot:${marker}`, eventKind: "commit.snapshot",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `github:42:commit.snapshot:${sha}`, sourceUrl: `https://github.com/example/repo/commit/${sha}`,
      contentHash: marker, visibility: "github:repository:example/repo", payloadVersion: "github-rest-v1",
      payload: { repositoryId: 42, repository: "example/repo", sha,
        message, authorLogin: "contributor", text: message } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 50_000, maxOutputTokens: 2_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "unused", model: "mock-model",
      allowedVisibilities: [event.visibility],
      fetcher: async () => { throw new Error("Commit extraction must remain deterministic."); } });
    const pipelineVersion = `logger-recovery-${marker}`;
    const initial = new EvidencePipeline({ store, ledger, pipelineVersion, extractor,
      identityResolver: { async resolve() { throw new Error("No task exists yet."); } } });
    const extracted = await initial.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(await store.listModelCalls(extracted.runId!)).toEqual([]);
    const commitMessage = (await store.listClaimsByRun(extracted.runId!)).find((claim) =>
      claim.body.kind === "context_statement")!;
    const task = await ledger.createTask({ clientEventId: marker,
      title: `Repair logger result recording ${marker}`,
      description: "Verify the logger result is recorded", status: "in_progress" }, "user:e2e");
    let cursor: { createdAt: string; id: string } | null = null;
    let discovered = false;
    for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
      const page = await store.listUnlinkedClaimsForTask(task.id, cursor, null,
        new Date(Date.now() + 1_000).toISOString(), 10);
      if (page.some((claim) => claim.id === commitMessage.id)) discovered = true;
      if (discovered || page.length < 10) break;
      const last = page.at(-1)!;
      cursor = { createdAt: last.createdAt, id: last.id };
    }
    expect(discovered).toBe(true);
    let sawTask = false;
    const resolver = new OpenAITaskIdentityResolver({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: [event.visibility], allowTaskContextEgress: true,
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: string };
        sawTask = (JSON.parse(request.input) as { candidates: { id: string }[] })
          .candidates.some((candidate) => candidate.id === task.id);
        return new Response(JSON.stringify({ id: `recovery-${marker}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ relationship: "related", targetId: task.id,
              alternativeTargetIds: [], reasons: ["logger_message"] }) }] }],
          usage: { input_tokens: 100, output_tokens: 20 } }), { status: 200 });
      } });
    const recovery = new EvidencePipeline({ store, ledger, pipelineVersion, extractor,
      identityResolver: resolver });
    const result = await recovery.runCachedAssessment({ claimIds: [commitMessage.id],
      budgetId: budget.id, evaluationClock: "2026-10-01T01:00:03.000Z", knowledgeCutoff: null });
    expect(sawTask).toBe(true);
    expect(result).toMatchObject({ claimCount: 1, assessmentCount: 2,
      pendingProposalCount: 0 });
    expect((await store.listClaimsForTask(task.id, null, 10)).map((claim) => claim.id))
      .toContain(commitMessage.id);
    const assessmentId = (await pool.query<{ id: string }>(`SELECT id FROM evidence_assessments
      WHERE organization_id=$1 AND run_id=$2 AND target_type='task' AND target_id=$3`,
    [organizationId, result.runId, task.id])).rows[0]?.id;
    const assessment = assessmentId ? await store.getAssessment(assessmentId) : null;
    expect(assessment).toMatchObject({ disposition: "review_required",
      reasonCodes: expect.arrayContaining(["commit_message_context_only"]),
      body: { fields: [], coverage: { complete: false } } });
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    expect(await store.listModelCalls(result.runId)).toMatchObject([
      { purpose: "identity", state: "succeeded" }]);
  });

  it("records branch, PR and check snapshots as exact artifacts without completing a task", async () => {
    const marker = randomUUID();
    const sha = "b".repeat(40);
    const task = await ledger.createTask({ clientEventId: `${marker}-task`,
      title: "Release the app", description: "Deploy and verify the app",
      status: "in_progress" }, "user:e2e");
    const observations = [
      { kind: "branch.snapshot", ref: "main", payload: { repositoryId: 42,
        repository: "example/repo", branch: "main", sha, protected: true, text: "main" } },
      { kind: "pull_request.snapshot", ref: "88", payload: { repositoryId: 42,
        repository: "example/repo", pullId: 88, number: 7, title: "Release app", body: "",
        state: "closed", mergedAt: "2026-10-01T00:00:00.000Z", head: "release",
        headSha: sha, base: "main", reviews: [], text: "Release app release" } },
      { kind: "check_run.snapshot", ref: "99", payload: { repositoryId: 42,
        repository: "example/repo", sha, checkId: 99, name: "build",
        status: "completed", conclusion: "success", text: "build completed success" } },
    ];
    const events = await Promise.all(observations.map(async (item) => (await store.appendSourceEvent({
      provider: "github", installationKey: "app-1", providerEventId: `${marker}-${item.kind}`,
      eventKind: item.kind, occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `github:42:${item.kind}:${item.ref}`, sourceUrl: null,
      contentHash: marker, visibility: "github:repository:example/repo",
      payloadVersion: "github-rest-v1", payload: item.payload,
    })).event));
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "unused", model: "mock-model",
      allowedVisibilities: ["github:repository:example/repo"],
      fetcher: async () => { throw new Error("Structured snapshots should not call the model."); } });
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `deterministic-github-e2e-${marker}`, extractor,
      identityResolver: { async resolve() { throw new Error("Artifacts cannot finish a task."); } },
    });
    const report = await pipeline.run({ eventIds: events.map((event) => event.id),
      budgetId: budget.id, evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ state: "completed", claimCount: 3,
      assessmentCount: 0, pendingProposalCount: 0 });
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    expect(await store.listModelCalls(report.runId!)).toEqual([]);
    expect((await store.getClaims((await pool.query<{ id: string }>(
      "SELECT id FROM evidence_claims WHERE extraction_run_id=$1 ORDER BY ordinal", [report.runId]))
      .rows.map((row) => row.id))).map((claim) => claim.body.assertedField).sort())
      .toEqual(["branch_head_sha", "check_run_conclusion", "pull_request_state"]);
  });

  it("reassesses a completed run from saved claims without another extraction", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: `${marker}-task`,
      title: `Ship importer ${marker}`, description: "Ship the complete importer",
      status: "in_progress" }, "user:e2e");
    const quote = "The importer is done.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 2000, maxOutputTokens: 1000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    const extractor = { name: "fixture-extractor", async extract() {
      extractionCalls += 1;
      return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
        statement: quote, subjectRefs: [task.id], speakerMemberId: null, assertedField: "status",
        assertedValue: "done", assertedAt: event.occurredAt, validFrom: null, validTo: null,
        temporalBasis: "relative_to_source" as const,
        spans: [{ eventId: event.id,
          originObservationKey: event.observationIdentity!.originObservationKey,
          sourceVersionKey: event.observationIdentity!.sourceVersionKey,
          locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
            endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
        derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] };
    } };
    const original = new EvidencePipeline({ store, ledger, pipelineVersion: `original-${marker}`,
      extractor, identityResolver: { async resolve() { return { relationship: "part_of" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: [] }; } } });
    const first = await original.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    const claimIds = (await pool.query<{ id: string }>(
      "SELECT id FROM evidence_claims WHERE extraction_run_id=$1", [first.runId])).rows.map((row) => row.id);
    const revised = new EvidencePipeline({ store, ledger, pipelineVersion: `reassess-${marker}`,
      extractor, identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: [] }; } } });
    const second = await revised.runCachedAssessment({ claimIds, budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:03.000Z", knowledgeCutoff: null });
    expect(second).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    expect(extractionCalls).toBe(1);
    expect((await store.listTaskProposals(task.id)).filter((item) => item.assessmentId)).toHaveLength(1);
  });

  it("leaves failed extraction recoverable with a persisted reason", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: "A report." },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `failure-e2e-${marker}`,
      extractor: { name: "fixture-failure", async extract() { throw new Error("fixture_invalid_output"); } },
      identityResolver: { async resolve() { throw new Error("not reached"); } },
    });
    await expect(pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null }))
      .rejects.toThrow("fixture_invalid_output");
    const result = await pool.query<{ state: string; reason_code: string }>(
      "SELECT state,reason_code FROM observation_dispositions WHERE source_event_id=$1 AND pipeline_version=$2",
      [event.id, `failure-e2e-${marker}`],
    );
    expect(result.rows).toEqual([{ state: "failed", reason_code: "extraction_failed" }]);
  });

  it("resumes assessment from persisted claims after identity resolution fails", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: `${marker}-task`, title: "Publish the report",
      description: "Publish the final report", status: "in_progress" }, "user:e2e");
    const quote = "The final report is published.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    let identityCalls = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `resume-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        extractionCalls += 1;
        return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
          statement: quote, subjectRefs: [task.id], speakerMemberId: null,
          assertedField: "issue_status", assertedValue: "resolved", assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() {
        identityCalls += 1;
        if (identityCalls === 1) throw new Error("fixture identity outage");
        return { relationship: "same_outcome" as const, targetId: task.id,
          alternativeTargetIds: [], reasons: [] };
      } },
    });
    const request = { eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null };
    await expect(pipeline.run(request)).rejects.toThrow("fixture identity outage");
    const resumed = await pipeline.run(request);
    expect(resumed).toMatchObject({ state: "completed", claimCount: 1,
      assessmentCount: 1, pendingProposalCount: 1 });
    expect(extractionCalls).toBe(1);
    expect(identityCalls).toBe(2);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
    const claimId = (await pool.query<{ id: string }>(
      `SELECT c.id FROM evidence_claims c JOIN evidence_dependencies dep
         ON dep.dependent_type='claim' AND dep.dependent_id=c.id
       WHERE dep.source_event_id=$1 ORDER BY c.created_at DESC LIMIT 1`, [event.id],
    )).rows[0]?.id;
    if (!claimId) throw new Error("Expected saved completion claim");
    const claim = (await store.getClaims([claimId]))[0]!;
    const oldAssessment = await store.saveAssessment({ runId: resumed.runId!,
      assessmentKey: `${marker}-legacy-done`, targetType: "task", targetId: task.id,
      targetVersion: String(task.version), contractVersion: null, claimIds: [claimId],
      evidenceFingerprint: marker, permissionFingerprint: marker,
      policyVersion: "evidence-policy-v1", modelVersion: "old-fixture",
      relationship: "same_outcome", disposition: "review_required",
      reasonCodes: ["reported_completion_unverified"],
      body: { schemaVersion: 1, kind: "task", relationship: "same_outcome",
        alternativeTargetIds: [], fields: [{ operation: { field: "status", op: "set", value: "done",
          supportingClaimIds: [claimId] }, verdict: "supported", support: claim.body.spans,
          contradictions: [], effectiveAt: claim.body.assertedAt, reasonCodes: [] }],
        criteria: [], coverage: { complete: false, requiredResources: [],
          gaps: ["outcome_contract_unverified"], checkedAt: request.evaluationClock },
        rawScores: [], explanation: quote } }, []);
    const oldProposal = await ledger.proposeAssessedTaskChange({ assessmentId: oldAssessment.id,
      operations: oldAssessment.body.fields.map((field) => field.operation),
      rationale: quote, requestedBy: "evidence-pipeline" });
    await expect(ledger.approveProposal(oldProposal.id, "user:e2e", "I reviewed the report"))
      .rejects.toMatchObject({ code: "CONFLICT" });
    const regated = await pipeline.runCachedAssessment({ claimIds: [claimId], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:04.000Z", knowledgeCutoff: null });
    expect(regated).toMatchObject({ assessmentCount: 1, pendingProposalCount: 1 });
    const policyRows = await pool.query<{ policy_version: string }>(
      "SELECT policy_version FROM evidence_assessments WHERE run_id=$1", [regated.runId]);
    expect(policyRows.rows).toEqual([{ policy_version: expect.stringMatching(/^evidence-policy-v8:[0-9a-f]{64}$/) }]);
  });

  it("resumes saved claims when the episode also includes a duplicate receipt", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: `${marker}-task`,
      title: `Ship importer ${marker}`, description: "Ship the importer", status: "in_progress" }, "user:e2e");
    const quote = "The importer is complete.";
    const append = async (providerEventId: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId,
      eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: providerEventId, visibility: "slack:channel:C1",
      payloadVersion: "test-v1", payload: { teamId: "T1", channel: "C1", messageTs: marker,
        text: quote },
    })).event;
    const first = await append(`${marker}-socket`);
    const duplicate = await append(`${marker}-history`);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 2000, maxOutputTokens: 1000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    let identityCalls = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `duplicate-resume-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        extractionCalls += 1;
        return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
          statement: quote, subjectRefs: [task.id], speakerMemberId: null,
          assertedField: "status", assertedValue: "done", assertedAt: first.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: first.id,
            originObservationKey: first.observationIdentity!.originObservationKey,
            sourceVersionKey: first.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: first.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() {
        identityCalls += 1;
        if (identityCalls === 1) throw new Error("fixture identity outage");
        return { relationship: "same_outcome" as const, targetId: task.id,
          alternativeTargetIds: [], reasons: [] };
      } },
    });
    const request = { eventIds: [first.id, duplicate.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null };
    await expect(pipeline.run(request)).rejects.toThrow("fixture identity outage");
    const recovered = await pipeline.run(request);
    expect(recovered).toMatchObject({ state: "completed", claimCount: 1,
      assessmentCount: 1, pendingProposalCount: 1 });
    expect(extractionCalls).toBe(1);
  });

  it("uses one identity batch for several saved completion claims", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: `${marker}-task`,
      title: `Ship import path ${marker}`, description: "Ship the complete import path",
      status: "in_progress" }, "user:e2e");
    const text = "The importer shipped. The monitor shipped.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let singleCalls = 0;
    let batchCalls = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `batch-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        const quotes = ["The importer shipped.", "The monitor shipped."];
        return { claims: quotes.map((quote) => { const start = text.indexOf(quote);
          return { schemaVersion: 1 as const, kind: "completion_report" as const,
            statement: quote, subjectRefs: [task.id], speakerMemberId: null,
            assertedField: "status", assertedValue: "done", assertedAt: event.occurredAt,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: [{ eventId: event.id,
              originObservationKey: event.observationIdentity!.originObservationKey,
              sourceVersionKey: event.observationIdentity!.sourceVersionKey,
              locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: start,
                endUtf16: start + quote.length,
                spanHash: createHash("sha256").update(quote).digest("hex") } }],
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }; }),
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0, 1], reasonCode: null }] };
      } }, identityResolver: { async resolve() { singleCalls += 1; throw new Error("single call forbidden"); },
        async resolveMany() { batchCalls += 1; return [
          { relationship: "same_outcome" as const, targetId: task.id,
            alternativeTargetIds: [], reasons: [] },
          { relationship: "part_of" as const, targetId: task.id,
            alternativeTargetIds: [], reasons: [] },
        ]; } } });
    const report = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect(report).toMatchObject({ claimCount: 2, assessmentCount: 2,
      pendingProposalCount: 1 });
    expect(batchCalls).toBe(1);
    expect(singleCalls).toBe(0);
  });

  it("skips superseded old deliveries and processes the current edit once", async () => {
    const marker = randomUUID();
    const sourceRef = `slack:T1:C1:${marker}`;
    const append = async (providerEventId: string, text: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId,
      eventKind: providerEventId.startsWith("edit") ? "message.edited" : "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef, sourceUrl: null, contentHash: providerEventId,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text },
    })).event;
    const first = await append(`original-${marker}`, "The retest is complete.");
    const duplicate = await append(`history-${marker}`, "The retest is complete.");
    const edit = await append(`edit-${marker}`, "The retest failed after review.");
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let extracted = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `edit-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract(input) {
        extracted += 1;
        return { claims: [], dispositions: input.events.map((event) => ({ eventId: event.id,
          state: "no_claim" as const, claimOrdinals: [], reasonCode: "fixture_no_claim" })) };
      } }, identityResolver: { async resolve() { throw new Error("not reached"); } } });
    const request = (eventId: string) => ({ eventIds: [eventId], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null });
    expect((await pipeline.run(request(first.id))).processedEventIds).toEqual([]);
    expect((await pipeline.run(request(duplicate.id))).processedEventIds).toEqual([]);
    expect((await pipeline.run(request(edit.id))).processedEventIds).toEqual([edit.id]);
    expect(extracted).toBe(1);
  });

  it("releases observation leases when budget suspension prevents run creation", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: "A report." },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    await pool.query("UPDATE inference_budgets SET state='suspended' WHERE id=$1", [budget.id]);
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `pre-run-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract() { throw new Error("not reached"); } },
      identityResolver: { async resolve() { throw new Error("not reached"); } } });
    await expect(pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null }))
      .rejects.toThrow("Active inference budget");
    expect((await pool.query<{ state: string; reason_code: string }>(
      "SELECT state,reason_code FROM observation_dispositions WHERE source_event_id=$1 AND pipeline_version=$2",
      [event.id, `pre-run-e2e-${marker}`],
    )).rows).toEqual([{ state: "failed", reason_code: "pre_run_failed" }]);
  });

  it("recovers one information-routed receipt as work without re-extracting its neighbor", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Ship the importer", description: "Ship the importer", status: "in_progress" }, "user:e2e");
    const quote = "The importer is blocked on credentials.";
    const receipt = async (suffix: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId: `${marker}:${suffix}`,
      eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}:${suffix}`,
      sourceUrl: null, contentHash: `${marker}:${suffix}`, visibility: "slack:channel:C1",
      payloadVersion: "test-v1", payload: { teamId: "T1", channel: "C1",
        messageTs: `${marker}:${suffix}`, text: suffix === "recover" ? quote : "Lunch is at noon." },
    })).event;
    const recover = await receipt("recover");
    const neighbor = await receipt("neighbor");
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const extractionCounts = new Map<string, number>();
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `reopen-e2e-${marker}`,
      extractor: { name: "fixture-extractor", async extract({ events }) {
        const event = events[0]!;
        const count = (extractionCounts.get(event.id) ?? 0) + 1;
        extractionCounts.set(event.id, count);
        const found = event.id === recover.id && count === 2;
        return { claims: found ? [{ schemaVersion: 1 as const,
          kind: "progress_report" as const, statement: quote, subjectRefs: [task.id],
          speakerMemberId: null, assertedField: "status", assertedValue: "blocked",
          assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }] : [],
          dispositions: [{ eventId: event.id, state: found ? "extracted" as const : "no_claim" as const,
            claimOrdinals: found ? [0] : [], reasonCode: found ? null : "information_routed" }] };
      } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const run = (eventId: string, reopenNoClaim = false) => pipeline.run({ eventIds: [eventId],
      budgetId: budget.id, evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, reopenNoClaim });
    expect((await run(recover.id)).claimCount).toBe(0);
    expect((await run(neighbor.id)).claimCount).toBe(0);
    expect((await run(recover.id)).state).toBe("no_evidence");
    expect((await run(recover.id, true))).toMatchObject({ claimCount: 1,
      assessmentCount: 1, pendingProposalCount: 1 });
    expect(extractionCounts.get(recover.id)).toBe(2);
    expect(extractionCounts.get(neighbor.id)).toBe(1);
    expect((await store.listTaskProposals(task.id)).some((proposal) =>
      proposal.kind === "task_change" && proposal.state === "pending"
        && proposal.changes.status === "blocked")).toBe(true);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
  });

  it("assesses identical words on distinct Slack objects as distinct observations", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Repair importer", status: "in_progress" }, "user:e2e");
    const quote = "The importer is blocked.";
    const append = async (suffix: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId: `${marker}:${suffix}`,
      eventKind: "message.observed", occurredAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(), sourceRef: `slack:T1:C1:${marker}:${suffix}`,
      sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: `${marker}:${suffix}`, text: quote },
    })).event;
    const first = await append("first");
    const second = await append("second");
    expect(first.observationIdentity?.originObservationKey)
      .not.toBe(second.observationIdentity?.originObservationKey);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    let extractions = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `distinct-text-${marker}`,
      extractor: { name: "fixture-extractor", async extract({ events }) {
        extractions += 1;
        const event = events[0]!;
        return { claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: quote, subjectRefs: [task.id], speakerMemberId: null,
          assertedField: "status", assertedValue: "blocked", assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } }, identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const run = async (eventId: string) => pipeline.run({ eventIds: [eventId],
      budgetId: budget.id, evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    const firstRun = await run(first.id);
    const secondRun = await run(second.id);
    expect(firstRun).toMatchObject({ claimCount: 1, assessmentCount: 1 });
    expect(secondRun).toMatchObject({ claimCount: 1, assessmentCount: 1 });
    expect(extractions).toBe(2);
    const claims = [...await store.listClaimsByRun(firstRun.runId!),
      ...await store.listClaimsByRun(secondRun.runId!)];
    expect(new Set(claims.map((claim) => claim.body.spans[0]?.originObservationKey)).size).toBe(2);
  });

  it("keeps an original, its quote, summary, and duplicate from becoming independent proof", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Verify release", status: "in_progress" }, "user:e2e");
    const sha = "d".repeat(40);
    const contract = { version: 1, statement: "Release verified", scope: "Exact release",
      exclusions: [], criteria: [{ id: "ci", description: "Integration passed",
        required: true, evidenceRule: { kind: "check_passed" as const,
          authorityPolicyId: null, artifactRefs: [sha], requiredCheckNames: ["integration"],
          requiredEnvironment: null, maxMutableAgeSeconds: 900 },
        acceptedBy: "pending", acceptedAt: "2020-01-01T00:00:00.000Z" }],
      provenance: { proposalId: randomUUID(), evidenceIds: [], actor: "pending",
        acceptedAt: "2020-01-01T00:00:00.000Z" } };
    const proposedContract = await ledger.propose({ taskId: task.id,
      baseRevision: task.version, changes: { outcomeContract: contract },
      rationale: "Require exact CI", requestedBy: "user:e2e", evidenceIds: [] });
    await ledger.approveProposal(proposedContract.id, "user:e2e", "Reviewed release criterion");
    const append = async (suffix: string, text: string, messageTs = `${marker}:${suffix}`) => {
      const now = new Date().toISOString();
      return (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: `${marker}:${suffix}`, eventKind: "message.observed",
        occurredAt: now, fetchedAt: now, sourceRef: `slack:T1:C1:${messageTs}`,
        sourceUrl: null, contentHash: `${marker}:${suffix}`, visibility: "company",
        payloadVersion: "test-v1", payload: { teamId: "T1", channel: "C1", messageTs, text } })).event;
    };
    const original = await append("original", "The release is complete.");
    const duplicate = await append("import", "The release is complete.", `${marker}:original`);
    const quote = await append("quote", 'Quoting the source: "The release is complete."');
    const summary = await append("summary", "Summary: the release is complete.");
    expect(duplicate.observationIdentity?.originObservationKey)
      .toBe(original.observationIdentity?.originObservationKey);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    let sourceClaimId: string | null = null;
    let extractions = 0;
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `corroboration-${marker}`,
      extractor: { name: "fixture-extractor", async extract({ events }) {
        extractions += 1;
        const event = events[0]!;
        const text = (event.payload as { text: string }).text;
        return { claims: [{ schemaVersion: 1 as const, kind: "completion_report" as const,
          statement: "The release is complete.", subjectRefs: [task.id],
          speakerMemberId: null, assertedField: "status", assertedValue: "done",
          assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: text.length, spanHash: createHash("sha256").update(text).digest("hex") } }],
          derivedFromClaimIds: event.id === quote.id && sourceClaimId ? [sourceClaimId] : [],
          supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } }, identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const run = async (eventId: string) => pipeline.run({ eventIds: [eventId],
      budgetId: budget.id, evaluationClock: new Date(Date.now() + 1_000).toISOString(),
      knowledgeCutoff: null });
    const first = await run(original.id);
    sourceClaimId = (await store.listClaimsByRun(first.runId!))[0]!.id;
    expect((await run(duplicate.id)).claimCount).toBe(0);
    const quoted = await run(quote.id);
    const summarized = await run(summary.id);
    const assessmentFor = async (runId: string) => {
      const row = (await pool.query<{ id: string }>(
        "SELECT id FROM evidence_assessments WHERE run_id=$1", [runId])).rows[0];
      return store.getAssessment(row!.id);
    };
    expect((await assessmentFor(quoted.runId!))?.reasonCodes)
      .toContain("corroboration_same_origin");
    expect((await assessmentFor(summarized.runId!))?.reasonCodes)
      .toContain("unknown_independence");
    for (const report of [first, quoted, summarized]) {
      const assessment = await assessmentFor(report.runId!);
      expect(assessment?.body.criteria[0]?.verdict).toBe("insufficient");
      expect(assessment?.disposition).toBe("review_required");
    }
    expect(extractions).toBe(3);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
  });

  it("keeps two outcomes and an unresolved portion of one message separate", async () => {
    const marker = randomUUID();
    const retest = await ledger.createTask({ clientEventId: `${marker}:retest`,
      title: "Run importer retest", status: "in_progress" }, "user:e2e");
    const repair = await ledger.createTask({ clientEventId: `${marker}:repair`,
      title: "Repair importer", status: "in_progress" }, "user:e2e");
    const first = "The importer retest is complete.";
    const second = "The importer repair is blocked on credentials.";
    const text = `${first} ${second} The remaining note is ambiguous.`;
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: new Date().toISOString(),
      fetchedAt: new Date().toISOString(), sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const claim = (quote: string, taskId: string, kind: "completion_report" | "progress_report",
      field: string | null, value: string | null) => ({ schemaVersion: 1 as const, kind,
      statement: quote, subjectRefs: [taskId], speakerMemberId: null,
      assertedField: field, assertedValue: value, assertedAt: event.occurredAt,
      validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
      spans: [{ eventId: event.id,
        originObservationKey: event.observationIdentity!.originObservationKey,
        sourceVersionKey: event.observationIdentity!.sourceVersionKey,
        locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: text.indexOf(quote),
          endUtf16: text.indexOf(quote) + quote.length,
          spanHash: createHash("sha256").update(quote).digest("hex") } }],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `two-outcomes-${marker}`,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [claim(first, retest.id, "completion_report", null, null),
          claim(second, repair.id, "progress_report", "status", "blocked")],
        dispositions: [{ eventId: event.id, state: "partial" as const,
          claimOrdinals: [0, 1], reasonCode: "ambiguous_tail" }] };
      } }, identityResolver: { async resolve({ claim: body }) { return {
        relationship: "same_outcome" as const, targetId: body.subjectRefs[0]!,
        alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    expect(result).toMatchObject({ claimCount: 2, assessmentCount: 2 });
    expect((await store.getLatestObservationDisposition(event.id, `two-outcomes-${marker}`))?.state)
      .toBe("partial");
    const saved = await store.listClaimsByRun(result.runId!);
    expect(saved).toHaveLength(2);
    expect(saved.map((item) => item.body.spans[0]?.locator)).toEqual(expect.arrayContaining([
      expect.objectContaining({ startUtf16: 0, endUtf16: first.length }),
      expect.objectContaining({ startUtf16: first.length + 1,
        endUtf16: first.length + 1 + second.length }),
    ]));
    expect((await ledger.getTask(retest.id))?.status).toBe("in_progress");
    expect((await ledger.getTask(repair.id))?.status).toBe("in_progress");
  });

  it("applies one exact authorized status attestation once across a worker retry", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Attested importer", description: "Ship the importer", status: "in_progress" }, "user:e2e");
    const mapped = await store.reconcileMemberIdentity({ provider: "slack", installationKey: "T-AUTH",
      externalId: `U-${marker}`, displayName: `Attester ${marker}` });
    if (!mapped.member) throw new Error("Fixture member identity was not mapped.");
    const quote = `PANINI_STATUS task=${task.id} status=blocked`;
    const now = new Date().toISOString();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T-AUTH",
      providerEventId: marker, eventKind: "message.observed", occurredAt: now,
      fetchedAt: now, sourceRef: `slack:T-AUTH:C-AUTH:${marker}`, sourceUrl: null,
      contentHash: marker, visibility: "company", payloadVersion: "test-v1",
      payload: { teamId: "T-AUTH", channel: "C-AUTH", messageTs: marker,
        user: `U-${marker}`, text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    let extractionCalls = 0;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `auto-e2e-${marker}`,
      application: { mode: "apply", autoApplyClasses: ["task_nonterminal"], authorityPolicies: [{
        id: `policy-${marker}`, version: 1, memberIds: [mapped.member.id], roles: [],
        providers: ["slack"], installationKeys: ["T-AUTH"], objectKinds: ["message.observed"],
        criterionKinds: ["status_nonterminal"], audience: ["company"],
        maxAttestationAgeSeconds: 900 }] },
      extractor: { name: "fixture-extractor", async extract() {
        extractionCalls += 1;
        return { claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: quote, subjectRefs: [task.id], speakerMemberId: mapped.member!.id,
          assertedField: "status", assertedValue: "blocked", assertedAt: now,
          validFrom: null, validTo: null, temporalBasis: "explicit" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    const run = () => pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    expect((await run()).pendingProposalCount).toBe(0);
    expect((await ledger.getTask(task.id))?.status).toBe("blocked");
    expect((await store.listTaskProposals(task.id)).filter((proposal) =>
      proposal.state === "auto_applied")).toHaveLength(1);
    const revisions = await store.listTaskRevisions(task.id);
    expect(revisions.at(-1)?.decisionMetadata?.basis).toBe("authorized_attestation");
    expect((await run()).state).toBe("no_evidence");
    expect((await store.listTaskRevisions(task.id)).map((revision) => revision.id))
      .toEqual(revisions.map((revision) => revision.id));
    expect(extractionCalls).toBe(1);

    // Inject an exhausted shared budget while leaving the source and actor valid.
    await pool.query("UPDATE inference_budgets SET spent_calls=max_calls WHERE id=$1", [budget.id]);
    const secondTask = await ledger.createTask({ clientEventId: `${marker}:budget`,
      title: "Budget-bound attestation", status: "in_progress" }, "user:e2e");
    const secondQuote = `PANINI_STATUS task=${secondTask.id} status=blocked`;
    const secondNow = new Date().toISOString();
    const secondEvent = (await store.appendSourceEvent({ provider: "slack",
      installationKey: "T-AUTH", providerEventId: `${marker}:budget`,
      eventKind: "message.observed", occurredAt: secondNow, fetchedAt: secondNow,
      sourceRef: `slack:T-AUTH:C-AUTH:${marker}:budget`, sourceUrl: null,
      contentHash: `${marker}:budget`, visibility: "company", payloadVersion: "test-v1",
      payload: { teamId: "T-AUTH", channel: "C-AUTH", messageTs: `${marker}:budget`,
        user: `U-${marker}`, text: secondQuote } })).event;
    const noHeadroom = new EvidencePipeline({ store, ledger,
      pipelineVersion: `auto-budget-e2e-${marker}`,
      application: { mode: "apply", autoApplyClasses: ["task_nonterminal"], authorityPolicies: [{
        id: `policy-${marker}`, version: 1, memberIds: [mapped.member.id], roles: [],
        providers: ["slack"], installationKeys: ["T-AUTH"], objectKinds: ["message.observed"],
        criterionKinds: ["status_nonterminal"], audience: ["company"],
        maxAttestationAgeSeconds: 900 }] },
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: secondQuote, subjectRefs: [secondTask.id], speakerMemberId: mapped.member!.id,
          assertedField: "status", assertedValue: "blocked", assertedAt: secondNow,
          validFrom: null, validTo: null, temporalBasis: "explicit" as const,
          spans: [{ eventId: secondEvent.id,
            originObservationKey: secondEvent.observationIdentity!.originObservationKey,
            sourceVersionKey: secondEvent.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: secondQuote.length,
              spanHash: createHash("sha256").update(secondQuote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: secondEvent.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: secondTask.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    expect((await noHeadroom.run({ eventIds: [secondEvent.id], budgetId: budget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null })).pendingProposalCount).toBe(1);
    expect((await ledger.getTask(secondTask.id))?.status).toBe("in_progress");
    expect((await store.listTaskProposals(secondTask.id)).filter((proposal) =>
      proposal.state === "pending")).toHaveLength(1);
  });

  it("credits an authorized criterion attestation only to its named accepted criterion", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: "Validate the importer", status: "in_progress" }, "user:e2e");
    const policyId = `criterion-policy-${marker}`;
    const criterion = (id: string) => ({ id, description: `Validate ${id}`,
      required: true, evidenceRule: { kind: "authorized_attestation" as const,
        authorityPolicyId: policyId, artifactRefs: [], requiredCheckNames: [],
        requiredEnvironment: null, maxMutableAgeSeconds: 900 },
      acceptedBy: "pending", acceptedAt: "2020-01-01T00:00:00.000Z" });
    const contract = { version: 1, statement: "Importer validated", scope: "Full importer",
      exclusions: [], criteria: [criterion("diagnostic"), criterion("release")],
      provenance: { proposalId: randomUUID(), evidenceIds: [], actor: "pending",
        acceptedAt: "2020-01-01T00:00:00.000Z" } };
    const contractProposal = await ledger.propose({ taskId: task.id, baseRevision: task.version,
      changes: { outcomeContract: contract }, rationale: "Set two required checks",
      requestedBy: "user:e2e", evidenceIds: [] });
    await ledger.approveProposal(contractProposal.id, "user:e2e", "Reviewed criteria");
    const mapped = await store.reconcileMemberIdentity({ provider: "slack", installationKey: "T-CRITERION",
      externalId: `U-${marker}`, displayName: `Criterion attester ${marker}` });
    if (!mapped.member) throw new Error("Fixture identity was not mapped.");
    const attestationText = `PANINI_CRITERION task=${task.id} criterion=diagnostic satisfied`;
    const completionText = "The entire importer is complete.";
    const append = async (suffix: string, text: string) => {
      const now = new Date().toISOString();
      return (await store.appendSourceEvent({ provider: "slack", installationKey: "T-CRITERION",
        providerEventId: `${marker}:${suffix}`, eventKind: "message.observed",
        occurredAt: now, fetchedAt: now, sourceRef: `slack:T-CRITERION:C:${marker}:${suffix}`,
        sourceUrl: null, contentHash: `${marker}:${suffix}`, visibility: "company",
        payloadVersion: "test-v1", payload: { teamId: "T-CRITERION", channel: "C",
          messageTs: `${marker}:${suffix}`, user: `U-${marker}`, text } })).event;
    };
    const attestation = await append("attestation", attestationText);
    const completion = await append("completion", completionText);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `criterion-e2e-${marker}`,
      application: { mode: "review", autoApplyClasses: [], authorityPolicies: [{
        id: policyId, version: 1, memberIds: [mapped.member.id], roles: [], providers: ["slack"],
        installationKeys: ["T-CRITERION"], objectKinds: ["message.observed"],
        criterionKinds: ["authorized_attestation"], audience: ["company"] }] },
      extractor: { name: "fixture-extractor", async extract({ events }) {
        const event = events[0]!;
        const isAttestation = event.id === attestation.id;
        const quote = isAttestation ? attestationText : completionText;
        return { claims: [{ schemaVersion: 1 as const,
          kind: isAttestation ? "progress_report" as const : "completion_report" as const,
          statement: quote, subjectRefs: isAttestation ? [task.id, "diagnostic"] : [task.id],
          speakerMemberId: mapped.member!.id,
          assertedField: isAttestation ? "criterion_attestation" : "status",
          assertedValue: isAttestation ? "diagnostic" : "done",
          assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
      } },
      identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
        targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
    });
    await pipeline.run({ eventIds: [attestation.id], budgetId: budget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    const completionRun = await pipeline.run({ eventIds: [completion.id], budgetId: budget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    const assessment = (await store.listAssessmentsForTask(task.id, 20))
      .find((item) => item.runId === completionRun.runId);
    expect(assessment?.body.criteria).toMatchObject([
      { criterionId: "diagnostic", verdict: "satisfied", verifiedBy: "authorized_actor" },
      { criterionId: "release", verdict: "insufficient" },
    ]);
    expect(assessment?.body.coverage.complete).toBe(false);
    expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
  });

  it("keeps missing, failed, malformed and budget-exhausted judgments in review", async () => {
    for (const mode of ["missing", "timeout", "malformed", "budget"] as const) {
      const marker = randomUUID();
      const task = await ledger.createTask({ clientEventId: marker,
        title: `Judge failure ${mode}`, status: "in_progress" }, "user:e2e");
      const quote = `The ${mode} task is blocked.`;
      const observedAt = new Date().toISOString();
      const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: marker, eventKind: "message.observed",
        occurredAt: observedAt, fetchedAt: observedAt,
        sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
        visibility: "company", payloadVersion: "test-v1",
        payload: { teamId: "T1", channel: "C1", messageTs: marker, text: quote } })).event;
      const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
        maxInputTokens: 10000, maxOutputTokens: 1000, maxUsd: null,
        deadline: new Date(Date.now() + 60_000).toISOString(),
        priceBasis: { ...LUNA_PRICE_2026_10_01 } });
      if (mode === "budget") await pool.query(
        "UPDATE inference_budgets SET spent_calls=max_calls WHERE id=$1", [budget.id]);
      let providerCalls = 0;
      const judge = mode === "missing" ? undefined : new OpenAIEvidenceJudge({ store,
        apiKey: "mock-key", model: LUNA_PRICE_2026_10_01.model,
        allowedVisibilities: ["company"], priceBasis: LUNA_PRICE_2026_10_01,
        fetcher: async () => {
          providerCalls += 1;
          if (mode === "timeout") throw new DOMException("synthetic timeout", "TimeoutError");
          return new Response(JSON.stringify({ id: `response-${marker}`,
            model: LUNA_PRICE_2026_10_01.model, status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: "malformed" }] }],
            usage: { input_tokens: 100, output_tokens: 20,
              input_tokens_details: { cached_tokens: 0 } } }),
          { status: 200, headers: { "content-type": "application/json" } });
        } });
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `judge-${mode}-${marker}`,
        ...(judge ? { judge } : {}),
        extractor: { name: "fixture-extractor", async extract() { return {
          claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
            statement: quote, subjectRefs: [task.id], speakerMemberId: null,
            assertedField: "status", assertedValue: "blocked", assertedAt: event.occurredAt,
            validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
            spans: [{ eventId: event.id,
              originObservationKey: event.observationIdentity!.originObservationKey,
              sourceVersionKey: event.observationIdentity!.sourceVersionKey,
              locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
                endUtf16: quote.length, spanHash: createHash("sha256").update(quote).digest("hex") } }],
            derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
          dispositions: [{ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [0], reasonCode: null }] };
        } },
        identityResolver: { async resolve() { return { relationship: "same_outcome" as const,
          targetId: task.id, alternativeTargetIds: [], reasons: ["explicit_subject"] }; } },
      });
      const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
        evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
      const assessment = (await store.listAssessmentsForTask(task.id, 10))
        .find((item) => item.runId === result.runId);
      expect(assessment?.disposition).toBe("review_required");
      expect(assessment?.reasonCodes, `${mode}: ${assessment?.reasonCodes.join(",")}`)
        .toContain(mode === "missing" ? "model_unavailable"
          : mode === "budget" ? "judge:budget_exhausted"
            : mode === "malformed" ? "judge:model_failure" : "model_failure");
      expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
      expect((await store.listTaskProposals(task.id)).every((proposal) =>
        proposal.state !== "auto_applied")).toBe(true);
      expect(providerCalls).toBe(mode === "timeout" || mode === "malformed" ? 1 : 0);
    }
  });
});
