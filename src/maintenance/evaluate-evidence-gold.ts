import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";

const transition = z.strictObject({ field: z.enum(["status", "result", "owner", "project", "priority", "task_create", "context_create"]),
  value: z.string() });
const relationship = z.enum(["same_outcome", "part_of", "related", "unrelated", "uncertain"]);
const goldCase = z.strictObject({ id: z.string().min(1), split: z.enum(["development", "holdout"]),
  clusterId: z.string().min(1), taskId: z.uuid().nullable(),
  sourceEventIds: z.array(z.uuid()).min(1), cutoff: z.iso.datetime(),
  expectedRelationship: relationship, expectedTransition: transition.nullable(),
  expectedClaim: z.string().trim().min(1).nullable(),
  expectedScope: z.string().trim().min(1).nullable(),
  supportingSourceEventIds: z.array(z.uuid()),
  adjudication: z.enum(["confirmed", "unresolved"]), reviewer: z.string().min(1),
  rationale: z.string().min(1), ambiguityStatus: z.enum(["clear", "ambiguous"]) });
const goldSchema = z.strictObject({ schemaVersion: z.literal(1),
  packetCasesHash: z.string().regex(/^[0-9a-f]{64}$/), frozenAt: z.iso.datetime(),
  frozenHash: z.string().regex(/^[0-9a-f]{64}$/), cases: z.array(goldCase).min(1) });
const predictedFinding = z.strictObject({ id: z.string().min(1), taskId: z.uuid().nullable(),
  relationship, transition: transition.nullable(), claim: z.string().trim().min(1).nullable(),
  scope: z.string().trim().min(1).nullable(),
  action: z.enum(["applied", "proposed", "review", "abstain"]),
  usedSources: z.array(z.strictObject({ id: z.uuid(), knownAt: z.iso.datetime() })) });
const predictionCase = z.strictObject({ id: z.string().min(1), cutoff: z.iso.datetime(),
  taskId: z.uuid().nullable(), relationship, transition: transition.nullable(),
  claim: z.string().trim().min(1).nullable(), scope: z.string().trim().min(1).nullable(),
  action: z.enum(["applied", "proposed", "review", "abstain"]),
  usedSources: z.array(z.strictObject({ id: z.uuid(), knownAt: z.iso.datetime() })),
  additionalFindings: z.array(predictedFinding),
  latencyMs: z.number().finite().nonnegative(), costUsd: z.number().finite().nonnegative().nullable() });
const predictionSchema = z.strictObject({ schemaVersion: z.literal(1), label: z.string().min(1),
  codeFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  database: z.string().min(1).optional(),
  goldHash: z.string().regex(/^[0-9a-f]{64}$/), inputFingerprint: z.string().min(1),
  modelBudgetHash: z.string().min(1), mode: z.enum(["baseline_historical", "baseline_contemporary", "candidate"]),
  inputManifest: z.array(z.strictObject({ id: z.string().min(1),
    sourceEventIds: z.array(z.uuid()).min(1), cutoff: z.iso.datetime() })),
  modelBudget: z.strictObject({ model: z.string().min(1),
    embeddingModel: z.literal("voyageai/voyage-4").nullable().optional(),
    maxCalls: z.number().int().positive(), maxInputTokens: z.number().int().positive(),
    maxOutputTokens: z.number().int().positive(), maxWallSeconds: z.number().int().positive(),
    maxUsd: z.string().regex(/^\d+(?:\.\d{1,8})?$/) }),
  totals: z.strictObject({ episodes: z.number().int().nonnegative(),
    claims: z.number().int().nonnegative(), proposals: z.number().int().nonnegative(),
    acceptedChanges: z.number().int().nonnegative() }),
  callLedgerHash: z.string().regex(/^[0-9a-f]{64}$/), cases: z.array(predictionCase) });

