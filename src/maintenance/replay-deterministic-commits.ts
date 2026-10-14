import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";
import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { githubCommitClaims, githubSnapshotClaims, OpenAIClaimExtractor } from "../intelligence/claim-extractor.js";
import { EvidencePipeline } from "../intelligence/evidence-pipeline.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const sourcePath = process.env.PANINI_REPLAY_REPORT;
const outputPath = process.env.PANINI_REPLAY_DETERMINISTIC_REPORT;
const scope = process.env.PANINI_DETERMINISTIC_SCOPE ?? "commits";
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",")
  .map((value) => value.trim()).filter(Boolean);
if (!databaseUrl || !contentKey || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !sourcePath || !outputPath || allowed.length === 0
  || !["commits", "github_snapshots"].includes(scope)) {
  throw new Error("Isolated replay database, source report, key, output, and visibility list are required.");
}
const root = path.resolve("artifacts/evidence-state");
const sourceFile = path.resolve(sourcePath);
const outputFile = path.resolve(outputPath);
if (!sourceFile.startsWith(`${root}${path.sep}`) || !sourceFile.endsWith(".json")
  || !outputFile.startsWith(`${root}${path.sep}`) || !outputFile.endsWith(".json")
  || sourceFile === outputFile) {
  throw new Error("Deterministic replay files must be JSON under artifacts/evidence-state.");
}
const source = JSON.parse(await readFile(sourceFile, "utf8")) as {
  database: string; organizationId: string; selectedEvents: number; inputFingerprint: string;
  pipelineVersion: string; budgetId: string; startedAt: string; stopReason: string | null;
};
if (source.database !== databaseName || !source.organizationId || !source.budgetId
  || source.stopReason !== "budget_exhausted") {
  throw new Error("A stopped, budget-limited source replay is required.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey);
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName || (await store.getOrganization()).id !== source.organizationId) {
    throw new Error("Deterministic replay database or organization assertion failed.");
  }
  const selected = (await store.listSourceEvents(10_000))
    .filter((event) => allowed.includes(event.visibility))
    .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
      || left.id.localeCompare(right.id))
    .slice(0, source.selectedEvents);
  if (selected.length !== source.selectedEvents || contentHash(selected.map((event) =>
    [event.id, event.observationIdentity?.sourceVersionKey ?? null])) !== source.inputFingerprint) {
    throw new Error("Deterministic replay input fingerprint differs from the approved source snapshot.");
  }
  const candidates = selected.filter((event) => event.provider === "github"
    && (scope === "github_snapshots" || event.eventKind === "commit.snapshot"));
  const eligible = candidates.filter((event) => scope === "github_snapshots"
    ? githubSnapshotClaims(event) !== null : githubCommitClaims(event) !== null);
  const before = (await pool.query<{ spent_calls: string; spent_output_tokens: string }>(
    "SELECT spent_calls,spent_output_tokens FROM inference_budgets WHERE id=$1 AND organization_id=$2",
    [source.budgetId, source.organizationId],
  )).rows[0];
  if (!before) throw new Error("Approved inference budget was not found.");
  const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
    autoApproveContext: false, requireReviewForTaskChanges: true }));
  const extractor = new OpenAIClaimExtractor({ store, apiKey: "disabled", model: "gpt-6-luna",
    allowedVisibilities: allowed,
    fetcher: async () => { throw new Error("Deterministic replay must never call a model."); } });
  const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: source.pipelineVersion,
    extractor, identityResolver: { async resolve() {
      throw new Error("Deterministic GitHub claims must not invoke task identity.");
    } } });
  let processedEvents = 0;
  let claims = 0;
  let alreadyTerminal = 0;
  const failures: { eventIds: string[]; code: string }[] = [];
  for (let index = 0; index < eligible.length; index += 20) {
    const eventIds = eligible.slice(index, index + 20).map((event) => event.id);
    try {
      const result = await pipeline.run({ eventIds, budgetId: source.budgetId,
        evaluationClock: source.startedAt, knowledgeCutoff: source.startedAt,
        replayMode: "source_reinterpret" });
      processedEvents += result.processedEventIds.length;
      claims += result.claimCount;
      alreadyTerminal += eventIds.length - result.processedEventIds.length;
    } catch (error) {
      failures.push({ eventIds, code: error instanceof Error ? error.name : "unknown" });
      break;
    }
  }
  const after = (await pool.query<{ spent_calls: string; spent_output_tokens: string }>(
    "SELECT spent_calls,spent_output_tokens FROM inference_budgets WHERE id=$1 AND organization_id=$2",
    [source.budgetId, source.organizationId],
  )).rows[0]!;
  if (before.spent_calls !== after.spent_calls || before.spent_output_tokens !== after.spent_output_tokens) {
    throw new Error("Deterministic commit replay unexpectedly changed the model budget.");
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: databaseName, organizationId: source.organizationId,
    sourceInputFingerprint: source.inputFingerprint, pipelineVersion: source.pipelineVersion,
    scope, selectedGithubReceipts: candidates.length, eligibleGithubReceipts: eligible.length,
    skippedForInvalidStructure: candidates.length - eligible.length,
    processedEvents, claims, alreadyTerminal, failures,
    modelCallsBefore: Number(before.spent_calls), modelCallsAfter: Number(after.spent_calls),
    modelOutputTokensBefore: Number(before.spent_output_tokens),
    modelOutputTokensAfter: Number(after.spent_output_tokens),
    limitation: "GitHub snapshots record reported artifact state; they do not establish task completion or deployment independently." };
  await mkdir(path.dirname(outputFile), { recursive: true });
  const temporary = `${outputFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temporary, outputFile);
  console.log(JSON.stringify({ report: outputFile, scope, selectedGithubReceipts: candidates.length,
    eligibleGithubReceipts: eligible.length, processedEvents, alreadyTerminal,
    failures: failures.length, modelCalls: Number(after.spent_calls) }));
} finally { await store.close(); await pool.end(); }
