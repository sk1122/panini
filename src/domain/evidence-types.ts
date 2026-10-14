import type { JsonValue, TaskFields } from "./types.js";

export type PipelineMode = "legacy" | "shadow" | "review" | "apply";
export interface EvidenceAuthorityPolicy {
  id: string;
  version: number;
  memberIds: string[];
  roles: string[];
  providers: string[];
  installationKeys: string[];
  objectKinds: string[];
  criterionKinds: string[];
  audience: string[];
  maxAttestationAgeSeconds?: number | undefined;
}
export type ReplayMode = "live" | "accepted_rebuild" | "cached_reassess" | "source_reinterpret" | "historical_eval";
export type WorkResult = "unknown" | "succeeded" | "failed" | "mixed" | "not_applicable";
export type EvidenceRuleKind = "authorized_attestation" | "artifact_observed" | "check_passed" | "merged" | "deployed" | "manual_review";

export interface EvidenceRule {
  kind: EvidenceRuleKind;
  authorityPolicyId: string | null;
  artifactRefs: string[];
  requiredCheckNames: string[];
  requiredEnvironment: string | null;
  maxMutableAgeSeconds: number;
  maxCheckpointAgeSeconds?: number | undefined;
}

export interface OutcomeCriterion {
  id: string;
  description: string;
  required: boolean;
  evidenceRule: EvidenceRule;
  acceptedBy: string;
  acceptedAt: string;
}

export interface OutcomeContract {
  version: number;
  statement: string;
  scope: string;
  exclusions: string[];
  criteria: OutcomeCriterion[];
  provenance: { proposalId: string; evidenceIds: string[]; actor: string; acceptedAt: string };
}

export type OutcomeContractDraft = Pick<OutcomeContract, "statement" | "scope" | "exclusions"> & {
  criteria: Omit<OutcomeCriterion, "acceptedBy" | "acceptedAt">[];
};

export type SourceLocator =
  | { kind: "text"; jsonPointer: string; startUtf16: number; endUtf16: number; spanHash: string }
  | { kind: "structured"; jsonPointer: string; valueHash: string }
  | { kind: "code"; repositoryId: string; sha: string; path: string; startLine: number; endLine: number; spanHash: string };

export interface SourceSpan {
  eventId: string;
  originObservationKey: string;
  sourceVersionKey: string;
  locator: SourceLocator;
}

export type ClaimKind = "request" | "progress_report" | "completion_report" | "artifact_observation" | "correction" | "cancellation" | "context_statement";

export interface ClaimBody {
  schemaVersion: 1;
  kind: ClaimKind;
  statement: string;
  subjectRefs: string[];
  speakerMemberId: string | null;
  assertedField: string | null;
  assertedValue: JsonValue;
  assertedAt: string;
  validFrom: string | null;
  validTo: string | null;
  temporalBasis: "explicit" | "relative_to_source" | "unknown";
  spans: SourceSpan[];
  derivedFromClaimIds: string[];
  supersedesClaimIds: string[];
  caveats: string[];
}

export interface EvidenceClaim {
  id: string;
  extractionRunId: string;
  episodeKey: string;
  ordinal: number;
  inputHash: string;
  contentHash: string;
  body: ClaimBody;
  createdAt: string;
}

export type TaskPatchField = "title" | "description" | "status" | "priority" | "owner" | "project" | "projectId" | "dueDate" | "dependencyRefs" | "sourceUrl" | "outcomeContract" | "result";
export type TaskClearField = "owner" | "project" | "projectId" | "dueDate" | "sourceUrl" | "dependencyRefs";
export type TaskSetOperation = { [K in TaskPatchField]-?: {
  field: K; op: "set"; value: NonNullable<TaskFields[K]>; supportingClaimIds: string[]
} }[TaskPatchField];
export type TaskPatchOperation = TaskSetOperation | { field: TaskClearField; op: "clear"; supportingClaimIds: string[] };

export type WorkRelationship = "same_outcome" | "part_of" | "related" | "unrelated" | "uncertain";
export type AssessmentDisposition = "eligible" | "review_required" | "rejected" | "no_change";
export type DispositionState = "pending" | "processing" | "processed" | "extracted" | "partial" | "no_claim" | "duplicate" | "unresolved" | "failed";

export interface FieldAssessment {
  operation: TaskPatchOperation;
  verdict: "supported" | "contradicted" | "insufficient";
  support: SourceSpan[];
  contradictions: SourceSpan[];
  effectiveAt: string | null;
  reasonCodes: string[];
}

export interface CriterionAssessment {
  criterionId: string;
  verdict: "satisfied" | "contradicted" | "insufficient" | "not_applicable";
  verifiedBy: "deterministic_artifact" | "authorized_actor" | "human_review" | "model_inference";
  support: SourceSpan[];
  checkedArtifactRefs: string[];
  reasonCodes: string[];
}

export interface TaskAssessmentBody {
  schemaVersion: 1;
  kind: "task" | "context";
  relationship: WorkRelationship;
  alternativeTargetIds: string[];
  fields: FieldAssessment[];
  criteria: CriterionAssessment[];
  coverage: { complete: boolean; requiredResources: string[]; gaps: string[]; checkedAt: string };
  rawScores: { name: string; value: number; model: string; calibrationArtifact: string | null }[];
  explanation: string;
}

export interface EvidenceAssessment {
  id: string;
  runId: string;
  assessmentKey: string;
  targetType: "task" | "project" | "context" | "task_create" | "project_create" | "context_create";
  targetId: string | null;
  targetVersion: string | null;
  contractVersion: number | null;
  claimIds: string[];
  evidenceFingerprint: string;
  permissionFingerprint: string;
  policyVersion: string;
  modelVersion: string;
  relationship: WorkRelationship;
  disposition: AssessmentDisposition;
  reasonCodes: string[];
  body: TaskAssessmentBody;
  createdAt: string;
}

export interface DecisionMetadata {
  schemaVersion: 1;
  assessmentId: string | null;
  basis: "manual" | "authorized_attestation" | "artifact_verified" | "model_inferred" | "legacy_unknown";
  policyVersion: string;
  contractVersion: number | null;
  effectiveAtByField: Record<string, string | null>;
  sourceEventIdsByField: Record<string, string[]>;
  acceptedAt: string;
  override: { actor: string; reasonCode: string } | null;
}