type GoldCase = z.infer<typeof goldCase>;
type PredictionCase = z.infer<typeof predictionCase>;
type PredictedFinding = z.infer<typeof predictedFinding>;

function wilson(successes: number, total: number): { low: number; high: number } | null {
  if (total === 0) return null;
  const zScore = 1.96;
  const p = successes / total;
  const denominator = 1 + zScore ** 2 / total;
  const center = (p + zScore ** 2 / (2 * total)) / denominator;
  const margin = zScore * Math.sqrt(p * (1 - p) / total + zScore ** 2 / (4 * total ** 2)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

function transitionKey(value: GoldCase["expectedTransition"] | PredictionCase["transition"]): string | null {
  return value ? `${value.field}:${value.value}` : null;
}

function normalizedText(value: string | null): string | null {
  return value?.trim().replace(/\s+/g, " ").toLocaleLowerCase("en-US") ?? null;
}

function isNoActionAbstention(gold: GoldCase, prediction: PredictionCase): boolean {
  return gold.taskId === null && gold.expectedTransition === null
    && ["unrelated", "uncertain"].includes(gold.expectedRelationship)
    && prediction.taskId === null && prediction.transition === null
    && prediction.action === "abstain";
}

function score(cases: GoldCase[], predictions: Map<string, PredictionCase>) {
  const confirmed = cases.filter((item) => item.adjudication === "confirmed"
    && item.ambiguityStatus === "clear");
  const selected = confirmed.map((item) => ({ gold: item, prediction: predictions.get(item.id)! }));
  const actionableAdditions = selected.flatMap(({ gold, prediction }) =>
    prediction.additionalFindings.filter((finding) =>
      finding.transition !== null && ["applied", "proposed"].includes(finding.action))
      .map((finding) => ({ gold, finding })));
  const expectedActions = selected.filter(({ gold }) => gold.expectedTransition !== null);
  const proposed = selected.filter(({ prediction }) => prediction.transition !== null
    && ["applied", "proposed"].includes(prediction.action));
  const correct = selected.filter(({ gold, prediction }) =>
    (isNoActionAbstention(gold, prediction) || (gold.taskId === prediction.taskId
      && gold.expectedRelationship === prediction.relationship
      && transitionKey(gold.expectedTransition) === transitionKey(prediction.transition)
      && (gold.expectedTransition === null || ["applied", "proposed"].includes(prediction.action))))
      && prediction.additionalFindings.every((finding) =>
        finding.transition === null || !["applied", "proposed"].includes(finding.action)));
  const correctActions = proposed.filter(({ gold, prediction }) =>
    gold.taskId === prediction.taskId
      && gold.expectedRelationship === prediction.relationship
      && transitionKey(gold.expectedTransition) === transitionKey(prediction.transition));
  const costs = selected.map(({ prediction }) => prediction.costUsd);
  const additions = selected.flatMap(({ prediction }) => prediction.additionalFindings);
  const supported = selected.filter(({ gold, prediction }) =>
    gold.supportingSourceEventIds.length > 0
      && gold.supportingSourceEventIds.some((sourceId) =>
        prediction.usedSources.some((source) => source.id === sourceId)));
  const claimExact = selected.filter(({ gold, prediction }) =>
    gold.expectedClaim !== null
      && normalizedText(gold.expectedClaim) === normalizedText(prediction.claim));
  const scopeExact = selected.filter(({ gold, prediction }) =>
    gold.expectedScope !== null
      && normalizedText(gold.expectedScope) === normalizedText(prediction.scope));
  return { totalCases: cases.length, confirmedScored: selected.length,
    additionalFindingsRequiringReview: additions.length,
    additionalActionFindingsRequiringReview: actionableAdditions.length,
    unresolvedExcluded: cases.filter((item) => item.adjudication === "unresolved").length,
    ambiguousExcluded: cases.filter((item) => item.adjudication === "confirmed"
      && item.ambiguityStatus === "ambiguous").length,
    expectedActions: expectedActions.length, proposedActions: proposed.length,
    correctActions: correctActions.length, exactCaseMatches: correct.length,
    falseCompletions: proposed.filter(({ gold, prediction }) =>
      prediction.transition?.field === "status" && prediction.transition.value === "done"
        && transitionKey(gold.expectedTransition) !== "status:done").length,
    unadjudicatedAdditionalCompletions: actionableAdditions.filter(({ finding }) =>
      finding.transition?.field === "status" && finding.transition.value === "done").length,
    missedCompletions: expectedActions.filter(({ gold, prediction }) =>
      transitionKey(gold.expectedTransition) === "status:done"
        && transitionKey(prediction.transition) !== "status:done").length,
    abstainedOrReview: selected.filter(({ prediction }) =>
      ["abstain", "review"].includes(prediction.action)).length,
    identityErrors: selected.filter(({ gold, prediction }) =>
      !isNoActionAbstention(gold, prediction)
        && (gold.taskId !== prediction.taskId
          || gold.expectedRelationship !== prediction.relationship)).length,
    sourceSupportedCases: supported.length,
    casesWithExpectedSupport: selected.filter(({ gold }) => gold.supportingSourceEventIds.length > 0).length,
    claimTextExactMatches: claimExact.length,
    casesWithExpectedClaim: selected.filter(({ gold }) => gold.expectedClaim !== null).length,
    scopeTextExactMatches: scopeExact.length,
    casesWithExpectedScope: selected.filter(({ gold }) => gold.expectedScope !== null).length,
    precision: actionableAdditions.length === 0 && proposed.length
      ? correctActions.length / proposed.length : null,
    precisionInterval95: actionableAdditions.length === 0
      ? wilson(correctActions.length, proposed.length) : null,
    precisionLowerBoundIfAdditionsIncorrect: proposed.length + actionableAdditions.length
      ? correctActions.length / (proposed.length + actionableAdditions.length) : null,
    precisionUpperBoundIfAdditionsCorrect: proposed.length + actionableAdditions.length
      ? (correctActions.length + actionableAdditions.length)
        / (proposed.length + actionableAdditions.length) : null,
    recall: expectedActions.length ? correctActions.length / expectedActions.length : null,
    recallInterval95: wilson(correctActions.length, expectedActions.length),
    costUsd: costs.every((value): value is number => value !== null)
      ? costs.reduce((sum, value) => sum + value, 0) : null,
    unknownCostCases: costs.filter((value) => value === null).length,
    latencyMs: selected.reduce((sum, item) => sum + item.prediction.latencyMs, 0) };
}

const root = path.resolve("artifacts/evidence-state");
const checkedPath = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error(`${name} must be JSON under artifacts/evidence-state.`);
  }
  return resolved;
};
const goldPath = checkedPath("PANINI_GOLD_MANIFEST");
const baselinePath = process.env.PANINI_BASELINE_PREDICTIONS
  ? checkedPath("PANINI_BASELINE_PREDICTIONS") : null;
