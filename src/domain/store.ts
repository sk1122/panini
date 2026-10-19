import type { EvidenceStore } from "./evidence-store.js";
import type {
	AgentDataScope,
	AgentProfile,
	AgentWorkspaceFile,
	AgentWorkspaceFileSummary,
	AgentWorkspaceWrite,
	AgentDevice,
	AuditEvent,
	ContextEntry,
	ContextRevision,
	ConnectorSyncState,
	ConnectorSyncStateUpdate,
	Member,
	MemberIdentity,
	MemberIdentityReconciliation,
	NewMember,
	NewMemberIdentity,
	NewAgentProfile,
	NewAgentDevice,
	NewAuditEvent,
	NewContextEntry,
	NewOutboxJob,
	NewProposal,
	NewSourceInstallation,
	Organization,
	NewRepositoryMapping,
	OutboxJob,
	Proposal,
	ProposalChanges,
	ProposalState,
	Project,
	SourceEvent,
	SourceEventInput,
	SourceInstallation,
	SourceInstallationUpdate,
	RepositoryMapping,
	Task,
	TaskRevision,
	WorkLink,
	WorkLinkRevision,
	Workstream,
} from "./types.js";

export interface EventAppendResult {
	inserted: boolean;
	event: SourceEvent;
}

export interface DecideProposalInput {
	state: Extract<
		ProposalState,
		"escalated" | "approved" | "rejected" | "auto_applied" | "superseded"
	>;
	decidedBy: string;
	decisionNote: string | null;
	auditAction: string;
	auditDetails?: Record<string, import("./types.js").JsonValue>;
}

export interface ApproveAndApplyProposalInput {
	proposalId: string;
	state: Extract<ProposalState, "approved" | "auto_applied">;
	decidedBy: string;
	decisionNote: string | null;
	auditAction: string;
	auditDetails?: Record<string, import("./types.js").JsonValue>;
	authorityPolicy?: import("./evidence-types.js").EvidenceAuthorityPolicy;
	/** Internal observation agent receipt; effective time is read from storage. */
	observationEventId?: string;
	observationRunId?: string;
	observationLeaseOwner?: string;
	workStateAssessmentId?: string;
}

export interface ReplaceProposalInput {
	proposalId: string;
	replacement: NewProposal;
	decidedBy: string;
	decisionNote: string;
	auditAction: string;
}

export interface RebuildCurrentProjectionsInput {
	tasks: Task[];
	context: ContextEntry[];
	actor: string;
	details: Record<string, import("./types.js").JsonValue>;
}

export interface LedgerStore extends EvidenceStore {
	ensureWorkScope?(
		input: import("./work-state.js").WorkScopeCommand,
	): Promise<import("./work-state.js").WorkScope>;
	finalizeWorkScope?(
		input: import("./work-state.js").WorkScopeCommand & {
			modelCallId: string;
			context: import("./work-state.js").WorkScopeDefinitionContext;
		},
	): Promise<import("./work-state.js").WorkScope>;
	readWorkScope?(
		taskId: string,
		allowedVisibilities: string[] | null,
	): Promise<import("./work-state.js").WorkScope | null>;
	saveWorkStateAssessment?(
		input: Omit<import("./work-state.js").WorkStateReceipt, "id">,
	): Promise<import("./work-state.js").WorkStateReceipt>;
	appendWorkEvidence?(
		input: import("./work-ontology.js").WorkEvidenceWrite,
	): Promise<import("./work-ontology.js").WorkEvidence>;
	readWorkEvidence?(
		input: import("./work-ontology.js").WorkEvidenceRead,
	): Promise<import("./work-ontology.js").WorkEvidence[]>;
	readWorkStateAssessments?(
		taskId: string,
		allowedVisibilities: string[] | null,
	): Promise<import("./work-state.js").WorkStateReceipt[]>;
	getOrganization(): Promise<Organization>;
	setOrganizationName(name: string): Promise<Organization>;
	listMembers(): Promise<Member[]>;
	getMember(id: string): Promise<Member | null>;
	upsertMember(input: NewMember): Promise<Member>;
	listMemberIdentities(): Promise<MemberIdentity[]>;
	reconcileMemberIdentity(
		input: NewMemberIdentity,
	): Promise<MemberIdentityReconciliation>;
	upsertSourceInstallation(
		input: NewSourceInstallation,
	): Promise<SourceInstallation>;
	getSourceInstallation(
		provider: string,
		installationKey: string,
	): Promise<SourceInstallation | null>;
	listSourceInstallations(): Promise<SourceInstallation[]>;
	getEvidenceAccessVersion(): Promise<string>;
	listAffectedContextEntryIdsBySource(
		eventId: string,
		afterEntryId: string | null,
		limit: number,
	): Promise<string[]>;
	updateSourceInstallation(
		id: string,
		update: SourceInstallationUpdate,
	): Promise<SourceInstallation>;
	upsertConnectorSyncState(
		installationId: string,
		resourceKey: string,
		update: ConnectorSyncStateUpdate,
	): Promise<ConnectorSyncState>;
	getConnectorSyncState(
		installationId: string,
		resourceKey: string,
	): Promise<ConnectorSyncState | null>;
	listConnectorSyncStates(
		installationId?: string,
	): Promise<ConnectorSyncState[]>;
	acquireSingletonLease(key: string, owner: string): Promise<boolean>;
	releaseSingletonLease(key: string, owner: string): Promise<void>;
	appendAuditEvent(input: NewAuditEvent): Promise<AuditEvent>;
	listAuditEvents(limit: number): Promise<AuditEvent[]>;
	enqueueOutboxJob(input: NewOutboxJob): Promise<OutboxJob>;
	listOutboxJobs(limit: number): Promise<OutboxJob[]>;
	getLatestTaskSearchCursor(
		taskId: string,
		dispatchEpoch: string,
		identityHash: string,
	): Promise<string | null>;
	claimOutboxJobs(
		workerId: string,
		limit: number,
		leaseSeconds: number,
	): Promise<OutboxJob[]>;
	completeOutboxJob(id: string, workerId: string): Promise<OutboxJob>;
	failOutboxJob(
		id: string,
		workerId: string,
		error: string,
		retryAt: string | null,
	): Promise<OutboxJob>;

