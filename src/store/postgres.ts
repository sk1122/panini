import {
	workStatePolicy,
	workScopeInstructions,
	parseWorkScopeResponse,
	type WorkScopeDefinitionContext,
	workSourceView,
	workTransitionInstructions,
	parseWorkTransitionResponse,
	requireSupportedWorkTransition,
	type WorkScope,
	type WorkScopeCommand,
	type WorkStateReceipt,
} from "../domain/work-state.js";
import {
	prepareWorkEvidence,
	type WorkEvidence,
	type WorkEvidenceWrite,
	type WorkEvidenceRead,
} from "../domain/work-ontology.js";
import type { TaskProposalChanges } from "../domain/types.js";
import { createHash, randomUUID } from "node:crypto";
import pg, { type PoolClient, type QueryResultRow } from "pg";
import { contextEntryFromProposal } from "../domain/context-catalog.js";
import { DomainError } from "../domain/errors.js";
import {
	agentWorkspaceUri,
	normalizeAgentWorkspacePath,
	validateAgentWorkspaceContent,
} from "../domain/agent-workspace.js";
import { acceptedContextReceiptEventKinds } from "../domain/source-event-policy.js";
import { observationIdentity } from "../intelligence/observation-identity.js";
import {
	atPointer,
	validateClaimBody,
} from "../intelligence/claim-validation.js";
import { explicitlyAssertsTaskDone } from "../intelligence/decision-policy.js";
import { authorizedStatusAttestation } from "../intelligence/authority-policy.js";
import { contentHash } from "../domain/content-hash.js";
import type {
	EvidenceAssessment,
	EvidenceClaim,
	ClaimBody,
	DispositionState,
} from "../domain/evidence-types.js";
import {
	emptyEvidenceCoverage,
	type InferenceBudget,
	type ModelCall,
	type ObservationDisposition,
	type ReserveCallInput,
	type SaveExtractionInput,
	type SettleCallInput,
	type V2RunCreate,
} from "../domain/evidence-store.js";
import type {
	ApproveAndApplyProposalInput,
	DecideProposalInput,
	EventAppendResult,
	LedgerStore,
	RebuildCurrentProjectionsInput,
	ReplaceProposalInput,
} from "../domain/store.js";
import {
	isContextProposal,
	isOpenProposalState,
	type AgentCapability,
	type AgentHarness,
	type AgentProfile,
	type AgentWorkspaceFile,
	type AgentWorkspaceFileSummary,
	type AgentWorkspaceWrite,
	type AgentDataScope,
	type AgentDevice,
	type AuditEvent,
	type ContextEntry,
	type ContextRevision,
	type ConnectorSyncState,
	type ConnectorSyncStateUpdate,
	type ContextFactType,
	type ContextFactValue,
	type ContextLifecycleState,
	type ContextLink,
	type JsonValue,
	type Member,
	type MemberIdentity,
	type MemberIdentityReconciliation,
	type NewMember,
	type NewMemberIdentity,
	type NewAuditEvent,
	type NewAgentDevice,
	type NewContextEntry,
	type NewOutboxJob,
	type NewAgentProfile,
	type NewProposal,
	type NewProjectProposal,
	type NewSourceInstallation,
	type NewRepositoryMapping,
	type Organization,
	type OutboxJob,
	type Proposal,
	type ProposalChanges,
	type ProposalState,
	type Project,
	type ProjectProposal,
	type ProjectRevision,
	type SourceEvent,
	type SourceEventInput,
	type SourceInstallation,
	type SourceInstallationUpdate,
	type SourceProvider,
	type RepositoryMapping,
	type Task,
	type TaskRevision,
	type WorkLink,
	type WorkLinkRevision,
	type Workstream,
} from "../domain/types.js";
import type {
	InterpretationRun,
	NewInterpretationRun,
	StoredInterpretationState,
} from "../intelligence/types.js";
import {
	PayloadCipher,
	type EncryptedPayload,
} from "../security/payload-cipher.js";
import {
	acceptedTaskChanges,
	applyTaskChanges,
	compileTaskPatch,
	taskFieldsFromCreate,
} from "./task-changes.js";

const { Pool } = pg;

export const DEFAULT_ORGANIZATION_ID = "00000000-0000-4000-8000-000000000001";

function iso(value: string | Date): string {
	return value instanceof Date
		? value.toISOString()
		: new Date(value).toISOString();
}

function workSlug(value: string): string {
	const base =
		value
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 80) || "project";

	return `${base}-${createHash("sha256").update(value.toLowerCase()).digest("hex").slice(0, 8)}`;
}

function normalizedIdentityName(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLocaleLowerCase("en");
}

function memberIdentitySubject(
	input: Pick<
		NewMemberIdentity,
		"provider" | "installationKey" | "externalId"
	>,
): string {
	return `${input.provider}:${input.installationKey}:${input.externalId}`;
}

interface SourceEventRow extends QueryResultRow {
	id: string;
	provider: string;
	installation_key: string;
	provider_event_id: string;
	event_kind: string;
	occurred_at: Date;
	fetched_at: Date;
	received_at: Date;
	source_ref: string;
	source_url: string | null;
	content_hash: string;
	visibility: string;
	payload_version: string;
	payload: SourceEvent["payload"] | null;
	supersedes_event_id: string | null;
	canonical_object_key?: string | null;
	source_version_key?: string | null;
	semantic_content_hash?: string | null;
	origin_observation_key?: string | null;
	authorization_version?: number;
	ciphertext?: string | null;
	iv?: string | null;
	auth_tag?: string | null;
	key_version?: string | null;
}

function sourceEventFromRow(
	row: SourceEventRow,
	cipher: PayloadCipher,
	allowUnavailable = false,
): SourceEvent {
	let payload: SourceEvent["payload"] | null;

	try {
		payload =
			row.ciphertext && row.iv && row.auth_tag && row.key_version
				? cipher.decrypt({
						ciphertext: row.ciphertext,
						iv: row.iv,
						authTag: row.auth_tag,
						keyVersion: row.key_version,
					})
				: row.payload;
	} catch (error) {
		if (!allowUnavailable) throw error;
		payload = { contentUnavailable: true };
	}
	if (payload === null && !allowUnavailable)
		throw new DomainError(
			`Content for source event ${row.id} is unavailable.`,
			"NOT_FOUND",
		);
	return {
		id: row.id,
		provider: row.provider,
		installationKey: row.installation_key,
		providerEventId: row.provider_event_id,
		eventKind: row.event_kind,
		occurredAt: iso(row.occurred_at),
		fetchedAt: iso(row.fetched_at),
		receivedAt: iso(row.received_at),
		sourceRef: row.source_ref,
		sourceUrl: row.source_url,
		contentHash: row.content_hash,
		visibility: row.visibility,
		payloadVersion: row.payload_version,
		payload,
		supersedesEventId: row.supersedes_event_id,
		observationIdentity:
			row.canonical_object_key &&
			row.source_version_key &&
			row.semantic_content_hash &&
			row.origin_observation_key
				? {
						canonicalObjectKey: row.canonical_object_key,
						sourceVersionKey: row.source_version_key,
						semanticContentHash: row.semantic_content_hash,
						originObservationKey: row.origin_observation_key,
					}
				: null,
		authorizationVersion: row.authorization_version ?? 1,
	};
}

interface TaskRow extends QueryResultRow {
	id: string;
	external_ref: string | null;
	document: Omit<
		Task,
		"id" | "externalRef" | "version" | "createdAt" | "updatedAt"
	>;
	version: number;
	created_at: Date;
	updated_at: Date;
}