const candidatePath = checkedPath("PANINI_CANDIDATE_PREDICTIONS");
const outputPath = checkedPath("PANINI_GOLD_EVALUATION_REPORT");
if (new Set([goldPath, baselinePath, candidatePath, outputPath]).size !== 4) {
  throw new Error("Gold, predictions, and output paths must be distinct.");
}
const gold = goldSchema.parse(JSON.parse(await readFile(goldPath, "utf8")));
if (contentHash(gold.cases) !== gold.frozenHash || gold.cases.some((item) =>
  item.cutoff > gold.frozenAt)) throw new Error("Gold labels or cutoffs changed after the freeze.");
const caseIds = new Set(gold.cases.map((item) => item.id));
if (caseIds.size !== gold.cases.length || !gold.cases.some((item) => item.split === "holdout")) {
  throw new Error("Gold cases must be unique and include a holdout split.");
}
if (!gold.cases.some((item) => item.split === "holdout" && item.adjudication === "confirmed"
  && item.ambiguityStatus === "clear")) {
  throw new Error("The frozen holdout has no confirmed, scorable case.");
}
const groups = new Map<string, Set<string>>();
const sources = new Map<string, Set<string>>();
for (const item of gold.cases) {
  const splits = groups.get(item.clusterId) ?? new Set<string>();
  splits.add(item.split); groups.set(item.clusterId, splits);
  for (const sourceId of item.sourceEventIds) {
    const sourceSplits = sources.get(sourceId) ?? new Set<string>();
    sourceSplits.add(item.split); sources.set(sourceId, sourceSplits);
  }
}
if ([...groups.values(), ...sources.values()].some((splits) => splits.size > 1)) {
  throw new Error("A task/thread cluster or source receipt crosses the development/holdout boundary.");
}
const developmentTimes = gold.cases.filter((item) => item.split === "development")
  .map((item) => item.cutoff);
