import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";
import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { EvidencePipeline } from "../intelligence/evidence-pipeline.js";
import { OpenAITaskIdentityResolver } from "../intelligence/task-identity.js";
import { OpenAIEvidenceJudge } from "../intelligence/evidence-judge.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "../intelligence/model-price.js";
import { PostgresLedgerStore } from "../store/postgres.js";
import { acceptedProjectionDiff, acceptedProjectionSnapshot,
  type AcceptedProjectionSnapshot } from "./accepted-projection-diff.js";

const databaseUrl = process.env.DATABASE_URL;
const key = process.env.CONTENT_ENCRYPTION_KEY;
const apiKey = process.env.INTELLIGENCE_API_KEY;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const sourceReportPath = process.env.PANINI_REPLAY_REPORT;
const reportPath = process.env.PANINI_REASSESS_REPORT;
const model = process.env.INTELLIGENCE_MODEL;
const unassessedOnly = process.env.PANINI_REASSESS_UNASSESSED_ONLY === "true";
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",")
  .map((item) => item.trim()).filter(Boolean);
if (!databaseUrl || !key || !apiKey || !databaseName || !sourceReportPath || !reportPath
  || !allowed.length || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || model !== "gpt-6-luna") {
  throw new Error("An isolated replay database, matching reports, source visibility list, and pinned model are required.");
}
const root = path.resolve("artifacts/evidence-state");
const sourceFile = path.resolve(sourceReportPath);
const outputFile = path.resolve(reportPath);
if (!sourceFile.startsWith(`${root}${path.sep}`) || !outputFile.startsWith(`${root}${path.sep}`)
  || !sourceFile.endsWith(".json") || !outputFile.endsWith(".json") || sourceFile === outputFile) {
  throw new Error("Replay reports must be distinct JSON files under artifacts/evidence-state.");
}
const sourceReport = JSON.parse(await readFile(sourceFile, "utf8")) as {
  database: string; model: string; budgetId: string; stopReason: string;
  inputFingerprint: string; deadline: string; caps: { maxCalls: number; maxUsd: string };
};
if (sourceReport.database !== databaseName || sourceReport.model !== model
  || (sourceReport.stopReason !== "completed" && process.env.PANINI_ALLOW_PARTIAL_REASSESS !== "true")) {
  throw new Error("A completed matching source replay is required before cached reassessment.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const actualDatabase = (await pool.query<{ current_database: string }>("SELECT current_database()"))
  .rows[0]?.current_database;
if (actualDatabase !== databaseName) throw new Error("Cached reassessment database assertion failed.");
const store = new PostgresLedgerStore(databaseUrl, key);
const organization = await store.getOrganization();
type Report = {
  schemaVersion: 1; mode: "cached_reassess"; runId: string; database: string;
  organizationId: string; model: string; budgetId: string; sourceInputFingerprint: string;
  claimFingerprint: string; selectedClaims: number; pipelineVersion: string;
  selection: "unassessed_only" | "all_completion";
  selectedClaimIds: string[];
  nextClaim: number; assessedClaims: number; assessments: number; pendingProposals: number;
  startedAt: string; finishedAt: string | null; stopReason: string | null;
  failures: { index: number; claimId: string; errorCode: string }[];
  acceptedProjectionBefore?: AcceptedProjectionSnapshot;
  acceptedProjectionChange?: ReturnType<typeof acceptedProjectionDiff>;
};
await mkdir(path.dirname(outputFile), { recursive: true });
let existing: Report | null = null;
try {
  existing = JSON.parse(await readFile(outputFile, "utf8")) as Report;
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}
const allRows = (await pool.query<{ id: string; content_hash: string; assessed: boolean }>(
  `SELECT c.id,c.content_hash,EXISTS (SELECT 1 FROM evidence_assessments a
      WHERE a.organization_id=c.organization_id AND a.content_state='active'
        AND c.id=ANY(a.claim_ids)) AS assessed
    FROM evidence_claims c WHERE c.organization_id=$1
      AND c.kind='completion_report' AND c.content_state='active'
    ORDER BY assessed,c.created_at,c.id`, [organization.id],
)).rows;
const rowById = new Map(allRows.map((row) => [row.id, row]));
const rows = existing?.selection === "unassessed_only"
  ? existing.selectedClaimIds.map((id) => rowById.get(id)).filter((row) => row !== undefined)
  : unassessedOnly ? allRows.filter((row) => !row.assessed) : allRows;
const claimFingerprint = contentHash(rows.map((row) => [row.id, row.content_hash]));
let progress: Report;
if (existing) {
  progress = existing;
  if (progress.database !== databaseName || progress.organizationId !== organization.id
    || progress.model !== model || progress.budgetId !== sourceReport.budgetId
    || progress.sourceInputFingerprint !== sourceReport.inputFingerprint
    || progress.claimFingerprint !== claimFingerprint || progress.selectedClaims !== rows.length
    || progress.selectedClaimIds.length !== rows.length
    || progress.selection !== (unassessedOnly ? "unassessed_only" : "all_completion")) {
    throw new Error("Existing cached reassessment does not match the replay and claim set.");
  }
} else {
  progress = { schemaVersion: 1, mode: "cached_reassess", runId: randomUUID(),
    database: databaseName, organizationId: organization.id, model,
    budgetId: sourceReport.budgetId, sourceInputFingerprint: sourceReport.inputFingerprint,
    claimFingerprint, selectedClaims: rows.length,
    selection: unassessedOnly ? "unassessed_only" : "all_completion",
    selectedClaimIds: rows.map((row) => row.id),
    pipelineVersion: "evidence-v2-20261001-reassess-r1", nextClaim: 0,
    assessedClaims: 0, assessments: 0, pendingProposals: 0,
    startedAt: new Date().toISOString(), finishedAt: null, stopReason: null, failures: [] };
  progress.acceptedProjectionBefore = await acceptedProjectionSnapshot(store);
}
const save = async () => {
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
  await rename(temporary, outputFile);
};
await save();
const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
  autoApproveContext: false, requireReviewForTaskChanges: true }));
