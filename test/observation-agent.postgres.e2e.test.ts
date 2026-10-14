// Failure cases fixed before implementation: split model stages; pending human review;
// missing separate task result; stale-time veto; fetched-time provenance; missing update target; lost context identity;
// duplicate receipt application; a no-change observation writing accepted state.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { BudgetedVoyageEmbeddings } from "../src/intelligence/voyage-work-embeddings.js";
import { ObservationAgent } from "./observation-agent-fixture.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const organizationId = randomUUID();
let pool: pg.Pool, store: PostgresLedgerStore, ledger: TeamLedger;
beforeAll(async () => {
  if (!databaseUrl?.includes("panini_e2e")) throw new Error("Disposable panini_e2e required");
  await migrate(databaseUrl);
  pool = new pg.Pool({ connectionString: databaseUrl });
  expect((await pool.query("SELECT current_database()")).rows[0].current_database).toBe("panini_e2e");
  await pool.query("INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
    [organizationId, `observation-${organizationId}`, "Observation Agent E2E"]);
  store = new PostgresLedgerStore(databaseUrl, Buffer.alloc(32, 41).toString("base64"), organizationId);
  ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
    autoApproveContext: false, requireReviewForTaskChanges: true }));
});
afterAll(async () => { await store?.close(); await pool?.end(); });