const holdoutTimes = gold.cases.filter((item) => item.split === "holdout")
  .map((item) => item.cutoff);
if (!developmentTimes.length || developmentTimes.some((time) => time >= holdoutTimes.sort()[0]!)) {
  throw new Error("The holdout must follow the development cases in knowledge time.");
}
const baseline = baselinePath
  ? predictionSchema.parse(JSON.parse(await readFile(baselinePath, "utf8"))) : null;
const candidate = predictionSchema.parse(JSON.parse(await readFile(candidatePath, "utf8")));
if ((baseline && (!["baseline_historical", "baseline_contemporary"].includes(baseline.mode)
  || baseline.goldHash !== gold.frozenHash
  || baseline.inputFingerprint !== candidate.inputFingerprint
  || baseline.modelBudgetHash !== candidate.modelBudgetHash))
  || candidate.mode !== "candidate" || candidate.goldHash !== gold.frozenHash) {
  throw new Error("Predictions do not share the frozen corpus, input, and model budget.");
}
for (const report of [baseline, candidate].filter((item): item is typeof candidate => item !== null)) {
  if (contentHash(report.inputManifest) !== report.inputFingerprint
    || contentHash(report.modelBudget) !== report.modelBudgetHash
    || report.inputManifest.length !== gold.cases.length
    || new Set(report.inputManifest.map((item) => item.id)).size !== gold.cases.length) {
    throw new Error(`${report.label} input or budget fingerprint is not backed by its manifest.`);
  }
  const inputById = new Map(report.inputManifest.map((item) => [item.id, item]));
  for (const item of gold.cases) {
    const declared = inputById.get(item.id);
    if (!declared || declared.cutoff !== item.cutoff
      || contentHash([...declared.sourceEventIds].sort())
        !== contentHash([...item.sourceEventIds].sort())) {
      throw new Error(`${report.label} input receipts differ from frozen case ${item.id}.`);
    }
  }
}
const predictionMap = (report: typeof candidate): Map<string, PredictionCase> => {
  const map = new Map(report.cases.map((item) => [item.id, item]));
  if (map.size !== gold.cases.length || report.cases.length !== gold.cases.length
    || [...map.keys()].some((id) => !caseIds.has(id))) {
    throw new Error(`${report.label} predictions omit or duplicate a gold case.`);
  }
  for (const item of gold.cases) {
    const prediction = map.get(item.id)!;
    const allowedSources = new Set(item.sourceEventIds);
    if (prediction.cutoff !== item.cutoff || [prediction, ...prediction.additionalFindings]
      .some((finding) => finding.usedSources.some((source) =>
        source.knownAt > item.cutoff || !allowedSources.has(source.id)))) {
      throw new Error(`${report.label} uses an unlisted or post-cutoff source for ${item.id}.`);
    }
    const findingIds = prediction.additionalFindings.map((finding) => finding.id);
    if (new Set(findingIds).size !== findingIds.length) {
      throw new Error(`${report.label} duplicates additional findings for ${item.id}.`);
    }
  }
  return map;
};
const baselineById = baseline ? predictionMap(baseline) : null;
const candidateById = predictionMap(candidate);
function alignFinding(goldItem: GoldCase, prediction: PredictionCase): {
  prediction: PredictionCase; selectedFindingId: string | null } {
  if (goldItem.taskId === null && goldItem.expectedTransition === null) {
    return { prediction, selectedFindingId: null };
  }
  const match = (finding: PredictionCase | PredictedFinding) =>
    finding.taskId === goldItem.taskId
      && finding.relationship === goldItem.expectedRelationship
      && transitionKey(finding.transition) === transitionKey(goldItem.expectedTransition)
      && (goldItem.expectedTransition === null
        || ["applied", "proposed"].includes(finding.action));
  if (match(prediction)) return { prediction, selectedFindingId: null };
  const index = prediction.additionalFindings.findIndex(match);
  if (index < 0) return { prediction, selectedFindingId: null };
  const selected = prediction.additionalFindings[index]!;
  const formerPrimary: PredictedFinding = { id: `${prediction.id}:primary`,
    taskId: prediction.taskId, relationship: prediction.relationship,
    transition: prediction.transition, claim: prediction.claim, scope: prediction.scope,
    action: prediction.action, usedSources: prediction.usedSources };
  return { prediction: { ...prediction, taskId: selected.taskId,
    relationship: selected.relationship, transition: selected.transition,
    claim: selected.claim, scope: selected.scope, action: selected.action,
    usedSources: selected.usedSources,
    additionalFindings: [formerPrimary, ...prediction.additionalFindings.filter((_, i) => i !== index)] },
  selectedFindingId: selected.id };
}
const alignMap = (predictions: Map<string, PredictionCase>) => new Map(gold.cases.map((item) =>
  [item.id, alignFinding(item, predictions.get(item.id)!).prediction] as const));
