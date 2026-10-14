import type { ClaimBody, DispositionState, EvidenceAssessment, EvidenceClaim, ReplayMode } from "./evidence-types.js";
import type { JsonValue } from "./types.js";
import type { InterpretationRun } from "../intelligence/types.js";

export interface ObservationDisposition {
  id: string;
  sourceEventId: string;
  canonicalEventId: string | null;
  originObservationKey: string;
  pipelineVersion: string;
  attempt: number;
  runId: string | null;
  state: DispositionState;
  claimIds: string[];
  reasonCode: string | null;
  retryable: boolean;
  nextAttemptAt: string | null;
  leaseOwner: string | null;
  leaseUntil: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface EvidenceCoverage {
  pipelineVersion: string;
  activeObservations: number;
  states: Record<DispositionState | "unseen", number>;
  retryBacklog: number;
  oldestRetryAt: string | null;
  evidenceJobs: { pending: number; running: number; failed: number;
    oldestPendingAt: string | null };
  outputs: { savedClaims: number; savedAssessments: number;
    pendingAssessedProposals: number; acceptedAssessedTaskRevisions: number };
}

export function emptyEvidenceCoverage(pipelineVersion: string): EvidenceCoverage {
  return { pipelineVersion, activeObservations: 0, retryBacklog: 0, oldestRetryAt: null,
    evidenceJobs: { pending: 0, running: 0, failed: 0, oldestPendingAt: null },
    outputs: { savedClaims: 0, savedAssessments: 0,
      pendingAssessedProposals: 0, acceptedAssessedTaskRevisions: 0 },
    states: { unseen: 0, pending: 0, processing: 0, extracted: 0, partial: 0,
      processed: 0, no_claim: 0, duplicate: 0, unresolved: 0, failed: 0 } };
}

export interface InferenceBudget {
  id: string;
  label: string;
  state: "active" | "exhausted" | "suspended" | "closed";
  maxCalls: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxUsd: string | null;
  deadline: string;
  reservedCalls: number;
  spentCalls: number;
  reservedInputTokens: number;
  spentInputTokens: number;
  reservedOutputTokens: number;
  spentOutputTokens: number;
  reservedUsd: string;
  spentUsd: string;
}

export type ModelCallState = "reserved" | "dispatched" | "succeeded" | "failed" | "unknown" | "cancelled" | "cache_hit";
export type ModelCallPurpose = "observe" | "route" | "embed" | "rank" | "extract" | "identity" | "assess" | "verify" | "summarize" | "artifact_fetch";

export interface ModelCall {
  id: string;
  budgetId: string;
  runId: string;
  purpose: ModelCallPurpose;
  logicalCallKey: string;
  attempt: number;
  provider: string;
  model: string;
  state: ModelCallState;
  requestHash: string;
  cacheKey: string | null;
  reservedInputTokens: number;
  reservedOutputTokens: number;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  embeddingItems: number | null;
  costUsd: string | null;
  costBasis: "provider" | "estimated" | "known_zero" | "unknown";
  providerRequestId: string | null;
  errorCode: string | null;
  createdAt: string;
  dispatchedAt: string | null;
  finishedAt: string | null;
}

export interface ReserveCallInput {
  budgetId: string;
  runId: string;
  /** Current accepted-source receipts whose text is included beyond the run inputs. */
  contextualSourceEventIds?: string[];
  purpose: ModelCallPurpose;
  logicalCallKey: string;
  attempt: number;
  provider: string;
  model: string;
  requestHash: string;
  request: JsonValue;
  cacheKey: string | null;
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedUsd: string | null;
}

export interface SettleCallInput {
  callId: string;
  state: Extract<ModelCallState, "succeeded" | "failed" | "unknown" | "cancelled">;
  providerRequestId: string | null;
  resolvedModelVersion: string | null;
  inputTokens: number | null;
  cachedInputTokens: number | null;
  outputTokens: number | null;
  embeddingItems: number | null;
  costUsd: string | null;
  costBasis: ModelCall["costBasis"];
  errorCode: string | null;
  response: JsonValue | null;
  finishedAt: string;
}

export interface V2RunCreate {
  model: string;
  inputHash: string;
  eventIds: string[];
  pipelineVersion: string;
  promptVersion: string;
  policyVersion: string;
  configHash: string;
  replayMode: ReplayMode;
  evaluationClock: string;
  knowledgeCutoff: string | null;
  budgetId: string;
  manifest: JsonValue;
}

export interface SaveExtractionInput {
  runId: string;
  episodeKey: string;
  inputHash: string;
  claims: ClaimBody[];
  dispositions: { dispositionId: string; eventId: string; state: Extract<DispositionState, "extracted" | "partial" | "no_claim" | "unresolved">; claimOrdinals: number[]; reasonCode: string | null }[];
  dependencies: readonly unknown[];
  expectedLeases: { dispositionId: string; attempt: number; owner: string }[];
}

export interface ObservationAgentCheckpoint {
  budgetId: string;
  transcript: JsonValue[];
  nextTurn: number;
  finished: boolean;
  writes: number;
  sourceEventIds: string[];
}

export interface EvidenceStore {
  observationAcceptedSourceEventIds(ids: readonly string[]): Promise<string[]>;
  completeObservationAgent(input: { runId: string; dispositionId: string; owner: string; writes: number }): Promise<void>;
  getObservationAgentCheckpoint(runId: string): Promise<ObservationAgentCheckpoint | null>;
  saveObservationAgentCheckpoint(input: { runId: string; dispositionId: string; owner: string;
    checkpoint: ObservationAgentCheckpoint }): Promise<void>;
  getWorkEntityEmbedding(input: { entityType: "task" | "project" | "claim" | "context" | "query"; entityId: string;
    model: string; modelVersion: string; inputHash: string;
    permissionFingerprint: string }): Promise<number[] | null>;
  putWorkEntityEmbedding(input: { entityType: "task" | "project" | "claim" | "context" | "query"; entityId: string;
    model: string; modelVersion: string; inputHash: string;
    permissionFingerprint: string; vector: number[] }): Promise<void>;
  createInferenceBudget(input: { label: string; maxCalls: number; maxInputTokens: number; maxOutputTokens: number; maxUsd: string | null; deadline: string; priceBasis: JsonValue | null }): Promise<InferenceBudget>;
  getInferenceBudget(id: string): Promise<InferenceBudget | null>;
  createV2Run(input: V2RunCreate): Promise<InterpretationRun>;
  claimObservation(input: { eventId: string; pipelineVersion: string; workerId: string;
    leaseSeconds: number; now: string; reopenNoClaim?: boolean }): Promise<{
    kind: "claimed" | "duplicate" | "busy" | "terminal"; disposition: ObservationDisposition }>;
  getLatestObservationDisposition(eventId: string, pipelineVersion: string): Promise<ObservationDisposition | null>;
  getEvidenceCoverage(pipelineVersion: string): Promise<EvidenceCoverage>;
  failObservationClaims(input: { leases: { dispositionId: string; attempt: number; owner: string }[];
    runId: string | null; reasonCode: string }): Promise<void>;
  saveExtraction(input: SaveExtractionInput): Promise<{ claims: EvidenceClaim[]; dispositions: ObservationDisposition[] }>;
  getClaims(ids: readonly string[]): Promise<EvidenceClaim[]>;
  listClaimsByRun(runId: string): Promise<EvidenceClaim[]>;
  listClaimsForTask(taskId: string, afterClaimId: string | null, limit: number): Promise<EvidenceClaim[]>;
  listUnlinkedClaimsForTask(taskId: string, cursor: { createdAt: string; id: string } | null,
    after: string | null, through: string, limit: number): Promise<EvidenceClaim[]>;
  listAffectedTaskIdsBySource(eventId: string, afterTaskId: string | null, limit: number): Promise<string[]>;
  saveAssessment(input: Omit<EvidenceAssessment, "id" | "createdAt">, dependencies: readonly unknown[]): Promise<EvidenceAssessment>;
  getAssessment(id: string): Promise<EvidenceAssessment | null>;
  listAssessmentsForTask(taskId: string, limit: number): Promise<EvidenceAssessment[]>;
  listModelCallContextSourceIds(runId: string): Promise<string[]>;
  reserveModelCall(input: ReserveCallInput): Promise<{ kind: "reserved"; call: ModelCall } | { kind: "exhausted"; reason: string }>;
  markModelCallDispatched(callId: string, at: string): Promise<void>;
  settleModelCall(input: SettleCallInput): Promise<ModelCall>;
  reconcileUnknownModelCallAtReservedBound(callId: string): Promise<ModelCall>;
  listModelCalls(runId: string): Promise<ModelCall[]>;
  getModelCallResponseByKey(logicalCallKey: string): Promise<{
    call: ModelCall; response: JsonValue | null } | null>;
}