it("uses one conversation to recover a missing target and immediately accept task and context writes at original source time", async () => {
  const marker = randomUUID();
  const task = await ledger.createTask({ title: `Importer ${marker}`, status: "planned" }, "user:e2e");
  const context = await ledger.createContextEntry({ kind: "fact", path: `/policy/${marker}`,
    title: "Importer policy", factType: "policy", value: "Newer fact", lifecycleState: "needs_review",
    links: [{ type: "task", targetId: task.id, targetRef: task.title }],
    effectiveFrom: "2026-09-27T00:00:00.000Z" }, "user:e2e");
  const originalTime = "2026-08-22T00:00:00.000Z";
  const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
    providerEventId: marker, eventKind: "message.observed", occurredAt: originalTime,
    fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `slack:T1:C1:${marker}`,
    sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test",
    payload: { text: `Importer finished. Revise policy and create follow-up. ${marker}` } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 20,
    maxInputTokens: 1_000_000, maxOutputTokens: 50_000, maxUsd: null,
    deadline: new Date(Date.now() + 300_000).toISOString(), priceBasis: null });
  const steps = [
    ["search_tasks", { query: marker, limit: 10 }],
    ["read_task", { id: task.id }],
    ["update_task", { id: randomUUID(), changes: { status: "done" }, rationale: "Missing target" }],
    ["update_task", { id: task.id, changes: { status: "done", result: "failed" }, rationale: "Retest completed but reported failure" }],
    ["search_context", { query: marker, limit: 10 }],
    ["read_context", { id: context.id }],
    ["update_context", { id: context.id, changes: { value: "Older source accepted by agent" }, rationale: "Agent decides chronology" }],
    ["create_task", { title: `Follow-up ${marker}`, status: "planned", result: "unknown", rationale: "New work" }],
    ["create_context", { path: `/follow-up/${marker}`, title: "Follow-up policy", factType: "policy", value: "Ready", rationale: "New fact" }],
  ] as const;
  const requests: unknown[] = [];
  const toolResults: unknown[] = [];
  let turn = 0;
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: "observation-agent-e2e-v1", allowedVisibilities: ["company"],
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2, embed: async (input: { texts: string[] }) => input.texts.map(() => [1,0]) },
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const prior = request.input.at(-1);
      if (prior.type === "function_call_output") toolResults.push(JSON.parse(prior.output));
      if (turn === 4) expect((await store.getTask(task.id))?.status).toBe("done");
      const step = steps[turn++];
      return new Response(JSON.stringify({ id: `fixture-${turn}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: step[0], call_id: `call-${turn}`,
          arguments: JSON.stringify(step[1]) }] : [{ type: "message",
          content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 100, output_tokens: 40 } }));
    } });
  const result = await agent.run({ eventId: event.id, budgetId: budget.id });
  expect(result.state).toBe("completed");
  expect(toolResults[2]).toMatchObject({ error: expect.any(String) });
  expect((await store.getTask(task.id))?.status).toBe("done");
  expect((await store.getTask(task.id))?.result).toBe("failed");
  expect((await store.listTasks()).find(item => item.title === `Follow-up ${marker}`)?.result).toBe("unknown");
  const revisedContext = await store.getContextEntry(context.id);
  expect(revisedContext?.kind === "fact" ? revisedContext.value : null).toBe("Older source accepted by agent");
  expect(revisedContext?.lifecycleState).toBe("accepted");
  expect(revisedContext?.links).toEqual(context.links);
  expect((await ledger.getContextEntryForAccess(context.id, { kind: "admin" }))?.id).toBe(context.id);
  expect((await store.getContextEntry(context.id))?.effectiveFrom).toBe(originalTime);
  expect((await store.listContextRevisions(context.id)).find(r => r.appliedBy === "observation-agent")?.appliedAt).toBe(originalTime);
  const proposals = await store.listProposals();
  const agentProposals = proposals.filter(p => p.requestedBy === "observation-agent");
  expect(agentProposals).toHaveLength(4);
  expect(agentProposals.every(p => p.state === "auto_applied")).toBe(true);
  const revisions = (await store.listTaskRevisions()).filter(r => agentProposals.some(p => p.id === r.proposalId));
  expect(revisions).toHaveLength(2);
  for (const revision of revisions) {
    expect(revision.appliedAt).toBe(originalTime);
    expect(revision.current.updatedAt).toBe(originalTime);
    expect(Object.values(revision.decisionMetadata!.effectiveAtByField).every(t => t === originalTime)).toBe(true);
    expect(revision.decisionMetadata!.basis).toBe("model_inferred");
  }
  expect(requests).toHaveLength(10);
  expect(JSON.stringify(requests[0])).toContain(originalTime);
  expect(JSON.stringify(requests[0])).not.toContain(event.fetchedAt);
  const duplicate = await agent.run({ eventId: event.id, budgetId: budget.id });
  expect(duplicate.state).toBe("duplicate");
  expect(requests).toHaveLength(10);
  const noopEvent = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
    providerEventId: `${marker}-noop`, eventKind: "message.observed", occurredAt: originalTime, fetchedAt: "2026-10-02T00:00:00.000Z",
    sourceRef: `slack:T1:C1:${marker}-noop`, sourceUrl: null, contentHash: `${marker}-noop`,
    visibility: "company", payloadVersion: "test", payload: { text: "Thanks" } })).event;
  expect((await agent.run({ eventId: noopEvent.id, budgetId: budget.id })).state).toBe("completed");
  expect((await store.listProposals()).filter(p => p.requestedBy === "observation-agent")).toHaveLength(4);
  await mkdir("artifacts/observation-agent", { recursive: true });
  await writeFile("artifacts/observation-agent/e2e.json", JSON.stringify({ organizationId,
    eventId: event.id, result, taskId: task.id, contextId: context.id, originalTime,
    agentProposals, revisions, requests, toolResults, outboundProviderCalls: 0 }, null, 2));
}, 60_000);

// Restart failures: creating a second run, repeating a committed tool write,
// forgetting tool outputs, or storing private conversation text in plaintext.
it("resumes the same persisted conversation after an interrupted turn without repeating a task creation", async () => {
  const marker = randomUUID();
  const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
    providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z",
    fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `slack:T1:C1:${marker}`,
    sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test",
    payload: { text: `Private restart marker ${marker}` } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 10,
    maxInputTokens: 500_000, maxOutputTokens: 20_000, maxUsd: null,
    deadline: new Date(Date.now() + 300_000).toISOString(), priceBasis: null });
  const requests: unknown[] = [];
  const options = { store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: "observation-agent-e2e-v1", allowedVisibilities: ["company"],
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2, embed: async (input: { texts: string[] }) => input.texts.map(() => [1,0]) },
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
    fetcher: async (_url: string | URL | Request, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body));
      requests.push(request);
      const output = requests.length === 1 ? [{ type: "function_call", name: "create_task",
        call_id: "durable-create", arguments: JSON.stringify({ title: `Restart ${marker}`,
          rationale: "Create requested task" }) }]
        : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }];
      if (requests.length === 2) expect(request.input.at(-1).type).toBe("function_call_output");
      return new Response(JSON.stringify({ id: `restart-${requests.length}`, model: "fixture",
        status: "completed", output, usage: { input_tokens: 100, output_tokens: 30 } }));
    } };
  await expect(new ObservationAgent({ ...options, maxTurns: 1 }).run({ eventId: event.id,
    budgetId: budget.id })).rejects.toThrow("turn limit");
  const interrupted = await store.getLatestObservationDisposition(event.id, options.pipelineVersion);
  expect(interrupted?.state).toBe("failed");
  const resumed = await new ObservationAgent(options).run({ eventId: event.id, budgetId: budget.id });
  expect(resumed.state).toBe("completed");
  expect(resumed.runId).toBe(interrupted?.runId);
  expect(requests).toHaveLength(2);
  expect((await store.listTasks()).filter(task => task.title === `Restart ${marker}`)).toHaveLength(1);
  const persisted = (await pool.query("SELECT output::text,manifest_envelope::text FROM interpretation_runs WHERE id=$1",
    [resumed.runId])).rows[0];
  expect(JSON.stringify(persisted)).not.toContain(`Private restart marker ${marker}`);
  const calls = await store.listModelCalls(resumed.runId!);
  expect(calls.map(call => call.purpose)).toEqual(["observe", "observe", "observe"]);
  await writeFile("artifacts/observation-agent/restart-e2e.json", JSON.stringify({ eventId: event.id,
    interrupted, resumed, calls, requests, outboundProviderCalls: 0 }, null, 2));
}, 60_000);

// Failure case: an existing historical source version is blocked by a coded freshness rule.
it("lets the agent decide whether an older existing observation should update a record", async () => {
  const marker = randomUUID();
  const task = await ledger.createTask({ title: marker, status: "planned" }, "user:e2e");
  const append = (suffix: string, occurredAt: string, text: string) => store.appendSourceEvent({
    provider: "slack", installationKey: "T1", providerEventId: `${marker}-${suffix}`,
    eventKind: "message.observed", occurredAt, fetchedAt: "2026-10-02T00:00:00.000Z",
    sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: `${marker}-${suffix}`,
    visibility: "company", payloadVersion: "test", payload: { text } });
  const old = (await append("old", "2026-08-22T00:00:00.000Z", "Finished older task")).event;
  await append("new", "2026-09-27T00:00:00.000Z", "Different newer source state");
  expect(await store.currentSourceEventIds([old.id])).toEqual([]);
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 4,
    maxInputTokens: 200_000, maxOutputTokens: 10_000, maxUsd: null,
    deadline: new Date(Date.now() + 300_000).toISOString(), priceBasis: null });
  let count = 0;
  const result = await new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: "observation-agent-e2e-v1", allowedVisibilities: ["company"],
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2, embed: async (input: { texts: string[] }) => input.texts.map(() => [1,0]) },
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
    fetcher: async () => new Response(JSON.stringify({ id: `old-${++count}`, model: "fixture",
      status: "completed", output: count === 1 ? [{ type: "function_call", name: "update_task",
        call_id: "old-update", arguments: JSON.stringify({ id: task.id, changes: { status: "done" },
          rationale: "The agent decides this historical source applies" }) }]
        : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
      usage: { input_tokens: 100, output_tokens: 40 } }))
  }).run({ eventId: old.id, budgetId: budget.id });
  expect(result.state).toBe("completed");
  expect((await store.getTask(task.id))?.status).toBe("done");
  const revision = (await store.listTaskRevisions(task.id)).find(r => r.decisionMetadata?.basis === "model_inferred");
  expect(revision?.decisionMetadata?.effectiveAtByField.status).toBe(old.occurredAt);
  expect((await ledger.getTaskForAccess(task.id, { kind: "admin" }))?.status).toBe("done");
  expect((await ledger.board()).tasks.some(item => item.id === task.id)).toBe(true);
  await store.revokeSourceEvent(old.id);
  expect((await ledger.board()).tasks.some(item => item.id === task.id)).toBe(false);
  await writeFile("artifacts/observation-agent/historical-source-e2e.json", JSON.stringify({ old, taskId: task.id,
    result, revision, providerCalls: count, outboundProviderCalls: 0 }, null, 2));
}, 60_000);

// Crash boundaries: after a settled response, after an accepted write, and before atomic completion.
for (const boundary of ["response", "write", "completion"] as const) {
  it(`recovers a ${boundary} boundary interruption without another decision flow`, async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z",
      fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `slack:T1:C1:${marker}`,
      sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test",
      payload: { text: `Create crash task ${marker}` } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 10,
      maxInputTokens: 500_000, maxOutputTokens: 20_000, maxUsd: null,
      deadline: new Date(Date.now() + 300_000).toISOString(), priceBasis: null });
    let calls = 0, injected = false;
    const save = store.saveObservationAgentCheckpoint.bind(store);
    const complete = store.completeObservationAgent.bind(store);
    store.saveObservationAgentCheckpoint = async input => {
      if (!injected && (boundary === "response" && input.checkpoint.nextTurn === 1
        && input.checkpoint.writes === 0 || boundary === "write" && input.checkpoint.writes === 1)) {
        injected = true; throw new Error("Injected crash boundary");
      }
      return save(input);
    };
    store.completeObservationAgent = async input => {
      if (!injected && boundary === "completion") { injected = true; throw new Error("Injected crash boundary"); }
      return complete(input);
    };
    const options = { store, ledger, apiKey: "fixture", model: "fixture",
      pipelineVersion: "observation-agent-e2e-v1", allowedVisibilities: ["company"],
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2, embed: async (input: { texts: string[] }) => input.texts.map(() => [1,0]) },
      priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
        cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
      fetcher: async () => new Response(JSON.stringify({ id: `crash-${++calls}`, model: "fixture", status: "completed",
        output: calls === 1 ? [{ type: "function_call", name: "create_task", call_id: "crash-create",
          arguments: JSON.stringify({ title: marker, rationale: "Create work" }) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 100, output_tokens: 40 } })) };
    try {
      await expect(new ObservationAgent(options).run({ eventId: event.id, budgetId: budget.id })).rejects.toThrow("Injected crash boundary");
      const interrupted = await store.getLatestObservationDisposition(event.id, options.pipelineVersion);
      const result = await new ObservationAgent(options).run({ eventId: event.id, budgetId: budget.id });
      expect(result.state).toBe("completed");
      expect(result.runId).toBe(interrupted?.runId);
      expect(calls).toBe(2);
      expect((await store.listTasks()).filter(task => task.title === marker)).toHaveLength(1);
      await writeFile(`artifacts/observation-agent/crash-${boundary}-e2e.json`, JSON.stringify({ eventId: event.id,
        result, modelFixtureCalls: calls, outboundProviderCalls: 0 }, null, 2));
    } finally {
      store.saveObservationAgentCheckpoint = save;
      store.completeObservationAgent = complete;
    }
  }, 60_000);
}

// Failure case: a structurally invalid write leaves a pending human-review proposal.
it("returns invalid-record errors to the same agent without leaving a human approval task", async () => {
  const marker = randomUUID();
  const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
    providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z",
    fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `slack:T1:C1:${marker}`,
    sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: marker } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 5,
    maxInputTokens: 500_000, maxOutputTokens: 20_000, maxUsd: null,
    deadline: new Date(Date.now() + 300_000).toISOString(), priceBasis: null });
  let count = 0;
  const result = await new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: "observation-agent-e2e-v1", allowedVisibilities: ["company"],
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2, embed: async (input: { texts: string[] }) => input.texts.map(() => [1,0]) },
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
    fetcher: async (_url, init) => {
      count++;
      if (count === 2) expect(JSON.parse(JSON.parse(String(init?.body)).input.at(-1).output)).toMatchObject({ error: expect.any(String) });
      const args = count === 1 ? { title: marker, projectId: randomUUID(), rationale: "Missing project" }
        : { title: marker, rationale: "Use a valid record" };
      return new Response(JSON.stringify({ id: `invalid-${count}`, model: "fixture", status: "completed",
        output: count < 3 ? [{ type: "function_call", name: "create_task", call_id: `invalid-${count}`,
          arguments: JSON.stringify(args) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 100, output_tokens: 40 } }));
    } }).run({ eventId: event.id, budgetId: budget.id });
  expect(result.state).toBe("completed");
  expect((await store.listProposals()).filter(proposal => proposal.evidenceIds.includes(event.id)
    && ["pending", "escalated"].includes(proposal.state))).toHaveLength(0);
  expect((await store.listTasks()).filter(task => task.title === marker)).toHaveLength(1);
  await writeFile("artifacts/observation-agent/invalid-record-e2e.json", JSON.stringify({ eventId: event.id,
    result, modelFixtureCalls: count, outboundProviderCalls: 0 }, null, 2));
}, 60_000);

// Failure case: accepted state outlives a revoked context receipt that the agent used.
it("keeps read context receipts in accepted provenance and enforces their revocation", async () => {
  const marker = randomUUID();
  const context = await ledger.createContextEntry({ kind: "fact", path: `/context-dependency/${marker}`,
    title: marker, factType: "policy", value: "Context-derived task" }, "user:e2e");
  const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
    providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z",
    fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `slack:T1:C1:${marker}`,
    sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: marker } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 5,
    maxInputTokens: 500_000, maxOutputTokens: 20_000, maxUsd: null,
    deadline: new Date(Date.now() + 300_000).toISOString(), priceBasis: null });
  let count = 0;
  const steps = [["read_context", { id: context.id }],
    ["create_task", { title: marker, rationale: "Use accepted context" }]] as const;
  const result = await new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: "observation-agent-e2e-v1", allowedVisibilities: ["company"],
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2, embed: async (input: { texts: string[] }) => input.texts.map(() => [1,0]) },
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
      cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
    fetcher: async () => {
      const step = steps[count++];
      return new Response(JSON.stringify({ id: `context-${count}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: step[0], call_id: `context-${count}`, arguments: JSON.stringify(step[1]) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 100, output_tokens: 40 } }));
    } }).run({ eventId: event.id, budgetId: budget.id });
  const task = (await store.listTasks()).find(task => task.title === marker)!;
  const revision = (await store.listTaskRevisions(task.id))[0]!;
  expect(revision.decisionMetadata?.sourceEventIdsByField.creation).toEqual(expect.arrayContaining([event.id, ...context.evidenceIds]));
  expect((await ledger.getTaskForAccess(task.id, { kind: "admin" }))?.id).toBe(task.id);
  await store.revokeSourceEvent(context.evidenceIds[0]!);
  expect((await ledger.board()).tasks.some(item => item.id === task.id)).toBe(false);
  await writeFile("artifacts/observation-agent/context-provenance-e2e.json", JSON.stringify({ result,
    taskId: task.id, revision, revokedSourceId: context.evidenceIds[0], outboundProviderCalls: 0 }, null, 2));
}, 60_000);

