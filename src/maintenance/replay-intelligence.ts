import { createPaniniCore } from "../runtime/core.js";
import { ExternalEvaluationLimiter } from "../intelligence/external-call-meter.js";
import { randomUUID } from "node:crypto";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { acceptedProjectionDiff, acceptedProjectionSnapshot } from "./accepted-projection-diff.js";

function positiveInteger(name: string, fallback: number): number {
  const raw = process.argv.find((argument) => argument.startsWith(`--${name}=`))?.split("=", 2)[1];
  const value = raw === undefined ? fallback : Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`--${name} must be a positive integer.`);
  return value;
}

const maxRuns = positiveInteger("max-runs", 250);
const maxInputTokens = positiveInteger("max-input-tokens", 2_000_000);
const maxOutputTokens = positiveInteger("max-output-tokens", 500_000);
const maxCalls = positiveInteger("max-calls", 0);
const maxWallSeconds = positiveInteger("max-wall-seconds", 0);
const expectedDatabase = process.env.PANINI_REPLAY_DATABASE;
const reportPath = process.env.PANINI_LEGACY_REPLAY_REPORT;
if (!process.env.DATABASE_URL || !expectedDatabase
  || !/^panini_replay_[a-z0-9_]+$/.test(expectedDatabase) || !reportPath) {
  throw new Error("Legacy evaluation requires an asserted isolated replay database and report path.");
}
const output = path.resolve(reportPath);
const artifactRoot = path.resolve("artifacts/evidence-state");
if (!output.startsWith(`${artifactRoot}${path.sep}`) || !output.endsWith(".json")) {
  throw new Error("Legacy replay report must be JSON under artifacts/evidence-state.");
}
const coverageAsOf = process.argv.find((argument) => argument.startsWith("--coverage-as-of="))?.slice("--coverage-as-of=".length);
if (!coverageAsOf || !Number.isFinite(new Date(coverageAsOf).getTime())) {
  throw new Error("--coverage-as-of=<ISO timestamp> is required for a historical replay.");
}
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const guard = await pool.connect();
try {
  const database = (await guard.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Legacy evaluation database assertion failed.");
  const locked = (await guard.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('panini_legacy_replay'), hashtext(current_database())) AS locked",
  )).rows[0]?.locked;
  if (!locked) throw new Error("A legacy evaluation is already running in this database.");
} catch (error) {
  guard.release();
  await pool.end();
  throw error;
}
const limiter = new ExternalEvaluationLimiter({ maxCalls, maxInputTokens,
  maxOutputTokens, maxWallSeconds });
const evaluationRunId = randomUUID();
const core = await createPaniniCore({ runMigrations: false, coverageAsOf,
  externalEvaluationLimiter: limiter,
  externalEvaluationRunId: evaluationRunId }).catch(async (error: unknown) => {
  guard.release();
  await pool.end();
  throw error;
});
if (!core.intelligence.isConfigured()) {
  await core.store.close();
  guard.release();
  await pool.end();
  throw new Error("Evidence intelligence is not configured.");
}
const [acceptedBefore, organization] = await Promise.all([
  acceptedProjectionSnapshot(core.store), core.store.getOrganization(),
]).catch(async (error: unknown) => {
  await core.store.close();
  guard.release();
  await pool.end();
  throw error;
});
const organizationId = organization.id;

let runs = 0;
let events = 0;
let inputTokens = 0;
let cachedInputTokens = 0;
let outputTokens = 0;
let stopReason = "max_runs";
const startedAt = new Date().toISOString();
const runIds: string[] = [];

try {
  while (runs < maxRuns) {
    if (inputTokens >= maxInputTokens) { stopReason = "input_token_limit"; break; }
    if (outputTokens >= maxOutputTokens) { stopReason = "output_token_limit"; break; }
    const report = await core.intelligence.run();
    if (report.state === "no_evidence") { stopReason = "no_evidence"; break; }
    runs += 1;
    if (report.id) runIds.push(report.id);
    events += report.eventIds.length;
    inputTokens += report.usage?.inputTokens ?? 0;
    cachedInputTokens += report.usage?.cachedInputTokens ?? 0;
    outputTokens += report.usage?.outputTokens ?? 0;
    console.log(JSON.stringify({ type: "intelligence_replay_run", run: runs, runId: report.id,
      eventCount: report.eventIds.length,
      usage: report.usage, cumulativeUsage: { inputTokens, cachedInputTokens, outputTokens } }));
    if (limiter.snapshot().stopped) { stopReason = "unknown_usage_or_call_limit"; break; }
  }
} catch (error) {
  stopReason = "legacy_evaluation_failed";
  process.exitCode = 1;
  console.error(JSON.stringify({ type: "legacy_evaluation_error",
    errorType: error instanceof Error ? error.name : "unknown" }));
} finally {
  try {
    const completion = { schemaVersion: 1, mode: "baseline_historical_unmatched",
      database: expectedDatabase, organizationId, evaluationRunId,
      startedAt, finishedAt: new Date().toISOString(),
      coverageAsOf, stopReason, runs, events, runIds,
      usage: { inputTokens, cachedInputTokens, outputTokens },
      limits: { maxRuns, maxCalls, maxInputTokens, maxOutputTokens, maxWallSeconds },
      externalCalls: limiter.snapshot(), costComplete: false,
      acceptedProjectionChange: acceptedProjectionDiff(acceptedBefore,
        await acceptedProjectionSnapshot(core.store)) };
    await mkdir(path.dirname(output), { recursive: true });
    const temporary = `${output}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(completion, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, output);
    console.log(JSON.stringify({ type: "intelligence_replay_complete", report: output,
      stopReason, runs, events, costComplete: false }));
  } finally {
    try {
      await core.store.close();
    } finally {
      try {
        await guard.query(
          "SELECT pg_advisory_unlock(hashtext('panini_legacy_replay'), hashtext(current_database()))",
        );
      } finally {
        guard.release();
        await pool.end();
      }
    }
  }
}