	createAgentProfile(input: NewAgentProfile): Promise<AgentProfile>;
	updateAgentDataScope(
		id: string,
		dataScope: AgentDataScope,
	): Promise<AgentProfile>;
	getAgentProfile(id: string): Promise<AgentProfile | null>;
	listAgentProfiles(memberId?: string): Promise<AgentProfile[]>;
	findActiveAgentByTokenHash(tokenHash: string): Promise<AgentProfile | null>;
	rotateAgentToken(
		id: string,
		tokenHash: string,
		tokenHint: string,
	): Promise<AgentProfile>;
	revokeAgentProfile(id: string): Promise<AgentProfile>;
	touchAgentProfile(id: string): Promise<void>;
	getAgentWorkspaceFile(
		memberId: string,
		agentProfileId: string,
		path: string,
		scope?: "agent" | "user",
	): Promise<AgentWorkspaceFile | null>;
	listAgentWorkspaceFiles(
		memberId: string,
		agentProfileId: string,
		prefix: string,
		scope?: "agent" | "user",
	): Promise<AgentWorkspaceFileSummary[]>;
	writeAgentWorkspaceFile(
		input: AgentWorkspaceWrite,
	): Promise<AgentWorkspaceFileSummary>;
	createAgentDevice(input: NewAgentDevice): Promise<AgentDevice>;
	getAgentDevice(id: string): Promise<AgentDevice | null>;
	listAgentDevices(agentProfileId?: string): Promise<AgentDevice[]>;
	revokeAgentDevice(id: string): Promise<AgentDevice>;
	touchAgentDevice(id: string): Promise<void>;
	upsertRepositoryMapping(
		input: NewRepositoryMapping,
	): Promise<RepositoryMapping>;
	listRepositoryMappings(): Promise<RepositoryMapping[]>;

