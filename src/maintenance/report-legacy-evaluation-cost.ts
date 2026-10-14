import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.PANINI_REPLAY_DATABASE;
const inputPath = process.env.PANINI_LEGACY_REPLAY_REPORT;
const outputPath = process.env.PANINI_LEGACY_COST_REPORT;
if (!databaseUrl || !expectedDatabase || !/^panini_replay_[a-z0-9_]+$/.test(expectedDatabase)
  || !inputPath || !outputPath) {
  throw new Error("Legacy cost reporting requires an isolated replay database and both report paths.");
}
const root = path.resolve("artifacts/evidence-state");
const checked = (value: string) => {
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error("Legacy cost reports must be JSON under artifacts/evidence-state.");
  }
  return resolved;
};
const source = checked(inputPath);
const output = checked(outputPath);
if (source === output) throw new Error("Legacy cost input and output must differ.");
const replay = JSON.parse(await readFile(source, "utf8")) as {
  database: string; organizationId: string; evaluationRunId: string;
  startedAt: string; finishedAt: string;
  stopReason: string; externalCalls: { calls: number };
};
if (replay.database !== expectedDatabase || !/^[0-9a-f-]{36}$/i.test(replay.organizationId)
  || !/^[0-9a-f-]{36}$/i.test(replay.evaluationRunId)
  || !Number.isFinite(Date.parse(replay.startedAt))
  || !Number.isFinite(Date.parse(replay.finishedAt))
  || replay.startedAt > replay.finishedAt) {
  throw new Error("Legacy replay report does not match this target or time window.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const database = (await pool.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Legacy cost database assertion failed.");
  const rows = (await pool.query<{
    call_id: string; provider: string; purpose: string; model: string; request_bytes: string;
    state: string | null; returned_input: string | null; returned_output: string | null;
    returned_total: string | null; http_status: string | null; returned_cost: string | null;
  }>(`SELECT dispatched.target_id AS call_id,
       dispatched.details->>'provider' AS provider,
       dispatched.details->>'purpose' AS purpose,
       dispatched.details->>'model' AS model,
       dispatched.details->>'requestBytes' AS request_bytes,
       terminal.action AS state,
       terminal.details->>'returnedInputTokens' AS returned_input,
       terminal.details->>'returnedOutputTokens' AS returned_output,
       terminal.details->>'returnedTotalTokens' AS returned_total,
       terminal.details->>'costUsd' AS returned_cost,
       terminal.details->>'httpStatus' AS http_status
     FROM audit_events dispatched LEFT JOIN LATERAL (
       SELECT action,details FROM audit_events event
        WHERE event.organization_id=dispatched.organization_id
          AND event.target_id=dispatched.target_id
          AND event.action IN ('external_call.completed','external_call.unknown')
        ORDER BY event.occurred_at DESC,event.id DESC LIMIT 1
     ) terminal ON true
     WHERE dispatched.organization_id=$1 AND dispatched.action='external_call.dispatched'
       AND dispatched.occurred_at >= $2::timestamptz
       AND dispatched.occurred_at <= $3::timestamptz
       AND dispatched.details->>'evaluationRunId'=$4
     ORDER BY dispatched.occurred_at,dispatched.id`,
  [replay.organizationId, replay.startedAt, replay.finishedAt,
    replay.evaluationRunId])).rows;
  const calls = rows.map((row) => ({ id: row.call_id, provider: row.provider,
    purpose: row.purpose, model: row.model,
    requestBytes: Number(row.request_bytes),
    state: row.state ?? "external_call.dispatched",
    returnedInputTokens: row.returned_input === null ? null : Number(row.returned_input),
    returnedOutputTokens: row.returned_output === null ? null : Number(row.returned_output),
    returnedTotalTokens: row.returned_total === null ? null : Number(row.returned_total),
    httpStatus: row.http_status === null ? null : Number(row.http_status),
    providerCostUsd: row.returned_cost === null ? null : Number(row.returned_cost) }));
  const purposes = [...new Set(calls.map((call) => call.purpose))].sort().map((purpose) => {
    const selected = calls.filter((call) => call.purpose === purpose);
    return { purpose, calls: selected.length,
      completed: selected.filter((call) => call.state === "external_call.completed").length,
      unknownUsage: selected.filter((call) => call.returnedInputTokens === null
        || call.returnedOutputTokens === null).length,
      knownProviderCostUsd: selected.reduce((sum, call) => sum + (call.providerCostUsd ?? 0), 0),
      unknownCostCalls: selected.filter((call) => call.providerCostUsd === null).length,
      returnedInputTokens: selected.reduce((sum, call) => sum + (call.returnedInputTokens ?? 0), 0),
      returnedOutputTokens: selected.reduce((sum, call) => sum + (call.returnedOutputTokens ?? 0), 0) };
  });
  const unrecordedCalls = Math.max(0, replay.externalCalls.calls - calls.length);
  const costComplete = unrecordedCalls === 0 && calls.every((call) =>
    call.state === "external_call.completed" && call.providerCostUsd !== null);
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database, organizationId: replay.organizationId,
    evaluationRunId: replay.evaluationRunId,
    replayReport: source, replayStopReason: replay.stopReason,
    auditCalls: calls.length, limiterCalls: replay.externalCalls.calls,
    unrecordedCalls,
    purposes, calls, providerReturnedCostUsd: calls.reduce((sum, call) =>
      sum + (call.providerCostUsd ?? 0), 0),
    unknownCostCalls: calls.filter((call) => call.providerCostUsd === null).length,
    costUsd: costComplete ? calls.reduce((sum, call) => sum + call.providerCostUsd!, 0) : null,
    costComplete,
    limitation: "Provider-returned cost is a request ledger, not a reconciled provider bill; unknown calls prevent a complete savings claim." };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(`${JSON.stringify({ report: output, calls: calls.length,
    unrecordedCalls: report.unrecordedCalls, costComplete })}\n`);
} finally { await pool.end(); }
