import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { loadConfig } from "../config.js";
import { ReplayVerifier } from "../replay/verifier.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.PANINI_ROLLOUT_EXPECTED_DATABASE;
const reportPath = process.env.PANINI_ROLLOUT_REPORT;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
if (!databaseUrl || !expectedDatabase || !/^[a-z][a-z0-9_]*$/.test(expectedDatabase)
  || !reportPath || !contentKey) {
  throw new Error("Rollout preparation requires an asserted database, content key and report path.");
}
const root = process.cwd();
const artifactRoot = path.resolve(root, "artifacts/evidence-state");
const output = path.resolve(reportPath);
if (!output.startsWith(`${artifactRoot}${path.sep}`) || !output.endsWith(".json")) {
  throw new Error("Rollout report must be JSON under artifacts/evidence-state.");
}

const hash = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.resolve(root, directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (entry.isFile()) files.push(relative);
  }
  return files;
}
const codeFiles = [...await sourceFiles("src"), ...await sourceFiles("drizzle"),
  "package.json", "pnpm-lock.yaml"].sort();
const codeHashes = await Promise.all(codeFiles.map(async (file) =>
  [file, hash(await readFile(path.resolve(root, file)))] as const));
const journal = JSON.parse(await readFile(path.resolve(root, "drizzle/meta/_journal.json"), "utf8")) as {
  entries: { tag: string }[];
};
const expectedMigrationHashes = await Promise.all(journal.entries.map(async ({ tag }) =>
  hash(await readFile(path.resolve(root, "drizzle", `${tag}.sql`)))));
const configFile = path.resolve(root, process.env.APP_CONFIG_PATH ?? "./config/panini.example.yaml");
const configHash = hash(await readFile(configFile));
const config = await loadConfig();
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey, undefined,
  { backfillLegacyContent: false });
