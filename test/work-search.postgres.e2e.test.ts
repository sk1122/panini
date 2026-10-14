import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { OpenAIWorkSearchResolver } from "../src/intelligence/work-search-resolver.js";
import { BudgetedVoyageEmbeddings } from "../src/intelligence/voyage-work-embeddings.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const organizationId = randomUUID();
const key = Buffer.alloc(32, 34).toString("base64");

describe("Model-directed accepted work search", () => {
  let pool: pg.Pool;
  let store: PostgresLedgerStore;
  let ledger: TeamLedger;
  beforeAll(async () => {
    if (!databaseUrl?.includes("panini_e2e")) throw new Error("Disposable panini_e2e database required");
    pool = new pg.Pool({ connectionString: databaseUrl });
    expect((await pool.query<{ current_database: string }>("SELECT current_database()"))
      .rows[0]?.current_database).toBe("panini_e2e");
    await pool.query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
      [organizationId, `search-e2e-${organizationId}`, "Work Search E2E"]);
    store = new PostgresLedgerStore(databaseUrl, key, organizationId);
    ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
  });
  afterAll(async () => { await store?.close(); await pool?.end(); });

  it("lets the model search accepted tasks and context, then accepts only returned task IDs", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: `Repair importer ${marker}`, description: "Restore the CSV importer",
      status: "in_progress" }, "user:e2e");
    const context = await ledger.createContextEntry({ kind: "fact", path: `/operations/importer-${marker}`,
      title: `Importer deadline ${marker}`, factType: "other", value: "Friday" }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { text: `The importer retest is done. Deadline is Friday. ${marker}` } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3,
      maxInputTokens: 200_000, maxOutputTokens: 3_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "search-e2e", promptVersion: "v1",
      policyVersion: "v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    const outputs: unknown[] = [];
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["company", "slack:channel:C1"],
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: unknown[] };
        const prior = request.input.at(-1) as { output?: string } | undefined;
        if (prior?.output) outputs.push(JSON.parse(prior.output));
        const output = turn === 0
          ? [{ type: "function_call", name: "search_tasks", call_id: "task-call",
            arguments: JSON.stringify({ query: "importer", limit: 5, method: "keyword" }) }]
          : turn === 1
            ? [{ type: "function_call", name: "search_context", call_id: "context-call",
              arguments: JSON.stringify({ query: "deadline", limit: 5, method: "keyword" }) }]
            : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
              relationship: "part_of", targetId: task.id, alternativeTargetIds: [],
              reasons: ["The retest is a component of the importer repair."],
            }) }] }];
        turn += 1;
        return new Response(JSON.stringify({ id: `mock-${turn}`, model: "mock-model",
          status: "completed", output, usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const resolution = await resolver.resolve({ claim: { schemaVersion: 1,
      kind: "completion_report", statement: "The importer retest is done.",
      subjectRefs: [], speakerMemberId: null, assertedField: "status",
      assertedValue: "done", assertedAt: event.occurredAt, validFrom: null,
      validTo: null, temporalBasis: "relative_to_source", spans: [],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] },
    events: [event], budgetId: budget.id, runId: run.id });
    expect(resolution).toMatchObject({ relationship: "part_of", targetId: task.id });
    expect(outputs[0]).toMatchObject({ tasks: [expect.objectContaining({ id: task.id })] });
    expect(outputs[1]).toMatchObject({ context: [expect.objectContaining({ id: context.id })] });
    expect((await store.listModelCalls(run.id))).toHaveLength(3);
    expect((await store.getTask(task.id))?.status).toBe("in_progress");
    const artifact = { case: "model-directed-work-search", database: "panini_e2e",
      taskId: task.id, contextId: context.id, modelCalls: 3,
      searchedTask: true, searchedContext: true, acceptedUnchanged: true };
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/e2e.json",
      JSON.stringify(artifact, null, 2) + "\n");
  });

  it("flags a possible accepted context match while leaving its update for review", async () => {
    const marker = randomUUID();
    const accepted = await ledger.createContextEntry({ kind: "fact",
      path: `/operations/webhook-${marker}`, title: `Webhook policy ${marker}`,
      factType: "policy", value: "Unsigned webhook",
      effectiveFrom: "2026-10-01T00:00:00.000Z" }, "user:e2e");
    const quote = `Webhook policy ${marker} now requires a signed webhook.`;
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 4,
      maxInputTokens: 100_000, maxOutputTokens: 2_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const contextQueries: string[] = [];
    const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "mock-key",
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: string[]; input_type: string };
        if (request.input_type === "search_query") contextQueries.push(...request.input);
        return new Response(JSON.stringify({ model: "voyage-4",
          data: request.input.map((text, index) => ({ index,
            embedding: [text.includes(marker) || text.includes("Search focus: signed webhook requirement") ? 1 : 0,
              text.includes(marker) || text.includes("Search focus: signed webhook requirement") ? 0 : 1,
              ...Array<number>(1022).fill(0)] })),
          usage: { prompt_tokens: 30, total_tokens: 30 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["company", "slack:channel:C1"], embeddings,
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async () => {
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_context", call_id: "context-call",
            arguments: JSON.stringify({ query: "signed webhook requirement",
              limit: 5, method: "similarity" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "same_fact", targetId: accepted.id,
            reasons: ["The source revises the same webhook policy."],
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-context-${turn}`, model: "mock-model",
          status: "completed", output, usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `work-search-context-${marker}`, identityResolver: resolver,
      contextResolver: resolver,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "context_statement" as const,
          statement: quote, subjectRefs: [marker], speakerMemberId: null,
          assertedField: "policy", assertedValue: "Signed webhook",
          assertedAt: event.occurredAt, validFrom: null, validTo: null,
          temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length,
              spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] }; } },
    });
    const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null });
    expect(result).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 1 });
    const proposal = (await store.listProposals()).find((item) => item.assessmentId
      && item.evidenceIds.includes(event.id));
    expect(proposal?.rationale).toContain("correction to this accepted fact");
    expect(proposal?.changes).toMatchObject({ sourceRef: accepted.sourceRef, path: accepted.path });
    expect((await store.getAssessment(proposal!.assessmentId!))?.reasonCodes)
      .toContain("matched_context_fact");
    expect(await store.getContextEntry(accepted.id)).toMatchObject({
      kind: "fact", value: "Unsigned webhook" });
    expect((await store.listModelCalls(result.runId!)).map((call) => call.purpose).sort())
      .toEqual(["embed", "embed", "identity", "identity"]);
    expect(contextQueries[0]).toContain(quote);
    expect(contextQueries[0]).toContain("Search focus: signed webhook requirement");
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/context-e2e.json",
      JSON.stringify({ case: "context-search-review", database: "panini_e2e",
        acceptedContextId: accepted.id, sourceEventId: event.id,
        runId: result.runId, modelCalls: 4, proposalId: proposal?.id,
        acceptedUnchanged: true }, null, 2) + "\n");
  });

  it("finds a paraphrased task through a budgeted similarity tool call", async () => {
    const marker = randomUUID();
    const target = await ledger.createTask({ clientEventId: `${marker}-target`,
      title: `Repair importer ${marker}`, description: "Fix the CSV loader",
      status: "in_progress" }, "user:e2e");
    await ledger.createTask({ clientEventId: `${marker}-decoy`,
      title: `Redesign billing ${marker}`, description: "Change invoices",
      status: "in_progress" }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { text: "The inbound data path is restored." } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 4,
      maxInputTokens: 100_000, maxOutputTokens: 2_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "semantic-search-e2e", promptVersion: "v1",
      policyVersion: "v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    const vector = (first: boolean) => [first ? 1 : 0, first ? 0 : 1,
      ...Array<number>(1022).fill(0)];
    const taskQueries: string[] = [];
    const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "mock-key",
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: string[]; input_type: string };
        if (request.input_type === "search_query") taskQueries.push(...request.input);
        return new Response(JSON.stringify({ model: "voyage-4",
          data: request.input.map((text, index) => ({ index,
            embedding: vector(text.includes(`Repair importer ${marker}`)
              || text.includes("Search focus: inbound data restoration")) })),
          usage: { prompt_tokens: 30, total_tokens: 30 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    let searched: { tasks: { id: string }[] } | null = null;
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["slack:channel:C1"], embeddings,
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: { output?: string }[] };
        const prior = request.input.at(-1);
        if (prior?.output) searched = JSON.parse(prior.output);
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_tasks", call_id: "similarity-call",
            arguments: JSON.stringify({ query: "inbound data restoration",
              limit: 2, method: "similarity" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "same_outcome", targetId: target.id,
            alternativeTargetIds: [], reasons: ["The data path refers to the loader repair."],
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-similarity-${turn}`,
          model: "mock-model", status: "completed", output,
          usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const resolution = await resolver.resolve({ claim: { schemaVersion: 1,
      kind: "completion_report", statement: "The inbound data path is restored.",
      subjectRefs: [], speakerMemberId: null, assertedField: "status",
      assertedValue: "done", assertedAt: event.occurredAt, validFrom: null,
      validTo: null, temporalBasis: "relative_to_source", spans: [],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] },
    events: [event], budgetId: budget.id, runId: run.id });
    expect(resolution).toMatchObject({ relationship: "same_outcome", targetId: target.id });
    expect((searched as { tasks: { id: string }[] } | null)?.tasks[0]?.id).toBe(target.id);
    expect((await store.listModelCalls(run.id)).map((call) => call.purpose).sort())
      .toEqual(["embed", "embed", "identity", "identity"]);
    expect(taskQueries[0]).toContain("The inbound data path is restored.");
    expect(taskQueries[0]).toContain("Search focus: inbound data restoration");
    expect((await store.getTask(target.id))?.status).toBe("in_progress");
  });

  it("does not expose context accepted after a historical cutoff", async () => {
    const marker = randomUUID();
    await ledger.createContextEntry({ kind: "fact", path: `/operations/later-${marker}`,
      title: `Later policy ${marker}`, factType: "policy", value: "New value" }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { text: `What was the policy for ${marker}?` } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 100_000, maxOutputTokens: 2_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "search-cutoff-e2e", promptVersion: "v1",
      policyVersion: "v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    let result: unknown;
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["company", "slack:channel:C1"],
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const input = (JSON.parse(String(init?.body)) as { input: { output?: string }[] }).input;
        if (input.at(-1)?.output) result = JSON.parse(input.at(-1)!.output!);
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_context", call_id: "cutoff-call",
            arguments: JSON.stringify({ query: marker, limit: 5, method: "keyword" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "uncertain", targetId: null, reasons: ["No accepted context at cutoff"],
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-cutoff-${turn}`, model: "mock-model",
          status: "completed", output, usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const resolution = await resolver.resolveContext({ claim: { schemaVersion: 1,
      kind: "context_statement", statement: `Policy for ${marker}`, subjectRefs: [marker],
      speakerMemberId: null, assertedField: "policy", assertedValue: "Old value",
      assertedAt: event.occurredAt, validFrom: null, validTo: null,
      temporalBasis: "relative_to_source", spans: [], derivedFromClaimIds: [],
      supersedesClaimIds: [], caveats: [] }, events: [event], budgetId: budget.id,
      runId: run.id, knowledgeCutoff: "2026-10-01T01:00:02.000Z" });
    expect(result).toEqual({ method: "keyword", context: [] });
    expect(resolution).toMatchObject({ relationship: "uncertain", targetId: null });
  });

  it("uses a long grounded search query instead of discarding its result", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: `Repair importer ${marker}`, description: "Restore the data importer",
      status: "planned" }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { text: "The importer repair has started." } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3,
      maxInputTokens: 100_000, maxOutputTokens: 3_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "long-search-e2e", promptVersion: "v1",
      policyVersion: "v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    const longQuery = `Find the accepted task to repair importer ${marker}. `
      + "The reported work restores the data importer and tests the same concrete deliverable. "
        .repeat(3);
    expect(longQuery.length).toBeGreaterThan(200);
    let searchResult: { tasks?: { id: string }[]; error?: string } | null = null;
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["slack:channel:C1"],
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: { output?: string }[] };
        if (request.input.at(-1)?.output) searchResult = JSON.parse(request.input.at(-1)!.output!);
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_tasks", call_id: "long-call",
            arguments: JSON.stringify({ query: longQuery, limit: 5, method: "keyword" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "same_outcome", targetId: task.id, alternativeTargetIds: [],
            reasons: ["The importer repair is the accepted task."],
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-long-${turn}`, model: "mock-model",
          status: "completed", output, usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const resolution = await resolver.resolve({ claim: { schemaVersion: 1,
      kind: "progress_report", statement: "The importer repair has started.",
      subjectRefs: [], speakerMemberId: null, assertedField: "status",
      assertedValue: "in_progress", assertedAt: event.occurredAt, validFrom: null,
      validTo: null, temporalBasis: "relative_to_source", spans: [],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] },
    events: [event], budgetId: budget.id, runId: run.id });
    expect((searchResult as { tasks?: { id: string }[]; error?: string } | null)?.tasks)
      .toContainEqual(expect.objectContaining({ id: task.id }));
    expect(resolution).toMatchObject({ relationship: "same_outcome", targetId: task.id });
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/long-query-e2e.json",
      JSON.stringify({ case: "long-grounded-query", queryLength: longQuery.length,
        returnedTaskId: task.id, resolution, modelCalls: turn }, null, 2) + "\n");
  });

  it("requires a decision after three searches rather than losing the fourth turn", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: `Repair importer ${marker}`, description: "Restore the data importer",
      status: "planned" }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { text: "The importer repair has started." } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 4,
      maxInputTokens: 100_000, maxOutputTokens: 4_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "search-final-e2e", promptVersion: "v1",
      policyVersion: "v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    let turn = 0;
    const choices: unknown[] = [];
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["slack:channel:C1"],
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { tool_choice: string };
        choices.push(request.tool_choice);
        const output = request.tool_choice === "none"
          ? [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "same_outcome", targetId: task.id, alternativeTargetIds: [],
            reasons: ["The returned task has the same importer repair outcome."],
          }) }] }]
          : [{ type: "function_call", name: "search_tasks", call_id: `search-${turn}`,
            arguments: JSON.stringify({ query: marker, limit: 5, method: "keyword" }) }];
        turn += 1;
        return new Response(JSON.stringify({ id: `mock-final-${turn}`, model: "mock-model",
          status: "completed", output, usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const resolution = await resolver.resolve({ claim: { schemaVersion: 1,
      kind: "progress_report", statement: "The importer repair has started.",
      subjectRefs: [], speakerMemberId: null, assertedField: "status",
      assertedValue: "in_progress", assertedAt: event.occurredAt, validFrom: null,
      validTo: null, temporalBasis: "relative_to_source", spans: [],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] },
    events: [event], budgetId: budget.id, runId: run.id });
    expect(choices).toEqual(["required", "auto", "auto", "none"]);
    expect(resolution).toMatchObject({ relationship: "same_outcome", targetId: task.id });
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/final-turn-e2e.json",
      JSON.stringify({ case: "forced-final-turn", choices, resolution,
        modelCalls: turn }, null, 2) + "\n");
  });

  it("sends the cited receipt as source context instead of unrelated episode events", async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ clientEventId: marker,
      title: `Repair importer ${marker}`, description: "Restore the data importer",
      status: "planned" }, "user:e2e");
    const unrelated = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: `${marker}-unrelated`, eventKind: "message.observed",
      occurredAt: "2026-10-02T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}-unrelated`, sourceUrl: null,
      contentHash: `${marker}-unrelated`, visibility: "slack:channel:C1",
      payloadVersion: "test-v1", payload: { text: "Unrelated billing discussion." } })).event;
    const cited = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: `${marker}-cited`, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}-cited`, sourceUrl: null,
      contentHash: `${marker}-cited`, visibility: "slack:channel:C1",
      payloadVersion: "test-v1", payload: { text: "The importer repair has started." } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3,
      maxInputTokens: 100_000, maxOutputTokens: 3_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [unrelated.id, cited.id], pipelineVersion: "cited-context-e2e",
      promptVersion: "v1", policyVersion: "v1", configHash: marker,
      replayMode: "live", evaluationClock: "2026-10-02T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    let sourceContext: { excerpt: string }[] = [];
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["slack:channel:C1"],
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          input: { content?: string }[] };
        sourceContext = (JSON.parse(request.input[0]!.content!) as {
          sourceContext: { excerpt: string }[] }).sourceContext;
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_tasks", call_id: "cited-call",
            arguments: JSON.stringify({ query: marker, limit: 5, method: "keyword" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "same_outcome", targetId: task.id, alternativeTargetIds: [],
            reasons: ["The cited report concerns the importer repair."],
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-cited-${turn}`, model: "mock-model",
          status: "completed", output, usage: { input_tokens: 200, output_tokens: 40 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const resolution = await resolver.resolve({ claim: { schemaVersion: 1,
      kind: "progress_report", statement: "The importer repair has started.",
      subjectRefs: [], speakerMemberId: null, assertedField: "status",
      assertedValue: "in_progress", assertedAt: cited.occurredAt, validFrom: null,
      validTo: null, temporalBasis: "relative_to_source",
      spans: [{ eventId: cited.id,
        originObservationKey: cited.observationIdentity!.originObservationKey,
        sourceVersionKey: cited.observationIdentity!.sourceVersionKey,
        locator: { kind: "text", jsonPointer: "/text", startUtf16: 0,
          endUtf16: "The importer repair has started.".length, spanHash: createHash("sha256")
            .update("The importer repair has started.").digest("hex") } }],
      derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] },
    events: [unrelated, cited], budgetId: budget.id, runId: run.id });
    expect(sourceContext).toHaveLength(1);
    expect(sourceContext[0]?.excerpt).toContain("The importer repair has started.");
    expect(sourceContext[0]?.excerpt).not.toContain("billing");
    expect(resolution).toMatchObject({ relationship: "same_outcome", targetId: task.id });
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/cited-context-e2e.json",
      JSON.stringify({ case: "cited-source-context", citedEventId: cited.id,
        contextCount: sourceContext.length, resolution, modelCalls: turn }, null, 2) + "\n");
  });

  it("keeps long evidence and task scope available while proposing inferred review state", async () => {
    const marker = randomUUID();
    const scopeTail = `Full Bayesian graph scope ${marker}`;
    const description = `${"Evidence ingestion and graph checks. ".repeat(300)}${scopeTail}`;
    const task = await ledger.createTask({ clientEventId: marker,
      title: `Pipe evidence into Bayesian graph ${marker}`, description,
      status: "in_progress" }, "user:e2e");
    const claimTail = `The back half of Bayesian graph work ${marker} is ready for review.`;
    const quote = `${"Source reconciliation detail. ".repeat(25)}${claimTail}`;
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1", payload: { text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 5,
      maxInputTokens: 200_000, maxOutputTokens: 5_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const documents: string[] = [];
    const queries: string[] = [];
    const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "mock-key",
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: string[]; input_type: string };
        (request.input_type === "search_document" ? documents : queries).push(...request.input);
        return new Response(JSON.stringify({ model: "voyage-4",
          data: request.input.map((text, index) => ({ index,
            embedding: request.input_type === "search_query" || text.includes(marker)
              ? [1, ...Array(1023).fill(0)] : [0, 1, ...Array(1022).fill(0)] })),
          usage: { prompt_tokens: 100, total_tokens: 100 } }), { status: 200 });
      } });
    let turn = 0;
    let returnedScope = "";
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["slack:channel:C1"], embeddings,
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { input: { output?: string }[] };
        if (request.input.at(-1)?.output) {
          const result = JSON.parse(request.input.at(-1)!.output!) as {
            tasks: { description: string }[] };
          returnedScope = result.tasks[0]?.description ?? "";
        }
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_tasks", call_id: "long-scope",
            arguments: JSON.stringify({ query: "Bayesian graph work", limit: 5,
              method: "similarity" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "same_outcome", targetId: task.id, alternativeTargetIds: [],
            reasons: ["The graph work matches this task."], suggestedStatus: "review",
            statusBasis: claimTail, requestIntent: null,
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-long-flow-${turn}`,
          model: "mock-model", status: "completed", output,
          usage: { input_tokens: 200, output_tokens: 50 } }), { status: 200 });
      } });
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `long-flow-${marker}`, identityResolver: resolver,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null,
          assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length,
              spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] }; } },
      judge: { async assess() { return { verdict: "supported" as const, reasonCodes: [],
        explanation: "The source supports a review-stage suggestion." }; } },
    });
    const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null });
    expect(result).toMatchObject({ claimCount: 1, pendingProposalCount: 1 });
    const embeddedTask = documents.find((text) => text.includes(scopeTail));
    expect(embeddedTask).toContain(scopeTail);
    expect(Buffer.byteLength(embeddedTask!, "utf8")).toBeGreaterThan(8_000);
    expect(queries[0]).toContain(claimTail);
    expect(returnedScope).toContain(scopeTail);
    expect((await store.getTask(task.id))?.status).toBe("in_progress");
    expect((await store.listTaskProposals(task.id)).find((item) => item.assessmentId))
      .toMatchObject({ state: "pending", changes: { status: "review" } });
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/long-evidence-flow-e2e.json",
      JSON.stringify({ case: "long-evidence-flow", claimLength: quote.length,
        embeddedTaskBytes: Buffer.byteLength(embeddedTask!, "utf8"), taskId: task.id,
        proposedStatus: "review", acceptedStatus: (await store.getTask(task.id))?.status }, null, 2) + "\n");
  });

  it("lets the model distinguish a question from a new durable task", async () => {
    const marker = randomUUID();
    const quote = `Which branch should we build from for ${marker}?`;
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-02T01:00:00.000Z", fetchedAt: "2026-10-02T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1", payload: { text: quote } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 100_000, maxOutputTokens: 2_000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    let turn = 0;
    const resolver = new OpenAIWorkSearchResolver({ store, apiKey: "mock-key",
      model: "mock-model", allowedVisibilities: ["slack:channel:C1"],
      priceBasis: { id: "mock", model: "mock-model", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async () => {
        const output = turn++ === 0
          ? [{ type: "function_call", name: "search_tasks", call_id: "question-search",
            arguments: JSON.stringify({ query: marker, limit: 5, method: "keyword" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            relationship: "unrelated", targetId: null, alternativeTargetIds: [],
            reasons: ["The source asks for a branch location."], suggestedStatus: null,
            statusBasis: null, requestIntent: "question_or_coordination",
          }) }] }];
        return new Response(JSON.stringify({ id: `mock-question-${turn}`,
          model: "mock-model", status: "completed", output,
          usage: { input_tokens: 200, output_tokens: 40 } }), { status: 200 });
      } });
    const pipeline = new EvidencePipeline({ store, ledger,
      pipelineVersion: `question-intent-${marker}`, identityResolver: resolver,
      extractor: { name: "fixture-extractor", async extract() { return {
        claims: [{ schemaVersion: 1 as const, kind: "request" as const,
          statement: quote, subjectRefs: [], speakerMemberId: null,
          assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: event.id,
            originObservationKey: event.observationIdentity!.originObservationKey,
            sourceVersionKey: event.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: quote.length,
              spanHash: createHash("sha256").update(quote).digest("hex") } }],
          derivedFromClaimIds: [], supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: event.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] }; } },
    });
    const result = await pipeline.run({ eventIds: [event.id], budgetId: budget.id,
      evaluationClock: "2026-10-02T01:00:02.000Z", knowledgeCutoff: null });
    expect(result).toMatchObject({ claimCount: 1, assessmentCount: 1, pendingProposalCount: 0 });
    expect((await store.listProposals()).filter((proposal) =>
      proposal.evidenceIds.includes(event.id))).toHaveLength(0);
    await mkdir("artifacts/evidence-state/work-search-20261002", { recursive: true });
    await writeFile("artifacts/evidence-state/work-search-20261002/request-intent-e2e.json",
      JSON.stringify({ case: "model-request-intent", sourceEventId: event.id,
        modelCalls: turn, taskProposals: 0 }, null, 2) + "\n");
  });
});
