import type {
  ContextEntry,
  ContextFactType,
  ContextFactValue,
  JsonValue,
  SourceEvent,
  Task,
  TaskPriority,
  TaskStatus,
  WorkContainerStatus,
} from "../domain/types.js";
import type { ModelUsage } from "../model-usage.js";

export type IntelligenceMode = "manual" | "interval";

export interface IntelligenceConfig {
  enabled: boolean;
  mode: IntelligenceMode;
  intervalSeconds: number;
  maxEventsPerRun: number;
  maxEvidenceCharacters: number;
  maxSourceDocumentCharacters: number;
  maxContextCharacters: number;
  minimumConfidence: number;
  completionMinimumConfidence: number;
  completionMinimumEvidenceItems: number;
  completionEvidenceProviders: string[];
  reconciliationEnabled?: boolean;
  reconciliationIntervalSeconds?: number;
  reconciliationMinimumAgeSeconds?: number;
  sourceProviders: string[];
}

export interface EvidenceDigest {
  id: string;
  provider: string;
  eventKind: string;
  occurredAt: string;
  sourceRef: string;
  sourceUrl: string | null;
  payloadExcerpt: string;
  route: ObservationRoute;
  routeConfidence: number;
}

export type ObservationRoute = "task" | "information" | "both" | "neither";

export interface ObservationRouteDecision {
  eventId: string;
  route: ObservationRoute;
  confidence: number;
}

export interface EvidenceRouter {
  readonly name: string;
  route(events: SourceEvent[]): Promise<ObservationRouteDecision[]>;
}

export interface ContextDigest {
  kind: ContextEntry["kind"];
  path: string;
  title: string;
  contentExcerpt: string;
  factType: ContextFactType | null;
  sourceUrl: string | null;
  updatedAt: string;
}

export interface TaskDigest {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner: string | null;
  project: string | null;
  dueDate: string | null;
  dependencyRefs: string[];
  version: number;
}

export interface ProjectDigest {
  id: string;
  name: string;
  aliases: string[];
  outcome: string;
  owner: string | null;
  status: WorkContainerStatus;
  version: number;
}

export interface MemberDigest {
  subject: string;
  displayName: string;
  status: "active" | "disabled";
  identities: Array<{
    provider: string;
    installationKey: string;
    externalId: string;
    displayName: string | null;
    status: "active" | "disabled";
  }>;
}

export interface EvidenceInterpreterInput {
  companyName: string;
  members: MemberDigest[];
  projects?: ProjectDigest[];
  tasks: TaskDigest[];
  context: ContextDigest[];
  events: EvidenceDigest[];
  retrieval?: {
    provider: "embedding_jev" | "legacy";
    embeddingModel: string | null;
    rankingModel: string | null;
    candidateCount: number;
    shortlistedCount: number;
    episodeGrouping: "explicit" | "semantic" | "single" | "information_batch";
  };
  coverage?: {
    complete: boolean;
    gaps: Array<{ provider: string; resource: string; status: string; reason: string | null }>;
  };
}

export type FindingKind = "project_upsert" | "task_change" | "task_create" | "task_duplicate" | "context_file_upsert" | "context_fact_upsert" | "abstain";

export interface InterpretationFinding {
  kind: FindingKind;
  taskId: string | null;
  duplicateOfTaskId?: string | null;
  title: string | null;
  description: string | null;
  status: TaskStatus | null;
  priority: TaskPriority | null;
  owner: string | null;
  project: string | null;
  projectId?: string | null;
  projectOutcome?: string | null;
  projectStatus?: WorkContainerStatus | null;
  dueDate: string | null;
  dependencyRefs: string[];
  contextPath: string | null;
  contextTitle: string | null;
  contextBody: string | null;
  contextFactType: ContextFactType | null;
  contextFactValue: ContextFactValue | null;
  rationale: string;
  confidence: number;
  evidenceEventIds: string[];
  caveats: string[];
}

export interface InterpretationOutput {
  summary: string;
  findings: InterpretationFinding[];
  usage?: ModelUsage;
}

export interface EvidenceInterpreter {
  readonly name: string;
  interpret(input: EvidenceInterpreterInput): Promise<InterpretationOutput>;
}

export type FindingOutcomeState = "applied" | "abstained" | "rejected";

export interface FindingOutcome {
  index: number;
  kind: FindingKind;
  state: FindingOutcomeState;
  proposalId: string | null;
  reason: string;
}

export type IntelligenceRunState = "completed" | "failed" | "no_evidence";

export interface IntelligenceRunReport {
  id: string | null;
  state: IntelligenceRunState;
  model: string;
  eventIds: string[];
  summary: string;
  outcomes: FindingOutcome[];
  usage: ModelUsage | null;
  startedAt: string;
  finishedAt: string;
}

export interface IntelligenceRunRequest {
  /** Explicit active evidence to reinterpret, even when a prior run completed it. */
  eventIds?: string[];
}

export type StoredInterpretationState = "running" | "completed" | "failed";

