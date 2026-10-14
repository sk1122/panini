import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";
import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { EvidencePipeline } from "../intelligence/evidence-pipeline.js";
import { OpenAIClaimExtractor } from "../intelligence/claim-extractor.js";
import { OpenAITaskIdentityResolver } from "../intelligence/task-identity.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "../intelligence/model-price.js";
import { BudgetedWorkEmbeddings, WORK_EMBEDDING_PRICE_2026_10_01 } from "../intelligence/work-embeddings.js";
import { OpenAIEvidenceJudge } from "../intelligence/evidence-judge.js";
import { EmbeddingObservationEpisodeGrouper, packIndependentEpisodes } from "../intelligence/observation-episodes.js";
import { PostgresLedgerStore } from "../store/postgres.js";
import { acceptedProjectionDiff, acceptedProjectionSnapshot,
  type AcceptedProjectionSnapshot } from "./accepted-projection-diff.js";

const databaseUrl = process.env.DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
const apiKey = process.env.INTELLIGENCE_API_KEY;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const outputPath = process.env.PANINI_REPLAY_REPORT;
const catchupPath = process.env.PANINI_REPLAY_SOURCE_IDS_REPORT;
const baseBudgetPath = process.env.PANINI_REPLAY_BUDGET_REPORT;
const continuePath = process.env.PANINI_REPLAY_CONTINUE_REPORT;
const model = process.env.INTELLIGENCE_MODEL;
const replayMode = process.env.PANINI_REPLAY_MODE ?? "source_reinterpret";
const historicalCutoff = process.env.PANINI_REPLAY_KNOWLEDGE_CUTOFF ?? null;
if (!(["source_reinterpret", "historical_eval"] as string[]).includes(replayMode)
  || (replayMode === "historical_eval" && (!historicalCutoff
    || !process.env.PANINI_REPLAY_PIPELINE_VERSION
    || !Number.isFinite(Date.parse(historicalCutoff)) || Date.parse(historicalCutoff) > Date.now()))
  || (replayMode !== "historical_eval" && historicalCutoff)) {
  throw new Error("Historical replay requires an explicit past knowledge cutoff; current replay must omit it.");
}
const pipelineVersion = process.env.PANINI_REPLAY_PIPELINE_VERSION
  ?? (catchupPath ? "evidence-v2-recent-20261001" : "evidence-v2-20261001");
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",").map((item) => item.trim()).filter(Boolean);
const requiredInt = (name: string): number => {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a finite positive integer.`);
  return value;
};
if (!databaseUrl || !contentKey || !apiKey || !databaseName || !outputPath || !allowed.length
  || !/^panini_replay_[a-z0-9_]+$/.test(databaseName) || model !== "gpt-6-luna"
  || !/^evidence-v2-[a-z0-9-]+$/.test(pipelineVersion)) {
  throw new Error("An explicit isolated database, source visibility list, key, output, and pinned Luna model are required.");
}
const workspace = process.cwd();
const artifactRoot = path.resolve(workspace, "artifacts/evidence-state");
const reportFile = path.resolve(outputPath);
if (!(reportFile.startsWith(`${artifactRoot}${path.sep}`) && reportFile.endsWith(".json"))) {
  throw new Error("Replay report must be a JSON file under artifacts/evidence-state/.");
}
if (Boolean(catchupPath) !== Boolean(baseBudgetPath)) {
  throw new Error("Catch-up source and base-budget reports must be supplied together.");
}
if (continuePath && (catchupPath || baseBudgetPath)) {
  throw new Error("An interrupted base replay cannot continue in catch-up mode.");
}
if (replayMode === "historical_eval" && (continuePath || catchupPath || baseBudgetPath)) {
  throw new Error("Historical evaluation cannot reuse a current-state replay budget or catch-up report.");
}
const checkedArtifactPath = (value: string): string => {
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${artifactRoot}${path.sep}`) || !resolved.endsWith(".json")
    || resolved === reportFile) throw new Error("Replay input reports must be distinct JSON artifacts.");
  return resolved;
};
const maxEvents = requiredInt("PANINI_REPLAY_MAX_EVENTS");
const maxCalls = requiredInt("PANINI_REPLAY_MAX_CALLS");
const maxInputTokens = requiredInt("PANINI_REPLAY_MAX_INPUT_TOKENS");
const maxOutputTokens = requiredInt("PANINI_REPLAY_MAX_OUTPUT_TOKENS");
const maxWallSeconds = requiredInt("PANINI_REPLAY_MAX_WALL_SECONDS");
const maxFailures = requiredInt("PANINI_REPLAY_MAX_FAILURES");
const invocationEpisodeLimit = process.env.PANINI_REPLAY_EPISODES_THIS_INVOCATION
  ? requiredInt("PANINI_REPLAY_EPISODES_THIS_INVOCATION") : Number.MAX_SAFE_INTEGER;
