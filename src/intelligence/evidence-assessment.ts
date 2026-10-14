import type { ClaimBody, CriterionAssessment, EvidenceClaim, OutcomeCriterion, SourceSpan,
  TaskAssessmentBody } from "../domain/evidence-types.js";
import type { SourceEvent, Task } from "../domain/types.js";
import { contentHash } from "../domain/content-hash.js";

function payloadObject(event: SourceEvent): Record<string, unknown> | null {
  return event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
    ? event.payload : null;
}

function exactSha(refs: readonly string[]): string | null {
  const shas = refs.filter((ref) => /^[0-9a-f]{40}$/i.test(ref));
  return shas.length === 1 ? shas[0]!.toLowerCase() : null;
}

/** A second report is not independent evidence unless its provenance establishes that fact. */
export function corroborationReason(claim: EvidenceClaim,
  prior: readonly EvidenceClaim[]): string | null {
  const repeated = prior.filter((item) => item.id !== claim.id
    && item.body.assertedField === claim.body.assertedField
    && contentHash(item.body.assertedValue) === contentHash(claim.body.assertedValue)
    && item.body.kind !== "artifact_observation");
  if (!repeated.length) return null;
  const ownOrigins = new Set(claim.body.spans.map((span) => span.originObservationKey));
  if (ownOrigins.size !== 1) return "unknown_independence";
  const sameRoot = repeated.every((item) => item.body.spans.every((span) =>
    ownOrigins.has(span.originObservationKey))
    || claim.body.derivedFromClaimIds.includes(item.id)
    || item.body.derivedFromClaimIds.includes(claim.id));
  return sameRoot ? "corroboration_same_origin" : "unknown_independence";
}