try {
  const database = (await pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Rollout database assertion failed.");
  const organization = await store.getOrganization();
  const migrationRows = await pool.query<{ hash: string }>(
    "SELECT hash FROM drizzle.__panini_migrations ORDER BY id",
  );
  const migrationHashesMatch = migrationRows.rows.length === expectedMigrationHashes.length
    && migrationRows.rows.every((row, index) => row.hash === expectedMigrationHashes[index]);
  const budgetId = process.env.PANINI_EVIDENCE_V2_BUDGET_ID ?? null;
  const budget = budgetId ? await store.getInferenceBudget(budgetId) : null;
  const costRows = budget ? await pool.query<{ spent_usd: string; unknown_calls: string }>(
    `SELECT coalesce(sum(cost_usd),0)::text AS spent_usd,
       count(*) FILTER (WHERE state IN ('dispatched','unknown')
         OR (state='succeeded' AND cost_basis='unknown'))::text AS unknown_calls
       FROM model_calls WHERE organization_id=$1 AND budget_id=$2`,
    [organization.id, budget.id],
  ) : null;
  const replay = await new ReplayVerifier(store).verify();
  const mode = config.app.intelligence.evidenceV2.mode;
  const safety = {
    reviewedGoldReport: process.env.PANINI_ROLLOUT_GOLD_REPORT ?? null,
    mechanicsReport: process.env.PANINI_ROLLOUT_MECHANICS_REPORT ?? null,
    isolatedRollbackReport: process.env.PANINI_ROLLOUT_ROLLBACK_REPORT ?? null,
    explicitDeploymentScope: process.env.PANINI_ROLLOUT_DEPLOYMENT_SCOPE ?? null,
  };
  const reportEvidence = async (value: string | null) => {
    if (!value) return null;
    const file = path.resolve(value);
    if (!file.startsWith(`${artifactRoot}${path.sep}`) || !file.endsWith(".json")) {
      throw new Error("Rollout evidence reports must be JSON under artifacts/evidence-state.");
    }
    const bytes = await readFile(file);
    return { path: file, sha256: hash(bytes), body: JSON.parse(bytes.toString("utf8")) as Record<string, unknown> };
  };
  const [goldEvidence, mechanicsEvidence, rollbackEvidence] = await Promise.all([
    reportEvidence(safety.reviewedGoldReport), reportEvidence(safety.mechanicsReport),
    reportEvidence(safety.isolatedRollbackReport),
  ]);
  const goldCandidate = goldEvidence?.body.candidate as {
    holdout?: { falseCompletions?: number; additionalFindingsRequiringReview?: number;
      additionalActionFindingsRequiringReview?: number };
  } | undefined;
  const goldBaseline = goldEvidence?.body.baseline;
  const goldPass = goldBaseline !== null && goldBaseline !== undefined
    && goldCandidate?.holdout?.falseCompletions === 0
    && goldCandidate.holdout.additionalFindingsRequiringReview === 0
    && goldCandidate.holdout.additionalActionFindingsRequiringReview === 0;
  const mechanicsPass = mechanicsEvidence?.body.allScenariosPass === true;
  const rollbackPass = rollbackEvidence?.body.ok === true
    && rollbackEvidence.body.mode === "isolated_pre_change_restore";
  const report = {
    schemaVersion: 1, preparedAt: new Date().toISOString(),
    source: { digest: hash(JSON.stringify(codeHashes)), fileCount: codeHashes.length,
      files: Object.fromEntries(codeHashes) },
    config: { digest: configHash, mode,
      pipelineVersion: config.app.intelligence.evidenceV2.pipelineVersion,
      policyVersion: config.app.intelligence.evidenceV2.policyVersion,
      enabledTransitionClasses: config.app.intelligence.evidenceV2.autoApplyClasses,
      authorityPolicyVersions: config.app.intelligence.evidenceV2.authorityPolicies.map((policy) =>
        ({ id: policy.id, version: policy.version })),
      primaryModel: config.intelligenceModel,
      escalationModel: config.app.intelligence.evidenceV2.escalation?.model ?? null,
    },
    target: { database, organizationId: organization.id,
      migrations: { databaseCount: migrationRows.rows.length,
        codeCount: journal.entries.length, codeLatestTag: journal.entries.at(-1)?.tag ?? null,
        databaseLatestHash: migrationRows.rows.at(-1)?.hash ?? null,
        hashesMatch: migrationHashesMatch } },
    budget: budget ? { id: budget.id, state: budget.state, deadline: budget.deadline,
      maxCalls: budget.maxCalls, maxInputTokens: budget.maxInputTokens,
      maxOutputTokens: budget.maxOutputTokens, maxUsd: budget.maxUsd,
      spentCalls: budget.spentCalls, spentUsd: costRows?.rows[0]?.spent_usd ?? null,
      unknownCalls: Number(costRows?.rows[0]?.unknown_calls ?? 0) } : null,
    projectionVerification: replay,
    metricThresholds: { failedEvidenceJobs: 0, rejectedAuthorityAttestations: 0,
      unsupportedAutoCompletions: 0, correctedAutoApplications: 0,
      crossOrganizationLeaks: 0, duplicateApplications: 0, unknownPaidCost: 0 },
    enforcedAutomaticGuard: ["failedEvidenceJobs", "rejectedAuthorityAttestations"],
    alerts: ["The transaction guard disables automatic application after a failed evidence job or rejected authority attestation.",
      "Investigate dead-letter evidence jobs, source freshness, and spend before advancing mode."],
    operatorCommands: { migrate: "pnpm db:migrate", startServer: "pnpm start",
      startWorker: "pnpm worker", stop: process.env.PANINI_ROLLOUT_STOP_COMMAND ?? null,
      restart: process.env.PANINI_ROLLOUT_RESTART_COMMAND ?? null,
      rollback: process.env.PANINI_ROLLOUT_ROLLBACK_COMMAND ?? null },
    evidence: { ...safety,
      reports: { gold: goldEvidence ? { path: goldEvidence.path, sha256: goldEvidence.sha256,
        passesKnownCompletionChecks: goldPass } : null,
      mechanics: mechanicsEvidence ? { path: mechanicsEvidence.path,
        sha256: mechanicsEvidence.sha256, allScenariosPass: mechanicsPass } : null,
      rollback: rollbackEvidence ? { path: rollbackEvidence.path,
        sha256: rollbackEvidence.sha256, ok: rollbackPass } : null } },
    promotionReady: false,
    promotionBlockers: [
      ...Object.entries(safety).filter(([, value]) => !value).map(([key]) => `missing_${key}`),
      ...(goldEvidence && !goldPass ? ["gold_completion_gate_not_met"] : []),
      ...(goldEvidence && (goldBaseline === null || goldBaseline === undefined)
        ? ["matched_baseline_absent"] : []),
      ...(mechanicsEvidence && !mechanicsPass ? ["mechanics_scenarios_not_all_passed"] : []),
      ...(rollbackEvidence && !rollbackPass ? ["isolated_restore_not_proven"] : []),
      ...(replay.ok ? [] : ["projection_rebuild_mismatch"]),
      ...(migrationHashesMatch
        ? [] : ["database_migrations_pending_or_unexpected"]),
      ...(budget && budget.state === "active" ? [] : ["active_budget_missing"]),
      ...(mode === "legacy" ? ["mode_is_legacy"] : []),
      "gold_and_rollback_reports_require_recorded_review",
    ],
  };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ report: output, database, organizationId: organization.id,
    mode, promotionReady: false, blockers: report.promotionBlockers })}\n`);
} finally {
  await store.close();
  await pool.end();
}
