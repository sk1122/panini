import { TeamLedger } from "../domain/team-ledger.js";
import { ProposalPolicy } from "../domain/policy.js";
import { JevWorkJudge } from "../reconciliation/jev-work-judge.js";
import { OpenAIWorkProseDrafter } from "../reconciliation/openai-work-drafter.js";
import { PostgresLedgerStore } from "../store/postgres.js";
import { MemoryLedgerStore } from "../store/memory.js";
import { ExternalEvaluationLimiter, meteredExternalFetch } from "../intelligence/external-call-meter.js";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const reportPath = process.env.PANINI_LEGACY_PREVIEW_REPORT;
const reportRoot = path.resolve("artifacts/evidence-state");
if (!reportPath || !path.resolve(reportPath).startsWith(`${reportRoot}${path.sep}`)
  || !reportPath.endsWith(".json")) {
  throw new Error("Legacy model preview requires a private JSON report under artifacts/evidence-state.");
}
const limiter = new ExternalEvaluationLimiter({
  maxCalls: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_CALLS),
  maxInputTokens: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_INPUT_TOKENS),
  maxOutputTokens: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_OUTPUT_TOKENS),
  maxWallSeconds: Number(process.env.PANINI_LEGACY_PREVIEW_MAX_WALL_SECONDS),
});

// Read-only preview against the current ledger. It makes hosted calls only for
// the source IDs explicitly supplied by the operator and applies no proposal.
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",").filter((visibility) =>
  visibility && (process.env.WORK_DRAFT_ALLOWED_VISIBILITIES ?? "").split(",").includes(visibility));
if (!process.env.DATABASE_URL || !process.env.CONTENT_ENCRYPTION_KEY || !process.env.OPENROUTER_API_KEY
  || !process.env.INTELLIGENCE_API_KEY || !process.env.INTELLIGENCE_MODEL || !allowed.length
  || process.argv.length < 3) throw new Error("Database, approved model scope, and source IDs are required.");
const store = new PostgresLedgerStore(process.env.DATABASE_URL, process.env.CONTENT_ENCRYPTION_KEY,
  undefined, { backfillLegacyContent: false });
const audit = new MemoryLedgerStore();
const ledger = new TeamLedger(store, new ProposalPolicy({ mode: "manual_review", autoApproveNewTasks: false,
  autoApproveContext: false, requireReviewForTaskChanges: true }));
const judge = new JevWorkJudge({ apiKey: process.env.OPENROUTER_API_KEY,
  allowedVisibilities: allowed,
  fetcher: meteredExternalFetch(audit, { provider: "openrouter", purpose: "work_judge", limiter }) });
const drafter = new OpenAIWorkProseDrafter({ apiKey: process.env.INTELLIGENCE_API_KEY,
  model: process.env.INTELLIGENCE_MODEL,
  ...(process.env.INTELLIGENCE_BASE_URL ? { baseUrl: process.env.INTELLIGENCE_BASE_URL } : {}),
  allowedVisibilities: allowed,
  fetcher: meteredExternalFetch(audit, { provider: "openai", purpose: "work_prose", limiter }) });
for (const eventId of process.argv.slice(2, 5)) {
  const bundle = await ledger.workEvidenceBundle(eventId, allowed);
  const classification = await judge.judge(bundle);
  const title = await drafter.draft(bundle, { kind: "task_title", candidateId: null,
    evidenceEventIds: [eventId] });
  const projects = await store.listProjects();
  const projectDecision = title.text ? await judge.judgeProject(title.text, bundle, projects) : null;
  console.log(JSON.stringify({ eventId, spanCount: bundle.spans.length,
  classification: { kind: classification.kind.choice, kindConfidence: classification.kind.confidence,
    target: classification.target.choice, targetConfidence: classification.target.confidence },
  titleLength: title.text.length, selectedProjectId: projectDecision?.selectedProjectId ?? null }));
}
await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
await writeFile(path.resolve(reportPath), `${JSON.stringify({ schemaVersion: 1,
  generatedAt: new Date().toISOString(), mode: "legacy_project_preview",
  selectedEventIds: process.argv.slice(2, 5),
  externalCalls: (await audit.listAuditEvents(10_000)).filter((event) =>
    event.action.startsWith("external_call.")),
  limits: limiter.snapshot(), costComplete: false }, null, 2)}\n`,
{ mode: 0o600 });
await store.close();