const alignedBaselineById = baselineById ? alignMap(baselineById) : null;
const alignedCandidateById = alignMap(candidateById);
const ledger = gold.cases.map((item) => {
  const before = alignedBaselineById?.get(item.id);
  const after = alignedCandidateById.get(item.id)!;
  const classify = (prediction: PredictionCase) => item.adjudication === "unresolved"
    || item.ambiguityStatus === "ambiguous" ? "excluded"
    : isNoActionAbstention(item, prediction) ? "matched"
    : prediction.taskId === item.taskId
      && prediction.relationship === item.expectedRelationship
      && transitionKey(prediction.transition) === transitionKey(item.expectedTransition)
      && (item.expectedTransition === null || ["applied", "proposed"].includes(prediction.action))
      ? "matched" : item.expectedTransition && !prediction.transition ? "missed"
        : item.expectedTransition && ["review", "abstain"].includes(prediction.action) ? "missed"
        : !item.expectedTransition && prediction.transition
          ? (["applied", "proposed"].includes(prediction.action) ? "extra" : "unresolved")
          : "changed";
  return { id: item.id, split: item.split, taskId: item.taskId,
    sourceEventIds: item.sourceEventIds, reviewer: item.reviewer, rationale: item.rationale,
    expectedClaim: item.expectedClaim, expectedScope: item.expectedScope,
    supportingSourceEventIds: item.supportingSourceEventIds,
    expectedTransition: item.expectedTransition, baseline: before ? classify(before) : null,
    candidate: classify(after), baselineAction: before?.action ?? null, candidateAction: after.action,
    baselineClaim: before?.claim ?? null, candidateClaim: after.claim,
    baselineScope: before?.scope ?? null, candidateScope: after.scope,
    baselineSources: before?.usedSources.map((source) => source.id) ?? null,
    candidateSources: after.usedSources.map((source) => source.id),
    baselineSelectedFindingId: baselineById
      ? alignFinding(item, baselineById.get(item.id)!).selectedFindingId : null,
    candidateSelectedFindingId: alignFinding(item, candidateById.get(item.id)!).selectedFindingId };
});
const additionLedger = gold.cases.flatMap((item) => [
  ...(baseline && alignedBaselineById ? alignedBaselineById.get(item.id)!.additionalFindings.map((finding) => ({
    caseId: item.id, model: baseline.label, findingId: finding.id,
    classification: "unresolved" as const, taskId: finding.taskId,
    claim: finding.claim, scope: finding.scope, transition: finding.transition,
    action: finding.action, sourceEventIds: finding.usedSources.map((source) => source.id),
    reason: "Additional finding is outside the singular frozen expected item; reviewer adjudication required.",
  })) : []),
  ...alignedCandidateById.get(item.id)!.additionalFindings.map((finding) => ({
    caseId: item.id, model: candidate.label, findingId: finding.id,
    classification: "unresolved" as const, taskId: finding.taskId,
    claim: finding.claim, scope: finding.scope, transition: finding.transition,
    action: finding.action, sourceEventIds: finding.usedSources.map((source) => source.id),
    reason: "Additional finding is outside the singular frozen expected item; reviewer adjudication required.",
  })),
]);
const matchedContemporary = baseline?.mode === "baseline_contemporary";
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  goldHash: gold.frozenHash, packetCasesHash: gold.packetCasesHash,
  frozenAt: gold.frozenAt,
  inputFingerprint: candidate.inputFingerprint, modelBudgetHash: candidate.modelBudgetHash,
  baseline: baseline && baselineById ? { label: baseline.label, mode: baseline.mode,
    totals: baseline.totals, callLedgerHash: baseline.callLedgerHash,
    development: score(gold.cases.filter((item) =>
    item.split === "development"), alignedBaselineById!), holdout: score(gold.cases.filter((item) =>
    item.split === "holdout"), alignedBaselineById!) } : null,
  candidate: { label: candidate.label, mode: candidate.mode, totals: candidate.totals,
    callLedgerHash: candidate.callLedgerHash,
    development: score(gold.cases.filter((item) =>
    item.split === "development"), alignedCandidateById), holdout: score(gold.cases.filter((item) =>
    item.split === "holdout"), alignedCandidateById) },
  findings: ledger, additions: additionLedger,
  comparison: { matchedContemporary, costComparable: matchedContemporary && baselineById !== null
    && score(gold.cases, alignedBaselineById!).unknownCostCases === 0
    && score(gold.cases, alignedCandidateById).unknownCostCases === 0,
    savingsClaimAllowed: false,
    limitation: matchedContemporary ? null : baseline
      ? "Historical baseline is descriptive; current stored task state does not match each frozen knowledge cutoff."
      : "No matched baseline predictions are available. Candidate metrics are descriptive; architecture, quality, and cost deltas cannot be inferred." },
  metricLimits: { claimTextExactMatches: "Literal normalized text only; semantic claim correctness needs independent review.",
    findingAlignment: "A non-primary finding matching the frozen task, relationship, transition and proposed action is scored as the expected item; the former primary remains an additional finding.",
    precision: "Unknown while extra actionable findings await review; bounds assume all are wrong or all are right.",
    sourceSupportedCases: "Measures overlap with labeled receipts, not whether the citation entails the claim." },
  releaseGate: baseline ? "mechanical_verification_and_rollback_report_still_required"
    : "matched_baseline_and_independent_addition_review_required" };
await mkdir(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.${process.pid}.tmp`;
await writeFile(temporary, JSON.stringify(report, null, 2), { mode: 0o600 });
await rename(temporary, outputPath);
console.log(JSON.stringify({ report: outputPath, goldHash: gold.frozenHash,
  scoredHoldout: report.candidate.holdout.confirmedScored,
  unknownCandidateCostCases: report.candidate.holdout.unknownCostCases }));
