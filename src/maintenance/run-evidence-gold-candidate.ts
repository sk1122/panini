import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";
import { evidenceV2Default } from "../config.js";
import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { OpenAIClaimExtractor } from "../intelligence/claim-extractor.js";
import { EvidencePipeline } from "../intelligence/evidence-pipeline.js";
import { OpenAIEvidenceJudge } from "../intelligence/evidence-judge.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "../intelligence/model-price.js";
import { EmbeddingObservationEpisodeGrouper, packIndependentEpisodes } from "../intelligence/observation-episodes.js";
import { OpenAIWorkSearchResolver } from "../intelligence/work-search-resolver.js";
import { BudgetedVoyageEmbeddings, VOYAGE4_PRICE_2026_10_02 } from "../intelligence/voyage-work-embeddings.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const root = path.resolve("artifacts/evidence-state");
function artifact(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error(`${name} must be JSON under artifacts/evidence-state.`);
  }
  return resolved;
}
const manifestPath = artifact("PANINI_EVALUATION_MANIFEST");
const progressPath = artifact("PANINI_CANDIDATE_PROGRESS");
const output = artifact("PANINI_CANDIDATE_CASE_RUNS");
if (new Set([manifestPath, progressPath, output]).size !== 3) throw new Error("Artifacts must differ.");
const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.PANINI_REPLAY_DATABASE;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
const apiKey = process.env.INTELLIGENCE_API_KEY;
const visibility = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",")
  .map((value) => value.trim()).filter(Boolean);
if (!databaseUrl || !expectedDatabase || !/^panini_replay_[a-z0-9_]+$/.test(expectedDatabase)
  || !contentKey || !apiKey || !visibility.length) {
  throw new Error("Candidate evaluation requires an asserted isolated replay database, keys, and visibility scope.");
}
const manifest = z.strictObject({ schemaVersion: z.literal(1), goldHash: z.string(),
  inputFingerprint: z.string(), modelBudgetHash: z.string(),
  inputManifest: z.array(z.strictObject({ id: z.string().min(1),
    sourceEventIds: z.array(z.uuid()).min(1), cutoff: z.iso.datetime() })).min(1),
  modelBudget: z.strictObject({ model: z.string(),
    embeddingModel: z.literal("voyageai/voyage-4").nullable().optional(),
    maxCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
    maxWallSeconds: z.number().int().positive(), maxUsd: z.string() }) }).passthrough()
  .parse(JSON.parse(await readFile(manifestPath, "utf8")));
if (contentHash(manifest.inputManifest) !== manifest.inputFingerprint
  || contentHash(manifest.modelBudget) !== manifest.modelBudgetHash
  || manifest.modelBudget.model !== "gpt-6-luna"
  || process.env.PANINI_EVALUATION_AUTHORIZED !== "true"
  || process.env.PANINI_EVALUATION_APPROVED_CAP_HASH !== manifest.modelBudgetHash) {
  throw new Error("Candidate evaluation needs the frozen input, pinned Luna model, and a separately approved exact cap hash.");
}
async function sourceFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.resolve(directory), { withFileTypes: true })) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(relative));
    else if (entry.isFile() && /\.(?:ts|js|json|sql)$/.test(relative)) files.push(relative);
  }
  return files;
}
const codeFiles = [...await sourceFiles("src"), ...await sourceFiles("drizzle"),
  "package.json", "pnpm-lock.yaml"].sort();
const codeFingerprint = contentHash(await Promise.all(codeFiles.map(async (file) =>
  [file, createHash("sha256").update(await readFile(path.resolve(file))).digest("hex")])));
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey, undefined,
  { backfillLegacyContent: false });
const guard = await pool.connect();
let locked = false;
const saveJson = async (file: string, value: unknown) => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, file);
};
type CaseProgress = { id: string; runIds: string[]; supersededSourceEventIds: string[];
  duplicateSourceEventIds: string[];
  nextEpisode: number; episodeFingerprint: string };
type Progress = { schemaVersion: 1; database: string; organizationId: string;
  goldHash: string; inputFingerprint: string; modelBudgetHash: string; codeFingerprint: string;
  budgetId: string; deadline: string; cases: CaseProgress[] };