const maxUsd = process.env.PANINI_REPLAY_MAX_USD;
const workEmbeddingsEnabled = process.env.PANINI_EVIDENCE_WORK_EMBEDDINGS_ENABLED === "true";
if (!maxUsd || !/^\d+(?:\.\d{1,8})?$/.test(maxUsd) || Number(maxUsd) <= 0) {
  throw new Error("PANINI_REPLAY_MAX_USD is required.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const codeFingerprint = contentHash({ workEmbeddingsEnabled, sources: await Promise.all([
  "src/intelligence/evidence-pipeline.ts", "src/intelligence/claim-extractor.ts",
  "src/intelligence/task-identity.ts", "src/intelligence/observation-identity.ts",
  "src/intelligence/observation-episodes.ts", "src/intelligence/decision-policy.ts",
  "src/intelligence/evidence-assessment.ts", "src/intelligence/claim-validation.ts",
  "src/intelligence/authority-policy.ts", "src/intelligence/work-embeddings.ts",
  "src/intelligence/evidence-judge.ts",
  "src/intelligence/model-price.ts", "src/domain/team-ledger.ts", "src/store/postgres.ts",
  "src/domain/accepted-source-access.ts", "src/retrieval/context-compiler.ts",
  "src/connectors/github/evidence-verifier.ts",
].map(async (file) => readFile(path.resolve(workspace, file), "utf8"))) });
const actualDatabase = (await pool.query<{ current_database: string }>("SELECT current_database()"))
  .rows[0]?.current_database;
