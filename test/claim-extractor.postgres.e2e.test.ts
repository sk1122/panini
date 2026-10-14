import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { OpenAIClaimExtractor } from "../src/intelligence/claim-extractor.js";
import { LUNA_PRICE_2026_10_01 } from "../src/intelligence/model-price.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 29).toString("base64");

describe("Bounded claim extraction through the provider boundary", () => {
  let store: PostgresLedgerStore;
  let pool: pg.Pool;
  beforeAll(async () => {
    if (!databaseUrl || !databaseUrl.includes("panini_e2e")) throw new Error("Isolated panini_e2e database required");
    store = new PostgresLedgerStore(databaseUrl, key);
    pool = new pg.Pool({ connectionString: databaseUrl });
    expect((await pool.query<{ current_database: string }>("SELECT current_database()"))
      .rows[0]?.current_database).toBe("panini_e2e");
  });
  afterAll(async () => { await store?.close(); await pool?.end(); });

  it("derives exact spans locally and accounts for a mocked model call", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker,
        text: "The retest is done. The repair remains open." },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 10000, maxOutputTokens: 5000, maxUsd: "0.01000000",
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: { ...LUNA_PRICE_2026_10_01 } });
    const run = await store.createV2Run({ model: "gpt-5.6-luna", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "extract-e2e", promptVersion: "v1", policyVersion: "v1", configHash: marker,
      replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    const calls: unknown[] = [];
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "gpt-5.6-luna",
      priceBasis: LUNA_PRICE_2026_10_01,
      allowedVisibilities: ["slack:channel:C1"], fetcher: async (_url, init) => {
        calls.push(JSON.parse(String(init?.body)));
        return new Response(JSON.stringify({ id: `response-${marker}`, model: "gpt-5.6-luna", status: "completed",
          output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify({
            claims: [{ kind: "completion_report", eventId: event.id, jsonPointer: "/text",
              quote: "The retest is done.", statement: "The retest is done.",
              subjectRefs: [], assertedField: "status", assertedValue: "done",
              assertedAt: "2026-10-01T01:00:00.000Z", caveats: [] }],
            dispositions: [{ eventId: event.id, state: "extracted", claimOrdinals: [0], reasonCode: null }],
          }) }] }], usage: { input_tokens: 100, output_tokens: 40,
            input_tokens_details: { cached_tokens: 0 } } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const result = await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(result.claims).toHaveLength(1);
    expect(result.claims[0]?.spans[0]?.locator).toMatchObject({ kind: "text", jsonPointer: "/text",
      startUtf16: 0, endUtf16: 19 });
    expect(calls).toHaveLength(1);
    const sent = JSON.parse((calls[0] as { input: string }).input) as
      { fields: { jsonPointer: string }[] }[];
    expect(sent.flatMap((item) => item.fields.map((field) => field.jsonPointer)))
      .toEqual(["/text"]);
    expect((await store.listModelCalls(run.id))).toMatchObject([{ state: "succeeded", purpose: "extract",
      inputTokens: 100, outputTokens: 40, costBasis: "estimated" }]);
  });

  it("refuses an unauthorized source before constructing an external prompt", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C-PRIVATE:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C-PRIVATE", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C-PRIVATE", messageTs: marker,
        text: "Restricted detail must not reach the provider." },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: "0.01000000",
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: { ...LUNA_PRICE_2026_10_01 } });
    const run = await store.createV2Run({ model: "gpt-5.6-luna", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "private-prompt-e2e", promptVersion: "v1",
      policyVersion: "v1", configHash: marker, replayMode: "live",
      evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    let externalCalls = 0;
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key",
      model: "gpt-5.6-luna", priceBasis: LUNA_PRICE_2026_10_01,
      allowedVisibilities: ["company"], fetcher: async () => {
        externalCalls += 1;
        throw new Error("The provider must not be called.");
      } });
    await expect(extractor.extract({ events: [event], runId: run.id, budgetId: budget.id }))
      .rejects.toThrow("not authorized for external extraction");
    expect(externalCalls).toBe(0);
    expect(await store.listModelCalls(run.id)).toEqual([]);
  });

  it("continues across an oversized source without discarding its later section", async () => {
    const marker = randomUUID();
    const tail = "The final migration was deployed.";
    const event = (await store.appendSourceEvent({ provider: "notion", installationKey: "default",
      providerEventId: marker, eventKind: "source.document.retrieved",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `notion:page:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "notion:page:test", payloadVersion: "test-v1",
      payload: { pageId: marker, document: { body: `${"A".repeat(90_000)} ${tail}` } },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 10,
      maxInputTokens: 200000, maxOutputTokens: 40000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "large-document-e2e", promptVersion: "v1", policyVersion: "v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    let calls = 0;
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["notion:page:test"], fetcher: async (_url, init) => {
        calls += 1;
        const state = JSON.parse((JSON.parse(String(init?.body)) as { input: string }).input) as
          { eventId: string; fields: { jsonPointer: string; text: string }[] }[];
        const hasTail = state.some((item) => item.fields.some((field) => field.text.includes(tail)));
        return new Response(JSON.stringify({ id: `response-${marker}-${calls}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: hasTail ? [{ kind: "artifact_observation", eventId: event.id,
              jsonPointer: "/document/body", quote: tail, statement: tail, subjectRefs: [],
              assertedField: null, assertedValue: null, assertedAt: event.occurredAt,
              caveats: [] }] : [], dispositions: [{ eventId: event.id,
                state: hasTail ? "extracted" : "no_claim", claimOrdinals: hasTail ? [0] : [],
                reasonCode: hasTail ? null : "none_in_section" }] }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const output = await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(calls).toBeGreaterThan(1);
    expect(output.claims).toHaveLength(1);
    expect(output.dispositions).toMatchObject([{ eventId: event.id, state: "extracted",
      claimOrdinals: [0] }]);
    expect((await store.listModelCalls(run.id))).toHaveLength(calls);
  });

  it("deduplicates the same exact claim seen in overlapping continuation sections", async () => {
    const marker = randomUUID();
    const quote = "Completion confirmed.";
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker,
        text: `${"A".repeat(47_500)}${quote}${"Z".repeat(20_000)}` },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3,
      maxInputTokens: 100000, maxOutputTokens: 12000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "overlap-e2e", promptVersion: "v1", policyVersion: "v1", configHash: marker,
      replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z", knowledgeCutoff: null,
      budgetId: budget.id, manifest: {} });
    let calls = 0;
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["slack:channel:C1"], fetcher: async (_url, init) => {
        calls += 1;
        const request = JSON.parse(String(init?.body)) as { input: string };
        const sections = JSON.parse(request.input) as { fields: { text: string }[] }[];
        const hasQuote = sections.some((section) => section.fields.some((field) => field.text.includes(quote)));
        return new Response(JSON.stringify({ id: `response-${marker}-${calls}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: hasQuote ? [{ kind: "completion_report", eventId: event.id,
              jsonPointer: "/text", quote, statement: quote, subjectRefs: [],
              assertedField: "status", assertedValue: "done", assertedAt: event.occurredAt,
              caveats: [] }] : [], dispositions: [{ eventId: event.id,
              state: hasQuote ? "extracted" : "no_claim",
              claimOrdinals: hasQuote ? [0] : [], reasonCode: null }] }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const result = await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(calls).toBe(2);
    expect(result.claims).toHaveLength(1);
    expect(result.dispositions).toMatchObject([{ eventId: event.id, claimOrdinals: [0] }]);
  });

  it("covers a document with hundreds of short fields without dropping the episode", async () => {
    const marker = randomUUID();
    const fields = Object.fromEntries(Array.from({ length: 600 }, (_, index) =>
      [`line_${index}`, `Observation ${index}.`]));
    const event = (await store.appendSourceEvent({ provider: "notion", installationKey: "default",
      providerEventId: marker, eventKind: "source.document.retrieved",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `notion:page:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "notion:page:test", payloadVersion: "test-v1",
      payload: { pageId: marker, fields },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 10,
      maxInputTokens: 200000, maxOutputTokens: 40000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "many-fields-e2e", promptVersion: "v1", policyVersion: "v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    let calls = 0;
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["notion:page:test"], fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: `response-${marker}-${calls}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: [], dispositions: [{ eventId: event.id,
              state: "no_claim", claimOrdinals: [], reasonCode: "none_in_section" }] }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const output = await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(calls).toBeGreaterThan(1);
    expect(output.dispositions).toMatchObject([{ eventId: event.id, state: "no_claim" }]);
  });

  it("splits an invalid structured batch and keeps every source disposition", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "notion", installationKey: "default",
      providerEventId: marker, eventKind: "source.document.retrieved",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `notion:page:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "notion:page:test", payloadVersion: "test-v1",
      payload: { pageId: marker, document: { first: "First section.", second: "Second section." } },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 10,
      maxInputTokens: 200000, maxOutputTokens: 40000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "invalid-batch-e2e", promptVersion: "v1", policyVersion: "v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    let calls = 0;
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["notion:page:test"], fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: `response-${marker}-${calls}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: calls === 1 ? "invalid JSON" : JSON.stringify({ claims: [],
              dispositions: [{ eventId: event.id, state: "no_claim", claimOrdinals: [],
                reasonCode: "none_in_section" }] }).replace(
                  '"claimOrdinals":[]', calls === 2 ? '"claimOrdinals":[0]' : '"claimOrdinals":[]') }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    const output = await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(calls).toBeGreaterThan(2);
    expect(output.dispositions).toMatchObject([{ eventId: event.id, state: "unresolved",
      reasonCode: "section_unresolved" }]);
    expect((await store.listModelCalls(run.id))).toHaveLength(calls);
  });

  it("records a safe provider error code without logging the source text", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker, text: "Private source text." },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 10000, maxOutputTokens: 5000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "provider-error-e2e", promptVersion: "v1", policyVersion: "v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["slack:channel:C1"], fetcher: async () =>
        new Response(JSON.stringify({ error: { code: "context_length_exceeded",
          message: "Private source text." } }), { status: 400 }) });
    await expect(extractor.extract({ events: [event], runId: run.id, budgetId: budget.id }))
      .rejects.toThrow("HTTP 400 code=context_length_exceeded");
    expect((await store.listModelCalls(run.id))[0]).toMatchObject({ state: "failed",
      costBasis: "estimated",
      errorCode: "provider_http_400_context_length_exceeded_reserved_bound" });
    expect((await pool.query<{ state: string }>("SELECT state FROM inference_budgets WHERE id=$1",
      [budget.id])).rows[0]?.state).toBe("exhausted");
  });

  it("sends Notion document text and properties without incidental page metadata", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "notion", installationKey: "default",
      providerEventId: marker, eventKind: "source.document.retrieved",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `notion:page:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "notion:page:test", payloadVersion: "test-v1",
      payload: { page: { id: marker, created_time: "private-metadata-sentinel",
        properties: { title: "Release plan" } }, blocks: [],
      document: { title: "Release plan", markdown: "The launch remains open." } },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 3,
      maxInputTokens: 20000, maxOutputTokens: 10000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "notion-fields-e2e", promptVersion: "v1", policyVersion: "v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    const requests: string[] = [];
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["notion:page:test"], fetcher: async (_url, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({ id: `response-${marker}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: [], dispositions: [{ eventId: event.id,
              state: "no_claim", claimOrdinals: [], reasonCode: "none" }] }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }),
          { status: 200, headers: { "content-type": "application/json" } });
      } });
    await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(requests.join(" ")).toContain("The launch remains open.");
    expect(requests.join(" ")).toContain("Release plan");
    expect(requests.join(" ")).not.toContain("private-metadata-sentinel");
  });

  it("sends focused GitHub evidence fields without incidental metadata", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "github", installationKey: "7",
      providerEventId: marker, eventKind: "commit.snapshot",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `github:7:commit.snapshot:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "github:repository:test/repo", payloadVersion: "test-v1",
      payload: { repositoryId: 7, repository: "test/repo", sha: marker,
        message: "Wire the ingest worker", text: "Wire the ingest worker",
        metadata: { diagnostic: "secret: abcdefghijklmnopqrstuvwxyz1234" } },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 2,
      maxInputTokens: 20000, maxOutputTokens: 10000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker, eventIds: [event.id],
      pipelineVersion: "github-fields-e2e", promptVersion: "v1", policyVersion: "v1",
      configHash: marker, replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    const requests: string[] = [];
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["github:repository:test/repo"], fetcher: async (_url, init) => {
        requests.push(String(init?.body));
        return new Response(JSON.stringify({ id: `response-${marker}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: [], dispositions: [{ eventId: event.id,
              state: "no_claim", claimOrdinals: [], reasonCode: "none" }] }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }), { status: 200 });
      } });
    await extractor.extract({ events: [event], runId: run.id, budgetId: budget.id });
    expect(requests.join(" ")).toContain("Wire the ingest worker");
    expect(requests.join(" ")).toContain(marker);
    expect(requests.join(" ")).not.toContain("secret: abcdefghijklmnopqrstuvwxyz1234");
  });

  it("quarantines a credential-bearing section while extracting a safe sibling event", async () => {
    const marker = randomUUID();
    const append = async (suffix: string, body: string) => (await store.appendSourceEvent({
      provider: "slack", installationKey: "T1", providerEventId: `${marker}-${suffix}`,
      eventKind: "message.observed", occurredAt: "2026-10-01T01:00:00.000Z",
      fetchedAt: "2026-10-01T01:00:01.000Z", sourceRef: `slack:T1:C1:${marker}-${suffix}`,
      sourceUrl: null, contentHash: `${marker}-${suffix}`,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: `${marker}-${suffix}`, text: body },
    })).event;
    const safe = await append("safe", "The importer shipped.");
    const secret = "secret: abcdefghijklmnopqrstuvwxyz1234";
    const sensitive = await append("sensitive", secret);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 5,
      maxInputTokens: 50000, maxOutputTokens: 10000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [safe.id, sensitive.id], pipelineVersion: "screened-section-e2e",
      promptVersion: "v1", policyVersion: "v1", configHash: marker,
      replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    const requests: string[] = [];
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["slack:channel:C1"], fetcher: async (_url, init) => {
        const body = String(init?.body);
        requests.push(body);
        const input = JSON.parse((JSON.parse(body) as { input: string }).input) as
          { eventId: string; fields: { jsonPointer: string; text: string }[] }[];
        const ids = [...new Set(input.map((item) => item.eventId))];
        const hasQuote = input.some((item) => item.eventId === safe.id
          && item.fields.some((field) => field.text.includes("The importer shipped.")));
        return new Response(JSON.stringify({ id: `response-${marker}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: hasQuote ? [{ kind: "completion_report", eventId: safe.id,
              jsonPointer: "/text", quote: "The importer shipped.",
              statement: "The importer shipped.", subjectRefs: [], assertedField: "status",
              assertedValue: "done", assertedAt: safe.occurredAt, caveats: [] }] : [],
              dispositions: ids.map((eventId) => ({ eventId,
                state: eventId === safe.id && hasQuote ? "extracted" : "no_claim",
                claimOrdinals: eventId === safe.id && hasQuote ? [0] : [], reasonCode: null })) }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }), { status: 200 });
      } });
    const result = await extractor.extract({ events: [safe, sensitive], runId: run.id,
      budgetId: budget.id });
    expect(result.claims).toHaveLength(1);
    expect(result.dispositions).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventId: safe.id, state: "extracted" }),
      expect.objectContaining({ eventId: sensitive.id, state: "unresolved" }),
    ]));
    expect(requests.join(" ")).not.toContain(secret);
  });

  it("does not mistake escaped newlines in screened text for a credential", async () => {
    const marker = randomUUID();
    const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: marker, eventKind: "message.observed",
      occurredAt: "2026-10-01T01:00:00.000Z", fetchedAt: "2026-10-01T01:00:01.000Z",
      sourceRef: `slack:T1:C1:${marker}`, sourceUrl: null, contentHash: marker,
      visibility: "slack:channel:C1", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: marker,
        text: "password:\nshort\nmore_work_updates" },
    })).event;
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 10000, maxOutputTokens: 5000, maxUsd: null,
      deadline: new Date(Date.now() + 120_000).toISOString(), priceBasis: null });
    const run = await store.createV2Run({ model: "mock-model", inputHash: marker,
      eventIds: [event.id], pipelineVersion: "escaped-newline-e2e",
      promptVersion: "v1", policyVersion: "v1", configHash: marker,
      replayMode: "live", evaluationClock: "2026-10-01T01:00:02.000Z",
      knowledgeCutoff: null, budgetId: budget.id, manifest: {} });
    let calls = 0;
    const extractor = new OpenAIClaimExtractor({ store, apiKey: "mock-key", model: "mock-model",
      allowedVisibilities: ["slack:channel:C1"], fetcher: async () => {
        calls += 1;
        return new Response(JSON.stringify({ id: `response-${marker}`, model: "mock-model",
          status: "completed", output: [{ type: "message", content: [{ type: "output_text",
            text: JSON.stringify({ claims: [], dispositions: [{ eventId: event.id,
              state: "no_claim", claimOrdinals: [], reasonCode: "none" }] }) }] }],
          usage: { input_tokens: 1000, output_tokens: 80 } }), { status: 200 });
      } });
    const result = await extractor.extract({ events: [event], runId: run.id,
      budgetId: budget.id });
    expect(calls).toBe(1);
    expect(result.dispositions).toMatchObject([{ eventId: event.id, state: "no_claim" }]);
  });
});