const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: progress.pipelineVersion,
  maxEvidenceExpansions: 0,
  extractor: { name: `saved-claims:${model}`, async extract() {
    throw new Error("Cached reassessment must never extract source text again.");
  } }, identityResolver: new OpenAITaskIdentityResolver({ store, apiKey, model,
    allowedVisibilities: allowed, allowTaskContextEgress: true,
    priceBasis: GPT6_LUNA_PRICE_2026_10_01,
    baseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1" }),
  judge: new OpenAIEvidenceJudge({ store, apiKey, model,
    allowedVisibilities: allowed, priceBasis: GPT6_LUNA_PRICE_2026_10_01,
    baseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1" }) });
try {
  for (let index = progress.nextClaim; index < rows.length; index += 1) {
    if (Date.now() >= Date.parse(sourceReport.deadline)) { progress.stopReason = "wall_deadline"; break; }
    const claimId = rows[index]!.id;
    try {
      const result = await pipeline.runCachedAssessment({ claimIds: [claimId],
        budgetId: sourceReport.budgetId, evaluationClock: progress.startedAt,
        knowledgeCutoff: progress.startedAt });
      progress.assessedClaims += 1;
      progress.assessments += result.assessmentCount;
      progress.pendingProposals += result.pendingProposalCount;
      progress.nextClaim = index + 1;
      await save();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = message.includes("budget exhausted") ? "budget_exhausted"
        : message.includes("unavailable") ? "source_unavailable" : "reassessment_failed";
      progress.failures.push({ index, claimId, errorCode });
      progress.stopReason = errorCode;
      break;
    }
  }
  if (!progress.stopReason) progress.stopReason = progress.nextClaim === rows.length ? "completed" : "stopped";
  if (progress.acceptedProjectionBefore) {
    progress.acceptedProjectionChange = acceptedProjectionDiff(progress.acceptedProjectionBefore,
      await acceptedProjectionSnapshot(store));
    if (!progress.acceptedProjectionChange.unchanged) {
      progress.stopReason = "accepted_projection_changed";
      process.exitCode = 1;
    }
  }
  progress.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ report: outputFile, database: progress.database,
    selectedClaims: progress.selectedClaims, assessedClaims: progress.assessedClaims,
    assessments: progress.assessments, pendingProposals: progress.pendingProposals,
    stopReason: progress.stopReason }));
} finally { await store.close(); await pool.end(); }
