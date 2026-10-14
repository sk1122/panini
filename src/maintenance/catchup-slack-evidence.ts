import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";
import { SlackCaptureAdapter, SlackWebApiClient } from "../connectors/slack/socket-mode.js";
import { contentHash } from "../domain/content-hash.js";
import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const organizationId = process.env.PANINI_REPLAY_ORGANIZATION;
const key = process.env.CONTENT_ENCRYPTION_KEY;
const token = process.env.SLACK_BOT_TOKEN;
const cutoff = process.env.PANINI_CATCHUP_CUTOFF;
const replayPath = process.env.PANINI_REPLAY_REPORT;
const outputPath = process.env.PANINI_CATCHUP_REPORT;
if (!databaseUrl || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !organizationId || !key || !token || !cutoff || !Number.isFinite(Date.parse(cutoff))
  || !replayPath || !outputPath) {
  throw new Error("Isolated replay database, credentials, cutoff, and reports are required.");
}
const root = path.resolve("artifacts/evidence-state");
const replayFile = path.resolve(replayPath);
const output = path.resolve(outputPath);
if (![replayFile, output].every((file) => file.startsWith(`${root}${path.sep}`)
  && file.endsWith(".json"))) throw new Error("Reports must be JSON under artifacts/evidence-state.");
const replay = JSON.parse(await readFile(replayFile, "utf8")) as {
  database: string; organizationId: string; stopReason: string | null; finishedAt: string | null;
};
if (replay.database !== databaseName || replay.organizationId !== organizationId
  || !replay.stopReason || !replay.finishedAt) {
  throw new Error("Source reinterpretation must be stopped at a persisted checkpoint before catch-up.");
}
const config = await loadConfig();
if (!config.app.slack?.enabled || config.app.slack.captureMode !== "all_messages"
  || config.app.slack.channels.length === 0) throw new Error("Slack all-message allowlist is required.");
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, key, organizationId);
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName) throw new Error("Catch-up database assertion failed.");
  const before = await pool.query<{ total: string; after_cutoff: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE occurred_at>$2::timestamptz)::text AS after_cutoff
       FROM source_events WHERE organization_id=$1 AND provider='slack'`,
    [organizationId, cutoff]);
  const beforeIds = new Set((await pool.query<{ id: string }>(
    "SELECT id FROM source_events WHERE organization_id=$1 AND provider='slack'",
    [organizationId],
  )).rows.map((row) => row.id));
  const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
    autoApproveContext: false, requireReviewForTaskChanges: true }));
  const tasksBefore = contentHash((await store.listTasks()).map((task) =>
    [task.id, task.version, task.status, task.result ?? "unknown"]));
  const adapter = new SlackCaptureAdapter(config.app.slack,
    new SlackWebApiClient(token), { record: (input) => store.appendSourceEvent(input) }, ledger);
  const outcome = await adapter.backfill({ occurredAfter: cutoff });
  const after = await pool.query<{ total: string; after_cutoff: string }>(
    `SELECT count(*)::text AS total,
       count(*) FILTER (WHERE occurred_at>$2::timestamptz)::text AS after_cutoff
       FROM source_events WHERE organization_id=$1 AND provider='slack'`,
    [organizationId, cutoff]);
  const newReceiptIds = (await pool.query<{ id: string }>(
    "SELECT id FROM source_events WHERE organization_id=$1 AND provider='slack'",
    [organizationId],
  )).rows.map((row) => row.id).filter((id) => !beforeIds.has(id)).sort();
  const tasksAfter = contentHash((await store.listTasks()).map((task) =>
    [task.id, task.version, task.status, task.result ?? "unknown"]));
  if (tasksBefore !== tasksAfter) throw new Error("Source catch-up unexpectedly changed accepted tasks.");
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId, cutoff, sourceReplayStopReason: replay.stopReason,
    slackReceiptsBefore: Number(before.rows[0]?.total ?? 0),
    slackReceiptsAfter: Number(after.rows[0]?.total ?? 0),
    afterCutoffBefore: Number(before.rows[0]?.after_cutoff ?? 0),
    afterCutoffAfter: Number(after.rows[0]?.after_cutoff ?? 0),
    captured: outcome.captured, duplicates: outcome.duplicates, ignored: outcome.ignored,
    newReceiptIds,
    fetched: outcome.fetched, errors: outcome.errors,
    acceptedTaskProjectionUnchanged: tasksBefore === tasksAfter,
    interpretation: "Captured new source receipts in the isolated database; no model interpretation or accepted task update was run." };
  await mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temp, output);
  console.log(JSON.stringify({ report: output, captured: outcome.captured,
    duplicates: outcome.duplicates, errors: outcome.errors.length }));
} finally { await store.close(); await pool.end(); }
