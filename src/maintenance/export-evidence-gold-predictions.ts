import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";
import type { EvidenceAssessment, EvidenceClaim, WorkRelationship } from "../domain/evidence-types.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const root = path.resolve("artifacts/evidence-state");
function artifact(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(`${name} is required.`);
  const resolved = path.resolve(raw);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error(`${name} must be a JSON artifact under artifacts/evidence-state.`);
  }
  return resolved;
}
const evaluationPath = artifact("PANINI_EVALUATION_MANIFEST");
const runMapPath = artifact("PANINI_CANDIDATE_CASE_RUNS");
const output = artifact("PANINI_CANDIDATE_PREDICTIONS");
if (new Set([evaluationPath, runMapPath, output]).size !== 3) throw new Error("Artifacts must differ.");
const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.PANINI_REPLAY_DATABASE;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
if (!databaseUrl || !expectedDatabase || !/^panini_replay_[a-z0-9_]+$/.test(expectedDatabase)
  || !contentKey) throw new Error("An asserted isolated replay database and content key are required.");

const evaluation = z.strictObject({ schemaVersion: z.literal(1),
  goldHash: z.string().regex(/^[a-f0-9]{64}$/), inputFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  modelBudgetHash: z.string().regex(/^[a-f0-9]{64}$/),
  inputManifest: z.array(z.strictObject({ id: z.string().min(1),
    sourceEventIds: z.array(z.uuid()).min(1), cutoff: z.iso.datetime() })).min(1),
  modelBudget: z.strictObject({ model: z.string().min(1),
    embeddingModel: z.literal("voyageai/voyage-4").nullable().optional(),
    maxCalls: z.number().int().positive(),
    maxInputTokens: z.number().int().positive(), maxOutputTokens: z.number().int().positive(),
    maxWallSeconds: z.number().int().positive(), maxUsd: z.string().min(1) }) }).passthrough()
  .parse(JSON.parse(await readFile(evaluationPath, "utf8")));
if (contentHash(evaluation.inputManifest) !== evaluation.inputFingerprint
  || contentHash(evaluation.modelBudget) !== evaluation.modelBudgetHash) {
  throw new Error("Evaluation input or model budget changed after preparation.");
}
const runMap = z.strictObject({ schemaVersion: z.literal(1), mode: z.literal("candidate"),
  database: z.string(), budgetId: z.uuid(), goldHash: z.string(), inputFingerprint: z.string(),
  modelBudgetHash: z.string(), codeFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  cases: z.array(z.strictObject({ id: z.string().min(1),
    runIds: z.array(z.uuid()).min(1), supersededSourceEventIds: z.array(z.uuid()),
    duplicateSourceEventIds: z.array(z.uuid()) })) })
  .parse(JSON.parse(await readFile(runMapPath, "utf8")));
if (runMap.database !== expectedDatabase || runMap.goldHash !== evaluation.goldHash
  || runMap.inputFingerprint !== evaluation.inputFingerprint
  || runMap.modelBudgetHash !== evaluation.modelBudgetHash
  || runMap.cases.length !== evaluation.inputManifest.length
  || new Set(runMap.cases.map((item) => item.id)).size !== runMap.cases.length
  || new Set(runMap.cases.flatMap((item) => item.runIds)).size
    !== runMap.cases.flatMap((item) => item.runIds).length) {
  throw new Error("Candidate run map is incomplete, duplicated, or mismatched.");
}
type Finding = { taskId: string | null; relationship: WorkRelationship;
  transition: { field: "status" | "result" | "owner" | "project" | "priority"
    | "task_create" | "context_create"; value: string } | null;
  claim: string; scope: string | null; action: "proposed" | "review";
  usedSources: { id: string; knownAt: string }[] };

const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, contentKey, undefined,
  { backfillLegacyContent: false });