function checkCriterion(criterion: OutcomeCriterion, claim: ClaimBody,
  events: readonly SourceEvent[], clock: string,
  authorizedAttestations: ReadonlyMap<string, SourceSpan[]>,
  defaultCheckpointAgeSeconds: number): CriterionAssessment {
  const rule = criterion.evidenceRule;
  const insufficient = (reasonCodes: string[]): CriterionAssessment => ({
    criterionId: criterion.id, verdict: "insufficient", verifiedBy: "deterministic_artifact",
    support: [], checkedArtifactRefs: rule.artifactRefs, reasonCodes,
  });
  const eventById = new Map(events.map((event) => [event.id, event]));
  const cited = claim.spans.map((span) => eventById.get(span.eventId)).filter((event): event is SourceEvent => Boolean(event));
  const checkpointAgeLimit = rule.maxCheckpointAgeSeconds ?? defaultCheckpointAgeSeconds;
  const checkpointFresh = (event: SourceEvent): boolean => {
    const age = (Date.parse(clock) - Date.parse(event.fetchedAt)) / 1000;
    return Number.isFinite(age) && age >= 0 && age <= checkpointAgeLimit;
  };
  if (rule.kind === "authorized_attestation") {
    const support = authorizedAttestations.get(criterion.id) ?? [];
    const freshSupport = support.filter((span) => {
      const event = eventById.get(span.eventId);
      return event && checkpointFresh(event);
    });
    return freshSupport.length > 0
      ? { criterionId: criterion.id, verdict: "satisfied", verifiedBy: "authorized_actor",
        support: freshSupport, checkedArtifactRefs: [], reasonCodes: [] }
      : insufficient([support.length > 0 ? "source_checkpoint_stale" : "unknown_authority"]);
  }
  if (rule.kind === "merged" || rule.kind === "deployed") {
    const sha = exactSha(rule.artifactRefs);
    if (!sha || (rule.kind === "deployed" && !rule.requiredEnvironment)) {
      return insufficient(["required_sha_or_environment_missing"]);
    }
    const snapshots = cited.filter((event) => {
      const payload = payloadObject(event);
      const checks = payload?.requiredChecks;
      return event.provider === "github" && event.eventKind === "artifact.verification"
        && event.payloadVersion === "github-verification-v1"
        && payload?.requiredHeadSha === sha && payload.observedHeadSha === sha
        && Array.isArray(checks)
        && rule.requiredCheckNames.every((name) => checks.includes(name))
        && Date.parse(event.occurredAt) <= Date.parse(clock)
        && Date.parse(event.fetchedAt) <= Date.parse(clock)
        && Date.parse(event.receivedAt) <= Date.parse(clock);
    }).sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));
    const latest = snapshots[0];
    if (!latest) return insufficient(["artifact_verification_required"]);
    if (snapshots[1]?.fetchedAt === latest.fetchedAt) {
      return insufficient(["artifact_verification_order_unknown"]);
    }
    if (!checkpointFresh(latest)) return insufficient(["source_checkpoint_stale"]);
    const payload = payloadObject(latest)!;
    if (rule.kind === "deployed" && payload.requiredDeploymentEnvironment !== rule.requiredEnvironment) {
      return insufficient(["wrong_environment"]);
    }
    if ((Date.parse(clock) - Date.parse(latest.fetchedAt)) / 1000 > rule.maxMutableAgeSeconds) {
      return insufficient(["stale_evidence"]);
    }
    if (payload.mergeVerified !== true) return insufficient(["merge_verification_required"]);
    if (payload.state !== "verified"
      || !Array.isArray(payload.reasonCodes) || payload.reasonCodes.length !== 0) {
      return insufficient(["artifact_verification_failed"]);
    }
    return { criterionId: criterion.id, verdict: "satisfied", verifiedBy: "deterministic_artifact",
      support: claim.spans.filter((span) => span.eventId === latest.id),
      checkedArtifactRefs: [sha], reasonCodes: [] };
  }
  if (rule.kind !== "check_passed") return insufficient([
    rule.kind === "manual_review" ? "manual_review_required"
      : "artifact_verification_required",
  ]);
  const sha = exactSha(rule.artifactRefs);
  if (!sha || rule.requiredCheckNames.length === 0) return insufficient(["required_sha_or_check_missing"]);
  const verifiedChecks = cited.filter((event) => {
    const payload = payloadObject(event);
    return event.provider === "github" && event.eventKind === "artifact.verification"
      && event.payloadVersion === "github-verification-v1"
      && payload?.requiredHeadSha === sha && payload.observedHeadSha === sha
      && payload.requireMerge === false && Array.isArray(payload.requiredChecks)
      && rule.requiredCheckNames.every((name) => (payload.requiredChecks as unknown[]).includes(name))
      && Date.parse(event.occurredAt) <= Date.parse(clock)
      && Date.parse(event.fetchedAt) <= Date.parse(clock)
      && Date.parse(event.receivedAt) <= Date.parse(clock);
  }).sort((left, right) => right.fetchedAt.localeCompare(left.fetchedAt));
  if (verifiedChecks.length > 0) {
    const latest = verifiedChecks[0]!;
    const payload = payloadObject(latest)!;
    if (verifiedChecks[1]?.fetchedAt === latest.fetchedAt) return insufficient(["artifact_verification_order_unknown"]);
    if (!checkpointFresh(latest)) return insufficient(["source_checkpoint_stale"]);
    if ((Date.parse(clock) - Date.parse(latest.fetchedAt)) / 1000 > rule.maxMutableAgeSeconds) {
      return insufficient(["stale_evidence"]);
    }
    if (payload.state !== "verified" || !Array.isArray(payload.reasonCodes)
      || payload.reasonCodes.length !== 0) return insufficient(["artifact_verification_failed"]);
    return { criterionId: criterion.id, verdict: "satisfied", verifiedBy: "deterministic_artifact",
      support: claim.spans.filter((span) => span.eventId === latest.id),
      checkedArtifactRefs: [sha], reasonCodes: [] };
  }
  const checked = rule.requiredCheckNames.map((name) => {
    const candidates = cited.filter((event) => {
      const payload = payloadObject(event);
      return event.provider === "github" && event.eventKind === "check_run.snapshot"
        && event.payloadVersion === "github-rest-v1"
        && typeof payload?.sha === "string" && payload.sha.toLowerCase() === sha
        && payload.name === name && Date.parse(event.occurredAt) <= Date.parse(clock)
        && Date.parse(event.fetchedAt) <= Date.parse(clock)
        && Date.parse(event.receivedAt) <= Date.parse(clock);
    }).sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)
      || right.fetchedAt.localeCompare(left.fetchedAt));
    const latest = candidates[0];
    if (!latest) return { name, state: "missing" as const, eventId: null };
    const payload = payloadObject(latest)!;
    const ageSeconds = (Date.parse(clock) - Date.parse(latest.fetchedAt)) / 1000;
    if (!Number.isFinite(ageSeconds) || ageSeconds > rule.maxMutableAgeSeconds) {
      return { name, state: "stale" as const, eventId: latest.id };
    }
    if (payload.status !== "completed" || payload.conclusion !== "success") {
      return { name, state: "failed" as const, eventId: latest.id };
    }
    return { name, state: "passed" as const, eventId: latest.id };
  });
  const supportingIds = new Set(checked.filter((item) => item.state === "passed")
    .map((item) => item.eventId));
  const contradictingIds = new Set(checked.filter((item) => item.state === "failed")
    .map((item) => item.eventId));
  const support = claim.spans.filter((span) => supportingIds.has(span.eventId));
  if (contradictingIds.size > 0) return { criterionId: criterion.id,
    verdict: "contradicted", verifiedBy: "deterministic_artifact",
    support: claim.spans.filter((span) => contradictingIds.has(span.eventId)),
    checkedArtifactRefs: [sha], reasonCodes: ["required_check_not_successful"] };
  if (checked.some((item) => item.state !== "passed")) return { criterionId: criterion.id,
    verdict: "insufficient", verifiedBy: "deterministic_artifact", support,
    checkedArtifactRefs: [sha], reasonCodes: checked.map((item) =>
      item.state === "stale" ? "stale_evidence" : item.state === "missing"
        ? "missing_required_source" : "").filter(Boolean) };
  return { criterionId: criterion.id, verdict: "satisfied",
    verifiedBy: "deterministic_artifact", support, checkedArtifactRefs: [sha], reasonCodes: [] };
}