function taskFromRow(row: TaskRow): Task {
	return {
		...row.document,
		id: row.id,
		externalRef: row.external_ref,
		version: row.version,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface ProposalRow extends QueryResultRow {
	id: string;
	client_event_id: string | null;
	kind: Proposal["kind"];
	task_id: string | null;
	base_version: number | null;
	state: ProposalState;
	changes: ProposalChanges;
	rationale: string;
	requested_by: string;
	evidence_ids: string[];
	created_at: Date;
	decided_at: Date | null;
	decided_by: string | null;
	decision_note: string | null;
	assessment_id?: string | null;
	application_key?: string | null;
	decision_metadata?:
		import("../domain/evidence-types.js").DecisionMetadata | null;
}

function proposalFromRow(row: ProposalRow): Proposal {
	const common = {
		id: row.id,
		clientEventId: row.client_event_id,
		taskId: row.task_id,
		baseVersion: row.base_version,
		state: row.state,
		rationale: row.rationale,
		requestedBy: row.requested_by,
		evidenceIds: row.evidence_ids,
		createdAt: iso(row.created_at),
		decidedAt: row.decided_at ? iso(row.decided_at) : null,
		decidedBy: row.decided_by,
		decisionNote: row.decision_note,
		assessmentId: row.assessment_id ?? null,
		applicationKey: row.application_key ?? null,
		decisionMetadata: row.decision_metadata ?? null,
	};

	if (row.kind === "context_update") {
		return {
			...common,
			kind: row.kind,
			changes:
				row.changes as import("../domain/types.js").ContextProposalChanges,
		};
	}
	if (row.kind === "context_file_upsert") {
		return {
			...common,
			kind: row.kind,
			changes:
				row.changes as import("../domain/types.js").ContextFileProposalChanges,
		};
	}
	if (row.kind === "context_fact_upsert") {
		return {
			...common,
			kind: row.kind,
			changes:
				row.changes as import("../domain/types.js").ContextFactProposalChanges,
		};
	}
	return {
		...common,
		kind: row.kind,
		changes:
			row.changes as import("../domain/types.js").TaskProposalChanges,
	};
}

interface ContextEntryRow extends QueryResultRow {
	id: string;
	kind: ContextEntry["kind"];
	source_event_id: string;
	source_ref: string;
	path: string;
	title: string;
	body: string | null;
	fact_type: ContextFactType | null;
	fact_value: ContextFactValue | null;
	source_url: string | null;
	content_hash: string;
	evidence_ids: string[];
	lifecycle_state: ContextLifecycleState;
	effective_from: Date;
	effective_to: Date | null;
	links: ContextLink[];
	updated_at: Date;
}

function contextEntryFromRow(row: ContextEntryRow): ContextEntry {
	const common = {
		id: row.id,
		sourceEventId: row.source_event_id,
		sourceRef: row.source_ref,
		path: row.path,
		title: row.title,
		sourceUrl: row.source_url,
		contentHash: row.content_hash,
		evidenceIds: row.evidence_ids,
		lifecycleState: row.lifecycle_state,
		effectiveFrom: iso(row.effective_from),
		effectiveTo: row.effective_to ? iso(row.effective_to) : null,
		links: row.links,
		updatedAt: iso(row.updated_at),
	};

	if (row.kind === "file") {
		return { ...common, kind: "file", body: row.body ?? "" };
	}
	if (!row.fact_type || row.fact_value === null) {
		throw new DomainError(
			`Context fact ${row.id} is malformed.`,
			"INVALID",
		);
	}
	return {
		...common,
		kind: "fact",
		factType: row.fact_type,
		value: row.fact_value,
	};
}

interface ContextRevisionRow extends QueryResultRow {
	id: string;
	context_entry_id: string;
	version: number;
	proposal_id: string;
	previous: ContextEntry | null;
	current: ContextEntry;
	applied_at: Date;
	applied_by: string;
}

function contextRevisionFromRow(row: ContextRevisionRow): ContextRevision {
	return {
		id: row.id,
		contextEntryId: row.context_entry_id,
		version: row.version,
		proposalId: row.proposal_id,
		previous: row.previous,
		current: row.current,
		appliedAt: iso(row.applied_at),
		appliedBy: row.applied_by,
	};
}

interface InterpretationRunRow extends QueryResultRow {
	id: string;
	content_state: "active" | "revoked" | "deleted";
	input_hash: string;
	model: string;
	state: StoredInterpretationState;
	event_ids: string[];
	output: JsonValue | null;
	error: string | null;
	created_at: Date;
	completed_at: Date | null;
}

interface DispositionRow extends QueryResultRow {
	id: string;
	source_event_id: string;
	canonical_event_id: string | null;
	origin_observation_key: string;
	pipeline_version: string;
	attempt: number;
	run_id: string | null;
	state: DispositionState;
	claim_ids: string[];
	reason_code: string | null;
	retryable: boolean;
	next_attempt_at: Date | null;
	lease_owner: string | null;
	lease_until: Date | null;
	created_at: Date;
	finished_at: Date | null;
}

function dispositionFromRow(row: DispositionRow): ObservationDisposition {
	return {
		id: row.id,
		sourceEventId: row.source_event_id,
		canonicalEventId: row.canonical_event_id,
		originObservationKey: row.origin_observation_key,
		pipelineVersion: row.pipeline_version,
		attempt: row.attempt,
		runId: row.run_id,
		state: row.state,
		claimIds: row.claim_ids,
		reasonCode: row.reason_code,
		retryable: row.retryable,
		nextAttemptAt: row.next_attempt_at ? iso(row.next_attempt_at) : null,
		leaseOwner: row.lease_owner,
		leaseUntil: row.lease_until ? iso(row.lease_until) : null,
		createdAt: iso(row.created_at),
		finishedAt: row.finished_at ? iso(row.finished_at) : null,
	};
}

interface EvidenceClaimRow extends QueryResultRow {
	id: string;
	extraction_run_id: string;
	episode_key: string;
	ordinal: number;
	input_hash: string;
	content_hash: string;
	body_envelope: EncryptedPayload | null;
	created_at: Date;
}

function claimFromRow(
	row: EvidenceClaimRow,
	cipher: PayloadCipher,
): EvidenceClaim {
	if (!row.body_envelope)
		throw new DomainError("Claim content is unavailable.", "NOT_FOUND");
	return {
		id: row.id,
		extractionRunId: row.extraction_run_id,
		episodeKey: row.episode_key,
		ordinal: row.ordinal,
		inputHash: row.input_hash,
		contentHash: row.content_hash,
		body: cipher.decrypt(row.body_envelope) as unknown as ClaimBody,
		createdAt: iso(row.created_at),
	};
}

interface EvidenceAssessmentRow extends QueryResultRow {
	id: string;
	run_id: string;
	assessment_key: string;
	target_type: EvidenceAssessment["targetType"];
	target_id: string | null;
	target_version: string | null;
	contract_version: number | null;
	claim_ids: string[];
	evidence_fingerprint: string;
	permission_fingerprint: string;
	policy_version: string;
	model_version: string;
	relationship: EvidenceAssessment["relationship"];
	disposition: EvidenceAssessment["disposition"];
	reason_codes: string[];
	body_envelope: EncryptedPayload | null;
	created_at: Date;
}

function assessmentFromRow(
	row: EvidenceAssessmentRow,
	cipher: PayloadCipher,
): EvidenceAssessment {
	if (!row.body_envelope)
		throw new DomainError(
			"Assessment content is unavailable.",
			"NOT_FOUND",
		);
	return {
		id: row.id,
		runId: row.run_id,
		assessmentKey: row.assessment_key,
		targetType: row.target_type,
		targetId: row.target_id,
		targetVersion: row.target_version,
		contractVersion: row.contract_version,
		claimIds: row.claim_ids,
		evidenceFingerprint: row.evidence_fingerprint,
		permissionFingerprint: row.permission_fingerprint,
		policyVersion: row.policy_version,
		modelVersion: row.model_version,
		relationship: row.relationship,
		disposition: row.disposition,
		reasonCodes: row.reason_codes,
		body: cipher.decrypt(
			row.body_envelope,
		) as unknown as EvidenceAssessment["body"],
		createdAt: iso(row.created_at),
	};
}

interface ModelCallRow extends QueryResultRow {
	id: string;
	budget_id: string;
	run_id: string;
	contextual_source_event_ids: string[];
	purpose: ModelCall["purpose"];
	logical_call_key: string;
	attempt: number;
	provider: string;
	model: string;
	state: ModelCall["state"];
	request_hash: string;
	cache_key: string | null;
	response_envelope: EncryptedPayload | null;
	reserved_input_tokens: string;
	reserved_output_tokens: string;
	input_tokens: string | null;
	cached_input_tokens: string | null;
	output_tokens: string | null;
	embedding_items: number | null;
	cost_usd: string | null;
	cost_basis: ModelCall["costBasis"];
	provider_request_id: string | null;
	error_code: string | null;
	created_at: Date;
	dispatched_at: Date | null;
	finished_at: Date | null;
}

function modelCallFromRow(row: ModelCallRow): ModelCall {
	return {
		id: row.id,
		budgetId: row.budget_id,
		runId: row.run_id,
		purpose: row.purpose,
		logicalCallKey: row.logical_call_key,
		attempt: row.attempt,
		provider: row.provider,
		model: row.model,
		state: row.state,
		requestHash: row.request_hash,
		cacheKey: row.cache_key,
		reservedInputTokens: Number(row.reserved_input_tokens),
		reservedOutputTokens: Number(row.reserved_output_tokens),
		inputTokens:
			row.input_tokens === null ? null : Number(row.input_tokens),
		cachedInputTokens:
			row.cached_input_tokens === null
				? null
				: Number(row.cached_input_tokens),
		outputTokens:
			row.output_tokens === null ? null : Number(row.output_tokens),
		embeddingItems: row.embedding_items,
		costUsd: row.cost_usd,
		costBasis: row.cost_basis,
		providerRequestId: row.provider_request_id,
		errorCode: row.error_code,
		createdAt: iso(row.created_at),
		dispatchedAt: row.dispatched_at ? iso(row.dispatched_at) : null,
		finishedAt: row.finished_at ? iso(row.finished_at) : null,
	};
}

function interpretationRunFromRow(
	row: InterpretationRunRow,
): InterpretationRun {
	return {
		id: row.id,
		inputHash: row.input_hash,
		model: row.model,
		state: row.state,
		eventIds: row.event_ids,
		output: row.output,
		error: row.error,
		createdAt: iso(row.created_at),
		completedAt: row.completed_at ? iso(row.completed_at) : null,
	};
}

interface AgentProfileRow extends QueryResultRow {
	id: string;
	member_id: string | null;
	owner: string;
	name: string;
	harness: AgentHarness;
	description: string;
	capabilities: AgentCapability[];
	data_scope: AgentDataScope;
	status: AgentProfile["status"];
	token_hint: string;
	created_at: Date;
	updated_at: Date;
	last_used_at: Date | null;
}

function agentProfileFromRow(row: AgentProfileRow): AgentProfile {
	return {
		id: row.id,
		memberId: row.member_id,
		owner: row.owner,
		name: row.name,
		harness: row.harness,
		description: row.description,
		capabilities: row.capabilities,
		dataScope: row.data_scope,
		status: row.status,
		tokenHint: row.token_hint,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
		lastUsedAt: row.last_used_at ? iso(row.last_used_at) : null,
	};
}

interface AgentWorkspaceFileRow extends QueryResultRow {
	workspace_scope: "agent" | "user";
	path: string;
	version: number;
	byte_size: number;
	ciphertext: string | null;
	iv: string | null;
	auth_tag: string | null;
	key_version: string | null;
	created_at: Date;
}

function agentWorkspaceFileSummary(
	row: AgentWorkspaceFileRow,
	memberId: string,
	agentProfileId: string,
): AgentWorkspaceFileSummary {
	return {
		uri: agentWorkspaceUri(
			memberId,
			row.workspace_scope === "user" ? "user" : agentProfileId,
			row.path,
		),
		path: row.path,
		version: row.version,
		byteSize: row.byte_size,
		updatedAt: iso(row.created_at),
	};
}

interface AgentDeviceRow extends QueryResultRow {
	id: string;
	organization_id: string;
	agent_profile_id: string;
	name: string;
	public_key: string;
	status: AgentDevice["status"];
	privacy_mode: AgentDevice["privacyMode"];
	last_seen_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

function agentDeviceFromRow(row: AgentDeviceRow): AgentDevice {
	return {
		id: row.id,
		organizationId: row.organization_id,
		agentProfileId: row.agent_profile_id,
		name: row.name,
		publicKey: row.public_key,
		status: row.status,
		privacyMode: row.privacy_mode,
		lastSeenAt: row.last_seen_at ? iso(row.last_seen_at) : null,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface RepositoryMappingRow extends QueryResultRow {
	id: string;
	organization_id: string;
	repository: string;
	project: string;
	context_paths: string[];
	created_at: Date;
	updated_at: Date;
}

function repositoryMappingFromRow(
	row: RepositoryMappingRow,
): RepositoryMapping {
	return {
		id: row.id,
		organizationId: row.organization_id,
		repository: row.repository,
		project: row.project,
		contextPaths: row.context_paths,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface ProjectRow extends QueryResultRow {
	id: string;
	organization_id: string;
	version: number;
	name: string;
	aliases: string[];
	slug: string;
	outcome: string;
	owner: string | null;
	status: Project["status"];
	source_ref: string;
	source_url: string | null;
	created_at: Date;
	updated_at: Date;
}

function projectFromRow(row: ProjectRow): Project {
	return {
		id: row.id,
		organizationId: row.organization_id,
		version: row.version,
		name: row.name,
		aliases: row.aliases,
		slug: row.slug,
		outcome: row.outcome,
		owner: row.owner,
		status: row.status,
		sourceRef: row.source_ref,
		sourceUrl: row.source_url,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface ProjectProposalRow extends QueryResultRow {
	id: string;
	kind: ProjectProposal["kind"];
	project_id: string | null;
	base_version: number | null;
	changes: ProjectProposal["changes"];
	evidence_ids: string[];
	rationale: string;
	requested_by: string;
	state: ProjectProposal["state"];
	created_at: Date;
	decided_at: Date | null;
	decided_by: string | null;
	decision_note: string | null;
}

function projectProposalFromRow(row: ProjectProposalRow): ProjectProposal {
	return {
		id: row.id,
		kind: row.kind,
		projectId: row.project_id,
		baseVersion: row.base_version,
		changes: row.changes,
		evidenceIds: row.evidence_ids,
		rationale: row.rationale,
		requestedBy: row.requested_by,
		state: row.state,
		createdAt: iso(row.created_at),
		decidedAt: row.decided_at ? iso(row.decided_at) : null,
		decidedBy: row.decided_by,
		decisionNote: row.decision_note,
	};
}

interface ProjectRevisionRow extends QueryResultRow {
	id: string;
	project_id: string;
	version: number;
	proposal_id: string;
	previous: Project | null;
	current: Project;
	applied_at: Date;
	applied_by: string;
}

function projectRevisionFromRow(row: ProjectRevisionRow): ProjectRevision {
	return {
		id: row.id,
		projectId: row.project_id,
		version: row.version,
		proposalId: row.proposal_id,
		previous: row.previous,
		current: row.current,
		appliedAt: iso(row.applied_at),
		appliedBy: row.applied_by,
	};
}

interface WorkstreamRow extends QueryResultRow {
	id: string;
	organization_id: string;
	project_id: string;
	name: string;
	outcome: string;
	owner: string | null;
	status: Workstream["status"];
	created_at: Date;
	updated_at: Date;
}

function workstreamFromRow(row: WorkstreamRow): Workstream {
	return {
		id: row.id,
		organizationId: row.organization_id,
		projectId: row.project_id,
		name: row.name,
		outcome: row.outcome,
		owner: row.owner,
		status: row.status,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface WorkLinkRow extends QueryResultRow {
	id: string;
	organization_id: string;
	task_id: string;
	target_task_id: string | null;
	target_ref: string;
	link_type: WorkLink["linkType"];
	created_at: Date;
	updated_at: Date;
}

function workLinkFromRow(row: WorkLinkRow): WorkLink {
	return {
		id: row.id,
		organizationId: row.organization_id,
		taskId: row.task_id,
		targetTaskId: row.target_task_id,
		targetRef: row.target_ref,
		linkType: row.link_type,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface WorkLinkRevisionRow extends QueryResultRow {
	id: string;
	organization_id: string;
	link_id: string;
	version: number;
	previous: WorkLink | null;
	current: WorkLink;
	changed_at: Date;
	changed_by: string;
	proposal_id: string | null;
}

function workLinkRevisionFromRow(row: WorkLinkRevisionRow): WorkLinkRevision {
	return {
		id: row.id,
		organizationId: row.organization_id,
		linkId: row.link_id,
		version: row.version,
		previous: row.previous,
		current: row.current,
		changedAt: iso(row.changed_at),
		changedBy: row.changed_by,
		proposalId: row.proposal_id,
	};
}

interface OrganizationRow extends QueryResultRow {
	id: string;
	slug: string;
	name: string;
	created_at: Date;
	updated_at: Date;
}

function organizationFromRow(row: OrganizationRow): Organization {
	return {
		id: row.id,
		slug: row.slug,
		name: row.name,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface MemberRow extends QueryResultRow {
	id: string;
	organization_id: string;
	subject: string;
	display_name: string;
	email: string | null;
	role: Member["role"];
	status: Member["status"];
	created_at: Date;
	updated_at: Date;
}

function memberFromRow(row: MemberRow): Member {
	return {
		id: row.id,
		organizationId: row.organization_id,
		subject: row.subject,
		displayName: row.display_name,
		email: row.email,
		role: row.role,
		status: row.status,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface MemberIdentityRow extends QueryResultRow {
	id: string;
	organization_id: string;
	member_id: string | null;
	provider: SourceProvider;
	installation_key: string;
	external_id: string;
	display_name: string | null;
	email: string | null;
	status: MemberIdentity["status"];
	created_at: Date;
	updated_at: Date;
}

function memberIdentityFromRow(row: MemberIdentityRow): MemberIdentity {
	return {
		id: row.id,
		organizationId: row.organization_id,
		memberId: row.member_id,
		provider: row.provider,
		installationKey: row.installation_key,
		externalId: row.external_id,
		displayName: row.display_name,
		email: row.email,
		status: row.status,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface SourceInstallationRow extends QueryResultRow {
	id: string;
	organization_id: string;
	provider: SourceProvider;
	installation_key: string;
	display_name: string;
	transport: SourceInstallation["transport"];
	status: SourceInstallation["status"];
	config: SourceInstallation["config"];
	last_sync_at: Date | null;
	last_success_at: Date | null;
	last_event_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
}

function sourceInstallationFromRow(
	row: SourceInstallationRow,
): SourceInstallation {
	return {
		id: row.id,
		organizationId: row.organization_id,
		provider: row.provider,
		installationKey: row.installation_key,
		displayName: row.display_name,
		transport: row.transport,
		status: row.status,
		config: row.config,
		lastSyncAt: row.last_sync_at ? iso(row.last_sync_at) : null,
		lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
		lastEventAt: row.last_event_at ? iso(row.last_event_at) : null,
		lastError: row.last_error,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface ConnectorSyncStateRow extends QueryResultRow {
	id: string;
	organization_id: string;
	installation_id: string;
	resource_key: string;
	status: ConnectorSyncState["status"];
	cursor: ConnectorSyncState["cursor"];
	last_attempt_at: Date | null;
	last_success_at: Date | null;
	last_repair_at: Date | null;
	last_error: string | null;
	observed_count: number;
	revoked_count: number;
	created_at: Date;
	updated_at: Date;
}

function connectorSyncStateFromRow(
	row: ConnectorSyncStateRow,
): ConnectorSyncState {
	return {
		id: row.id,
		organizationId: row.organization_id,
		installationId: row.installation_id,
		resourceKey: row.resource_key,
		status: row.status,
		cursor: row.cursor,
		lastAttemptAt: row.last_attempt_at ? iso(row.last_attempt_at) : null,
		lastSuccessAt: row.last_success_at ? iso(row.last_success_at) : null,
		lastRepairAt: row.last_repair_at ? iso(row.last_repair_at) : null,
		lastError: row.last_error,
		observedCount: row.observed_count,
		revokedCount: row.revoked_count,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

interface AuditEventRow extends QueryResultRow {
	id: string;
	organization_id: string;
	actor: string;
	action: string;
	target_type: string;
	target_id: string | null;
	source_event_id: string | null;
	proposal_id: string | null;
	details: AuditEvent["details"];
	occurred_at: Date;
}

function auditEventFromRow(row: AuditEventRow): AuditEvent {
	return {
		id: row.id,
		organizationId: row.organization_id,
		actor: row.actor,
		action: row.action,
		targetType: row.target_type,
		targetId: row.target_id,
		sourceEventId: row.source_event_id,
		proposalId: row.proposal_id,
		details: row.details,
		occurredAt: iso(row.occurred_at),
	};
}

interface OutboxJobRow extends QueryResultRow {
	id: string;
	organization_id: string;
	topic: string;
	dedupe_key: string;
	payload: JsonValue;
	state: OutboxJob["state"];
	attempts: number;
	available_at: Date;
	locked_at: Date | null;
	locked_by: string | null;
	completed_at: Date | null;
	last_error: string | null;
	created_at: Date;
	updated_at: Date;
}

function outboxJobFromRow(row: OutboxJobRow): OutboxJob {
	return {
		id: row.id,
		organizationId: row.organization_id,
		topic: row.topic,
		dedupeKey: row.dedupe_key,
		payload: row.payload,
		state: row.state,
		attempts: row.attempts,
		availableAt: iso(row.available_at),
		lockedAt: row.locked_at ? iso(row.locked_at) : null,
		lockedBy: row.locked_by,
		completedAt: row.completed_at ? iso(row.completed_at) : null,
		lastError: row.last_error,
		createdAt: iso(row.created_at),
		updatedAt: iso(row.updated_at),
	};
}

export class PostgresLedgerStore implements LedgerStore {
	private readonly pool: pg.Pool;
	private readonly cipher: PayloadCipher;
	private readonly contentReady: Promise<void>;
	private readonly singletonLeases = new Map<
		string,
		{ owner: string; client: PoolClient }
	>();

	constructor(
		databaseUrl: string,
		contentEncryptionKey: string,
		private readonly organizationId = DEFAULT_ORGANIZATION_ID,
		options: { backfillLegacyContent?: boolean } = {},
	) {
		this.pool = new Pool({ connectionString: databaseUrl, max: 10 });
		this.cipher = new PayloadCipher(contentEncryptionKey);
		this.contentReady =
			options.backfillLegacyContent === false
				? Promise.resolve()
				: this.backfillLegacyContent();
	}

	async appendWorkEvidence(input: WorkEvidenceWrite): Promise<WorkEvidence> {
		await this.contentReady;

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const source = (
				await client.query<SourceEventRow>(
					`SELECT se.*,sec.ciphertext,sec.iv,sec.auth_tag,sec.key_version
                FROM source_events se JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
                WHERE se.organization_id=$1 AND se.id=$2 AND se.content_state='active' FOR SHARE OF se`,
					[this.organizationId, input.eventId],
				)
			).rows[0];

			if (
				!source ||
				!input.allowedVisibilities.includes(source.visibility)
			)
				throw new DomainError(
					"Work source is unavailable.",
					"CONFLICT",
				);

			const event = sourceEventFromRow(source, this.cipher);
			const prepared = prepareWorkEvidence(input.evidence, event);
			const run = (
				await client.query<InterpretationRunRow>(
					"SELECT * FROM interpretation_runs WHERE organization_id=$1 AND id=$2 AND content_state='active' AND state='running' FOR UPDATE",
					[this.organizationId, input.runId],
				)
			).rows[0];
			const lease = await client.query(
				"SELECT id FROM observation_dispositions WHERE organization_id=$1 AND source_event_id=$2 AND run_id=$3 AND state='processing' AND lease_owner=$4 AND lease_until>now() FOR UPDATE",
				[
					this.organizationId,
					input.eventId,
					input.runId,
					input.leaseOwner,
				],
			);

			if (
				!run ||
				!run.event_ids.includes(event.id) ||
				lease.rowCount !== 1
			)
				throw new DomainError(
					"Work evidence requires the current observation lease.",
					"CONFLICT",
				);

			const hash = contentHash({
				eventId: input.eventId,
				evidence: prepared.input,
			});
			const prior = (
				await client.query(
					"SELECT * FROM work_assertions WHERE organization_id=$1 AND operation_key=$2",
					[this.organizationId, input.key],
				)
			).rows[0];

			if (prior) {
				if (!prior.body_envelope || prior.input_hash !== hash)
					throw new DomainError(
						"Work receipt was reused with different input.",
						"CONFLICT",
					);

				const body = this.cipher.decrypt(
					prior.body_envelope,
				) as unknown as Omit<WorkEvidence, "claim">;
				const saved = (
					await client.query<EvidenceClaimRow>(
						"SELECT * FROM evidence_claims WHERE organization_id=$1 AND id=$2 AND content_state='active'",
						[this.organizationId, prior.claim_id],
					)
				).rows[0];

				if (!saved)
					throw new DomainError(
						"Work assertion is unavailable.",
						"CONFLICT",
					);
				await client.query("COMMIT");
				return { ...body, claim: claimFromRow(saved, this.cipher) };
			}

			const item = prepared.input;

			if (item.taskId) {
				const row = (
					await client.query<TaskRow>(
						"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2 FOR SHARE",
						[this.organizationId, item.taskId],
					)
				).rows[0];

				if (!row)
					throw new DomainError(
						"Work task was not found.",
						"NOT_FOUND",
					);

				const contract = taskFromRow(row).outcomeContract;

				if (
					item.criterionIds.length > 0 ||
					item.contractVersion !== null
				) {
					if (
						!contract ||
						contract.version !== item.contractVersion ||
						item.criterionIds.some(
							(id) => !contract.criteria.some((c) => c.id === id),
						)
					)
						throw new DomainError(
							"Criterion support requires the current approved contract and known criteria. Without an approved OutcomeContract, use contractVersion null and criterionIds []; inferred WorkScope requirement IDs are not approved criteria.",
							"CONFLICT",
						);
				}
			}
			if (item.relatedEntityId) {
				const related = await client.query(
					`SELECT e.id FROM work_entities e WHERE e.organization_id=$1 AND e.id=$2 AND e.kind='execution'
                    AND EXISTS (SELECT 1 FROM work_assertions a JOIN source_events s ON s.organization_id=a.organization_id AND s.id=a.source_event_id
                    JOIN evidence_claims c ON c.organization_id=a.organization_id AND c.id=a.claim_id
                    WHERE a.organization_id=e.organization_id AND a.entity_id=e.id AND s.content_state='active' AND c.content_state='active' AND s.visibility=ANY($3::text[])) FOR SHARE OF e`,
					[
						this.organizationId,
						item.relatedEntityId,
						input.allowedVisibilities,
					],
				);

				if (!related.rowCount)
					throw new DomainError(
						"Producing execution is unavailable.",
						"CONFLICT",
					);
			}

			const correctionIds = [...new Set(item.claimedCorrectionIds ?? [])];

			if (
				correctionIds.length !==
				(item.claimedCorrectionIds?.length ?? 0)
			)
				throw new DomainError(
					"Correction targets must be unique.",
					"INVALID",
				);
			if (correctionIds.length) {
				const targets = await client.query(
					`SELECT w.id FROM work_assertions w JOIN evidence_claims c ON c.organization_id=w.organization_id AND c.id=w.claim_id AND c.content_state='active'
                     JOIN source_events s ON s.organization_id=w.organization_id AND s.id=w.source_event_id AND s.content_state='active'
                     JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
                     WHERE w.organization_id=$1 AND w.id=ANY($2::uuid[]) AND w.task_id IS NOT DISTINCT FROM $3::uuid
                     AND w.body_envelope IS NOT NULL AND s.visibility=ANY($4::text[]) FOR SHARE OF w,c,s,sc`,
					[
						this.organizationId,
						correctionIds,
						item.taskId,
						input.allowedVisibilities,
					],
				);

				if (targets.rowCount !== correctionIds.length)
					throw new DomainError(
						"Correction target is unavailable or belongs to different work.",
						"CONFLICT",
					);
			}

			const entityId = (
				await client.query(
					`INSERT INTO work_entities(id,organization_id,kind,identity_hash) VALUES($1,$2,$3,$4)
                ON CONFLICT(organization_id,identity_hash) DO UPDATE SET identity_hash=EXCLUDED.identity_hash RETURNING id`,
					[
						randomUUID(),
						this.organizationId,
						item.kind,
						prepared.identityHash,
					],
				)
			).rows[0].id as string;
			const ordinal = Number(
				(
					await client.query(
						"SELECT COALESCE(max(ordinal),-1)+1 AS ordinal FROM evidence_claims WHERE organization_id=$1 AND extraction_run_id=$2",
						[this.organizationId, input.runId],
					)
				).rows[0].ordinal,
			);

			if (prepared.reporterExternalId) {
				const reporter = (
					await client.query<{ member_id: string }>(
						`SELECT mi.member_id FROM member_identities mi
                    JOIN members m ON m.organization_id=mi.organization_id AND m.id=mi.member_id AND m.status='active'
                    WHERE mi.organization_id=$1 AND mi.provider=$2 AND mi.installation_key=$3
                    AND mi.external_id=$4 AND mi.status='active' FOR SHARE OF mi,m`,
						[
							this.organizationId,
							event.provider,
							event.installationKey,
							prepared.reporterExternalId,
						],
					)
				).rows;

				if (reporter.length === 1)
					prepared.claim.speakerMemberId = reporter[0]!.member_id;
			}

			const claimRow = (
				await client.query<EvidenceClaimRow>(
					`INSERT INTO evidence_claims(id,organization_id,extraction_run_id,episode_key,ordinal,kind,input_hash,content_hash,body_envelope)
                VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
					[
						randomUUID(),
						this.organizationId,
						input.runId,
						event.observationIdentity!.originObservationKey,
						ordinal,
						prepared.claim.kind,
						run.input_hash,
						contentHash(prepared.claim),
						JSON.stringify(
							this.cipher.encrypt(
								prepared.claim as unknown as JsonValue,
							),
						),
					],
				)
			).rows[0]!;
			const span = prepared.claim.spans[0]!;

			await client.query(
				`INSERT INTO evidence_dependencies(organization_id,dependent_type,dependent_id,field_key,source_event_id,origin_observation_key,source_version_key,source_authorization_version,relationship)
                VALUES($1,'claim',$2,'$',$3,$4,$5,$6,'supports') ON CONFLICT DO NOTHING`,
				[
					this.organizationId,
					claimRow.id,
					event.id,
					span.originObservationKey,
					span.sourceVersionKey,
					event.authorizationVersion,
				],
			);

			const body: Omit<WorkEvidence, "claim"> = {
				id: randomUUID(),
				entity: {
					id: entityId,
					identityBasis: "source_local",
					kind: item.kind,
					name: item.name,
					externalRef: item.externalRef,
					revision: item.revision,
					environment: item.environment,
				},
				taskId: item.taskId,
				contractVersion: item.contractVersion,
				criterionIds: item.criterionIds,
				relationship: item.relationship,
				relatedEntityId: item.relatedEntityId,
				claimedCorrectionIds: correctionIds,
				correctionStatus: correctionIds.length
					? "claimed_unresolved"
					: "none",
				basis: "source_reported",
				linkBasis: "model_inferred",
				authorityBasis: prepared.claim.speakerMemberId
					? "identity_only"
					: "unknown",
			};

			await client.query(
				`INSERT INTO work_assertions(id,organization_id,entity_id,task_id,claim_id,source_event_id,operation_key,input_hash,body_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
				[
					body.id,
					this.organizationId,
					entityId,
					item.taskId,
					claimRow.id,
					event.id,
					input.key,
					hash,
					JSON.stringify(
						this.cipher.encrypt(body as unknown as JsonValue),
					),
				],
			);
			await client.query("COMMIT");
			return { ...body, claim: claimFromRow(claimRow, this.cipher) };
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async governedWorkObservation(
		client: PoolClient,
		eventId: string,
	): Promise<boolean> {
		const found = await client.query(
			`SELECT r.id FROM observation_dispositions d JOIN interpretation_runs r ON r.organization_id=d.organization_id AND r.id=d.run_id
             WHERE d.organization_id=$1 AND d.source_event_id=$2 AND r.prompt_version='observation-agent-ontology-v2' LIMIT 1`,
			[this.organizationId, eventId],
		);

		return found.rowCount === 1;
	}

	private async requireWorkLease(
		client: PoolClient,
		runId: string,
		eventId: string,
		owner: string,
	): Promise<void> {
		const lease = await client.query(
			`SELECT d.id FROM observation_dispositions d JOIN interpretation_runs r ON r.organization_id=d.organization_id AND r.id=d.run_id
             WHERE d.organization_id=$1 AND d.source_event_id=$2 AND d.run_id=$3 AND d.state='processing'
             AND d.lease_owner=$4 AND d.lease_until>now() AND r.state='running' AND r.content_state='active'
             AND $2::uuid=ANY(r.event_ids) FOR SHARE OF r FOR UPDATE OF d`,
			[this.organizationId, eventId, runId, owner],
		);

		if (lease.rowCount !== 1)
			throw new DomainError(
				"Work state requires the live observation lease.",
				"CONFLICT",
			);
	}

	async ensureWorkScope(input: WorkScopeCommand): Promise<WorkScope> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");
			await this.requireWorkLease(
				client,
				input.runId,
				input.eventId,
				input.leaseOwner,
			);

			const row = (
				await client.query<TaskRow>(
					"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2 FOR UPDATE",
					[this.organizationId, input.taskId],
				)
			).rows[0];

			if (!row || row.version !== input.expectedTaskVersion)
				throw new DomainError(
					"Task changed before scope definition.",
					"CONFLICT",
				);

			const existing = (
				await client.query<{ body_envelope: EncryptedPayload | null }>(
					"SELECT body_envelope FROM work_scopes WHERE organization_id=$1 AND task_id=$2",
					[this.organizationId, input.taskId],
				)
			).rows[0];

			if (existing) {
				if (!existing.body_envelope)
					throw new DomainError(
						"Work scope was revoked; use reviewed scope replacement.",
						"CONFLICT",
					);

				const scope = this.cipher.decrypt(
					existing.body_envelope,
				) as unknown as WorkScope;

				await this.requireWorkSources(
					client,
					scope.sourceEventIds,
					input.allowedVisibilities,
				);
				await client.query("COMMIT");
				return scope;
			}

			const first = (
				await client.query<{
					previous: Task | null;
					current: Task;
					evidence_ids: string[];
				}>(
					`SELECT r.previous,r.current,p.evidence_ids FROM task_revisions r
                 JOIN proposals p ON p.organization_id=r.organization_id AND p.id=r.proposal_id
                 WHERE r.organization_id=$1 AND r.task_id=$2 ORDER BY r.version LIMIT 1`,
					[this.organizationId, input.taskId],
				)
			).rows[0];
			const original =
				first?.previous ?? first?.current ?? taskFromRow(row);
			// A later progress proposal is not the original request's provenance.
			const sourceEventIds =
				first && !first.previous
					? [...new Set(first.evidence_ids)].sort()
					: [];

			await this.requireWorkSources(
				client,
				[...new Set([...sourceEventIds, input.eventId])],
				input.allowedVisibilities,
			);

			const scope: WorkScope = {
				id: randomUUID(),
				taskId: input.taskId,
				version: 1,
				amendmentOfScopeId: null,
				authorityBasis: "inferred_request",
				requiredSteps: [],
				boundaryClear: false,
				definitionModelCallId: null,
				basis: "accepted_interpretation",
				boundary: {
					title: original.title,
					description: original.description,
				},
				originalTaskVersion: original.version,
				requestSourceAvailable: sourceEventIds.length > 0,
				sourceEventIds,
				createdAt: new Date().toISOString(),
			};

			await client.query(
				"INSERT INTO work_scopes(id,organization_id,task_id,source_event_ids,body_envelope) VALUES($1,$2,$3,$4,$5::jsonb)",
				[
					scope.id,
					this.organizationId,
					input.taskId,
					sourceEventIds,
					JSON.stringify(
						this.cipher.encrypt(scope as unknown as JsonValue),
					),
				],
			);
			await client.query("COMMIT");
			return scope;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async finalizeWorkScope(
		input: WorkScopeCommand & {
			modelCallId: string;
			context: WorkScopeDefinitionContext;
		},
	): Promise<WorkScope> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");
			await this.requireWorkLease(
				client,
				input.runId,
				input.eventId,
				input.leaseOwner,
			);

			const row = (
				await client.query<{ body_envelope: EncryptedPayload | null }>(
					"SELECT body_envelope FROM work_scopes WHERE organization_id=$1 AND id=$2 AND task_id=$3 FOR UPDATE",
					[this.organizationId, input.context.scopeId, input.taskId],
				)
			).rows[0];

			if (!row?.body_envelope)
				throw new DomainError("Scope is unavailable.", "CONFLICT");

			const scope = this.cipher.decrypt(
				row.body_envelope,
			) as unknown as WorkScope;

			if (scope.definitionModelCallId) {
				await client.query("COMMIT");
				return scope;
			}

			const task = (
				await client.query<TaskRow>(
					"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2 FOR SHARE",
					[this.organizationId, input.taskId],
				)
			).rows[0];
			const call = (
				await client.query<
					ModelCallRow & { request_envelope: EncryptedPayload | null }
				>(
					"SELECT * FROM model_calls WHERE organization_id=$1 AND id=$2 AND state='succeeded' AND purpose='verify' AND run_id=$3 FOR SHARE",
					[this.organizationId, input.modelCallId, input.runId],
				)
			).rows[0];

			if (
				!task ||
				task.version !== input.expectedTaskVersion ||
				input.context.taskId !== input.taskId ||
				input.context.taskVersion !== task.version ||
				input.context.policyVersion !== workStatePolicy ||
				contentHash(input.context.boundary) !==
					contentHash(scope.boundary) ||
				!call?.request_envelope ||
				!call.response_envelope
			)
				throw new DomainError(
					"Scope definition lacks a current task and settled provider receipt.",
					"CONFLICT",
				);

			const request = this.cipher.decrypt(
				call.request_envelope,
			) as unknown as {
				instructions: string;
				input: { content: string }[];
			};

			if (
				request.instructions !== workScopeInstructions ||
				contentHash(request) !== call.request_hash ||
				contentHash(JSON.parse(request.input[0]?.content ?? "null")) !==
					contentHash(input.context)
			)
				throw new DomainError(
					"Scope definition differs from its saved provider request.",
					"CONFLICT",
				);

			const sources = await this.requireWorkSources(
				client,
				input.context.sources.map((source) => source.id),
				input.allowedVisibilities,
			);

			if (
				[input.eventId, ...scope.sourceEventIds].some(
					(id) => !sources.some((source) => source.id === id),
				) ||
				contentHash([...call.contextual_source_event_ids].sort()) !==
					contentHash(sources.map((source) => source.id).sort()) ||
				sources.some(
					(source) =>
						contentHash(workSourceView(source)) !==
						contentHash(
							input.context.sources.find(
								(item) => item.id === source.id,
							),
						),
				)
			)
				throw new DomainError(
					"Scope definition context is missing, changed or restricted.",
					"CONFLICT",
				);

			const definition = parseWorkScopeResponse(
				this.cipher.decrypt(call.response_envelope),
			);
			const requiredSteps = definition.requirements.map((step) => {
				const source = sources.find(
					(event) => event.id === step.requestSourceEventId,
				);
				const text =
					step.requestSourceEventId &&
					step.sourcePointer !== null &&
					source
						? atPointer(source.payload, step.sourcePointer)
						: `${scope.boundary.title}\n${scope.boundary.description}`;

				if (
					(step.requestSourceEventId !== null && !source) ||
					(step.requestSourceEventId === null) !==
						(step.sourcePointer === null) ||
					typeof text !== "string" ||
					!text.includes(step.quote)
				)
					throw new DomainError(
						"Required work needs an exact request or boundary quote.",
						"CONFLICT",
					);
				return {
					id: `req:${contentHash({ scopeId: scope.id, ...step }).slice(0, 20)}`,
					description: step.description,
					quote: step.quote,
					sourceEventId: step.requestSourceEventId,
					sourcePointer: step.sourcePointer,
				};
			});

			if (
				new Set(requiredSteps.map((step) => step.id)).size !==
				requiredSteps.length
			)
				throw new DomainError(
					"Scope definition repeats a requirement.",
					"CONFLICT",
				);

			const finalized: WorkScope = {
				...scope,
				requiredSteps,
				boundaryClear:
					definition.boundaryClear && !definition.amendmentClaimed,
				definitionModelCallId: call.id,
				sourceEventIds: sources.map((source) => source.id).sort(),
			};

			await client.query(
				"UPDATE work_scopes SET source_event_ids=$3,body_envelope=$4::jsonb WHERE organization_id=$1 AND id=$2",
				[
					this.organizationId,
					scope.id,
					finalized.sourceEventIds,
					JSON.stringify(
						this.cipher.encrypt(finalized as unknown as JsonValue),
					),
				],
			);
			await client.query("COMMIT");
			return finalized;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async requireWorkSources(
		client: PoolClient,
		ids: string[],
		allowedVisibilities: string[],
	): Promise<SourceEvent[]> {
		const unique = [...new Set(ids)].sort();
		const sources = (
			await client.query<SourceEventRow>(
				`SELECT se.*,sec.ciphertext,sec.iv,sec.auth_tag,sec.key_version FROM source_events se
             JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
             WHERE se.organization_id=$1 AND se.id=ANY($2::uuid[]) AND se.content_state='active'
             AND se.visibility=ANY($3::text[]) ORDER BY se.id FOR SHARE OF se,sec`,
				[this.organizationId, unique, allowedVisibilities],
			)
		).rows;

		if (sources.length !== unique.length)
			throw new DomainError(
				"Work scope or assessment source is unavailable or restricted.",
				"CONFLICT",
			);
		return sources.map((source) => sourceEventFromRow(source, this.cipher));
	}

	async readWorkScope(
		taskId: string,
		allowedVisibilities: string[] | null,
	): Promise<WorkScope | null> {
		const row = (
			await this.pool.query<{ body_envelope: EncryptedPayload }>(
				`SELECT w.body_envelope FROM work_scopes w WHERE w.organization_id=$1 AND w.task_id=$2 AND w.body_envelope IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM unnest(w.source_event_ids) sid WHERE NOT EXISTS (
                SELECT 1 FROM source_events s JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
                WHERE s.organization_id=w.organization_id AND s.id=sid AND s.content_state='active'
                AND ($3::text[] IS NULL OR s.visibility=ANY($3))))`,
				[this.organizationId, taskId, allowedVisibilities],
			)
		).rows[0];

		return row
			? (this.cipher.decrypt(row.body_envelope) as unknown as WorkScope)
			: null;
	}

	async readWorkStateAssessments(
		taskId: string,
		allowedVisibilities: string[] | null,
	): Promise<WorkStateReceipt[]> {
		const rows = (
			await this.pool.query<{ body_envelope: EncryptedPayload }>(
				`SELECT w.body_envelope FROM work_state_assessments w JOIN model_calls mc ON mc.organization_id=w.organization_id AND mc.id=w.model_call_id WHERE w.organization_id=$1 AND w.task_id=$2 AND w.body_envelope IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM unnest(w.source_event_ids) sid WHERE NOT EXISTS (
                SELECT 1 FROM source_events s JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
                WHERE s.organization_id=w.organization_id AND s.id=sid AND s.content_state='active'
                AND ($3::text[] IS NULL OR s.visibility=ANY($3)))) ORDER BY mc.created_at DESC,w.id LIMIT 100`,
				[this.organizationId, taskId, allowedVisibilities],
			)
		).rows;

		return rows.map(
			(row) =>
				this.cipher.decrypt(
					row.body_envelope,
				) as unknown as WorkStateReceipt,
		);
	}

	private async validateWorkStateReceipt(
		client: PoolClient,
		receipt: WorkStateReceipt,
		task: Task,
		changes: TaskProposalChanges,
		eventId: string,
		requireLease = true,
	): Promise<void> {
		const { context } = receipt;

		if (
			context.policyVersion !== workStatePolicy ||
			context.task.id !== task.id ||
			context.task.version !== task.version ||
			contentHash(context.task) !== contentHash(task) ||
			context.activeEventId !== eventId ||
			contentHash(context.changes) !== contentHash(changes)
		)
			throw new DomainError(
				"Work assessment no longer matches the task or exact changes.",
				"CONFLICT",
			);
		if (requireLease)
			await this.requireWorkLease(
				client,
				receipt.runId,
				eventId,
				receipt.leaseOwner,
			);

		const scopeRow = (
			await client.query<{ body_envelope: EncryptedPayload | null }>(
				"SELECT body_envelope FROM work_scopes WHERE organization_id=$1 AND id=$2 AND task_id=$3 FOR SHARE",
				[this.organizationId, context.scope.id, task.id],
			)
		).rows[0];

		if (
			!scopeRow?.body_envelope ||
			contentHash(this.cipher.decrypt(scopeRow.body_envelope)) !==
				contentHash(context.scope)
		)
			throw new DomainError(
				"Work assessment scope is unavailable or changed.",
				"CONFLICT",
			);

		const effectiveRequirements = task.outcomeContract
			? task.outcomeContract.criteria
					.filter((criterion) => criterion.required)
					.map((criterion) => ({
						id: `approved:${criterion.id}`,
						description: criterion.description,
					}))
			: context.scope.requiredSteps.map((step) => ({
					id: step.id,
					description: step.description,
				}));

		if (
			contentHash(context.requirements) !==
			contentHash(effectiveRequirements)
		)
			throw new DomainError(
				"Assessment requirements differ from the stored scope or approved contract.",
				"CONFLICT",
			);

		const call = (
			await client.query<
				ModelCallRow & { request_envelope: EncryptedPayload | null }
			>(
				"SELECT * FROM model_calls WHERE organization_id=$1 AND id=$2 AND state='succeeded' AND purpose='verify' AND run_id=$3 FOR SHARE",
				[this.organizationId, receipt.modelCallId, receipt.runId],
			)
		).rows[0];

		if (!call?.request_envelope || !call.response_envelope)
			throw new DomainError(
				"Work assessment has no settled provider receipt.",
				"CONFLICT",
			);

		const request = this.cipher.decrypt(
			call.request_envelope,
		) as unknown as { instructions: string; input: { content: string }[] };
		const response = this.cipher.decrypt(call.response_envelope);

		if (
			contentHash(request) !== call.request_hash ||
			request.instructions !== workTransitionInstructions ||
			contentHash(JSON.parse(request.input[0]?.content ?? "null")) !==
				contentHash(context) ||
			contentHash(parseWorkTransitionResponse(response)) !==
				contentHash(receipt.assessment)
		)
			throw new DomainError(
				"Work assessment differs from its saved model request or response.",
				"CONFLICT",
			);

		const ids = context.sources.map((source) => source.id);
		const required = [
			...new Set([
				eventId,
				...context.scope.sourceEventIds,
				...context.assertions.flatMap((item) =>
					item.claim.body.spans.map((span) => span.eventId),
				),
			]),
		];

		if (
			new Set(ids).size !== ids.length ||
			required.some((id) => !ids.includes(id)) ||
			contentHash([...call.contextual_source_event_ids].sort()) !==
				contentHash([...ids].sort())
		)
			throw new DomainError(
				"Work assessment omitted required source context.",
				"CONFLICT",
			);

		const sources = await this.requireWorkSources(
			client,
			ids,
			receipt.allowedVisibilities,
		);

		for (const source of sources)
			if (
				contentHash(workSourceView(source)) !==
				contentHash(
					context.sources.find((item) => item.id === source.id),
				)
			)
				throw new DomainError(
					"Work assessment source content or authorization changed.",
					"CONFLICT",
				);

		const known = (
			await client.query<{ id: string }>(
				`SELECT a.id FROM work_assertions a JOIN evidence_claims c ON c.organization_id=a.organization_id AND c.id=a.claim_id AND c.content_state='active'
             JOIN source_events s ON s.organization_id=a.organization_id AND s.id=a.source_event_id AND s.content_state='active'
             JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
             WHERE a.organization_id=$1 AND a.task_id=$2 AND a.body_envelope IS NOT NULL AND s.visibility=ANY($3::text[])
             ORDER BY a.id FOR SHARE OF a,c,s,sc`,
				[this.organizationId, task.id, receipt.allowedVisibilities],
			)
		).rows.map((row) => row.id);

		if (
			contentHash(known) !==
			contentHash(context.assertions.map((item) => item.id).sort())
		)
			throw new DomainError(
				"Known work evidence changed or was omitted; reassess the current record.",
				"CONFLICT",
			);
		for (const assertion of context.assertions) {
			const stored = (
				await client.query<
					EvidenceClaimRow & { work_body: EncryptedPayload | null }
				>(
					`SELECT c.*,w.body_envelope AS work_body FROM work_assertions w JOIN evidence_claims c ON c.organization_id=w.organization_id AND c.id=w.claim_id
                 WHERE w.organization_id=$1 AND w.id=$2 AND w.task_id=$3 AND c.content_state='active' FOR SHARE OF w,c`,
					[this.organizationId, assertion.id, task.id],
				)
			).rows[0];
			const { contractCurrent: _current, ...selected } = assertion;

			if (
				!stored?.work_body ||
				contentHash({
					...(this.cipher.decrypt(stored.work_body) as object),
					claim: claimFromRow(stored, this.cipher),
				}) !== contentHash(selected)
			)
				throw new DomainError(
					"Work assessment assertion is unavailable or changed.",
					"CONFLICT",
				);
		}
		requireSupportedWorkTransition(context, receipt.assessment);
	}

	async saveWorkStateAssessment(
		input: Omit<WorkStateReceipt, "id">,
	): Promise<WorkStateReceipt> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const prior = (
				await client.query<{ body_envelope: EncryptedPayload | null }>(
					"SELECT body_envelope FROM work_state_assessments WHERE organization_id=$1 AND operation_key=$2",
					[this.organizationId, input.key],
				)
			).rows[0];

			if (prior?.body_envelope) {
				const receipt = this.cipher.decrypt(
					prior.body_envelope,
				) as unknown as WorkStateReceipt;

				if (
					contentHash({ ...receipt, id: null }) !==
					contentHash({ ...input, id: null })
				)
					throw new DomainError(
						"Work state receipt was reused with different input.",
						"CONFLICT",
					);
				await client.query("COMMIT");
				return receipt;
			}

			const taskRow = (
				await client.query<TaskRow>(
					"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2 FOR UPDATE",
					[this.organizationId, input.context.task.id],
				)
			).rows[0];

			if (!taskRow)
				throw new DomainError("Work task was not found.", "NOT_FOUND");

			const receipt = { ...input, id: randomUUID() };

			await this.validateWorkStateReceipt(
				client,
				receipt,
				taskFromRow(taskRow),
				input.context.changes,
				input.context.activeEventId,
			);
			await client.query(
				"INSERT INTO work_state_assessments(id,organization_id,task_id,scope_id,run_id,model_call_id,operation_key,source_event_ids,body_envelope) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
				[
					receipt.id,
					this.organizationId,
					input.context.task.id,
					input.context.scope.id,
					input.runId,
					input.modelCallId,
					input.key,
					input.context.sources.map((source) => source.id),
					JSON.stringify(
						this.cipher.encrypt(receipt as unknown as JsonValue),
					),
				],
			);
			await client.query("COMMIT");
			return receipt;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async readWorkEvidence(input: WorkEvidenceRead): Promise<WorkEvidence[]> {
		if (input.limit === null && !input.taskId)
			throw new DomainError(
				"A complete evidence read requires one task.",
				"INVALID",
			);

		const limit =
			input.limit === null
				? null
				: Math.max(1, Math.min(100, input.limit));
		const result = await this.pool.query<
			EvidenceClaimRow & {
				work_body: EncryptedPayload;
				current_contract_version: number | null;
			}
		>(
			`SELECT c.*,a.body_envelope AS work_body,(t.document->'outcomeContract'->>'version')::int AS current_contract_version
            FROM work_assertions a JOIN evidence_claims c ON c.organization_id=a.organization_id AND c.id=a.claim_id AND c.content_state='active'
            JOIN source_events s ON s.organization_id=a.organization_id AND s.id=a.source_event_id AND s.content_state='active'
            JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
            LEFT JOIN tasks t ON t.organization_id=a.organization_id AND t.id=a.task_id
            WHERE a.organization_id=$1 AND a.body_envelope IS NOT NULL AND ($2::text[] IS NULL OR s.visibility=ANY($2))
            AND ($3::uuid IS NULL OR a.task_id=$3) AND ($4::uuid IS NULL OR a.entity_id=$4)
            AND ($5::uuid[] IS NULL OR a.task_id IS NULL OR a.task_id=ANY($5))
            ORDER BY s.occurred_at DESC,c.created_at DESC,a.id LIMIT $6`,
			[
				this.organizationId,
				input.allowedVisibilities,
				input.taskId ?? null,
				input.entityId ?? null,
				input.allowedTaskIds ?? null,
				limit,
			],
		);

		const readableExecutions = new Set(
			(
				await this.pool.query<{ entity_id: string }>(
					`SELECT DISTINCT a.entity_id FROM work_assertions a
            JOIN work_entities e ON e.organization_id=a.organization_id AND e.id=a.entity_id AND e.kind='execution'
            JOIN evidence_claims c ON c.organization_id=a.organization_id AND c.id=a.claim_id AND c.content_state='active'
            JOIN source_events s ON s.organization_id=a.organization_id AND s.id=a.source_event_id AND s.content_state='active'
            JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
            WHERE a.organization_id=$1 AND a.body_envelope IS NOT NULL AND ($2::text[] IS NULL OR s.visibility=ANY($2))
            AND ($3::uuid[] IS NULL OR a.task_id IS NULL OR a.task_id=ANY($3))`,
					[
						this.organizationId,
						input.allowedVisibilities,
						input.allowedTaskIds ?? null,
					],
				)
			).rows.map((row) => row.entity_id),
		);

		const readableAssertions = new Set(
			(
				await this.pool.query<{ id: string }>(
					`SELECT a.id FROM work_assertions a JOIN evidence_claims c ON c.organization_id=a.organization_id AND c.id=a.claim_id AND c.content_state='active'
             JOIN source_events s ON s.organization_id=a.organization_id AND s.id=a.source_event_id AND s.content_state='active'
             JOIN source_event_contents sc ON sc.source_event_id=s.id AND sc.revoked_at IS NULL
             WHERE a.organization_id=$1 AND a.body_envelope IS NOT NULL AND ($2::text[] IS NULL OR s.visibility=ANY($2))
             AND ($3::uuid[] IS NULL OR a.task_id IS NULL OR a.task_id=ANY($3))`,
					[
						this.organizationId,
						input.allowedVisibilities,
						input.allowedTaskIds ?? null,
					],
				)
			).rows.map((row) => row.id),
		);

		return result.rows.map((row) => {
			const body = this.cipher.decrypt(row.work_body) as unknown as Omit<
				WorkEvidence,
				"claim"
			>;

			// A production edge is visible only while its execution has readable evidence.
			return {
				...body,
				claimedCorrectionIds: (body.claimedCorrectionIds ?? []).filter(
					(id) => readableAssertions.has(id),
				),
				relatedEntityId:
					body.relatedEntityId &&
					readableExecutions.has(body.relatedEntityId)
						? body.relatedEntityId
						: null,
				claim: claimFromRow(row, this.cipher),
				contractCurrent:
					body.contractVersion === null
						? null
						: body.contractVersion === row.current_contract_version,
			};
		});
	}

	async getOrganization(): Promise<Organization> {
		const result = await this.pool.query<OrganizationRow>(
			"SELECT * FROM organizations WHERE id=$1",
			[this.organizationId],
		);

		if (!result.rows[0])
			throw new DomainError(
				"The default organization has not been initialized.",
				"NOT_FOUND",
			);
		return organizationFromRow(result.rows[0]);
	}

	async setOrganizationName(name: string): Promise<Organization> {
		const result = await this.pool.query<OrganizationRow>(
			"UPDATE organizations SET name=$2, updated_at=now() WHERE id=$1 RETURNING *",
			[this.organizationId, name],
		);

		if (!result.rows[0])
			throw new DomainError(
				"The default organization has not been initialized.",
				"NOT_FOUND",
			);
		return organizationFromRow(result.rows[0]);
	}

	async listMembers(): Promise<Member[]> {
		const result = await this.pool.query<MemberRow>(
			"SELECT * FROM members WHERE organization_id=$1 ORDER BY created_at",
			[this.organizationId],
		);

		return result.rows.map(memberFromRow);
	}

	async getMember(id: string): Promise<Member | null> {
		const result = await this.pool.query<MemberRow>(
			"SELECT * FROM members WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? memberFromRow(result.rows[0]) : null;
	}

	async upsertMember(input: NewMember): Promise<Member> {
		const subject = input.subject.trim();
		const displayName = input.displayName.trim();

		if (!subject || !displayName)
			throw new DomainError(
				"A member requires a subject and display name.",
				"INVALID",
			);

		const result = await this.pool.query<MemberRow>(
			`INSERT INTO members
        (id, organization_id, subject, display_name, email, role, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (organization_id, subject) DO UPDATE SET
        display_name=excluded.display_name,
        email=COALESCE(excluded.email, members.email),
        role=CASE WHEN members.role IN ('owner','admin','reviewer') THEN members.role ELSE excluded.role END,
        status=excluded.status,
        updated_at=now()
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				subject,
				displayName,
				input.email ?? null,
				input.role ?? "member",
				input.status ?? "active",
			],
		);

		return memberFromRow(result.rows[0]!);
	}

	async listMemberIdentities(): Promise<MemberIdentity[]> {
		const result = await this.pool.query<MemberIdentityRow>(
			"SELECT * FROM member_identities WHERE organization_id=$1 ORDER BY created_at, id",
			[this.organizationId],
		);

		return result.rows.map(memberIdentityFromRow);
	}

	async reconcileMemberIdentity(
		input: NewMemberIdentity,
	): Promise<MemberIdentityReconciliation> {
		const installationKey = input.installationKey.trim();
		const externalId = input.externalId.trim();
		const requestedDisplayName = input.displayName?.trim() || null;
		const requestedEmail =
			input.email?.trim().toLocaleLowerCase("en") || null;
		const status = input.status ?? "active";

		if (!installationKey || !externalId) {
			throw new DomainError(
				"A member identity requires an installation key and external ID.",
				"INVALID",
			);
		}

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");
			await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
				`member-reconcile:${this.organizationId}`,
			]);

			const existingResult = await client.query<MemberIdentityRow>(
				`SELECT * FROM member_identities
         WHERE organization_id=$1 AND provider=$2 AND installation_key=$3 AND external_id=$4
         FOR UPDATE`,
				[
					this.organizationId,
					input.provider,
					installationKey,
					externalId,
				],
			);
			const existingIdentity = existingResult.rows[0] ?? null;
			const displayName =
				requestedDisplayName ?? existingIdentity?.display_name ?? null;
			const email = requestedEmail ?? existingIdentity?.email ?? null;
			const subject = memberIdentitySubject({
				provider: input.provider,
				installationKey,
				externalId,
			});

			const persistIdentity = async (
				memberId: string | null,
			): Promise<MemberIdentityRow> => {
				if (existingIdentity) {
					const updated = await client.query<MemberIdentityRow>(
						`UPDATE member_identities SET member_id=$2, display_name=$3, email=$4, status=$5, updated_at=now()
             WHERE id=$1 RETURNING *`,
						[
							existingIdentity.id,
							memberId,
							displayName,
							email,
							status,
						],
					);

					return updated.rows[0]!;
				}

				const inserted = await client.query<MemberIdentityRow>(
					`INSERT INTO member_identities
            (id, organization_id, member_id, provider, installation_key, external_id, display_name, email, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
					[
						randomUUID(),
						this.organizationId,
						memberId,
						input.provider,
						installationKey,
						externalId,
						displayName,
						email,
						status,
					],
				);

				return inserted.rows[0]!;
			};

			const refreshMember = async (
				member: MemberRow,
			): Promise<MemberRow> => {
				// Source identity sync cannot reactivate or edit a personal login account.
				if (member.subject.startsWith("local:")) return member;

				const identityRows = await client.query<MemberIdentityRow>(
					"SELECT * FROM member_identities WHERE organization_id=$1 AND member_id=$2",
					[this.organizationId, member.id],
				);
				const identityManaged = identityRows.rows.some(
					(identity) =>
						member.subject ===
						memberIdentitySubject({
							provider: identity.provider,
							installationKey: identity.installation_key,
							externalId: identity.external_id,
						}),
				);
				const hasActiveIdentity = identityRows.rows.some(
					(identity) => identity.status === "active",
				);
				const nextStatus = hasActiveIdentity
					? "active"
					: identityManaged
						? "disabled"
						: member.status;
				const nextDisplayName =
					member.subject === subject && displayName
						? displayName
						: member.display_name;
				const nextEmail =
					email && (!member.email || member.subject === subject)
						? email
						: member.email;
				const updated = await client.query<MemberRow>(
					`UPDATE members SET display_name=$2, email=$3, status=$4, updated_at=now()
           WHERE id=$1 RETURNING *`,
					[member.id, nextDisplayName, nextEmail, nextStatus],
				);

				return updated.rows[0]!;
			};

			if (existingIdentity?.member_id) {
				const memberResult = await client.query<MemberRow>(
					"SELECT * FROM members WHERE organization_id=$1 AND id=$2 FOR UPDATE",
					[this.organizationId, existingIdentity.member_id],
				);

				if (!memberResult.rows[0])
					throw new DomainError(
						"The member identity references a missing member.",
						"NOT_FOUND",
					);

				const identity = await persistIdentity(
					existingIdentity.member_id,
				);
				const member = await refreshMember(memberResult.rows[0]);

				await client.query("COMMIT");
				return {
					member: memberFromRow(member),
					identity: memberIdentityFromRow(identity),
					matchedBy: "identity",
				};
			}

			const membersResult = await client.query<MemberRow>(
				"SELECT * FROM members WHERE organization_id=$1 ORDER BY created_at, id FOR UPDATE",
				[this.organizationId],
			);
			let candidates = membersResult.rows.filter(
				(member) => member.subject === subject,
			);
			let matchedBy: MemberIdentityReconciliation["matchedBy"] =
				candidates.length === 1 ? "identity" : "created";

			if (candidates.length !== 1 && email) {
				candidates = membersResult.rows.filter(
					(member) =>
						member.email?.trim().toLocaleLowerCase("en") === email,
				);
				if (candidates.length === 1) matchedBy = "email";
			}
			if (candidates.length !== 1 && displayName) {
				const normalizedName = normalizedIdentityName(displayName);

				candidates = membersResult.rows.filter(
					(member) =>
						member.subject !== "bootstrap:local-admin" &&
						normalizedIdentityName(member.display_name) ===
							normalizedName,
				);
				if (candidates.length === 1) matchedBy = "display_name";
			}

			let memberRow = candidates.length === 1 ? candidates[0]! : null;

			if (!memberRow && !displayName) {
				const identity = await persistIdentity(null);

				await client.query("COMMIT");
				return {
					member: null,
					identity: memberIdentityFromRow(identity),
					matchedBy: "unresolved",
				};
			}
			if (!memberRow) {
				const inserted = await client.query<MemberRow>(
					`INSERT INTO members (id, organization_id, subject, display_name, email, role, status)
           VALUES ($1,$2,$3,$4,$5,'member',$6) RETURNING *`,
					[
						randomUUID(),
						this.organizationId,
						subject,
						displayName,
						email,
						status,
					],
				);

				memberRow = inserted.rows[0]!;
				matchedBy = "created";
			}

			const identity = await persistIdentity(memberRow.id);

			memberRow = await refreshMember(memberRow);
			await client.query("COMMIT");
			return {
				member: memberFromRow(memberRow),
				identity: memberIdentityFromRow(identity),
				matchedBy,
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async upsertSourceInstallation(
		input: NewSourceInstallation,
	): Promise<SourceInstallation> {
		const result = await this.pool.query<SourceInstallationRow>(
			`INSERT INTO source_installations
        (id, organization_id, provider, installation_key, display_name, transport, status, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb)
       ON CONFLICT (organization_id, provider, installation_key) DO UPDATE SET
        display_name=excluded.display_name, transport=excluded.transport,
        status=COALESCE($9::text, source_installations.status),
        config=excluded.config, updated_at=now()
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.provider,
				input.installationKey,
				input.displayName,
				input.transport,
				input.status ?? "configured",
				JSON.stringify(input.config ?? {}),
				input.status ?? null,
			],
		);

		return sourceInstallationFromRow(result.rows[0]!);
	}

	async getSourceInstallation(
		provider: string,
		installationKey: string,
	): Promise<SourceInstallation | null> {
		const result = await this.pool.query<SourceInstallationRow>(
			"SELECT * FROM source_installations WHERE organization_id=$1 AND provider=$2 AND installation_key=$3",
			[this.organizationId, provider, installationKey],
		);

		return result.rows[0]
			? sourceInstallationFromRow(result.rows[0])
			: null;
	}

	async listSourceInstallations(): Promise<SourceInstallation[]> {
		const result = await this.pool.query<SourceInstallationRow>(
			"SELECT * FROM source_installations WHERE organization_id=$1 ORDER BY display_name",
			[this.organizationId],
		);

		return result.rows.map(sourceInstallationFromRow);
	}

	async updateSourceInstallation(
		id: string,
		update: SourceInstallationUpdate,
	): Promise<SourceInstallation> {
		const current = await this.pool.query<SourceInstallationRow>(
			"SELECT * FROM source_installations WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		if (!current.rows[0])
			throw new DomainError(
				`Source installation ${id} does not exist.`,
				"NOT_FOUND",
			);

		const value = sourceInstallationFromRow(current.rows[0]);
		const result = await this.pool.query<SourceInstallationRow>(
			`UPDATE source_installations SET
        status=$3, config=$4::jsonb, last_sync_at=$5, last_success_at=$6,
        last_event_at=$7, last_error=$8, updated_at=now()
       WHERE organization_id=$1 AND id=$2 RETURNING *`,
			[
				this.organizationId,
				id,
				update.status ?? value.status,
				JSON.stringify(update.config ?? value.config),
				update.lastSyncAt === undefined
					? value.lastSyncAt
					: update.lastSyncAt,
				update.lastSuccessAt === undefined
					? value.lastSuccessAt
					: update.lastSuccessAt,
				update.lastEventAt === undefined
					? value.lastEventAt
					: update.lastEventAt,
				update.lastError === undefined
					? value.lastError
					: update.lastError,
			],
		);

		return sourceInstallationFromRow(result.rows[0]!);
	}

	async upsertConnectorSyncState(
		installationId: string,
		resourceKey: string,
		update: ConnectorSyncStateUpdate,
	): Promise<ConnectorSyncState> {
		const current = await this.getConnectorSyncState(
			installationId,
			resourceKey,
		);
		const result = await this.pool.query<ConnectorSyncStateRow>(
			`INSERT INTO connector_sync_states (
         id, organization_id, installation_id, resource_key, status, cursor,
         last_attempt_at, last_success_at, last_repair_at, last_error, observed_count, revoked_count
       )
       SELECT $1,$2,si.id,$4,$5,$6::jsonb,$7,$8,$9,$10,$11,$12
         FROM source_installations si
        WHERE si.organization_id=$2 AND si.id=$3
       ON CONFLICT (installation_id, resource_key) DO UPDATE SET
         status=excluded.status,
         cursor=excluded.cursor,
         last_attempt_at=excluded.last_attempt_at,
         last_success_at=excluded.last_success_at,
         last_repair_at=excluded.last_repair_at,
         last_error=excluded.last_error,
         observed_count=excluded.observed_count,
         revoked_count=excluded.revoked_count,
         updated_at=now()
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				installationId,
				resourceKey,
				update.status ?? current?.status ?? "idle",
				JSON.stringify(update.cursor ?? current?.cursor ?? {}),
				update.lastAttemptAt === undefined
					? (current?.lastAttemptAt ?? null)
					: update.lastAttemptAt,
				update.lastSuccessAt === undefined
					? (current?.lastSuccessAt ?? null)
					: update.lastSuccessAt,
				update.lastRepairAt === undefined
					? (current?.lastRepairAt ?? null)
					: update.lastRepairAt,
				update.lastError === undefined
					? (current?.lastError ?? null)
					: update.lastError,
				update.observedCount ?? current?.observedCount ?? 0,
				update.revokedCount ?? current?.revokedCount ?? 0,
			],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Source installation ${installationId} does not exist.`,
				"NOT_FOUND",
			);
		return connectorSyncStateFromRow(result.rows[0]);
	}

	async getConnectorSyncState(
		installationId: string,
		resourceKey: string,
	): Promise<ConnectorSyncState | null> {
		const result = await this.pool.query<ConnectorSyncStateRow>(
			`SELECT * FROM connector_sync_states
        WHERE organization_id=$1 AND installation_id=$2 AND resource_key=$3`,
			[this.organizationId, installationId, resourceKey],
		);

		return result.rows[0]
			? connectorSyncStateFromRow(result.rows[0])
			: null;
	}

	async listConnectorSyncStates(
		installationId?: string,
	): Promise<ConnectorSyncState[]> {
		const result = installationId
			? await this.pool.query<ConnectorSyncStateRow>(
					`SELECT * FROM connector_sync_states
            WHERE organization_id=$1 AND installation_id=$2 ORDER BY resource_key`,
					[this.organizationId, installationId],
				)
			: await this.pool.query<ConnectorSyncStateRow>(
					"SELECT * FROM connector_sync_states WHERE organization_id=$1 ORDER BY installation_id, resource_key",
					[this.organizationId],
				);

		return result.rows.map(connectorSyncStateFromRow);
	}

	async acquireSingletonLease(key: string, owner: string): Promise<boolean> {
		const scopedKey = `${this.organizationId}:${key}`;
		const current = this.singletonLeases.get(scopedKey);

		if (current) return current.owner === owner;

		const client = await this.pool.connect();

		try {
			const result = await client.query<{ acquired: boolean }>(
				"SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired",
				[scopedKey],
			);

			if (!result.rows[0]?.acquired) {
				client.release();
				return false;
			}
			this.singletonLeases.set(scopedKey, { owner, client });
			return true;
		} catch (error) {
			client.release();
			throw error;
		}
	}

	async releaseSingletonLease(key: string, owner: string): Promise<void> {
		const scopedKey = `${this.organizationId}:${key}`;
		const lease = this.singletonLeases.get(scopedKey);

		if (!lease || lease.owner !== owner) return;
		this.singletonLeases.delete(scopedKey);
		try {
			await lease.client.query(
				"SELECT pg_advisory_unlock(hashtextextended($1, 0))",
				[scopedKey],
			);
		} finally {
			lease.client.release();
		}
	}

	async appendAuditEvent(input: NewAuditEvent): Promise<AuditEvent> {
		const result = await this.pool.query<AuditEventRow>(
			`INSERT INTO audit_events
        (id, organization_id, actor, action, target_type, target_id, source_event_id, proposal_id, details, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10) RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.actor,
				input.action,
				input.targetType,
				input.targetId,
				input.sourceEventId,
				input.proposalId,
				JSON.stringify(input.details),
				input.occurredAt ?? new Date().toISOString(),
			],
		);

		return auditEventFromRow(result.rows[0]!);
	}

	async listAuditEvents(limit: number): Promise<AuditEvent[]> {
		const result = await this.pool.query<AuditEventRow>(
			"SELECT * FROM audit_events WHERE organization_id=$1 ORDER BY occurred_at DESC LIMIT $2",
			[this.organizationId, limit],
		);

		return result.rows.map(auditEventFromRow);
	}

	async enqueueOutboxJob(input: NewOutboxJob): Promise<OutboxJob> {
		const result = await this.pool.query<OutboxJobRow>(
			`INSERT INTO outbox_jobs
        (id, organization_id, topic, dedupe_key, payload, state, attempts, available_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,$6)
       ON CONFLICT (organization_id, dedupe_key) DO UPDATE SET dedupe_key=outbox_jobs.dedupe_key
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.topic,
				input.dedupeKey,
				JSON.stringify(input.payload),
				input.availableAt ?? new Date().toISOString(),
			],
		);

		return outboxJobFromRow(result.rows[0]!);
	}

	async listOutboxJobs(limit: number): Promise<OutboxJob[]> {
		const result = await this.pool.query<OutboxJobRow>(
			"SELECT * FROM outbox_jobs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2",
			[this.organizationId, limit],
		);

		return result.rows.map(outboxJobFromRow);
	}

	async getLatestTaskSearchCursor(
		taskId: string,
		dispatchEpoch: string,
		identityHash: string,
	): Promise<string | null> {
		const result = await this.pool.query<{ payload: JsonValue }>(
			`SELECT payload FROM outbox_jobs WHERE organization_id=$1
         AND topic='evidence.task.search_manifest' AND state='completed'
         AND payload->>'taskId'=$2 AND payload->>'dispatchEpoch'=$3
         ORDER BY completed_at DESC,id DESC LIMIT 1`,
			[this.organizationId, taskId, dispatchEpoch],
		);
		const payload = result.rows[0]?.payload;

		if (
			!payload ||
			typeof payload !== "object" ||
			Array.isArray(payload) ||
			payload.reason !== "completed" ||
			payload.taskIdentityHash !== identityHash ||
			typeof payload.discoveryThrough !== "string" ||
			!Number.isFinite(Date.parse(payload.discoveryThrough))
		)
			return null;
		return payload.discoveryThrough;
	}

	async claimOutboxJobs(
		workerId: string,
		limit: number,
		leaseSeconds: number,
	): Promise<OutboxJob[]> {
		const result = await this.pool.query<OutboxJobRow>(
			`WITH candidates AS (
         SELECT id
           FROM outbox_jobs
          WHERE organization_id=$1
            AND (
              (state='pending' AND available_at <= now())
              OR (state='running' AND locked_at <= now() - make_interval(secs => $3::integer))
            )
          ORDER BY available_at, created_at
          FOR UPDATE SKIP LOCKED
          LIMIT $4
       )
       UPDATE outbox_jobs AS jobs
          SET state='running', attempts=jobs.attempts + 1, locked_at=now(), locked_by=$2, updated_at=now()
         FROM candidates
        WHERE jobs.id=candidates.id
       RETURNING jobs.*`,
			[this.organizationId, workerId, leaseSeconds, limit],
		);

		return result.rows.map(outboxJobFromRow);
	}

	async completeOutboxJob(id: string, workerId: string): Promise<OutboxJob> {
		const result = await this.pool.query<OutboxJobRow>(
			`UPDATE outbox_jobs
          SET state='completed', completed_at=now(), locked_at=NULL, locked_by=NULL,
              last_error=NULL, updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND state='running' AND locked_by=$3
       RETURNING *`,
			[this.organizationId, id, workerId],
		);

		if (result.rows[0]) return outboxJobFromRow(result.rows[0]);
		return this.throwOutboxFailure(id, workerId);
	}

	async failOutboxJob(
		id: string,
		workerId: string,
		error: string,
		retryAt: string | null,
	): Promise<OutboxJob> {
		const result = await this.pool.query<OutboxJobRow>(
			`UPDATE outbox_jobs
          SET state=CASE WHEN $4::timestamptz IS NULL THEN 'failed' ELSE 'pending' END,
              available_at=COALESCE($4::timestamptz, available_at), completed_at=NULL,
              locked_at=NULL, locked_by=NULL, last_error=$5, updated_at=now()
        WHERE organization_id=$1 AND id=$2 AND state='running' AND locked_by=$3
       RETURNING *`,
			[this.organizationId, id, workerId, retryAt, error.slice(0, 4_000)],
		);

		if (result.rows[0]) return outboxJobFromRow(result.rows[0]);
		return this.throwOutboxFailure(id, workerId);
	}

	async createAgentProfile(input: NewAgentProfile): Promise<AgentProfile> {
		try {
			const result = await this.pool.query<AgentProfileRow>(
				`INSERT INTO agent_profiles
          (id, organization_id, member_id, owner, name, harness, description, capabilities, data_scope, status, token_hash, token_hint,
           created_at, updated_at, last_used_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::jsonb,'active',$10,$11,now(),now(),NULL)
         RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.memberId,
					input.owner,
					input.name,
					input.harness,
					input.description,
					input.capabilities,
					JSON.stringify(input.dataScope),
					input.tokenHash,
					input.tokenHint,
				],
			);

			return agentProfileFromRow(result.rows[0]!);
		} catch (error) {
			if ((error as { code?: string }).code === "23505") {
				throw new DomainError(
					`Agent ${input.name} already exists for ${input.owner}.`,
					"CONFLICT",
				);
			}
			throw error;
		}
	}

	async updateAgentDataScope(
		id: string,
		dataScope: AgentDataScope,
	): Promise<AgentProfile> {
		const result = await this.pool.query<AgentProfileRow>(
			`UPDATE agent_profiles SET data_scope=$3::jsonb, updated_at=now()
       WHERE organization_id=$1 AND id=$2 AND status='active' RETURNING *`,
			[this.organizationId, id, JSON.stringify(dataScope)],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Active agent profile ${id} does not exist.`,
				"NOT_FOUND",
			);
		return agentProfileFromRow(result.rows[0]);
	}

	async getAgentProfile(id: string): Promise<AgentProfile | null> {
		const result = await this.pool.query<AgentProfileRow>(
			"SELECT * FROM agent_profiles WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? agentProfileFromRow(result.rows[0]) : null;
	}

	async listAgentProfiles(memberId?: string): Promise<AgentProfile[]> {
		const result = memberId
			? await this.pool.query<AgentProfileRow>(
					"SELECT * FROM agent_profiles WHERE organization_id=$1 AND member_id=$2 ORDER BY updated_at DESC",
					[this.organizationId, memberId],
				)
			: await this.pool.query<AgentProfileRow>(
					"SELECT * FROM agent_profiles WHERE organization_id=$1 ORDER BY updated_at DESC",
					[this.organizationId],
				);

		return result.rows.map(agentProfileFromRow);
	}

	async findActiveAgentByTokenHash(
		tokenHash: string,
	): Promise<AgentProfile | null> {
		const result = await this.pool.query<AgentProfileRow>(
			"SELECT * FROM agent_profiles WHERE organization_id=$1 AND token_hash=$2 AND status='active'",
			[this.organizationId, tokenHash],
		);

		return result.rows[0] ? agentProfileFromRow(result.rows[0]) : null;
	}

	async rotateAgentToken(
		id: string,
		tokenHash: string,
		tokenHint: string,
	): Promise<AgentProfile> {
		const result = await this.pool.query<AgentProfileRow>(
			`UPDATE agent_profiles
          SET token_hash=$3, token_hint=$4, status='active', updated_at=now()
        WHERE organization_id=$1 AND id=$2 RETURNING *`,
			[this.organizationId, id, tokenHash, tokenHint],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Agent profile ${id} does not exist.`,
				"NOT_FOUND",
			);
		return agentProfileFromRow(result.rows[0]);
	}

	async revokeAgentProfile(id: string): Promise<AgentProfile> {
		const result = await this.pool.query<AgentProfileRow>(
			"UPDATE agent_profiles SET status='revoked', updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",
			[this.organizationId, id],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Agent profile ${id} does not exist.`,
				"NOT_FOUND",
			);
		return agentProfileFromRow(result.rows[0]);
	}

	async touchAgentProfile(id: string): Promise<void> {
		await this.pool.query(
			"UPDATE agent_profiles SET last_used_at=now() WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);
	}

	async getAgentWorkspaceFile(
		memberId: string,
		agentProfileId: string,
		path: string,
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFile | null> {
		const normalizedPath = normalizeAgentWorkspacePath(path);
		const result = await this.pool.query<AgentWorkspaceFileRow>(
			`SELECT file.* FROM agent_workspace_file_revisions file
         JOIN agent_profiles profile ON profile.id=$3
        WHERE file.organization_id=$1 AND file.member_id=$2 AND file.workspace_scope=$5
          AND ($5='user' OR file.agent_profile_id=$3) AND file.path=$4
          AND profile.organization_id=$1 AND profile.member_id=$2 AND profile.status='active'
        ORDER BY file.version DESC LIMIT 1`,
			[
				this.organizationId,
				memberId,
				agentProfileId,
				normalizedPath,
				scope,
			],
		);
		const row = result.rows[0];

		if (!row?.ciphertext || !row.iv || !row.auth_tag || !row.key_version)
			return null;

		const content = this.cipher.decrypt({
			ciphertext: row.ciphertext,
			iv: row.iv,
			authTag: row.auth_tag,
			keyVersion: row.key_version,
		});

		if (typeof content !== "string")
			throw new DomainError(
				"Agent workspace content is invalid.",
				"INVALID",
			);
		return {
			...agentWorkspaceFileSummary(row, memberId, agentProfileId),
			content,
		};
	}

	async listAgentWorkspaceFiles(
		memberId: string,
		agentProfileId: string,
		prefix: string,
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFileSummary[]> {
		const normalizedPrefix = prefix
			? normalizeAgentWorkspacePath(prefix)
			: "";
		const result = await this.pool.query<AgentWorkspaceFileRow>(
			`SELECT latest.* FROM (
         SELECT DISTINCT ON (file.path) file.* FROM agent_workspace_file_revisions file
           JOIN agent_profiles profile ON profile.id=$3
          WHERE file.organization_id=$1 AND file.member_id=$2 AND file.workspace_scope=$6
            AND ($6='user' OR file.agent_profile_id=$3)
            AND profile.organization_id=$1 AND profile.member_id=$2 AND profile.status='active'
          ORDER BY file.path, file.version DESC
       ) latest
       WHERE latest.ciphertext IS NOT NULL
         AND ($4='' OR latest.path=$4 OR latest.path LIKE $5 ESCAPE '\\')
       ORDER BY latest.path LIMIT 1000`,
			[
				this.organizationId,
				memberId,
				agentProfileId,
				normalizedPrefix,
				`${normalizedPrefix.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}/%`,
				scope,
			],
		);

		return result.rows.map((row) =>
			agentWorkspaceFileSummary(row, memberId, agentProfileId),
		);
	}

	async writeAgentWorkspaceFile(
		input: AgentWorkspaceWrite,
	): Promise<AgentWorkspaceFileSummary> {
		const scope = input.scope ?? "agent";
		const path = normalizeAgentWorkspacePath(input.path);

		if (
			!Number.isInteger(input.expectedVersion) ||
			input.expectedVersion < 0
		) {
			throw new DomainError(
				"Expected file version is invalid.",
				"INVALID",
			);
		}
		if (input.content !== null)
			validateAgentWorkspaceContent(input.content);

		const encrypted =
			input.content === null ? null : this.cipher.encrypt(input.content);
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const profile = await client.query(
				"SELECT id FROM agent_profiles WHERE organization_id=$1 AND member_id=$2 AND id=$3 AND status='active' FOR SHARE",
				[this.organizationId, input.memberId, input.agentProfileId],
			);

			if (!profile.rows[0])
				throw new DomainError(
					"Agent workspace is unavailable.",
					"FORBIDDEN",
				);

			const latest = await client.query<
				{ version: number } & QueryResultRow
			>(
				`SELECT version FROM agent_workspace_file_revisions
          WHERE organization_id=$1 AND member_id=$2 AND workspace_scope=$5
            AND ($5='user' OR agent_profile_id=$3) AND path=$4
          ORDER BY version DESC LIMIT 1`,
				[
					this.organizationId,
					input.memberId,
					input.agentProfileId,
					path,
					scope,
				],
			);
			const currentVersion = latest.rows[0]?.version ?? 0;

			if (currentVersion !== input.expectedVersion)
				throw new DomainError(
					"Agent file revision conflict.",
					"CONFLICT",
				);
			if (input.content === null && currentVersion === 0)
				throw new DomainError(
					"Agent file does not exist.",
					"NOT_FOUND",
				);

			const result = await client.query<AgentWorkspaceFileRow>(
				`INSERT INTO agent_workspace_file_revisions
          (id, organization_id, member_id, agent_profile_id, path, version, byte_size, ciphertext, iv, auth_tag, key_version, workspace_scope)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.memberId,
					input.agentProfileId,
					path,
					currentVersion + 1,
					input.content === null
						? 0
						: Buffer.byteLength(input.content, "utf8"),
					encrypted?.ciphertext ?? null,
					encrypted?.iv ?? null,
					encrypted?.authTag ?? null,
					encrypted?.keyVersion ?? null,
					scope,
				],
			);
			const summary = agentWorkspaceFileSummary(
				result.rows[0]!,
				input.memberId,
				input.agentProfileId,
			);

			await client.query(
				`INSERT INTO audit_events
          (id, organization_id, actor, action, target_type, target_id, source_event_id, proposal_id, details, occurred_at)
         VALUES ($1,$2,$3,$4,$7,$5,NULL,NULL,$6::jsonb,now())`,
				[
					randomUUID(),
					this.organizationId,
					`agent:${input.agentProfileId}`,
					`${scope}_workspace.${input.content === null ? "deleted" : "written"}`,
					summary.uri,
					JSON.stringify({
						version: summary.version,
						byteSize: summary.byteSize,
					}),
					`${scope}_workspace_file`,
				],
			);
			await client.query("COMMIT");
			return summary;
		} catch (error) {
			await client.query("ROLLBACK");
			if ((error as { code?: string }).code === "23505")
				throw new DomainError(
					"Agent file revision conflict.",
					"CONFLICT",
				);
			throw error;
		} finally {
			client.release();
		}
	}

	async createAgentDevice(input: NewAgentDevice): Promise<AgentDevice> {
		try {
			const result = await this.pool.query<AgentDeviceRow>(
				`INSERT INTO agent_devices
          (id, organization_id, agent_profile_id, name, public_key, status, privacy_mode)
         SELECT $1,$2,ap.id,$4,$5,'active',$6
           FROM agent_profiles ap
          WHERE ap.organization_id=$2 AND ap.id=$3
         RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.agentProfileId,
					input.name,
					input.publicKey,
					input.privacyMode,
				],
			);

			if (!result.rows[0])
				throw new DomainError(
					`Agent profile ${input.agentProfileId} does not exist.`,
					"NOT_FOUND",
				);
			return agentDeviceFromRow(result.rows[0]);
		} catch (error) {
			if ((error as { code?: string }).code === "23505")
				throw new DomainError(
					`Device ${input.name} already exists for this agent.`,
					"CONFLICT",
				);
			throw error;
		}
	}

	async listAgentDevices(agentProfileId?: string): Promise<AgentDevice[]> {
		const result = agentProfileId
			? await this.pool.query<AgentDeviceRow>(
					"SELECT * FROM agent_devices WHERE organization_id=$1 AND agent_profile_id=$2 ORDER BY updated_at DESC",
					[this.organizationId, agentProfileId],
				)
			: await this.pool.query<AgentDeviceRow>(
					"SELECT * FROM agent_devices WHERE organization_id=$1 ORDER BY updated_at DESC",
					[this.organizationId],
				);

		return result.rows.map(agentDeviceFromRow);
	}

	async getAgentDevice(id: string): Promise<AgentDevice | null> {
		const result = await this.pool.query<AgentDeviceRow>(
			"SELECT * FROM agent_devices WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? agentDeviceFromRow(result.rows[0]) : null;
	}

	async revokeAgentDevice(id: string): Promise<AgentDevice> {
		const result = await this.pool.query<AgentDeviceRow>(
			"UPDATE agent_devices SET status='revoked', updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *",
			[this.organizationId, id],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Agent device ${id} does not exist.`,
				"NOT_FOUND",
			);
		return agentDeviceFromRow(result.rows[0]);
	}

	async touchAgentDevice(id: string): Promise<void> {
		await this.pool.query(
			"UPDATE agent_devices SET last_seen_at=now(), updated_at=now() WHERE organization_id=$1 AND id=$2 AND status='active'",
			[this.organizationId, id],
		);
	}

	async upsertRepositoryMapping(
		input: NewRepositoryMapping,
	): Promise<RepositoryMapping> {
		const result = await this.pool.query<RepositoryMappingRow>(
			`INSERT INTO repository_mappings (id, organization_id, repository, project, context_paths)
       VALUES ($1,$2,$3,$4,$5::text[])
       ON CONFLICT (organization_id, (lower(repository))) DO UPDATE SET
        project=excluded.project, context_paths=excluded.context_paths, updated_at=now()
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.repository,
				input.project,
				input.contextPaths,
			],
		);

		return repositoryMappingFromRow(result.rows[0]!);
	}

	async listRepositoryMappings(): Promise<RepositoryMapping[]> {
		const result = await this.pool.query<RepositoryMappingRow>(
			"SELECT * FROM repository_mappings WHERE organization_id=$1 ORDER BY repository",
			[this.organizationId],
		);

		return result.rows.map(repositoryMappingFromRow);
	}

	async appendSourceEvent(
		input: SourceEventInput,
	): Promise<EventAppendResult> {
		await this.contentReady;

		const identity = observationIdentity(input);
		const id = randomUUID();
		const receivedAt = new Date().toISOString();
		const encrypted = this.cipher.encrypt(input.payload);
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");
			if (identity?.canonicalObjectKey) {
				await client.query(
					"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
					[
						`${this.organizationId}:source:${identity.canonicalObjectKey}`,
					],
				);
			}

			const result = await client.query<SourceEventRow>(
				`INSERT INTO source_events (
          id, organization_id, provider, installation_key, provider_event_id, event_kind, occurred_at, fetched_at,
          received_at, source_ref, source_url, content_hash, visibility, payload_version, payload, supersedes_event_id,
          canonical_object_key, source_version_key, semantic_content_hash, origin_observation_key
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NULL,$15,$16,$17,$18,$19)
        ON CONFLICT (organization_id, provider, installation_key, provider_event_id) DO NOTHING
        RETURNING *`,
				[
					id,
					this.organizationId,
					input.provider,
					input.installationKey,
					input.providerEventId,
					input.eventKind,
					input.occurredAt,
					input.fetchedAt,
					receivedAt,
					input.sourceRef,
					input.sourceUrl,
					input.contentHash,
					input.visibility,
					input.payloadVersion,
					input.supersedesEventId ?? null,
					identity?.canonicalObjectKey ?? null,
					identity?.sourceVersionKey ?? null,
					identity?.semanticContentHash ?? null,
					identity?.originObservationKey ?? null,
				],
			);
			const inserted = result.rows[0];

			if (inserted) {
				if (input.supersedesEventId) {
					const previous = (
						await client.query<SourceEventRow>(
							`SELECT * FROM source_events WHERE organization_id=$1 AND id=$2 FOR SHARE`,
							[this.organizationId, input.supersedesEventId],
						)
					).rows[0];

					if (
						!previous ||
						previous.provider !== input.provider ||
						previous.installation_key !== input.installationKey ||
						previous.source_ref !== input.sourceRef ||
						(!/delet/i.test(input.eventKind) &&
							Date.parse(input.occurredAt) <=
								previous.occurred_at.getTime())
					) {
						throw new DomainError(
							"Source supersession order or object is invalid.",
							"INVALID",
						);
					}
				}
				await client.query(
					`INSERT INTO source_event_contents (source_event_id, ciphertext, iv, auth_tag, key_version)
           VALUES ($1,$2,$3,$4,$5)`,
					[
						id,
						encrypted.ciphertext,
						encrypted.iv,
						encrypted.authTag,
						encrypted.keyVersion,
					],
				);
				await client.query(
					`INSERT INTO outbox_jobs
            (id, organization_id, topic, dedupe_key, payload, state, attempts, available_at)
           VALUES ($1,$2,'evidence.source.recorded',$3,$4::jsonb,'pending',0,$5)
           ON CONFLICT (organization_id, dedupe_key) DO NOTHING`,
					[
						randomUUID(),
						this.organizationId,
						`evidence:source:recorded:${id}`,
						JSON.stringify({
							eventId: id,
							sourceVersionKey:
								identity?.sourceVersionKey ?? null,
						}),
						receivedAt,
					],
				);
				if (input.supersedesEventId) {
					await client.query(
						`DELETE FROM context_document_embeddings idx WHERE idx.organization_id=$1
               AND EXISTS (SELECT 1 FROM context_entries ce
                 WHERE ce.organization_id=idx.organization_id AND ce.id=idx.context_entry_id
                   AND (ce.source_event_id=$2::uuid OR $2::uuid=ANY(ce.evidence_ids)))`,
						[this.organizationId, input.supersedesEventId],
					);
					await client.query(
						`INSERT INTO outbox_jobs
              (id,organization_id,topic,dedupe_key,payload,state,attempts,available_at)
             VALUES ($1,$2,'evidence.source.superseded',$3,$4::jsonb,'pending',0,$5)
             ON CONFLICT (organization_id,dedupe_key) DO NOTHING`,
						[
							randomUUID(),
							this.organizationId,
							`evidence:superseded:${input.supersedesEventId}:${id}:start`,
							JSON.stringify({
								eventId: input.supersedesEventId,
								newEventId: id,
								afterTaskId: null,
							}),
							receivedAt,
						],
					);
				}
				await client.query("COMMIT");
				return {
					inserted: true,
					event: {
						...input,
						observationIdentity: identity,
						authorizationVersion: 1,
						supersedesEventId: input.supersedesEventId ?? null,
						id,
						receivedAt,
					},
				};
			}

			const existing = await client.query<SourceEventRow>(
				`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
           FROM source_events se
           LEFT JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
          WHERE se.organization_id=$1 AND se.provider=$2 AND se.installation_key=$3 AND se.provider_event_id=$4`,
				[
					this.organizationId,
					input.provider,
					input.installationKey,
					input.providerEventId,
				],
			);

			await client.query("COMMIT");
			// A deleted or disconnected source retains its receipt but not its content.
			// Duplicate backfill must skip it instead of aborting the whole channel.
			return {
				inserted: false,
				event: sourceEventFromRow(existing.rows[0]!, this.cipher, true),
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async listSourceEvents(limit: number): Promise<SourceEvent[]> {
		await this.contentReady;

		const result = await this.pool.query<SourceEventRow>(
			`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.content_state='active'
        ORDER BY se.received_at DESC LIMIT $2`,
			[this.organizationId, limit],
		);

		return result.rows.map((row) =>
			sourceEventFromRow(row, this.cipher, true),
		);
	}

	async listSourceContextCandidates(input: {
		provider: string;
		installationKey: string;
		visibility: string;
		cutoff: string;
		limit: number;
	}): Promise<SourceEvent[]> {
		if (
			!Number.isSafeInteger(input.limit) ||
			input.limit < 1 ||
			input.limit > 501 ||
			!Number.isFinite(Date.parse(input.cutoff))
		)
			throw new DomainError("Invalid context bounds.", "INVALID");
		await this.contentReady;

		const result = await this.pool.query<SourceEventRow>(
			`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.content_state='active'
          AND se.provider=$2 AND se.installation_key=$3 AND se.visibility=$4
          AND se.received_at<=$5::timestamptz AND se.occurred_at<=$5::timestamptz
        ORDER BY se.received_at DESC,se.id DESC LIMIT $6`,
			[
				this.organizationId,
				input.provider,
				input.installationKey,
				input.visibility,
				input.cutoff,
				input.limit,
			],
		);

		return result.rows.map((row) =>
			sourceEventFromRow(row, this.cipher, true),
		);
	}

	async listSourceEventsAfter(
		cursor: { receivedAt: string; id: string } | null,
		limit: number,
	): Promise<SourceEvent[]> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 101 ||
			(cursor &&
				(!Number.isFinite(Date.parse(cursor.receivedAt)) ||
					!/^[0-9a-f-]{36}$/i.test(cursor.id)))
		) {
			throw new DomainError(
				"Invalid evidence discovery cursor or page size.",
				"INVALID",
			);
		}
		await this.contentReady;

		const result = await this.pool.query<SourceEventRow>(
			`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.content_state='active'
          AND ($2::timestamptz IS NULL OR (se.received_at,se.id) > ($2::timestamptz,$3::uuid))
          AND NOT EXISTS (SELECT 1 FROM source_events newer
            WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
              AND newer.installation_key=se.installation_key
              AND coalesce(newer.canonical_object_key,newer.source_ref)
                =coalesce(se.canonical_object_key,se.source_ref)
              AND (se.source_version_key IS NULL
                OR newer.source_version_key IS DISTINCT FROM se.source_version_key
                OR newer.content_state<>'active')
              AND (newer.occurred_at,newer.received_at,newer.id)
                >(se.occurred_at,se.received_at,se.id))
        ORDER BY se.received_at ASC,se.id ASC LIMIT $4`,
			[
				this.organizationId,
				cursor?.receivedAt ?? null,
				cursor?.id ?? null,
				limit,
			],
		);

		return result.rows.map((row) =>
			sourceEventFromRow(row, this.cipher, true),
		);
	}

	async listSourceDocuments(
		limit: number,
		at?: string,
	): Promise<SourceEvent[]> {
		await this.contentReady;

		const result = await this.pool.query<SourceEventRow>(
			`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.content_state='active'
          AND ($3::timestamptz IS NULL OR se.received_at <= $3::timestamptz)
          AND (
            se.event_kind='source.document.retrieved'
            OR (se.provider='slack' AND se.event_kind IN ('message.explicitly_captured','message.imported','message.observed','message.edited'))
          )
          AND NOT EXISTS (SELECT 1 FROM source_events newer
            WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
              AND newer.installation_key=se.installation_key
              AND coalesce(newer.canonical_object_key,newer.source_ref)
                =coalesce(se.canonical_object_key,se.source_ref)
              AND ($3::timestamptz IS NULL OR newer.received_at <= $3::timestamptz)
              AND (se.source_version_key IS NULL
                OR newer.source_version_key IS DISTINCT FROM se.source_version_key
                OR newer.content_state<>'active')
              AND (newer.occurred_at,newer.received_at,newer.id)
                >(se.occurred_at,se.received_at,se.id))
        ORDER BY se.received_at DESC, se.id DESC LIMIT $2`,
			[this.organizationId, limit, at ?? null],
		);

		return result.rows.map((row) =>
			sourceEventFromRow(row, this.cipher, true),
		);
	}

	async getLatestSourceEventBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
	): Promise<SourceEvent | null> {
		await this.contentReady;

		const result = await this.pool.query<SourceEventRow>(
			`WITH requested AS (
         SELECT coalesce(canonical_object_key,source_ref) AS object_key
           FROM source_events WHERE organization_id=$1 AND provider=$2
             AND installation_key=$3 AND source_ref=$4
          ORDER BY occurred_at DESC,received_at DESC,id DESC LIMIT 1
       )
       SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.provider=$2 AND se.installation_key=$3
          AND coalesce(se.canonical_object_key,se.source_ref)=(SELECT object_key FROM requested)
          AND se.content_state='active'
          AND NOT EXISTS (SELECT 1 FROM source_events newer
            WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
              AND newer.installation_key=se.installation_key
              AND coalesce(newer.canonical_object_key,newer.source_ref)
                =coalesce(se.canonical_object_key,se.source_ref)
              AND (newer.occurred_at,newer.received_at,newer.id)
                >(se.occurred_at,se.received_at,se.id))
        ORDER BY se.occurred_at DESC, se.received_at DESC, se.id DESC
        LIMIT 1`,
			[this.organizationId, provider, installationKey, sourceRef],
		);

		return result.rows[0]
			? sourceEventFromRow(result.rows[0], this.cipher)
			: null;
	}

	async currentSourceEventIds(
		ids: readonly string[],
		at?: string,
	): Promise<string[]> {
		if (ids.length === 0) return [];

		const result = await this.pool.query<{ id: string }>(
			`SELECT se.id FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.id=ANY($2::uuid[]) AND se.content_state='active'
          AND ($3::timestamptz IS NULL OR se.received_at <= $3::timestamptz)
          AND NOT EXISTS (SELECT 1 FROM source_events newer
            WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
              AND newer.installation_key=se.installation_key
              AND coalesce(newer.canonical_object_key,newer.source_ref)
                =coalesce(se.canonical_object_key,se.source_ref)
              AND ($3::timestamptz IS NULL OR newer.received_at <= $3::timestamptz)
              AND (se.source_version_key IS NULL
                OR newer.source_version_key IS DISTINCT FROM se.source_version_key
                OR newer.content_state<>'active')
              AND (newer.occurred_at,newer.received_at,newer.id)
                >(se.occurred_at,se.received_at,se.id))`,
			[this.organizationId, ids, at ?? null],
		);

		return result.rows.map((row) => row.id);
	}

	async listActiveSourceRefs(
		provider: string,
		installationKey: string,
		visibility: string,
	): Promise<string[]> {
		const result = await this.pool.query<{ source_ref: string }>(
			`SELECT DISTINCT source_ref
         FROM source_events
        WHERE organization_id=$1 AND provider=$2 AND installation_key=$3
          AND visibility=$4 AND content_state='active'
        ORDER BY source_ref`,
			[this.organizationId, provider, installationKey, visibility],
		);

		return result.rows.map((row) => row.source_ref);
	}

	async getSourceEvents(ids: string[]): Promise<SourceEvent[]> {
		if (ids.length === 0) return [];
		await this.contentReady;

		const result = await this.pool.query<SourceEventRow>(
			`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE se.organization_id=$1 AND se.content_state='active' AND se.id=ANY($2::uuid[])`,
			[this.organizationId, ids],
		);
		const byId = new Map(
			result.rows.map((row) => [
				row.id,
				sourceEventFromRow(row, this.cipher),
			]),
		);

		return ids.flatMap((id) => byId.get(id) ?? []);
	}

	async getSourceEventScope(id: string): Promise<{
		provider: string;
		installationKey: string;
		visibility: string;
		canonicalObjectKey: string;
	} | null> {
		const result = await this.pool.query<{
			provider: string;
			installation_key: string;
			visibility: string;
			canonical_object_key: string;
		}>(
			`SELECT provider,installation_key,visibility,
              coalesce(canonical_object_key,source_ref) AS canonical_object_key
         FROM source_events WHERE organization_id=$1 AND id=$2`,
			[this.organizationId, id],
		);
		const row = result.rows[0];

		return row
			? {
					provider: row.provider,
					installationKey: row.installation_key,
					visibility: row.visibility,
					canonicalObjectKey: row.canonical_object_key,
				}
			: null;
	}

	async requestNoClaimReopen(input: {
		eventId: string;
		pipelineVersion: string;
		dispatchEpoch: string;
		actor: string;
		reason: string;
	}): Promise<OutboxJob> {
		await this.contentReady;

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const event = (
				await client.query<SourceEventRow>(
					`SELECT * FROM source_events WHERE organization_id=$1 AND id=$2
           AND content_state='active' FOR SHARE`,
					[this.organizationId, input.eventId],
				)
			).rows[0];
			const previous = event
				? (
						await client.query<DispositionRow>(
							`SELECT * FROM observation_dispositions WHERE organization_id=$1
           AND source_event_id=$2 AND pipeline_version=$3
           ORDER BY attempt DESC,created_at DESC LIMIT 1 FOR SHARE`,
							[
								this.organizationId,
								input.eventId,
								input.pipelineVersion,
							],
						)
					).rows[0]
				: null;

			if (
				!event ||
				previous?.state !== "no_claim" ||
				previous.attempt !== 1
			) {
				throw new DomainError(
					"Only an active first-pass no-claim receipt can be reopened.",
					"CONFLICT",
				);
			}

			const dedupeKey = `evidence:manual-reopen:${input.dispatchEpoch}:${event.id}:attempt:2`;
			const inserted = await client.query<OutboxJobRow>(
				`INSERT INTO outbox_jobs (id,organization_id,topic,dedupe_key,payload,state,attempts,available_at)
         VALUES ($1,$2,'evidence.source.ready',$3,$4::jsonb,'pending',0,now())
         ON CONFLICT (organization_id,dedupe_key) DO NOTHING RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					dedupeKey,
					JSON.stringify({
						pipelineVersion: input.pipelineVersion,
						dispatchEpoch: input.dispatchEpoch,
						eventId: event.id,
						sourceVersionKey: event.source_version_key,
						reason: "manual_reopen",
						requestedBy: input.actor,
						reviewReason: input.reason,
					}),
				],
			);
			const job =
				inserted.rows[0] ??
				(
					await client.query<OutboxJobRow>(
						"SELECT * FROM outbox_jobs WHERE organization_id=$1 AND dedupe_key=$2",
						[this.organizationId, dedupeKey],
					)
				).rows[0]!;

			if (inserted.rows[0]) {
				await client.query(
					`INSERT INTO audit_events
            (id,organization_id,actor,action,target_type,target_id,source_event_id,proposal_id,details,occurred_at)
           VALUES ($1,$2,$3,'evidence.no_claim_reopened','source_event',$4,$4,NULL,$5::jsonb,now())`,
					[
						randomUUID(),
						this.organizationId,
						input.actor,
						event.id,
						JSON.stringify({
							pipelineVersion: input.pipelineVersion,
							jobId: job.id,
							reason: input.reason,
						}),
					],
				);
			}
			await client.query("COMMIT");
			return outboxJobFromRow(job);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async listRevokedSourceEventIds(
		afterEventId: string | null,
		limit: number,
	): Promise<string[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError(
				"Invalid revoked source page size.",
				"INVALID",
			);
		}

		const result = await this.pool.query<{ id: string }>(
			`SELECT id FROM source_events WHERE organization_id=$1 AND content_state='revoked'
         AND ($2::uuid IS NULL OR id>$2::uuid) ORDER BY id LIMIT $3`,
			[this.organizationId, afterEventId, limit],
		);

		return result.rows.map((row) => row.id);
	}

	async listSourceSupersessions(
		afterNewEventId: string | null,
		limit: number,
	): Promise<
		{
			oldEventId: string;
			newEventId: string;
		}[]
	> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError(
				"Invalid source supersession page size.",
				"INVALID",
			);
		}

		const result = await this.pool.query<{
			supersedes_event_id: string;
			id: string;
		}>(
			`SELECT id,supersedes_event_id FROM source_events WHERE organization_id=$1
         AND supersedes_event_id IS NOT NULL AND ($2::uuid IS NULL OR id>$2::uuid)
         ORDER BY id LIMIT $3`,
			[this.organizationId, afterNewEventId, limit],
		);

		return result.rows.map((row) => ({
			oldEventId: row.supersedes_event_id,
			newEventId: row.id,
		}));
	}

	private async redactDerivedForRevokedSources(
		client: PoolClient,
		ids: string[],
	): Promise<void> {
		if (ids.length === 0) return;
		await client.query(
			"UPDATE work_assertions SET body_envelope=NULL WHERE organization_id=$1 AND source_event_id=ANY($2::uuid[])",
			[this.organizationId, ids],
		);
		await client.query(
			`UPDATE evidence_claims c SET content_state='revoked',body_envelope=NULL
         WHERE c.organization_id=$1 AND c.content_state='active'
           AND EXISTS (SELECT 1 FROM evidence_dependencies d
             WHERE d.organization_id=c.organization_id AND d.dependent_type='claim'
               AND d.dependent_id=c.id AND d.source_event_id=ANY($2::uuid[]))`,
			[this.organizationId, ids],
		);
		await client.query(
			`UPDATE evidence_assessments a SET content_state='revoked',body_envelope=NULL
         WHERE a.organization_id=$1 AND a.content_state='active'
           AND (EXISTS (SELECT 1 FROM evidence_dependencies d
             WHERE d.organization_id=a.organization_id AND d.dependent_type='assessment'
               AND d.dependent_id=a.id AND d.source_event_id=ANY($2::uuid[]))
             OR EXISTS (SELECT 1 FROM model_calls mc WHERE mc.organization_id=a.organization_id
               AND mc.run_id=a.run_id AND mc.contextual_source_event_ids && $2::uuid[]))`,
			[this.organizationId, ids],
		);
		await client.query(
			"UPDATE work_scopes SET body_envelope=NULL WHERE organization_id=$1 AND source_event_ids && $2::uuid[]",
			[this.organizationId, ids],
		);
		await client.query(
			"UPDATE work_state_assessments SET body_envelope=NULL WHERE organization_id=$1 AND source_event_ids && $2::uuid[]",
			[this.organizationId, ids],
		);
		await client.query(
			`UPDATE model_calls mc SET request_envelope=NULL,response_envelope=NULL,cache_key=NULL
         WHERE mc.organization_id=$1 AND (mc.contextual_source_event_ids && $2::uuid[] OR EXISTS (
           SELECT 1 FROM interpretation_runs ir WHERE ir.organization_id=mc.organization_id
             AND ir.id=mc.run_id AND ir.event_ids && $2::uuid[]))`,
			[this.organizationId, ids],
		);
		await client.query(
			`UPDATE interpretation_runs SET output=NULL,output_envelope=NULL,
         manifest_envelope=NULL,error=NULL,content_state='revoked'
         WHERE organization_id=$1 AND (event_ids && $2::uuid[] OR EXISTS (
           SELECT 1 FROM model_calls mc WHERE mc.organization_id=interpretation_runs.organization_id
             AND mc.run_id=interpretation_runs.id AND mc.contextual_source_event_ids && $2::uuid[]))`,
			[this.organizationId, ids],
		);
	}

	async revokeSourceEvent(id: string): Promise<boolean> {
		await this.contentReady;

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const result = await client.query(
				`UPDATE source_events SET content_state='revoked', revoked_at=now()
          WHERE organization_id=$1 AND id=$2 AND content_state='active'`,
				[this.organizationId, id],
			);

			if (result.rowCount === 1) {
				await client.query(
					"DELETE FROM source_event_contents WHERE source_event_id=$1",
					[id],
				);
				await this.redactDerivedForRevokedSources(client, [id]);
				await client.query(
					"DELETE FROM work_entity_embeddings WHERE organization_id=$1 AND entity_type IN ('task','claim','context','query')",
					[this.organizationId],
				);
				await client.query(
					`DELETE FROM context_document_embeddings idx WHERE idx.organization_id=$1
             AND idx.context_entry_id IN (SELECT ce.id FROM context_entries ce
               WHERE ce.organization_id=$1 AND (ce.source_event_id=$2 OR $2=ANY(ce.evidence_ids)))`,
					[this.organizationId, id],
				);
				await client.query(
					`INSERT INTO outbox_jobs (id,organization_id,topic,dedupe_key,payload,state,attempts,available_at)
           VALUES ($1,$2,'evidence.source.revoked',$3,$4::jsonb,'pending',0,now())
           ON CONFLICT (organization_id,dedupe_key) DO NOTHING`,
					[
						randomUUID(),
						this.organizationId,
						`evidence:revoked:${id}:start`,
						JSON.stringify({ eventId: id, afterTaskId: null }),
					],
				);
			}
			await client.query("COMMIT");
			return result.rowCount === 1;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async revokeSourceEventsBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
		exceptEventId?: string,
	): Promise<string[]> {
		return this.revokeMatchingSourceEvents(
			"provider=$2 AND installation_key=$3 AND source_ref=$4",
			[provider, installationKey, sourceRef],
			exceptEventId,
		);
	}

	async revokeSourceEventsByVisibility(
		provider: string,
		installationKey: string,
		visibility: string,
		exceptEventId?: string,
	): Promise<string[]> {
		return this.revokeMatchingSourceEvents(
			"provider=$2 AND installation_key=$3 AND visibility=$4",
			[provider, installationKey, visibility],
			exceptEventId,
		);
	}

	async listUninterpretedSourceEvents(
		providers: string[],
		limit: number,
		model?: string,
	): Promise<SourceEvent[]> {
		if (providers.length === 0) return [];
		await this.contentReady;

		const selectors = providers.map((selector) => {
			const separator = selector.indexOf(":");

			return separator < 0
				? { provider: selector, eventKind: null }
				: {
						provider: selector.slice(0, separator),
						eventKind: selector.slice(separator + 1),
					};
		});
		const result = await this.pool.query<SourceEventRow>(
			`SELECT se.*, sec.ciphertext, sec.iv, sec.auth_tag, sec.key_version
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
        WHERE EXISTS (
            SELECT 1
              FROM jsonb_to_recordset($1::jsonb) AS selector(provider text, "eventKind" text)
             WHERE selector.provider = se.provider
               AND (selector."eventKind" IS NULL OR selector."eventKind" = se.event_kind)
          )
          AND se.organization_id = $2
          AND se.content_state = 'active'
          AND NOT (
            se.provider = 'manual'
            AND se.event_kind = ANY($4::text[])
          )
          AND NOT EXISTS (
            SELECT 1
              FROM interpretation_runs ir
             WHERE ir.state = 'completed'
               AND ir.organization_id = se.organization_id
               AND ($5::text IS NULL OR ir.model = $5)
               AND se.id = ANY(ir.event_ids)
          )
        ORDER BY se.occurred_at, se.received_at
        LIMIT $3`,
			[
				JSON.stringify(selectors),
				this.organizationId,
				limit,
				acceptedContextReceiptEventKinds,
				model ?? null,
			],
		);

		return result.rows.map((row) => sourceEventFromRow(row, this.cipher));
	}

	async getWorkEntityEmbedding(input: {
		entityType: "task" | "project" | "claim" | "context" | "query";
		entityId: string;
		model: string;
		modelVersion: string;
		inputHash: string;
		permissionFingerprint: string;
	}): Promise<number[] | null> {
		const result = await this.pool.query<{
			vectors_envelope: EncryptedPayload;
			vector_dimension: number;
		}>(
			`SELECT vectors_envelope,vector_dimension FROM work_entity_embeddings
        WHERE organization_id=$1 AND entity_type=$2 AND entity_id=$3 AND model=$4
          AND model_version=$5 AND input_hash=$6 AND permission_fingerprint=$7`,
			[
				this.organizationId,
				input.entityType,
				input.entityId,
				input.model,
				input.modelVersion,
				input.inputHash,
				input.permissionFingerprint,
			],
		);
		const row = result.rows[0];

		if (!row) return null;

		const vector = this.cipher.decrypt(row.vectors_envelope);

		if (
			!Array.isArray(vector) ||
			vector.length !== row.vector_dimension ||
			vector.some(
				(value) => typeof value !== "number" || !Number.isFinite(value),
			)
		) {
			throw new DomainError(
				"Stored work entity embedding is invalid.",
				"INVALID",
			);
		}
		return vector as number[];
	}

	async getEvidenceAccessVersion(): Promise<string> {
		const result = await this.pool.query<{
			revoked_count: string;
			latest_revocation: string | null;
		}>(
			`SELECT count(*) FILTER (WHERE content_state='revoked')::text AS revoked_count,
              max(revoked_at)::text AS latest_revocation
         FROM source_events WHERE organization_id=$1`,
			[this.organizationId],
		);
		const row = result.rows[0];

		return `${row?.revoked_count ?? "0"}:${row?.latest_revocation ?? "none"}`;
	}

	async listAffectedContextEntryIdsBySource(
		eventId: string,
		afterEntryId: string | null,
		limit: number,
	): Promise<string[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError(
				"Invalid affected context page size.",
				"INVALID",
			);
		}

		const result = await this.pool.query<{ id: string }>(
			`SELECT id FROM context_entries WHERE organization_id=$1
         AND (source_event_id=$2 OR $2::uuid=ANY(evidence_ids))
         AND ($3::uuid IS NULL OR id>$3::uuid)
         ORDER BY id LIMIT $4`,
			[this.organizationId, eventId, afterEntryId, limit],
		);

		return result.rows.map((row) => row.id);
	}

	async putWorkEntityEmbedding(input: {
		entityType: "task" | "project" | "claim" | "context" | "query";
		entityId: string;
		model: string;
		modelVersion: string;
		inputHash: string;
		permissionFingerprint: string;
		vector: number[];
	}): Promise<void> {
		if (
			!input.vector.length ||
			input.vector.some((value) => !Number.isFinite(value)) ||
			!input.vector.some((value) => value !== 0)
		) {
			throw new DomainError("Invalid work entity embedding.", "INVALID");
		}

		const envelope = this.cipher.encrypt(input.vector as JsonValue);

		await this.pool.query(
			`INSERT INTO work_entity_embeddings (organization_id,entity_type,entity_id,model,
         model_version,input_hash,permission_fingerprint,vector_dimension,vectors_envelope)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
       ON CONFLICT (organization_id,entity_type,entity_id,model,model_version,input_hash,
         permission_fingerprint) DO UPDATE SET vector_dimension=excluded.vector_dimension,
         vectors_envelope=excluded.vectors_envelope`,
			[
				this.organizationId,
				input.entityType,
				input.entityId,
				input.model,
				input.modelVersion,
				input.inputHash,
				input.permissionFingerprint,
				input.vector.length,
				JSON.stringify(envelope),
			],
		);
	}

	async createInferenceBudget(input: {
		label: string;
		maxCalls: number;
		maxInputTokens: number;
		maxOutputTokens: number;
		maxUsd: string | null;
		deadline: string;
		priceBasis: JsonValue | null;
	}): Promise<InferenceBudget> {
		for (const limit of [
			input.maxCalls,
			input.maxInputTokens,
			input.maxOutputTokens,
		]) {
			if (
				!Number.isSafeInteger(limit) ||
				limit <= 0 ||
				limit > 1_000_000_000_000
			) {
				throw new DomainError(
					"Inference budget limits must be finite positive safe integers.",
					"INVALID",
				);
			}
		}
		if (
			!Number.isFinite(Date.parse(input.deadline)) ||
			Date.parse(input.deadline) <= Date.now()
		) {
			throw new DomainError(
				"Inference budget deadline must be in the future.",
				"INVALID",
			);
		}

		const id = randomUUID();

		await this.pool.query(
			`INSERT INTO inference_budgets
        (id,organization_id,label,state,max_calls,max_input_tokens,max_output_tokens,max_usd,deadline,price_basis)
       VALUES ($1,$2,$3,'active',$4,$5,$6,$7,$8,$9::jsonb)`,
			[
				id,
				this.organizationId,
				input.label,
				input.maxCalls,
				input.maxInputTokens,
				input.maxOutputTokens,
				input.maxUsd,
				input.deadline,
				input.priceBasis === null
					? null
					: JSON.stringify(input.priceBasis),
			],
		);
		return {
			id,
			label: input.label,
			state: "active",
			maxCalls: input.maxCalls,
			maxInputTokens: input.maxInputTokens,
			maxOutputTokens: input.maxOutputTokens,
			maxUsd: input.maxUsd,
			deadline: input.deadline,
			reservedCalls: 0,
			spentCalls: 0,
			reservedInputTokens: 0,
			spentInputTokens: 0,
			reservedOutputTokens: 0,
			spentOutputTokens: 0,
			reservedUsd: "0.00000000",
			spentUsd: "0.00000000",
		};
	}

	async getInferenceBudget(id: string): Promise<InferenceBudget | null> {
		const result = await this.pool.query<{
			id: string;
			label: string;
			state: InferenceBudget["state"];
			max_calls: string;
			max_input_tokens: string;
			max_output_tokens: string;
			max_usd: string | null;
			deadline: Date;
			reserved_calls: string;
			spent_calls: string;
			reserved_input_tokens: string;
			spent_input_tokens: string;
			reserved_output_tokens: string;
			spent_output_tokens: string;
			reserved_usd: string;
			spent_usd: string;
		}>(
			`SELECT id,label,state,max_calls,max_input_tokens,max_output_tokens,max_usd,
              deadline,reserved_calls,spent_calls,reserved_input_tokens,spent_input_tokens,
              reserved_output_tokens,spent_output_tokens,reserved_usd,spent_usd
         FROM inference_budgets WHERE organization_id=$1 AND id=$2`,
			[this.organizationId, id],
		);
		const row = result.rows[0];

		return row
			? {
					id: row.id,
					label: row.label,
					state: row.state,
					maxCalls: Number(row.max_calls),
					maxInputTokens: Number(row.max_input_tokens),
					maxOutputTokens: Number(row.max_output_tokens),
					maxUsd: row.max_usd,
					deadline: row.deadline.toISOString(),
					reservedCalls: Number(row.reserved_calls),
					spentCalls: Number(row.spent_calls),
					reservedInputTokens: Number(row.reserved_input_tokens),
					spentInputTokens: Number(row.spent_input_tokens),
					reservedOutputTokens: Number(row.reserved_output_tokens),
					spentOutputTokens: Number(row.spent_output_tokens),
					reservedUsd: row.reserved_usd,
					spentUsd: row.spent_usd,
				}
			: null;
	}

	private async lockModelCallSources(
		client: PoolClient,
		runId: string,
		contextualSourceEventIds: string[],
	): Promise<boolean> {
		const run = (
			await client.query<{
				content_state: string;
				event_ids: string[];
				policy_version: string | null;
			}>(
				"SELECT content_state,event_ids,policy_version FROM interpretation_runs WHERE organization_id=$1 AND id=$2 AND schema_version=2",
				[this.organizationId, runId],
			)
		).rows[0];

		if (!run || run.content_state !== "active") return false;

		const ids = [
			...new Set([...run.event_ids, ...contextualSourceEventIds]),
		].sort();

		await this.lockSourceObjectKeys(client, ids);

		const sources = (
			await client.query<SourceEventRow>(
				`SELECT * FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[])
         ORDER BY id FOR SHARE`,
				[this.organizationId, ids],
			)
		).rows;

		if (
			sources.length !== ids.length ||
			sources.some((source) => source.content_state !== "active")
		)
			return false;
		// Observation workflows let the model reason about original source chronology.
		// That policy is independent of the wording/version of its instructions.
		if (run.policy_version === "observation-agent-v1") return true;

		const contextual = sources.filter((source) =>
			contextualSourceEventIds.includes(source.id),
		);

		if (contextual.length > 0) {
			const current = await client.query<{ id: string }>(
				`SELECT se.id FROM source_events se
           JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
          WHERE se.organization_id=$1 AND se.id=ANY($2::uuid[]) AND se.content_state='active'
            AND NOT EXISTS (SELECT 1 FROM source_events newer
              WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
                AND newer.installation_key=se.installation_key
                AND coalesce(newer.canonical_object_key,newer.source_ref)
                  =coalesce(se.canonical_object_key,se.source_ref)
                AND (se.source_version_key IS NULL
                  OR newer.source_version_key IS DISTINCT FROM se.source_version_key
                  OR newer.content_state<>'active')
                AND (newer.occurred_at,newer.received_at,newer.id)
                  >(se.occurred_at,se.received_at,se.id))`,
				[this.organizationId, contextualSourceEventIds],
			);

			if (current.rows.length !== contextualSourceEventIds.length)
				return false;
		}
		return true;
	}

	private async lockSourceObjectKeys(
		client: PoolClient,
		ids: readonly string[],
	): Promise<void> {
		if (ids.length === 0) return;

		// Source ingestion takes the object lock before touching source rows.
		// Approval and model dispatch must follow that order to avoid deadlocks.
		const result = await client.query<{
			canonical_object_key: string | null;
		}>(
			`SELECT canonical_object_key FROM source_events
        WHERE organization_id=$1 AND id=ANY($2::uuid[])`,
			[this.organizationId, ids],
		);
		const keys = [
			...new Set(
				result.rows
					.map((row) => row.canonical_object_key)
					.filter((key): key is string => Boolean(key)),
			),
		].sort();

		for (const key of keys) {
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[`${this.organizationId}:source:${key}`],
			);
		}
	}

	async reserveModelCall(
		input: ReserveCallInput,
	): Promise<
		| { kind: "reserved"; call: ModelCall }
		| { kind: "exhausted"; reason: string }
	> {
		for (const value of [
			input.attempt,
			input.estimatedInputTokens,
			input.estimatedOutputTokens,
		]) {
			if (
				!Number.isSafeInteger(value) ||
				value < 0 ||
				value > 1_000_000_000_000
			) {
				throw new DomainError(
					"Model call reservation requires finite token bounds.",
					"INVALID",
				);
			}
		}
		if (
			input.attempt < 1 ||
			!input.logicalCallKey ||
			!input.provider ||
			!input.model ||
			(input.estimatedUsd !== null &&
				(!/^\d+(?:\.\d{1,8})?$/.test(input.estimatedUsd) ||
					Number(input.estimatedUsd) < 0))
		) {
			throw new DomainError(
				"Model call reservation is invalid.",
				"INVALID",
			);
		}

		const contextualSourceEventIds = [
			...new Set(input.contextualSourceEventIds ?? []),
		].sort();

		// Current derived records can legitimately cite more than 500 receipts. These are
		// audit metadata, not prompt text; validate every UUID and lock every source below.
		if (
			contextualSourceEventIds.some(
				(id) =>
					!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
						id,
					),
			)
		) {
			throw new DomainError(
				"Model call contextual source list is invalid.",
				"INVALID",
			);
		}

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");
			if (
				!(await this.lockModelCallSources(
					client,
					input.runId,
					contextualSourceEventIds,
				))
			) {
				throw new DomainError(
					"Model call source was unavailable before reservation.",
					"CONFLICT",
				);
			}

			const budget = await client.query<{
				state: string;
				deadline: Date;
				max_calls: string;
				max_input_tokens: string;
				max_output_tokens: string;
				max_usd: string | null;
				reserved_calls: string;
				reserved_input_tokens: string;
				reserved_output_tokens: string;
				reserved_usd: string;
				spent_calls: string;
				spent_input_tokens: string;
				spent_output_tokens: string;
				spent_usd: string;
			}>(
				"SELECT * FROM inference_budgets WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, input.budgetId],
			);
			const b = budget.rows[0];

			if (!b)
				throw new DomainError(
					"Inference budget was not found.",
					"NOT_FOUND",
				);

			const previous = await client.query<ModelCallRow>(
				`SELECT * FROM model_calls WHERE organization_id=$1 AND logical_call_key=$2 AND attempt=$3 FOR UPDATE`,
				[this.organizationId, input.logicalCallKey, input.attempt],
			);

			if (previous.rows[0]) {
				const row = previous.rows[0];

				if (
					row.request_hash !== input.requestHash ||
					row.budget_id !== input.budgetId ||
					row.run_id !== input.runId ||
					contentHash(row.contextual_source_event_ids) !==
						contentHash(contextualSourceEventIds)
				) {
					throw new DomainError(
						"Model call key belongs to a different request.",
						"CONFLICT",
					);
				}
				await client.query("COMMIT");
				return { kind: "reserved", call: modelCallFromRow(row) };
			}

			const reason =
				b.state !== "active"
					? `budget_${b.state}`
					: b.deadline.getTime() <= Date.now()
						? "deadline_exceeded"
						: Number(b.spent_calls) + Number(b.reserved_calls) + 1 >
							  Number(b.max_calls)
							? "call_cap"
							: Number(b.spent_input_tokens) +
										Number(b.reserved_input_tokens) +
										input.estimatedInputTokens >
								  Number(b.max_input_tokens)
								? "input_token_cap"
								: Number(b.spent_output_tokens) +
											Number(b.reserved_output_tokens) +
											input.estimatedOutputTokens >
									  Number(b.max_output_tokens)
									? "output_token_cap"
									: b.max_usd !== null &&
										  input.estimatedUsd === null
										? "price_unknown"
										: b.max_usd !== null &&
											  Number(b.spent_usd) +
													Number(b.reserved_usd) +
													Number(input.estimatedUsd) >
													Number(b.max_usd)
											? "usd_cap"
											: null;

			if (reason) {
				await client.query("COMMIT");
				return { kind: "exhausted", reason };
			}

			const envelope = this.cipher.encrypt(input.request);
			const result = await client.query<ModelCallRow>(
				`INSERT INTO model_calls
          (id,organization_id,budget_id,run_id,purpose,logical_call_key,attempt,provider,model,state,
           request_hash,request_envelope,cache_key,contextual_source_event_ids,reserved_input_tokens,reserved_output_tokens,
           reserved_usd,cost_basis)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'reserved',$10,$11::jsonb,$12,$13::uuid[],$14,$15,$16,'unknown')
         RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.budgetId,
					input.runId,
					input.purpose,
					input.logicalCallKey,
					input.attempt,
					input.provider,
					input.model,
					input.requestHash,
					JSON.stringify(envelope),
					input.cacheKey,
					contextualSourceEventIds,
					input.estimatedInputTokens,
					input.estimatedOutputTokens,
					input.estimatedUsd ?? "0",
				],
			);

			await client.query(
				`UPDATE inference_budgets SET reserved_calls=reserved_calls+1,
           reserved_input_tokens=reserved_input_tokens+$3,
           reserved_output_tokens=reserved_output_tokens+$4,
           reserved_usd=reserved_usd+$5::numeric
         WHERE organization_id=$1 AND id=$2`,
				[
					this.organizationId,
					input.budgetId,
					input.estimatedInputTokens,
					input.estimatedOutputTokens,
					input.estimatedUsd ?? "0",
				],
			);
			await client.query("COMMIT");
			return {
				kind: "reserved",
				call: modelCallFromRow(result.rows[0]!),
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async markModelCallDispatched(callId: string, at: string): Promise<void> {
		const client = await this.pool.connect();
		let cancelledForRevocation = false;

		try {
			await client.query("BEGIN");

			const pre = await client.query<{
				budget_id: string;
				run_id: string;
				contextual_source_event_ids: string[];
			}>(
				"SELECT budget_id,run_id,contextual_source_event_ids FROM model_calls WHERE organization_id=$1 AND id=$2",
				[this.organizationId, callId],
			);

			if (!pre.rows[0])
				throw new DomainError("Model call was not found.", "NOT_FOUND");

			const sourcesActive = await this.lockModelCallSources(
				client,
				pre.rows[0].run_id,
				pre.rows[0].contextual_source_event_ids,
			);

			await client.query(
				"SELECT id FROM inference_budgets WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, pre.rows[0].budget_id],
			);

			const callResult = await client.query<ModelCallRow>(
				"SELECT * FROM model_calls WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, callId],
			);
			const call = callResult.rows[0];

			if (!call || call.state !== "reserved") {
				throw new DomainError(
					"Model call is not reserved for dispatch.",
					"CONFLICT",
				);
			}
			if (!sourcesActive) {
				await client.query(
					`UPDATE model_calls SET state='cancelled',request_envelope=NULL,response_envelope=NULL,
             cache_key=NULL,cost_usd='0',cost_basis='known_zero',error_code='source_revoked',finished_at=$3
           WHERE organization_id=$1 AND id=$2`,
					[this.organizationId, callId, at],
				);
				await client.query(
					`UPDATE inference_budgets SET reserved_calls=reserved_calls-1,
             reserved_input_tokens=reserved_input_tokens-$3,
             reserved_output_tokens=reserved_output_tokens-$4,
             reserved_usd=reserved_usd-$5::numeric,spent_calls=spent_calls+1
           WHERE organization_id=$1 AND id=$2`,
					[
						this.organizationId,
						call.budget_id,
						call.reserved_input_tokens,
						call.reserved_output_tokens,
						call.reserved_usd,
					],
				);
				await client.query("COMMIT");
				cancelledForRevocation = true;
			} else {
				await client.query(
					`UPDATE model_calls SET state='dispatched',dispatched_at=$3
             WHERE organization_id=$1 AND id=$2`,
					[this.organizationId, callId, at],
				);
				await client.query("COMMIT");
			}
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
		if (cancelledForRevocation) {
			throw new DomainError(
				"Source was revoked before model dispatch.",
				"CONFLICT",
			);
		}
	}

	async settleModelCall(input: SettleCallInput): Promise<ModelCall> {
		const pre = await this.pool.query<{
			budget_id: string;
			run_id: string;
			contextual_source_event_ids: string[];
		}>(
			"SELECT budget_id,run_id,contextual_source_event_ids FROM model_calls WHERE organization_id=$1 AND id=$2",
			[this.organizationId, input.callId],
		);

		if (!pre.rows[0])
			throw new DomainError("Model call was not found.", "NOT_FOUND");

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const sourceRevoked = !(await this.lockModelCallSources(
				client,
				pre.rows[0].run_id,
				pre.rows[0].contextual_source_event_ids,
			));

			await client.query(
				"SELECT id FROM inference_budgets WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, pre.rows[0].budget_id],
			);

			const result = await client.query<ModelCallRow>(
				"SELECT * FROM model_calls WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, input.callId],
			);
			const call = result.rows[0];

			if (!call || call.budget_id !== pre.rows[0].budget_id)
				throw new DomainError("Model call changed budget.", "CONFLICT");
			if (!["reserved", "dispatched"].includes(call.state)) {
				await client.query("COMMIT");
				return modelCallFromRow(call);
			}

			const unknown =
				input.state === "unknown" ||
				(input.state !== "cancelled" &&
					(input.inputTokens === null ||
						input.outputTokens === null));
			const finalState = unknown ? "unknown" : input.state;
			const responseEnvelope =
				input.response === null || sourceRevoked
					? null
					: this.cipher.encrypt(input.response);
			const updated = await client.query<ModelCallRow>(
				`UPDATE model_calls SET state=$3,resolved_model_version=$4,input_tokens=$5,cached_input_tokens=$6,
           output_tokens=$7,embedding_items=$8,cost_usd=$9,cost_basis=$10,provider_request_id=$11,
           error_code=$12,response_envelope=$13::jsonb,finished_at=$14,
           request_envelope=CASE WHEN $15 THEN NULL ELSE request_envelope END,
           cache_key=CASE WHEN $15 THEN NULL ELSE cache_key END
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
				[
					this.organizationId,
					input.callId,
					finalState,
					input.resolvedModelVersion,
					input.inputTokens,
					input.cachedInputTokens,
					input.outputTokens,
					input.embeddingItems,
					input.costUsd,
					input.costBasis,
					input.providerRequestId,
					input.errorCode,
					responseEnvelope ? JSON.stringify(responseEnvelope) : null,
					input.finishedAt,
					sourceRevoked,
				],
			);

			if (unknown) {
				await client.query(
					"UPDATE inference_budgets SET state='suspended' WHERE organization_id=$1 AND id=$2",
					[this.organizationId, call.budget_id],
				);
			} else {
				await client.query(
					`UPDATE inference_budgets SET reserved_calls=reserved_calls-1,
             reserved_input_tokens=reserved_input_tokens-$3,
             reserved_output_tokens=reserved_output_tokens-$4,
             reserved_usd=reserved_usd-(SELECT reserved_usd FROM model_calls WHERE id=$5),
             spent_calls=spent_calls+1,spent_input_tokens=spent_input_tokens+$6,
             spent_output_tokens=spent_output_tokens+$7,spent_usd=spent_usd+$8::numeric
           WHERE organization_id=$1 AND id=$2`,
					[
						this.organizationId,
						call.budget_id,
						call.reserved_input_tokens,
						call.reserved_output_tokens,
						call.id,
						input.inputTokens ?? 0,
						input.outputTokens ?? 0,
						input.costUsd ?? "0",
					],
				);
				if (input.costBasis === "unknown") {
					const financial = await client.query<{
						max_usd: string | null;
					}>(
						"SELECT max_usd FROM inference_budgets WHERE organization_id=$1 AND id=$2",
						[this.organizationId, call.budget_id],
					);

					if (financial.rows[0]?.max_usd !== null) {
						await client.query(
							"UPDATE inference_budgets SET state='suspended' WHERE organization_id=$1 AND id=$2",
							[this.organizationId, call.budget_id],
						);
					}
				}
				await client.query(
					`UPDATE inference_budgets SET state='exhausted'
            WHERE organization_id=$1 AND id=$2 AND state='active'
              AND (spent_calls+reserved_calls>=max_calls
                OR spent_input_tokens+reserved_input_tokens>=max_input_tokens
                OR spent_output_tokens+reserved_output_tokens>=max_output_tokens
                OR (max_usd IS NOT NULL AND spent_usd+reserved_usd>=max_usd))`,
					[this.organizationId, call.budget_id],
				);
			}
			await client.query("COMMIT");
			return modelCallFromRow(updated.rows[0]!);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async reconcileUnknownModelCallAtReservedBound(
		callId: string,
	): Promise<ModelCall> {
		const pre = await this.pool.query<{ budget_id: string }>(
			"SELECT budget_id FROM model_calls WHERE organization_id=$1 AND id=$2",
			[this.organizationId, callId],
		);

		if (!pre.rows[0])
			throw new DomainError("Model call was not found.", "NOT_FOUND");

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const budgetResult = await client.query<{
				state: string;
				deadline: Date;
				max_calls: string;
				max_input_tokens: string;
				max_output_tokens: string;
				max_usd: string | null;
				reserved_calls: string;
				reserved_input_tokens: string;
				reserved_output_tokens: string;
				reserved_usd: string;
				spent_calls: string;
				spent_input_tokens: string;
				spent_output_tokens: string;
				spent_usd: string;
			}>(
				"SELECT * FROM inference_budgets WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, pre.rows[0].budget_id],
			);
			const budget = budgetResult.rows[0];

			if (!budget)
				throw new DomainError(
					"Inference budget was not found.",
					"NOT_FOUND",
				);

			const callResult = await client.query<ModelCallRow>(
				"SELECT * FROM model_calls WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, callId],
			);
			const call = callResult.rows[0];

			if (!call || call.budget_id !== pre.rows[0].budget_id) {
				throw new DomainError("Model call changed budget.", "CONFLICT");
			}
			if (
				call.state === "failed" &&
				call.error_code?.endsWith("_reserved_bound")
			) {
				await client.query("COMMIT");
				return modelCallFromRow(call);
			}
			if (
				call.state !== "unknown" ||
				Number(budget.reserved_calls) < 1 ||
				Number(budget.reserved_input_tokens) <
					Number(call.reserved_input_tokens) ||
				Number(budget.reserved_output_tokens) <
					Number(call.reserved_output_tokens) ||
				Number(budget.reserved_usd) < Number(call.reserved_usd)
			) {
				throw new DomainError(
					"Unknown call has no held budget reservation.",
					"CONFLICT",
				);
			}

			const updated = await client.query<ModelCallRow>(
				`UPDATE model_calls SET state='failed',cost_usd=reserved_usd,cost_basis='estimated',
           error_code=left(coalesce(error_code,'unknown') || '_reserved_bound',100)
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
				[this.organizationId, callId],
			);
			const otherUnknown = await client.query<{ count: string }>(
				"SELECT count(*)::text AS count FROM model_calls WHERE organization_id=$1 AND budget_id=$2 AND state='unknown'",
				[this.organizationId, call.budget_id],
			);
			const spentCalls = Number(budget.spent_calls) + 1;
			const spentInput =
				Number(budget.spent_input_tokens) +
				Number(call.reserved_input_tokens);
			const spentOutput =
				Number(budget.spent_output_tokens) +
				Number(call.reserved_output_tokens);
			const spentUsd =
				Number(budget.spent_usd) + Number(call.reserved_usd);
			const state =
				Number(otherUnknown.rows[0]?.count ?? 0) > 0
					? "suspended"
					: budget.deadline.getTime() <= Date.now() ||
						  spentCalls >= Number(budget.max_calls) ||
						  spentInput >= Number(budget.max_input_tokens) ||
						  spentOutput >= Number(budget.max_output_tokens) ||
						  (budget.max_usd !== null &&
								spentUsd >= Number(budget.max_usd))
						? "exhausted"
						: "active";

			await client.query(
				`UPDATE inference_budgets SET state=$3,reserved_calls=reserved_calls-1,
           reserved_input_tokens=reserved_input_tokens-$4,
           reserved_output_tokens=reserved_output_tokens-$5,
           reserved_usd=reserved_usd-$6::numeric,spent_calls=spent_calls+1,
           spent_input_tokens=spent_input_tokens+$4,spent_output_tokens=spent_output_tokens+$5,
           spent_usd=spent_usd+$6::numeric WHERE organization_id=$1 AND id=$2`,
				[
					this.organizationId,
					call.budget_id,
					state,
					call.reserved_input_tokens,
					call.reserved_output_tokens,
					call.reserved_usd,
				],
			);
			await client.query("COMMIT");
			return modelCallFromRow(updated.rows[0]!);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async listModelCalls(runId: string): Promise<ModelCall[]> {
		const result = await this.pool.query<ModelCallRow>(
			"SELECT * FROM model_calls WHERE organization_id=$1 AND run_id=$2 ORDER BY created_at,id",
			[this.organizationId, runId],
		);

		return result.rows.map(modelCallFromRow);
	}

	async getModelCallResponseByKey(logicalCallKey: string): Promise<{
		call: ModelCall;
		response: JsonValue | null;
	} | null> {
		const result = await this.pool.query<ModelCallRow>(
			`SELECT * FROM model_calls WHERE organization_id=$1 AND logical_call_key=$2
         AND attempt=1 LIMIT 1`,
			[this.organizationId, logicalCallKey],
		);
		const row = result.rows[0];

		if (!row) return null;

		const contextual = row.contextual_source_event_ids ?? [];
		const run = await this.getInterpretationRun(row.run_id);
		const sourceIds = [
			...new Set([...(run?.eventIds ?? []), ...contextual]),
		];
		const [events, currentIds] = await Promise.all([
			this.getSourceEvents(sourceIds),
			this.currentSourceEventIds(sourceIds),
		]);
		const current = new Set(currentIds);
		const observationEmbedding =
			row.purpose === "embed" &&
			Boolean(await this.getObservationAgentCheckpoint(row.run_id));
		const available =
			run &&
			events.length === sourceIds.length &&
			(row.purpose === "observe" ||
				observationEmbedding ||
				sourceIds.every((id) => current.has(id)));

		return {
			call: modelCallFromRow(row),
			response:
				available && row.response_envelope
					? this.cipher.decrypt(row.response_envelope)
					: null,
		};
	}

	async observationAcceptedSourceEventIds(
		ids: readonly string[],
	): Promise<string[]> {
		if (!ids.length) return [];

		const result = await this.pool.query<{ id: string }>(
			`SELECT DISTINCT jsonb_array_elements_text(evidence_ids) AS id FROM proposals
       WHERE organization_id=$1 AND requested_by='observation-agent' AND state='auto_applied'
         AND evidence_ids ?| $2::text[]`,
			[this.organizationId, [...ids]],
		);

		return result.rows
			.map((row) => row.id)
			.filter((id) => ids.includes(id));
	}

	async completeObservationAgent(input: {
		runId: string;
		dispositionId: string;
		owner: string;
		writes: number;
	}): Promise<void> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const disposition = await client.query(
				"UPDATE observation_dispositions d SET state='processed',retryable=false,reason_code=$5,lease_owner=NULL,lease_until=NULL,finished_at=now() WHERE d.organization_id=$1 AND d.id=$2 AND d.lease_owner=$3 AND d.run_id=$4 AND d.state='processing' AND d.lease_until>now() AND EXISTS (SELECT 1 FROM source_events s WHERE s.organization_id=d.organization_id AND s.id=d.source_event_id AND s.content_state='active') RETURNING id",
				[
					this.organizationId,
					input.dispositionId,
					input.owner,
					input.runId,
					input.writes
						? "observation_agent_applied"
						: "observation_agent_no_change",
				],
			);

			if (!disposition.rows[0])
				throw new DomainError(
					"Observation completion lease or source is unavailable.",
					"CONFLICT",
				);

			const run = await client.query(
				"UPDATE interpretation_runs SET state='completed',output=$3::jsonb,error=NULL,completed_at=now() WHERE organization_id=$1 AND id=$2 AND state='running' AND content_state='active' RETURNING id",
				[
					this.organizationId,
					input.runId,
					JSON.stringify({
						workflow: "one-agent-per-observation",
						writes: input.writes,
					}),
				],
			);

			if (!run.rows[0])
				throw new DomainError(
					"Observation run is unavailable.",
					"CONFLICT",
				);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async getObservationAgentCheckpoint(
		runId: string,
	): Promise<
		import("../domain/evidence-store.js").ObservationAgentCheckpoint | null
	> {
		const result = await this.pool.query<{
			manifest_envelope: EncryptedPayload;
		}>(
			"SELECT manifest_envelope FROM interpretation_runs WHERE organization_id=$1 AND id=$2 AND content_state='active' AND state='running'",
			[this.organizationId, runId],
		);
		const envelope = result.rows[0]?.manifest_envelope;

		if (!envelope) return null;

		const manifest = this.cipher.decrypt(envelope) as unknown as {
			observationAgent?: import("../domain/evidence-store.js").ObservationAgentCheckpoint;
		};

		return manifest.observationAgent ?? null;
	}

	async saveObservationAgentCheckpoint(input: {
		runId: string;
		dispositionId: string;
		owner: string;
		checkpoint: import("../domain/evidence-store.js").ObservationAgentCheckpoint;
	}): Promise<void> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const lease = await client.query(
				"UPDATE observation_dispositions SET run_id=$4 WHERE organization_id=$1 AND id=$2 AND lease_owner=$3 AND state='processing' AND lease_until>now() RETURNING id",
				[
					this.organizationId,
					input.dispositionId,
					input.owner,
					input.runId,
				],
			);

			if (!lease.rows[0])
				throw new DomainError(
					"Observation lease is unavailable.",
					"CONFLICT",
				);

			const envelope = this.cipher.encrypt({
				workflow: "one-agent-per-observation",
				budgetId: input.checkpoint.budgetId,
				observationAgent: input.checkpoint,
			} as unknown as JsonValue);
			const run = await client.query(
				"UPDATE interpretation_runs SET manifest_envelope=$3::jsonb WHERE organization_id=$1 AND id=$2 AND state='running' AND content_state='active' RETURNING id",
				[this.organizationId, input.runId, JSON.stringify(envelope)],
			);

			if (!run.rows[0])
				throw new DomainError(
					"Observation run is unavailable.",
					"CONFLICT",
				);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async createV2Run(input: V2RunCreate): Promise<InterpretationRun> {
		await this.contentReady;

		const id = randomUUID();
		const envelope = this.cipher.encrypt({
			...(input.manifest as Record<string, JsonValue>),
			budgetId: input.budgetId,
		});
		const result = await this.pool.query<InterpretationRunRow>(
			`INSERT INTO interpretation_runs
        (id,organization_id,input_hash,model,state,event_ids,output,error,schema_version,pipeline_version,
         prompt_version,policy_version,config_hash,replay_mode,evaluation_clock,knowledge_cutoff,manifest_envelope)
       SELECT $1,$2,$3,$4,'running',$5::uuid[],NULL,NULL,2,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
       FROM inference_budgets b WHERE b.id=$14 AND b.organization_id=$2 AND b.state='active'
       RETURNING *`,
			[
				id,
				this.organizationId,
				input.inputHash,
				input.model,
				input.eventIds,
				input.pipelineVersion,
				input.promptVersion,
				input.policyVersion,
				input.configHash,
				input.replayMode,
				input.evaluationClock,
				input.knowledgeCutoff,
				JSON.stringify(envelope),
				input.budgetId,
			],
		);

		if (!result.rows[0])
			throw new DomainError(
				"Active inference budget was not found in this organization.",
				"INVALID",
			);
		return interpretationRunFromRow(result.rows[0]);
	}

	async claimObservation(input: {
		eventId: string;
		pipelineVersion: string;
		workerId: string;
		leaseSeconds: number;
		now: string;
		reopenNoClaim?: boolean;
	}): Promise<{
		kind: "claimed" | "duplicate" | "busy" | "terminal";
		disposition: ObservationDisposition;
	}> {
		if (
			!Number.isSafeInteger(input.leaseSeconds) ||
			input.leaseSeconds < 1 ||
			input.leaseSeconds > 3600 ||
			!input.pipelineVersion ||
			!input.workerId ||
			!Number.isFinite(Date.parse(input.now))
		) {
			throw new DomainError(
				"Invalid observation claim lease.",
				"INVALID",
			);
		}

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const eventResult = await client.query<SourceEventRow>(
				"SELECT * FROM source_events WHERE id=$1 AND organization_id=$2 AND content_state='active' FOR SHARE",
				[input.eventId, this.organizationId],
			);
			const event = eventResult.rows[0];

			if (!event)
				throw new DomainError(
					"Active source event was not found.",
					"NOT_FOUND",
				);

			const origin =
				event.origin_observation_key ??
				`unresolved-receipt:${event.id}`;

			await client.query(
				"SELECT pg_advisory_xact_lock(hashtext($1),hashtext($2))",
				[this.organizationId, origin],
			);

			const previousResult = await client.query<DispositionRow>(
				`SELECT * FROM observation_dispositions WHERE organization_id=$1 AND origin_observation_key=$2
           AND pipeline_version=$3 AND state<>'duplicate' ORDER BY attempt DESC,created_at DESC LIMIT 1 FOR UPDATE`,
				[this.organizationId, origin, input.pipelineVersion],
			);
			const previous = previousResult.rows[0];

			if (
				previous &&
				(previous.state === "pending" ||
					previous.state === "processing")
			) {
				if (
					previous.lease_until &&
					previous.lease_until.getTime() > Date.parse(input.now)
				) {
					await client.query("COMMIT");
					return {
						kind: "busy",
						disposition: dispositionFromRow(previous),
					};
				}

				const expired = await client.query<DispositionRow>(
					`UPDATE observation_dispositions SET state='failed',reason_code='lease_expired',retryable=$3,
            lease_owner=NULL,lease_until=NULL,finished_at=$2 WHERE id=$1 RETURNING *`,
					[previous.id, input.now, previous.attempt < 3],
				);

				if (previous.attempt >= 3) {
					await client.query("COMMIT");
					return {
						kind: "terminal",
						disposition: dispositionFromRow(expired.rows[0]!),
					};
				}
			} else if (
				previous &&
				previous.source_event_id === input.eventId &&
				!["failed", "partial", "unresolved"].includes(previous.state) &&
				!(
					previous.state === "no_claim" &&
					input.reopenNoClaim &&
					previous.attempt === 1
				)
			) {
				await client.query("COMMIT");
				return {
					kind: "terminal",
					disposition: dispositionFromRow(previous),
				};
			} else if (
				previous &&
				previous.source_event_id === input.eventId &&
				previous.attempt >= 3
			) {
				const exhausted = await client.query<DispositionRow>(
					`UPDATE observation_dispositions SET retryable=false
             WHERE id=$1 RETURNING *`,
					[previous.id],
				);

				await client.query("COMMIT");
				return {
					kind: "terminal",
					disposition: dispositionFromRow(exhausted.rows[0]!),
				};
			} else if (previous && previous.source_event_id !== input.eventId) {
				const duplicate = await client.query<DispositionRow>(
					`INSERT INTO observation_dispositions
            (id,organization_id,source_event_id,canonical_event_id,origin_observation_key,pipeline_version,
             attempt,state,reason_code,finished_at)
           VALUES ($1,$2,$3,$4,$5,$6,1,'duplicate','same_origin_version',$7)
           ON CONFLICT (organization_id,source_event_id,pipeline_version,attempt) DO UPDATE
             SET canonical_event_id=excluded.canonical_event_id RETURNING *`,
					[
						randomUUID(),
						this.organizationId,
						input.eventId,
						previous.source_event_id,
						origin,
						input.pipelineVersion,
						input.now,
					],
				);

				await client.query("COMMIT");
				return {
					kind: "duplicate",
					disposition: dispositionFromRow(duplicate.rows[0]!),
				};
			}

			const nextAttempt = await client.query<{ attempt: number }>(
				`SELECT COALESCE(max(attempt),0)+1 AS attempt FROM observation_dispositions
          WHERE organization_id=$1 AND source_event_id=$2 AND pipeline_version=$3`,
				[this.organizationId, input.eventId, input.pipelineVersion],
			);
			const leaseUntil = new Date(
				Date.parse(input.now) + input.leaseSeconds * 1000,
			).toISOString();
			const claimed = await client.query<DispositionRow>(
				`INSERT INTO observation_dispositions
          (id,organization_id,source_event_id,origin_observation_key,pipeline_version,attempt,state,
           lease_owner,lease_until)
         VALUES ($1,$2,$3,$4,$5,$6,'processing',$7,$8) RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.eventId,
					origin,
					input.pipelineVersion,
					nextAttempt.rows[0]!.attempt,
					input.workerId,
					leaseUntil,
				],
			);

			await client.query("COMMIT");
			return {
				kind: "claimed",
				disposition: dispositionFromRow(claimed.rows[0]!),
			};
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async getLatestObservationDisposition(
		eventId: string,
		pipelineVersion: string,
	): Promise<ObservationDisposition | null> {
		const result = await this.pool.query<DispositionRow>(
			`SELECT * FROM observation_dispositions WHERE organization_id=$1 AND source_event_id=$2
         AND pipeline_version=$3 ORDER BY attempt DESC,created_at DESC LIMIT 1`,
			[this.organizationId, eventId, pipelineVersion],
		);

		return result.rows[0] ? dispositionFromRow(result.rows[0]) : null;
	}

	async getEvidenceCoverage(pipelineVersion: string) {
		const coverage = emptyEvidenceCoverage(pipelineVersion);
		const result = await this.pool.query<{
			state: DispositionState | "unseen";
			count: string;
			retry_count: string;
			oldest_retry_at: Date | null;
		}>(
			`SELECT COALESCE(d.state,'unseen') AS state, count(*)::text AS count,
          count(*) FILTER (WHERE d.state IN ('failed','partial','unresolved')
            AND d.retryable AND d.attempt<3)::text AS retry_count,
          min(d.created_at) FILTER (WHERE d.state IN ('failed','partial','unresolved')
            AND d.retryable AND d.attempt<3) AS oldest_retry_at
         FROM source_events se LEFT JOIN LATERAL (
           SELECT state,retryable,attempt,created_at FROM observation_dispositions d
            WHERE d.organization_id=se.organization_id AND d.source_event_id=se.id
              AND d.pipeline_version=$2
            ORDER BY attempt DESC,created_at DESC LIMIT 1
         ) d ON true
        WHERE se.organization_id=$1 AND se.content_state='active'
          AND NOT EXISTS (SELECT 1 FROM source_events newer
            WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
              AND newer.installation_key=se.installation_key
              AND coalesce(newer.canonical_object_key,newer.source_ref)
                =coalesce(se.canonical_object_key,se.source_ref)
              AND (se.source_version_key IS NULL
                OR newer.source_version_key IS DISTINCT FROM se.source_version_key
                OR newer.content_state<>'active')
              AND (newer.occurred_at,newer.received_at,newer.id)
                >(se.occurred_at,se.received_at,se.id))
        GROUP BY COALESCE(d.state,'unseen')`,
			[this.organizationId, pipelineVersion],
		);

		for (const row of result.rows) {
			coverage.states[row.state] = Number(row.count);
			coverage.activeObservations += Number(row.count);
			coverage.retryBacklog += Number(row.retry_count);
			if (row.oldest_retry_at) {
				const at = row.oldest_retry_at.toISOString();

				if (!coverage.oldestRetryAt || at < coverage.oldestRetryAt)
					coverage.oldestRetryAt = at;
			}
		}

		const jobs = await this.pool.query<{
			pending: string;
			running: string;
			failed: string;
			oldest_pending_at: Date | null;
		}>(
			`SELECT count(*) FILTER (WHERE state='pending')::text AS pending,
          count(*) FILTER (WHERE state='running')::text AS running,
          count(*) FILTER (WHERE state='failed')::text AS failed,
          min(created_at) FILTER (WHERE state='pending') AS oldest_pending_at
         FROM outbox_jobs WHERE organization_id=$1 AND topic LIKE 'evidence.%'`,
			[this.organizationId],
		);

		coverage.evidenceJobs = {
			pending: Number(jobs.rows[0]?.pending ?? 0),
			running: Number(jobs.rows[0]?.running ?? 0),
			failed: Number(jobs.rows[0]?.failed ?? 0),
			oldestPendingAt:
				jobs.rows[0]?.oldest_pending_at?.toISOString() ?? null,
		};

		const outputs = await this.pool.query<{
			claims: string;
			assessments: string;
			pending: string;
			accepted: string;
		}>(
			`SELECT
         (SELECT count(*) FROM evidence_claims WHERE organization_id=$1 AND content_state='active')::text AS claims,
         (SELECT count(*) FROM evidence_assessments WHERE organization_id=$1 AND content_state='active')::text AS assessments,
         (SELECT count(*) FROM proposals WHERE organization_id=$1 AND assessment_id IS NOT NULL
            AND state IN ('pending','escalated'))::text AS pending,
         (SELECT count(*) FROM task_revisions WHERE organization_id=$1
            AND decision_metadata->>'assessmentId' IS NOT NULL)::text AS accepted`,
			[this.organizationId],
		);

		coverage.outputs = {
			savedClaims: Number(outputs.rows[0]?.claims ?? 0),
			savedAssessments: Number(outputs.rows[0]?.assessments ?? 0),
			pendingAssessedProposals: Number(outputs.rows[0]?.pending ?? 0),
			acceptedAssessedTaskRevisions: Number(
				outputs.rows[0]?.accepted ?? 0,
			),
		};
		return coverage;
	}

	async failObservationClaims(input: {
		leases: { dispositionId: string; attempt: number; owner: string }[];
		runId: string | null;
		reasonCode: string;
	}): Promise<void> {
		if (!input.reasonCode || input.reasonCode.length > 100)
			throw new DomainError("Invalid failure reason.", "INVALID");
		for (const lease of input.leases) {
			await this.pool.query(
				`UPDATE observation_dispositions SET state='failed',reason_code=$5,retryable=(attempt<3),run_id=$6,
           lease_owner=NULL,lease_until=NULL,finished_at=now()
         WHERE organization_id=$1 AND id=$2 AND attempt=$3 AND lease_owner=$4 AND state='processing'`,
				[
					this.organizationId,
					lease.dispositionId,
					lease.attempt,
					lease.owner,
					input.reasonCode,
					input.runId,
				],
			);
		}
	}

	async saveExtraction(input: SaveExtractionInput): Promise<{
		claims: EvidenceClaim[];
		dispositions: ObservationDisposition[];
	}> {
		if (input.dependencies.length > 0)
			throw new DomainError(
				"Additional dependencies are not supported yet.",
				"INVALID",
			);
		await this.contentReady;

		const pre = await this.pool.query<{ event_ids: string[] }>(
			"SELECT event_ids FROM interpretation_runs WHERE organization_id=$1 AND id=$2",
			[this.organizationId, input.runId],
		);

		if (!pre.rows[0])
			throw new DomainError("Extraction run was not found.", "NOT_FOUND");

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const sourcesAtCommit = await client.query<{ id: string }>(
				`SELECT id FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[])
           AND content_state='active' ORDER BY id FOR SHARE`,
				[this.organizationId, pre.rows[0].event_ids],
			);

			if (sourcesAtCommit.rows.length !== pre.rows[0].event_ids.length) {
				throw new DomainError(
					"Extraction input was revoked before commit.",
					"CONFLICT",
				);
			}

			const runResult = await client.query<InterpretationRunRow>(
				"SELECT * FROM interpretation_runs WHERE organization_id=$1 AND id=$2 AND schema_version=2 FOR UPDATE",
				[this.organizationId, input.runId],
			);
			const run = runResult.rows[0];

			if (
				!run ||
				run.content_state !== "active" ||
				run.state !== "running" ||
				run.input_hash !== input.inputHash
			) {
				throw new DomainError(
					"Extraction run is missing, stale, or has a different input hash.",
					"CONFLICT",
				);
			}

			const activeIds = new Set(run.event_ids);
			const reportedIds = new Set(
				input.dispositions.map((item) => item.eventId),
			);

			if (
				activeIds.size !== input.dispositions.length ||
				reportedIds.size !== activeIds.size ||
				[...activeIds].some((id) => !reportedIds.has(id))
			) {
				throw new DomainError(
					"Extraction is missing an active input disposition.",
					"INVALID",
				);
			}

			const existing = await client.query<EvidenceClaimRow>(
				"SELECT * FROM evidence_claims WHERE organization_id=$1 AND extraction_run_id=$2 ORDER BY ordinal",
				[this.organizationId, input.runId],
			);

			if (existing.rows.length > 0) {
				if (
					existing.rows.length !== input.claims.length ||
					existing.rows.some(
						(row, index) =>
							row.content_hash !==
							contentHash(input.claims[index]),
					)
				) {
					throw new DomainError(
						"A different extraction is already saved for this run.",
						"CONFLICT",
					);
				}

				const dispositions = await client.query<DispositionRow>(
					"SELECT * FROM observation_dispositions WHERE organization_id=$1 AND run_id=$2 ORDER BY source_event_id",
					[this.organizationId, input.runId],
				);

				await client.query("COMMIT");
				return {
					claims: existing.rows.map((row) =>
						claimFromRow(row, this.cipher),
					),
					dispositions: dispositions.rows.map(dispositionFromRow),
				};
			}
			if (input.claims.length === 0) {
				const prior = await client.query<DispositionRow>(
					"SELECT * FROM observation_dispositions WHERE organization_id=$1 AND run_id=$2 ORDER BY source_event_id",
					[this.organizationId, input.runId],
				);

				if (prior.rows.length > 0) {
					if (
						prior.rows.length !== input.dispositions.length ||
						prior.rows.some(
							(row) =>
								!input.dispositions.some(
									(item) =>
										item.eventId === row.source_event_id &&
										item.state === row.state &&
										item.reasonCode === row.reason_code,
								),
						)
					) {
						throw new DomainError(
							"A different extraction is already saved for this run.",
							"CONFLICT",
						);
					}
					await client.query("COMMIT");
					return {
						claims: [],
						dispositions: prior.rows.map(dispositionFromRow),
					};
				}
			}
			if (
				input.expectedLeases.length !== input.dispositions.length ||
				new Set(input.dispositions.map((item) => item.eventId)).size !==
					input.dispositions.length ||
				input.dispositions.some(
					(item) => !run.event_ids.includes(item.eventId),
				)
			) {
				throw new DomainError(
					"Extraction does not cover exactly its claimed active inputs.",
					"INVALID",
				);
			}

			const leases = await client.query<DispositionRow>(
				`SELECT * FROM observation_dispositions WHERE organization_id=$1 AND id=ANY($2::uuid[]) FOR UPDATE`,
				[
					this.organizationId,
					input.expectedLeases.map((lease) => lease.dispositionId),
				],
			);

			if (leases.rows.length !== input.expectedLeases.length)
				throw new DomainError(
					"Extraction lease is missing.",
					"CONFLICT",
				);

			const leaseById = new Map(leases.rows.map((row) => [row.id, row]));

			for (const lease of input.expectedLeases) {
				const current = leaseById.get(lease.dispositionId);

				if (
					!current ||
					current.state !== "processing" ||
					current.attempt !== lease.attempt ||
					current.lease_owner !== lease.owner ||
					!current.lease_until ||
					current.lease_until.getTime() <= Date.now()
				) {
					throw new DomainError(
						"Extraction lease expired or changed owner.",
						"CONFLICT",
					);
				}
			}

			const sourceIds = [
				...new Set(
					input.claims.flatMap((claim) =>
						claim.spans.map((span) => span.eventId),
					),
				),
			];
			const sourceRows =
				sourceIds.length === 0
					? []
					: (
							await client.query<SourceEventRow>(
								`SELECT se.*,sec.ciphertext,sec.iv,sec.auth_tag,sec.key_version
           FROM source_events se JOIN source_event_contents sec ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
          WHERE se.organization_id=$1 AND se.id=ANY($2::uuid[]) AND se.content_state='active' FOR SHARE OF se`,
								[this.organizationId, sourceIds],
							)
						).rows;
			const events = new Map(
				sourceRows.map((row) => [
					row.id,
					sourceEventFromRow(row, this.cipher),
				]),
			);

			if (events.size !== sourceIds.length)
				throw new DomainError(
					"Claim cites an unavailable source.",
					"INVALID",
				);
			for (const claim of input.claims) validateClaimBody(claim, events);

			const claims: EvidenceClaim[] = [];

			for (const [ordinal, body] of input.claims.entries()) {
				const envelope = this.cipher.encrypt(
					body as unknown as JsonValue,
				);
				const result = await client.query<EvidenceClaimRow>(
					`INSERT INTO evidence_claims
            (id,organization_id,extraction_run_id,episode_key,ordinal,kind,input_hash,content_hash,body_envelope)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) RETURNING *`,
					[
						randomUUID(),
						this.organizationId,
						input.runId,
						input.episodeKey,
						ordinal,
						body.kind,
						input.inputHash,
						contentHash(body),
						JSON.stringify(envelope),
					],
				);
				const row = result.rows[0]!;

				claims.push(claimFromRow(row, this.cipher));
				for (const span of body.spans) {
					const source = events.get(span.eventId)!;

					await client.query(
						`INSERT INTO evidence_dependencies
              (organization_id,dependent_type,dependent_id,field_key,source_event_id,
               origin_observation_key,source_version_key,source_authorization_version,relationship)
             VALUES ($1,'claim',$2,'$',$3,$4,$5,$6,'supports') ON CONFLICT DO NOTHING`,
						[
							this.organizationId,
							row.id,
							span.eventId,
							span.originObservationKey,
							span.sourceVersionKey,
							source.authorizationVersion ?? 1,
						],
					);
				}
			}

			const dispositions: ObservationDisposition[] = [];

			for (const item of input.dispositions) {
				const lease = leaseById.get(item.dispositionId);

				if (
					!lease ||
					lease.source_event_id !== item.eventId ||
					item.claimOrdinals.some(
						(ordinal) =>
							!Number.isSafeInteger(ordinal) ||
							ordinal < 0 ||
							ordinal >= claims.length,
					)
				) {
					throw new DomainError(
						"Extraction disposition does not match its lease or claim ordinals.",
						"INVALID",
					);
				}

				const claimIds = item.claimOrdinals.map(
					(ordinal) => claims[ordinal]!.id,
				);

				if (
					["extracted", "partial"].includes(item.state) &&
					claimIds.length === 0
				) {
					throw new DomainError(
						"Extracted disposition must reference a claim.",
						"INVALID",
					);
				}
				if (item.state === "no_claim" && !item.reasonCode) {
					throw new DomainError(
						"No-claim disposition needs a reason.",
						"INVALID",
					);
				}

				const updated = await client.query<DispositionRow>(
					`UPDATE observation_dispositions SET state=$2,claim_ids=$3::uuid[],reason_code=$4,
             retryable=$5,run_id=$6,lease_owner=NULL,lease_until=NULL,finished_at=now()
           WHERE id=$1 RETURNING *`,
					[
						item.dispositionId,
						item.state,
						claimIds,
						item.reasonCode,
						(item.state === "partial" ||
							item.state === "unresolved") &&
							lease.attempt < 3,
						input.runId,
					],
				);

				dispositions.push(dispositionFromRow(updated.rows[0]!));
			}
			await client.query("COMMIT");
			return { claims, dispositions };
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async getClaims(ids: readonly string[]): Promise<EvidenceClaim[]> {
		if (ids.length === 0) return [];

		const result = await this.pool.query<EvidenceClaimRow>(
			`SELECT c.* FROM evidence_claims c WHERE c.organization_id=$1
         AND c.id=ANY($2::uuid[]) AND c.content_state='active'
         AND NOT EXISTS (SELECT 1 FROM evidence_dependencies d JOIN source_events se
           ON se.organization_id=d.organization_id AND se.id=d.source_event_id
           WHERE d.organization_id=c.organization_id AND d.dependent_type='claim'
             AND d.dependent_id=c.id AND se.content_state<>'active')`,
			[this.organizationId, ids],
		);
		const byId = new Map(
			result.rows.map((row) => [row.id, claimFromRow(row, this.cipher)]),
		);

		return ids.flatMap((id) => byId.get(id) ?? []);
	}

	async listClaimsByRun(runId: string): Promise<EvidenceClaim[]> {
		const result = await this.pool.query<EvidenceClaimRow>(
			`SELECT c.* FROM evidence_claims c WHERE c.organization_id=$1 AND c.extraction_run_id=$2
         AND c.content_state='active'
         AND NOT EXISTS (SELECT 1 FROM evidence_dependencies d JOIN source_events se
           ON se.organization_id=d.organization_id AND se.id=d.source_event_id
           WHERE d.organization_id=c.organization_id AND d.dependent_type='claim'
             AND d.dependent_id=c.id AND se.content_state<>'active')
         ORDER BY c.ordinal,c.id`,
			[this.organizationId, runId],
		);

		return result.rows.map((row) => claimFromRow(row, this.cipher));
	}

	async listClaimsForTask(
		taskId: string,
		afterClaimId: string | null,
		limit: number,
	): Promise<EvidenceClaim[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError("Invalid task claim page size.", "INVALID");
		}

		const result = await this.pool.query<EvidenceClaimRow>(
			`SELECT c.* FROM evidence_claims c WHERE c.organization_id=$1 AND c.content_state='active'
         AND ($3::uuid IS NULL OR c.id>$3::uuid)
         AND EXISTS (SELECT 1 FROM evidence_assessments a WHERE a.organization_id=c.organization_id
           AND a.content_state='active' AND c.id=ANY(a.claim_ids)
           AND ((a.target_type='task' AND a.target_id=$2)
             OR (a.target_type='task_create' AND EXISTS (
               SELECT 1 FROM proposals p JOIN task_revisions r ON r.proposal_id=p.id
                WHERE p.organization_id=a.organization_id AND p.assessment_id=a.id
                  AND r.organization_id=a.organization_id AND r.task_id=$2))))
         AND NOT EXISTS (SELECT 1 FROM evidence_dependencies d JOIN source_events se
           ON se.organization_id=d.organization_id AND se.id=d.source_event_id
           WHERE d.organization_id=c.organization_id AND d.dependent_type='claim'
             AND d.dependent_id=c.id AND se.content_state<>'active')
         ORDER BY c.id LIMIT $4`,
			[this.organizationId, taskId, afterClaimId, limit],
		);

		return result.rows.map((row) => claimFromRow(row, this.cipher));
	}

	async listUnlinkedClaimsForTask(
		taskId: string,
		cursor: { createdAt: string; id: string } | null,
		after: string | null,
		through: string,
		limit: number,
	): Promise<EvidenceClaim[]> {
		if (
			!Number.isSafeInteger(limit) ||
			limit < 1 ||
			limit > 100 ||
			!Number.isFinite(Date.parse(through)) ||
			(after &&
				(!Number.isFinite(Date.parse(after)) || after > through)) ||
			(cursor &&
				(!Number.isFinite(Date.parse(cursor.createdAt)) ||
					!/^[0-9a-f-]{36}$/i.test(cursor.id)))
		) {
			throw new DomainError(
				"Invalid unlinked claim discovery cursor.",
				"INVALID",
			);
		}

		const result = await this.pool.query<EvidenceClaimRow>(
			`SELECT c.* FROM evidence_claims c WHERE c.organization_id=$1 AND c.content_state='active'
         AND c.created_at<=$4::timestamptz
         AND ($7::timestamptz IS NULL OR c.created_at >= $7::timestamptz)
         AND ($3::timestamptz IS NULL OR
           (date_trunc('milliseconds',c.created_at),c.id)>($3::timestamptz,$5::uuid))
         AND NOT EXISTS (SELECT 1 FROM evidence_assessments a
           WHERE a.organization_id=c.organization_id AND a.content_state='active'
             AND c.id=ANY(a.claim_ids) AND a.target_type='task' AND a.target_id=$2)
         AND NOT EXISTS (SELECT 1 FROM evidence_dependencies d JOIN source_events se
           ON se.organization_id=d.organization_id AND se.id=d.source_event_id
           WHERE d.organization_id=c.organization_id AND d.dependent_type='claim'
             AND d.dependent_id=c.id AND se.content_state<>'active')
         ORDER BY date_trunc('milliseconds',c.created_at),c.id LIMIT $6`,
			[
				this.organizationId,
				taskId,
				cursor?.createdAt ?? null,
				through,
				cursor?.id ?? null,
				limit,
				after,
			],
		);

		return result.rows.map((row) => claimFromRow(row, this.cipher));
	}

	async listAffectedTaskIdsBySource(
		eventId: string,
		afterTaskId: string | null,
		limit: number,
	): Promise<string[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError(
				"Invalid affected task page size.",
				"INVALID",
			);
		}

		const result = await this.pool.query<{ task_id: string }>(
			`SELECT DISTINCT affected.task_id FROM (
         SELECT a.target_id AS task_id FROM evidence_dependencies d
           JOIN evidence_assessments a ON a.organization_id=d.organization_id
             AND a.id=d.dependent_id AND a.target_type='task'
          WHERE d.organization_id=$1 AND d.source_event_id=$2 AND d.dependent_type='assessment'
         UNION
         SELECT r.task_id FROM evidence_dependencies d
           JOIN evidence_assessments a ON a.organization_id=d.organization_id
             AND a.id=d.dependent_id AND a.target_type='task_create'
           JOIN proposals p ON p.organization_id=a.organization_id AND p.assessment_id=a.id
           JOIN task_revisions r ON r.organization_id=p.organization_id AND r.proposal_id=p.id
          WHERE d.organization_id=$1 AND d.source_event_id=$2 AND d.dependent_type='assessment'
         UNION
         SELECT r.task_id FROM evidence_dependencies d
           JOIN task_revisions r ON r.organization_id=d.organization_id AND r.id=d.dependent_id
          WHERE d.organization_id=$1 AND d.source_event_id=$2 AND d.dependent_type='task_revision'
         UNION
         SELECT r.task_id FROM task_revisions r
           JOIN proposals p ON p.organization_id=r.organization_id AND p.id=r.proposal_id
          WHERE r.organization_id=$1 AND r.decision_metadata IS NULL AND p.evidence_ids ? $2::text
         UNION
         SELECT a.target_id AS task_id FROM model_calls mc
           JOIN evidence_assessments a ON a.organization_id=mc.organization_id AND a.run_id=mc.run_id
          WHERE mc.organization_id=$1 AND $2::uuid=ANY(mc.contextual_source_event_ids)
            AND a.target_type='task'
       ) affected WHERE affected.task_id IS NOT NULL
         AND ($3::uuid IS NULL OR affected.task_id>$3::uuid)
       ORDER BY affected.task_id LIMIT $4`,
			[this.organizationId, eventId, afterTaskId, limit],
		);

		return result.rows.map((row) => row.task_id);
	}

	async saveAssessment(
		input: Omit<EvidenceAssessment, "id" | "createdAt">,
		dependencies: readonly unknown[],
	): Promise<EvidenceAssessment> {
		if (dependencies.length > 0)
			throw new DomainError(
				"Additional assessment dependencies are not supported yet.",
				"INVALID",
			);
		if (
			input.claimIds.length === 0 ||
			new Set(input.claimIds).size !== input.claimIds.length ||
			!(
				(input.targetType === "task" &&
					input.targetId &&
					input.targetVersion &&
					input.body.kind === "task") ||
				(input.targetType === "task_create" &&
					!input.targetId &&
					!input.targetVersion &&
					input.contractVersion === null &&
					input.body.kind === "task" &&
					input.body.fields.length === 0) ||
				(input.targetType === "context_create" &&
					!input.targetId &&
					!input.targetVersion &&
					input.contractVersion === null &&
					input.body.kind === "context" &&
					input.body.fields.length === 0 &&
					input.body.criteria.length === 0) ||
				(input.targetType === "context" &&
					input.targetId &&
					input.targetVersion &&
					input.contractVersion === null &&
					input.body.kind === "context" &&
					input.body.fields.length === 0 &&
					input.body.criteria.length === 0)
			) ||
			input.body.relationship !== input.relationship
		) {
			throw new DomainError(
				"Assessment target or claim set is invalid.",
				"INVALID",
			);
		}

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const contextualSourceIds = (
				await client.query<{ id: string }>(
					`SELECT DISTINCT unnest(contextual_source_event_ids) AS id FROM model_calls
           WHERE organization_id=$1 AND run_id=$2 ORDER BY 1`,
					[this.organizationId, input.runId],
				)
			).rows.map((row) => row.id);

			if (
				!(await this.lockModelCallSources(
					client,
					input.runId,
					contextualSourceIds,
				))
			) {
				throw new DomainError(
					"Assessment model context was revoked or superseded.",
					"CONFLICT",
				);
			}

			const prior = await client.query<EvidenceAssessmentRow>(
				"SELECT * FROM evidence_assessments WHERE organization_id=$1 AND assessment_key=$2 FOR UPDATE",
				[this.organizationId, input.assessmentKey],
			);

			if (prior.rows[0]) {
				const existing = assessmentFromRow(prior.rows[0], this.cipher);

				if (
					contentHash({
						...existing,
						id: null,
						runId: null,
						createdAt: null,
					}) !==
					contentHash({
						...input,
						id: null,
						runId: null,
						createdAt: null,
					})
				) {
					throw new DomainError(
						"Assessment key already belongs to a different decision.",
						"CONFLICT",
					);
				}
				await client.query("COMMIT");
				return existing;
			}

			const run = await client.query<{
				id: string;
				replay_mode: string | null;
				knowledge_cutoff: Date | null;
			}>(
				"SELECT id,replay_mode,knowledge_cutoff FROM interpretation_runs WHERE organization_id=$1 AND id=$2 AND schema_version=2 AND content_state='active' FOR SHARE",
				[this.organizationId, input.runId],
			);

			if (!run.rows[0])
				throw new DomainError(
					"Assessment run was not found.",
					"NOT_FOUND",
				);

			const claimsResult = await client.query<EvidenceClaimRow>(
				`SELECT * FROM evidence_claims WHERE organization_id=$1 AND id=ANY($2::uuid[])
           AND content_state='active' FOR SHARE`,
				[this.organizationId, input.claimIds],
			);

			if (claimsResult.rows.length !== input.claimIds.length)
				throw new DomainError(
					"Assessment claim is unavailable.",
					"INVALID",
				);

			const claims = claimsResult.rows.map((row) =>
				claimFromRow(row, this.cipher),
			);
			const spans = claims.flatMap((claim) => claim.body.spans);
			const allowedSpans = new Set(
				spans.map((span) => contentHash(span)),
			);

			for (const field of input.body.fields) {
				if (
					field.operation.supportingClaimIds.some(
						(id) => !input.claimIds.includes(id),
					) ||
					field.support.some(
						(span) => !allowedSpans.has(contentHash(span)),
					) ||
					field.contradictions.some(
						(span) => !allowedSpans.has(contentHash(span)),
					)
				) {
					throw new DomainError(
						"Assessment field cites a claim or source outside its inputs.",
						"INVALID",
					);
				}
			}
			for (const criterion of input.body.criteria) {
				if (
					criterion.support.some(
						(span) => !allowedSpans.has(contentHash(span)),
					)
				) {
					throw new DomainError(
						"Assessment criterion cites a source outside its claims.",
						"INVALID",
					);
				}
			}

			const sourceIds = [
				...new Set(spans.map((span) => span.eventId)),
			].sort();
			const sources = await client.query<SourceEventRow>(
				`SELECT * FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[])
           AND content_state='active' ORDER BY id FOR SHARE`,
				[this.organizationId, sourceIds],
			);

			if (sources.rows.length !== sourceIds.length)
				throw new DomainError(
					"Assessment source was revoked.",
					"INVALID",
				);

			const sourceById = new Map(
				sources.rows.map((row) => [row.id, row]),
			);

			if (
				spans.some(
					(span) =>
						sourceById.get(span.eventId)?.origin_observation_key !==
							span.originObservationKey ||
						sourceById.get(span.eventId)?.source_version_key !==
							span.sourceVersionKey,
				)
			) {
				throw new DomainError(
					"Assessment source version changed.",
					"CONFLICT",
				);
			}
			if (input.targetType === "task") {
				const task = await client.query<TaskRow>(
					"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2 FOR SHARE",
					[this.organizationId, input.targetId],
				);
				const cutoff = run.rows[0]?.knowledge_cutoff;
				const historicalRun = Boolean(
					cutoff &&
					[
						"source_reinterpret",
						"cached_reassess",
						"historical_eval",
					].includes(run.rows[0]?.replay_mode ?? ""),
				);
				let target =
					!historicalRun &&
					task.rows[0] &&
					String(task.rows[0].version) === input.targetVersion
						? taskFromRow(task.rows[0])
						: null;

				if (historicalRun) {
					const historical = await client.query<{ current: Task }>(
						`SELECT current FROM task_revisions WHERE organization_id=$1 AND task_id=$2
               AND version=$3 AND applied_at <= $4 ORDER BY applied_at DESC LIMIT 1`,
						[
							this.organizationId,
							input.targetId,
							Number(input.targetVersion),
							cutoff,
						],
					);

					target = historical.rows[0]?.current ?? null;
				}
				if (!target)
					throw new DomainError(
						"Assessment target version changed.",
						"CONFLICT",
					);

				const contract = target.outcomeContract;

				if (
					input.contractVersion !== (contract?.version ?? null) ||
					input.body.criteria.some(
						(item) =>
							!contract?.criteria.some(
								(criterion) =>
									criterion.id === item.criterionId,
							),
					)
				) {
					throw new DomainError(
						"Assessment criterion or contract version is invalid.",
						"INVALID",
					);
				}
			} else if (input.targetType === "context") {
				const target = await client.query<ContextEntryRow>(
					"SELECT * FROM context_entries WHERE organization_id=$1 AND id=$2 FOR SHARE",
					[this.organizationId, input.targetId],
				);
				const cutoff = run.rows[0]?.knowledge_cutoff;
				const historical = cutoff
					? await client.query<{ current: ContextEntry }>(
							`SELECT current FROM context_revisions WHERE organization_id=$1 AND context_entry_id=$2
             AND applied_at<=$3 ORDER BY version DESC LIMIT 1`,
							[this.organizationId, input.targetId, cutoff],
						)
					: null;
				const entry = cutoff
					? historical?.rows[0]?.current
					: target.rows[0]
						? contextEntryFromRow(target.rows[0])
						: null;

				if (
					!entry ||
					entry.kind !== "fact" ||
					contentHash(entry) !== input.targetVersion
				) {
					throw new DomainError(
						"Assessment context target changed.",
						"CONFLICT",
					);
				}
			} else if (input.body.criteria.length > 0) {
				throw new DomainError(
					"Creation cannot assess an unaccepted contract.",
					"INVALID",
				);
			}

			const envelope = this.cipher.encrypt(
				input.body as unknown as JsonValue,
			);
			const inserted = await client.query<EvidenceAssessmentRow>(
				`INSERT INTO evidence_assessments
          (id,organization_id,run_id,assessment_key,target_type,target_id,target_version,contract_version,
           claim_ids,evidence_fingerprint,permission_fingerprint,policy_version,model_version,
           relationship,disposition,reason_codes,body_envelope)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::uuid[],$10,$11,$12,$13,$14,$15,$16,$17::jsonb)
         RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.runId,
					input.assessmentKey,
					input.targetType,
					input.targetId,
					input.targetVersion,
					input.contractVersion,
					input.claimIds,
					input.evidenceFingerprint,
					input.permissionFingerprint,
					input.policyVersion,
					input.modelVersion,
					input.relationship,
					input.disposition,
					input.reasonCodes,
					JSON.stringify(envelope),
				],
			);
			const assessment = assessmentFromRow(
				inserted.rows[0]!,
				this.cipher,
			);

			for (const span of spans) {
				const source = sourceById.get(span.eventId)!;

				await client.query(
					`INSERT INTO evidence_dependencies
            (organization_id,dependent_type,dependent_id,field_key,source_event_id,
             origin_observation_key,source_version_key,source_authorization_version,relationship)
           VALUES ($1,'assessment',$2,'$',$3,$4,$5,$6,'supports') ON CONFLICT DO NOTHING`,
					[
						this.organizationId,
						assessment.id,
						span.eventId,
						span.originObservationKey,
						span.sourceVersionKey,
						source.authorization_version ?? 1,
					],
				);
			}
			await client.query("COMMIT");
			return assessment;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async getAssessment(id: string): Promise<EvidenceAssessment | null> {
		const result = await this.pool.query<EvidenceAssessmentRow>(
			`SELECT a.* FROM evidence_assessments a WHERE a.organization_id=$1 AND a.id=$2
         AND a.content_state='active'
         AND NOT EXISTS (SELECT 1 FROM evidence_dependencies d JOIN source_events se
           ON se.organization_id=d.organization_id AND se.id=d.source_event_id
           WHERE d.organization_id=a.organization_id AND d.dependent_type='assessment'
             AND d.dependent_id=a.id AND se.content_state<>'active')`,
			[this.organizationId, id],
		);

		return result.rows[0]
			? assessmentFromRow(result.rows[0], this.cipher)
			: null;
	}

	async listAssessmentsForTask(
		taskId: string,
		limit: number,
	): Promise<EvidenceAssessment[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError(
				"Invalid task assessment page size.",
				"INVALID",
			);
		}

		const result = await this.pool.query<EvidenceAssessmentRow>(
			`SELECT a.* FROM evidence_assessments a WHERE a.organization_id=$1
         AND a.target_type='task' AND a.target_id=$2 AND a.content_state='active'
         AND NOT EXISTS (SELECT 1 FROM evidence_dependencies d JOIN source_events se
           ON se.organization_id=d.organization_id AND se.id=d.source_event_id
           WHERE d.organization_id=a.organization_id AND d.dependent_type='assessment'
             AND d.dependent_id=a.id AND se.content_state<>'active')
         ORDER BY a.created_at DESC,a.id DESC LIMIT $3`,
			[this.organizationId, taskId, limit],
		);

		return result.rows.map((row) => assessmentFromRow(row, this.cipher));
	}

	async listModelCallContextSourceIds(runId: string): Promise<string[]> {
		const result = await this.pool.query<{ id: string }>(
			`SELECT DISTINCT unnest(contextual_source_event_ids) AS id FROM model_calls
         WHERE organization_id=$1 AND run_id=$2 ORDER BY 1`,
			[this.organizationId, runId],
		);

		return result.rows.map((row) => row.id);
	}

	async createInterpretationRun(
		input: NewInterpretationRun,
	): Promise<InterpretationRun> {
		const result = await this.pool.query<InterpretationRunRow>(
			`INSERT INTO interpretation_runs
        (id, organization_id, input_hash, model, state, event_ids, output, error, created_at, completed_at)
       VALUES ($1,$2,$3,$4,'running',$5::uuid[],NULL,NULL,now(),NULL)
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.inputHash,
				input.model,
				input.eventIds,
			],
		);

		return interpretationRunFromRow(result.rows[0]!);
	}

	async completeInterpretationRun(
		id: string,
		output: JsonValue,
	): Promise<InterpretationRun> {
		const result = await this.pool.query<InterpretationRunRow>(
			`UPDATE interpretation_runs
          SET state='completed', output=$2::jsonb, error=NULL, completed_at=now()
        WHERE id=$1 AND organization_id=$3 AND state='running' AND content_state='active'
        RETURNING *`,
			[id, JSON.stringify(output), this.organizationId],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Interpretation run ${id} is not running.`,
				"CONFLICT",
			);
		return interpretationRunFromRow(result.rows[0]);
	}

	async failInterpretationRun(
		id: string,
		error: string,
	): Promise<InterpretationRun> {
		const result = await this.pool.query<InterpretationRunRow>(
			`UPDATE interpretation_runs
          SET state='failed', error=$2, completed_at=now()
        WHERE id=$1 AND organization_id=$3 AND state='running' AND content_state='active'
        RETURNING *`,
			[id, error.slice(0, 4_000), this.organizationId],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Interpretation run ${id} is not running.`,
				"CONFLICT",
			);
		return interpretationRunFromRow(result.rows[0]);
	}

	async getInterpretationRun(id: string): Promise<InterpretationRun | null> {
		const result = await this.pool.query<InterpretationRunRow>(
			"SELECT * FROM interpretation_runs WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? interpretationRunFromRow(result.rows[0]) : null;
	}

	async listInterpretationRuns(limit: number): Promise<InterpretationRun[]> {
		const result = await this.pool.query<InterpretationRunRow>(
			"SELECT * FROM interpretation_runs WHERE organization_id=$1 ORDER BY created_at DESC LIMIT $2",
			[this.organizationId, limit],
		);

		return result.rows.map(interpretationRunFromRow);
	}

	async upsertContextEntry(input: NewContextEntry): Promise<ContextEntry> {
		const result = await this.pool.query<ContextEntryRow>(
			`INSERT INTO context_entries
        (id, organization_id, kind, source_event_id, source_ref, path, title, body, fact_type, fact_value,
         source_url, content_hash, evidence_ids, lifecycle_state, effective_from, effective_to, links, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::uuid[],$14,$15,$16,$17::jsonb,now())
       ON CONFLICT (organization_id, source_ref) DO UPDATE SET
        kind=excluded.kind, source_event_id=excluded.source_event_id, path=excluded.path,
        title=excluded.title, body=excluded.body, fact_type=excluded.fact_type,
        fact_value=excluded.fact_value, source_url=excluded.source_url,
        content_hash=excluded.content_hash, evidence_ids=excluded.evidence_ids,
        lifecycle_state=excluded.lifecycle_state, effective_from=excluded.effective_from,
        effective_to=excluded.effective_to, links=excluded.links, updated_at=now()
       RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.kind,
				input.sourceEventId,
				input.sourceRef,
				input.path,
				input.title,
				input.kind === "file" ? input.body : null,
				input.kind === "fact" ? input.factType : null,
				input.kind === "fact" ? JSON.stringify(input.value) : null,
				input.sourceUrl,
				input.contentHash,
				input.evidenceIds,
				input.lifecycleState,
				input.effectiveFrom,
				input.effectiveTo,
				JSON.stringify(input.links),
			],
		);

		return contextEntryFromRow(result.rows[0]!);
	}

	async getContextEntry(id: string): Promise<ContextEntry | null> {
		const result = await this.pool.query<ContextEntryRow>(
			`SELECT ce.* FROM context_entries ce
        JOIN source_events se ON se.id=ce.source_event_id
       WHERE ce.organization_id=$1 AND ce.id=$2 AND se.content_state='active'
         AND NOT EXISTS (SELECT 1 FROM unnest(ce.evidence_ids) support_id
           LEFT JOIN source_events sx ON sx.organization_id=ce.organization_id AND sx.id=support_id
           WHERE sx.id IS NULL OR sx.content_state<>'active')`,
			[this.organizationId, id],
		);

		return result.rows[0] ? contextEntryFromRow(result.rows[0]) : null;
	}

	async getContextEntryRefreshTarget(
		id: string,
	): Promise<Pick<
		ContextEntry,
		"id" | "kind" | "sourceRef" | "path" | "evidenceIds"
	> | null> {
		const result = await this.pool.query<
			Pick<
				ContextEntryRow,
				"id" | "kind" | "source_ref" | "path" | "evidence_ids"
			>
		>(
			`SELECT id,kind,source_ref,path,evidence_ids FROM context_entries
        WHERE organization_id=$1 AND id=$2`,
			[this.organizationId, id],
		);
		const row = result.rows[0];

		return row
			? {
					id: row.id,
					kind: row.kind,
					sourceRef: row.source_ref,
					path: row.path,
					evidenceIds: row.evidence_ids,
				}
			: null;
	}

	async listContextEntries(): Promise<ContextEntry[]> {
		const result = await this.pool.query<ContextEntryRow>(
			`SELECT ce.* FROM context_entries ce
        JOIN source_events se ON se.id=ce.source_event_id
       WHERE ce.organization_id=$1 AND se.content_state='active'
         AND NOT EXISTS (SELECT 1 FROM unnest(ce.evidence_ids) support_id
           LEFT JOIN source_events sx ON sx.organization_id=ce.organization_id AND sx.id=support_id
           WHERE sx.id IS NULL OR sx.content_state<>'active')
       ORDER BY ce.path`,
			[this.organizationId],
		);

		return result.rows.map(contextEntryFromRow);
	}

	async listContextRevisions(
		contextEntryId?: string,
	): Promise<ContextRevision[]> {
		const result = contextEntryId
			? await this.pool.query<ContextRevisionRow>(
					"SELECT * FROM context_revisions WHERE organization_id=$1 AND context_entry_id=$2 ORDER BY version",
					[this.organizationId, contextEntryId],
				)
			: await this.pool.query<ContextRevisionRow>(
					"SELECT * FROM context_revisions WHERE organization_id=$1 ORDER BY applied_at, context_entry_id, version",
					[this.organizationId],
				);

		return result.rows.map(contextRevisionFromRow);
	}

	async getContextRevisionByProposal(
		proposalId: string,
	): Promise<ContextRevision | null> {
		const result = await this.pool.query<ContextRevisionRow>(
			"SELECT * FROM context_revisions WHERE organization_id=$1 AND proposal_id=$2 LIMIT 1",
			[this.organizationId, proposalId],
		);

		return result.rows[0] ? contextRevisionFromRow(result.rows[0]) : null;
	}

	async searchContextEntries(
		query: string,
		limit: number,
	): Promise<ContextEntry[]> {
		const searchTerms = [
			...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []),
		]
			.filter((term) => term.length > 1)
			.slice(0, 32);

		if (searchTerms.length === 0)
			return (await this.listContextEntries()).slice(0, limit);

		const result = await this.pool.query<ContextEntryRow>(
			`WITH candidates AS (
         SELECT ce.*,
                to_tsvector(
                  'simple',
                  ce.path || ' ' || ce.title || ' ' || coalesce(ce.body, '') || ' ' ||
                  coalesce(ce.fact_type, '') || ' ' || coalesce(ce.fact_value::text, '')
                ) AS document
         FROM context_entries ce
         JOIN source_events se ON se.id=ce.source_event_id
        WHERE ce.organization_id=$1 AND se.content_state='active'
          AND NOT EXISTS (SELECT 1 FROM unnest(ce.evidence_ids) support_id
            LEFT JOIN source_events sx ON sx.organization_id=ce.organization_id AND sx.id=support_id
            WHERE sx.id IS NULL OR sx.content_state<>'active')
       )
       SELECT id, kind, source_event_id, source_ref, path, title, body, fact_type, fact_value,
              source_url, content_hash, evidence_ids, lifecycle_state, effective_from, effective_to, links, updated_at
         FROM candidates
        WHERE EXISTS (
          SELECT 1 FROM unnest($2::text[]) AS term
           WHERE document @@ plainto_tsquery('simple', term)
        )
        ORDER BY (
          SELECT count(*) FROM unnest($2::text[]) AS term
           WHERE document @@ plainto_tsquery('simple', term)
        ) DESC, updated_at DESC
        LIMIT $3`,
			[this.organizationId, searchTerms, limit],
		);

		return result.rows.map(contextEntryFromRow);
	}

	async createProposal(input: NewProposal): Promise<Proposal> {
		try {
			const result = await this.pool.query<ProposalRow>(
				`INSERT INTO proposals
          (id, organization_id, client_event_id, kind, task_id, base_version, state, changes, rationale,
           requested_by, evidence_ids, assessment_id, application_key, decision_metadata, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,$8,$9,$10::jsonb,$11,$12,$13::jsonb,now())
         ON CONFLICT (organization_id, application_key) WHERE application_key IS NOT NULL DO NOTHING
         RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.clientEventId ?? null,
					input.kind,
					input.taskId,
					input.baseVersion,
					JSON.stringify(input.changes),
					input.rationale,
					input.requestedBy,
					JSON.stringify(input.evidenceIds),
					input.assessmentId ?? null,
					input.applicationKey ?? null,
					input.decisionMetadata
						? JSON.stringify(input.decisionMetadata)
						: null,
				],
			);

			if (result.rows[0]) return proposalFromRow(result.rows[0]);
			if (input.applicationKey) {
				const existing = await this.pool.query<ProposalRow>(
					"SELECT * FROM proposals WHERE organization_id=$1 AND application_key=$2",
					[this.organizationId, input.applicationKey],
				);
				const row = existing.rows[0];

				if (
					row &&
					row.assessment_id === (input.assessmentId ?? null) &&
					row.task_id === input.taskId &&
					row.base_version === input.baseVersion &&
					contentHash(row.changes) === contentHash(input.changes) &&
					contentHash(row.evidence_ids) ===
						contentHash(input.evidenceIds)
				)
					return proposalFromRow(row);
				throw new DomainError(
					"Application key belongs to a different proposal.",
					"CONFLICT",
				);
			}
			throw new DomainError("Proposal could not be created.", "CONFLICT");
		} catch (error) {
			if (
				(error as { code?: string }).code === "23505" &&
				input.clientEventId
			) {
				const existing = await this.findProposalByClientEvent(
					input.requestedBy,
					input.clientEventId,
				);

				if (existing) return existing;
			}
			throw error;
		}
	}

	async getProposal(id: string): Promise<Proposal | null> {
		const result = await this.pool.query<ProposalRow>(
			"SELECT * FROM proposals WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? proposalFromRow(result.rows[0]) : null;
	}

	async findProposalByClientEvent(
		requestedBy: string,
		clientEventId: string,
	): Promise<Proposal | null> {
		const result = await this.pool.query<ProposalRow>(
			"SELECT * FROM proposals WHERE organization_id=$1 AND requested_by=$2 AND client_event_id=$3 LIMIT 1",
			[this.organizationId, requestedBy, clientEventId],
		);

		return result.rows[0] ? proposalFromRow(result.rows[0]) : null;
	}

	async listProposals(state?: ProposalState): Promise<Proposal[]> {
		const result = state
			? await this.pool.query<ProposalRow>(
					"SELECT * FROM proposals WHERE organization_id=$1 AND state=$2 ORDER BY created_at DESC",
					[this.organizationId, state],
				)
			: await this.pool.query<ProposalRow>(
					"SELECT * FROM proposals WHERE organization_id=$1 ORDER BY created_at DESC",
					[this.organizationId],
				);

		return result.rows.map(proposalFromRow);
	}

	async findOpenProposal(
		taskId: string | null,
		changes: ProposalChanges,
	): Promise<Proposal | null> {
		const result = await this.pool.query<ProposalRow>(
			"SELECT * FROM proposals WHERE organization_id=$1 AND state IN ('pending','escalated') AND task_id IS NOT DISTINCT FROM $2 AND changes=$3::jsonb ORDER BY created_at DESC LIMIT 1",
			[this.organizationId, taskId, JSON.stringify(changes)],
		);

		return result.rows[0] ? proposalFromRow(result.rows[0]) : null;
	}

	async replaceProposal(input: ReplaceProposalInput): Promise<Proposal> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const originalResult = await client.query<ProposalRow>(
				"SELECT * FROM proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, input.proposalId],
			);

			if (!originalResult.rows[0])
				throw new DomainError(
					`Proposal ${input.proposalId} does not exist.`,
					"NOT_FOUND",
				);

			const original = proposalFromRow(originalResult.rows[0]);

			if (!isOpenProposalState(original.state)) {
				throw new DomainError(
					`Proposal ${original.id} is already ${original.state}.`,
					"CONFLICT",
				);
			}

			const now = new Date().toISOString();
			const replacementResult = await client.query<ProposalRow>(
				`INSERT INTO proposals
          (id, organization_id, client_event_id, kind, task_id, base_version, state, changes, rationale, requested_by, evidence_ids, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,'pending',$7::jsonb,$8,$9,$10::jsonb,$11) RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.replacement.clientEventId ?? null,
					input.replacement.kind,
					input.replacement.taskId,
					input.replacement.baseVersion,
					JSON.stringify(input.replacement.changes),
					input.replacement.rationale,
					input.replacement.requestedBy,
					JSON.stringify(input.replacement.evidenceIds),
					now,
				],
			);
			const replacement = proposalFromRow(replacementResult.rows[0]!);

			await client.query(
				`UPDATE proposals SET state='superseded', decided_at=$3, decided_by=$4, decision_note=$5
          WHERE organization_id=$1 AND id=$2`,
				[
					this.organizationId,
					original.id,
					now,
					input.decidedBy,
					input.decisionNote,
				],
			);
			await this.insertDecisionEffects(client, {
				proposalId: original.id,
				actor: input.decidedBy,
				action: input.auditAction,
				details: { replacementProposalId: replacement.id },
				topic: "proposal.decided",
				dedupeKey: `proposal-decision:${original.id}:superseded`,
				payload: { proposalId: original.id, state: "superseded" },
				occurredAt: now,
			});
			await client.query("COMMIT");
			return replacement;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async decideProposal(
		id: string,
		decision: DecideProposalInput,
	): Promise<Proposal> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const current = await client.query<ProposalRow>(
				"SELECT * FROM proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, id],
			);

			if (!current.rows[0])
				throw new DomainError(
					`Proposal ${id} does not exist.`,
					"NOT_FOUND",
				);

			const proposal = proposalFromRow(current.rows[0]);

			if (!isOpenProposalState(proposal.state)) {
				throw new DomainError(
					`Proposal ${id} is already ${proposal.state}.`,
					"CONFLICT",
				);
			}

			const now = new Date().toISOString();
			const result = await client.query<ProposalRow>(
				`UPDATE proposals SET state=$3, decided_at=$4, decided_by=$5, decision_note=$6
          WHERE organization_id=$1 AND id=$2 RETURNING *`,
				[
					this.organizationId,
					id,
					decision.state,
					now,
					decision.decidedBy,
					decision.decisionNote,
				],
			);

			await this.insertDecisionEffects(client, {
				proposalId: id,
				actor: decision.decidedBy,
				action: decision.auditAction,
				details: decision.auditDetails ?? {},
				topic: "proposal.decided",
				dedupeKey: `proposal-decision:${id}:${decision.state}`,
				payload: { proposalId: id, state: decision.state },
				occurredAt: now,
			});
			await client.query("COMMIT");
			return proposalFromRow(result.rows[0]!);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async assertOrderedAssessedSourceVersions(
		client: PoolClient,
		cited: SourceEventRow[],
	): Promise<void> {
		const keys = [
			...new Set(
				cited
					.map((source) => source.canonical_object_key)
					.filter((key): key is string => Boolean(key)),
			),
		].sort();

		if (
			cited.some(
				(source) =>
					!source.canonical_object_key || !source.source_version_key,
			)
		) {
			throw new DomainError(
				"Assessed source identity is unavailable.",
				"CONFLICT",
			);
		}
		for (const key of keys) {
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1,0))",
				[`${this.organizationId}:source:${key}`],
			);
		}
		for (const key of keys) {
			const result = await client.query<SourceEventRow>(
				`SELECT * FROM source_events WHERE organization_id=$1 AND canonical_object_key=$2
           ORDER BY id LIMIT 101 FOR SHARE`,
				[this.organizationId, key],
			);
			const versions = result.rows;

			if (versions.length > 100) {
				throw new DomainError(
					"Assessed source version history exceeds the review bound.",
					"CONFLICT",
				);
			}

			const byId = new Map(versions.map((source) => [source.id, source]));
			const citedForKey = cited.filter(
				(source) => source.canonical_object_key === key,
			);
			const citedVersions = new Set(
				citedForKey.map((source) => source.source_version_key),
			);

			if (
				citedVersions.size !== 1 ||
				citedForKey.some(
					(source) => source.content_state !== "active",
				) ||
				versions.some(
					(source) =>
						source.source_version_key ===
							citedForKey[0]!.source_version_key &&
						source.content_state !== "active",
				)
			) {
				throw new DomainError(
					"Assessed source version is unavailable or ambiguous.",
					"CONFLICT",
				);
			}

			const reached = new Set<string>();

			for (const start of versions.filter(
				(source) =>
					source.source_version_key ===
					citedForKey[0]!.source_version_key,
			)) {
				let cursor: SourceEventRow | undefined = start;
				const seen = new Set<string>();

				while (cursor && !seen.has(cursor.id)) {
					seen.add(cursor.id);
					if (cursor.source_version_key)
						reached.add(cursor.source_version_key);
					cursor = cursor.supersedes_event_id
						? byId.get(cursor.supersedes_event_id)
						: undefined;
				}
			}
			if (
				versions.some(
					(source) =>
						!source.source_version_key ||
						!reached.has(source.source_version_key),
				)
			) {
				throw new DomainError(
					"Assessed source version order is unverified.",
					"CONFLICT",
				);
			}
		}
	}

	async approveAndApplyProposal(
		input: ApproveAndApplyProposalInput,
	): Promise<TaskRevision> {
		const client = await this.pool.connect();

		try {
			const pre = await client.query<ProposalRow>(
				"SELECT assessment_id,evidence_ids FROM proposals WHERE organization_id=$1 AND id=$2",
				[this.organizationId, input.proposalId],
			);
			const sourceIds = pre.rows[0]
				? [...new Set(pre.rows[0].evidence_ids)].sort()
				: [];

			await client.query("BEGIN");
			if (pre.rows[0]?.assessment_id) {
				const assessmentRun = (
					await client.query<{ run_id: string }>(
						`SELECT run_id FROM evidence_assessments WHERE organization_id=$1 AND id=$2
             AND content_state='active'`,
						[this.organizationId, pre.rows[0].assessment_id],
					)
				).rows[0];

				if (!assessmentRun)
					throw new DomainError(
						"Assessed proposal is no longer available.",
						"CONFLICT",
					);

				const contextual = (
					await client.query<{ id: string }>(
						`SELECT DISTINCT unnest(contextual_source_event_ids) AS id FROM model_calls
             WHERE organization_id=$1 AND run_id=$2 ORDER BY 1`,
						[this.organizationId, assessmentRun.run_id],
					)
				).rows.map((row) => row.id);
				const runSources =
					(
						await client.query<{ event_ids: string[] }>(
							"SELECT event_ids FROM interpretation_runs WHERE organization_id=$1 AND id=$2",
							[this.organizationId, assessmentRun.run_id],
						)
					).rows[0]?.event_ids ?? [];

				await this.lockSourceObjectKeys(
					client,
					[
						...new Set([
							...sourceIds,
							...runSources,
							...contextual,
						]),
					].sort(),
				);
				if (
					!(await this.lockModelCallSources(
						client,
						assessmentRun.run_id,
						contextual,
					))
				) {
					throw new DomainError(
						"Assessed model context changed before approval.",
						"CONFLICT",
					);
				}
			}

			const lockedSources =
				sourceIds.length === 0
					? []
					: (
							await client.query<SourceEventRow>(
								`SELECT * FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[])
           AND content_state='active' ORDER BY id FOR SHARE`,
								[this.organizationId, sourceIds],
							)
						).rows;

			if (
				sourceIds.length > 0 &&
				lockedSources.length !== sourceIds.length
			) {
				throw new DomainError(
					"Proposal source evidence was revoked.",
					"CONFLICT",
				);
			}
			if (pre.rows[0]?.assessment_id && sourceIds.length > 0) {
				await this.assertOrderedAssessedSourceVersions(
					client,
					lockedSources,
				);
			}

			const proposalResult = await client.query<ProposalRow>(
				"SELECT * FROM proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, input.proposalId],
			);
			const row = proposalResult.rows[0];

			if (!row)
				throw new DomainError(
					`Proposal ${input.proposalId} does not exist.`,
					"NOT_FOUND",
				);

			const proposal = proposalFromRow(row);

			if (
				proposal.assessmentId &&
				(sourceIds.length === 0 ||
					contentHash(sourceIds) !==
						contentHash([...new Set(proposal.evidenceIds)].sort()))
			) {
				throw new DomainError(
					"Assessed proposal evidence changed before approval.",
					"CONFLICT",
				);
			}
			if (!isOpenProposalState(proposal.state)) {
				if (
					proposal.state === input.state &&
					proposal.decidedBy === input.decidedBy &&
					proposal.decisionNote === input.decisionNote
				) {
					const existing = await client.query<{
						id: string;
						task_id: string;
						version: number;
						proposal_id: string;
						previous: Task | null;
						current: Task;
						applied_at: Date;
						applied_by: string;
						decision_metadata:
							| import("../domain/evidence-types.js").DecisionMetadata
							| null;
					}>(
						"SELECT * FROM task_revisions WHERE organization_id=$1 AND proposal_id=$2 LIMIT 1",
						[this.organizationId, proposal.id],
					);
					const revision = existing.rows[0];

					if (revision) {
						await client.query("COMMIT");
						return {
							id: revision.id,
							taskId: revision.task_id,
							version: revision.version,
							proposalId: revision.proposal_id,
							previous: revision.previous,
							current: revision.current,
							appliedAt: iso(revision.applied_at),
							appliedBy: revision.applied_by,
							decisionMetadata: revision.decision_metadata,
						};
					}
				}
				throw new DomainError(
					`Proposal ${proposal.id} is already ${proposal.state}.`,
					"CONFLICT",
				);
			}
			if (input.state === "auto_applied" && !input.observationEventId) {
				const guard = await client.query<{ tripped: boolean }>(
					`SELECT EXISTS (
             SELECT 1 FROM outbox_jobs WHERE organization_id=$1 AND state='failed'
               AND topic LIKE 'evidence.%'
             UNION ALL
             SELECT 1 FROM proposals p JOIN evidence_assessments ea
               ON ea.organization_id=p.organization_id AND ea.id=p.assessment_id
              WHERE p.organization_id=$1 AND p.state='rejected'
                AND ea.reason_codes @> ARRAY['authorized_attestation']::text[]
           ) AS tripped`,
					[this.organizationId],
				);

				if (guard.rows[0]?.tripped) {
					throw new DomainError(
						"Automatic evidence application is disabled by an operational failure or rejected attestation.",
						"CONFLICT",
					);
				}
			}
			if (isContextProposal(proposal)) {
				throw new DomainError(
					"Context proposals require context approval.",
					"INVALID",
				);
			}

			const now = new Date().toISOString();
			const observation = input.observationEventId
				? lockedSources.find(
						(source) => source.id === input.observationEventId,
					)
				: null;

			if (
				input.observationEventId &&
				(!observation ||
					proposal.assessmentId ||
					proposal.requestedBy !== "observation-agent")
			) {
				throw new DomainError(
					"Invalid observation agent receipt.",
					"INVALID",
				);
			}

			const governed = observation
				? await this.governedWorkObservation(client, observation.id)
				: false;

			if (governed) {
				if (!input.observationRunId || !input.observationLeaseOwner)
					throw new DomainError(
						"Candidate write requires its exact live run and lease owner.",
						"CONFLICT",
					);
				await this.requireWorkLease(
					client,
					input.observationRunId,
					input.observationEventId!,
					input.observationLeaseOwner,
				);
			}

			if (
				governed &&
				proposal.kind === "task_create" &&
				((proposal.changes.status &&
					!["planned", "backlog"].includes(
						proposal.changes.status,
					)) ||
					(proposal.changes.result &&
						proposal.changes.result !== "unknown"))
			)
				throw new DomainError(
					"Candidate creation requires planned work with unknown result; use the assessed transition path.",
					"CONFLICT",
				);

			const stateTime = observation ? iso(observation.occurred_at) : now;
			let previous: Task | null = null;
			let current: Task;
			let decisionMetadata:
				import("../domain/evidence-types.js").DecisionMetadata | null =
				null;

			if (proposal.kind === "task_create") {
				if (proposal.assessmentId) {
					const assessmentResult =
						await client.query<EvidenceAssessmentRow>(
							`SELECT * FROM evidence_assessments WHERE organization_id=$1 AND id=$2
               AND content_state='active' FOR SHARE`,
							[this.organizationId, proposal.assessmentId],
						);

					if (!assessmentResult.rows[0])
						throw new DomainError(
							"Assessed decision is unavailable.",
							"CONFLICT",
						);

					const assessment = assessmentFromRow(
						assessmentResult.rows[0],
						this.cipher,
					);

					if (
						assessment.reasonCodes.includes(
							"historical_evaluation",
						) ||
						assessment.targetType !== "task_create" ||
						assessment.targetId !== null ||
						assessment.claimIds.length === 0 ||
						assessment.disposition === "rejected" ||
						assessment.disposition === "no_change"
					) {
						throw new DomainError(
							"Assessed creation no longer matches the request.",
							"CONFLICT",
						);
					}
					if (
						input.state === "auto_applied" ||
						input.decidedBy.startsWith("intelligence:") ||
						!input.decisionNote?.trim()
					) {
						throw new DomainError(
							"Assessed creation requires a human reviewer and a reason.",
							"FORBIDDEN",
						);
					}

					const claimRows = await client.query<EvidenceClaimRow>(
						`SELECT * FROM evidence_claims WHERE organization_id=$1 AND id=ANY($2::uuid[])
               AND content_state='active' FOR SHARE`,
						[this.organizationId, assessment.claimIds],
					);

					if (claimRows.rows.length !== assessment.claimIds.length) {
						throw new DomainError(
							"Assessed request claim is unavailable.",
							"CONFLICT",
						);
					}

					const claimBodies = claimRows.rows.map(
						(claimRow) => claimFromRow(claimRow, this.cipher).body,
					);
					const lockById = new Map(
						lockedSources.map((source) => [source.id, source]),
					);
					const spans = claimBodies.flatMap((claim) => claim.spans);

					if (
						claimBodies.some((claim) => claim.kind !== "request") ||
						spans.length === 0 ||
						contentHash(
							[
								...new Set(spans.map((span) => span.eventId)),
							].sort(),
						) !== contentHash(sourceIds) ||
						spans.some((span) => {
							const source = lockById.get(span.eventId);

							return (
								!source ||
								source.source_version_key !==
									span.sourceVersionKey ||
								source.origin_observation_key !==
									span.originObservationKey
							);
						})
					)
						throw new DomainError(
							"Assessed request source is stale or unsupported.",
							"CONFLICT",
						);
					decisionMetadata = {
						schemaVersion: 1,
						assessmentId: assessment.id,
						...(assessment.body.workStateAssessmentId
							? {
									workStateAssessmentId:
										assessment.body.workStateAssessmentId,
								}
							: {}),
						basis: "manual",
						policyVersion: assessment.policyVersion,
						contractVersion: assessment.contractVersion,
						effectiveAtByField: {},
						sourceEventIdsByField: { creation: sourceIds },
						acceptedAt: now,
						override: {
							actor: input.decidedBy,
							reasonCode:
								assessment.reasonCodes[0] ?? "manual_review",
						},
					};
				}

				const fields = taskFieldsFromCreate(
					acceptedTaskChanges({
						previous: null,
						changes: proposal.changes,
						proposalId: proposal.id,
						evidenceIds: proposal.evidenceIds,
						decidedBy: input.decidedBy,
						decidedAt: now,
						state: input.state,
					}),
				);

				current = {
					...fields,
					id: randomUUID(),
					version: 1,
					createdAt: stateTime,
					updatedAt: stateTime,
				};
				await this.insertTask(client, current);
			} else {
				const taskResult = await client.query<TaskRow>(
					"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2 FOR UPDATE",
					[this.organizationId, proposal.taskId],
				);

				if (!taskResult.rows[0])
					throw new DomainError(
						`Task ${proposal.taskId ?? ""} does not exist.`,
						"NOT_FOUND",
					);
				previous = taskFromRow(taskResult.rows[0]);
				if (
					governed &&
					(proposal.changes.status !== undefined ||
						proposal.changes.result !== undefined)
				) {
					if (
						!input.workStateAssessmentId ||
						previous.outcomeContract
					)
						throw new DomainError(
							"Work state requires a bound assessment; approved contracts use assessed review proposals.",
							"CONFLICT",
						);

					const stateReceipt = (
						await client.query<{
							body_envelope: EncryptedPayload | null;
						}>(
							"SELECT body_envelope FROM work_state_assessments WHERE organization_id=$1 AND id=$2 FOR SHARE",
							[this.organizationId, input.workStateAssessmentId],
						)
					).rows[0];

					if (!stateReceipt?.body_envelope)
						throw new DomainError(
							"Work state assessment is unavailable.",
							"CONFLICT",
						);
					await this.validateWorkStateReceipt(
						client,
						this.cipher.decrypt(
							stateReceipt.body_envelope,
						) as unknown as WorkStateReceipt,
						previous,
						proposal.changes as TaskProposalChanges,
						input.observationEventId!,
					);
				}

				if (
					input.observationEventId &&
					previous.outcomeContract &&
					previous.status !== "done" &&
					proposal.changes.status === "done"
				) {
					throw new DomainError(
						"Approved outcome requirements need an assessed completion proposal; a source report cannot verify itself.",
						"CONFLICT",
					);
				}
				if (
					!input.observationEventId &&
					previous.version !== proposal.baseVersion
				) {
					throw new DomainError(
						"Task changed after this proposal was created.",
						"CONFLICT",
					);
				}
				if (proposal.assessmentId) {
					const assessmentResult =
						await client.query<EvidenceAssessmentRow>(
							`SELECT * FROM evidence_assessments WHERE organization_id=$1 AND id=$2
               AND content_state='active' FOR SHARE`,
							[this.organizationId, proposal.assessmentId],
						);

					if (!assessmentResult.rows[0])
						throw new DomainError(
							"Assessed decision is unavailable.",
							"CONFLICT",
						);

					const assessment = assessmentFromRow(
						assessmentResult.rows[0],
						this.cipher,
					);

					if (assessment.body.workStateAssessmentId) {
						const receiptRow = (
							await client.query<{
								body_envelope: EncryptedPayload | null;
							}>(
								"SELECT body_envelope FROM work_state_assessments WHERE organization_id=$1 AND id=$2 FOR SHARE",
								[
									this.organizationId,
									assessment.body.workStateAssessmentId,
								],
							)
						).rows[0];

						if (!receiptRow?.body_envelope)
							throw new DomainError(
								"Formal work receipt is unavailable or revoked.",
								"CONFLICT",
							);

						const receipt = this.cipher.decrypt(
							receiptRow.body_envelope,
						) as unknown as WorkStateReceipt;

						await this.validateWorkStateReceipt(
							client,
							receipt,
							previous,
							proposal.changes as TaskProposalChanges,
							receipt.context.activeEventId,
							false,
						);
					}

					if (
						assessment.reasonCodes.includes("historical_evaluation")
					) {
						throw new DomainError(
							"Historical assessments cannot be applied.",
							"CONFLICT",
						);
					}
					if (
						contentHash(
							compileTaskPatch(
								assessment.body.fields.map(
									(field) => field.operation,
								),
							),
						) !== contentHash(proposal.changes)
					) {
						throw new DomainError(
							"Assessed proposal patch differs from its assessment.",
							"CONFLICT",
						);
					}
					for (const field of assessment.body.fields) {
						const latest = (
							await client.query<{
								applied_at: Date;
								decision_metadata:
									| import("../domain/evidence-types.js").DecisionMetadata
									| null;
							}>(
								`SELECT applied_at,decision_metadata FROM task_revisions
                 WHERE organization_id=$1 AND task_id=$2
                   AND previous IS NOT NULL AND (previous->$3) IS DISTINCT FROM (current->$3)
                 ORDER BY version DESC LIMIT 1`,
								[
									this.organizationId,
									previous.id,
									field.operation.field,
								],
							)
						).rows[0];
						const latestEffectiveAt =
							latest?.decision_metadata?.effectiveAtByField[
								field.operation.field
							] ?? (latest ? iso(latest.applied_at) : null);

						if (
							latestEffectiveAt &&
							(!field.effectiveAt ||
								!Number.isFinite(
									Date.parse(field.effectiveAt),
								) ||
								Date.parse(field.effectiveAt) <
									Date.parse(latestEffectiveAt))
						) {
							throw new DomainError(
								"Assessed evidence predates the accepted task field.",
								"CONFLICT",
							);
						}
					}

					const doneFields = assessment.body.fields.filter(
						(field) =>
							field.operation.field === "status" &&
							field.operation.op === "set" &&
							field.operation.value === "done",
					);

					if (doneFields.length > 0) {
						const supportingIds = [
							...new Set(
								doneFields.flatMap(
									(field) =>
										field.operation.supportingClaimIds,
								),
							),
						];

						if (
							supportingIds.length === 0 ||
							doneFields.some(
								(field) =>
									field.operation.supportingClaimIds
										.length === 0,
							)
						) {
							throw new DomainError(
								"Task completion lacks a supporting bounded report.",
								"CONFLICT",
							);
						}

						const claimRows = await client.query<EvidenceClaimRow>(
							`SELECT * FROM evidence_claims WHERE organization_id=$1 AND id=ANY($2::uuid[])
                 AND content_state='active' FOR SHARE`,
							[this.organizationId, supportingIds],
						);

						if (
							claimRows.rows.length !== supportingIds.length ||
							claimRows.rows.some((claimRow) => {
								const claim = claimFromRow(
									claimRow,
									this.cipher,
								).body;

								return (
									!explicitlyAssertsTaskDone(claim) &&
									!(
										claim.kind === "completion_report" &&
										assessment.relationship ===
											"same_outcome" &&
										assessment.reasonCodes.includes(
											"task_status_inferred_from_bounded_report",
										) &&
										input.state === "approved" &&
										!input.decidedBy.startsWith(
											"intelligence:",
										) &&
										Boolean(input.decisionNote?.trim())
									)
								);
							})
						) {
							throw new DomainError(
								"Task completion lacks a reviewed bounded report.",
								"CONFLICT",
							);
						}
					}

					const policy = (
						await import("../intelligence/decision-policy.js")
					).decideEvidenceApplication({ task: previous, assessment });

					if (
						assessment.targetId !== previous.id ||
						assessment.targetVersion !== String(previous.version) ||
						assessment.claimIds.length === 0 ||
						policy.disposition === "rejected" ||
						policy.disposition === "no_change"
					) {
						throw new DomainError(
							"Assessed decision no longer matches the task.",
							"CONFLICT",
						);
					}

					let autoAuthorized = false;

					if (
						input.state === "auto_applied" &&
						input.authorityPolicy &&
						assessment.claimIds.length === 1 &&
						assessment.body.fields.length === 1 &&
						policy.disposition === "eligible" &&
						policy.applicationClass === "task_nonterminal" &&
						!policy.requiresHumanReview &&
						sourceIds.length === 1 &&
						assessment.reasonCodes.includes(
							"authorized_attestation",
						) &&
						assessment.reasonCodes.includes(
							`authority_policy:${input.authorityPolicy.id}:v${input.authorityPolicy.version}`,
						) &&
						input.decidedBy ===
							`policy:authority:${input.authorityPolicy.id}:v${input.authorityPolicy.version}`
					) {
						const claimResult =
							await client.query<EvidenceClaimRow>(
								`SELECT * FROM evidence_claims WHERE organization_id=$1 AND id=$2
                 AND content_state='active' FOR SHARE`,
								[this.organizationId, assessment.claimIds[0]],
							);
						const claim = claimResult.rows[0]
							? claimFromRow(claimResult.rows[0], this.cipher)
									.body
							: null;
						const sourceResult = await client.query<SourceEventRow>(
							`SELECT se.*,sec.ciphertext,sec.iv,sec.auth_tag,sec.key_version
                 FROM source_events se JOIN source_event_contents sec
                   ON sec.source_event_id=se.id AND sec.revoked_at IS NULL
                WHERE se.organization_id=$1 AND se.id=$2 AND se.content_state='active'`,
							[this.organizationId, sourceIds[0]],
						);
						const source = sourceResult.rows[0]
							? sourceEventFromRow(
									sourceResult.rows[0],
									this.cipher,
								)
							: null;
						const memberResult = claim?.speakerMemberId
							? await client.query<MemberRow>(
									"SELECT * FROM members WHERE organization_id=$1 AND id=$2 FOR SHARE",
									[
										this.organizationId,
										claim.speakerMemberId,
									],
								)
							: null;
						const member = memberResult?.rows[0]
							? memberFromRow(memberResult.rows[0])
							: null;
						const identityResult =
							source && member
								? await client.query<MemberIdentityRow>(
										`SELECT * FROM member_identities WHERE organization_id=$1 AND member_id=$2
                 AND provider=$3 AND installation_key=$4 AND status='active' FOR SHARE`,
										[
											this.organizationId,
											member.id,
											source.provider,
											source.installationKey,
										],
									)
								: null;
						const field = assessment.body.fields[0];

						autoAuthorized = Boolean(
							claim &&
							source &&
							field &&
							claim.spans.length === 1 &&
							field.operation.field === "status" &&
							field.operation.op === "set" &&
							field.operation.value === claim.assertedValue &&
							field.operation.supportingClaimIds.length === 1 &&
							field.operation.supportingClaimIds[0] ===
								assessment.claimIds[0] &&
							field.support.length === 1 &&
							contentHash(field.support[0]) ===
								contentHash(claim.spans[0]) &&
							identityResult?.rows.length === 1 &&
							authorizedStatusAttestation({
								claim,
								task: previous,
								source,
								member,
								identity: memberIdentityFromRow(
									identityResult.rows[0]!,
								),
								policy: input.authorityPolicy,
							}),
						);
					}
					if (
						(input.state === "auto_applied" && !autoAuthorized) ||
						input.decidedBy.startsWith("intelligence:") ||
						(policy.disposition === "review_required" &&
							!input.decisionNote?.trim())
					) {
						throw new DomainError(
							"Assessed decision requires a human reviewer and a reason.",
							"FORBIDDEN",
						);
					}

					const supportsByField = Object.fromEntries(
						assessment.body.fields.map((field) => [
							field.operation.field,
							[
								...new Set(
									field.support.map((span) => span.eventId),
								),
							].sort(),
						]),
					);

					decisionMetadata = {
						schemaVersion: 1,
						assessmentId: assessment.id,
						...(assessment.body.workStateAssessmentId
							? {
									workStateAssessmentId:
										assessment.body.workStateAssessmentId,
								}
							: {}),
						basis: autoAuthorized
							? "authorized_attestation"
							: policy.disposition === "review_required"
								? "manual"
								: "model_inferred",
						policyVersion: assessment.policyVersion,
						contractVersion: assessment.contractVersion,
						effectiveAtByField: Object.fromEntries(
							assessment.body.fields.map((field) => [
								field.operation.field,
								field.effectiveAt,
							]),
						),
						sourceEventIdsByField: supportsByField,
						acceptedAt: now,
						override:
							policy.disposition === "review_required"
								? {
										actor: input.decidedBy,
										reasonCode:
											policy.reasonCodes[0] ??
											"manual_review",
									}
								: null,
					};

					const lockById = new Map(
						lockedSources.map((source) => [source.id, source]),
					);

					for (const field of assessment.body.fields) {
						for (const span of field.support) {
							const source = lockById.get(span.eventId);

							if (
								!source ||
								source.source_version_key !==
									span.sourceVersionKey ||
								source.origin_observation_key !==
									span.originObservationKey
							) {
								throw new DomainError(
									"Assessed source version is stale.",
									"CONFLICT",
								);
							}
						}
					}
				}
				current = applyTaskChanges(
					previous,
					acceptedTaskChanges({
						previous,
						changes: proposal.changes,
						proposalId: proposal.id,
						evidenceIds: proposal.evidenceIds,
						decidedBy: input.decidedBy,
						decidedAt: now,
						state: input.state,
					}),
					stateTime,
				);
				await this.updateTask(client, current);
			}
			if (current.projectId) {
				const linked = await client.query<ProjectRow>(
					"SELECT * FROM projects WHERE organization_id=$1 AND id=$2",
					[this.organizationId, current.projectId],
				);
				const project = linked.rows[0]
					? projectFromRow(linked.rows[0])
					: null;

				if (
					!project ||
					(current.project &&
						![project.name, ...project.aliases].some(
							(name) =>
								name.toLowerCase() ===
								current.project!.trim().toLowerCase(),
						))
				) {
					throw new DomainError(
						"Linked project does not match the task's project label.",
						"INVALID",
					);
				}
			}

			if (input.observationEventId) {
				const observation = lockedSources.find(
					(source) => source.id === input.observationEventId,
				);

				if (
					!observation ||
					proposal.assessmentId ||
					proposal.requestedBy !== "observation-agent"
				) {
					throw new DomainError(
						"Invalid observation agent receipt.",
						"INVALID",
					);
				}

				const fields =
					proposal.kind === "task_create"
						? ["creation", ...Object.keys(proposal.changes)]
						: Object.keys(proposal.changes);

				decisionMetadata = {
					schemaVersion: 1,
					assessmentId: null,
					basis: "model_inferred",
					policyVersion: governed
						? workStatePolicy
						: "observation-agent-v1",
					...(input.workStateAssessmentId
						? { workStateAssessmentId: input.workStateAssessmentId }
						: {}),
					contractVersion: current.outcomeContract?.version ?? null,
					effectiveAtByField: Object.fromEntries(
						fields.map((field) => [
							field,
							iso(observation.occurred_at),
						]),
					),
					sourceEventIdsByField: Object.fromEntries(
						fields.map((field) => [field, sourceIds]),
					),
					acceptedAt: now,
					override: null,
				};
			}
			if (!decisionMetadata) {
				const changedFields =
					proposal.kind === "task_create"
						? ["creation"]
						: Object.keys(proposal.changes);
				const sourceIds = [...new Set(proposal.evidenceIds)].sort();

				decisionMetadata = {
					schemaVersion: 1,
					assessmentId: null,
					basis:
						input.state === "approved"
							? "manual"
							: "legacy_unknown",
					policyVersion:
						input.state === "approved"
							? "manual-direct-v1"
							: "legacy-auto-v1",
					contractVersion: current.outcomeContract?.version ?? null,
					effectiveAtByField: Object.fromEntries(
						changedFields.map((field) => [field, now]),
					),
					sourceEventIdsByField: sourceIds.length
						? Object.fromEntries(
								changedFields.map((field) => [
									field,
									sourceIds,
								]),
							)
						: {},
					acceptedAt: now,
					override:
						input.state === "approved"
							? {
									actor: input.decidedBy,
									reasonCode: "manual_decision",
								}
							: null,
				};
			}

			await client.query(
				`UPDATE proposals SET state=$3, decided_at=$4, decided_by=$5, decision_note=$6,
           decision_metadata=$7::jsonb WHERE organization_id=$1 AND id=$2`,
				[
					this.organizationId,
					proposal.id,
					input.state,
					now,
					input.decidedBy,
					input.decisionNote,
					decisionMetadata ? JSON.stringify(decisionMetadata) : null,
				],
			);

			const revision: TaskRevision = {
				id: randomUUID(),
				taskId: current.id,
				version: current.version,
				proposalId: proposal.id,
				previous,
				current,
				appliedAt: stateTime,
				appliedBy: input.decidedBy,
				decisionMetadata,
			};

			await client.query(
				`INSERT INTO task_revisions
          (id, organization_id, task_id, version, proposal_id, previous, current, applied_at, applied_by, decision_metadata)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10::jsonb)`,
				[
					revision.id,
					this.organizationId,
					revision.taskId,
					revision.version,
					revision.proposalId,
					previous ? JSON.stringify(previous) : null,
					JSON.stringify(current),
					revision.appliedAt,
					revision.appliedBy,
					decisionMetadata ? JSON.stringify(decisionMetadata) : null,
				],
			);
			if (decisionMetadata) {
				const lockedById = new Map(
					lockedSources.map((source) => [source.id, source]),
				);

				for (const [fieldKey, ids] of Object.entries(
					decisionMetadata.sourceEventIdsByField,
				)) {
					for (const sourceId of ids) {
						const source = lockedById.get(sourceId)!;

						await client.query(
							`INSERT INTO evidence_dependencies
                (organization_id,dependent_type,dependent_id,field_key,source_event_id,
                 origin_observation_key,source_version_key,source_authorization_version,relationship)
               VALUES ($1,'task_revision',$2,$3,$4,$5,$6,$7,'supports') ON CONFLICT DO NOTHING`,
							[
								this.organizationId,
								revision.id,
								fieldKey,
								sourceId,
								source.origin_observation_key ??
									`unresolved-receipt:${source.id}`,
								source.source_version_key ??
									`unresolved-receipt:${source.id}`,
								source.authorization_version ?? 1,
							],
						);
					}
				}
			}
			await this.projectAcceptedTask(client, current);
			await this.insertDecisionEffects(client, {
				proposalId: proposal.id,
				actor: input.decidedBy,
				action: input.auditAction,
				details: input.auditDetails ?? {},
				topic: "projection.task.revised",
				dedupeKey: `task-revision:${revision.id}`,
				payload: {
					proposalId: proposal.id,
					taskId: current.id,
					revisionId: revision.id,
					version: current.version,
				},
				occurredAt: now,
			});
			await client.query("COMMIT");
			return revision;
		} catch (error) {
			await client.query("ROLLBACK");
			if ((error as { code?: string }).code === "23505") {
				throw new DomainError(
					"A task with this source reference already exists.",
					"CONFLICT",
				);
			}
			throw error;
		} finally {
			client.release();
		}
	}

	async approveAndApplyContextProposal(
		input: ApproveAndApplyProposalInput,
	): Promise<ContextEntry> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const proposalResult = await client.query<ProposalRow>(
				"SELECT * FROM proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, input.proposalId],
			);
			const row = proposalResult.rows[0];

			if (!row)
				throw new DomainError(
					`Proposal ${input.proposalId} does not exist.`,
					"NOT_FOUND",
				);

			const proposal = proposalFromRow(row);

			if (!isOpenProposalState(proposal.state)) {
				if (
					proposal.state === input.state &&
					proposal.decidedBy === input.decidedBy &&
					proposal.decisionNote === input.decisionNote &&
					isContextProposal(proposal)
				) {
					const sourceIds = [...new Set(proposal.evidenceIds)].sort();

					if (
						proposal.assessmentId ||
						proposal.requestedBy === "evidence-summary"
					) {
						await this.lockSourceObjectKeys(client, sourceIds);
					}

					const sources = sourceIds.length
						? (
								await client.query<SourceEventRow>(
									`SELECT * FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[])
               AND content_state='active' ORDER BY id FOR SHARE`,
									[this.organizationId, sourceIds],
								)
							).rows
						: [];

					if (
						sources.length === sourceIds.length &&
						sourceIds.length > 0
					) {
						if (proposal.assessmentId)
							await this.assertOrderedAssessedSourceVersions(
								client,
								sources,
							);

						const existing = await client.query<{
							current: ContextEntry;
						}>(
							"SELECT current FROM context_revisions WHERE organization_id=$1 AND proposal_id=$2 LIMIT 1",
							[this.organizationId, proposal.id],
						);

						if (existing.rows[0]) {
							await client.query("COMMIT");
							return existing.rows[0].current;
						}
					}
				}
				throw new DomainError(
					`Proposal ${proposal.id} is already ${proposal.state}.`,
					"CONFLICT",
				);
			}
			if (!isContextProposal(proposal)) {
				throw new DomainError(
					"Task proposals require task approval.",
					"INVALID",
				);
			}

			const sourceIds = [...new Set(proposal.evidenceIds)].sort();
			const sourceEventId = input.observationEventId ?? sourceIds[0];

			if (!sourceEventId)
				throw new DomainError(
					"A context proposal requires evidence.",
					"INVALID",
				);
			if (
				proposal.assessmentId ||
				proposal.requestedBy === "evidence-summary"
			) {
				await this.lockSourceObjectKeys(client, sourceIds);
			}

			const evidenceResult = await client.query<SourceEventRow>(
				`SELECT * FROM source_events WHERE organization_id=$1 AND id=ANY($2::uuid[])
           AND content_state='active' ORDER BY id FOR SHARE`,
				[this.organizationId, sourceIds],
			);

			if (evidenceResult.rows.length !== sourceIds.length) {
				throw new DomainError(
					"A context proposal requires active evidence.",
					"CONFLICT",
				);
			}
			if (proposal.requestedBy === "evidence-summary") {
				if (
					proposal.kind !== "context_file_upsert" ||
					sourceIds.length !== 1 ||
					input.state === "auto_applied" ||
					input.decidedBy.startsWith("intelligence:") ||
					!input.decisionNote?.trim()
				) {
					throw new DomainError(
						"A refreshed summary requires a human reviewer and one source.",
						"FORBIDDEN",
					);
				}

				const current = await client.query<{ id: string }>(
					`SELECT se.id FROM source_events se WHERE se.organization_id=$1
             AND se.id=ANY($2::uuid[]) AND se.content_state='active'
             AND se.event_kind='source.document.retrieved'
             AND NOT EXISTS (SELECT 1 FROM source_events newer
               WHERE newer.organization_id=se.organization_id AND newer.provider=se.provider
                 AND newer.installation_key=se.installation_key
                 AND coalesce(newer.canonical_object_key,newer.source_ref)
                   =coalesce(se.canonical_object_key,se.source_ref)
                 AND (se.source_version_key IS NULL
                   OR newer.source_version_key IS DISTINCT FROM se.source_version_key
                   OR newer.content_state<>'active')
                 AND (newer.occurred_at,newer.received_at,newer.id)
                   >(se.occurred_at,se.received_at,se.id))`,
					[this.organizationId, sourceIds],
				);

				if (current.rows.length !== sourceIds.length) {
					throw new DomainError(
						"Context summary source changed before approval.",
						"CONFLICT",
					);
				}
			}
			if (proposal.assessmentId)
				await this.assertOrderedAssessedSourceVersions(
					client,
					evidenceResult.rows,
				);

			const sourcesById = new Map(
				evidenceResult.rows.map((source) => [source.id, source]),
			);
			let contextAssessment: EvidenceAssessment | null = null;

			if (proposal.assessmentId) {
				if (
					input.state === "auto_applied" ||
					input.decidedBy.startsWith("intelligence:") ||
					!input.decisionNote?.trim()
				) {
					throw new DomainError(
						"An assessed context fact requires a human reviewer and reason.",
						"FORBIDDEN",
					);
				}

				const assessmentResult =
					await client.query<EvidenceAssessmentRow>(
						`SELECT * FROM evidence_assessments WHERE organization_id=$1 AND id=$2
             AND content_state='active' FOR SHARE`,
						[this.organizationId, proposal.assessmentId],
					);

				if (!assessmentResult.rows[0])
					throw new DomainError(
						"Context assessment is unavailable.",
						"CONFLICT",
					);

				const assessment = assessmentFromRow(
					assessmentResult.rows[0],
					this.cipher,
				);

				contextAssessment = assessment;
				if (
					assessment.reasonCodes.includes("historical_evaluation") ||
					!["context_create", "context"].includes(
						assessment.targetType,
					) ||
					assessment.disposition !== "review_required" ||
					proposal.kind !== "context_fact_upsert"
				) {
					throw new DomainError(
						"Context assessment does not match this proposal.",
						"CONFLICT",
					);
				}

				const claimsResult = await client.query<EvidenceClaimRow>(
					`SELECT * FROM evidence_claims WHERE organization_id=$1 AND id=ANY($2::uuid[])
             AND content_state='active' FOR SHARE`,
					[this.organizationId, assessment.claimIds],
				);

				if (claimsResult.rows.length !== assessment.claimIds.length) {
					throw new DomainError(
						"Context claim is unavailable.",
						"CONFLICT",
					);
				}

				const claims = claimsResult.rows.map((claim) =>
					claimFromRow(claim, this.cipher),
				);
				const spans = claims.flatMap((claim) => claim.body.spans);
				const claim = claims[0]?.body;
				const canonicalObject = spans[0]
					? sourcesById.get(spans[0].eventId)?.canonical_object_key
					: null;
				const factIdentity =
					claim?.assertedField &&
					claim.subjectRefs.length &&
					canonicalObject
						? contentHash({
								source: canonicalObject,
								field: claim.assertedField,
								subjects: [
									...new Set(claim.subjectRefs),
								].sort(),
							})
						: null;

				if (
					claims.length !== 1 ||
					claims[0]?.body.kind !== "context_statement" ||
					contentHash(proposal.changes.value) !==
						contentHash(claims[0].body.assertedValue) ||
					(assessment.targetType === "context_create" &&
						(!factIdentity ||
							proposal.changes.sourceRef !==
								`evidence:fact:${factIdentity}` ||
							proposal.changes.path !==
								`/evidence/facts/${factIdentity}`)) ||
					spans.length === 0 ||
					contentHash(
						[...new Set(spans.map((span) => span.eventId))].sort(),
					) !== contentHash(sourceIds) ||
					spans.some((span) => {
						const source = sourcesById.get(span.eventId);

						return (
							!source ||
							source.origin_observation_key !==
								span.originObservationKey ||
							source.source_version_key !== span.sourceVersionKey
						);
					})
				) {
					throw new DomainError(
						"Context source version is stale or unsupported.",
						"CONFLICT",
					);
				}
			}

			const primarySource = sourcesById.get(sourceEventId)!;
			const entry = contextEntryFromProposal(
				proposal,
				sourceEventId,
				primarySource.content_hash,
				iso(primarySource.occurred_at),
			);
			const observation = input.observationEventId
				? sourcesById.get(input.observationEventId)
				: null;

			if (input.observationEventId) {
				if (
					!observation ||
					proposal.assessmentId ||
					proposal.requestedBy !== "observation-agent"
				) {
					throw new DomainError(
						"Invalid observation agent receipt.",
						"INVALID",
					);
				}
				if (
					await this.governedWorkObservation(
						client,
						input.observationEventId,
					)
				) {
					if (!input.observationRunId || !input.observationLeaseOwner)
						throw new DomainError(
							"Candidate context requires its exact live run and lease owner.",
							"CONFLICT",
						);
					await this.requireWorkLease(
						client,
						input.observationRunId,
						input.observationEventId,
						input.observationLeaseOwner,
					);
				}
				entry.effectiveFrom = iso(observation.occurred_at);
			}
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
				[`${this.organizationId}:${entry.sourceRef}`],
			);

			const previousResult = await client.query<ContextEntryRow>(
				"SELECT * FROM context_entries WHERE organization_id=$1 AND source_ref=$2 FOR UPDATE",
				[this.organizationId, entry.sourceRef],
			);
			const previous = previousResult.rows[0]
				? contextEntryFromRow(previousResult.rows[0])
				: null;

			if (
				contextAssessment?.targetType === "context" &&
				(!previous ||
					previous.kind !== "fact" ||
					previous.id !== contextAssessment.targetId ||
					contentHash(previous) !== contextAssessment.targetVersion ||
					entry.path !== previous.path ||
					entry.kind !== "fact" ||
					entry.factType !== previous.factType)
			) {
				throw new DomainError(
					"Accepted context fact changed after assessment.",
					"CONFLICT",
				);
			}
			if (proposal.assessmentId && previous) {
				const nextEffective = Date.parse(
					entry.effectiveFrom ?? iso(primarySource.occurred_at),
				);
				const oldEffective = Date.parse(
					previous.effectiveFrom ?? previous.updatedAt,
				);
				const previousSource = await client.query<{
					received_at: Date;
				}>(
					"SELECT received_at FROM source_events WHERE organization_id=$1 AND id=$2",
					[this.organizationId, previous.sourceEventId],
				);

				if (
					nextEffective < oldEffective ||
					(nextEffective === oldEffective &&
						primarySource.received_at.getTime() <=
							(previousSource.rows[0]?.received_at.getTime() ??
								Infinity))
				) {
					throw new DomainError(
						"A newer accepted context fact already exists.",
						"CONFLICT",
					);
				}
			}

			const entryId = previous?.id ?? randomUUID();
			const result = await client.query<ContextEntryRow>(
				`INSERT INTO context_entries
          (id, organization_id, kind, source_event_id, source_ref, path, title, body, fact_type, fact_value,
           source_url, content_hash, evidence_ids, lifecycle_state, effective_from, effective_to, links, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12,$13::uuid[],$14,$15,$16,$17::jsonb,$18)
         ON CONFLICT (organization_id, source_ref) DO UPDATE SET
          kind=excluded.kind, source_event_id=excluded.source_event_id, path=excluded.path,
          title=excluded.title, body=excluded.body, fact_type=excluded.fact_type,
          fact_value=excluded.fact_value, source_url=excluded.source_url,
          content_hash=excluded.content_hash, evidence_ids=excluded.evidence_ids,
          lifecycle_state=excluded.lifecycle_state, effective_from=excluded.effective_from,
          effective_to=excluded.effective_to, links=excluded.links, updated_at=excluded.updated_at
        RETURNING *`,
				[
					entryId,
					this.organizationId,
					entry.kind,
					entry.sourceEventId,
					entry.sourceRef,
					entry.path,
					entry.title,
					entry.kind === "file" ? entry.body : null,
					entry.kind === "fact" ? entry.factType : null,
					entry.kind === "fact" ? JSON.stringify(entry.value) : null,
					entry.sourceUrl,
					entry.contentHash,
					entry.evidenceIds,
					entry.lifecycleState,
					entry.effectiveFrom,
					entry.effectiveTo,
					JSON.stringify(entry.links),
					observation
						? iso(observation.occurred_at)
						: new Date().toISOString(),
				],
			);

			await client.query(
				"UPDATE proposals SET state=$3, decided_at=now(), decided_by=$4, decision_note=$5 WHERE organization_id=$1 AND id=$2",
				[
					this.organizationId,
					proposal.id,
					input.state,
					input.decidedBy,
					input.decisionNote,
				],
			);

			const applied = contextEntryFromRow(result.rows[0]!);
			const versionResult = await client.query<{ version: number }>(
				"SELECT COALESCE(max(version), 0)::integer + 1 AS version FROM context_revisions WHERE organization_id=$1 AND context_entry_id=$2",
				[this.organizationId, applied.id],
			);
			const revision: ContextRevision = {
				id: randomUUID(),
				contextEntryId: applied.id,
				version: versionResult.rows[0]!.version,
				proposalId: proposal.id,
				previous,
				current: applied,
				appliedAt: applied.updatedAt,
				appliedBy: input.decidedBy,
			};

			await client.query(
				`INSERT INTO context_revisions
          (id, organization_id, context_entry_id, version, proposal_id, previous, current, applied_at, applied_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
				[
					revision.id,
					this.organizationId,
					revision.contextEntryId,
					revision.version,
					revision.proposalId,
					previous ? JSON.stringify(previous) : null,
					JSON.stringify(applied),
					revision.appliedAt,
					revision.appliedBy,
				],
			);
			await this.insertDecisionEffects(client, {
				proposalId: proposal.id,
				actor: input.decidedBy,
				action: input.auditAction,
				details: input.auditDetails ?? {},
				topic: "projection.context.updated",
				dedupeKey: `context-proposal:${proposal.id}`,
				payload: {
					proposalId: proposal.id,
					contextEntryId: applied.id,
					revisionId: revision.id,
					version: revision.version,
					path: applied.path,
				},
				occurredAt: applied.updatedAt,
			});
			await client.query("COMMIT");
			return applied;
		} catch (error) {
			await client.query("ROLLBACK");
			if ((error as { code?: string }).code === "23505") {
				throw new DomainError(
					"A context entry already occupies this path.",
					"CONFLICT",
				);
			}
			throw error;
		} finally {
			client.release();
		}
	}

	async getTask(id: string): Promise<Task | null> {
		const result = await this.pool.query<TaskRow>(
			"SELECT * FROM tasks WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? taskFromRow(result.rows[0]) : null;
	}

	async listProjects(): Promise<Project[]> {
		const result = await this.pool.query<ProjectRow>(
			"SELECT * FROM projects WHERE organization_id=$1 ORDER BY name",
			[this.organizationId],
		);

		return result.rows.map(projectFromRow);
	}

	async createProjectProposal(
		input: NewProjectProposal,
	): Promise<ProjectProposal> {
		const result = await this.pool.query<ProjectProposalRow>(
			`INSERT INTO project_proposals
        (id, organization_id, kind, project_id, base_version, changes, evidence_ids, rationale, requested_by, state)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,'pending') RETURNING *`,
			[
				randomUUID(),
				this.organizationId,
				input.kind,
				input.projectId,
				input.baseVersion,
				JSON.stringify(input.changes),
				JSON.stringify(input.evidenceIds),
				input.rationale,
				input.requestedBy,
			],
		);

		return projectProposalFromRow(result.rows[0]!);
	}

	async getProjectProposal(id: string): Promise<ProjectProposal | null> {
		const result = await this.pool.query<ProjectProposalRow>(
			"SELECT * FROM project_proposals WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		return result.rows[0] ? projectProposalFromRow(result.rows[0]) : null;
	}

	async listProjectProposals(): Promise<ProjectProposal[]> {
		const result = await this.pool.query<ProjectProposalRow>(
			"SELECT * FROM project_proposals WHERE organization_id=$1 ORDER BY created_at DESC",
			[this.organizationId],
		);

		return result.rows.map(projectProposalFromRow);
	}

	async decideProjectProposal(
		id: string,
		state: "rejected" | "superseded",
		actor: string,
		note: string | null,
	): Promise<ProjectProposal> {
		const result = await this.pool.query<ProjectProposalRow>(
			`UPDATE project_proposals SET state=$3, decided_at=now(), decided_by=$4, decision_note=$5
       WHERE organization_id=$1 AND id=$2 AND state IN ('pending','escalated') RETURNING *`,
			[this.organizationId, id, state, actor, note],
		);

		if (!result.rows[0])
			throw new DomainError(
				"Project proposal does not exist or is already decided.",
				"CONFLICT",
			);
		await this.appendAuditEvent({
			actor,
			action: `project_proposal.${state}`,
			targetType: "project_proposal",
			targetId: id,
			sourceEventId: null,
			proposalId: null,
			details: { projectId: result.rows[0].project_id },
		});
		return projectProposalFromRow(result.rows[0]);
	}

	async approveProjectProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<ProjectRevision> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const proposalResult = await client.query<ProjectProposalRow>(
				"SELECT * FROM project_proposals WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, id],
			);
			const proposal = proposalResult.rows[0]
				? projectProposalFromRow(proposalResult.rows[0])
				: null;

			if (!proposal)
				throw new DomainError(
					"Project proposal does not exist.",
					"NOT_FOUND",
				);
			if (!isOpenProposalState(proposal.state))
				throw new DomainError(
					"Project proposal is already decided.",
					"CONFLICT",
				);

			const previousResult = proposal.projectId
				? await client.query<ProjectRow>(
						"SELECT * FROM projects WHERE organization_id=$1 AND id=$2 FOR UPDATE",
						[this.organizationId, proposal.projectId],
					)
				: null;
			const previous = previousResult?.rows[0]
				? projectFromRow(previousResult.rows[0])
				: null;

			if (proposal.kind === "project_change" && !previous)
				throw new DomainError("Project does not exist.", "NOT_FOUND");
			if (proposal.kind === "project_create" && proposal.projectId)
				throw new DomainError(
					"New project cannot target a project.",
					"INVALID",
				);
			if (previous && previous.version !== proposal.baseVersion)
				throw new DomainError(
					"Project changed after this proposal was created.",
					"CONFLICT",
				);

			const name = (proposal.changes.name ?? previous?.name ?? "").trim();
			const outcome = (
				proposal.changes.outcome ??
				previous?.outcome ??
				""
			).trim();

			if (!name || !outcome)
				throw new DomainError(
					"A project needs a name and outcome.",
					"INVALID",
				);

			const now = new Date().toISOString();
			const current: Project = {
				id: previous?.id ?? randomUUID(),
				organizationId: this.organizationId,
				version: (previous?.version ?? 0) + 1,
				name,
				aliases: [
					...new Set([
						...(proposal.changes.aliases ??
							previous?.aliases ??
							[]),
						...(previous && previous.name !== name
							? [previous.name]
							: []),
					]),
				],
				slug: previous?.slug ?? workSlug(name),
				outcome,
				owner:
					proposal.changes.owner === undefined
						? (previous?.owner ?? null)
						: proposal.changes.owner,
				status: proposal.changes.status ?? previous?.status ?? "active",
				sourceRef: previous?.sourceRef ?? `project:proposal:${id}`,
				sourceUrl:
					proposal.changes.sourceUrl === undefined
						? (previous?.sourceUrl ?? null)
						: proposal.changes.sourceUrl,
				createdAt: previous?.createdAt ?? now,
				updatedAt: now,
			};

			if (previous) {
				const updated = await client.query(
					`UPDATE projects SET name=$3, aliases=$4::jsonb, outcome=$5, owner=$6, status=$7,
            source_url=$8, version=$9, updated_at=$10
           WHERE organization_id=$1 AND id=$2 AND version=$11`,
					[
						this.organizationId,
						current.id,
						name,
						JSON.stringify(current.aliases),
						outcome,
						current.owner,
						current.status,
						current.sourceUrl,
						current.version,
						now,
						previous.version,
					],
				);

				if (updated.rowCount !== 1)
					throw new DomainError(
						"Project revision conflict.",
						"CONFLICT",
					);
			} else {
				await client.query(
					`INSERT INTO projects (id, organization_id, version, name, aliases, slug, outcome, owner, status,
            source_ref, source_url, created_at, updated_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10,$11,$12,$13)`,
					[
						current.id,
						this.organizationId,
						current.version,
						name,
						JSON.stringify(current.aliases),
						current.slug,
						outcome,
						current.owner,
						current.status,
						current.sourceRef,
						current.sourceUrl,
						now,
						now,
					],
				);
			}

			const revision: ProjectRevision = {
				id: randomUUID(),
				projectId: current.id,
				version: current.version,
				proposalId: id,
				previous,
				current,
				appliedAt: now,
				appliedBy: actor,
			};

			await client.query(
				`INSERT INTO project_revisions (id, organization_id, project_id, version, proposal_id, previous, current, applied_at, applied_by)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9)`,
				[
					revision.id,
					this.organizationId,
					current.id,
					current.version,
					id,
					previous ? JSON.stringify(previous) : null,
					JSON.stringify(current),
					now,
					actor,
				],
			);
			await client.query(
				"UPDATE project_proposals SET state='approved', decided_at=$3, decided_by=$4, decision_note=$5 WHERE organization_id=$1 AND id=$2",
				[this.organizationId, id, now, actor, note],
			);
			await client.query(
				`INSERT INTO audit_events (id, organization_id, actor, action, target_type, target_id, source_event_id, proposal_id, details, occurred_at)
         VALUES ($1,$2,$3,'project_proposal.approved','project',$4,NULL,NULL,$5::jsonb,$6)`,
				[
					randomUUID(),
					this.organizationId,
					actor,
					current.id,
					JSON.stringify({
						projectProposalId: id,
						version: current.version,
					}),
					now,
				],
			);
			await client.query("COMMIT");
			return revision;
		} catch (error) {
			await client.query("ROLLBACK");
			if ((error as { code?: string }).code === "23505")
				throw new DomainError(
					"A project with this name already exists.",
					"CONFLICT",
				);
			throw error;
		} finally {
			client.release();
		}
	}

	async listProjectRevisions(projectId: string): Promise<ProjectRevision[]> {
		const result = await this.pool.query<ProjectRevisionRow>(
			"SELECT * FROM project_revisions WHERE organization_id=$1 AND project_id=$2 ORDER BY version DESC",
			[this.organizationId, projectId],
		);

		return result.rows.map(projectRevisionFromRow);
	}

	async listWorkstreams(projectId?: string): Promise<Workstream[]> {
		const result = projectId
			? await this.pool.query<WorkstreamRow>(
					"SELECT * FROM workstreams WHERE organization_id=$1 AND project_id=$2 ORDER BY name",
					[this.organizationId, projectId],
				)
			: await this.pool.query<WorkstreamRow>(
					"SELECT * FROM workstreams WHERE organization_id=$1 ORDER BY project_id, name",
					[this.organizationId],
				);

		return result.rows.map(workstreamFromRow);
	}

	async listWorkLinks(taskId?: string): Promise<WorkLink[]> {
		const result = taskId
			? await this.pool.query<WorkLinkRow>(
					"SELECT * FROM work_links WHERE organization_id=$1 AND task_id=$2 ORDER BY target_ref",
					[this.organizationId, taskId],
				)
			: await this.pool.query<WorkLinkRow>(
					"SELECT * FROM work_links WHERE organization_id=$1 ORDER BY task_id, target_ref",
					[this.organizationId],
				);

		return result.rows.map(workLinkFromRow);
	}

	async listWorkLinkRevisions(): Promise<WorkLinkRevision[]> {
		const result = await this.pool.query<WorkLinkRevisionRow>(
			"SELECT * FROM work_link_revisions WHERE organization_id=$1 ORDER BY changed_at,id",
			[this.organizationId],
		);

		return result.rows.map(workLinkRevisionFromRow);
	}

	async upsertWorkLink(input: {
		taskId: string;
		targetTaskId: string | null;
		targetRef: string;
		linkType: WorkLink["linkType"];
		changedBy?: string;
		proposalId?: string | null;
	}): Promise<WorkLink> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const inserted = await client.query<WorkLinkRow>(
				`INSERT INTO work_links
          (id, organization_id, task_id, target_task_id, target_ref, link_type, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,now(),now())
         ON CONFLICT (task_id,target_ref,link_type) DO NOTHING RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					input.taskId,
					input.targetTaskId,
					input.targetRef,
					input.linkType,
				],
			);
			const found = inserted.rows[0]
				? inserted
				: await client.query<WorkLinkRow>(
						`SELECT * FROM work_links WHERE organization_id=$1 AND task_id=$2
           AND target_ref=$3 AND link_type=$4 FOR UPDATE`,
						[
							this.organizationId,
							input.taskId,
							input.targetRef,
							input.linkType,
						],
					);
			const prior = inserted.rows[0]
				? null
				: found.rows[0]
					? workLinkFromRow(found.rows[0])
					: null;

			if (!found.rows[0])
				throw new DomainError(
					"Work link disappeared during update.",
					"CONFLICT",
				);
			if (prior && prior.targetTaskId === input.targetTaskId) {
				await client.query("COMMIT");
				return prior;
			}

			const row = prior
				? (
						await client.query<WorkLinkRow>(
							"UPDATE work_links SET target_task_id=$2,updated_at=now() WHERE id=$1 RETURNING *",
							[prior.id, input.targetTaskId],
						)
					).rows[0]!
				: found.rows[0];
			const current = workLinkFromRow(row!);
			const version = await client.query<{ version: number }>(
				"SELECT COALESCE(max(version),0)+1 AS version FROM work_link_revisions WHERE link_id=$1",
				[current.id],
			);

			await client.query(
				`INSERT INTO work_link_revisions
           (id,organization_id,link_id,version,previous,current,changed_at,changed_by,proposal_id)
         VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,now(),$7,$8)`,
				[
					randomUUID(),
					this.organizationId,
					current.id,
					version.rows[0]!.version,
					prior ? JSON.stringify(prior) : null,
					JSON.stringify(current),
					input.changedBy ?? "system:unattributed",
					input.proposalId ?? null,
				],
			);
			await client.query("COMMIT");
			return current;
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async findTaskByExternalRef(externalRef: string): Promise<Task | null> {
		const result = await this.pool.query<TaskRow>(
			"SELECT * FROM tasks WHERE organization_id=$1 AND external_ref=$2",
			[this.organizationId, externalRef],
		);

		return result.rows[0] ? taskFromRow(result.rows[0]) : null;
	}

	async listTasks(): Promise<Task[]> {
		const result = await this.pool.query<TaskRow>(
			"SELECT * FROM tasks WHERE organization_id=$1 ORDER BY updated_at DESC",
			[this.organizationId],
		);

		return result.rows.map(taskFromRow);
	}

	async listTaskRevisions(taskId?: string): Promise<TaskRevision[]> {
		const query = taskId
			? "SELECT * FROM task_revisions WHERE organization_id=$1 AND task_id=$2 ORDER BY version"
			: "SELECT * FROM task_revisions WHERE organization_id=$1 ORDER BY applied_at, task_id, version";
		const parameters = taskId
			? [this.organizationId, taskId]
			: [this.organizationId];
		const result = await this.pool.query<{
			id: string;
			task_id: string;
			version: number;
			proposal_id: string;
			previous: Task | null;
			current: Task;
			applied_at: Date;
			applied_by: string;
			decision_metadata:
				import("../domain/evidence-types.js").DecisionMetadata | null;
		}>(query, parameters);

		return result.rows.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			version: row.version,
			proposalId: row.proposal_id,
			previous: row.previous,
			current: row.current,
			appliedAt: iso(row.applied_at),
			appliedBy: row.applied_by,
			decisionMetadata: row.decision_metadata,
		}));
	}

	async getTaskRevisionByProposal(
		proposalId: string,
	): Promise<TaskRevision | null> {
		return (
			(await this.listTaskRevisions()).find(
				(revision) => revision.proposalId === proposalId,
			) ?? null
		);
	}

	async listTaskProposals(taskId: string): Promise<Proposal[]> {
		const result = await this.pool.query<ProposalRow>(
			`SELECT p.*
         FROM proposals p
        WHERE p.organization_id=$1
          AND (
            p.task_id=$2
            OR EXISTS (
              SELECT 1
                FROM task_revisions tr
               WHERE tr.organization_id=$1
                 AND tr.task_id=$2
                 AND tr.proposal_id=p.id
            )
          )
        ORDER BY p.created_at DESC`,
			[this.organizationId, taskId],
		);

		return result.rows.map(proposalFromRow);
	}

	async rebuildCurrentProjections(
		input: RebuildCurrentProjectionsInput,
	): Promise<void> {
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN ISOLATION LEVEL SERIALIZABLE");
			await client.query(
				"SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
				[`${this.organizationId}:projection-rebuild`],
			);
			await client.query(
				"LOCK TABLE task_revisions, context_revisions, tasks, context_entries, projects, workstreams, work_links IN SHARE ROW EXCLUSIVE MODE",
			);
			await client.query(
				"CREATE TEMP TABLE replay_tasks_shadow (id uuid PRIMARY KEY, current jsonb NOT NULL) ON COMMIT DROP",
			);
			await client.query(
				"CREATE TEMP TABLE replay_context_shadow (id uuid PRIMARY KEY, current jsonb NOT NULL) ON COMMIT DROP",
			);
			for (const task of input.tasks) {
				await client.query(
					"INSERT INTO replay_tasks_shadow (id, current) VALUES ($1,$2::jsonb)",
					[task.id, JSON.stringify(task)],
				);
			}
			for (const entry of input.context) {
				await client.query(
					"INSERT INTO replay_context_shadow (id, current) VALUES ($1,$2::jsonb)",
					[entry.id, JSON.stringify(entry)],
				);
			}

			const taskDrift = await client.query<{ count: string }>(
				`SELECT count(*)::text AS count
           FROM replay_tasks_shadow shadow
           LEFT JOIN LATERAL (
             SELECT current FROM task_revisions
              WHERE organization_id=$1 AND task_id=shadow.id
              ORDER BY version DESC LIMIT 1
           ) revision ON true
          WHERE revision.current IS NULL OR revision.current <> shadow.current`,
				[this.organizationId],
			);
			const contextDrift = await client.query<{ count: string }>(
				`SELECT count(*)::text AS count
           FROM replay_context_shadow shadow
           LEFT JOIN LATERAL (
             SELECT current FROM context_revisions
              WHERE organization_id=$1 AND context_entry_id=shadow.id
              ORDER BY version DESC LIMIT 1
           ) revision ON true
          WHERE revision.current IS NULL OR revision.current <> shadow.current`,
				[this.organizationId],
			);

			if (
				taskDrift.rows[0]?.count !== "0" ||
				contextDrift.rows[0]?.count !== "0"
			) {
				throw new DomainError(
					"Projection history changed while the shadow rebuild was being prepared.",
					"CONFLICT",
				);
			}
			await client.query(
				`INSERT INTO tasks (id, organization_id, external_ref, document, version, created_at, updated_at)
         SELECT shadow.id, $1, shadow.current->>'externalRef',
                shadow.current - ARRAY['id','externalRef','version','createdAt','updatedAt'],
                (shadow.current->>'version')::integer,
                (shadow.current->>'createdAt')::timestamptz,
                (shadow.current->>'updatedAt')::timestamptz
           FROM replay_tasks_shadow shadow
         ON CONFLICT (id) DO UPDATE SET
           external_ref=excluded.external_ref, document=excluded.document, version=excluded.version,
           created_at=excluded.created_at, updated_at=excluded.updated_at
         WHERE tasks.organization_id=$1`,
				[this.organizationId],
			);
			await client.query(
				`INSERT INTO context_entries (
           id, organization_id, kind, source_event_id, source_ref, path, title, body,
           fact_type, fact_value, source_url, content_hash, evidence_ids,
           lifecycle_state, effective_from, effective_to, links, updated_at
         )
         SELECT shadow.id, $1, shadow.current->>'kind',
                (shadow.current->>'sourceEventId')::uuid, shadow.current->>'sourceRef',
                shadow.current->>'path', shadow.current->>'title',
                CASE WHEN shadow.current->>'kind'='file' THEN shadow.current->>'body' ELSE NULL END,
                CASE WHEN shadow.current->>'kind'='fact' THEN shadow.current->>'factType' ELSE NULL END,
                CASE WHEN shadow.current->>'kind'='fact' THEN shadow.current->'value' ELSE NULL END,
                NULLIF(shadow.current->>'sourceUrl', ''), shadow.current->>'contentHash',
                ARRAY(SELECT evidence.value::uuid FROM jsonb_array_elements_text(shadow.current->'evidenceIds') AS evidence(value)),
                COALESCE(shadow.current->>'lifecycleState', 'accepted'),
                COALESCE(shadow.current->>'effectiveFrom', shadow.current->>'updatedAt')::timestamptz,
                NULLIF(shadow.current->>'effectiveTo', '')::timestamptz,
                COALESCE(shadow.current->'links', '[]'::jsonb),
                (shadow.current->>'updatedAt')::timestamptz
           FROM replay_context_shadow shadow
         ON CONFLICT (organization_id, source_ref) DO UPDATE SET
           kind=excluded.kind, source_event_id=excluded.source_event_id, path=excluded.path,
           title=excluded.title, body=excluded.body, fact_type=excluded.fact_type,
           fact_value=excluded.fact_value, source_url=excluded.source_url,
           content_hash=excluded.content_hash, evidence_ids=excluded.evidence_ids,
           lifecycle_state=excluded.lifecycle_state, effective_from=excluded.effective_from,
           effective_to=excluded.effective_to, links=excluded.links,
           updated_at=excluded.updated_at`,
				[this.organizationId],
			);
			await client.query(
				"DELETE FROM work_links WHERE organization_id=$1",
				[this.organizationId],
			);
			for (const task of input.tasks)
				await this.projectAcceptedTask(client, task);
			await client.query(
				`INSERT INTO audit_events
          (id, organization_id, actor, action, target_type, target_id, source_event_id, proposal_id, details)
         VALUES ($1::uuid,$2::uuid,$3,'projection.rebuilt','organization',($2::uuid)::text,NULL,NULL,$4::jsonb)`,
				[
					randomUUID(),
					this.organizationId,
					input.actor,
					JSON.stringify(input.details),
				],
			);
			await client.query("COMMIT");
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async close(): Promise<void> {
		await this.contentReady;

		const leases = [...this.singletonLeases.entries()];

		this.singletonLeases.clear();
		for (const [key, lease] of leases) {
			try {
				await lease.client.query(
					"SELECT pg_advisory_unlock(hashtextextended($1, 0))",
					[key],
				);
			} finally {
				lease.client.release();
			}
		}
		await this.pool.end();
	}

	private async backfillLegacyContent(): Promise<void> {
		const rows = await this.pool.query<{ id: string; payload: JsonValue }>(
			`SELECT se.id, se.payload
         FROM source_events se
         LEFT JOIN source_event_contents sec ON sec.source_event_id=se.id
        WHERE se.organization_id=$1 AND se.payload IS NOT NULL AND sec.source_event_id IS NULL`,
			[this.organizationId],
		);

		for (const row of rows.rows) {
			const encrypted: EncryptedPayload = this.cipher.encrypt(
				row.payload,
			);
			const client = await this.pool.connect();

			try {
				await client.query("BEGIN");
				await client.query(
					`INSERT INTO source_event_contents (source_event_id, ciphertext, iv, auth_tag, key_version)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (source_event_id) DO NOTHING`,
					[
						row.id,
						encrypted.ciphertext,
						encrypted.iv,
						encrypted.authTag,
						encrypted.keyVersion,
					],
				);
				await client.query(
					"UPDATE source_events SET payload=NULL WHERE organization_id=$1 AND id=$2",
					[this.organizationId, row.id],
				);
				await client.query("COMMIT");
			} catch (error) {
				await client.query("ROLLBACK");
				throw error;
			} finally {
				client.release();
			}
		}
	}

	private async revokeMatchingSourceEvents(
		predicateSql: string,
		predicateValues: [string, string, string],
		exceptEventId?: string,
	): Promise<string[]> {
		await this.contentReady;

		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");

			const result = await client.query<{ id: string }>(
				`UPDATE source_events
            SET content_state='revoked', revoked_at=now()
          WHERE organization_id=$1 AND ${predicateSql}
            AND content_state='active'
            AND ($5::uuid IS NULL OR id<>$5::uuid)
        RETURNING id`,
				[
					this.organizationId,
					...predicateValues,
					exceptEventId ?? null,
				],
			);

			if (result.rows.length > 0) {
				const revokedIds = result.rows.map((row) => row.id);

				await client.query(
					"DELETE FROM source_event_contents WHERE source_event_id=ANY($1::uuid[])",
					[revokedIds],
				);
				await this.redactDerivedForRevokedSources(client, revokedIds);
				await client.query(
					"DELETE FROM work_entity_embeddings WHERE organization_id=$1 AND entity_type IN ('task','claim','context','query')",
					[this.organizationId],
				);
				await client.query(
					`DELETE FROM context_document_embeddings idx WHERE idx.organization_id=$1
             AND idx.context_entry_id IN (SELECT ce.id FROM context_entries ce
               WHERE ce.organization_id=$1 AND (ce.source_event_id=ANY($2::uuid[])
                 OR ce.evidence_ids && $2::uuid[]))`,
					[this.organizationId, revokedIds],
				);
				for (const row of result.rows) {
					await client.query(
						`INSERT INTO outbox_jobs (id,organization_id,topic,dedupe_key,payload,state,attempts,available_at)
             VALUES ($1,$2,'evidence.source.revoked',$3,$4::jsonb,'pending',0,now())
             ON CONFLICT (organization_id,dedupe_key) DO NOTHING`,
						[
							randomUUID(),
							this.organizationId,
							`evidence:revoked:${row.id}:start`,
							JSON.stringify({
								eventId: row.id,
								afterTaskId: null,
							}),
						],
					);
				}
			}
			await client.query("COMMIT");
			return result.rows.map((row) => row.id);
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	private async throwProposalFailure(id: string): Promise<void> {
		const proposal = await this.getProposal(id);

		if (!proposal)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		throw new DomainError(
			`Proposal ${id} is already ${proposal.state}.`,
			"CONFLICT",
		);
	}

	private async throwOutboxFailure(
		id: string,
		workerId: string,
	): Promise<never> {
		const result = await this.pool.query<OutboxJobRow>(
			"SELECT * FROM outbox_jobs WHERE organization_id=$1 AND id=$2",
			[this.organizationId, id],
		);

		if (!result.rows[0])
			throw new DomainError(
				`Outbox job ${id} does not exist.`,
				"NOT_FOUND",
			);
		throw new DomainError(
			`Outbox job ${id} is not leased by ${workerId}.`,
			"CONFLICT",
		);
	}

	private async insertDecisionEffects(
		client: PoolClient,
		input: {
			proposalId: string;
			actor: string;
			action: string;
			details: Record<string, JsonValue>;
			topic: string;
			dedupeKey: string;
			payload: JsonValue;
			occurredAt: string;
		},
	): Promise<void> {
		await client.query(
			`INSERT INTO audit_events
        (id, organization_id, actor, action, target_type, target_id, source_event_id, proposal_id, details, occurred_at)
       VALUES ($1,$2,$3,$4,'proposal',$5::text,NULL,$5::uuid,$6::jsonb,$7)`,
			[
				randomUUID(),
				this.organizationId,
				input.actor,
				input.action,
				input.proposalId,
				JSON.stringify(input.details),
				input.occurredAt,
			],
		);
		await client.query(
			`INSERT INTO outbox_jobs
        (id, organization_id, topic, dedupe_key, payload, state, attempts, available_at, created_at, updated_at)
       VALUES ($1,$2,$3,$4,$5::jsonb,'pending',0,$6,$6,$6)
       ON CONFLICT (organization_id, dedupe_key) DO NOTHING`,
			[
				randomUUID(),
				this.organizationId,
				input.topic,
				input.dedupeKey,
				JSON.stringify(input.payload),
				input.occurredAt,
			],
		);
	}

	private async insertTask(client: PoolClient, task: Task): Promise<void> {
		const { id, externalRef, version, createdAt, updatedAt, ...document } =
			task;

		await client.query(
			"INSERT INTO tasks (id, organization_id, external_ref, document, version, created_at, updated_at) VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)",
			[
				id,
				this.organizationId,
				externalRef,
				JSON.stringify(document),
				version,
				createdAt,
				updatedAt,
			],
		);
	}

	private async updateTask(client: PoolClient, task: Task): Promise<void> {
		const { id, externalRef, version, createdAt, updatedAt, ...document } =
			task;
		const result = await client.query(
			"UPDATE tasks SET external_ref=$3, document=$4::jsonb, version=$5, updated_at=$6 WHERE organization_id=$1 AND id=$2 AND version=$7",
			[
				this.organizationId,
				id,
				externalRef,
				JSON.stringify(document),
				version,
				updatedAt,
				version - 1,
			],
		);

		if (result.rowCount !== 1)
			throw new DomainError("Task revision conflict.", "CONFLICT");
	}

	private async projectAcceptedTask(
		client: PoolClient,
		task: Task,
	): Promise<void> {
		await client.query(
			"DELETE FROM work_links WHERE organization_id=$1 AND task_id=$2",
			[this.organizationId, task.id],
		);
		for (const targetRef of [...new Set(task.dependencyRefs)]) {
			if (targetRef === task.externalRef) continue;
			await client.query(
				`INSERT INTO work_links
          (id, organization_id, task_id, target_task_id, target_ref, link_type)
         VALUES (
           $1,$2,$3,
           (SELECT id FROM tasks WHERE organization_id=$2 AND external_ref=$4 LIMIT 1),
           $4,'depends_on'
         )
         ON CONFLICT (task_id, target_ref, link_type) DO UPDATE SET
           target_task_id=excluded.target_task_id, updated_at=now()`,
				[randomUUID(), this.organizationId, task.id, targetRef],
			);
		}
		if (task.externalRef) {
			await client.query(
				`UPDATE work_links SET target_task_id=$3, updated_at=now()
          WHERE organization_id=$1 AND target_ref=$2 AND task_id<>$3`,
				[this.organizationId, task.externalRef, task.id],
			);
		}
	}
}