try {
  const database = (await pool.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Candidate prediction database assertion failed.");
  const organization = await store.getOrganization();
  const budget = await store.getInferenceBudget(runMap.budgetId);
  if (!budget || budget.maxCalls !== evaluation.modelBudget.maxCalls
    || budget.maxInputTokens !== evaluation.modelBudget.maxInputTokens
    || budget.maxOutputTokens !== evaluation.modelBudget.maxOutputTokens
    || Number(budget.maxUsd) !== Number(evaluation.modelBudget.maxUsd)) {
    throw new Error("Candidate inference budget differs from the frozen evaluation cap.");
  }
  const allCallRows: { runId: string; id: string; purpose: string; state: string;
    inputTokens: number | null; outputTokens: number | null; costUsd: string | null;
    costBasis: string }[] = [];
  const cases = [];
  let totalClaims = 0;
  let totalProposals = 0;
  for (const input of evaluation.inputManifest) {
    const mapped = runMap.cases.find((item) => item.id === input.id);
    if (!mapped) throw new Error(`No run map for ${input.id}.`);
    const runs = (await pool.query<{ id: string; model: string; state: string; event_ids: string[];
      replay_mode: string | null; knowledge_cutoff: Date | null;
      created_at: Date; completed_at: Date | null }>(
      `SELECT id,model,state,event_ids,replay_mode,knowledge_cutoff,created_at,completed_at
         FROM interpretation_runs WHERE organization_id=$1 AND id=ANY($2::uuid[])`,
      [organization.id, mapped.runIds],
    )).rows;
    const sources = await store.getSourceEvents(input.sourceEventIds);
    if (sources.length !== input.sourceEventIds.length
      || sources.some((source) => source.receivedAt > input.cutoff)) {
      throw new Error(`Frozen sources are missing or post-cutoff for ${input.id}.`);
    }
    const currentIds = await store.currentSourceEventIds(input.sourceEventIds, input.cutoff);
    if (contentHash([...currentIds].sort())
      !== contentHash(input.sourceEventIds.filter((id) =>
        !mapped.supersededSourceEventIds.includes(id)).sort())
      || new Set(mapped.supersededSourceEventIds).size !== mapped.supersededSourceEventIds.length
      || mapped.supersededSourceEventIds.some((id) => !input.sourceEventIds.includes(id))
      || new Set(mapped.duplicateSourceEventIds).size !== mapped.duplicateSourceEventIds.length
      || mapped.duplicateSourceEventIds.some((id) => !currentIds.includes(id))) {
      throw new Error(`Superseded source exclusion is invalid for ${input.id}.`);
    }
    const bySourceId = new Map(sources.map((source) => [source.id, source]));
    const selectedCurrent = currentIds.filter((id) => !mapped.duplicateSourceEventIds.includes(id));
    const selectedOrigins = new Set(selectedCurrent.map((id) =>
      bySourceId.get(id)?.observationIdentity?.originObservationKey ?? id));
    if (selectedOrigins.size !== selectedCurrent.length || mapped.duplicateSourceEventIds.some((id) =>
      !selectedOrigins.has(bySourceId.get(id)?.observationIdentity?.originObservationKey ?? id))) {
      throw new Error(`Duplicate origin exclusions are invalid for ${input.id}.`);
    }
    if (runs.length !== mapped.runIds.length || runs.some((run) => run.state !== "completed"
      || run.model !== `openai-claims:${evaluation.modelBudget.model}:v2`
      || run.replay_mode !== "historical_eval" || !run.completed_at
      || run.knowledge_cutoff?.toISOString() !== input.cutoff)
      || contentHash([...new Set(runs.flatMap((run) => run.event_ids))].sort())
        !== contentHash([...selectedCurrent].sort())) {
      throw new Error(`Historical run coverage or cutoff mismatch for ${input.id}.`);
    }
    const knownAt = new Map(sources.map((source) => [source.id, source.receivedAt]));
    const claims = (await Promise.all(mapped.runIds.map((id) => store.listClaimsByRun(id)))).flat();
    const claimIds = new Set(claims.map((claim) => claim.id));
    const assessmentRows = (await pool.query<{ id: string }>(
      `SELECT id FROM evidence_assessments WHERE organization_id=$1
         AND run_id=ANY($2::uuid[]) ORDER BY created_at,id`,
      [organization.id, mapped.runIds],
    )).rows;
    const assessments = await Promise.all(assessmentRows.map((row) => store.getAssessment(row.id)));
    if (assessments.some((assessment) => !assessment
      || assessment.claimIds.some((id) => !claimIds.has(id)))) {
      throw new Error(`Missing or externally linked assessment for ${input.id}.`);
    }
    const byClaim = new Map(claims.map((claim) => [claim.id, claim]));
    const findings = assessments.flatMap<Finding>((assessment) => {
      const item = assessment as EvidenceAssessment;
      const sourceClaims = item.claimIds.map((id) => byClaim.get(id)!);
      const primary = sourceClaims[0];
      if (!primary) return [];
      const spans = sourceClaims.flatMap((claim) => claim.body.spans);
      const ids = [...new Set(spans.map((span) => span.eventId))].sort();
      if (ids.some((id) => !knownAt.has(id))) {
        throw new Error(`Assessment uses an unlisted source for ${input.id}.`);
      }
      const usedSources = ids.map((id) => ({ id, knownAt: knownAt.get(id)! }));
      const base = { taskId: item.targetType === "task" ? item.targetId : null,
        relationship: item.relationship,
        claim: primary.body.statement,
        scope: primary.body.subjectRefs.length ? primary.body.subjectRefs.join("; ") : null,
        usedSources };
      if (item.targetType === "task_create" && item.reasonCodes.includes("new_work_requires_review")) {
        return [{ ...base, transition: { field: "task_create" as const,
          value: primary.body.statement }, action: "proposed" as const }];
      }
      if (item.targetType === "context_create"
        && item.reasonCodes.includes("atomic_context_requires_review")
        && !item.reasonCodes.includes("already_current")) {
        return [{ ...base, transition: { field: "context_create" as const,
          value: primary.body.statement }, action: "proposed" as const }];
      }
      if (item.targetType !== "task") return [{ ...base, transition: null,
        action: "review" as const }];
      const fields = item.body.fields.filter((field) => field.verdict === "supported"
        && field.operation.op === "set"
        && ["status", "result", "owner", "project", "priority"].includes(field.operation.field));
      if (!fields.length) return [{ ...base, transition: null, action: "review" as const }];
      return fields.map((field) => ({ ...base, transition: {
        field: field.operation.field as "status" | "result" | "owner" | "project" | "priority",
        value: String((field.operation as { value: unknown }).value) },
      action: item.relationship === "same_outcome"
        && !item.reasonCodes.includes("already_current") ? "proposed" as const : "review" as const }));
    });
    const sorted = findings.map((finding, index) => ({ ...finding,
      id: `${input.id}:finding:${String(index + 1).padStart(4, "0")}` }));
    const primary = sorted[0] ?? null;
    const fallbackClaim: EvidenceClaim | null = claims[0] ?? null;
    totalClaims += claims.length;
    totalProposals += sorted.filter((finding) => finding.action === "proposed").length;
    const calls = (await pool.query<{ run_id: string; id: string; purpose: string; state: string;
      input_tokens: string | null; output_tokens: string | null;
      cost_usd: string | null; cost_basis: string }>(
      `SELECT run_id,id,purpose,state,input_tokens::text,output_tokens::text,
          cost_usd::text,cost_basis FROM model_calls WHERE organization_id=$1
          AND run_id=ANY($2::uuid[]) AND budget_id=$3 ORDER BY run_id,id`,
      [organization.id, mapped.runIds, runMap.budgetId],
    )).rows.map((row) => ({ runId: row.run_id, id: row.id, purpose: row.purpose,
      state: row.state, inputTokens: row.input_tokens === null ? null : Number(row.input_tokens),
      outputTokens: row.output_tokens === null ? null : Number(row.output_tokens),
      costUsd: row.cost_usd, costBasis: row.cost_basis }));
    allCallRows.push(...calls);
    const unrelatedCalls = (await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM model_calls WHERE organization_id=$1
         AND run_id=ANY($2::uuid[]) AND budget_id<>$3`,
      [organization.id, mapped.runIds, runMap.budgetId],
    )).rows[0];
    if (Number(unrelatedCalls?.count ?? 0) !== 0) {
      throw new Error(`Candidate ${input.id} used another inference budget.`);
    }
    const completeCost = calls.every((call) => call.state === "succeeded"
      && call.costBasis !== "unknown" && call.costUsd !== null);
    const costUsd = completeCost ? calls.reduce((sum, call) => sum + Number(call.costUsd), 0) : null;
    cases.push({ id: input.id, cutoff: input.cutoff,
      taskId: primary?.taskId ?? null, relationship: primary?.relationship ?? "uncertain",
      transition: primary?.transition ?? null,
      claim: primary?.claim ?? fallbackClaim?.body.statement ?? null,
      scope: primary?.scope ?? (fallbackClaim?.body.subjectRefs.length
        ? fallbackClaim.body.subjectRefs.join("; ") : null),
      action: primary?.action ?? "abstain", usedSources: primary?.usedSources ?? [],
      additionalFindings: sorted.slice(1),
      latencyMs: runs.reduce((sum, run) => sum
        + run.completed_at!.getTime() - run.created_at.getTime(), 0), costUsd });
  }
  const report = { schemaVersion: 1, label: "evidence-v2-historical-evaluation",
    goldHash: evaluation.goldHash, inputFingerprint: evaluation.inputFingerprint,
    modelBudgetHash: evaluation.modelBudgetHash, mode: "candidate", database,
    codeFingerprint: runMap.codeFingerprint,
    inputManifest: evaluation.inputManifest, modelBudget: evaluation.modelBudget,
    totals: { episodes: runMap.cases.reduce((sum, item) => sum + item.runIds.length, 0),
      claims: totalClaims, proposals: totalProposals, acceptedChanges: 0 },
    callLedgerHash: contentHash(allCallRows), cases };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(`${JSON.stringify({ report: output, cases: cases.length,
    claims: totalClaims, proposals: totalProposals,
    unknownCostCases: cases.filter((item) => item.costUsd === null).length })}\n`);
} finally { await store.close(); await pool.end(); }
