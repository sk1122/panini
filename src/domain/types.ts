export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const sourceProviders = ["notion", "slack", "github", "agent", "manual"] as const;
export type SourceProvider = (typeof sourceProviders)[number];

export type MemberRole = "owner" | "admin" | "reviewer" | "member";
export type MemberStatus = "active" | "disabled";

export interface Organization {
  id: string;
  slug: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export interface Member {
  id: string;
  organizationId: string;
  subject: string;
  displayName: string;
  email: string | null;
  role: MemberRole;
  status: MemberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewMember {
  subject: string;
  displayName: string;
  email?: string | null;
  role?: MemberRole;
  status?: MemberStatus;
}

export interface MemberIdentity {
  id: string;
  organizationId: string;
  memberId: string | null;
  provider: SourceProvider;
  installationKey: string;
  externalId: string;
  displayName: string | null;
  email: string | null;
  status: MemberStatus;
  createdAt: string;
  updatedAt: string;
}

export interface NewMemberIdentity {
  provider: SourceProvider;
  installationKey: string;
  externalId: string;
  displayName?: string | null;
  email?: string | null;
  status?: MemberStatus;
}

export type MemberIdentityMatch = "identity" | "email" | "display_name" | "created" | "unresolved";

export interface MemberIdentityReconciliation {
  member: Member | null;
  identity: MemberIdentity;
  matchedBy: MemberIdentityMatch;
}

export type SourceInstallationStatus = "configured" | "healthy" | "degraded" | "revoked" | "disabled";
export type SourceInstallationTransport = "poll" | "socket_mode" | "webhook" | "local";

export interface SourceInstallation {
  id: string;
  organizationId: string;
  provider: SourceProvider;
  installationKey: string;
  displayName: string;
  transport: SourceInstallationTransport;
  status: SourceInstallationStatus;
  config: { [key: string]: JsonValue };
  lastSyncAt: string | null;
  lastSuccessAt: string | null;
  lastEventAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewSourceInstallation {
  provider: SourceProvider;
  installationKey: string;
  displayName: string;
  transport: SourceInstallationTransport;
  status?: SourceInstallationStatus;
  config?: { [key: string]: JsonValue };
}

export interface SourceInstallationUpdate {
  status?: SourceInstallationStatus;
  config?: { [key: string]: JsonValue };
  lastSyncAt?: string | null;
  lastSuccessAt?: string | null;
  lastEventAt?: string | null;
  lastError?: string | null;
}

export type ConnectorSyncStatus = "idle" | "running" | "healthy" | "degraded" | "revoked";

export interface ConnectorSyncState {
  id: string;
  organizationId: string;
  installationId: string;
  resourceKey: string;
  status: ConnectorSyncStatus;
  cursor: { [key: string]: JsonValue };
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastRepairAt: string | null;
  lastError: string | null;
  observedCount: number;
  revokedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorSyncStateUpdate {
  status?: ConnectorSyncStatus;
  cursor?: { [key: string]: JsonValue };
  lastAttemptAt?: string | null;
  lastSuccessAt?: string | null;
  lastRepairAt?: string | null;
  lastError?: string | null;
  observedCount?: number;
  revokedCount?: number;
}

export interface AuditEvent {
  id: string;
  organizationId: string;
  actor: string;
  action: string;
  targetType: string;
  targetId: string | null;
  sourceEventId: string | null;
  proposalId: string | null;
  details: { [key: string]: JsonValue };
  occurredAt: string;
}

export interface NewAuditEvent extends Omit<AuditEvent, "id" | "organizationId" | "occurredAt"> {
  occurredAt?: string;
}

export type OutboxJobState = "pending" | "running" | "completed" | "failed";

export interface OutboxJob {
  id: string;
  organizationId: string;
  topic: string;
  dedupeKey: string;
  payload: JsonValue;
  state: OutboxJobState;
  attempts: number;
  availableAt: string;
  lockedAt: string | null;
  lockedBy: string | null;
  completedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewOutboxJob {
  topic: string;
  dedupeKey: string;
  payload: JsonValue;
  availableAt?: string;
}

export interface WorkspaceSnapshot {
  organization: Organization;
  members: Member[];
  memberIdentities: MemberIdentity[];
  installations: SourceInstallation[];
  connectorSyncs: ConnectorSyncState[];
  generatedAt: string;
}

export interface AllowedAction {
  action: "approve" | "edit" | "reject" | "supersede" | "rebase" | "undo";
  allowed: boolean;
  reason: string;
}

export const taskStatuses = [
  "backlog",
  "planned",
  "in_progress",
  "blocked",
  "review",
  "done",
  "cancelled",
] as const;

export type TaskStatus = (typeof taskStatuses)[number];
export type TaskPriority = "low" | "medium" | "high" | "urgent";

export type WorkContainerStatus = "active" | "paused" | "completed" | "archived";

export interface Project {
  id: string;
  organizationId: string;
  version: number;
  name: string;
  aliases: string[];
  slug: string;
  outcome: string;
  owner: string | null;
  status: WorkContainerStatus;
  sourceRef: string;
  sourceUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Workstream {
  id: string;
  organizationId: string;
  projectId: string;
  name: string;
  outcome: string;
  owner: string | null;
  status: WorkContainerStatus;
  createdAt: string;
  updatedAt: string;
}

export type WorkLinkType = "depends_on" | "blocks" | "relates_to" | "duplicates";

export interface WorkLink {
  id: string;
  organizationId: string;
  taskId: string;
  targetTaskId: string | null;
  targetRef: string;
  linkType: WorkLinkType;
  createdAt: string;
  updatedAt: string;
}

export interface WorkLinkRevision {
  id: string;
  organizationId: string;
  linkId: string;
  version: number;
  previous: WorkLink | null;
  current: WorkLink;
  changedAt: string;
  changedBy: string;
  proposalId: string | null;
}

export interface WorkGraph {
  projects: Project[];
  workstreams: Workstream[];
  tasks: Task[];
  links: WorkLink[];
  generatedAt: string;
}

export interface TaskFields {
  externalRef: string | null;
  /** Canonical link when an accepted project relationship has been reviewed. */
  projectId?: string | null;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  owner: string | null;
  project: string | null;
  dueDate: string | null;
  dependencyRefs: string[];
  sourceUrl: string | null;
  outcomeContract?: import("./evidence-types.js").OutcomeContract | null;
  result?: import("./evidence-types.js").WorkResult;
}

export interface Task extends TaskFields {
  id: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SourceEventInput {
  provider: string;
  installationKey: string;
  providerEventId: string;
  eventKind: string;
  occurredAt: string;
  fetchedAt: string;
  sourceRef: string;
  sourceUrl: string | null;
  contentHash: string;
  visibility: string;
  payloadVersion: string;
  payload: JsonValue;
  supersedesEventId?: string | null;
  observationIdentity?: import("../intelligence/observation-identity.js").ObservationIdentity | null;
}

export interface SourceEvent extends SourceEventInput {
  id: string;
  receivedAt: string;
  authorizationVersion?: number;
}

export interface SourceDocumentSection {
  id: string;
  heading: string;
  headingPath: string[];
  level: number;
  startLine: number;
  endLine: number;
  characterCount: number;
  excerpt: string;
}

export interface SourceDocumentSummary {
  sourceEventId: string;
  provider: string;
  sourceRef: string;
  sourceUrl: string | null;
  sourcePath: string;
  title: string;
  suggestedPath: string;
  contentHash: string;
  occurredAt: string;
  fetchedAt: string;
  receivedAt: string;
  visibility: string;
  characterCount: number;
  sections: SourceDocumentSection[];
  matchedSectionIds: string[];
  relatedContextEntryIds: string[];
  /** Set on budgeted context-pack pointers; source_read returns the full outline. */
  omittedSectionCount?: number;
}

export interface SourceDocumentRead {
  document: SourceDocumentSummary;
  section: SourceDocumentSection | null;
  markdown: string;
  truncated: boolean;
  authority: string[];
}

export interface SourceDocumentSignal {
  type: "source_document_snapshot";
  suggestedPath: string;
  title: string;
}

export interface TaskSignal {
  type: "task_snapshot";
  fields: TaskFields;
}

export type WorkSignal = SourceDocumentSignal | TaskSignal;

export interface Observation {
  event: SourceEventInput;
  signal: WorkSignal;
}

export type ProposalState = "pending" | "escalated" | "approved" | "rejected" | "auto_applied" | "superseded";
export type ProposalKind =
  | "task_create"
  | "task_change"
  | "context_update"
  | "context_file_upsert"
  | "context_fact_upsert";

export interface TaskProposalChanges extends Partial<TaskFields> {
  externalRef?: string | null;
}

export interface ContextProposalChanges {
  sourceRef: string;
  key: string;
  title: string;
  body: string;
  sourceUrl: string | null;
}

export const contextFactTypes = [
  "identity",
  "decision",
  "policy",
  "constraint",
  "preference",
  "relationship",
  "metric",
  "reference",
  "other",
] as const;

export type ContextFactType = (typeof contextFactTypes)[number];
export type ContextFactValue = string | number | boolean;

export const contextLifecycleStates = ["accepted", "needs_review", "superseded"] as const;
export type ContextLifecycleState = (typeof contextLifecycleStates)[number];

export const contextLinkTypes = ["project", "workstream", "task", "member"] as const;
export type ContextLinkType = (typeof contextLinkTypes)[number];

export interface ContextLink {
  type: ContextLinkType;
  targetId: string | null;
  targetRef: string;
}

interface ContextTemporalChanges {
  lifecycleState?: ContextLifecycleState;
  effectiveFrom?: string;
  effectiveTo?: string | null;
  links?: ContextLink[];
}

export interface ContextFileProposalChanges extends ContextTemporalChanges {
  sourceRef: string;
  path: string;
  title: string;
  body: string;
  sourceUrl: string | null;
}

export interface ContextFactProposalChanges extends ContextTemporalChanges {
  sourceRef: string;
  path: string;
  title: string;
  factType: ContextFactType;
  value: ContextFactValue;
  sourceUrl: string | null;
}

export type ProposalChanges =
  | TaskProposalChanges
  | ContextProposalChanges
  | ContextFileProposalChanges
  | ContextFactProposalChanges;

interface ProposalBase {
  id: string;
  clientEventId: string | null;
  taskId: string | null;
  baseVersion: number | null;
  state: ProposalState;
  rationale: string;
  requestedBy: string;
  evidenceIds: string[];
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
  assessmentId?: string | null;
  applicationKey?: string | null;
  decisionMetadata?: import("./evidence-types.js").DecisionMetadata | null;
}

export type Proposal = ProposalBase & (
  | { kind: "task_create" | "task_change"; changes: TaskProposalChanges }
  | { kind: "context_update"; changes: ContextProposalChanges }
  | { kind: "context_file_upsert"; changes: ContextFileProposalChanges }
  | { kind: "context_fact_upsert"; changes: ContextFactProposalChanges }
);

interface NewProposalBase {
  clientEventId?: string | null;
  taskId: string | null;
  baseVersion: number | null;
  rationale: string;
  requestedBy: string;
  evidenceIds: string[];
  assessmentId?: string | null;
  applicationKey?: string | null;
  decisionMetadata?: import("./evidence-types.js").DecisionMetadata | null;
}

export type NewProposal = NewProposalBase & (
  | { kind: "task_create" | "task_change"; changes: TaskProposalChanges }
  | { kind: "context_update"; changes: ContextProposalChanges }
  | { kind: "context_file_upsert"; changes: ContextFileProposalChanges }
  | { kind: "context_fact_upsert"; changes: ContextFactProposalChanges }
);

export interface TaskRevision {
  id: string;
  taskId: string;
  version: number;
  proposalId: string;
  previous: Task | null;
  current: Task;
  appliedAt: string;
  appliedBy: string;
  decisionMetadata?: import("./evidence-types.js").DecisionMetadata | null;
}

export interface ProjectChanges {
  name?: string;
  aliases?: string[];
  outcome?: string;
  owner?: string | null;
  status?: WorkContainerStatus;
  sourceUrl?: string | null;
}

export interface ProjectProposal {
  id: string;
  kind: "project_create" | "project_change";
  projectId: string | null;
  baseVersion: number | null;
  changes: ProjectChanges;
  evidenceIds: string[];
  rationale: string;
  requestedBy: string;
  state: ProposalState;
  createdAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  decisionNote: string | null;
}

export interface NewProjectProposal extends Omit<ProjectProposal, "id" | "state" | "createdAt" | "decidedAt" | "decidedBy" | "decisionNote"> {}

export interface ProjectRevision {
  id: string;
  projectId: string;
  version: number;
  proposalId: string;
  previous: Project | null;
  current: Project;
  appliedAt: string;
  appliedBy: string;
}

export interface TaskDetail {
  task: Task;
  revisions: TaskRevision[];
  proposals: Proposal[];
  evidence: Omit<SourceEvent, "payload">[];
  activityCandidates: Omit<SourceEvent, "payload">[];
  activityCoverage: { scanned: number; limit: number; bounded: boolean };
  allowedActions: AllowedAction[];
}

export interface ProposalDetail {
  proposal: Proposal;
  before: Task | null;
  after: TaskFields | ProposalChanges;
  evidence: Omit<SourceEvent, "payload">[];
  stale: boolean;
  allowedActions: AllowedAction[];
}

interface ContextEntryBase {
  id: string;
  sourceEventId: string;
  sourceRef: string;
  path: string;
  title: string;
  sourceUrl: string | null;
  contentHash: string;
  evidenceIds: string[];
  lifecycleState: ContextLifecycleState;
  effectiveFrom: string;
  effectiveTo: string | null;
  links: ContextLink[];
  updatedAt: string;
}

export interface ContextFile extends ContextEntryBase {
  kind: "file";
  body: string;
}

export interface ContextFact extends ContextEntryBase {
  kind: "fact";
  factType: ContextFactType;
  value: ContextFactValue;
}

export type ContextEntry = ContextFile | ContextFact;

export interface ContextRevision {
  id: string;
  contextEntryId: string;
  version: number;
  proposalId: string;
  previous: ContextEntry | null;
  current: ContextEntry;
  appliedAt: string;
  appliedBy: string;
}

export type NewContextEntry =
  | Omit<ContextFile, "id" | "updatedAt">
  | Omit<ContextFact, "id" | "updatedAt">;

export interface ContextTreeNode {
  kind: "folder" | "file" | "fact";
  name: string;
  path: string;
  entryId: string | null;
  lifecycleState: ContextLifecycleState | null;
  effectiveFrom: string | null;
  effectiveTo: string | null;
  children: ContextTreeNode[];
}

export interface ContextFileSummary extends Omit<ContextFile, "body"> {
  excerpt: string;
  characterCount: number;
}

export interface ContextIndex {
  generatedAt: string;
  tree: ContextTreeNode[];
  facts: ContextFact[];
  files: ContextFileSummary[];
  counts: {
    facts: number;
    files: number;
    folders: number;
    accepted: number;
    needsReview: number;
    superseded: number;
    outsideEffectiveInterval: number;
  };
}

export const agentHarnesses = ["codex", "claude_code", "hermes", "pi", "generic_mcp"] as const;
export type AgentHarness = (typeof agentHarnesses)[number];

export const agentCapabilities = [
  "work:read",
  "work:propose",
  "context:read",
  "source:read",
  "context:propose",
  "evidence:report",
  "workspace:read",
  "workspace:write",
] as const;
export type AgentCapability = (typeof agentCapabilities)[number];
export type AgentProfileStatus = "active" | "revoked";

export interface AgentDataScope {
  projects: string[];
  contextPaths: string[];
  sourceVisibilities: string[];
}

export interface AgentProfile {
  id: string;
  memberId: string | null;
  owner: string;
  name: string;
  harness: AgentHarness;
  description: string;
  capabilities: AgentCapability[];
  dataScope: AgentDataScope;
  status: AgentProfileStatus;
  tokenHint: string;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
}

export interface NewAgentProfile {
  memberId: string;
  owner: string;
  name: string;
  harness: AgentHarness;
  description: string;
  capabilities: AgentCapability[];
  dataScope: AgentDataScope;
  tokenHash: string;
  tokenHint: string;
}

export interface AgentWorkspaceFileSummary {
  uri: string;
  path: string;
  version: number;
  byteSize: number;
  updatedAt: string;
}

export interface AgentWorkspaceFile extends AgentWorkspaceFileSummary {
  content: string;
}

export interface AgentWorkspaceWrite {
  scope?: "agent" | "user";
  memberId: string;
  agentProfileId: string;
  path: string;
  expectedVersion: number;
  content: string | null;
}

export type DeviceStatus = "active" | "revoked";
export type PrivacyMode = "metadata" | "approved_excerpts";

export interface AgentDevice {
  id: string;
  organizationId: string;
  agentProfileId: string;
  name: string;
  publicKey: string;
  status: DeviceStatus;
  privacyMode: PrivacyMode;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewAgentDevice {
  agentProfileId: string;
  name: string;
  publicKey: string;
  privacyMode: PrivacyMode;
}

export interface RepositoryMapping {
  id: string;
  organizationId: string;
  repository: string;
  project: string;
  contextPaths: string[];
  createdAt: string;
  updatedAt: string;
}

export interface NewRepositoryMapping {
  repository: string;
  project: string;
  contextPaths: string[];
}

export interface BoardSnapshot {
  tasks: Task[];
  proposals: Proposal[];
  generatedAt: string;
}

export interface ContextPack {
  generatedAt: string;
  entries: ContextEntry[];
  tree: ContextTreeNode[];
  tasks: Task[];
  pendingProposals: Proposal[];
}

export interface RetrievalCitation {
  entryId: string;
  path: string;
  title: string;
  sourceUrl: string | null;
  sourceDocumentIds: string[];
  supportingSources: { sourceEventId: string; sourceVersionKey: string | null;
    receivedAt: string }[];
  supportingSourceOmittedCount: number;
  contentHash: string;
  lifecycleState: ContextLifecycleState;
  effectiveFrom: string;
  effectiveTo: string | null;
  sourceOccurredAt: string;
  updatedAt: string;
}

export const contextOutlineSections = [
  "architecture",
  "specifications",
  "decisions",
  "policies",
  "plans",
  "research",
  "company",
  "other",
] as const;

export type ContextOutlineSectionKey = (typeof contextOutlineSections)[number];

export interface ContextOutlineEntry {
  entryId: string;
  kind: ContextEntry["kind"];
  path: string;
  title: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  links: ContextLink[];
  updatedAt: string;
}

export interface ContextOutlineSection {
  key: ContextOutlineSectionKey;
  title: string;
  entries: ContextOutlineEntry[];
}

export interface WorkDependencyEdge {
  taskId: string;
  dependsOnTaskId: string;
  reference: string;
}

export interface WorkBrief {
  counts: {
    total: number;
    remaining: number;
    completed: number;
    cancelled: number;
    byStatus: Record<TaskStatus, number>;
  };
  focusTaskIds: string[];
  blockedTaskIds: string[];
  activeTaskIds: string[];
  remainingTaskIds: string[];
  recentlyCompletedTaskIds: string[];
  dependencyEdges: WorkDependencyEdge[];
  unresolvedDependencies: { taskId: string; references: string[] }[];
  pendingProposalIds: string[];
  escalatedProposalIds: string[];
  omittedTaskCount: number;
}

export interface AgentContextGuide {
  purpose: string;
  authority: string[];
  readingOrder: string[];
}

export interface RetrievalResult {
  status: "ready" | "abstained";
  abstentionReason: string | null;
  objective: string;
  query: string;
  provider: "postgres" | "jev" | "embedding_jev";
  generatedAt: string;
  asOf?: string;
  guide: AgentContextGuide;
  outline: ContextOutlineSection[];
  work: WorkBrief;
  entries: ContextEntry[];
  tasks: Task[];
  summary?: { text: string; basis: "accepted_projection"; asOf: string;
    taskCount: number; contextEntryCount: number; coverage: "bounded" };
  taskEvidence?: { taskId: string; contractVersion: number | null; knownAt: string;
    reportedClaims: { claimId: string; kind: string; statement: string; assertedAt: string;
      sourceEventIds: string[]; receivedAt: string }[];
    assessments: { assessmentId: string; claimIds: string[]; disposition: string;
      reasonCodes: string[]; criteria: { criterionId: string; verdict: string }[];
      coverageGaps: string[]; checkedAt: string; sourceEventIds: string[] }[];
    omittedClaimCount: number; coverage: "linked_claims_only" }[];
  sources: SourceDocumentSummary[];
  citations: RetrievalCitation[];
  omitted: { reason: "character_budget" | "item_limit" | "candidate_limit" | "no_match" | "visibility" | "deleted" | "catalog_budget" | "source_budget" | "task_budget" | "claim_budget"; count: number }[];
  manifest: {
    organizationId: string;
    provider: "postgres" | "jev" | "embedding_jev";
    rankingModel?: string;
    embeddingModel?: string;
    candidateCount: number;
    returnedCount: number;
    characterBudget: number;
    usedCharacters: number;
    entryVersions: { entryId: string; contentHash: string; updatedAt: string }[];
  };
}

export function isContextProposal(
  proposal: Proposal,
): proposal is Extract<Proposal, { kind: "context_update" | "context_file_upsert" | "context_fact_upsert" }> {
  return proposal.kind === "context_update" ||
    proposal.kind === "context_file_upsert" ||
    proposal.kind === "context_fact_upsert";
}

export function isOpenProposalState(state: ProposalState): state is "pending" | "escalated" {
  return state === "pending" || state === "escalated";
}
