import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const comparisonPath = process.env.PANINI_REPLAY_COMPARISON;
const outputPath = process.env.PANINI_REPLAY_REVIEW_SAMPLE;
if (!databaseUrl || !contentKey || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !comparisonPath || !outputPath) {
  throw new Error("An isolated replay database, encryption key, comparison, and output are required.");
}
const root = path.resolve("artifacts/evidence-state");
const comparisonFile = path.resolve(comparisonPath);
const outputFile = path.resolve(outputPath);
if (!comparisonFile.startsWith(`${root}${path.sep}`) || !comparisonFile.endsWith(".json")
  || !outputFile.startsWith(`${root}${path.sep}`) || !outputFile.endsWith(".json")
  || comparisonFile === outputFile) {
  throw new Error("Review files must be JSON under artifacts/evidence-state.");
}
const comparison = JSON.parse(await readFile(comparisonFile, "utf8")) as {
  database: string; organizationId: string;
  tasks: { taskId: string; title: string; acceptedStatus: string; reviewCategory: string }[];
};
if (comparison.database !== databaseName || !comparison.organizationId) {
  throw new Error("Comparison target does not match the isolated database.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey);
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName || (await store.getOrganization()).id !== comparison.organizationId) {
    throw new Error("Review sample database or organization assertion failed.");
  }
  const selected = comparison.tasks.filter((task) =>
    task.reviewCategory === "open_with_explicit_task_done_report"
      || task.reviewCategory === "open_with_activity_completion_report_only").slice(0, 30);
  const cases = [] as unknown[];
  for (const task of selected) {
    const assessments = (await pool.query<{ id: string; claim_ids: string[]; reason_codes: string[] }>(
      `SELECT id,claim_ids,reason_codes FROM evidence_assessments
       WHERE organization_id=$1 AND target_type='task' AND target_id=$2
         AND relationship='same_outcome' AND content_state='active'
       ORDER BY created_at,id LIMIT 20`, [comparison.organizationId, task.taskId],
    )).rows;
    const claims = await store.getClaims([...new Set(assessments.flatMap((item) => item.claim_ids))]);
    const byId = new Map(claims.map((claim) => [claim.id, claim]));
    cases.push({ taskId: task.taskId, title: task.title, acceptedStatus: task.acceptedStatus,
      assessments: assessments.map((assessment) => ({ assessmentId: assessment.id,
        reasonCodes: assessment.reason_codes,
        claims: assessment.claim_ids.flatMap((id) => {
          const claim = byId.get(id);
          return claim ? [{ claimId: id, kind: claim.body.kind,
            statement: claim.body.statement, assertedAt: claim.body.assertedAt,
            assertedField: claim.body.assertedField, assertedValue: claim.body.assertedValue,
            caveats: claim.body.caveats,
            sourceEventIds: claim.body.spans.map((span) => span.eventId) }] : [];
        }) })) });
  }
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId: comparison.organizationId,
    purpose: "Private local review of reported completion versus accepted task scope; claims are not accepted status.",
    cases }, null, 2), { mode: 0o600 });
  await rename(temporary, outputFile);
  console.log(JSON.stringify({ report: outputFile, caseCount: cases.length }));
} finally { await store.close(); await pool.end(); }
