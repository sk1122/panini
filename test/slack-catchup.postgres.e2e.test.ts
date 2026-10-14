import { createHash, randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SlackCaptureAdapter, type SlackMessage } from "../src/connectors/slack/socket-mode.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const orgId = randomUUID();

describe("Slack catch-up in disposable PostgreSQL", () => {
  let pool: pg.Pool;
  let store: PostgresLedgerStore;
  beforeAll(async () => {
    if (!databaseUrl?.includes("panini_e2e")) throw new Error("Disposable panini_e2e database required");
    pool = new pg.Pool({ connectionString: databaseUrl });
    await pool.query("INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
      [orgId, `slack-catchup-${orgId}`, "Slack Catchup E2E"]);
    store = new PostgresLedgerStore(databaseUrl, Buffer.alloc(32, 42).toString("base64"), orgId);
  });
  afterAll(async () => { await store?.close(); await pool?.end(); });

  it("captures newer top-level messages and replies to old roots only once", async () => {
    const cutoff = "2026-09-27T09:05:30.087Z";
    const oldTs = String(Date.parse("2026-09-25T00:00:00Z") / 1000);
    const newTs = String(Date.parse("2026-09-29T00:00:00Z") / 1000);
    const replyTs = String(Date.parse("2026-09-29T01:00:00Z") / 1000);
    const message = (ts: string, text: string, threadTs: string | null = null,
      replyCount = 0): SlackMessage => ({ channel: "C1", ts, threadTs,
      user: null, text, permalink: null, replyCount });
    const oldRoot = message(oldTs, "Old thread root", null, 1);
    const newRoot = message(newTs, "New top-level update");
    const reply = message(replyTs, "New reply on old root", oldTs);
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    const client = {
      async identifyWorkspace() { return { teamId: "T1", workspaceUrl: null }; },
      async getMessage() { return oldRoot; },
      async listMembers() { return { members: [], nextCursor: null }; },
      async listChannelMessages() { return { messages: [newRoot, oldRoot], nextCursor: null }; },
      async listThreadReplies() { return { messages: [oldRoot, reply], nextCursor: null }; },
    };
    const adapter = new SlackCaptureAdapter({ installationKey: "T1",
      channels: ["C1"], captureMode: "all_messages", captureReactions: [] },
    client, { record: (input) => store.appendSourceEvent(input) }, ledger);
    const first = await adapter.backfill({ occurredAfter: cutoff });
    expect(first).toMatchObject({ captured: 2, errors: [] });
    const second = await adapter.backfill({ occurredAfter: cutoff });
    expect(second).toMatchObject({ captured: 0, duplicates: 2, errors: [] });
    const rows = await pool.query<{ source_ref: string }>(
      "SELECT source_ref FROM source_events WHERE organization_id=$1 AND provider='slack' ORDER BY source_ref",
      [orgId]);
    expect(rows.rows.map((row) => row.source_ref)).toEqual([
      `slack:T1:C1:${newTs}`, `slack:T1:C1:${replyTs}`,
    ]);
    expect((await ledger.board()).tasks).toHaveLength(0);
  });

  it("preserves socket and history receipts but interprets their shared origin once", async () => {
    const marker = randomUUID();
    const ts = String(Date.parse("2026-09-29T03:00:00Z") / 1000);
    const text = `Importer progress ${marker}`;
    const message: SlackMessage = { channel: "C1", ts, threadTs: null,
      user: null, text, permalink: null };
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    const client = { async identifyWorkspace() { return { teamId: "T1", workspaceUrl: null }; },
      async getMessage() { return message; },
      async listMembers() { return { members: [], nextCursor: null }; },
      async listChannelMessages() { return { messages: [message], nextCursor: null }; },
      async listThreadReplies() { return { messages: [], nextCursor: null }; } };
    const adapter = new SlackCaptureAdapter({ installationKey: "T1", channels: ["C1"],
      captureMode: "all_messages", captureReactions: [] }, client,
    { record: (input) => store.appendSourceEvent(input) }, ledger);
    const socket = await adapter.handleEnvelope({ type: "events_api", envelope_id: marker,
      payload: { event_id: `socket-${marker}`, team_id: "T1",
        event: { type: "message", channel: "C1", ts, text } } }, () => {});
    expect(socket.outcome).toBe("captured");
    const backfill = await adapter.backfill({ occurredAfter: "2026-09-27T00:00:00.000Z" });
    expect(backfill).toMatchObject({ captured: 1, errors: [] });
    const events = (await pool.query<{ id: string; origin_observation_key: string }>(
      "SELECT id,origin_observation_key FROM source_events WHERE organization_id=$1 AND source_ref=$2 ORDER BY id",
      [orgId, `slack:T1:C1:${ts}`])).rows;
    expect(events).toHaveLength(2);
    expect(new Set(events.map((event) => event.origin_observation_key)).size).toBe(1);
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    let extractions = 0;
    const pipelineVersion = `socket-history-${marker}`;
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion,
      extractor: { name: "fixture-extractor", async extract({ events: selected }) {
        extractions += 1;
        return { claims: [], dispositions: selected.map((event) => ({ eventId: event.id,
          state: "no_claim" as const, claimOrdinals: [], reasonCode: "no_work" })) };
      } }, identityResolver: { async resolve() { throw new Error("No claim to resolve."); } } });
    const result = await pipeline.run({ eventIds: events.map((event) => event.id),
      budgetId: budget.id, evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    expect(result.processedEventIds).toHaveLength(1);
    expect(extractions).toBe(1);
    const dispositions = (await pool.query<{ state: string }>(
      "SELECT state FROM observation_dispositions WHERE organization_id=$1 AND pipeline_version=$2",
      [orgId, pipelineVersion])).rows.map((row) => row.state).sort();
    expect(dispositions).toEqual(["duplicate", "no_claim"]);
  });

  it("keeps late edits behind the current version and redacts derived claims after deletion", async () => {
    const marker = randomUUID();
    const ts = String(Date.parse("2026-10-01T00:00:00.000Z") / 1000);
    const sourceRef = `slack:T1:C1:${ts}`;
    const original = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
      providerEventId: `original-${marker}`, eventKind: "message.observed",
      occurredAt: "2026-10-01T00:00:00.000Z", fetchedAt: "2026-10-01T00:00:01.000Z",
      sourceRef, sourceUrl: null, contentHash: marker, visibility: "slack:channel:C1",
      payloadVersion: "slack-message-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: ts,
        text: "The logger repair is in progress." } })).event;
    const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
      autoApproveContext: false, requireReviewForTaskChanges: true }));
    const budget = await store.createInferenceBudget({ label: marker, maxCalls: 1,
      maxInputTokens: 1000, maxOutputTokens: 500, maxUsd: null,
      deadline: new Date(Date.now() + 60_000).toISOString(), priceBasis: null });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: `mutation-${marker}`,
      extractor: { name: "fixture-extractor", async extract() {
        return { claims: [{ schemaVersion: 1 as const, kind: "progress_report" as const,
          statement: "The logger repair is in progress.", subjectRefs: [], speakerMemberId: null,
          assertedField: "status", assertedValue: "in_progress", assertedAt: original.occurredAt,
          validFrom: null, validTo: null, temporalBasis: "relative_to_source" as const,
          spans: [{ eventId: original.id,
            originObservationKey: original.observationIdentity!.originObservationKey,
            sourceVersionKey: original.observationIdentity!.sourceVersionKey,
            locator: { kind: "text" as const, jsonPointer: "/text", startUtf16: 0,
              endUtf16: "The logger repair is in progress.".length,
              spanHash: createHash("sha256").update("The logger repair is in progress.").digest("hex") } }], derivedFromClaimIds: [],
          supersedesClaimIds: [], caveats: [] }],
        dispositions: [{ eventId: original.id, state: "extracted" as const,
          claimOrdinals: [0], reasonCode: null }] };
      } }, identityResolver: { async resolve() { return { relationship: "uncertain" as const,
        targetId: null, alternativeTargetIds: [], reasons: ["fixture"] }; } } });
    await pipeline.run({ eventIds: [original.id], budgetId: budget.id,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null });
    const activeClaimCount = async () => (await pool.query<{ count: string }>(`SELECT count(*)::text AS count
      FROM evidence_claims claim JOIN evidence_dependencies dep
        ON dep.organization_id=claim.organization_id AND dep.dependent_type='claim'
          AND dep.dependent_id=claim.id
      WHERE claim.organization_id=$1 AND claim.content_state='active'
        AND dep.source_event_id=$2`, [orgId, original.id])).rows[0]?.count;
    const originalClaimCount = await activeClaimCount();
    expect(originalClaimCount).toBe("1");
    const adapter = new SlackCaptureAdapter({ installationKey: "T1", channels: ["C1"],
      captureMode: "all_messages", captureReactions: [] },
    { async getMessage() { throw new Error("No fetch expected for mutation"); } },
    { record: (input) => store.appendSourceEvent(input) }, ledger);
    const mutation = async (eventId: string, eventTs: string, subtype: "message_changed" | "message_deleted",
      text?: string) => adapter.handleEnvelope({ type: "events_api", envelope_id: eventId,
        payload: { event_id: eventId, team_id: "T1", event: { type: "message", subtype,
          channel: "C1", event_ts: eventTs,
          ...(subtype === "message_deleted" ? { deleted_ts: ts }
            : { message: { ts, text: text ?? "" } }) } } }, () => {});
    const edit = await mutation(`edit-${marker}`, String(Date.parse("2026-10-01T02:00:00Z") / 1000),
      "message_changed", "The logger repair is blocked.");
    expect(edit.outcome).toBe("captured");
    expect((await store.getSourceEvents([original.id]))).toEqual([]);
    expect(await activeClaimCount()).toBe("0");
    const late = await mutation(`late-${marker}`, String(Date.parse("2026-10-01T01:00:00Z") / 1000),
      "message_changed", "A late old status.");
    expect(late).toMatchObject({ outcome: "captured", reason: expect.stringContaining("uncertain") });
    expect((await store.getLatestSourceEventBySourceRef("slack", "T1", sourceRef))?.id)
      .toBe(edit.eventId);
    const deletion = await mutation(`delete-${marker}`,
      String(Date.parse("2026-10-01T03:00:00Z") / 1000), "message_deleted");
    expect(deletion.outcome).toBe("captured");
    expect((await store.getSourceEvents([edit.eventId!, late.eventId!]))).toEqual([]);
    expect((await store.getLatestSourceEventBySourceRef("slack", "T1", sourceRef)))
      .toMatchObject({ id: deletion.eventId, eventKind: "message.deleted",
        payload: { deletionObserved: true } });
    const afterDelete = await mutation(`after-delete-${marker}`,
      String(Date.parse("2026-10-01T02:30:00Z") / 1000), "message_changed", "Stale text");
    expect(afterDelete.outcome).toBe("ignored");
    expect((await store.currentSourceEventIds([original.id, edit.eventId!, late.eventId!])))
      .toEqual([]);
  });
});