// Embedding search failures written first: synonym-only matches lost to lexical filtering;
// wrong model/input type; context facts or files omitted; stale vectors after edits;
// inaccessible/revoked records embedded; failure silently falling back to keywords.
it("searches task and context meanings with Voyage 4, caches vectors, and refreshes changed content", async () => {
  const marker = randomUUID();
  const target = await ledger.createTask({ title: `Restore peripheral ${marker}`, description: "Reconnect a pointing device" }, "user:e2e");
  await ledger.createTask({ title: `Pointer repair brochure ${marker}`, description: "Unrelated print material" }, "user:e2e");
  const fact = await ledger.createContextEntry({ kind: "fact", path: `/semantic/${marker}`, title: "Peripheral recovery policy", factType: "policy", value: "Reconnect input hardware" }, "user:e2e");
  const file = await ledger.createContextEntry({ kind: "file", path: `/semantic-doc/${marker}`, title: "Peripheral recovery manual", body: "Reconnect input hardware", lifecycleState: "accepted" }, "user:e2e");
  const privateEvent = (await store.appendSourceEvent({ provider: "manual", installationKey: "private", providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `private:${marker}`, sourceUrl: null, contentHash: marker, visibility: "private", payloadVersion: "test", payload: { text: "Invisible semantic secret" } })).event;
  const hidden = await ledger.proposeContextFact({ sourceRef: `private-context:${marker}`, path: `/hidden/${marker}`, title: "Invisible semantic secret", factType: "policy", value: "Secret", rationale: "Fixture", requestedBy: "user:e2e", evidenceIds: [privateEvent.id] });
  await store.approveAndApplyContextProposal({ proposalId: hidden.id, state: "approved", decidedBy: "user:e2e", decisionNote: "Fixture", auditAction: "fixture" });
  const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1", providerEventId: `${marker}-semantic`, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `semantic:${marker}`, sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: "Find the repair work and related instructions" } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 30, maxInputTokens: 1_000_000, maxOutputTokens: 50_000, maxUsd: null, deadline: new Date(Date.now()+300_000).toISOString(), priceBasis: null });
  const embeddingRequests: {model: string; input: string[]; input_type: string}[] = [];
  const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "fixture", fetcher: async (_url, init) => {
    const body = JSON.parse(String(init?.body)); embeddingRequests.push(body);
    expect(body.model).toBe("voyageai/voyage-4");
    if (body.input_type === "search_query" && body.input[0] === "provider outage") return new Response("Fixture outage", { status: 503 });
    const data = body.input.map((text: string, index: number) => ({ index, embedding: Array.from({ length: 1024 }, (_, i) => i === (body.input_type === "search_query" || /Restore peripheral|Peripheral recovery/.test(text) ? 0 : 1) ? 1 : 0) }));
    return new Response(JSON.stringify({ model: "voyage-4", data, usage: { prompt_tokens: 100 } }));
  } });
  const steps = [["search_tasks", { query: "pointer repair", limit: 1 }], ["search_tasks", { query: "pointer repair", limit: 1 }], ["update_task", { id: target.id, changes: { description: "Revised recovery procedure" }, rationale: "Clarify instructions" }], ["search_tasks", { query: "pointer repair", limit: 1 }], ["search_context", { query: "pointer repair", limit: 50 }], ["search_context", { query: "pointer repair", limit: 50 }]] as const;
  let turn = 0, outage = false; const outputs: any[] = [];
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture", embeddings,
    pipelineVersion: "semantic-observation-v1", allowedVisibilities: ["company"], priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); const prior = request.input.at(-1);
      if (prior.type === "function_call_output") outputs.push(JSON.parse(prior.output));
      const step = outage ? (turn++ === 6 ? ["search_tasks", { query: "provider outage", limit: 1 }] : undefined) : steps[turn++]; return new Response(JSON.stringify({ id: `semantic-${turn}`, model: "fixture", status: "completed", output: step ? [{ type: "function_call", name: step[0], call_id: `semantic-${turn}`, arguments: JSON.stringify(step[1]) }] : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }], usage: { input_tokens: 100, output_tokens: 40 } }));
    } });
  expect((await agent.run({ eventId: event.id, budgetId: budget.id })).state).toBe("completed");
  for (const index of [0,1,3]) expect(outputs[index].tasks[0].id).toBe(target.id);
  const contexts = outputs[4].context; expect(contexts.slice(0,2).map((entry: any) => entry.id)).toEqual(expect.arrayContaining([fact.id,file.id]));
  expect(JSON.stringify(embeddingRequests)).not.toContain("Invisible semantic secret");
  expect(outputs[5].context.some((entry: any) => entry.id === fact.id)).toBe(true);
  expect(embeddingRequests.filter(r => r.input_type === "search_query")).toHaveLength(1);
  expect(embeddingRequests.filter(r => r.input_type === "search_document" && r.input.some(text => text.includes("Restore peripheral")))).toHaveLength(2);
  // Revocation must also remove the new encrypted context/query vector cache types.
  await store.revokeSourceEvent(fact.evidenceIds[0]!);
  expect(Number((await pool.query("SELECT count(*)::text AS count FROM work_entity_embeddings WHERE organization_id=$1 AND entity_type IN ('context','query')", [organizationId])).rows[0].count)).toBe(0);
  const fresh = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1", providerEventId: `${marker}-after-revocation`, eventKind: "message.observed", occurredAt: "2026-08-23T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `semantic-fresh:${marker}`, sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: "Read remaining policy" } })).event;
  turn = 4; const oldCount = outputs.length;
  expect((await agent.run({ eventId: fresh.id, budgetId: budget.id })).state).toBe("completed");
  expect(outputs[oldCount].context.some((entry: any) => entry.id === fact.id)).toBe(false);
  expect(outputs[oldCount].context.some((entry: any) => entry.id === file.id)).toBe(true);
  const failedEvent = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1", providerEventId: `${marker}-outage`, eventKind: "message.observed", occurredAt: "2026-08-24T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `semantic-outage:${marker}`, sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: "Search outage fixture" } })).event;
  turn = 6; outage = true;
  await expect(agent.run({ eventId: failedEvent.id, budgetId: budget.id })).rejects.toThrow("HTTP 503");
  const failedRun = await store.getLatestObservationDisposition(failedEvent.id, "semantic-observation-v1");
  const checkpoint = await store.getObservationAgentCheckpoint(failedRun!.runId!);
  const failedCalls = await store.listModelCalls(failedRun!.runId!);
  expect(failedCalls.find(call => call.purpose === "embed" && call.state === "unknown")?.errorCode).toBe("provider_http_503");
  expect(checkpoint!.transcript.at(-1)).toMatchObject({ type: "function_call", name: "search_tasks" });
  const calls = (await pool.query("SELECT purpose,model,state FROM model_calls WHERE run_id=$1", [(await store.getLatestObservationDisposition(event.id, "semantic-observation-v1"))!.runId])).rows;
  expect(calls.some(row => row.purpose === "embed" && row.model === "voyageai/voyage-4" && row.state === "succeeded")).toBe(true);
  await writeFile("artifacts/observation-agent/semantic-search-e2e.json", JSON.stringify({ eventId: event.id, targetId: target.id, factId: fact.id, fileId: file.id, outputs, embeddingRequests, calls, externalProviderCalls: 0 },null,2));
}, 60_000);

