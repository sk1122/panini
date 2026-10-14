import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import type { OutboxJob, Task } from "../domain/types.js";
import type { EvidenceClaim } from "../domain/evidence-types.js";
import { identityText } from "../intelligence/task-identity.js";
import type { EvidencePipeline } from "../intelligence/evidence-pipeline.js";

function discoveryTerms(value: string): Set<string> {
  return new Set((value.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((term) => term.length >= 5 && !["about", "after", "before", "could", "should",
      "there", "their", "these", "those", "would", "status", "update", "review", "complete"].includes(term)));
}

function claimMayConcernTask(claim: EvidenceClaim, task: Task): boolean {
  const statement = claim.body.statement.toLocaleLowerCase("en");
  if (claim.body.subjectRefs.includes(task.id) || statement.includes(task.id.toLowerCase())) return true;
  if (task.externalRef && (claim.body.subjectRefs.includes(task.externalRef)
    || statement.includes(task.externalRef.toLocaleLowerCase("en")))) return true;
  const taskTerms = discoveryTerms([task.title, task.description,
    task.outcomeContract?.statement ?? "", task.outcomeContract?.scope ?? ""].join(" "));
  const shared = [...discoveryTerms(statement)].filter((term) => taskTerms.has(term));
  return shared.length >= 2;
}

function claimExplicitlyReferencesTask(claim: EvidenceClaim, task: Task): boolean {
  const statement = claim.body.statement.toLocaleLowerCase("en");
  return claim.body.subjectRefs.includes(task.id) || statement.includes(task.id.toLowerCase())
    || Boolean(task.externalRef && (claim.body.subjectRefs.includes(task.externalRef)
      || statement.includes(task.externalRef.toLocaleLowerCase("en"))));
}

function lexicalDiscoveryScore(claim: EvidenceClaim, task: Task): number {
  const taskTerms = discoveryTerms([task.title, task.description,
    task.outcomeContract?.statement ?? "", task.outcomeContract?.scope ?? ""].join(" "));
  return [...discoveryTerms(claim.body.statement)].filter((term) => taskTerms.has(term)).length;
}

type ScoredClaim = { id: string; score: number };
function topClaims(previous: ScoredClaim[], next: ScoredClaim[], limit: number): ScoredClaim[] {
  const byId = new Map<string, number>();
  for (const item of [...previous, ...next]) {
    byId.set(item.id, Math.max(item.score, byId.get(item.id) ?? -Infinity));
  }
  return [...byId].map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
    .slice(0, limit);
}

export function createTaskEvidenceReassessHandler(options: {
  store: LedgerStore;
  evidencePipeline: EvidencePipeline;
  evidenceVersion: string;
  evidenceDispatchEpoch: string;
  evidenceBudgetId: string;
  policy: unknown;
  intelligenceModel: string | null;
  allowedVisibilities: string[];
  semanticDiscoveryEnabled: boolean;
  semanticDiscoveryScores: (task: Task, claims: EvidenceClaim[], evaluationClock: string) => Promise<{
    scores: ScoredClaim[]; screened: number;
  }>;
}) {
  const { store, evidencePipeline, evidenceVersion, evidenceDispatchEpoch,
    evidenceBudgetId, semanticDiscoveryScores } = options;
  const workEmbeddings = options.semanticDiscoveryEnabled;
  const config = { app: { intelligence: { evidenceV2: options.policy } },
    intelligenceModel: options.intelligenceModel,
    jevWorkAllowedVisibilities: options.allowedVisibilities };
  return async (job: Pick<OutboxJob, "payload" | "createdAt">): Promise<void> => {
    const payload = z.object({ pipelineVersion: z.string(), taskId: z.uuid(),
      taskVersion: z.number().int().positive(), afterClaimId: z.uuid().nullable(),
      stage: z.enum(["linked", "discover"]).default("linked"),
      evaluationClock: z.iso.datetime().optional(),
      discoveryCursor: z.object({ createdAt: z.iso.datetime(), id: z.uuid() }).nullable().optional(),
      discoveryAfter: z.iso.datetime().nullable().optional(),
      searchIdentityHash: z.string().regex(/^[0-9a-f]{64}$/).optional(),
      discoveryThrough: z.iso.datetime().optional(),
      linkedExamined: z.number().int().nonnegative().default(0),
      linkedReassessed: z.number().int().nonnegative().default(0),
      discoveryExamined: z.number().int().nonnegative().default(0),
      discoveryCandidates: z.number().int().nonnegative().default(0),
      explicitMatchCount: z.number().int().nonnegative().default(0),
      lexicalTop: z.array(z.object({ id: z.uuid(), score: z.number().finite() })).max(20).default([]),
      semanticTop: z.array(z.object({ id: z.uuid(), score: z.number().finite() })).max(20).default([]),
      semanticScreened: z.number().int().nonnegative().default(0) }).parse(job.payload);
    if (payload.pipelineVersion !== evidenceVersion) return;
    const evaluationClock = payload.evaluationClock ?? job.createdAt;
    const task = await store.getTask(payload.taskId);
    const taskIdentityHash = task ? contentHash({ text: identityText(task),
      policy: config.app.intelligence.evidenceV2,
      model: config.intelligenceModel,
      allowedVisibilities: [...config.jevWorkAllowedVisibilities].sort(),
      accessVersion: await store.getEvidenceAccessVersion() }) : null;
    const manifest = async (reason: "completed" | "target_changed", counts: {
      linkedExamined: number; linkedReassessed: number;
      discoveryExamined: number; discoveryCandidates: number;
      discoverySelected: number; candidateOverflow: number;
      explicitAssessed: number;
      semanticScreened: number; semanticSelected: number;
      selectedClaimIds: string[] }) => {
      await store.enqueueOutboxJob({ topic: "evidence.task.search_manifest",
        dedupeKey: `evidence:task:${evidenceDispatchEpoch}:${payload.taskId}:${payload.taskVersion}:${payload.searchIdentityHash ?? taskIdentityHash ?? "missing"}:manifest`,
        payload: { pipelineVersion: evidenceVersion, dispatchEpoch: evidenceDispatchEpoch,
          taskId: payload.taskId, taskVersion: payload.taskVersion,
          taskIdentityHash: payload.searchIdentityHash ?? taskIdentityHash,
          discoveryAfter: payload.discoveryAfter ?? null,
          discoveryThrough: payload.discoveryThrough ?? null,
          method: workEmbeddings
            ? "linked_claims_plus_lexical_scan_and_top20_semantic"
            : "linked_claims_plus_explicit_or_two_term_lexical_scan",
          semanticDiscovery: Boolean(workEmbeddings), coverageComplete: false,
          reason, ...counts } });
    };
    if (!task || task.version !== payload.taskVersion) {
      await manifest("target_changed", {
        linkedExamined: payload.linkedExamined,
        linkedReassessed: payload.linkedReassessed,
        discoveryExamined: payload.discoveryExamined,
        discoveryCandidates: payload.discoveryCandidates,
        discoverySelected: 0,
        candidateOverflow: 0,
        explicitAssessed: payload.explicitMatchCount,
        semanticScreened: payload.semanticScreened,
        semanticSelected: payload.semanticTop.length,
        selectedClaimIds: [] });
      return;
    }
    if (payload.searchIdentityHash && taskIdentityHash !== payload.searchIdentityHash) {
      await manifest("target_changed", {
        linkedExamined: payload.linkedExamined, linkedReassessed: payload.linkedReassessed,
        discoveryExamined: payload.discoveryExamined,
        discoveryCandidates: payload.discoveryCandidates,
        discoverySelected: 0, candidateOverflow: 0,
        explicitAssessed: payload.explicitMatchCount,
        semanticScreened: payload.semanticScreened,
        semanticSelected: payload.semanticTop.length, selectedClaimIds: [] });
      await store.enqueueOutboxJob({ topic: "evidence.task.reassess",
        dedupeKey: `evidence:task:${evidenceDispatchEpoch}:${task.id}:${task.version}:${taskIdentityHash}:restart`,
        payload: { pipelineVersion: evidenceVersion, taskId: task.id,
          taskVersion: task.version, afterClaimId: null,
          searchIdentityHash: taskIdentityHash } });
      return;
    }
    const allowedClaims = async (claims: EvidenceClaim[]): Promise<EvidenceClaim[]> => {
      const ids = [...new Set(claims.flatMap((claim) => claim.body.spans.map((span) => span.eventId)))];
      const events = await store.getSourceEvents(ids);
      const currentIds = new Set(await store.currentSourceEventIds(ids));
      const allowedIds = new Set(events.filter((event) =>
        currentIds.has(event.id)
          && config.jevWorkAllowedVisibilities.includes(event.visibility)).map((event) => event.id));
      return claims.filter((claim) => claim.body.spans.length > 0
        && claim.body.spans.every((span) => allowedIds.has(span.eventId)));
    };
    if (payload.stage === "linked") {
      const claims = await store.listClaimsForTask(payload.taskId, payload.afterClaimId, 10);
      const eligible = await allowedClaims(claims);
      if (eligible.length > 0) {
        await evidencePipeline.runCachedAssessment({ claimIds: eligible.map((claim) => claim.id),
          budgetId: evidenceBudgetId, evaluationClock, knowledgeCutoff: null });
      }
      if (claims.length === 10) {
        const cursor = claims.at(-1)!.id;
        await store.enqueueOutboxJob({ topic: "evidence.task.reassess",
          dedupeKey: `evidence:task:${evidenceDispatchEpoch}:${payload.taskId}:${payload.taskVersion}:${taskIdentityHash}:${cursor}`,
          payload: { pipelineVersion: evidenceVersion, taskId: payload.taskId,
            taskVersion: payload.taskVersion, afterClaimId: cursor,
            ...(taskIdentityHash ? { searchIdentityHash: taskIdentityHash } : {}),
            evaluationClock,
            linkedExamined: payload.linkedExamined + claims.length,
            linkedReassessed: payload.linkedReassessed + eligible.length,
            discoveryExamined: payload.discoveryExamined,
            discoveryCandidates: payload.discoveryCandidates,
            explicitMatchCount: payload.explicitMatchCount,
            lexicalTop: payload.lexicalTop,
            semanticTop: payload.semanticTop, semanticScreened: payload.semanticScreened } });
      } else {
        const through = new Date().toISOString();
        const priorThrough = taskIdentityHash
          ? await store.getLatestTaskSearchCursor(task.id, evidenceDispatchEpoch, taskIdentityHash)
          : null;
        const after = priorThrough && priorThrough <= through ? priorThrough : null;
        await store.enqueueOutboxJob({ topic: "evidence.task.reassess",
          dedupeKey: `evidence:task:${evidenceDispatchEpoch}:${payload.taskId}:${payload.taskVersion}:${taskIdentityHash}:discover:start`,
          payload: { pipelineVersion: evidenceVersion, taskId: payload.taskId,
            taskVersion: payload.taskVersion, afterClaimId: null,
          stage: "discover", discoveryCursor: null, discoveryAfter: after,
          ...(taskIdentityHash ? { searchIdentityHash: taskIdentityHash } : {}),
          discoveryThrough: through,
            evaluationClock,
            linkedExamined: payload.linkedExamined + claims.length,
            linkedReassessed: payload.linkedReassessed + eligible.length,
            discoveryExamined: payload.discoveryExamined,
            discoveryCandidates: payload.discoveryCandidates,
            explicitMatchCount: payload.explicitMatchCount,
            lexicalTop: payload.lexicalTop,
            semanticTop: payload.semanticTop, semanticScreened: payload.semanticScreened } });
      }
      return;
    }
    if (!payload.discoveryThrough) throw new Error("Target discovery requires a fixed cutoff.");
    const page = await store.listUnlinkedClaimsForTask(payload.taskId,
      payload.discoveryCursor ?? null, payload.discoveryAfter ?? null,
      payload.discoveryThrough, 10);
    const eligiblePage = await allowedClaims(page.filter((claim) =>
      ["request", "progress_report", "completion_report"].includes(claim.body.kind)
      || (claim.body.kind === "context_statement"
        && claim.body.caveats.includes("commit_message_not_interpreted_as_task_state"))));
    const explicitOnPage = eligiblePage.filter((claim) => claimExplicitlyReferencesTask(claim, task))
      .map((claim) => claim.id);
    const explicitSet = new Set(explicitOnPage);
    const semantic = await semanticDiscoveryScores(task,
      eligiblePage.filter((claim) => !explicitSet.has(claim.id)), evaluationClock);
    const semanticTop = topClaims(payload.semanticTop, semantic.scores, 20);
    const candidates = eligiblePage.filter((claim) => !explicitSet.has(claim.id)
      && claimMayConcernTask(claim, task));
    if (explicitOnPage.length > 0) {
      await evidencePipeline.runCachedAssessment({ claimIds: explicitOnPage,
        budgetId: evidenceBudgetId, evaluationClock, knowledgeCutoff: null });
    }
    const explicitMatchCount = payload.explicitMatchCount + explicitOnPage.length;
    const lexicalTop = topClaims(payload.lexicalTop, candidates.map((claim) => ({
      id: claim.id, score: lexicalDiscoveryScore(claim, task) })), 20);
    if (page.length === 10) {
      const last = page.at(-1)!;
      await store.enqueueOutboxJob({ topic: "evidence.task.reassess",
        dedupeKey: `evidence:task:${evidenceDispatchEpoch}:${payload.taskId}:${payload.taskVersion}:${payload.searchIdentityHash ?? taskIdentityHash}:discover:${last.id}`,
        payload: { pipelineVersion: evidenceVersion, taskId: payload.taskId,
          taskVersion: payload.taskVersion, afterClaimId: null, stage: "discover",
          discoveryCursor: { createdAt: last.createdAt, id: last.id },
          discoveryAfter: payload.discoveryAfter ?? null,
          ...(payload.searchIdentityHash ? { searchIdentityHash: payload.searchIdentityHash } : {}),
          discoveryThrough: payload.discoveryThrough,
          evaluationClock,
          linkedExamined: payload.linkedExamined,
          linkedReassessed: payload.linkedReassessed,
          discoveryExamined: payload.discoveryExamined + page.length,
          discoveryCandidates: payload.discoveryCandidates + candidates.length,
          explicitMatchCount,
          lexicalTop, semanticTop,
          semanticScreened: payload.semanticScreened + semantic.screened } });
    } else {
      const rankedIds = [...new Set([...lexicalTop.map((item) => item.id),
        ...semanticTop.map((item) => item.id)])];
      const selectedIds = rankedIds.slice(0, 40);
      const selectedClaims = await allowedClaims(await store.getClaims(selectedIds));
      if (selectedClaims.length > 0) {
        await evidencePipeline.runCachedAssessment({ claimIds: selectedClaims.map((claim) => claim.id),
          budgetId: evidenceBudgetId, evaluationClock, knowledgeCutoff: null });
      }
      await manifest("completed", {
      linkedExamined: payload.linkedExamined,
      linkedReassessed: payload.linkedReassessed,
      discoveryExamined: payload.discoveryExamined + page.length,
      discoveryCandidates: payload.discoveryCandidates + candidates.length,
      discoverySelected: selectedClaims.length + explicitMatchCount,
      candidateOverflow: Math.max(0, rankedIds.length - selectedIds.length),
      explicitAssessed: explicitMatchCount,
      semanticScreened: payload.semanticScreened + semantic.screened,
      semanticSelected: semanticTop.length,
      selectedClaimIds: selectedClaims.map((claim) => claim.id) });
    }
  };
}
