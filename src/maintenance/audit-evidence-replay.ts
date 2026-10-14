import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const outputPath = process.env.PANINI_REPLAY_AUDIT;
const sourceReportPath = process.env.PANINI_REPLAY_REPORT;
const sourceIdsPath = process.env.PANINI_REPLAY_SOURCE_IDS_REPORT;
const excludedIdsPath = process.env.PANINI_REPLAY_EXCLUDE_SOURCE_IDS_REPORT;
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",")
  .map((item) => item.trim()).filter(Boolean);
if (!databaseUrl || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !outputPath || !sourceReportPath || !allowed.length) {
  throw new Error("An isolated replay database, visibility list, and report are required.");
}
const root = path.resolve("artifacts/evidence-state");
const reportFile = path.resolve(outputPath);
const sourceFile = path.resolve(sourceReportPath);
if (!reportFile.startsWith(`${root}${path.sep}`) || !reportFile.endsWith(".json")
  || !sourceFile.startsWith(`${root}${path.sep}`) || !sourceFile.endsWith(".json")
  || sourceFile === reportFile) {
  throw new Error("Replay audit must be JSON under artifacts/evidence-state.");
}
const sourceReport = JSON.parse(await readFile(sourceFile, "utf8")) as {
  database: string; organizationId: string; selectedEvents: number;
  inputFingerprint: string; stopReason: string | null; pipelineVersion: string;
};
if (sourceReport.database !== databaseName || !Number.isSafeInteger(sourceReport.selectedEvents)
  || sourceReport.selectedEvents < 1) throw new Error("Source replay report is invalid.");
const sourceIdsFile = sourceIdsPath ? path.resolve(sourceIdsPath) : null;
if (sourceIdsFile && (!sourceIdsFile.startsWith(`${root}${path.sep}`)
  || !sourceIdsFile.endsWith(".json") || sourceIdsFile === reportFile)) {
  throw new Error("Source IDs report must be a distinct JSON artifact under artifacts/evidence-state.");
}
const sourceIdsReport = sourceIdsFile
  ? JSON.parse(await readFile(sourceIdsFile, "utf8")) as {
      database: string; organizationId: string; newReceiptIds: string[];
    } : null;
if (sourceIdsReport && (sourceIdsReport.database !== databaseName
  || sourceIdsReport.organizationId !== sourceReport.organizationId
  || !Array.isArray(sourceIdsReport.newReceiptIds)
  || sourceIdsReport.newReceiptIds.length !== sourceReport.selectedEvents
  || new Set(sourceIdsReport.newReceiptIds).size !== sourceIdsReport.newReceiptIds.length)) {
  throw new Error("Source IDs report does not match this replay.");
}
const excludedIdsFile = excludedIdsPath ? path.resolve(excludedIdsPath) : null;
if (excludedIdsFile && (!excludedIdsFile.startsWith(`${root}${path.sep}`)
  || !excludedIdsFile.endsWith(".json") || excludedIdsFile === reportFile
  || excludedIdsFile === sourceFile || excludedIdsFile === sourceIdsFile)) {
  throw new Error("Excluded source IDs report must be a distinct JSON artifact under artifacts/evidence-state.");
}
const excludedIdsReport = excludedIdsFile
  ? JSON.parse(await readFile(excludedIdsFile, "utf8")) as {
      database: string; organizationId: string; newReceiptIds: string[];
    } : null;