if (actualDatabase !== databaseName) throw new Error("Replay database assertion failed.");
const store = new PostgresLedgerStore(databaseUrl, contentKey);
const organization = await store.getOrganization();
const startedAt = new Date().toISOString();
const catchup = catchupPath ? JSON.parse(await readFile(checkedArtifactPath(catchupPath), "utf8")) as {
  database: string; organizationId: string; acceptedTaskProjectionUnchanged: boolean;
  newReceiptIds: string[];
} : null;
const baseBudget = baseBudgetPath ? JSON.parse(await readFile(checkedArtifactPath(baseBudgetPath), "utf8")) as {
  database: string; organizationId: string; budgetId: string; deadline: string;
  finishedAt: string | null; stopReason: string | null; nextEpisode: number; totalEpisodes: number;
  caps: { maxCalls: number; maxInputTokens: number; maxOutputTokens: number; maxUsd: string };
} : null;
const interrupted = continuePath ? JSON.parse(await readFile(checkedArtifactPath(continuePath), "utf8")) as {
  schemaVersion: number; mode: string; runId: string; database: string; organizationId: string;
  model: string; pipelineVersion: string; inputFingerprint: string; selectedEvents: number;
  totalEpisodes: number; budgetId: string; startedAt: string; deadline: string;
  nextEpisode: number; processedEvents: number; claims: number; assessments: number;
  pendingProposals: number; noEvidenceEpisodes: number;
  failures: { episode: number; eventIds: string[]; errorCode: string }[];
  stopReason: string | null; finishedAt: string | null;
  codeSegments?: { startedAt: string; fromEpisode: number; codeFingerprint: string }[];
} : null;
if (catchup && baseBudget) {
  if (catchup.database !== databaseName || catchup.organizationId !== organization.id
    || !catchup.acceptedTaskProjectionUnchanged
    || !Array.isArray(catchup.newReceiptIds)
    || catchup.newReceiptIds.some((id) => typeof id !== "string" || !/^[0-9a-f-]{36}$/i.test(id))
    || new Set(catchup.newReceiptIds).size !== catchup.newReceiptIds.length
    || baseBudget.database !== databaseName || baseBudget.organizationId !== organization.id
    || !baseBudget.finishedAt || baseBudget.stopReason !== "completed"
    || baseBudget.nextEpisode !== baseBudget.totalEpisodes
    || baseBudget.caps.maxCalls !== maxCalls || baseBudget.caps.maxInputTokens !== maxInputTokens
    || baseBudget.caps.maxOutputTokens !== maxOutputTokens || baseBudget.caps.maxUsd !== maxUsd
    || !Number.isFinite(Date.parse(baseBudget.deadline))) {
    throw new Error("Catch-up receipts or shared replay budget do not match this isolated target.");
  }
  const row = (await pool.query<{ id: string; state: string; max_calls: string;
    max_input_tokens: string; max_output_tokens: string; max_usd: string;
    reserved_calls: string; deadline: Date }>(
    `SELECT id,state,max_calls,max_input_tokens,max_output_tokens,max_usd,reserved_calls,deadline
       FROM inference_budgets WHERE id=$1 AND organization_id=$2`,
    [baseBudget.budgetId, organization.id],
  )).rows[0];
  if (!row || row.state !== "active" || Number(row.reserved_calls) !== 0 || Number(row.max_calls) !== maxCalls
    || Number(row.max_input_tokens) !== maxInputTokens
    || Number(row.max_output_tokens) !== maxOutputTokens
    || row.max_usd !== maxUsd || row.deadline.toISOString() !== baseBudget.deadline) {
    throw new Error("The shared model budget is missing, changed, or inactive.");
  }
  const unresolved = (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM model_calls
      WHERE organization_id=$1 AND budget_id=$2 AND state IN ('reserved','dispatched','unknown')`,
    [organization.id, baseBudget.budgetId],
  )).rows[0];
  if (Number(unresolved?.n ?? 0) !== 0) throw new Error("Shared model calls need reconciliation before catch-up.");
}
const deadline = baseBudget?.deadline ?? new Date(Date.now() + maxWallSeconds * 1000).toISOString();
const allEvents = await store.listSourceEvents(10_000);
const newIds = new Set(catchup?.newReceiptIds ?? []);
const candidateEvents = allEvents.filter((event) => catchup
  ? newIds.has(event.id) && allowed.includes(event.visibility)
  : allowed.includes(event.visibility))
  .filter((event) => !historicalCutoff || event.receivedAt <= historicalCutoff)
  .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
const currentIds = new Set(await store.currentSourceEventIds(
  candidateEvents.map((event) => event.id), historicalCutoff ?? startedAt));
const selected = candidateEvents.filter((event) => currentIds.has(event.id)).slice(0, maxEvents);
if (catchup && selected.length !== newIds.size) {
  throw new Error("Catch-up replay must select every new active and authorized receipt.");
}
const episodes = packIndependentEpisodes(
  await new EmbeddingObservationEpisodeGrouper(null, []).group(selected, 20), 20, 30_000);
const inputFingerprint = contentHash({ mode: replayMode, historicalCutoff,
  sources: selected.map((event) => [event.id,
    event.observationIdentity?.sourceVersionKey ?? null]) });
if (interrupted) {
  if (interrupted.schemaVersion !== 1 || interrupted.mode !== "source_reinterpret"
    || interrupted.database !== databaseName || interrupted.organizationId !== organization.id
    || interrupted.model !== model || interrupted.pipelineVersion !== pipelineVersion
    || interrupted.inputFingerprint !== inputFingerprint
    || interrupted.selectedEvents !== selected.length || interrupted.totalEpisodes !== episodes.length
    || !interrupted.finishedAt || interrupted.stopReason !== "interrupted_connection"
    || !Number.isSafeInteger(interrupted.nextEpisode) || interrupted.nextEpisode < 1
    || interrupted.nextEpisode >= episodes.length
    || !interrupted.codeSegments?.length
    || interrupted.codeSegments.at(-1)?.codeFingerprint !== codeFingerprint
    || interrupted.failures.some((failure) => failure.episode >= interrupted.nextEpisode)) {
    throw new Error("Interrupted replay does not match this input, cursor, or pipeline code.");
  }
  const previousBudget = await store.getInferenceBudget(interrupted.budgetId);
  if (!previousBudget || previousBudget.state !== "exhausted"
    || previousBudget.reservedCalls !== 0 || Date.parse(previousBudget.deadline) > Date.now()) {
    throw new Error("Previous replay budget is not closed and fully reconciled.");
  }
  const unsettled = (await pool.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM model_calls
      WHERE organization_id=$1 AND budget_id=$2 AND state IN ('reserved','dispatched','unknown')`,
    [organization.id, interrupted.budgetId],
  )).rows[0];
  if (Number(unsettled?.n ?? 0) !== 0) {
    throw new Error("Previous replay has unsettled model calls.");
  }
}

