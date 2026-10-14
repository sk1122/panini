import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";
import { OpenAIClaimExtractor } from "../src/intelligence/claim-extractor.js";
import { OpenAIWorkSearchResolver } from "../src/intelligence/work-search-resolver.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "../src/intelligence/model-price.js";
import { OpenAIEvidenceJudge } from "../src/intelligence/evidence-judge.js";
import { loadConfig } from "../src/config.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { AutonomousAdjudicator } from "../src/adjudication/engine.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { buildHttpServer } from "../src/http/server.js";
import { IdentityService } from "../src/security/identity.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { PayloadCipher } from "../src/security/payload-cipher.js";
import type { ClaimBody } from "../src/domain/evidence-types.js";
import type { SourceEvent } from "../src/domain/types.js";

// Failure cases written before implementation:
// Missing parent context; unrelated/private/future/superseded context; unrecorded truncation;
// contextual receipts accidentally processed; live/replay disagreement; invented contextual claims;
// cross-source fact duplicates; stale or disappeared fact targets; approval against a changed fact;
// per-claim judgments disagree; unsupported fields or claim IDs; acceptance before human approval.
const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const organizationId = randomUUID();
const artifacts: unknown[] = [];
describe("Reviewed beta through durable source, proposal, acceptance, and agent reads", () => {
  let store: PostgresLedgerStore, ledger: TeamLedger, pool: pg.Pool;
  beforeAll(async () => {
    if (!databaseUrl?.includes("panini_e2e")) throw new Error("Disposable panini_e2e database required");
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Reviewed beta E2E')",
      [organizationId, `beta-${organizationId}`]);
    store = new PostgresLedgerStore(databaseUrl, Buffer.alloc(32, 39).toString("base64"), organizationId);
    ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
  });
  afterAll(async () => {
    await mkdir("artifacts/evidence-state/finish-20261003", { recursive: true });
    await writeFile("artifacts/evidence-state/finish-20261003/reviewed-beta-e2e.json",
      JSON.stringify({ generatedAt: new Date().toISOString(), database: "panini_e2e",
        provider: "fixtures", externalProviderCalls: 0, cases: artifacts }, null, 2) + "\n");
    await store?.close(); await pool?.end();
  });
  async function receipt(text: string, thread: string, at: string, extra = {}) {
    const marker = randomUUID();
    return (await store.appendSourceEvent({ provider: "slack", installationKey: "TBETA",
      providerEventId: marker, eventKind: "message.observed", occurredAt: at, fetchedAt: at,
      sourceRef: `slack:TBETA:CBETA:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:CBETA", payloadVersion: "test-v1",
      payload: { teamId: "TBETA", channel: "CBETA", messageTs: marker, threadTs: thread, text, ...extra } })).event;
  }
  function claim(event: SourceEvent, kind: ClaimBody["kind"], field: string | null = null,
    value: string | null = null): ClaimBody {
    const text = (event.payload as { text: string }).text;
    return { schemaVersion: 1, kind, statement: text, subjectRefs: ["importer"], speakerMemberId: null,
      assertedAt: event.occurredAt, assertedField: field, assertedValue: value,
      validFrom: null, validTo: null, temporalBasis: "relative_to_source",
      spans: [{ eventId: event.id, originObservationKey: event.observationIdentity!.originObservationKey,
        sourceVersionKey: event.observationIdentity!.sourceVersionKey,
        locator: { kind: "text", jsonPointer: "/text", startUtf16: 0, endUtf16: text.length,
          spanHash: createHash("sha256").update(text).digest("hex") } }],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] };
  }
  async function budget() { return store.createInferenceBudget({ label: randomUUID(), maxCalls: 10,
    maxInputTokens: 100_000, maxOutputTokens: 10_000, maxUsd: null,
    deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null }); }
  const unrelated = { async resolve() { return { relationship: "unrelated" as const,
    targetId: null, alternativeTargetIds: [], reasons: [] }; } };

  // Failure cases before the partial-scope fix: real component work is dropped;
  // a request starts work; a component completes the whole task or determines its result;
  // a reviewed progress candidate changes accepted state before approval;
  // a newer request makes old component work appear fresh.
  it("reviews partial-scope component progress without promoting requests or whole outcomes", async () => {
    const scenarios = [
      { name: "component-progress", kind: "context_statement" as const, text: "Type-aware linting now passes in db.",
        operation: { op: "set" as const, field: "status" as const, value: "in_progress" as const }, expected: 1 },
      { name: "request-only", kind: "request" as const, text: "Please start type-aware linting in db.",
        operation: { op: "set" as const, field: "status" as const, value: "in_progress" as const }, expected: 0 },
      { name: "supported-request-only", kind: "request" as const, text: "Please start type-aware linting in db.",
        operation: { op: "set" as const, field: "status" as const, value: "in_progress" as const }, expected: 0 },
      { name: "component-completion", kind: "completion_report" as const, text: "The db lint component is finished.",
        operation: { op: "set" as const, field: "status" as const, value: "done" as const }, expected: 0 },
      { name: "component-result", kind: "progress_report" as const, text: "The db lint component passed its checks.",
        operation: { op: "set" as const, field: "result" as const, value: "succeeded" as const }, expected: 0 },
      { name: "mixed-stale-work", kind: "request" as const, text: "Please start type-aware linting in db now.",
        operation: { op: "set" as const, field: "status" as const, value: "in_progress" as const }, expected: 0 },
    ];
    for (const scenario of scenarios) {
      const task = await ledger.createTask({ clientEventId: randomUUID(), title: `Lint rollout ${scenario.name}`,
        status: "planned" }, "user:e2e");
      const at = new Date(Date.now() + 1_000).toISOString();
      const source = await receipt(scenario.text, randomUUID(), at);
      const sources = [source];
      if (scenario.name === "mixed-stale-work") sources.push(await receipt("The old db lint component passed.",
        randomUUID(), new Date(Date.now() - 60_000).toISOString()));
      const inferenceBudget = await budget();
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `partial-scope-${randomUUID()}`,
        extractor: { name: "fixture-partial-scope", async extract({ events }) { return {
          claims: events.map(event => claim(event, event.id === source.id ? scenario.kind : "progress_report")),
          dispositions: events.map((event, index) => ({ eventId: event.id, state: "extracted" as const,
            claimOrdinals: [index], reasonCode: null })) }; } },
        identityResolver: { supportsObservationAttribution: true, async resolve() { return {
          relationship: "same_outcome" as const, targetId: task.id, alternativeTargetIds: [], reasons: [] }; } },
        judge: { async assess() { throw new Error("Joint assessment required"); }, async assessTarget(input) {
          const verdict: "supported" | "partial_scope" = scenario.name === "supported-request-only"
            ? "supported" : "partial_scope";
          return { fields: [{ operation: { ...scenario.operation, supportingClaimIds: input.claims.map(claim => claim.id) },
            verdict, reasonCodes: [] }], reasonCodes: ["component_scope"],
            explanation: "Only one component of the broader lint rollout is evidenced." };
        } }, application: { mode: "review", autoApplyClasses: [], authorityPolicies: [] } });
      const report = await pipeline.run({ eventIds: sources.map(event => event.id), budgetId: inferenceBudget.id,
        evaluationClock: new Date(Date.now() + 2_000).toISOString(), knowledgeCutoff: null });
      expect(report.pendingProposalCount).toBe(scenario.expected);
      expect((await store.getTask(task.id))?.status).toBe("planned");
      const proposal = (await store.listProposals()).find(p => p.assessmentId && p.evidenceIds.includes(source.id));
      if (scenario.expected) {
        expect(proposal?.state).toBe("pending");
        await ledger.approveProposal(proposal!.id, "user:e2e", "Verified component work supports progress only");
        expect((await store.getTask(task.id))?.status).toBe("in_progress");
      } else expect(proposal).toBeUndefined();
      artifacts.push({ case: `partial-scope-${scenario.name}`, passed: true, taskId: task.id,
        eventId: source.id, expectedPendingProposals: scenario.expected });
    }
  });

  // A shared statement must not alias two receipts with different dates or source context.
  it("processes distinct receipts with identical statements without model-call key collisions", async () => {
    const task = await ledger.createTask({ clientEventId: randomUUID(), title: "Importer key collision",
      status: "planned" }, "user:e2e");
    const first = await receipt("Importer work started.", randomUUID(), "2026-10-02T00:00:00Z");
    const second = await receipt("Importer work started.", randomUUID(), "2026-10-02T00:01:00Z");
    const bodies = [first, second].map(event => ({ ...claim(event, "progress_report", "status", "in_progress"),
      subjectRefs: [task.id] }));
    const inferenceBudget = await budget();
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "fixture", model: "gpt-6-luna",
      priceBasis: GPT6_LUNA_PRICE_2026_10_01, allowedVisibilities: [first.visibility],
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body));
        const searched = request.input.some((item: { type?: string }) => item.type === "function_call_output");
        return Response.json({ id: randomUUID(), model: "gpt-6-luna", status: "completed",
          usage: { input_tokens: 80, output_tokens: 30 }, output: searched
            ? [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
              relationship: "same_outcome", targetId: task.id, alternativeTargetIds: [],
              reasons: ["same_importer"], suggestedStatus: "in_progress", statusBasis: "work started",
              requestIntent: null }) }] }]
            : [{ type: "function_call", name: "search_tasks", call_id: randomUUID(),
              arguments: JSON.stringify({ query: task.id, limit: 1, method: "keyword" }) }] });
      } });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `same-statement-${randomUUID()}`,
      extractor: { name: "fixture", async extract({ events }) { return { claims: bodies,
        dispositions: events.map((event, index) => ({ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [index], reasonCode: null })) }; } }, identityResolver: resolver,
      judge: { async assess() { throw new Error("Joint assessment required"); },
        async assessTarget() { return { fields: [], reasonCodes: [], explanation: "Fixture leaves acceptance unchanged." }; } },
      application: { mode: "review", autoApplyClasses: [], authorityPolicies: [] } });
    const run = await pipeline.run({ eventIds: [first.id, second.id], budgetId: inferenceBudget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    const calls = await store.listModelCalls(run.runId!);
    expect(run.state).toBe("completed");
    expect(calls).toHaveLength(4);
    expect(calls.every(call => call.state === "succeeded")).toBe(true);
    expect(new Set(calls.map(call => call.logicalCallKey)).size).toBe(4);
    expect((await store.getTask(task.id))?.status).toBe("planned");
    artifacts.push({ case: "same-statement-distinct-receipts", passed: true,
      eventIds: [first.id, second.id], modelCallIds: calls.map(call => call.id) });
  });

  it("uses the same bounded parent context in live and historical processing without consuming it", async () => {
    const thread = randomUUID();
    const parent = await receipt("Retest the importer, including its signed webhook.", thread, "2026-10-02T00:00:00Z");
    const reply = await receipt("The retest passed.", thread, "2026-10-02T00:01:00Z");
    const future = await receipt("Later: the webhook failed.", thread, "2026-10-02T00:02:00Z");
    const outsider = await receipt("Unrelated billing migration.", randomUUID(), "2026-10-02T00:00:00Z");
    await pool.query("UPDATE source_events SET received_at=$2 WHERE organization_id=$1 AND id=ANY($3::uuid[])",
      [organizationId, "2026-10-02T00:01:30Z", [parent.id, reply.id, outsider.id]]);
    await pool.query("UPDATE source_events SET received_at='2026-10-02T00:03:00Z' WHERE organization_id=$1 AND id=$2",
      [organizationId, future.id]);
    const captured: Array<{ active: string[]; context: string[] }> = [];
    for (const historical of [false, true]) {
      const inferenceBudget = await budget();
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `context-${randomUUID()}`,
        sourceContext: { allowedVisibilities: ["slack:channel:CBETA"], maxEvents: 20, maxPayloadBytes: 24_000 },
        extractor: { name: "fixture-context", async extract(input) {
          captured.push({ active: input.events.map(e => e.id), context: (input.contextEvents ?? []).map(e => e.id) });
          return { claims: [], dispositions: input.events.map(e => ({ eventId: e.id,
            state: "no_claim" as const, claimOrdinals: [], reasonCode: "fixture_no_claim" })) };
        } }, identityResolver: unrelated });
      const result = await pipeline.run({ eventIds: [reply.id], budgetId: inferenceBudget.id,
        evaluationClock: "2026-10-02T00:02:00Z", knowledgeCutoff: "2026-10-02T00:02:00Z",
        replayMode: historical ? "historical_eval" : "live", historicalEvaluation: historical });
      const envelope = (await pool.query("SELECT manifest_envelope FROM interpretation_runs WHERE organization_id=$1 AND id=$2",
        [organizationId, result.runId])).rows[0].manifest_envelope;
      expect(new PayloadCipher(Buffer.alloc(32, 39).toString("base64")).decrypt(envelope))
        .toMatchObject({ activeEventIds: [reply.id], contextualEventIds: [parent.id] });
      const dispositions = await pool.query("SELECT source_event_id FROM observation_dispositions WHERE organization_id=$1 AND run_id=$2",
        [organizationId, result.runId]);
      expect(dispositions.rows.map(row => row.source_event_id)).toEqual([reply.id]);
    }
    expect(captured).toEqual([{ active: [reply.id], context: [parent.id] }, { active: [reply.id], context: [parent.id] }]);
    artifacts.push({ case: "live-replay-parent-parity", passed: true, parentId: parent.id, replyId: reply.id });
  });

  it("puts context in the real extractor request while quoting and settling only the active receipt", async () => {
    const thread = randomUUID();
    const parent = await receipt("The request is an importer retest.", thread, "2026-10-02T00:04:00Z");
    const reply = await receipt("It passed.", thread, "2026-10-02T00:05:00Z");
    let requestText = "";
    const inferenceBudget = await budget();
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `extract-context-${randomUUID()}`,
      sourceContext: { allowedVisibilities: ["slack:channel:CBETA"], maxEvents: 20, maxPayloadBytes: 24_000 },
      extractor: new OpenAIClaimExtractor({ store, apiKey: "fixture", model: "fixture",
        allowedVisibilities: ["slack:channel:CBETA"], fetcher: async (_url, init) => {
          requestText = String(init?.body);
          return new Response(JSON.stringify({ id: randomUUID(), model: "fixture", status: "completed",
            output_text: JSON.stringify({ claims: [{ kind: "progress_report", eventId: reply.id,
              jsonPointer: "/text", quote: "It passed.", statement: "The importer retest passed.",
              subjectRefs: ["importer"], assertedField: null, assertedValue: null,
              assertedAt: reply.occurredAt, caveats: [] }],
              dispositions: [{ eventId: reply.id, state: "extracted", claimOrdinals: [0], reasonCode: null }] }),
            usage: { input_tokens: 200, output_tokens: 100 } }), { status: 200 });
        } }), identityResolver: unrelated });
    const report = await pipeline.run({ eventIds: [reply.id], budgetId: inferenceBudget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    expect(requestText).toContain("The request is an importer retest.");
    const claims = await store.listClaimsByRun(report.runId!);
    expect(claims).toHaveLength(1); expect(claims[0]?.body.spans.map(s => s.eventId)).toEqual([reply.id]);
    artifacts.push({ case: "extractor-read-only-context", passed: true, parentId: parent.id, runId: report.runId });
  });

  it("revises a matched fact across sources and refuses an unchanged or stale correction", async () => {
    const marker = randomUUID();
    const oldSource = await receipt("The importer uses unsigned webhooks.", marker, "2026-10-02T00:00:00Z");
    const oldProposal = await ledger.proposeContextFact({ sourceRef: `company-fact:${marker}`,
      path: `/company/importer/${marker}`, title: "Importer webhook policy", factType: "policy", value: "unsigned",
      rationale: "Accepted original policy", requestedBy: "user:e2e", evidenceIds: [oldSource.id],
      effectiveFrom: oldSource.occurredAt });
    await ledger.approveProposal(oldProposal.id, "user:e2e", "Verified original policy");
    const original = (await store.listContextEntries()).find(e => e.sourceRef === `company-fact:${marker}`)!;
    async function run(text: string, value: string, at: string) {
      const source = await receipt(text, randomUUID(), at), inferenceBudget = await budget();
      const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `fact-correction-${randomUUID()}`,
        extractor: { name: "fixture-fact", async extract() { return { claims: [claim(source, "context_statement", "policy", value)],
          dispositions: [{ eventId: source.id, state: "extracted" as const, claimOrdinals: [0], reasonCode: null }] }; } },
        identityResolver: unrelated, contextResolver: { async resolveContext() {
          return { relationship: "same_fact" as const, targetId: original.id, reasons: ["same importer policy"] }; } } });
      const report = await pipeline.run({ eventIds: [source.id], budgetId: inferenceBudget.id,
        evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
      return { report, source };
    }
    const changed = await run("The importer now requires signed webhooks.", "signed", "2026-10-02T00:10:00Z");
    const proposal = (await store.listProposals()).find(p => p.assessmentId && p.evidenceIds.includes(changed.source.id))!;
    expect(proposal).toMatchObject({ kind: "context_fact_upsert", changes: { sourceRef: original.sourceRef, path: original.path, value: "signed" } });
    expect((await store.getContextEntry(original.id))?.kind).toBe("fact");
    await ledger.approveProposal(proposal.id, "user:e2e", "Verified signed webhook policy");
    expect(await store.getContextEntry(original.id)).toMatchObject({ kind: "fact", value: "signed" });
    expect((await store.listContextEntries()).filter(e => e.path === original.path)).toHaveLength(1);
    expect(await store.listContextRevisions(original.id)).toHaveLength(2);
    expect((await run("The importer still uses signed webhooks.", "signed", "2026-10-02T00:11:00Z")).report.pendingProposalCount).toBe(0);
    expect((await run("The importer uses unsigned webhooks.", "unsigned", "2026-10-02T00:01:00Z")).report.pendingProposalCount).toBe(0);
    artifacts.push({ case: "cross-source-fact-correction", passed: true, contextId: original.id, proposalId: proposal.id });
  });

  it("judges all claims for a target once, proposes both supported fields, and exposes only accepted changes", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker, title: "Retest importer and report its result", status: "planned" }, "user:e2e");
    const first = await receipt("Start the importer retest.", marker, new Date(Date.now() + 1_000).toISOString());
    const second = await receipt("The importer retest ran, but one webhook case failed.", marker, new Date(Date.now() + 2_000).toISOString());
    let judgments = 0;
    const inferenceBudget = await budget();
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `target-group-${marker}`,
      extractor: { name: "fixture-group", async extract() { return {
        claims: [claim(first, "request"), claim(second, "progress_report")],
        dispositions: [{ eventId: first.id, state: "extracted" as const, claimOrdinals: [0], reasonCode: null },
          { eventId: second.id, state: "extracted" as const, claimOrdinals: [1], reasonCode: null }] }; } },
      identityResolver: { supportsObservationAttribution: true, async resolve() { return {
        relationship: "same_outcome" as const, targetId: task.id, alternativeTargetIds: [], reasons: [] }; } },
      judge: new OpenAIEvidenceJudge({ store, apiKey: "fixture", model: "fixture",
        allowedVisibilities: ["slack:channel:CBETA"],
        priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
          cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
        fetcher: async (_url, init) => { judgments++;
          const request = JSON.parse(String(init?.body));
          expect(request.text.format.name).toBe("panini_target_assessment_v1");
          const input = JSON.parse(request.input);
          expect(input.claims).toHaveLength(2);
          expect(input.acceptedHistory).toHaveLength(1);
          const ids = input.claims.map((c: { id: string }) => c.id);
          return new Response(JSON.stringify({ id: randomUUID(), model: "fixture", status: "completed",
            output_text: JSON.stringify({ explanation: "The retest started and has a mixed result.", reasonCodes: [], fields: [
            { operation: { field: "status" as const, op: "set" as const, value: "in_progress" as const, supportingClaimIds: ids }, verdict: "supported" as const },
            { operation: { field: "result" as const, op: "set" as const, value: "mixed" as const, supportingClaimIds: [ids[1]!] }, verdict: "supported" as const } ] }), usage: { input_tokens: 300, output_tokens: 100 } }), { status: 200 });
        } }), application: { mode: "review", autoApplyClasses: [], authorityPolicies: [] } });
    const report = await pipeline.run({ eventIds: [first.id, second.id], budgetId: inferenceBudget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    expect(judgments).toBe(1); expect(report).toMatchObject({ assessmentCount: 1, pendingProposalCount: 1 });
    expect(await ledger.getTaskForAccess(task.id, { kind: "admin" })).toMatchObject({ status: "planned" });
    const proposal = (await store.listTaskProposals(task.id)).find(p => p.assessmentId)!;
    expect(proposal.changes).toMatchObject({ status: "in_progress", result: "mixed" });
    const assessment = await store.getAssessment(proposal.assessmentId!);
    expect(assessment?.claimIds).toHaveLength(2);
    const identity = new IdentityService(databaseUrl!, organizationId);
    const config = await loadConfig();
    Object.assign(config, { databaseUrl, contentEncryptionKey: Buffer.alloc(32, 39).toString("base64"),
      adminToken: "reviewed-beta-e2e-installation-token", publicUrl: "https://panini.example.test" });
    config.app.intelligence.enabled = false; config.app.adjudication.enabled = false;
    const log = { info() {}, error() {} };
    const app = await buildHttpServer({ config, ledger, identity,
      intelligence: new EvidenceIntelligence({ store, ledger, interpreter: null,
        companyName: "Reviewed beta", config: config.app.intelligence, log }),
      adjudicator: new AutonomousAdjudicator({ store, ledger, provider: null,
        companyName: "Reviewed beta", config: config.app.adjudication,
        completionPolicy: { minimumEvidenceItems: 2, evidenceProviders: ["agent"] }, log }),
      jobs: new OutboxQueue(store), replay: new ReplayVerifier(store) });
    try {
      const bootstrap = await app.inject({ method: "POST", url: "/api/auth/bootstrap",
        headers: { origin: config.publicUrl }, payload: { token: config.adminToken,
          companyName: "Reviewed beta", displayName: "Reviewer", email: `beta-${marker}@example.test`,
          password: "A synthetic long fixture password 2026!" } });
      expect(bootstrap.statusCode).toBe(200);
      const agent = await ledger.createAgentProfile({ memberId: bootstrap.json().identity.memberId,
        name: "Reviewed beta reader", harness: "codex", capabilities: ["work:read", "context:read"],
        dataScope: { projects: ["*"], contextPaths: ["/"], sourceVisibilities: ["slack:channel:CBETA"] } });
      async function agentRead() {
        const response = await app.inject({ method: "POST", url: "/mcp",
          headers: { authorization: `Bearer ${agent.secret}`, accept: "application/json, text/event-stream",
            "content-type": "application/json", "mcp-protocol-version": "2025-03-26" },
          payload: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "memory_read",
            arguments: { uri: `panini://context/work/${task.id}` } } } });
        expect(response.statusCode).toBe(200);
        const message = JSON.parse(response.body.split("\n").find(line => line.startsWith("data: "))?.slice(6)
          ?? response.body);
        return message.result.structuredContent.item.task;
      }
      expect(await agentRead()).toMatchObject({ status: "planned" });
      const accepted = await app.inject({ method: "POST", url: `/api/proposals/${proposal.id}/approve`,
        headers: { authorization: `Bearer ${config.adminToken}`, "idempotency-key": randomUUID() },
        payload: { note: "Verified both retest receipts" } });
      expect(accepted.statusCode).toBe(200);
      expect(await agentRead()).toMatchObject({ status: "in_progress", result: "mixed" });
      const visible = await app.inject({ method: "GET", url: `/api/tasks/${task.id}`,
        headers: { authorization: `Bearer ${config.adminToken}` } });
      expect(visible.statusCode).toBe(200);
      expect(visible.json().task).toMatchObject({ status: "in_progress", result: "mixed" });
    } finally { await app.close(); await identity.close(); }
    artifacts.push({ case: "joint-target-approval-agent-read", passed: true, taskId: task.id, proposalId: proposal.id,
      accepted: { status: "in_progress", result: "mixed" }, judgments });
  });

  it("leaves a disappeared context match unresolved instead of creating a duplicate fact", async () => {
    const source = await receipt("The importer uses signed webhooks.", randomUUID(), "2026-10-02T00:25:00Z");
    const inferenceBudget = await budget();
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `missing-fact-${randomUUID()}`,
      extractor: { name: "fixture-fact", async extract() { return { claims: [claim(source, "context_statement", "policy", "signed")],
        dispositions: [{ eventId: source.id, state: "extracted" as const, claimOrdinals: [0], reasonCode: null }] }; } },
      identityResolver: unrelated, contextResolver: { async resolveContext() { return {
        relationship: "same_fact" as const, targetId: randomUUID(), reasons: [] }; } } });
    const report = await pipeline.run({ eventIds: [source.id], budgetId: inferenceBudget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    expect(report.pendingProposalCount).toBe(0);
    expect((await store.listProposals()).filter(p => p.evidenceIds.includes(source.id))).toHaveLength(0);
    artifacts.push({ case: "missing-context-target", passed: true });
  });

  it("rejects a context correction when its matched accepted fact changed before approval", async () => {
    const marker = randomUUID();
    const source = await receipt("The importer uses unsigned webhooks.", marker, "2026-10-02T00:30:00Z");
    const originalInput = { sourceRef: `concurrent-fact:${marker}`, path: `/company/concurrent/${marker}`,
      title: "Webhook policy", factType: "policy" as const, value: "unsigned", rationale: "Original policy",
      requestedBy: "user:e2e", evidenceIds: [source.id], effectiveFrom: source.occurredAt };
    await ledger.approveProposal((await ledger.proposeContextFact(originalInput)).id, "user:e2e", "Original verified");
    const original = (await store.listContextEntries()).find(e => e.sourceRef === originalInput.sourceRef)!;
    const correction = await receipt("The importer now uses signed webhooks.", randomUUID(), "2026-10-02T00:31:00Z");
    const inferenceBudget = await budget();
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `concurrent-fact-${marker}`,
      extractor: { name: "fixture-fact", async extract() { return { claims: [claim(correction, "context_statement", "policy", "signed")],
        dispositions: [{ eventId: correction.id, state: "extracted" as const, claimOrdinals: [0], reasonCode: null }] }; } },
      identityResolver: unrelated, contextResolver: { async resolveContext() { return {
        relationship: "same_fact" as const, targetId: original.id, reasons: [] }; } } });
    await pipeline.run({ eventIds: [correction.id], budgetId: inferenceBudget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    const pending = (await store.listProposals()).find(p => p.assessmentId && p.evidenceIds.includes(correction.id))!;
    const later = await receipt("The importer requires mutual TLS.", randomUUID(), "2026-10-02T00:32:00Z");
    await ledger.approveProposal((await ledger.proposeContextFact({ ...originalInput,
      value: "mutual TLS", evidenceIds: [later.id], effectiveFrom: later.occurredAt })).id, "user:e2e", "New policy verified");
    await expect(ledger.approveProposal(pending.id, "user:e2e", "Old correction reviewed")).rejects.toThrow(/changed|newer|version/i);
    expect(await store.getContextEntry(original.id)).toMatchObject({ kind: "fact", value: "mutual TLS" });
    artifacts.push({ case: "context-version-conflict", passed: true });
  });
});
