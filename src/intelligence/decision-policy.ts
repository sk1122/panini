import type { AssessmentDisposition, ClaimBody, EvidenceAssessment } from "../domain/evidence-types.js";
import type { Task } from "../domain/types.js";

export interface EvidencePolicyDecision {
  disposition: AssessmentDisposition;
  reasonCodes: string[];
  applicationClass: string | null;
  requiresHumanReview: boolean;
}

export function explicitlyAssertsTaskDone(claim: ClaimBody): boolean {
  return claim.kind === "completion_report" && claim.assertedField === "status"
    && claim.assertedValue === "done";
}

/** Short-lived coordination stays in evidence, outside the durable task queue. */
export function isTransientCoordinationRequest(claim: ClaimBody): boolean {
  if (claim.kind !== "request") return false;
  const statement = claim.statement;
  if (/\b(implement|build|add|create|fix|ship|deploy|write|migrate|integrate|remove|replace|design|test|validate|document|track|instrument)\b/i
    .test(statement)) return false;
  return /\b(have|schedule|set up|jump on|get on)\s+(a\s+|the\s+)?call\b/i.test(statement)
    || /\b(come|be|get)\s+online\b/i.test(statement)
    || /\bjoin\s+(the\s+)?(call|meeting)\b/i.test(statement)
    || /\b(notify|message|ping|dm)\s+me\b/i.test(statement)
    || /\basks?\s+(whether|what|how|which|where)\b/i.test(statement);
}

/** A model assessment is a proposal. This policy cannot grant itself application authority. */
export function decideEvidenceApplication(input: {
  task: Task;
  assessment: EvidenceAssessment;
}): EvidencePolicyDecision {
  const { task, assessment } = input;
  const reasons = new Set(assessment.reasonCodes);
  const body = assessment.body;
  if (reasons.has("historical_evaluation")) return {
    disposition: "rejected", reasonCodes: [...reasons],
    applicationClass: null, requiresHumanReview: true,
  };
  if (assessment.targetType !== "task" || assessment.targetId !== task.id
    || assessment.targetVersion !== String(task.version)) reasons.add("version_conflict");
  if (assessment.relationship === "unrelated") return {
    disposition: "rejected", reasonCodes: [...reasons, "identity_unrelated"],
    applicationClass: null, requiresHumanReview: true,
  };
  if (assessment.relationship !== "same_outcome") reasons.add(
    assessment.relationship === "part_of" ? "partial_scope" : "identity_uncertain",
  );
  if (body.fields.length === 0) reasons.add("no_change");
  for (const field of body.fields) {
    if (field.verdict !== "supported" || field.contradictions.length > 0) reasons.add("insufficient_support");
    for (const reason of field.reasonCodes) reasons.add(reason);
  }
  const terminal = body.fields.some((field) => field.operation.field === "status"
    && field.operation.op === "set" && field.operation.value === "done");
  if (terminal) {
    if (!task.outcomeContract) reasons.add("unknown_contract");
    else {
      if (assessment.contractVersion !== task.outcomeContract.version) reasons.add("version_conflict");
      for (const criterion of task.outcomeContract.criteria.filter((item) => item.required)) {
        if (body.criteria.find((item) => item.criterionId === criterion.id)?.verdict !== "satisfied") {
          reasons.add("missing_required_source");
        }
      }
    }
    if (!body.coverage.complete || body.coverage.gaps.length > 0) reasons.add("missing_required_source");
    if (body.fields.some((field) => field.contradictions.length > 0)) reasons.add("contradicted");
  }
  if (assessment.disposition === "rejected") reasons.add("assessment_rejected");
  if (assessment.disposition === "review_required") reasons.add("assessment_requires_review");
  if (reasons.has("no_change") && reasons.size === 1) return {
    disposition: "no_change", reasonCodes: ["no_change"], applicationClass: null, requiresHumanReview: false,
  };
  if (reasons.has("version_conflict") || reasons.has("unknown_contract") || reasons.has("partial_scope")
    || reasons.has("identity_uncertain") || reasons.has("insufficient_support")
    || reasons.has("stale_evidence")
    || reasons.has("missing_required_source") || reasons.has("contradicted")
    || reasons.has("assessment_requires_review") || reasons.has("assessment_rejected")) {
    return { disposition: "review_required", reasonCodes: [...reasons],
      applicationClass: null, requiresHumanReview: true };
  }
  return { disposition: "eligible", reasonCodes: [...reasons],
    applicationClass: terminal ? "task_terminal" : "task_nonterminal",
    requiresHumanReview: terminal || !reasons.has("authorized_attestation") };
}