interface Progress {
  schemaVersion: 1;
  mode: "source_reinterpret" | "historical_eval";
  historicalCutoff: string | null;
  runId: string;
  database: string;
  organizationId: string;
  model: string;
  pipelineVersion: string;
  inputFingerprint: string;
  selectedEvents: number;
  totalEpisodes: number;
  budgetId: string;
  caps: { maxEvents: number; maxCalls: number; maxInputTokens: number;
    maxOutputTokens: number; maxWallSeconds: number; maxUsd: string; maxFailures: number };
  startedAt: string;
  deadline: string;
  nextEpisode: number;
  processedEvents: number;
  claims: number;
  assessments: number;
  pendingProposals: number;
  noEvidenceEpisodes: number;
  failures: { episode: number; eventIds: string[]; errorCode: string }[];
  stopReason: string | null;
  finishedAt: string | null;
  usage: { calls: number; inputTokens: number; outputTokens: number; estimatedUsd: string;
    unknownCalls: number; byPurpose?: Record<string, { calls: number; retries: number;
      inputTokens: number; cachedInputTokens: number; outputTokens: number;
      estimatedUsd: string; unknownCalls: number }> } | null;
  codeSegments?: { startedAt: string; fromEpisode: number; codeFingerprint: string }[];
  continuationFrom?: { report: string; runId: string; budgetId: string; nextEpisode: number };
  acceptedProjectionBefore?: AcceptedProjectionSnapshot;
  acceptedProjectionChange?: ReturnType<typeof acceptedProjectionDiff>;
}