try {
  const database = (await guard.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Candidate evaluation database assertion failed.");
  locked = (await guard.query<{ locked: boolean }>(
    "SELECT pg_try_advisory_lock(hashtext('panini_gold_candidate'),hashtext(current_database())) AS locked",
  )).rows[0]?.locked ?? false;
  if (!locked) throw new Error("A candidate evaluation is already running in this database.");
  const organization = await store.getOrganization();
  let progress: Progress;
  try {
    progress = JSON.parse(await readFile(progressPath, "utf8")) as Progress;
    if (progress.schemaVersion !== 1 || progress.database !== expectedDatabase
      || progress.organizationId !== organization.id || progress.goldHash !== manifest.goldHash
      || progress.inputFingerprint !== manifest.inputFingerprint
      || progress.modelBudgetHash !== manifest.modelBudgetHash
      || progress.codeFingerprint !== codeFingerprint) {
      throw new Error("Existing candidate evaluation progress does not match the frozen setup.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const deadline = new Date(Date.now() + manifest.modelBudget.maxWallSeconds * 1_000).toISOString();
    const budget = await store.createInferenceBudget({ label: `gold-candidate-${randomUUID()}`,
      maxCalls: manifest.modelBudget.maxCalls,
      maxInputTokens: manifest.modelBudget.maxInputTokens,
      maxOutputTokens: manifest.modelBudget.maxOutputTokens,
      maxUsd: manifest.modelBudget.maxUsd, deadline,
      priceBasis: { models: [{ ...GPT6_LUNA_PRICE_2026_10_01 },
        { ...VOYAGE4_PRICE_2026_10_02 }] } });
    progress = { schemaVersion: 1, database: expectedDatabase,
      organizationId: organization.id, goldHash: manifest.goldHash,
      inputFingerprint: manifest.inputFingerprint, modelBudgetHash: manifest.modelBudgetHash,
      codeFingerprint,
      budgetId: budget.id, deadline, cases: [] };
    await saveJson(progressPath, progress);
  }
  const budget = await store.getInferenceBudget(progress.budgetId);
  if (!budget || budget.maxCalls !== manifest.modelBudget.maxCalls
    || budget.maxInputTokens !== manifest.modelBudget.maxInputTokens
    || budget.maxOutputTokens !== manifest.modelBudget.maxOutputTokens
    || Number(budget.maxUsd) !== Number(manifest.modelBudget.maxUsd)
    || budget.deadline !== progress.deadline || budget.state !== "active") {
    throw new Error("Candidate budget is missing, changed, or closed.");
  }
  const ledger = new TeamLedger(store, new ProposalPolicy({ autoApproveNewTasks: false,
    autoApproveContext: false, requireReviewForTaskChanges: true }));
  const baseUrl = process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1";
  const embeddings = manifest.modelBudget.embeddingModel === "voyageai/voyage-4"
    ? new BudgetedVoyageEmbeddings({ store, apiKey: process.env.OPENROUTER_API_KEY ?? "" }) : null;
  const identityResolver = new OpenAIWorkSearchResolver({ store, apiKey,
    model: manifest.modelBudget.model, allowedVisibilities: visibility,
    priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl,
    ...(embeddings ? { embeddings } : {}) });
  for (const input of manifest.inputManifest) {
    if (Date.now() >= Date.parse(progress.deadline)) throw new Error("Candidate evaluation wall deadline reached.");
    const sources = await store.getSourceEvents(input.sourceEventIds);
    if (sources.length !== input.sourceEventIds.length
      || sources.some((source) => source.receivedAt > input.cutoff
        || !visibility.includes(source.visibility))) {
      throw new Error(`Missing, post-cutoff, or disallowed source in ${input.id}.`);
    }
    const currentIds = new Set(await store.currentSourceEventIds(input.sourceEventIds, input.cutoff));
    const current = sources.filter((source) => currentIds.has(source.id))
      .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
        || left.id.localeCompare(right.id));
    const seenOrigins = new Set<string>();
    const duplicateSourceEventIds: string[] = [];
    const selected = current.filter((source) => {
      const origin = source.observationIdentity?.originObservationKey ?? source.id;
      if (seenOrigins.has(origin)) { duplicateSourceEventIds.push(source.id); return false; }
      seenOrigins.add(origin);
      return true;
    });
    if (!selected.length) throw new Error(`No current source version for ${input.id}.`);
    const supersededSourceEventIds = input.sourceEventIds.filter((id) => !currentIds.has(id)).sort();
    const episodes = packIndependentEpisodes(
      await new EmbeddingObservationEpisodeGrouper(null, []).group(selected, 20), 20, 30_000);
    const episodeFingerprint = contentHash(episodes.map((episode) =>
      episode.events.map((source) => source.id)));
    let caseProgress = progress.cases.find((item) => item.id === input.id);
    if (!caseProgress) {
      caseProgress = { id: input.id, runIds: [], supersededSourceEventIds,
        duplicateSourceEventIds,
        nextEpisode: 0, episodeFingerprint };
      progress.cases.push(caseProgress);
      await saveJson(progressPath, progress);
    }
    if (caseProgress.episodeFingerprint !== episodeFingerprint
      || contentHash(caseProgress.supersededSourceEventIds) !== contentHash(supersededSourceEventIds)
      || contentHash(caseProgress.duplicateSourceEventIds) !== contentHash(duplicateSourceEventIds)
      || caseProgress.nextEpisode > episodes.length
      || caseProgress.runIds.length !== caseProgress.nextEpisode) {
      throw new Error(`Candidate ${input.id} episode grouping changed during resume.`);
    }
    const pipelineVersion = `evidence-v2-gold-${codeFingerprint.slice(0, 8)}-${contentHash(input.id).slice(0, 16)}`;
    const extractor = new OpenAIClaimExtractor({ store, apiKey, model: manifest.modelBudget.model,
      allowedVisibilities: visibility, priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl });
    const pipeline = new EvidencePipeline({ store, ledger, pipelineVersion,
      sourceContext: { allowedVisibilities: visibility,
        maxEvents: evidenceV2Default.maxContextObservations,
        maxPayloadBytes: evidenceV2Default.maxInputTokens },
      extractor, identityResolver, contextResolver: identityResolver,
      judge: new OpenAIEvidenceJudge({ store, apiKey, model: manifest.modelBudget.model,
        allowedVisibilities: visibility, priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl }),
      application: { mode: "review", autoApplyClasses: [], authorityPolicies: [] },
      maxEvidenceExpansions: 0 });
    for (let index = caseProgress.nextEpisode; index < episodes.length; index += 1) {
      const eventIds = episodes[index]!.events.map((source) => source.id);
      const previous = (await pool.query<{ id: string }>(
        `SELECT id FROM interpretation_runs WHERE organization_id=$1
           AND pipeline_version=$2 AND replay_mode='historical_eval'
           AND knowledge_cutoff=$3::timestamptz AND event_ids=$4::uuid[]
           AND state='completed' ORDER BY created_at DESC,id DESC LIMIT 1`,
        [organization.id, pipelineVersion, input.cutoff, eventIds],
      )).rows[0];
      const runId = previous?.id ?? (await pipeline.run({ eventIds,
        budgetId: progress.budgetId, evaluationClock: input.cutoff,
        knowledgeCutoff: input.cutoff, replayMode: "historical_eval",
        historicalEvaluation: true })).runId;
      if (!runId) throw new Error(`Candidate ${input.id} episode produced no durable run.`);
      caseProgress.runIds.push(runId);
      caseProgress.nextEpisode = index + 1;
      await saveJson(progressPath, progress);
    }
    process.stdout.write(`${JSON.stringify({ caseId: input.id,
      episodes: caseProgress.runIds.length, totalCases: manifest.inputManifest.length })}\n`);
  }
  if (progress.cases.length !== manifest.inputManifest.length
    || new Set(progress.cases.map((item) => item.id)).size !== progress.cases.length
    || progress.cases.some((item) => !manifest.inputManifest.some((input) => input.id === item.id))) {
    throw new Error("Candidate progress contains missing or unlisted cases.");
  }
  const report = { schemaVersion: 1, mode: "candidate", database: expectedDatabase,
    budgetId: progress.budgetId, goldHash: manifest.goldHash,
    inputFingerprint: manifest.inputFingerprint,
    modelBudgetHash: manifest.modelBudgetHash, codeFingerprint,
    cases: progress.cases.map(({ id, runIds, supersededSourceEventIds,
      duplicateSourceEventIds }) =>
      ({ id, runIds, supersededSourceEventIds, duplicateSourceEventIds })) };
  await saveJson(output, report);
  process.stdout.write(`${JSON.stringify({ report: output, cases: report.cases.length,
    budgetId: progress.budgetId })}\n`);
} finally {
  try { await store.close(); } finally {
    if (locked) await guard.query(
      "SELECT pg_advisory_unlock(hashtext('panini_gold_candidate'),hashtext(current_database()))",
    ).catch(() => undefined);
    guard.release();
    await pool.end();
  }
}
