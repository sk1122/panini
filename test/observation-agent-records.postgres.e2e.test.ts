// Failures written before the fix: reads resend obsolete snapshots/provenance; a task
// with >500 obsolete receipts stops dispatch; current context exposes audit envelopes;
// tool schemas allow format/sourceUrl/rationale mistakes and both context content kinds;
// strict optional nulls clear existing owners; accepted writes return large audit objects;
// legitimate current context provenance exceeds the arbitrary 500-source metadata ceiling.
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { beforeAll, afterAll, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { ObservationAgent as ProductionObservationAgent } from "../src/intelligence/observation-agent.js";
import { ObservationAgent } from "./observation-agent-fixture.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const organizationId = randomUUID();
let pool: pg.Pool, store: PostgresLedgerStore, ledger: TeamLedger;
beforeAll(async () => {
  if (!databaseUrl?.includes("panini_e2e")) throw Error("Disposable panini_e2e required");
  await migrate(databaseUrl);
  pool = new pg.Pool({ connectionString: databaseUrl });
  await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
    [organizationId, `records-${organizationId}`, "Latest records E2E"]);
  store = new PostgresLedgerStore(databaseUrl, Buffer.alloc(32, 41).toString("base64"), organizationId);
  ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
    autoApproveContext: false, requireReviewForTaskChanges: true }));
});
afterAll(async () => { await store?.close(); await pool?.end(); });
const priceBasis = { id: "fixture", model: "fixture", inputUsdPerMillion: 0,
  cachedInputUsdPerMillion: 0, outputUsdPerMillion: 0, sourceUrl: "local" };
async function source(text: string) {
  const id = randomUUID();
  return (await store.appendSourceEvent({ provider: "manual", installationKey: "records-e2e",
    providerEventId: id, eventKind: "message.observed", occurredAt: "2026-08-22T00:00:00.000Z",
    fetchedAt: "2026-10-04T00:00:00.000Z", sourceRef: `records:${id}`, sourceUrl: null,
    contentHash: id, visibility: "company", payloadVersion: "fixture", payload: { text } })).event;
}
async function budget() {
  return store.createInferenceBudget({ label: randomUUID(), maxCalls: 30,
    maxInputTokens: 3_000_000, maxOutputTokens: 50_000, maxUsd: null,
    deadline: new Date(Date.now() + 180_000).toISOString(), priceBasis: null });
}
async function artifact(name: string, data: unknown) {
  await mkdir("artifacts/observation-agent", { recursive: true });
  await writeFile(`artifacts/observation-agent/${name}.json`, JSON.stringify(data, null, 2));
}