// Failure boundaries written first: provider result settled but document/query cache save fails.
// Retrying the same tool must recover vectors without paying for the request again.
for (const boundary of ["task", "query", "task_partial"] as const) {
  it(`recovers a settled Voyage response after ${boundary} cache persistence fails`, async () => {
    const marker = randomUUID();
    const task = await ledger.createTask({ title: `Embedding boundary ${marker}` }, "user:e2e");
    if (boundary === "task_partial") await ledger.createTask({ title: `Second cache boundary ${marker}` }, "user:e2e");
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1", providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `cache-boundary:${marker}`, sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: "Find the existing work" } })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 15, maxInputTokens: 1_000_000, maxOutputTokens: 50_000, maxUsd: null, deadline: new Date(Date.now()+300_000).toISOString(), priceBasis: null });
    let embeddingCalls = 0, turns = 0, cacheWrites = 0, injected = false;
    const embeddingRequests: unknown[] = [];
    const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "fixture", fetcher: async (_url, init) => {
      embeddingCalls++; const request = JSON.parse(String(init?.body)); embeddingRequests.push(request);
      return new Response(JSON.stringify({ model: "voyage-4", data: request.input.map((_: string,index: number) => ({ index, embedding: Array.from({ length: 1024 }, (_,i) => i===0 ? 1 : 0) })), usage: { prompt_tokens: 100 } }));
    } });
    const put = store.putWorkEntityEmbedding.bind(store);
    store.putWorkEntityEmbedding = async input => {
      if (!injected && input.entityType === (boundary === "query" ? "query" : "task")
        && ++cacheWrites === (boundary === "task_partial" ? 2 : 1)) { injected = true; throw new Error("Injected cache persistence failure"); }
      return put(input);
    };
    const outputs: { tasks?: {id: string}[]; error?: string }[] = [];
    try {
      const result = await new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture", embeddings,
        pipelineVersion: `embedding-boundary-${boundary}`, allowedVisibilities: ["company"], priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" },
        fetcher: async (_url, init) => {
          const request = JSON.parse(String(init?.body)); const last = request.input.at(-1);
          if (last.type === "function_call_output") outputs.push(JSON.parse(last.output));
          const turn = ++turns; return new Response(JSON.stringify({ id: `boundary-${turn}`, model: "fixture", status: "completed", output: turn<=2 ? [{ type: "function_call", name: "search_tasks", call_id: `boundary-${turn}`, arguments: JSON.stringify({ query: marker, limit: 50 }) }] : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }], usage: { input_tokens: 100, output_tokens: 40 } }));
        } }).run({ eventId: event.id, budgetId: budget.id });
      expect(result.state).toBe("completed"); expect(injected).toBe(true);
      expect(outputs[0]?.error).toContain("Injected cache persistence failure");
      expect(outputs[1]?.tasks?.some(item => item.id === task.id)).toBe(true);
      expect(embeddingCalls).toBe(2);
      await writeFile(`artifacts/observation-agent/embedding-cache-${boundary}-e2e.json`, JSON.stringify({ eventId: event.id, result, embeddingCalls, embeddingRequests, outputs, externalProviderCalls: 0 },null,2));
    } finally { store.putWorkEntityEmbedding = put; }
  },60_000);
}