export interface InterpretationRun {
  id: string;
  inputHash: string;
  model: string;
  state: StoredInterpretationState;
  eventIds: string[];
  output: JsonValue | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface NewInterpretationRun {
  inputHash: string;
  model: string;
  eventIds: string[];
}

export interface EvidenceIntelligenceOptions {
  store: {
    appendSourceEvent(input: import("../domain/types.js").SourceEventInput): Promise<import("../domain/store.js").EventAppendResult>;
    getSourceEvents(ids: string[]): Promise<SourceEvent[]>;
    getLatestSourceEventBySourceRef(provider: string, installationKey: string, sourceRef: string): Promise<SourceEvent | null>;
    listUninterpretedSourceEvents(providers: string[], limit: number, model?: string): Promise<SourceEvent[]>;
    createInterpretationRun(input: NewInterpretationRun): Promise<InterpretationRun>;
    completeInterpretationRun(id: string, output: JsonValue): Promise<InterpretationRun>;
    failInterpretationRun(id: string, error: string): Promise<InterpretationRun>;
    listInterpretationRuns(limit: number): Promise<InterpretationRun[]>;
    appendAuditEvent(input: import("../domain/types.js").NewAuditEvent): Promise<import("../domain/types.js").AuditEvent>;
    listTaskRevisions(taskId: string): Promise<import("../domain/types.js").TaskRevision[]>;
    listTaskProposals(taskId: string): Promise<import("../domain/types.js").Proposal[]>;
  };
  ledger: {
    retrieve(input: {
      objective: string;
      query?: string;
      limit?: number;
      characterBudget?: number;
    }): Promise<{ entries: ContextEntry[]; tasks: Task[] }>;
    workspace(): Promise<{
      members: import("../domain/types.js").Member[];
      memberIdentities: import("../domain/types.js").MemberIdentity[];
      installations: import("../domain/types.js").SourceInstallation[];
      connectorSyncs: import("../domain/types.js").ConnectorSyncState[];
    }>;
    getTask(id: string): Promise<Task | null>;
    workGraph(): Promise<import("../domain/types.js").WorkGraph>;
    propose(input: {
      taskId: string;
      changes: import("../domain/types.js").TaskProposalChanges;
      rationale: string;
      requestedBy: string;
      evidenceIds?: string[];
    }): Promise<import("../domain/types.js").Proposal>;
    proposeTaskCreation(input: import("../domain/team-ledger.js").ProposeTaskCreationInput): Promise<import("../domain/types.js").Proposal>;
    proposeContextFile(input: import("../domain/team-ledger.js").ProposeContextFileInput): Promise<import("../domain/types.js").Proposal>;
    proposeContextFact(input: import("../domain/team-ledger.js").ProposeContextFactInput): Promise<import("../domain/types.js").Proposal>;
    approveProposal(id: string, actor: string, note: string | null): Promise<Task | ContextEntry>;
    rejectProposal(id: string, actor: string, note: string | null): Promise<import("../domain/types.js").Proposal>;
    proposeProjectCreation(input: {
      changes: import("../domain/types.js").ProjectChanges;
      rationale: string;
      requestedBy: string;
      evidenceIds: string[];
    }): Promise<import("../domain/types.js").ProjectProposal>;
    proposeProjectChange(projectId: string, input: {
      baseVersion: number;
      changes: import("../domain/types.js").ProjectChanges;
      rationale: string;
      requestedBy: string;
      evidenceIds: string[];
    }): Promise<import("../domain/types.js").ProjectProposal>;
    approveProjectProposal(id: string, actor: string, note: string | null): Promise<import("../domain/types.js").ProjectRevision>;
    markTaskDuplicate(duplicateTaskId: string, canonicalTaskId: string, rationale: string, actor: string,
      evidenceIds: string[]): Promise<{ proposalId: string | null; link: import("../domain/types.js").WorkLink }>;
  };
  interpreter: EvidenceInterpreter | null;
  router?: EvidenceRouter | null;
  episodeGrouper?: import("./observation-episodes.js").ObservationEpisodeGrouper | null;
  entityRetriever?: import("../retrieval/work-entity-retriever.js").WorkEntityRetriever | null;
  workJudge?: Pick<import("../reconciliation/jev-work-judge.js").JevWorkJudge, "judgeTaskStatus"> | null;
  workChangeJudge?: { judgeTaskChange(
    task: Pick<Task, "id" | "title" | "description" | "status">,
    proposed: Pick<Task, "title" | "description" | "status" | "priority" | "owner" | "project">,
    evidence: SourceEvent[],
  ): Promise<Pick<import("../reconciliation/jev-work-judge.js").TaskChangeJudgment,
    "relationship" | "relationshipProbability" | "changeSupportProbability" | "statusSupportProbability" | "completionSupportProbability">> } | null;
  workClaimJudge?: { judge(bundle: import("../reconciliation/evidence-bundle.js").WorkEvidenceBundle):
    Promise<Pick<import("../reconciliation/jev-work-judge.js").WorkJudgment, "kind" | "concreteActionProbability">> } | null;
  /** Fixed source-checkpoint evaluation time for an isolated historical replay. */
  coverageAsOf?: string;
  companyName: string;
  config: IntelligenceConfig;
  log: { info(message: string, fields?: object): void; error(message: string, fields?: object): void };
}