await mkdir(path.dirname(reportFile), { recursive: true });
let progress: Progress;
try {
  progress = JSON.parse(await readFile(reportFile, "utf8")) as Progress;
  if (progress.database !== databaseName || progress.organizationId !== organization.id
    || progress.mode !== replayMode || progress.historicalCutoff !== historicalCutoff
    || progress.model !== model || progress.inputFingerprint !== inputFingerprint
    || progress.pipelineVersion !== pipelineVersion
    || progress.selectedEvents !== selected.length || progress.totalEpisodes !== episodes.length
    || progress.caps.maxEvents !== maxEvents || progress.caps.maxCalls !== maxCalls
    || progress.caps.maxInputTokens !== maxInputTokens
    || progress.caps.maxOutputTokens !== maxOutputTokens
    || progress.caps.maxWallSeconds !== maxWallSeconds
    || progress.caps.maxFailures !== maxFailures || progress.caps.maxUsd !== maxUsd
    || !Number.isFinite(Date.parse(progress.deadline))
    || progress.nextEpisode < 0 || progress.nextEpisode > episodes.length) {
    throw new Error("Existing replay report does not match this target, input, or budget.");
  }
  if (interrupted && (progress.continuationFrom?.report !== checkedArtifactPath(continuePath!)
    || progress.continuationFrom?.runId !== interrupted.runId
    || progress.continuationFrom?.budgetId !== interrupted.budgetId
    || progress.continuationFrom?.nextEpisode !== interrupted.nextEpisode)) {
    throw new Error("Existing continuation does not match the interrupted replay.");
  }
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  const budget = baseBudget ? { id: baseBudget.budgetId } : await store.createInferenceBudget({ label: `${replayMode}-${randomUUID()}`,
    maxCalls, maxInputTokens, maxOutputTokens, maxUsd,
    deadline, priceBasis: { models: [{ ...GPT6_LUNA_PRICE_2026_10_01 },
      { ...WORK_EMBEDDING_PRICE_2026_10_01 }] } });
  progress = { schemaVersion: 1, mode: replayMode as Progress["mode"],
    historicalCutoff, runId: randomUUID(),
    database: databaseName, organizationId: organization.id, model,
    pipelineVersion, inputFingerprint,
    selectedEvents: selected.length, totalEpisodes: episodes.length, budgetId: budget.id,
    caps: { maxEvents, maxCalls, maxInputTokens, maxOutputTokens, maxWallSeconds,
      maxUsd, maxFailures }, startedAt: interrupted?.startedAt ?? startedAt,
      deadline, nextEpisode: interrupted?.nextEpisode ?? 0,
    processedEvents: interrupted?.processedEvents ?? 0, claims: interrupted?.claims ?? 0,
    assessments: interrupted?.assessments ?? 0,
    pendingProposals: interrupted?.pendingProposals ?? 0,
    noEvidenceEpisodes: interrupted?.noEvidenceEpisodes ?? 0,
    failures: interrupted?.failures ?? [], stopReason: null, finishedAt: null, usage: null,
    acceptedProjectionBefore: await acceptedProjectionSnapshot(store),
    ...(interrupted ? { continuationFrom: { report: checkedArtifactPath(continuePath!),
      runId: interrupted.runId, budgetId: interrupted.budgetId,
      nextEpisode: interrupted.nextEpisode } } : {}) };
}
const persistedBudget = await store.getInferenceBudget(progress.budgetId);
if (!persistedBudget || persistedBudget.state !== "active"
  || persistedBudget.maxCalls !== maxCalls
  || persistedBudget.maxInputTokens !== maxInputTokens
  || persistedBudget.maxOutputTokens !== maxOutputTokens
  || Number(persistedBudget.maxUsd) !== Number(maxUsd)
  || persistedBudget.deadline !== progress.deadline
  || persistedBudget.reservedCalls !== 0) {
  throw new Error("Replay budget is missing, changed, inactive, or has unsettled calls.");
}
progress.codeSegments ??= [];
progress.codeSegments.push({ startedAt, fromEpisode: progress.nextEpisode, codeFingerprint });
const save = async () => {
  const temporary = `${reportFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(progress, null, 2), { mode: 0o600 });
  await rename(temporary, reportFile);
};
await save();
progress.stopReason = null;
progress.finishedAt = null;
const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
  autoApproveContext: false, requireReviewForTaskChanges: true }));
const extractor = new OpenAIClaimExtractor({ store, apiKey, model, allowedVisibilities: allowed,
  priceBasis: GPT6_LUNA_PRICE_2026_10_01,
  baseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1" });
const workEmbeddings = workEmbeddingsEnabled
  ? new BudgetedWorkEmbeddings({ store, apiKey,
    baseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1" }) : null;
const identityResolver = new OpenAITaskIdentityResolver({ store, apiKey, model,
  allowedVisibilities: allowed, allowTaskContextEgress: true,
  ...(workEmbeddings ? { embeddings: workEmbeddings,
    permissionVersion: progress.pipelineVersion } : {}),
  priceBasis: GPT6_LUNA_PRICE_2026_10_01,
  baseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1" });
const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion: progress.pipelineVersion,
  extractor, identityResolver,
  judge: new OpenAIEvidenceJudge({ store, apiKey, model,
    allowedVisibilities: allowed, priceBasis: GPT6_LUNA_PRICE_2026_10_01,
    baseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1" }) });
try {
  const invocationStart = progress.nextEpisode;
  for (let index = progress.nextEpisode; index < episodes.length; index += 1) {
    if (index - invocationStart >= invocationEpisodeLimit) {
      progress.stopReason = "pilot_pause";
      break;
    }
    if (Date.now() >= Date.parse(progress.deadline)) { progress.stopReason = "wall_deadline"; break; }
    const eventIds = episodes[index]!.events.map((event) => event.id);
    try {
      const report = await pipeline.run({ eventIds, budgetId: progress.budgetId,
        evaluationClock: historicalCutoff ?? progress.startedAt,
        knowledgeCutoff: historicalCutoff ?? progress.startedAt,
        replayMode: replayMode === "historical_eval" ? "historical_eval" : "source_reinterpret",
        historicalEvaluation: replayMode === "historical_eval" });
      progress.processedEvents += report.processedEventIds.length;
      progress.claims += report.claimCount;
      progress.assessments += report.assessmentCount;
      progress.pendingProposals += report.pendingProposalCount;
      progress.noEvidenceEpisodes += Number(report.state === "no_evidence");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const errorCode = message.includes("budget exhausted") ? "budget_exhausted"
        : message.includes("output is incomplete") ? "incomplete_output"
          : message.includes("external-text screen") ? "egress_screen"
            : message.includes("timed out") ? "timeout" : "episode_failed";
      progress.failures.push({ episode: index, eventIds, errorCode });
      progress.stopReason = errorCode === "budget_exhausted" ? "budget_exhausted"
        : new Set(progress.failures.map((failure) => failure.episode)).size >= maxFailures
          ? "failure_cap" : "episode_failed";
      progress.nextEpisode = index;
      await save();
      break;
    }
    progress.nextEpisode = index + 1;
    await save();
  }
  if (!progress.stopReason) progress.stopReason = progress.nextEpisode >= episodes.length
    ? "completed" : "stopped";
  if (progress.acceptedProjectionBefore) {
    progress.acceptedProjectionChange = acceptedProjectionDiff(progress.acceptedProjectionBefore,
      await acceptedProjectionSnapshot(store));
    if (!progress.acceptedProjectionChange.unchanged) {
      progress.stopReason = "accepted_projection_changed";
      process.exitCode = 1;
    }
  }
  const usage = await pool.query<{ calls: string; input_tokens: string; output_tokens: string;
    estimated_usd: string; unknown_calls: string }>(
    `SELECT count(*)::text AS calls,coalesce(sum(input_tokens),0)::text AS input_tokens,
       coalesce(sum(output_tokens),0)::text AS output_tokens,
       coalesce(sum(cost_usd),0)::text AS estimated_usd,
       count(*) FILTER (WHERE cost_basis='unknown' OR state='unknown'
         OR cost_usd IS NULL)::text AS unknown_calls
     FROM model_calls WHERE budget_id=$1`, [progress.budgetId]);
  const totals = usage.rows[0]!;
  progress.usage = { calls: Number(totals.calls), inputTokens: Number(totals.input_tokens),
    outputTokens: Number(totals.output_tokens), estimatedUsd: totals.estimated_usd,
    unknownCalls: Number(totals.unknown_calls) };
  const purposeRows = (await pool.query<{ purpose: string; calls: string; retries: string;
    input_tokens: string; cached_input_tokens: string; output_tokens: string;
    estimated_usd: string; unknown_calls: string }>(
    `SELECT purpose,count(*)::text AS calls,
       count(*) FILTER (WHERE attempt>1)::text AS retries,
       coalesce(sum(input_tokens),0)::text AS input_tokens,
       coalesce(sum(cached_input_tokens),0)::text AS cached_input_tokens,
       coalesce(sum(output_tokens),0)::text AS output_tokens,
       coalesce(sum(cost_usd),0)::text AS estimated_usd,
       count(*) FILTER (WHERE cost_basis='unknown' OR state='unknown'
         OR cost_usd IS NULL)::text AS unknown_calls
     FROM model_calls WHERE budget_id=$1 GROUP BY purpose ORDER BY purpose`,
    [progress.budgetId])).rows;
  progress.usage.byPurpose = Object.fromEntries(purposeRows.map((row) => [row.purpose, {
    calls: Number(row.calls), retries: Number(row.retries),
    inputTokens: Number(row.input_tokens),
    cachedInputTokens: Number(row.cached_input_tokens),
    outputTokens: Number(row.output_tokens), estimatedUsd: row.estimated_usd,
    unknownCalls: Number(row.unknown_calls),
  }]));
  const costReport = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database: progress.database, organizationId: progress.organizationId,
    budgetId: progress.budgetId, inputFingerprint: progress.inputFingerprint,
    pipelineVersion: progress.pipelineVersion, stopReason: progress.stopReason,
    sourceObservations: progress.selectedEvents, processedObservations: progress.processedEvents,
    acceptedProjectionChange: progress.acceptedProjectionChange ?? null,
    usage: progress.usage,
    coverage: "V2 budgeted model and artifact calls only; connector polling and legacy adapters are not included",
    savingsClaimAllowed: false };
  const costFile = reportFile.replace(/\.json$/, ".cost-report.json");
  const costTemporary = `${costFile}.${process.pid}.tmp`;
  await writeFile(costTemporary, JSON.stringify(costReport, null, 2), { mode: 0o600 });
  await rename(costTemporary, costFile);
  progress.finishedAt = new Date().toISOString();
  await save();
  console.log(JSON.stringify({ report: reportFile, database: progress.database,
    selectedEvents: progress.selectedEvents, processedEvents: progress.processedEvents,
    claims: progress.claims, assessments: progress.assessments,
    pendingProposals: progress.pendingProposals, failures: progress.failures.length,
    stopReason: progress.stopReason, usage: progress.usage }));
} finally { await store.close(); await pool.end(); }
