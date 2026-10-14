import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const replayPath = process.env.PANINI_REPLAY_REPORT;
const auditPath = process.env.PANINI_REPLAY_AUDIT;
const outputPath = process.env.PANINI_REPAIR_REPORT;
if (!databaseUrl || databaseName !== "panini_replay_20261001"
  || !replayPath || !auditPath || !outputPath) {
  throw new Error("The exact isolated replay database and three reports are required.");
}
const root = path.resolve("artifacts/evidence-state");
const checked = (value: string) => {
  const file = path.resolve(value);
  if (!file.startsWith(`${root}${path.sep}`) || !file.endsWith(".json")) {
    throw new Error("Repair reports must be JSON under artifacts/evidence-state.");
  }
  return file;
};
const replayFile = checked(replayPath);
const auditFile = checked(auditPath);
const output = checked(outputPath);
if (new Set([replayFile, auditFile, output]).size !== 3) throw new Error("Repair reports must be distinct.");
const replay = JSON.parse(await readFile(replayFile, "utf8")) as {
  database: string; organizationId: string; runId: string; inputFingerprint: string;
  selectedEvents: number; nextEpisode: number; totalEpisodes: number; stopReason: string;
};
const audit = JSON.parse(await readFile(auditFile, "utf8")) as {
  database: string; organizationId: string; selectedReceipts: number;
  sourceStopReason: string; unresolvedReceiptIds: string[];
};
if (replay.database !== databaseName || audit.database !== databaseName
  || replay.organizationId !== audit.organizationId || replay.stopReason !== "completed"
  || replay.nextEpisode !== replay.totalEpisodes
  || audit.sourceStopReason !== "completed" || audit.selectedReceipts !== replay.selectedEvents
  || !Array.isArray(audit.unresolvedReceiptIds)) {
  throw new Error("Completed frozen replay and matching coverage audit are required.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
// This repair calls only source/disposition SQL methods and never decrypts content.
const store = new PostgresLedgerStore(databaseUrl, Buffer.alloc(32).toString("base64"), replay.organizationId);
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName) throw new Error("Repair database assertion failed.");
  const rows = (await pool.query<{ id: string; origin_observation_key: string;
    source_version_key: string; canonical_event_id: string | null;
    canonical_state: string | null; canonical_version_key: string | null }>(
    `SELECT se.id,se.origin_observation_key,se.source_version_key,
       prior.source_event_id AS canonical_event_id,prior.state AS canonical_state,
       canonical.source_version_key AS canonical_version_key
      FROM source_events se
      LEFT JOIN LATERAL (
        SELECT d.source_event_id,d.state FROM observation_dispositions d
        WHERE d.organization_id=se.organization_id
          AND d.origin_observation_key=se.origin_observation_key
          AND d.pipeline_version='evidence-v2-20261001' AND d.state<>'duplicate'
        ORDER BY d.attempt DESC,d.created_at DESC LIMIT 1
      ) prior ON true
      LEFT JOIN source_events canonical ON canonical.id=prior.source_event_id
      WHERE se.organization_id=$1 AND se.id=ANY($2::uuid[])
        AND se.content_state='active'
        AND NOT EXISTS (SELECT 1 FROM observation_dispositions d
          WHERE d.organization_id=se.organization_id AND d.source_event_id=se.id
            AND d.pipeline_version='evidence-v2-20261001')
      ORDER BY se.id`,
    [replay.organizationId, audit.unresolvedReceiptIds],
  )).rows;
  if (rows.some((row) => !row.origin_observation_key || !row.source_version_key
    || !row.canonical_event_id || row.canonical_event_id === row.id
    || row.canonical_version_key !== row.source_version_key
    || !row.canonical_state || ["processing", "pending", "duplicate"].includes(row.canonical_state))) {
    throw new Error("A missing receipt is not a settled duplicate of the same source version.");
  }
  const acceptedBefore = contentHash((await pool.query(
    "SELECT id,version,document FROM tasks WHERE organization_id=$1 ORDER BY id",
    [replay.organizationId],
  )).rows);
  const callsBefore = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM model_calls WHERE organization_id=$1",
    [replay.organizationId],
  )).rows[0]?.n ?? 0);
  let repaired = 0;
  for (const row of rows) {
    const result = await store.claimObservation({ eventId: row.id,
      pipelineVersion: "evidence-v2-20261001", workerId: "isolated-duplicate-repair",
      leaseSeconds: 60, now: new Date().toISOString() });
    if (result.kind === "claimed") {
      await store.failObservationClaims({ leases: [{ dispositionId: result.disposition.id,
        attempt: result.disposition.attempt, owner: "isolated-duplicate-repair" }],
        runId: null, reasonCode: "duplicate_repair_preflight_mismatch" });
    }
    if (result.kind !== "duplicate" && result.kind !== "terminal") {
      throw new Error("A preflighted duplicate could not be settled safely.");
    }
    repaired += Number(result.kind === "duplicate");
  }
  const after = (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM source_events se WHERE se.organization_id=$1
      AND se.id=ANY($2::uuid[]) AND NOT EXISTS (SELECT 1 FROM observation_dispositions d
        WHERE d.organization_id=se.organization_id AND d.source_event_id=se.id
          AND d.pipeline_version='evidence-v2-20261001')`,
    [replay.organizationId, rows.map((row) => row.id)],
  )).rows[0];
  const acceptedAfter = contentHash((await pool.query(
    "SELECT id,version,document FROM tasks WHERE organization_id=$1 ORDER BY id",
    [replay.organizationId],
  )).rows);
  const callsAfter = Number((await pool.query<{ n: string }>(
    "SELECT count(*)::text AS n FROM model_calls WHERE organization_id=$1",
    [replay.organizationId],
  )).rows[0]?.n ?? 0);
  if (acceptedBefore !== acceptedAfter || callsBefore !== callsAfter) {
    throw new Error("Duplicate repair unexpectedly changed accepted tasks or model calls.");
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: actual, organizationId: replay.organizationId,
    sourceReplayFingerprint: contentHash({ runId: replay.runId,
      inputFingerprint: replay.inputFingerprint }),
    missingDuplicateReceiptsBefore: rows.length, repaired,
    missingDuplicateReceiptsAfter: Number(after?.n ?? 0), modelCalls: callsAfter - callsBefore,
    acceptedStateChanged: acceptedBefore !== acceptedAfter,
    interpretation: "Only receipt transport duplicates of an already recorded canonical source version were marked duplicate. Partial canonical extraction remains unresolved." };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temporary, output);
  console.log(JSON.stringify({ report: output, missingBefore: rows.length,
    repaired, missingAfter: report.missingDuplicateReceiptsAfter }));
} finally { await store.close(); await pool.end(); }