// Failure-first: nearby references and a shared tool name must not be presented as one discussion.
it("labels source discussion boundaries in initial context and explicit source reads", async () => {
  const channel = `C${randomUUID()}`, teamId = "TTHREAD";
  const firstThread = "1787356800.000001", otherThread = "1787356801.000001";
  const chat = async (messageTs: string, threadTs: string, text: string) => {
    const id = randomUUID();
    return (await store.appendSourceEvent({ provider: "slack", installationKey: "thread-e2e",
      providerEventId: id, eventKind: "message.observed", occurredAt: new Date(Number(messageTs) * 1000).toISOString(),
      fetchedAt: new Date().toISOString(), sourceRef: `slack:${teamId}:${channel}:${messageTs}`,
      sourceUrl: null, contentHash: id, visibility: "company", payloadVersion: "fixture",
      payload: { teamId, channel, messageTs, threadTs, text } })).event;
  };
  const root = await chat(firstThread, firstThread, "@Sam");
  const unrelated = await chat(otherThread, otherThread, "Choose inventory allocation tables or model weights.");
  const active = await chat("1787356802.000001", firstThread, "First trying model only; this is not final.");
  const b = await budget();
  const requests: any[] = [], outputs: any[] = [];
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `thread-boundaries-${active.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      if (requests.length === 1) {
        const initial = JSON.parse(request.input[0].content);
        expect(initial.observation.discussion.sameAsActive).toBe(true);
        expect(initial.sourceReferences.find((e: any) => e.id === root.id).discussion.sameAsActive).toBe(true);
      } else {
        const result = JSON.parse(request.input.at(-1).output); outputs.push(result);
        expect(result.discussion.sameAsActive).toBe(false);
        expect(result.discussion.threadTs).toBe(otherThread);
      }
      return Response.json({ id: `thread-${requests.length}`, status: "completed", model: "fixture",
        output: requests.length === 1 ? [{ type: "function_call", name: "read_source", call_id: "foreign-source",
          arguments: JSON.stringify({ id: unrelated.id }) }] : [{ type: "message", content: [{ type: "output_text", text: "Unresolved task identity" }] }],
        usage: { input_tokens: 1, output_tokens: 1 } });
    } });
  expect((await agent.run({ eventId: active.id, budgetId: b.id })).state).toBe("completed");
  await artifact("source-discussion-boundaries-e2e", { ok: true, externalProviderCalls: 0, sourceIds: [root.id, unrelated.id, active.id], outputs });
});

// Failure-first: retry a connection that never delivered a request; do not repeat an unknown socket outcome.
it("retries an undelivered connect timeout but leaves an unknown socket outcome suspended", async () => {
  const outcomes: unknown[] = [];
  for (const code of ["UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]) {
    const event = await source("No new work; check the transport boundary.");
    const b = await budget();
    let attempts = 0;
    const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
      pipelineVersion: `connection-retry-${code}-${event.id}`, allowedVisibilities: ["company"], priceBasis,
      fetcher: async () => {
        if (++attempts === 1) throw new TypeError("fetch failed", { cause: { code } });
        return Response.json({ id: `connected-${event.id}`, status: "completed", model: "fixture",
          output: [{ type: "message", content: [{ type: "output_text", text: "No change" }] }],
          usage: { input_tokens: 1, output_tokens: 1 } });
      } });
    if (code === "UND_ERR_CONNECT_TIMEOUT") {
      expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
      expect(attempts).toBe(2);
      const current = (await store.getInferenceBudget(b.id))!;
      expect(current.state).toBe("active");
      expect(current.reservedCalls).toBe(0);
      expect(current.spentCalls).toBe(2);
    } else {
      await expect(agent.run({ eventId: event.id, budgetId: b.id })).rejects.toThrow("fetch failed");
      expect(attempts).toBe(1);
      const current = (await store.getInferenceBudget(b.id))!;
      expect(current.state).toBe("suspended");
      expect(current.reservedCalls).toBe(1);
    }
    outcomes.push({ code, attempts, budget: await store.getInferenceBudget(b.id) });
  }
  await artifact("provider-connection-boundary-e2e", { ok: true, externalProviderCalls: 0, outcomes });
});

// Failure-first: a productive report can require more than 24 reads without being an infinite loop.
it("finishes a productive multi-item observation after more than 24 tool turns", async () => {
  const tasks = await Promise.all(Array.from({ length: 26 }, (_, n) => ledger.createTask({
    title: `Multi-item work ${n}`, description: `Distinct work item ${n}`, status: "planned" }, "user:e2e")));
  const event = await source("Read the current fields of the 26 distinct work items in this report.");
  const b = await budget();
  let turns = 0;
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `multi-item-${event.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async () => {
      const task = tasks[turns++];
      return Response.json({ id: `multi-item-${turns}`, status: "completed", model: "fixture",
        output: task ? [{ type: "function_call", name: "read_task", call_id: `multi-read-${turns}`,
          arguments: JSON.stringify({ id: task.id }) }] : [{ type: "message", content: [{ type: "output_text", text: "Reads complete" }] }],
        usage: { input_tokens: 1, output_tokens: 1 } });
    } });
  expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
  expect(turns).toBe(27);
  await artifact("productive-multi-item-e2e", { ok: true, externalProviderCalls: 0, turns, tasks: tasks.length });
});