	appendSourceEvent(input: SourceEventInput): Promise<EventAppendResult>;
	listSourceEvents(limit: number): Promise<SourceEvent[]>;
	listSourceContextCandidates(input: {
		provider: string;
		installationKey: string;
		visibility: string;
		cutoff: string;
		limit: number;
	}): Promise<SourceEvent[]>;
	listSourceEventsAfter(
		cursor: { receivedAt: string; id: string } | null,
		limit: number,
	): Promise<SourceEvent[]>;
	listSourceDocuments(limit: number, at?: string): Promise<SourceEvent[]>;
	getLatestSourceEventBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
	): Promise<SourceEvent | null>;
	currentSourceEventIds(
		ids: readonly string[],
		at?: string,
	): Promise<string[]>;
	listActiveSourceRefs(
		provider: string,
		installationKey: string,
		visibility: string,
	): Promise<string[]>;
	upsertContextEntry(entry: NewContextEntry): Promise<ContextEntry>;
	getContextEntry(id: string): Promise<ContextEntry | null>;
	/** Metadata only, for repairing a context entry whose source was withdrawn. */
	getContextEntryRefreshTarget(
		id: string,
	): Promise<Pick<
		ContextEntry,
		"id" | "kind" | "sourceRef" | "path" | "evidenceIds"
	> | null>;
	listContextEntries(): Promise<ContextEntry[]>;
	listContextRevisions(contextEntryId?: string): Promise<ContextRevision[]>;
	getContextRevisionByProposal(
		proposalId: string,
	): Promise<ContextRevision | null>;
	searchContextEntries(query: string, limit: number): Promise<ContextEntry[]>;

	createProposal(input: NewProposal): Promise<Proposal>;
	getProposal(id: string): Promise<Proposal | null>;
	findProposalByClientEvent(
		requestedBy: string,
		clientEventId: string,
	): Promise<Proposal | null>;
	listProposals(state?: ProposalState): Promise<Proposal[]>;
	findOpenProposal(
		taskId: string | null,
		changes: ProposalChanges,
	): Promise<Proposal | null>;
	replaceProposal(input: ReplaceProposalInput): Promise<Proposal>;
	decideProposal(
		id: string,
		decision: DecideProposalInput,
	): Promise<Proposal>;
	approveAndApplyProposal(
		input: ApproveAndApplyProposalInput,
	): Promise<TaskRevision>;
	approveAndApplyContextProposal(
		input: ApproveAndApplyProposalInput,
	): Promise<ContextEntry>;

	listUninterpretedSourceEvents(
		providers: string[],
		limit: number,
		model?: string,
	): Promise<SourceEvent[]>;
	createInterpretationRun(
		input: import("../intelligence/types.js").NewInterpretationRun,
	): Promise<import("../intelligence/types.js").InterpretationRun>;
	completeInterpretationRun(
		id: string,
		output: import("./types.js").JsonValue,
	): Promise<import("../intelligence/types.js").InterpretationRun>;
	failInterpretationRun(
		id: string,
		error: string,
	): Promise<import("../intelligence/types.js").InterpretationRun>;
	getInterpretationRun(
		id: string,
	): Promise<import("../intelligence/types.js").InterpretationRun | null>;
	listInterpretationRuns(
		limit: number,
	): Promise<import("../intelligence/types.js").InterpretationRun[]>;

	getTask(id: string): Promise<Task | null>;
	listProjects(): Promise<Project[]>;
	createProjectProposal(
		input: import("./types.js").NewProjectProposal,
	): Promise<import("./types.js").ProjectProposal>;
	getProjectProposal(
		id: string,
	): Promise<import("./types.js").ProjectProposal | null>;
	listProjectProposals(): Promise<import("./types.js").ProjectProposal[]>;
	decideProjectProposal(
		id: string,
		state: "rejected" | "superseded",
		actor: string,
		note: string | null,
	): Promise<import("./types.js").ProjectProposal>;
	approveProjectProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<import("./types.js").ProjectRevision>;
	listProjectRevisions(
		projectId: string,
	): Promise<import("./types.js").ProjectRevision[]>;
	listWorkstreams(projectId?: string): Promise<Workstream[]>;
	listWorkLinks(taskId?: string): Promise<WorkLink[]>;
	listWorkLinkRevisions(): Promise<WorkLinkRevision[]>;
	upsertWorkLink(input: {
		taskId: string;
		targetTaskId: string | null;
		targetRef: string;
		linkType: WorkLink["linkType"];
		changedBy?: string;
		proposalId?: string | null;
	}): Promise<WorkLink>;
	findTaskByExternalRef(externalRef: string): Promise<Task | null>;
	listTasks(): Promise<Task[]>;
	listTaskRevisions(taskId?: string): Promise<TaskRevision[]>;
	getTaskRevisionByProposal(proposalId: string): Promise<TaskRevision | null>;
	listTaskProposals(taskId: string): Promise<Proposal[]>;
	getSourceEvents(ids: string[]): Promise<SourceEvent[]>;
	/** Scope metadata survives content revocation for safe reconciliation. */
	getSourceEventScope(id: string): Promise<{
		provider: string;
		installationKey: string;
		visibility: string;
		canonicalObjectKey: string;
	} | null>;
	requestNoClaimReopen(input: {
		eventId: string;
		pipelineVersion: string;
		dispatchEpoch: string;
		actor: string;
		reason: string;
	}): Promise<OutboxJob>;
	listRevokedSourceEventIds(
		afterEventId: string | null,
		limit: number,
	): Promise<string[]>;
	listSourceSupersessions(
		afterNewEventId: string | null,
		limit: number,
	): Promise<
		{
			oldEventId: string;
			newEventId: string;
		}[]
	>;
	revokeSourceEvent(id: string): Promise<boolean>;
	revokeSourceEventsBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
		exceptEventId?: string,
	): Promise<string[]>;
	revokeSourceEventsByVisibility(
		provider: string,
		installationKey: string,
		visibility: string,
		exceptEventId?: string,
	): Promise<string[]>;
	rebuildCurrentProjections(
		input: RebuildCurrentProjectionsInput,
	): Promise<void>;
	close(): Promise<void>;
}