/** Checks only evidence explicitly linked to this claim; a missing connector search stays a coverage gap. */
export function assessTaskOutcomeCriteria(input: { task: Task; claim: ClaimBody;
  events: readonly SourceEvent[]; evaluationClock: string;
  defaultCheckpointAgeSeconds?: number;
  authorizedAttestations?: ReadonlyMap<string, SourceSpan[]> }): Pick<TaskAssessmentBody, "criteria" | "coverage"> {
  const contract = input.task.outcomeContract;
  if (!contract) return { criteria: [], coverage: { complete: false, requiredResources: [],
    gaps: ["unknown_contract"], checkedAt: input.evaluationClock } };
  const criteria = contract.criteria.map((criterion) => checkCriterion(criterion,
    input.claim, input.events, input.evaluationClock,
    input.authorizedAttestations ?? new Map(), input.defaultCheckpointAgeSeconds ?? 900));
  const required = contract.criteria.filter((criterion) => criterion.required);
  const gaps = [...new Set(criteria.filter((item) =>
    contract.criteria.find((criterion) => criterion.id === item.criterionId)?.required
      && item.verdict !== "satisfied").flatMap((item) => item.reasonCodes))];
  if (required.length === 0) gaps.push("no_required_criteria");
  // A fresh exact-revision verification is its own source check. A stored
  // check snapshot alone does not prove the connector has seen later updates.
  const eventById = new Map(input.events.map((event) => [event.id, event]));
  if (!required.every((criterion) => ["check_passed", "merged", "deployed", "authorized_attestation"]
    .includes(criterion.evidenceRule.kind)
    && criteria.find((item) => item.criterionId === criterion.id)?.verdict === "satisfied"
    && criteria.find((item) => item.criterionId === criterion.id)?.support.some((span) =>
      criterion.evidenceRule.kind === "authorized_attestation"
        ? eventById.get(span.eventId)?.provider === "slack"
        : eventById.get(span.eventId)?.eventKind === "artifact.verification"))) {
    gaps.push("source_checkpoint_unverified");
  }
  return { criteria, coverage: { complete: gaps.length === 0,
    requiredResources: [...new Set(required
      .flatMap((criterion) => criterion.evidenceRule.artifactRefs))], gaps,
    checkedAt: input.evaluationClock } };
}