if (excludedIdsReport && (sourceIdsReport
  || excludedIdsReport.database !== databaseName
  || excludedIdsReport.organizationId !== sourceReport.organizationId
  || !Array.isArray(excludedIdsReport.newReceiptIds)
  || new Set(excludedIdsReport.newReceiptIds).size !== excludedIdsReport.newReceiptIds.length)) {
  throw new Error("Excluded source IDs report does not match the base replay.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const database = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (database !== databaseName) throw new Error("Replay audit database assertion failed.");
  const organizationId = (await pool.query<{ id: string }>(
    "SELECT id FROM organizations WHERE id=$1", [sourceReport.organizationId],
  )).rows[0]?.id;
  if (!organizationId) throw new Error("Replay organization was not found.");
  const sources = (await pool.query<{ id: string; provider: string; visibility: string;
    occurred_at: Date; fetched_at: Date; source_version_key: string | null }>(
    `SELECT se.id,se.provider,se.visibility,se.occurred_at,se.fetched_at,se.source_version_key
       FROM source_events se JOIN source_event_contents sec
         ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
      WHERE se.organization_id=$1 AND se.content_state='active'`, [organizationId],
  )).rows.filter((row) => allowed.includes(row.visibility))
    .sort((left, right) => left.occurred_at.getTime() - right.occurred_at.getTime()
      || left.id.localeCompare(right.id));
  const selectedIdsFilter = sourceIdsReport ? new Set(sourceIdsReport.newReceiptIds) : null;
  const excludedIds = new Set(excludedIdsReport?.newReceiptIds ?? []);
  const selected = selectedIdsFilter
    ? sources.filter((row) => selectedIdsFilter.has(row.id))
    : sources.filter((row) => !excludedIds.has(row.id)).slice(0, sourceReport.selectedEvents);
  const selectedIds = selected.map((row) => row.id);
  const selectedFingerprint = contentHash(selected.map((row) => [row.id,
    row.source_version_key ?? null]));
  if (selected.length !== sourceReport.selectedEvents || selectedFingerprint !== sourceReport.inputFingerprint) {
    throw new Error(`Replay input fingerprint changed before the coverage audit: count=${selected.length}, fingerprint=${selectedFingerprint}.`);
  }
  const latest = (await pool.query<{ source_event_id: string; state: string;
    reason_code: string | null; attempt: number }>(
    `SELECT DISTINCT ON (source_event_id) source_event_id,state,reason_code,attempt
       FROM observation_dispositions WHERE organization_id=$1 AND pipeline_version=$3
         AND source_event_id=ANY($2::uuid[]) ORDER BY source_event_id,attempt DESC,created_at DESC`,
    [organizationId, selectedIds, sourceReport.pipelineVersion],
  )).rows;
  const latestById = new Map(latest.map((row) => [row.source_event_id, row]));
  const dispositionCounts: Record<string, number> = {};
  const unresolvedIds: string[] = [];
  for (const source of selected) {
    const state = latestById.get(source.id)?.state ?? "missing";
    dispositionCounts[state] = (dispositionCounts[state] ?? 0) + 1;
    if (["missing", "pending", "processing", "failed", "partial", "unresolved"].includes(state)) {
      unresolvedIds.push(source.id);
    }
  }
  const providerFreshness = Object.fromEntries([...new Set(selected.map((row) => row.provider))]
    .sort().map((provider) => {
      const rows = selected.filter((row) => row.provider === provider);
      return [provider, { selectedReceipts: rows.length,
        latestOccurredAt: new Date(Math.max(...rows.map((row) => row.occurred_at.getTime()))).toISOString(),
        latestFetchedAt: new Date(Math.max(...rows.map((row) => row.fetched_at.getTime()))).toISOString() }];
    }));
  const claimKinds = (await pool.query<{ kind: string; n: string }>(
    `SELECT kind,count(*)::text AS n FROM evidence_claims
      WHERE organization_id=$1 AND content_state='active' GROUP BY kind ORDER BY kind`, [organizationId],
  )).rows;
  const assessments = (await pool.query<{ target_type: string; relationship: string;
    disposition: string; n: string }>(
    `SELECT target_type,relationship,disposition,count(*)::text AS n FROM evidence_assessments
      WHERE organization_id=$1 AND content_state='active'
      GROUP BY target_type,relationship,disposition ORDER BY target_type,relationship,disposition`,
    [organizationId],
  )).rows;
  const proposals = (await pool.query<{ state: string; n: string }>(
    `SELECT state,count(*)::text AS n FROM proposals WHERE organization_id=$1
      AND assessment_id IS NOT NULL GROUP BY state ORDER BY state`, [organizationId],
  )).rows;
  const taskStatuses = (await pool.query<{ status: string; n: string }>(
    `SELECT document->>'status' AS status,count(*)::text AS n FROM tasks
      WHERE organization_id=$1 GROUP BY document->>'status' ORDER BY status`, [organizationId],
  )).rows;
  const unassessedCompletions = (await pool.query<{ id: string }>(
    `SELECT c.id FROM evidence_claims c WHERE c.organization_id=$1
      AND c.kind='completion_report' AND c.content_state='active'
      AND NOT EXISTS (SELECT 1 FROM evidence_assessments a WHERE a.organization_id=c.organization_id
        AND a.content_state='active' AND c.id=ANY(a.claim_ids)) ORDER BY c.id`, [organizationId],
  )).rows.map((row) => row.id);
  const failedRunsWithClaims = (await pool.query<{ run_id: string; n: string }>(
    `SELECT r.id AS run_id,count(c.id)::text AS n FROM interpretation_runs r
      JOIN evidence_claims c ON c.extraction_run_id=r.id
      WHERE r.organization_id=$1 AND r.schema_version=2 AND r.state='failed'
      GROUP BY r.id ORDER BY r.id`, [organizationId],
  )).rows;
  const usage = (await pool.query<{ purpose: string; state: string; calls: string;
    input_tokens: string; output_tokens: string; estimated_usd: string; unknown_calls: string }>(
    `SELECT purpose,state,count(*)::text AS calls,coalesce(sum(input_tokens),0)::text AS input_tokens,
      coalesce(sum(output_tokens),0)::text AS output_tokens,
      coalesce(sum(cost_usd),0)::text AS estimated_usd,
      count(*) FILTER (WHERE cost_basis='unknown' OR state='unknown')::text AS unknown_calls
      FROM model_calls WHERE organization_id=$1 GROUP BY purpose,state ORDER BY purpose,state`,
    [organizationId],
  )).rows;
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId, sourceStopReason: sourceReport.stopReason,
    selectedReceipts: selected.length,
    selectedFingerprint: contentHash(selectedIds), providerFreshness, dispositionCounts,
    unresolvedReceiptCount: unresolvedIds.length, unresolvedReceiptIds: unresolvedIds,
    claimKinds: Object.fromEntries(claimKinds.map((row) => [row.kind, Number(row.n)])),
    assessments: assessments.map((row) => ({ ...row, n: Number(row.n) })),
    proposals: Object.fromEntries(proposals.map((row) => [row.state, Number(row.n)])),
    acceptedTaskStatuses: Object.fromEntries(taskStatuses.map((row) => [row.status, Number(row.n)])),
    unassessedCompletionCount: unassessedCompletions.length,
    unassessedCompletionClaimIds: unassessedCompletions,
    failedRunsWithClaims: failedRunsWithClaims.map((row) => ({ ...row, n: Number(row.n) })),
    modelUsage: usage.map((row) => ({ ...row, calls: Number(row.calls),
      inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens),
      unknownCalls: Number(row.unknown_calls) })) };
  await mkdir(path.dirname(reportFile), { recursive: true });
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temporary, reportFile);
  console.log(JSON.stringify({ report: reportFile, selectedReceipts: report.selectedReceipts,
    unresolvedReceiptCount: report.unresolvedReceiptCount,
    unassessedCompletionCount: report.unassessedCompletionCount,
    failedRunsWithClaims: report.failedRunsWithClaims.length }));
} finally { await pool.end(); }