// Failure case written first: a long context file is sent as one provider input,
// so its tail is rejected or truncated and cannot be found by semantic search.
it("embeds long context files in bounded chunks and retrieves a match at the end", async () => {
  await pool.query("DELETE FROM work_entity_embeddings WHERE organization_id=$1", [organizationId]);
  const marker = randomUUID();
  const file = await ledger.createContextEntry({ kind: "file", path: `/long/${marker}`, title: "Long recovery manual", body: "Ordinary paragraph. ".repeat(12000) + "Tail discovery proof", lifecycleState: "accepted" }, "user:e2e");
  const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1", providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z", fetchedAt: "2026-10-02T00:00:00.000Z", sourceRef: `long:${marker}`, sourceUrl: null, contentHash: marker, visibility: "company", payloadVersion: "test", payload: { text: "Find the tail proof" } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 20, maxInputTokens: 2_000_000, maxOutputTokens: 50_000, maxUsd: null, deadline: new Date(Date.now()+300_000).toISOString(), priceBasis: null });
  const requests: { input: string[]; input_type: string }[] = [];
  const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "fixture", fetcher: async (_url,init) => {
    const body = JSON.parse(String(init?.body)); requests.push(body);
    if (body.input.some((text: string) => text.length>3000) || body.input.length>16) return new Response("Unbounded document", {status:400});
    return new Response(JSON.stringify({ model: "voyage-4", data: body.input.map((text: string,index: number) => ({ index, embedding: Array.from({length:1024},(_,i) => i===(body.input_type==="search_query" || text.includes("Tail discovery proof") ? 0 : 1) ? 1 : 0) })), usage: {prompt_tokens:100} }));
  } });
  let turns=0; let found: any;
  const result = await new ObservationAgent({ store,ledger,apiKey:"fixture",model:"fixture",embeddings,pipelineVersion:"long-document-e2e",allowedVisibilities:["company"],priceBasis:{id:"fixture",model:"fixture",inputUsdPerMillion:0,cachedInputUsdPerMillion:0,outputUsdPerMillion:0,sourceUrl:"local"},fetcher:async(_url,init)=> {
    const body=JSON.parse(String(init?.body)); if (++turns===2) found=JSON.parse(body.input.at(-1).output);
    return new Response(JSON.stringify({id:`long-${turns}`,model:"fixture",status:"completed",output:turns===1?[{type:"function_call",name:"search_context",call_id:"long-search",arguments:JSON.stringify({query:"tail discovery",limit:1})}]:[{type:"message",content:[{type:"output_text",text:"Finished"}]}],usage:{input_tokens:100,output_tokens:40}}));
  } }).run({eventId:event.id,budgetId:budget.id});
  expect(result.state).toBe("completed");expect(found.context[0].id).toBe(file.id);
  expect(requests.every(request=>request.input.length<=16&&request.input.every(text=>text.length<=3000))).toBe(true);
  expect(requests.some(request=>request.input.some(text=>text.includes("Tail discovery proof")))).toBe(true);
  await writeFile("artifacts/observation-agent/long-document-e2e.json",JSON.stringify({eventId:event.id,fileId:file.id,result,embeddingBatches:requests.length,maxInputChars:Math.max(...requests.flatMap(request=>request.input.map(text=>text.length))),tailRetrieved:true,externalProviderCalls:0},null,2));
},60_000);

