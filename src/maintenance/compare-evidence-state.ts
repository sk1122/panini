import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { explicitlyAssertsTaskDone } from "../intelligence/decision-policy.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const sourcePath = process.env.PANINI_REPLAY_REPORT;
const additionalPath = process.env.PANINI_REPLAY_ADDITIONAL_REPORT;
const outputPath = process.env.PANINI_REPLAY_COMPARISON;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
if (!databaseUrl || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !sourcePath || !outputPath || !contentKey) {
  throw new Error("An isolated replay database, content key, source report, and output are required.");
}
const root = path.resolve("artifacts/evidence-state");
const sourceFile = path.resolve(sourcePath);
const outputFile = path.resolve(outputPath);
if (!sourceFile.startsWith(`${root}${path.sep}`) || !sourceFile.endsWith(".json")
  || !outputFile.startsWith(`${root}${path.sep}`) || !outputFile.endsWith(".json")
  || sourceFile === outputFile) {
  throw new Error("Comparison files must be JSON under artifacts/evidence-state.");
}
const replay = JSON.parse(await readFile(sourceFile, "utf8")) as {
  database: string; organizationId: string; stopReason: string | null;
  processedEvents: number; selectedEvents: number; inputFingerprint: string;
};
if (replay.database !== databaseName || !replay.organizationId || !replay.inputFingerprint) {
  throw new Error("Replay report target does not match the isolated database.");
}
const additionalFile = additionalPath ? path.resolve(additionalPath) : null;
if (additionalFile && (!additionalFile.startsWith(`${root}${path.sep}`)
  || !additionalFile.endsWith(".json") || additionalFile === sourceFile
  || additionalFile === outputFile)) {
  throw new Error("Additional replay report must be a distinct JSON artifact.");
}
const additional = additionalFile
  ? JSON.parse(await readFile(additionalFile, "utf8")) as typeof replay : null;
if (additional && (additional.database !== databaseName
  || additional.organizationId !== replay.organizationId
  || additional.stopReason !== "completed" || !additional.inputFingerprint)) {
  throw new Error("Additional replay is incomplete or targets a different database.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey, replay.organizationId);
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName) throw new Error("Comparison database assertion failed.");
  const tasks = (await pool.query<{ id: string; title: string; status: string; version: number }>(
    `SELECT id,document->>'title' AS title,document->>'status' AS status,version
       FROM tasks WHERE organization_id=$1 ORDER BY id`, [replay.organizationId],
  )).rows;
  const assessmentRows = (await pool.query<{ target_id: string; relationship: string;
    assessment_id: string; claim_ids: string[]; latest_source_at: Date | null;
    has_pending_done_proposal: boolean }>(
    `SELECT a.target_id,a.relationship,a.id AS assessment_id,a.claim_ids,
       max(se.occurred_at) AS latest_source_at,
       coalesce(bool_or(p.state IN ('pending','escalated') AND p.changes->>'status'='done'),false)
         AS has_pending_done_proposal
      FROM evidence_assessments a
      JOIN evidence_claims c ON c.organization_id=a.organization_id
        AND c.id=ANY(a.claim_ids) AND c.kind='completion_report' AND c.content_state='active'
      JOIN evidence_dependencies dep ON dep.organization_id=a.organization_id
        AND dep.dependent_type='assessment' AND dep.dependent_id=a.id
      JOIN source_events se ON se.organization_id=dep.organization_id
        AND se.id=dep.source_event_id AND se.content_state='active'
      LEFT JOIN proposals p ON p.organization_id=a.organization_id AND p.assessment_id=a.id
      WHERE a.organization_id=$1 AND a.target_type='task' AND a.content_state='active'
      GROUP BY a.target_id,a.relationship,a.id ORDER BY a.target_id,a.id`,
    [replay.organizationId],
  )).rows;
  const claimIds = [...new Set(assessmentRows.flatMap((row) => row.claim_ids))];
  const claims = new Map((await store.getClaims(claimIds)).map((claim) => [claim.id, claim]));
  if (claims.size !== claimIds.length) throw new Error("Compared completion claims are missing or revoked.");
  const byTask = new Map<string, Array<typeof assessmentRows[number] & { explicitTaskDone: boolean }>>();
  for (const row of assessmentRows) {
    const rows = byTask.get(row.target_id) ?? [];
    rows.push({ ...row, explicitTaskDone: row.claim_ids.some((id) =>
      explicitlyAssertsTaskDone(claims.get(id)!.body)) });
    byTask.set(row.target_id, rows);
  }
  const comparisons = tasks.map((task) => {
    const evidence = byTask.get(task.id) ?? [];
    const sameOutcome = evidence.filter((row) => row.relationship === "same_outcome");
    const explicitlyDone = sameOutcome.filter((row) => row.explicitTaskDone);
    const latest = evidence.map((row) => row.latest_source_at?.getTime() ?? 0);
    return { taskId: task.id, title: task.title, acceptedStatus: task.status,
      acceptedVersion: task.version, assessedCompletionCounts: {
        sameOutcome: sameOutcome.length,
        partOf: evidence.filter((row) => row.relationship === "part_of").length,
        related: evidence.filter((row) => row.relationship === "related").length,
        uncertain: evidence.filter((row) => row.relationship === "uncertain").length,
      }, pendingDoneProposalCount: sameOutcome.filter((row) => row.has_pending_done_proposal).length,
      explicitTaskDoneReportCount: explicitlyDone.length,
      invalidPendingDoneProposalCount: sameOutcome.filter((row) =>
        row.has_pending_done_proposal && !row.explicitTaskDone).length,
      latestAssessedSourceAt: latest.length > 0 ? new Date(Math.max(...latest)).toISOString() : null,
      reviewCategory: task.status !== "done" && explicitlyDone.length > 0
        ? "open_with_explicit_task_done_report"
        : task.status !== "done" && sameOutcome.length > 0
          ? "open_with_activity_completion_report_only"
        : task.status === "done" && explicitlyDone.length === 0
          ? "done_without_v2_explicit_task_done_assessment"
          : "no_direct_status_conflict_detected" };
  });
  const categories = Object.fromEntries([...new Set(comparisons.map((item) => item.reviewCategory))]
    .sort().map((category) => [category, comparisons.filter((item) => item.reviewCategory === category).length]));
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId: replay.organizationId,
    replayStopReason: replay.stopReason, selectedEvents: replay.selectedEvents + (additional?.selectedEvents ?? 0),
    processedEvents: replay.processedEvents + (additional?.processedEvents ?? 0),
    inputFingerprint: replay.inputFingerprint,
    additionalReplay: additional ? { selectedEvents: additional.selectedEvents,
      processedEvents: additional.processedEvents,
      inputFingerprint: additional.inputFingerprint, stopReason: additional.stopReason } : null,
    interpretation: "Only an explicit status=done claim counts as a task-done report. It still requires scope, criterion, freshness, and human review. Completion-kind activity claims and missing v2 assessments do not prove a status conflict.",
    categories, tasks: comparisons };
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temporary, outputFile);
  console.log(JSON.stringify({ report: outputFile, tasks: comparisons.length,
    categories, replayStopReason: replay.stopReason }));
} finally { await store.close(); await pool.end(); }
