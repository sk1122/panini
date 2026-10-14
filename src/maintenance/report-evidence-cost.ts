import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const replayPath = process.env.PANINI_REPLAY_REPORT;
const outputPath = process.env.PANINI_REPLAY_COST_REPORT;
if (!databaseUrl || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !replayPath || !outputPath) throw new Error("Isolated replay database and reports are required.");
const root = path.resolve("artifacts/evidence-state");
const source = path.resolve(replayPath);
const output = path.resolve(outputPath);
if (![source, output].every((file) => file.startsWith(`${root}${path.sep}`) && file.endsWith(".json"))) {
  throw new Error("Replay cost reports must be JSON under artifacts/evidence-state.");
}
const replay = JSON.parse(await readFile(source, "utf8")) as {
  database: string; organizationId: string; budgetId: string; stopReason: string | null;
  startedAt?: string; finishedAt?: string | null;
};
if (replay.database !== databaseName || !replay.organizationId || !replay.budgetId) {
  throw new Error("Replay report does not match the asserted database.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName) throw new Error("Cost report database assertion failed.");
  const budget = (await pool.query<{
    state: string; max_calls: string; max_input_tokens: string; max_output_tokens: string;
    max_usd: string; spent_calls: string; spent_input_tokens: string;
    spent_output_tokens: string; spent_usd: string; reserved_calls: string;
  }>(`SELECT state,max_calls,max_input_tokens,max_output_tokens,max_usd,spent_calls,
       spent_input_tokens,spent_output_tokens,spent_usd,reserved_calls
     FROM inference_budgets WHERE organization_id=$1 AND id=$2`,
  [replay.organizationId, replay.budgetId])).rows[0];
  if (!budget) throw new Error("Replay budget was not found.");
  const rows = (await pool.query<{
    purpose: string; calls: string; returned_input: string; returned_output: string;
    returned_cached_input: string; reserved_bound_calls: string;
    reserved_bound_input: string; reserved_bound_output: string;
    estimated_usd: string; unknown_calls: string;
  }>(`SELECT purpose,count(*)::text AS calls,
       coalesce(sum(input_tokens),0)::text AS returned_input,
       coalesce(sum(output_tokens),0)::text AS returned_output,
       coalesce(sum(cached_input_tokens),0)::text AS returned_cached_input,
       count(*) FILTER (WHERE error_code LIKE '%_reserved_bound')::text AS reserved_bound_calls,
       coalesce(sum(reserved_input_tokens) FILTER
         (WHERE error_code LIKE '%_reserved_bound'),0)::text AS reserved_bound_input,
       coalesce(sum(reserved_output_tokens) FILTER
         (WHERE error_code LIKE '%_reserved_bound'),0)::text AS reserved_bound_output,
       coalesce(sum(cost_usd),0)::text AS estimated_usd,
       count(*) FILTER (WHERE state='unknown' OR cost_basis='unknown')::text AS unknown_calls
     FROM model_calls WHERE organization_id=$1 AND budget_id=$2
     GROUP BY purpose ORDER BY purpose`, [replay.organizationId, replay.budgetId])).rows;
  const legacyRows = replay.startedAt && replay.finishedAt
    ? (await pool.query<{ purpose: string; calls: string; completed: string;
      returned_input: string; returned_output: string }>(
      `SELECT dispatched.details->>'purpose' AS purpose, count(*)::text AS calls,
          count(completed.id)::text AS completed,
          coalesce(sum((completed.details->>'returnedInputTokens')::bigint),0)::text AS returned_input,
          coalesce(sum((completed.details->>'returnedOutputTokens')::bigint),0)::text AS returned_output
         FROM audit_events dispatched LEFT JOIN LATERAL (
           SELECT id,details FROM audit_events completed
            WHERE completed.organization_id=dispatched.organization_id
              AND completed.action='external_call.completed'
              AND completed.target_id=dispatched.target_id
            ORDER BY completed.occurred_at DESC LIMIT 1
         ) completed ON true
         WHERE dispatched.organization_id=$1 AND dispatched.action='external_call.dispatched'
           AND dispatched.occurred_at >= $2::timestamptz
           AND dispatched.occurred_at <= $3::timestamptz
         GROUP BY dispatched.details->>'purpose' ORDER BY 1`,
      [replay.organizationId, replay.startedAt, replay.finishedAt],
    )).rows : [];
  const providerRows = replay.startedAt && replay.finishedAt
    ? (await pool.query<{ provider: string; purpose: string; calls: string;
      completed: string; unknown: string }>(
      `SELECT dispatched.details->>'provider' AS provider,
          dispatched.details->>'purpose' AS purpose,count(*)::text AS calls,
          count(*) FILTER (WHERE terminal.action='external_provider.completed')::text AS completed,
          count(*) FILTER (WHERE terminal.action IS NULL
            OR terminal.action='external_provider.unknown')::text AS unknown
         FROM audit_events dispatched LEFT JOIN LATERAL (
           SELECT action FROM audit_events terminal
            WHERE terminal.organization_id=dispatched.organization_id
              AND terminal.target_id=dispatched.target_id
              AND terminal.action IN ('external_provider.completed','external_provider.unknown')
            ORDER BY terminal.occurred_at DESC LIMIT 1
         ) terminal ON true
         WHERE dispatched.organization_id=$1 AND dispatched.action='external_provider.dispatched'
           AND dispatched.occurred_at >= $2::timestamptz
           AND dispatched.occurred_at <= $3::timestamptz
         GROUP BY dispatched.details->>'provider',dispatched.details->>'purpose'
         ORDER BY 1,2`,
      [replay.organizationId, replay.startedAt, replay.finishedAt],
    )).rows : [];
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId: replay.organizationId,
    budgetId: replay.budgetId, replayStopReason: replay.stopReason,
    budget: { state: budget.state, maxCalls: Number(budget.max_calls),
      maxInputTokens: Number(budget.max_input_tokens), maxOutputTokens: Number(budget.max_output_tokens),
      maxEstimatedUsd: budget.max_usd, spentCalls: Number(budget.spent_calls),
      spentInputTokens: Number(budget.spent_input_tokens),
      spentOutputTokens: Number(budget.spent_output_tokens), spentEstimatedUsd: budget.spent_usd,
      reservedCalls: Number(budget.reserved_calls) },
    purposes: rows.map((row) => ({ purpose: row.purpose, calls: Number(row.calls),
      providerReturnedInputTokens: Number(row.returned_input),
      providerReturnedOutputTokens: Number(row.returned_output),
      providerReturnedCachedInputTokens: Number(row.returned_cached_input),
      reservedBoundCalls: Number(row.reserved_bound_calls),
      reservedBoundInputTokens: Number(row.reserved_bound_input),
      reservedBoundOutputTokens: Number(row.reserved_bound_output),
      estimatedUsd: row.estimated_usd, unknownCalls: Number(row.unknown_calls) })),
    legacyAdapters: legacyRows.map((row) => ({ purpose: row.purpose,
      calls: Number(row.calls), completed: Number(row.completed),
      returnedInputTokens: Number(row.returned_input),
      returnedOutputTokens: Number(row.returned_output),
      unknownCostCalls: Number(row.calls) })),
    providerApiCalls: providerRows.map((row) => ({ provider: row.provider,
      purpose: row.purpose, calls: Number(row.calls), completed: Number(row.completed),
      unknown: Number(row.unknown), costUsd: null })),
    costComplete: false, savingsClaimAllowed: false,
    excluded: ["Legacy and provider calls before audit metering was installed"],
    interpretation: "USD is an estimate from the frozen price basis, not a provider bill. Reserved-bound charges are conservative accounting for calls with unknown provider usage." };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temporary, output);
  console.log(JSON.stringify({ report: output, state: budget.state,
    spentCalls: report.budget.spentCalls, reservedCalls: report.budget.reservedCalls }));
} finally { await pool.end(); }