// Failure-first: an embedding HTTP 402 loses its status and is then masked by
// local budget exhaustion. Stop after the failed provider call; hold its unknown cost.
it("reports an embedding credit error without a further model dispatch", async () => {
  const marker = randomUUID();
  const event = (await store.appendSourceEvent({ provider: "manual", installationKey: "credit-e2e",
    providerEventId: marker, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z",
    fetchedAt: "2026-10-04T00:00:00.000Z", sourceRef: marker, sourceUrl: null, contentHash: marker,
    visibility: "company", payloadVersion: "fixture", payload: { text: "Find the task" } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 10, maxInputTokens: 1000000,
    maxOutputTokens: 50000, maxUsd: null, deadline: new Date(Date.now()+180000).toISOString(), priceBasis: null });
  let turns = 0, embeddingCalls = 0;
  const embeddings = new BudgetedVoyageEmbeddings({ store, apiKey: "fixture", fetcher: async () => {
    embeddingCalls++;
    return Response.json({ error: { code: 402, message: "Insufficient credits" } }, { status: 402 });
  }});
  const agent = new ObservationAgent({ store, ledger, embeddings, apiKey: "fixture", model: "fixture",
    pipelineVersion: `credit-${marker}`, allowedVisibilities: ["company"],
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0,
      outputUsdPerMillion: 0, sourceUrl: "local" }, fetcher: async () => {
      turns++;
      return Response.json({ id: marker, model: "fixture", status: "completed",
        output: [{ type: "function_call", name: "search_tasks", call_id: marker,
          arguments: JSON.stringify({ query: "Find the task", limit: 1 }) }], usage: { input_tokens: 1, output_tokens: 1 } });
    }});
  await expect(agent.run({ eventId: event.id, budgetId: budget.id })).rejects.toThrow("HTTP 402");
  expect(turns).toBe(1); expect(embeddingCalls).toBe(1);
  const calls = (await pool.query("SELECT purpose,state,error_code FROM model_calls WHERE budget_id=$1", [budget.id])).rows;
  expect(calls.find(c => c.purpose === "embed")).toMatchObject({ state: "unknown", error_code: "provider_http_402" });
  const finalBudget = await store.getInferenceBudget(budget.id);
  expect(finalBudget?.state).toBe("suspended"); expect(finalBudget?.reservedCalls).toBe(1);
  await mkdir("artifacts/observation-agent", { recursive: true });
  await writeFile("artifacts/observation-agent/provider-credit-error-e2e.json", JSON.stringify({ ok: true,
    externalProviderCalls: 0, turns, embeddingCalls, calls, budget: finalBudget }, null, 2));
});