it("reads only the latest task and context and excludes >500 obsolete source receipts", async () => {
  const marker = `obsolete-history-${randomUUID()}`;
  const task = await ledger.createTask({ title: "Current task", description: "Start",
    project: "Current container", owner: "Alice", status: "planned" }, "user:e2e");
  const receipts = [];
  for (let n = 0; n < 501; n++) receipts.push(await source(`Old receipt ${n}`));
  const old = await store.createProposal({ kind: "task_change", taskId: task.id, baseVersion: task.version,
    changes: { description: marker.repeat(500) }, rationale: "Old description",
    requestedBy: "user:e2e", evidenceIds: receipts.map(e => e.id) });
  await store.approveAndApplyProposal({ proposalId: old.id, state: "approved",
    decidedBy: "user:e2e", decisionNote: "Fixture", auditAction: "fixture" });
  const event = await source("Read latest records only");
  const current = await store.createProposal({ kind: "task_change", taskId: task.id, baseVersion: (await store.getTask(task.id))!.version,
    changes: { description: "Latest description" }, rationale: "Current description",
    requestedBy: "user:e2e", evidenceIds: [event.id] });
  await store.approveAndApplyProposal({ proposalId: current.id, state: "approved",
    decidedBy: "user:e2e", decisionNote: "Fixture", auditAction: "fixture" });
  const context = await ledger.createContextEntry({ kind: "fact", path: `/latest/${event.id}`,
    title: "Latest context", factType: "policy", value: marker }, "user:e2e");
  const cp = await ledger.proposeContextFact({ sourceRef: context.sourceRef, path: context.path,
    title: context.title, factType: "policy", value: "Latest policy", rationale: "Current",
    requestedBy: "user:e2e", evidenceIds: [event.id], effectiveFrom: event.occurredAt });
  await store.approveAndApplyContextProposal({ proposalId: cp.id, state: "approved",
    decidedBy: "user:e2e", decisionNote: "Fixture", auditAction: "fixture" });
  const steps = [["search_tasks", { query: "Current task", limit: 1 }],
    ["read_task", { id: task.id }], ["read_context", { id: context.id }]];
  const requests: any[] = [], results: any[] = [];
  const b = await budget();
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `latest-records-${event.id}`, allowedVisibilities: ["company"], priceBasis,
    embeddings: { model: "voyageai/voyage-4", modelVersion: "voyageai/voyage-4", dimensions: 2,
      embed: async input => input.texts.map(() => [1, 0]) },
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      if (request.input.at(-1).type === "function_call_output") results.push(JSON.parse(request.input.at(-1).output));
      const step = steps[requests.length - 1];
      return new Response(JSON.stringify({ id: `latest-${requests.length}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: step[0], call_id: `latest-${requests.length}`, arguments: JSON.stringify(step[1]) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Read current records" }] }],
        usage: { input_tokens: 100, output_tokens: 20 } }));
    } });
  expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
  expect(requests).toHaveLength(4);
  expect(results[1]).toEqual({ task: expect.objectContaining({ id: task.id, title: task.title,
    project: task.project, owner: "Alice", description: "Latest description", version: 3 }) });
  expect(results[2]).toEqual({ context: expect.objectContaining({ id: context.id, value: "Latest policy" }) });
  expect(JSON.stringify(results)).not.toContain(marker);
  expect(JSON.stringify(results)).not.toContain("evidenceIds");
  expect(JSON.stringify(results)).not.toContain("outcomeContract");
  const runId = (await store.getLatestObservationDisposition(event.id, `latest-records-${event.id}`))!.runId!;
  const sourceCounts = (await pool.query<{ count: number }>(
    "SELECT cardinality(contextual_source_event_ids)::int AS count FROM model_calls WHERE run_id=$1", [runId])).rows;
  expect(sourceCounts.every(call => call.count < 500)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(results[1]))).toBeLessThan(1500);
  await artifact("latest-records-e2e", { ok: true, externalProviderCalls: 0,
    obsoleteReceipts: receipts.length, requests: requests.length, results,
    taskResponseBytes: Buffer.byteLength(JSON.stringify(results[1])),
    maxSourceIds: Math.max(...sourceCounts.map(call => call.count)) });
}, 120_000);

it("publishes strict schemas and completes nullable writes without argument-error correction turns", async () => {
  const require = createRequire(import.meta.url);
  const fastifyRequire = createRequire(require.resolve("fastify"));
  const Ajv = fastifyRequire("ajv/dist/2020.js").default;
  const ajv = new Ajv({ strict: false });
  fastifyRequire("ajv-formats")(ajv);
  const task = await ledger.createTask({ title: "Schema task", owner: "Alice", status: "planned" }, "user:e2e");
  const event = await source("Complete schema task and save fact and document");
  const b = await budget();
  const requests: any[] = [], results: any[] = [];
  let factId: string;
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `strict-records-${event.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      const byName = new Map<string, any>(request.tools.map((t: any) => [t.name, t]));
      const check = (schema: any): void => {
        if (schema.type === "object") {
          expect(schema.additionalProperties).toBe(false);
          expect(schema.required).toEqual(Object.keys(schema.properties));
          Object.values(schema.properties).forEach(check);
        }
        if (schema.items) check(schema.items);
        schema.anyOf?.forEach(check);
      };
      for (const tool of request.tools) { expect(tool.strict).toBe(true); check(tool.parameters); }
      const validator = (name: string) => ajv.compile(byName.get(name).parameters);
      expect(validator("read_task")({ id: task.id, format: "json" })).toBe(false);
      const prev = request.input.at(-1);
      if (prev.type === "function_call_output") {
        const result = JSON.parse(prev.output); results.push(result);
        expect(result.error).toBeUndefined();
        if (results.length === 1) expect(result.owner).toBe("Alice");
        if (results.length === 3) factId = result.id;
      }
      const stepIndex = requests.length - 1;
      const taskChanges = Object.fromEntries(Object.keys(byName.get("update_task").parameters.properties.changes.properties).map(k => [k, null]));
      const steps: [string, any][] = [
        ["update_task", { id: task.id, changes: { ...taskChanges, status: "done", sourceUrl: "https://example.com/proof" }, clearFields: [], rationale: "Complete work" }],
        ["update_task", { id: task.id, changes: taskChanges, clearFields: ["owner"], rationale: "Clear owner explicitly" }],
        ["create_context", { path: `/strict-fact/${event.id}`, title: "Strict fact", content: { kind: "fact", factType: "policy", value: "Accepted" }, rationale: "Observed policy" }],
        ["create_context", { path: `/strict-file/${event.id}`, title: "Strict document", content: { kind: "file", body: "Current document" }, rationale: "Observed document" }],
        ["read_task", { id: task.id }],
      ];
      expect(validator("create_context")({ path: "/bad", title: "Bad", content: { kind: "file", body: "File", value: "Fact" }, rationale: "Bad" })).toBe(false);
      const step = steps[stepIndex];
      if (step) expect(validator(step[0])(step[1])).toBe(true);
      return new Response(JSON.stringify({ id: `strict-${requests.length}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: step[0], call_id: `strict-${requests.length}`, arguments: JSON.stringify(step[1]) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 100, output_tokens: 20 } }));
    } });
  expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
  expect(requests).toHaveLength(6);
  expect((await store.getTask(task.id))?.owner).toBeNull();
  expect((await store.getTask(task.id))?.sourceUrl).toBe("https://example.com/proof");
  expect((await store.getContextEntry(factId!))?.kind).toBe("fact");
  expect(JSON.stringify(results)).not.toContain("history");
  expect(JSON.stringify(results)).not.toContain("evidenceIds");
  await artifact("strict-record-tools-e2e", { ok: true, externalProviderCalls: 0,
    modelCalls: requests.length, correctionTurns: 0, results, schemas: requests[0].tools });
}, 60_000);

it("replays recorded format hints and misplaced rationale without tool-error correction turns", async () => {
  const task = await ledger.createTask({ title: "Recorded argument task", status: "planned" }, "user:e2e");
  const context = await ledger.createContextEntry({ kind: "fact", path: `/recorded/${task.id}`,
    title: "Recorded policy", factType: "policy", value: "Current policy" }, "user:e2e");
  const event = await source("Use recorded read/write argument shapes");
  const b = await budget();
  const steps = [["read_task", { id: task.id, format: "json" }],
    ["read_context", { id: context.id, format: "json" }],
    ["read_source", { id: event.id, format: "json" }],
    ["update_task", { id: task.id, changes: { status: "done", sourceUrl: "https://example.com/recorded",
      rationale: "Recorded completion" } }]];
  const results: any[] = [];
  let calls = 0;
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `recorded-arguments-${event.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const last = request.input.at(-1);
      if (last.type === "function_call_output") {
        const result = JSON.parse(last.output); expect(result.error).toBeUndefined(); results.push(result);
      }
      const step = steps[calls++];
      return new Response(JSON.stringify({ id: `recorded-${calls}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: step[0], call_id: `recorded-${calls}`, arguments: JSON.stringify(step[1]) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 100, output_tokens: 20 } }));
    } });
  expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
  expect(calls).toBe(5);
  expect((await store.getTask(task.id))?.status).toBe("done");
  expect((await store.getTask(task.id))?.sourceUrl).toBe("https://example.com/recorded");
  expect((await store.listTaskProposals(task.id)).find(p => p.requestedBy === "observation-agent")?.rationale).toBe("Recorded completion");
  await artifact("recorded-tool-arguments-e2e", { ok: true, externalProviderCalls: 0,
    modelCalls: calls, correctionTurns: 0, results });
}, 60_000);

it("keeps >500 authorized current receipts in audit metadata without sending them as context fields", async () => {
  const event = await source("Read a context supported by many receipts");
  const receipts = [];
  for (let n = 0; n < 501; n++) receipts.push(await source(`Current support ${n}`));
  const proposal = await ledger.proposeContextFact({ sourceRef: `many-receipts:${event.id}`,
    path: `/many-receipts/${event.id}`, title: "Current many-source policy", factType: "policy",
    value: "Current policy", rationale: "Supported current policy", requestedBy: "user:e2e",
    evidenceIds: receipts.map(e => e.id), effectiveFrom: event.occurredAt });
  const context = await store.approveAndApplyContextProposal({ proposalId: proposal.id,
    state: "approved", decidedBy: "user:e2e", decisionNote: "Fixture", auditAction: "fixture" });
  const b = await budget();
  let calls = 0;
  let response: any;
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `many-receipts-${event.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      calls++;
      if (calls === 2) response = JSON.parse(request.input.at(-1).output);
      return new Response(JSON.stringify({ id: `many-${calls}`, model: "fixture", status: "completed",
        output: calls === 1 ? [{ type: "function_call", name: "read_context", call_id: "many-read",
          arguments: JSON.stringify({ id: context.id }) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Read current policy" }] }],
        usage: { input_tokens: 100, output_tokens: 20 } }));
    } });
  expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
  expect(calls).toBe(2);
  expect(response.context.value).toBe("Current policy");
  expect(response.context.evidenceIds).toBeUndefined();
  const runId = (await store.getLatestObservationDisposition(event.id, `many-receipts-${event.id}`))!.runId!;
  const maxSources = (await pool.query("SELECT max(cardinality(contextual_source_event_ids))::int AS count FROM model_calls WHERE run_id=$1", [runId])).rows[0].count;
  expect(maxSources).toBeGreaterThan(500);
  await expect(store.reserveModelCall({ budgetId: b.id, runId, purpose: "observe",
    logicalCallKey: randomUUID(), attempt: 1, provider: "openai", model: "fixture",
    requestHash: randomUUID(), request: {}, cacheKey: null, contextualSourceEventIds: ["invalid-id"],
    estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedUsd: "0" })).rejects.toThrow("contextual source list is invalid");
  const privateEvent = (await store.appendSourceEvent({ provider: "manual", installationKey: "records-e2e",
    providerEventId: randomUUID(), eventKind: "message.observed", occurredAt: event.occurredAt,
    fetchedAt: event.fetchedAt, sourceRef: `private:${event.id}`, sourceUrl: null, contentHash: randomUUID(),
    visibility: "private", payloadVersion: "fixture", payload: { text: "Private fixture" } })).event;
  await store.revokeSourceEvent(privateEvent.id);
  await expect(store.reserveModelCall({ budgetId: b.id, runId, purpose: "observe",
    logicalCallKey: randomUUID(), attempt: 1, provider: "openai", model: "fixture",
    requestHash: randomUUID(), request: {}, cacheKey: null, contextualSourceEventIds: [privateEvent.id],
    estimatedInputTokens: 1, estimatedOutputTokens: 1, estimatedUsd: "0" })).rejects.toThrow();
  await artifact("current-provenance-e2e", { ok: true, externalProviderCalls: 0,
    modelCalls: calls, auditSourceCount: maxSources, contextResponseBytes: Buffer.byteLength(JSON.stringify(response)) });
}, 120_000);

// Failures recorded before this repair: full description copies exceed response capacity;
// a compact edit drops existing scope; repeated text creates duplicate notes;
// ambiguous replacement changes the wrong span. All writes use the real ledger and DB.
it("edits a long task description without copying it into tool arguments and rejects ambiguous edits", async () => {
  const description = "Keep the complete importer rollout scope.\n" + "Existing distinct progress remains recorded.\n".repeat(700);
  const task = await ledger.createTask({ title: "Long importer work", description, status: "in_progress" }, "user:e2e");
  const event = await source("The next importer passed its checks; the rollout is still open.");
  const b = await budget();
  const results: any[] = [], requests: any[] = [];
  const steps = [
    { id: task.id, replacements: [{ oldText: "Existing distinct progress remains recorded.", newText: "Lost history" }], append: null, rationale: "Ambiguous edit must fail" },
    { id: task.id, replacements: [], append: "Next importer passed its checks; rollout remains open.", status: "review", rationale: "Record progress and required review atomically" },
    { id: task.id, replacements: [], append: "Next importer passed its checks; rollout remains open.", status: "review", rationale: "Repeated note is unchanged" },
  ];
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture", pipelineVersion: `compact-edit-${event.id}`,
    allowedVisibilities: ["company"], priceBasis, fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      expect(request.tools.some((t: any) => t.name === "edit_task_description")).toBe(true);
      expect(request.max_output_tokens).toBeGreaterThanOrEqual(8000);
      if (request.input.at(-1).type === "function_call_output") results.push(JSON.parse(request.input.at(-1).output));
      const step = steps[requests.length - 1];
      return new Response(JSON.stringify({ id: `edit-${requests.length}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: "edit_task_description", call_id: `edit-${requests.length}`, arguments: JSON.stringify(step) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Done" }] }], usage: { input_tokens: 100, output_tokens: 20 } }));
    } });
  expect((await agent.run({ eventId: event.id, budgetId: b.id })).state).toBe("completed");
  expect(results[0].error).toContain("exactly once");
  expect((await store.getTask(task.id))!.status).toBe("review");
  expect(results[2].unchanged).toBe(true);
  expect((await store.getTask(task.id))!.description).toBe(description + "\n\n" + steps[1]!.append);
  expect((await store.listProposals()).filter(p => p.requestedBy === "observation-agent" && p.taskId === task.id)).toHaveLength(1);
  await artifact("compact-description-edit-e2e", { ok: true, descriptionChars: description.length, requests: requests.length,
    retainedOriginal: true, ambiguousEditRejected: true, repeatedNoteUnchanged: true, externalProviderCalls: 0 });
});

// Failure-first: another accepted writer updates a description after a compact edit reads it.
// The stale edit must not overwrite that update; reread/retry must preserve both notes.
it("preserves concurrent accepted description changes when a compact edit retries", async () => {
  const task = await ledger.createTask({ title: "Concurrent edit fixture", description: "Original scope", status: "planned" }, "user:e2e");
  const event = await source("Append current progress without losing the reviewer note");
  const b = await budget();
  let armed = false, injected = false, turn = 0;
  const toolResults: any[] = [];
  const reader = new Proxy(store, { get(target, property) {
    if (property === "getTask") return async (id: string) => {
      if (id === task.id && armed && !injected) {
        injected = true;
        const current = (await target.getTask(id))!;
        const proposal = await target.createProposal({ kind: "task_change", taskId: id, baseVersion: current.version,
          changes: { description: current.description + "\nConcurrent reviewer note" }, rationale: "Concurrent accepted change",
          requestedBy: "user:e2e", evidenceIds: [event.id] });
        await target.approveAndApplyProposal({ proposalId: proposal.id, state: "approved", decidedBy: "user:e2e",
          decisionNote: "Fixture", auditAction: "fixture" });
      }
      return target.getTask(id);
    };
    const value = target[property as keyof PostgresLedgerStore];
    return typeof value === "function" ? value.bind(target) : value;
  }});
  const agent = new ObservationAgent({ store: reader, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `concurrent-edit-${event.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.input.at(-1)?.type === "function_call_output") toolResults.push(JSON.parse(request.input.at(-1).output));
      armed = true;
      const step = turn++;
      const name = step === 1 ? "read_task" : "edit_task_description";
      const args = step === 1 ? { id: task.id } : { id: task.id, replacements: [], append: "Current progress", rationale: "Append progress" };
      return Response.json({ id: `concurrent-${step}`, model: "fixture", status: "completed",
        output: step < 3 ? [{ type: "function_call", name, call_id: `concurrent-${step}`, arguments: JSON.stringify(args) }]
          : [{ type: "message", content: [{ type: "output_text", text: "Finished" }] }],
        usage: { input_tokens: 1, output_tokens: 1 } });
    } });
  const run = await agent.run({ eventId: event.id, budgetId: b.id });
  const current = (await store.getTask(task.id))!;
  expect(current.description).toContain("Concurrent reviewer note");
  expect(current.description).toContain("Original scope");
  expect(current.description).toContain("Current progress");
  expect(toolResults[0].error).toContain("changed");
  expect(run.writes).toBe(1);
  await artifact("concurrent-description-edit-e2e", { ok: true, externalProviderCalls: 0, run, task: current, toolResults });
});

// Failure-first: the latest tail of an imported thread can omit the active report's target.
it("keeps nearby source messages when a long thread has later replies", async () => {
  const channel = `C${randomUUID()}`, installationKey = `nearby-${randomUUID()}`;
  const sent = 1787356800;
  const chat = async (delta: number, text: string) => {
    const id = randomUUID(), messageTs = String(sent + delta);
    return (await store.appendSourceEvent({ provider: "slack", installationKey,
      providerEventId: id, eventKind: "message.imported", occurredAt: new Date((sent + delta) * 1000).toISOString(),
      fetchedAt: new Date().toISOString(), sourceRef: `slack:TNEAR:${channel}:${messageTs}`,
      sourceUrl: null, contentHash: id, visibility: "company", payloadVersion: "fixture",
      payload: { teamId: "TNEAR", channel, messageTs, threadTs: String(sent - 10000), text } })).event;
  };
  await chat(-10000, "Please tag the shipment owner.");
  const target = await chat(-60, "What does it cost to pair shipment evidence with route nodes?");
  const event = await chat(0, "First trying model only. This is preliminary.");
  for (let i = 1; i <= 30; i++) await chat(i * 3600, `Later discussion ${i}`);
  let seen: any[] = [];
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: randomUUID(), allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      const initial = JSON.parse(request.input[0].content);
      seen = initial.sourceReferences;
      expect(seen.some(source => source.id === target.id)).toBe(true);
      expect(seen.map(source => source.occurredAt)).toEqual(seen.map(source => source.occurredAt).sort());
      return Response.json({ id: "nearby-fixture", status: "completed", model: "fixture",
        output: [], usage: { input_tokens: 10, output_tokens: 1 } });
    } });
  expect((await agent.run({ eventId: event.id, budgetId: (await budget()).id })).state).toBe("completed");
  await artifact("nearby-thread-context-e2e", { ok: true, externalProviderCalls: 0,
    activeEventId: event.id, targetSourceId: target.id, selectedSourceIds: seen.map(source => source.id) });
});

// Failure-first: the conversation must inspect its final source coverage before completing.
it("checks source coverage before finishing and retains a missing implementation limitation", async () => {
  const event = await source("Commit: added a delivery pipeline through a temporary adapter. The adapter remains a stopgap pending the final handoff.");
  const contextPath = `/completion/${randomUUID()}`;
  const requests: any[] = [];
  const agent = new ProductionObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: randomUUID(), allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body)); requests.push(request);
      const turn = requests.length;
      let output: any[] = [];
      if (turn === 1) output = [{ type: "function_call", name: "create_context", call_id: "partial-note",
        arguments: JSON.stringify({ path: contextPath, title: "Delivery pipeline implementation",
          content: { kind: "fact", factType: "other", value: "Added the delivery pipeline." }, rationale: "Record implementation." }) }];
      if (turn === 3) {
        const check = JSON.parse(request.input.filter((item: any) => item.role === "user").at(-1).content);
        expect(check.kind).toBe("observation_completion_check");
        expect(check.observation.id).toBe(event.id);
        const context = (await store.listContextEntries()).find(entry => entry.path === contextPath)!;
        output = [{ type: "function_call", name: "update_context", call_id: "retain-limitation",
          arguments: JSON.stringify({ id: context.id, changes: { value: "Added the delivery pipeline through a temporary adapter. The adapter remains a stopgap pending the final handoff." }, rationale: "Retain the missing material source limitation." }) }];
      }
      return Response.json({ id: `coverage-${turn}`, status: "completed", model: "fixture", output,
        usage: { input_tokens: 10, output_tokens: 1 } });
    } });
  const result = await agent.run({ eventId: event.id, budgetId: (await budget()).id });
  const context = (await store.listContextEntries()).find(entry => entry.path === contextPath)!;
  expect(context.kind === "fact" ? context.value : context.body).toContain("stopgap");
  expect(result.writes).toBe(2);
  const calls = await store.listModelCalls(result.runId!);
  expect(calls.every(call => call.purpose === "observe" && call.runId === result.runId)).toBe(true);
  expect(calls.filter(call => call.state !== "succeeded")).toHaveLength(0);
  await artifact("completion-source-coverage-e2e", { ok: true, externalProviderCalls: 0, result,
    context, calls: calls.map(call => ({ purpose: call.purpose, state: call.state, runId: call.runId })) });
});

// Failure-first: done is returned without its source or author; newer unrelated edits
// replace completion provenance; old payloads or inaccessible receipts leak into reads.
it("exposes current completion sources and authors without obsolete task snapshots", async () => {
  const task = await ledger.createTask({ title: `Collect sample ${randomUUID()}`,
    description: "Collect and publish the sample.", status: "planned" }, "user:e2e");
  const report = await source("Collected the sample; publication was not reported.");
  const completion = await store.createProposal({ kind: "task_change", taskId: task.id,
    baseVersion: task.version, changes: { status: "done" }, rationale: "Legacy generated completion",
    requestedBy: "intelligence:fixture", evidenceIds: [report.id] });
  await store.approveAndApplyProposal({ proposalId: completion.id, state: "auto_applied",
    decidedBy: "intelligence:fixture", decisionNote: "Fixture", auditAction: "fixture" });
  const active = await source("Read the current completion evidence.");
  const note = await store.createProposal({ kind: "task_change", taskId: task.id,
    baseVersion: (await store.getTask(task.id))!.version, changes: { sourceUrl: "https://example.test/note" },
    rationale: "Unrelated link edit", requestedBy: "user:e2e", evidenceIds: [active.id] });
  await store.approveAndApplyProposal({ proposalId: note.id, state: "approved",
    decidedBy: "user:e2e", decisionNote: "Fixture", auditAction: "fixture" });
  const human = await ledger.createTask({ title: `Bounded trial ${randomUUID()}`,
    description: "Finish this bounded trial.", status: "done" }, "user:e2e");
  const steps = [["read_task", { id: task.id }], ["read_task", { id: human.id }]];
  const results: any[] = []; let call = 0;
  const b = await budget();
  const agent = new ObservationAgent({ store, ledger, apiKey: "fixture", model: "fixture",
    pipelineVersion: `completion-provenance-${active.id}`, allowedVisibilities: ["company"], priceBasis,
    fetcher: async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.input.at(-1).type === "function_call_output") results.push(JSON.parse(request.input.at(-1).output));
      const step = steps[call++];
      return new Response(JSON.stringify({ id: `provenance-${call}`, model: "fixture", status: "completed",
        output: step ? [{ type: "function_call", name: step[0], call_id: `provenance-${call}`,
          arguments: JSON.stringify(step[1]) }] : [{ type: "message", content: [{ type: "output_text", text: "Read evidence" }] }],
        usage: { input_tokens: 100, output_tokens: 20 } }));
    } });
  expect((await agent.run({ eventId: active.id, budgetId: b.id })).state).toBe("completed");
  expect(results[0].task.statusProvenance).toEqual({ revisionVersion: 2,
    appliedAt: expect.any(String), appliedBy: "intelligence:fixture", requestedBy: "intelligence:fixture",
    sourceEventIds: [report.id] });
  expect(results[0].task.version).toBe(3);
  expect(results[1].task.statusProvenance.requestedBy).toBe("user:e2e");
  expect(JSON.stringify(results)).not.toContain("Legacy generated completion");
  await artifact("completion-provenance-e2e", { ok: true, externalProviderCalls: 0, results });
});