// Failure-first: a captured branch snapshot must not claim a branch creation date.
it("labels branch capture time as observation time with unknown creation time", async () => {
  const marker = randomUUID();
  const event = (await store.appendSourceEvent({ provider: "github", installationKey: "branch-e2e",
    providerEventId: marker, eventKind: "branch.snapshot", occurredAt: "2026-08-22T00:00:00.000Z",
    fetchedAt: "2026-08-22T00:00:00.000Z", sourceRef: marker, sourceUrl: null, contentHash: marker,
    visibility: "company", payloadVersion: "fixture", payload: { branch: "pilot", sha: "fixture", text: "pilot" } })).event;
  const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3, maxInputTokens: 100000,
    maxOutputTokens: 50000, maxUsd: null, deadline: new Date(Date.now()+180000).toISOString(), priceBasis: null });
  let observation: any;
  const result = await new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: marker, allowedVisibilities: ["company"],
    priceBasis: { id: "fixture", model: "fixture", inputUsdPerMillion: 0, cachedInputUsdPerMillion: 0,
      outputUsdPerMillion: 0, sourceUrl: "local" }, fetcher: async (_url, init) => {
      observation = JSON.parse(JSON.parse(String(init?.body)).input[0].content).observation;
      return Response.json({ id: marker, model: "fixture", status: "completed", output: [{ type: "message",
        content: [{ type: "output_text", text: "No change" }] }], usage: { input_tokens: 1, output_tokens: 1 } });
    }}).run({ eventId: event.id, budgetId: budget.id });
  expect(observation.timeBasis).toBe("capture_only_creation_unknown");
  expect(result.writes).toBe(0);
  await writeFile("artifacts/observation-agent/branch-time-basis-e2e.json", JSON.stringify({ ok: true,
    externalProviderCalls: 0, observation, result }, null, 2));
});
