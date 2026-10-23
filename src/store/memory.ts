import { randomUUID } from "node:crypto";
import { contextEntryFromProposal } from "../domain/context-catalog.js";
import { DomainError } from "../domain/errors.js";
import {
	agentWorkspaceUri,
	normalizeAgentWorkspacePath,
	validateAgentWorkspaceContent,
} from "../domain/agent-workspace.js";
import { isInterpretationEligibleSourceEvent } from "../domain/source-event-policy.js";
import { observationIdentity } from "../intelligence/observation-identity.js";
import { validateClaimBody } from "../intelligence/claim-validation.js";
import {
	decideEvidenceApplication,
	explicitlyAssertsTaskDone,
} from "../intelligence/decision-policy.js";
import { authorizedStatusAttestation } from "../intelligence/authority-policy.js";
import { contentHash } from "../domain/content-hash.js";
import type {
	DecisionMetadata,
	EvidenceAssessment,
	EvidenceClaim,
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
	type AgentProfile,
	type AgentDataScope,
	type AgentWorkspaceFile,
	type AgentWorkspaceFileSummary,
	type AgentWorkspaceWrite,
	type AgentDevice,
	type AuditEvent,
	type ContextEntry,
	type ContextRevision,
	type ConnectorSyncState,
	type ConnectorSyncStateUpdate,
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
} from "../intelligence/types.js";
import {
	acceptedTaskChanges,
	applyTaskChanges,
	compileTaskPatch,
	taskFieldsFromCreate,
} from "./task-changes.js";

const copy = <T>(value: T): T => structuredClone(value);

type StoredAgentProfile = AgentProfile & { tokenHash: string };

function workSlug(value: string): string {
	return (
		value
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 100) || "project"
	);
}

function publicAgent(profile: StoredAgentProfile): AgentProfile {
	const { tokenHash: _tokenHash, ...safe } = profile;

	return copy(safe);
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

export class MemoryLedgerStore implements LedgerStore {
	private readonly organization: Organization;
	private readonly members: Member[];
	private readonly memberIdentities: MemberIdentity[] = [];
	private readonly installations = new Map<string, SourceInstallation>();
	private readonly connectorSyncs = new Map<string, ConnectorSyncState>();
	private readonly singletonLeases = new Map<string, string>();
	private readonly audits: AuditEvent[] = [];
	private readonly outboxJobs = new Map<string, OutboxJob>();
	private readonly agents = new Map<string, StoredAgentProfile>();
	private readonly agentWorkspace = new Map<
		string,
		Array<
			AgentWorkspaceFile | (AgentWorkspaceFileSummary & { content: null })
		>
	>();
	private readonly devices = new Map<string, AgentDevice>();
	private readonly repositoryMappings = new Map<string, RepositoryMapping>();
	private readonly eventsByProviderId = new Map<
		string,
		EventAppendResult["event"]
	>();
	private readonly revokedEventIds = new Set<string>();
	private readonly contextBySourceRef = new Map<string, ContextEntry>();
	private readonly contextRevisions = new Map<string, ContextRevision[]>();
	private readonly proposals = new Map<string, Proposal>();
	private readonly tasks = new Map<string, Task>();
	private readonly projects = new Map<string, Project>();
	private readonly projectProposals = new Map<string, ProjectProposal>();
	private readonly projectRevisions = new Map<string, ProjectRevision[]>();
	private readonly workstreams = new Map<string, Workstream>();
	private readonly workLinks = new Map<string, WorkLink>();
	private readonly workLinkRevisions = new Map<string, WorkLinkRevision[]>();
	private readonly revisions = new Map<string, TaskRevision[]>();
	private readonly interpretationRuns = new Map<string, InterpretationRun>();
	private readonly v2RunMetadata = new Map<string, V2RunCreate>();
	private readonly observationAgentCheckpoints = new Map<
		string,
		import("../domain/evidence-store.js").ObservationAgentCheckpoint
	>();
	private readonly evidenceBudgets = new Map<string, InferenceBudget>();
	private readonly modelCalls = new Map<string, ModelCall>();
	private readonly modelCallResponses = new Map<string, JsonValue>();
	private readonly modelCallContextSourceIds = new Map<string, string[]>();
	private readonly budgetTokenTotals = new Map<
		string,
		{
			reservedInput: number;
			reservedOutput: number;
			spentInput: number;
			spentOutput: number;
			reservedUsd: number;
			spentUsd: number;
		}
	>();
	private readonly modelCallReservedUsd = new Map<string, number>();
	private readonly dispositions = new Map<string, ObservationDisposition>();
	private readonly evidenceClaims = new Map<string, EvidenceClaim>();
	private readonly evidenceAssessments = new Map<
		string,
		EvidenceAssessment
	>();
	private readonly workEntityVectors = new Map<string, number[]>();

	constructor(
		organizationName = "Panini workspace",
		organizationId = "00000000-0000-4000-8000-000000000001",
	) {
		const now = new Date().toISOString();

		this.organization = {
			id: organizationId,
			slug: "default",
			name: organizationName,
			createdAt: now,
			updatedAt: now,
		};
		this.members = [
			{
				id: "00000000-0000-4000-8000-000000000002",
				organizationId: this.organization.id,
				subject: "bootstrap:local-admin",
				displayName: "Local administrator",
				email: null,
				role: "owner",
				status: "active",
				createdAt: now,
				updatedAt: now,
			},
		];
	}

	async getOrganization(): Promise<Organization> {
		return copy(this.organization);
	}

	async setOrganizationName(name: string): Promise<Organization> {
		this.organization.name = name;
		this.organization.updatedAt = new Date().toISOString();
		return copy(this.organization);
	}

	async listMembers(): Promise<Member[]> {
		return this.members.map(copy);
	}

	async getMember(id: string): Promise<Member | null> {
		const member = this.members.find((candidate) => candidate.id === id);

		return member ? copy(member) : null;
	}

	async upsertMember(input: NewMember): Promise<Member> {
		const subject = input.subject.trim();
		const displayName = input.displayName.trim();

		if (!subject || !displayName)
			throw new DomainError(
				"A member requires a subject and display name.",
				"INVALID",
			);

		const existing = this.members.find(
			(member) => member.subject === subject,
		);
		const now = new Date().toISOString();

		if (existing) {
			existing.displayName = displayName;
			existing.email =
				input.email === undefined ? existing.email : input.email;
			existing.status = input.status ?? existing.status;
			if (input.role) existing.role = input.role;
			existing.updatedAt = now;
			return copy(existing);
		}

		const member: Member = {
			id: randomUUID(),
			organizationId: this.organization.id,
			subject,
			displayName,
			email: input.email ?? null,
			role: input.role ?? "member",
			status: input.status ?? "active",
			createdAt: now,
			updatedAt: now,
		};

		this.members.push(member);
		return copy(member);
	}

	async listMemberIdentities(): Promise<MemberIdentity[]> {
		return this.memberIdentities.map(copy);
	}

	async reconcileMemberIdentity(
		input: NewMemberIdentity,
	): Promise<MemberIdentityReconciliation> {
		const installationKey = input.installationKey.trim();
		const externalId = input.externalId.trim();
		const displayName = input.displayName?.trim() || null;
		const email = input.email?.trim().toLocaleLowerCase("en") || null;
		const status = input.status ?? "active";

		if (!installationKey || !externalId) {
			throw new DomainError(
				"A member identity requires an installation key and external ID.",
				"INVALID",
			);
		}

		const now = new Date().toISOString();
		const existingIdentity = this.memberIdentities.find(
			(identity) =>
				identity.provider === input.provider &&
				identity.installationKey === installationKey &&
				identity.externalId === externalId,
		);

		if (existingIdentity) {
			existingIdentity.displayName =
				displayName ?? existingIdentity.displayName;
			existingIdentity.email = email ?? existingIdentity.email;
			existingIdentity.status = status;
			existingIdentity.updatedAt = now;
			if (existingIdentity.memberId) {
				const member = this.members.find(
					(candidate) => candidate.id === existingIdentity.memberId,
				);

				if (!member)
					throw new DomainError(
						"The member identity references a missing member.",
						"NOT_FOUND",
					);
				if (
					displayName &&
					member.subject ===
						memberIdentitySubject({
							...input,
							installationKey,
							externalId,
						})
				) {
					member.displayName = displayName;
				}
				if (
					email &&
					(!member.email ||
						member.subject ===
							memberIdentitySubject({
								...input,
								installationKey,
								externalId,
							}))
				) {
					member.email = email;
				}

				const identities = this.memberIdentities.filter(
					(identity) => identity.memberId === member.id,
				);

				if (status === "active") member.status = "active";
				else if (
					identities.some((identity) => identity.status === "active")
				)
					member.status = "active";
				else if (
					identities.some(
						(identity) =>
							member.subject === memberIdentitySubject(identity),
					)
				)
					member.status = "disabled";
				member.updatedAt = now;
				return {
					member: copy(member),
					identity: copy(existingIdentity),
					matchedBy: "identity",
				};
			}
		}

		let matchedBy: MemberIdentityReconciliation["matchedBy"] = "created";
		let candidates = email
			? this.members.filter(
					(member) =>
						member.email?.trim().toLocaleLowerCase("en") === email,
				)
			: [];

		if (candidates.length === 1) {
			matchedBy = "email";
		} else if (displayName) {
			const normalizedName = normalizedIdentityName(displayName!);

			candidates = this.members.filter(
				(member) =>
					member.subject !== "bootstrap:local-admin" &&
					normalizedIdentityName(member.displayName) ===
						normalizedName,
			);
			matchedBy = candidates.length === 1 ? "display_name" : "created";
		}

		let member = candidates.length === 1 ? candidates[0]! : undefined;

		if (!member && !displayName) {
			const identity =
				existingIdentity ??
				({
					id: randomUUID(),
					organizationId: this.organization.id,
					memberId: null,
					provider: input.provider,
					installationKey,
					externalId,
					displayName: null,
					email,
					status,
					createdAt: now,
					updatedAt: now,
				} satisfies MemberIdentity);

			identity.email = email;
			identity.status = status;
			identity.updatedAt = now;
			if (!existingIdentity) this.memberIdentities.push(identity);
			return {
				member: null,
				identity: copy(identity),
				matchedBy: "unresolved",
			};
		}
		if (!member) {
			member = {
				id: randomUUID(),
				organizationId: this.organization.id,
				subject: memberIdentitySubject({
					...input,
					installationKey,
					externalId,
				}),
				displayName: displayName!,
				email,
				role: "member",
				status,
				createdAt: now,
				updatedAt: now,
			};
			this.members.push(member);
		} else {
			if (email && !member.email) member.email = email;
			if (status === "active") member.status = "active";
			member.updatedAt = now;
		}

		const identity =
			existingIdentity ??
			({
				id: randomUUID(),
				organizationId: this.organization.id,
				memberId: member.id,
				provider: input.provider,
				installationKey,
				externalId,
				displayName,
				email,
				status,
				createdAt: now,
				updatedAt: now,
			} satisfies MemberIdentity);

		identity.memberId = member.id;
		identity.displayName = displayName;
		identity.email = email;
		identity.status = status;
		identity.updatedAt = now;
		if (!existingIdentity) this.memberIdentities.push(identity);
		return { member: copy(member), identity: copy(identity), matchedBy };
	}

	async upsertSourceInstallation(
		input: NewSourceInstallation,
	): Promise<SourceInstallation> {
		const key = `${input.provider}:${input.installationKey}`;
		const existing = this.installations.get(key);
		const now = new Date().toISOString();
		const installation: SourceInstallation = {
			id: existing?.id ?? randomUUID(),
			organizationId: this.organization.id,
			provider: input.provider,
			installationKey: input.installationKey,
			displayName: input.displayName,
			transport: input.transport,
			status: input.status ?? existing?.status ?? "configured",
			config: copy(input.config ?? existing?.config ?? {}),
			lastSyncAt: existing?.lastSyncAt ?? null,
			lastSuccessAt: existing?.lastSuccessAt ?? null,
			lastEventAt: existing?.lastEventAt ?? null,
			lastError: existing?.lastError ?? null,
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		this.installations.set(key, installation);
		return copy(installation);
	}

	async getSourceInstallation(
		provider: string,
		installationKey: string,
	): Promise<SourceInstallation | null> {
		const installation = this.installations.get(
			`${provider}:${installationKey}`,
		);

		return installation ? copy(installation) : null;
	}

	async listSourceInstallations(): Promise<SourceInstallation[]> {
		return [...this.installations.values()]
			.sort((a, b) => a.displayName.localeCompare(b.displayName))
			.map(copy);
	}

	async updateSourceInstallation(
		id: string,
		update: SourceInstallationUpdate,
	): Promise<SourceInstallation> {
		const found = [...this.installations.entries()].find(
			([, installation]) => installation.id === id,
		);

		if (!found)
			throw new DomainError(
				`Source installation ${id} does not exist.`,
				"NOT_FOUND",
			);

		const [key, installation] = found;
		const updated: SourceInstallation = {
			...installation,
			...copy(update),
			config: update.config ? copy(update.config) : installation.config,
			updatedAt: new Date().toISOString(),
		};

		this.installations.set(key, updated);
		return copy(updated);
	}

	async upsertConnectorSyncState(
		installationId: string,
		resourceKey: string,
		update: ConnectorSyncStateUpdate,
	): Promise<ConnectorSyncState> {
		if (
			![...this.installations.values()].some(
				(installation) => installation.id === installationId,
			)
		) {
			throw new DomainError(
				`Source installation ${installationId} does not exist.`,
				"NOT_FOUND",
			);
		}

		const key = `${installationId}:${resourceKey}`;
		const current = this.connectorSyncs.get(key);
		const now = new Date().toISOString();
		const state: ConnectorSyncState = {
			id: current?.id ?? randomUUID(),
			organizationId: this.organization.id,
			installationId,
			resourceKey,
			status: update.status ?? current?.status ?? "idle",
			cursor: copy(update.cursor ?? current?.cursor ?? {}),
			lastAttemptAt:
				update.lastAttemptAt === undefined
					? (current?.lastAttemptAt ?? null)
					: update.lastAttemptAt,
			lastSuccessAt:
				update.lastSuccessAt === undefined
					? (current?.lastSuccessAt ?? null)
					: update.lastSuccessAt,
			lastRepairAt:
				update.lastRepairAt === undefined
					? (current?.lastRepairAt ?? null)
					: update.lastRepairAt,
			lastError:
				update.lastError === undefined
					? (current?.lastError ?? null)
					: update.lastError,
			observedCount: update.observedCount ?? current?.observedCount ?? 0,
			revokedCount: update.revokedCount ?? current?.revokedCount ?? 0,
			createdAt: current?.createdAt ?? now,
			updatedAt: now,
		};

		this.connectorSyncs.set(key, state);
		return copy(state);
	}

	async getConnectorSyncState(
		installationId: string,
		resourceKey: string,
	): Promise<ConnectorSyncState | null> {
		const state = this.connectorSyncs.get(
			`${installationId}:${resourceKey}`,
		);

		return state ? copy(state) : null;
	}

	async listConnectorSyncStates(
		installationId?: string,
	): Promise<ConnectorSyncState[]> {
		return [...this.connectorSyncs.values()]
			.filter(
				(state) =>
					!installationId || state.installationId === installationId,
			)
			.sort((left, right) =>
				left.resourceKey.localeCompare(right.resourceKey),
			)
			.map(copy);
	}

	async acquireSingletonLease(key: string, owner: string): Promise<boolean> {
		const current = this.singletonLeases.get(key);

		if (current && current !== owner) return false;
		this.singletonLeases.set(key, owner);
		return true;
	}

	async releaseSingletonLease(key: string, owner: string): Promise<void> {
		if (this.singletonLeases.get(key) === owner)
			this.singletonLeases.delete(key);
	}

	async appendAuditEvent(input: NewAuditEvent): Promise<AuditEvent> {
		const audit: AuditEvent = {
			...copy(input),
			id: randomUUID(),
			organizationId: this.organization.id,
			occurredAt: input.occurredAt ?? new Date().toISOString(),
		};

		this.audits.push(audit);
		return copy(audit);
	}

	async listAuditEvents(limit: number): Promise<AuditEvent[]> {
		return this.audits
			.toSorted((a, b) => b.occurredAt.localeCompare(a.occurredAt))
			.slice(0, limit)
			.map(copy);
	}

	async enqueueOutboxJob(input: NewOutboxJob): Promise<OutboxJob> {
		const existing = [...this.outboxJobs.values()].find(
			(job) => job.dedupeKey === input.dedupeKey,
		);

		if (existing) return copy(existing);

		const now = new Date().toISOString();
		const job: OutboxJob = {
			id: randomUUID(),
			organizationId: this.organization.id,
			topic: input.topic,
			dedupeKey: input.dedupeKey,
			payload: copy(input.payload),
			state: "pending",
			attempts: 0,
			availableAt: input.availableAt ?? now,
			lockedAt: null,
			lockedBy: null,
			completedAt: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		};

		this.outboxJobs.set(job.id, job);
		return copy(job);
	}

	async listOutboxJobs(limit: number): Promise<OutboxJob[]> {
		return [...this.outboxJobs.values()]
			.sort((left, right) =>
				right.createdAt.localeCompare(left.createdAt),
			)
			.slice(0, limit)
			.map(copy);
	}

	async getLatestTaskSearchCursor(
		taskId: string,
		dispatchEpoch: string,
		identityHash: string,
	): Promise<string | null> {
		const recent = [...this.outboxJobs.values()]
			.filter(
				(job) =>
					job.topic === "evidence.task.search_manifest" &&
					job.state === "completed" &&
					job.payload &&
					typeof job.payload === "object" &&
					!Array.isArray(job.payload) &&
					job.payload.taskId === taskId &&
					job.payload.dispatchEpoch === dispatchEpoch,
			)
			.sort(
				(left, right) =>
					(right.completedAt ?? right.createdAt).localeCompare(
						left.completedAt ?? left.createdAt,
					) || right.id.localeCompare(left.id),
			)[0];
		const payload = recent?.payload;

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
		const now = new Date();
		const expiredBefore = new Date(
			now.getTime() - leaseSeconds * 1_000,
		).toISOString();
		const claimed = [...this.outboxJobs.values()]
			.filter(
				(job) =>
					(job.state === "pending" &&
						job.availableAt <= now.toISOString()) ||
					(job.state === "running" &&
						Boolean(job.lockedAt && job.lockedAt <= expiredBefore)),
			)
			.sort(
				(left, right) =>
					left.availableAt.localeCompare(right.availableAt) ||
					left.createdAt.localeCompare(right.createdAt),
			)
			.slice(0, limit)
			.map((job) => ({
				...job,
				state: "running" as const,
				attempts: job.attempts + 1,
				lockedAt: now.toISOString(),
				lockedBy: workerId,
				updatedAt: now.toISOString(),
			}));

		for (const job of claimed) this.outboxJobs.set(job.id, job);
		return claimed.map(copy);
	}

	async completeOutboxJob(id: string, workerId: string): Promise<OutboxJob> {
		const job = this.outboxJobs.get(id);

		if (!job)
			throw new DomainError(
				`Outbox job ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (job.state !== "running" || job.lockedBy !== workerId) {
			throw new DomainError(
				`Outbox job ${id} is not leased by ${workerId}.`,
				"CONFLICT",
			);
		}

		const now = new Date().toISOString();
		const completed: OutboxJob = {
			...job,
			state: "completed",
			completedAt: now,
			lockedAt: null,
			lockedBy: null,
			lastError: null,
			updatedAt: now,
		};

		this.outboxJobs.set(id, completed);
		return copy(completed);
	}

	async failOutboxJob(
		id: string,
		workerId: string,
		error: string,
		retryAt: string | null,
	): Promise<OutboxJob> {
		const job = this.outboxJobs.get(id);

		if (!job)
			throw new DomainError(
				`Outbox job ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (job.state !== "running" || job.lockedBy !== workerId) {
			throw new DomainError(
				`Outbox job ${id} is not leased by ${workerId}.`,
				"CONFLICT",
			);
		}

		const now = new Date().toISOString();
		const failed: OutboxJob = {
			...job,
			state: retryAt ? "pending" : "failed",
			availableAt: retryAt ?? job.availableAt,
			lockedAt: null,
			lockedBy: null,
			completedAt: null,
			lastError: error.slice(0, 4_000),
			updatedAt: now,
		};

		this.outboxJobs.set(id, failed);
		return copy(failed);
	}

	async createAgentProfile(input: NewAgentProfile): Promise<AgentProfile> {
		const duplicate = [...this.agents.values()].find(
			(profile) =>
				profile.memberId === input.memberId &&
				profile.name.toLowerCase() === input.name.toLowerCase(),
		);

		if (duplicate)
			throw new DomainError(
				`Agent ${input.name} already exists for ${input.owner}.`,
				"CONFLICT",
			);

		const now = new Date().toISOString();
		const stored: StoredAgentProfile = {
			id: randomUUID(),
			memberId: input.memberId,
			owner: input.owner,
			name: input.name,
			harness: input.harness,
			description: input.description,
			capabilities: copy(input.capabilities),
			dataScope: copy(input.dataScope),
			status: "active",
			tokenHash: input.tokenHash,
			tokenHint: input.tokenHint,
			createdAt: now,
			updatedAt: now,
			lastUsedAt: null,
		};

		this.agents.set(stored.id, stored);
		return publicAgent(stored);
	}

	async updateAgentDataScope(
		id: string,
		dataScope: AgentDataScope,
	): Promise<AgentProfile> {
		const profile = this.agents.get(id);

		if (!profile || profile.status !== "active")
			throw new DomainError(
				`Active agent profile ${id} does not exist.`,
				"NOT_FOUND",
			);

		const updated = {
			...profile,
			dataScope: copy(dataScope),
			updatedAt: new Date().toISOString(),
		};

		this.agents.set(id, updated);
		return publicAgent(updated);
	}

	async getAgentProfile(id: string): Promise<AgentProfile | null> {
		const profile = this.agents.get(id);

		return profile ? publicAgent(profile) : null;
	}

	async listAgentProfiles(memberId?: string): Promise<AgentProfile[]> {
		return [...this.agents.values()]
			.filter((profile) => !memberId || profile.memberId === memberId)
			.sort((left, right) =>
				right.updatedAt.localeCompare(left.updatedAt),
			)
			.map(publicAgent);
	}

	async findActiveAgentByTokenHash(
		tokenHash: string,
	): Promise<AgentProfile | null> {
		const profile = [...this.agents.values()].find(
			(candidate) =>
				candidate.status === "active" &&
				candidate.tokenHash === tokenHash,
		);

		return profile ? publicAgent(profile) : null;
	}

	async rotateAgentToken(
		id: string,
		tokenHash: string,
		tokenHint: string,
	): Promise<AgentProfile> {
		const profile = this.agents.get(id);

		if (!profile)
			throw new DomainError(
				`Agent profile ${id} does not exist.`,
				"NOT_FOUND",
			);

		const updated: StoredAgentProfile = {
			...profile,
			tokenHash,
			tokenHint,
			status: "active",
			updatedAt: new Date().toISOString(),
		};

		this.agents.set(id, updated);
		return publicAgent(updated);
	}

	async revokeAgentProfile(id: string): Promise<AgentProfile> {
		const profile = this.agents.get(id);

		if (!profile)
			throw new DomainError(
				`Agent profile ${id} does not exist.`,
				"NOT_FOUND",
			);

		const updated: StoredAgentProfile = {
			...profile,
			status: "revoked",
			updatedAt: new Date().toISOString(),
		};

		this.agents.set(id, updated);
		return publicAgent(updated);
	}

	async touchAgentProfile(id: string): Promise<void> {
		const profile = this.agents.get(id);

		if (profile)
			this.agents.set(id, {
				...profile,
				lastUsedAt: new Date().toISOString(),
			});
	}

	private workspaceProfile(
		memberId: string,
		agentProfileId: string,
	): StoredAgentProfile {
		const profile = this.agents.get(agentProfileId);

		if (
			!profile ||
			profile.status !== "active" ||
			profile.memberId !== memberId
		) {
			throw new DomainError(
				"Agent workspace is unavailable.",
				"FORBIDDEN",
			);
		}
		return profile;
	}

	async getAgentWorkspaceFile(
		memberId: string,
		agentProfileId: string,
		path: string,
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFile | null> {
		this.workspaceProfile(memberId, agentProfileId);

		const key = agentWorkspaceUri(
			memberId,
			scope === "user" ? "user" : agentProfileId,
			path,
		);
		const latest = this.agentWorkspace.get(key)?.at(-1);

		return latest?.content === null || !latest ? null : copy(latest);
	}

	async listAgentWorkspaceFiles(
		memberId: string,
		agentProfileId: string,
		prefix: string,
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFileSummary[]> {
		this.workspaceProfile(memberId, agentProfileId);

		const normalizedPrefix = prefix
			? normalizeAgentWorkspacePath(prefix)
			: "";

		return [...this.agentWorkspace.values()]
			.map((revisions) => revisions.at(-1)!)
			.filter(
				(file) =>
					file.uri.startsWith(
						`panini://${memberId}/${scope === "user" ? "user" : agentProfileId}/`,
					) &&
					file.content !== null &&
					(!normalizedPrefix ||
						file.path === normalizedPrefix ||
						file.path.startsWith(`${normalizedPrefix}/`)),
			)
			.map(({ content: _content, ...summary }) => copy(summary))
			.sort((left, right) => left.path.localeCompare(right.path));
	}

	async writeAgentWorkspaceFile(
		input: AgentWorkspaceWrite,
	): Promise<AgentWorkspaceFileSummary> {
		this.workspaceProfile(input.memberId, input.agentProfileId);

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

		const scope = input.scope ?? "agent";
		const uri = agentWorkspaceUri(
			input.memberId,
			scope === "user" ? "user" : input.agentProfileId,
			path,
		);
		const revisions = this.agentWorkspace.get(uri) ?? [];
		const currentVersion = revisions.at(-1)?.version ?? 0;

		if (currentVersion !== input.expectedVersion)
			throw new DomainError("Agent file revision conflict.", "CONFLICT");
		if (input.content === null && currentVersion === 0)
			throw new DomainError("Agent file does not exist.", "NOT_FOUND");

		const now = new Date().toISOString();
		const file = {
			uri,
			path,
			version: currentVersion + 1,
			byteSize:
				input.content === null
					? 0
					: Buffer.byteLength(input.content, "utf8"),
			updatedAt: now,
			content: input.content,
		};

		revisions.push(file);
		this.agentWorkspace.set(uri, revisions);
		this.audits.push({
			id: randomUUID(),
			organizationId: this.organization.id,
			actor: `agent:${input.agentProfileId}`,
			action: `${scope}_workspace.${input.content === null ? "deleted" : "written"}`,
			targetType: `${scope}_workspace_file`,
			targetId: uri,
			sourceEventId: null,
			proposalId: null,
			details: { version: file.version, byteSize: file.byteSize },
			occurredAt: now,
		});

		const { content: _content, ...summary } = file;

		return copy(summary);
	}

	async createAgentDevice(input: NewAgentDevice): Promise<AgentDevice> {
		if (!this.agents.has(input.agentProfileId)) {
			throw new DomainError(
				`Agent profile ${input.agentProfileId} does not exist.`,
				"NOT_FOUND",
			);
		}

		const duplicate = [...this.devices.values()].find(
			(device) =>
				device.agentProfileId === input.agentProfileId &&
				device.name.toLowerCase() === input.name.toLowerCase(),
		);

		if (duplicate)
			throw new DomainError(
				`Device ${input.name} already exists for this agent.`,
				"CONFLICT",
			);

		const now = new Date().toISOString();
		const device: AgentDevice = {
			id: randomUUID(),
			organizationId: this.organization.id,
			agentProfileId: input.agentProfileId,
			name: input.name,
			publicKey: input.publicKey,
			status: "active",
			privacyMode: input.privacyMode,
			lastSeenAt: null,
			createdAt: now,
			updatedAt: now,
		};

		this.devices.set(device.id, device);
		return copy(device);
	}

	async listAgentDevices(agentProfileId?: string): Promise<AgentDevice[]> {
		return [...this.devices.values()]
			.filter(
				(device) =>
					!agentProfileId || device.agentProfileId === agentProfileId,
			)
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map(copy);
	}

	async getAgentDevice(id: string): Promise<AgentDevice | null> {
		const device = this.devices.get(id);

		return device ? copy(device) : null;
	}

	async revokeAgentDevice(id: string): Promise<AgentDevice> {
		const device = this.devices.get(id);

		if (!device)
			throw new DomainError(
				`Agent device ${id} does not exist.`,
				"NOT_FOUND",
			);

		const updated = {
			...device,
			status: "revoked" as const,
			updatedAt: new Date().toISOString(),
		};

		this.devices.set(id, updated);
		return copy(updated);
	}

	async touchAgentDevice(id: string): Promise<void> {
		const device = this.devices.get(id);

		if (device)
			this.devices.set(id, {
				...device,
				lastSeenAt: new Date().toISOString(),
			});
	}

	async upsertRepositoryMapping(
		input: NewRepositoryMapping,
	): Promise<RepositoryMapping> {
		const key = input.repository.toLowerCase();
		const existing = this.repositoryMappings.get(key);
		const now = new Date().toISOString();
		const mapping: RepositoryMapping = {
			id: existing?.id ?? randomUUID(),
			organizationId: this.organization.id,
			repository: input.repository,
			project: input.project,
			contextPaths: copy(input.contextPaths),
			createdAt: existing?.createdAt ?? now,
			updatedAt: now,
		};

		this.repositoryMappings.set(key, mapping);
		return copy(mapping);
	}

	async listRepositoryMappings(): Promise<RepositoryMapping[]> {
		return [...this.repositoryMappings.values()]
			.sort((a, b) => a.repository.localeCompare(b.repository))
			.map(copy);
	}

	async appendSourceEvent(
		input: SourceEventInput,
	): Promise<EventAppendResult> {
		const key = `${input.provider}:${input.installationKey}:${input.providerEventId}`;
		const existing = this.eventsByProviderId.get(key);

		if (existing) return { inserted: false, event: copy(existing) };
		if (input.supersedesEventId) {
			const previous = [...this.eventsByProviderId.values()].find(
				(event) => event.id === input.supersedesEventId,
			);

			if (
				!previous ||
				previous.provider !== input.provider ||
				previous.installationKey !== input.installationKey ||
				previous.sourceRef !== input.sourceRef ||
				(!/delet/i.test(input.eventKind) &&
					Date.parse(input.occurredAt) <=
						Date.parse(previous.occurredAt))
			) {
				throw new DomainError(
					"Source supersession order or object is invalid.",
					"INVALID",
				);
			}
		}

		const event = {
			...copy(input),
			observationIdentity: observationIdentity(input),
			authorizationVersion: 1,
			supersedesEventId: input.supersedesEventId ?? null,
			id: randomUUID(),
			receivedAt: new Date().toISOString(),
		};

		this.eventsByProviderId.set(key, event);
		await this.enqueueOutboxJob({
			topic: "evidence.source.recorded",
			dedupeKey: `evidence:source:recorded:${event.id}`,
			payload: {
				eventId: event.id,
				sourceVersionKey:
					event.observationIdentity?.sourceVersionKey ?? null,
			},
			availableAt: event.receivedAt,
		});
		if (input.supersedesEventId) {
			await this.enqueueOutboxJob({
				topic: "evidence.source.superseded",
				dedupeKey: `evidence:superseded:${input.supersedesEventId}:${event.id}:start`,
				payload: {
					eventId: input.supersedesEventId,
					newEventId: event.id,
					afterTaskId: null,
				},
				availableAt: event.receivedAt,
			});
		}
		return { inserted: true, event: copy(event) };
	}

	async getWorkEntityEmbedding(input: {
		entityType: "task" | "project" | "claim" | "context" | "query";
		entityId: string;
		model: string;
		modelVersion: string;
		inputHash: string;
		permissionFingerprint: string;
	}): Promise<number[] | null> {
		return copy(this.workEntityVectors.get(JSON.stringify(input)) ?? null);
	}

	async getEvidenceAccessVersion(): Promise<string> {
		return [...this.revokedEventIds].sort().join(":");
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
		return [...this.contextBySourceRef.values()]
			.filter(
				(entry) =>
					(entry.sourceEventId === eventId ||
						entry.evidenceIds.includes(eventId)) &&
					(!afterEntryId || entry.id > afterEntryId),
			)
			.map((entry) => entry.id)
			.sort()
			.slice(0, limit);
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

		const { vector, ...key } = input;

		this.workEntityVectors.set(JSON.stringify(key), copy(vector));
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

		const budget: InferenceBudget = {
			id: randomUUID(),
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

		this.evidenceBudgets.set(budget.id, budget);
		this.budgetTokenTotals.set(budget.id, {
			reservedInput: 0,
			reservedOutput: 0,
			spentInput: 0,
			spentOutput: 0,
			reservedUsd: 0,
			spentUsd: 0,
		});
		return copy(budget);
	}

	async getInferenceBudget(id: string): Promise<InferenceBudget | null> {
		const budget = this.evidenceBudgets.get(id);
		const totals = this.budgetTokenTotals.get(id);

		return budget && totals
			? {
					...copy(budget),
					reservedInputTokens: totals.reservedInput,
					spentInputTokens: totals.spentInput,
					reservedOutputTokens: totals.reservedOutput,
					spentOutputTokens: totals.spentOutput,
					reservedUsd: totals.reservedUsd.toFixed(8),
					spentUsd: totals.spentUsd.toFixed(8),
				}
			: null;
	}

	async reserveModelCall(
		input: ReserveCallInput,
	): Promise<
		| { kind: "reserved"; call: ModelCall }
		| { kind: "exhausted"; reason: string }
	> {
		const contextualSourceEventIds = [
			...new Set(input.contextualSourceEventIds ?? []),
		].sort();
		const run = this.interpretationRuns.get(input.runId);

		if (
			!run ||
			[...run.eventIds, ...contextualSourceEventIds].some(
				(id) =>
					this.revokedEventIds.has(id) ||
					![...this.eventsByProviderId.values()].some(
						(event) => event.id === id,
					),
			)
		) {
			throw new DomainError(
				"Model call source was unavailable before reservation.",
				"CONFLICT",
			);
		}
		if (
			(await this.currentSourceEventIds(contextualSourceEventIds))
				.length !== contextualSourceEventIds.length
		) {
			throw new DomainError(
				"Model call context source was superseded.",
				"CONFLICT",
			);
		}

		const budget = this.evidenceBudgets.get(input.budgetId);
		const totals = this.budgetTokenTotals.get(input.budgetId);

		if (!budget || !totals)
			throw new DomainError(
				"Inference budget was not found.",
				"NOT_FOUND",
			);

		const previous = [...this.modelCalls.values()].find(
			(call) =>
				call.logicalCallKey === input.logicalCallKey &&
				call.attempt === input.attempt,
		);

		if (previous) {
			if (
				previous.requestHash !== input.requestHash ||
				previous.budgetId !== input.budgetId ||
				previous.runId !== input.runId ||
				contentHash(
					this.modelCallContextSourceIds.get(previous.id) ?? [],
				) !== contentHash(contextualSourceEventIds)
			) {
				throw new DomainError(
					"Model call key belongs to a different request.",
					"CONFLICT",
				);
			}
			return { kind: "reserved", call: copy(previous) };
		}
		if (!this.interpretationRuns.has(input.runId))
			throw new DomainError("V2 run was not found.", "NOT_FOUND");

		const reason =
			budget.state !== "active"
				? `budget_${budget.state}`
				: Date.parse(budget.deadline) <= Date.now()
					? "deadline_exceeded"
					: budget.spentCalls + budget.reservedCalls + 1 >
						  budget.maxCalls
						? "call_cap"
						: totals.spentInput +
									totals.reservedInput +
									input.estimatedInputTokens >
							  budget.maxInputTokens
							? "input_token_cap"
							: totals.spentOutput +
										totals.reservedOutput +
										input.estimatedOutputTokens >
								  budget.maxOutputTokens
								? "output_token_cap"
								: budget.maxUsd !== null &&
									  input.estimatedUsd === null
									? "price_unknown"
									: budget.maxUsd !== null &&
										  totals.spentUsd +
												totals.reservedUsd +
												Number(input.estimatedUsd) >
												Number(budget.maxUsd)
										? "usd_cap"
										: null;

		if (reason) return { kind: "exhausted", reason };

		const call: ModelCall = {
			id: randomUUID(),
			budgetId: budget.id,
			runId: input.runId,
			purpose: input.purpose,
			logicalCallKey: input.logicalCallKey,
			attempt: input.attempt,
			provider: input.provider,
			model: input.model,
			state: "reserved",
			requestHash: input.requestHash,
			cacheKey: input.cacheKey,
			reservedInputTokens: input.estimatedInputTokens,
			reservedOutputTokens: input.estimatedOutputTokens,
			inputTokens: null,
			cachedInputTokens: null,
			outputTokens: null,
			embeddingItems: null,
			costUsd: null,
			costBasis: "unknown",
			providerRequestId: null,
			errorCode: null,
			createdAt: new Date().toISOString(),
			dispatchedAt: null,
			finishedAt: null,
		};

		budget.reservedCalls += 1;
		totals.reservedInput += input.estimatedInputTokens;
		totals.reservedOutput += input.estimatedOutputTokens;
		totals.reservedUsd += Number(input.estimatedUsd ?? 0);
		this.modelCalls.set(call.id, call);
		this.modelCallContextSourceIds.set(call.id, contextualSourceEventIds);
		this.modelCallReservedUsd.set(call.id, Number(input.estimatedUsd ?? 0));
		return { kind: "reserved", call: copy(call) };
	}

	async markModelCallDispatched(callId: string, at: string): Promise<void> {
		const call = this.modelCalls.get(callId);

		if (!call || call.state !== "reserved")
			throw new DomainError(
				"Model call is not reserved for dispatch.",
				"CONFLICT",
			);

		const run = this.interpretationRuns.get(call.runId);
		const contextIds = this.modelCallContextSourceIds.get(callId) ?? [];

		if (
			[...(run?.eventIds ?? []), ...contextIds].some((id) =>
				this.revokedEventIds.has(id),
			)
		) {
			await this.settleModelCall({
				callId,
				state: "cancelled",
				providerRequestId: null,
				resolvedModelVersion: null,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				embeddingItems: null,
				costUsd: "0.00000000",
				costBasis: "known_zero",
				errorCode: "source_revoked",
				response: null,
				finishedAt: at,
			});
			throw new DomainError(
				"Source was revoked before model dispatch.",
				"CONFLICT",
			);
		}
		if (
			(await this.currentSourceEventIds(contextIds)).length !==
			contextIds.length
		) {
			await this.settleModelCall({
				callId,
				state: "cancelled",
				providerRequestId: null,
				resolvedModelVersion: null,
				inputTokens: 0,
				cachedInputTokens: 0,
				outputTokens: 0,
				embeddingItems: null,
				costUsd: "0.00000000",
				costBasis: "known_zero",
				errorCode: "source_superseded",
				response: null,
				finishedAt: at,
			});
			throw new DomainError(
				"Source was superseded before model dispatch.",
				"CONFLICT",
			);
		}
		call.state = "dispatched";
		call.dispatchedAt = at;
	}

	async settleModelCall(input: SettleCallInput): Promise<ModelCall> {
		const call = this.modelCalls.get(input.callId);

		if (!call)
			throw new DomainError("Model call was not found.", "NOT_FOUND");
		if (!["reserved", "dispatched"].includes(call.state)) return copy(call);

		const budget = this.evidenceBudgets.get(call.budgetId)!;
		const totals = this.budgetTokenTotals.get(call.budgetId)!;
		const unknown =
			input.state === "unknown" ||
			(input.state !== "cancelled" &&
				(input.inputTokens === null || input.outputTokens === null));

		call.state = unknown ? "unknown" : input.state;
		call.inputTokens = input.inputTokens;
		call.cachedInputTokens = input.cachedInputTokens;
		call.outputTokens = input.outputTokens;
		call.embeddingItems = input.embeddingItems;
		call.costUsd = input.costUsd;
		call.costBasis = input.costBasis;
		call.providerRequestId = input.providerRequestId;
		call.errorCode = input.errorCode;
		call.finishedAt = input.finishedAt;
		if (
			input.response !== null &&
			![
				...(this.interpretationRuns.get(call.runId)?.eventIds ?? []),
				...(this.modelCallContextSourceIds.get(call.id) ?? []),
			].some((id) => this.revokedEventIds.has(id))
		) {
			this.modelCallResponses.set(call.id, copy(input.response));
		}
		if (unknown) budget.state = "suspended";
		else {
			budget.reservedCalls -= 1;
			budget.spentCalls += 1;
			totals.reservedInput -= call.reservedInputTokens;
			totals.reservedOutput -= call.reservedOutputTokens;
			totals.reservedUsd -= this.modelCallReservedUsd.get(call.id) ?? 0;
			totals.spentInput += input.inputTokens ?? 0;
			totals.spentOutput += input.outputTokens ?? 0;
			totals.spentUsd += Number(input.costUsd ?? 0);
			if (budget.maxUsd !== null && input.costBasis === "unknown")
				budget.state = "suspended";
			else if (
				budget.spentCalls + budget.reservedCalls >= budget.maxCalls ||
				totals.spentInput + totals.reservedInput >=
					budget.maxInputTokens ||
				totals.spentOutput + totals.reservedOutput >=
					budget.maxOutputTokens ||
				(budget.maxUsd !== null &&
					totals.spentUsd + totals.reservedUsd >=
						Number(budget.maxUsd))
			) {
				budget.state = "exhausted";
			}
		}
		return copy(call);
	}

	async reconcileUnknownModelCallAtReservedBound(
		callId: string,
	): Promise<ModelCall> {
		const call = this.modelCalls.get(callId);

		if (!call)
			throw new DomainError("Model call was not found.", "NOT_FOUND");
		if (
			call.state === "failed" &&
			call.errorCode?.endsWith("_reserved_bound")
		)
			return copy(call);
		if (call.state !== "unknown")
			throw new DomainError("Model call is not unknown.", "CONFLICT");

		const budget = this.evidenceBudgets.get(call.budgetId)!;
		const totals = this.budgetTokenTotals.get(call.budgetId)!;
		const reservedUsd = this.modelCallReservedUsd.get(call.id) ?? 0;

		if (
			budget.reservedCalls < 1 ||
			(budget.maxUsd !== null && reservedUsd <= 0)
		) {
			throw new DomainError(
				"Unknown call has no held budget reservation.",
				"CONFLICT",
			);
		}
		call.state = "failed";
		call.costUsd = reservedUsd.toFixed(8);
		call.costBasis = "estimated";
		call.errorCode = `${call.errorCode ?? "unknown"}_reserved_bound`;
		budget.reservedCalls -= 1;
		budget.spentCalls += 1;
		totals.reservedInput -= call.reservedInputTokens;
		totals.reservedOutput -= call.reservedOutputTokens;
		totals.reservedUsd -= reservedUsd;
		totals.spentInput += call.reservedInputTokens;
		totals.spentOutput += call.reservedOutputTokens;
		totals.spentUsd += reservedUsd;
		budget.state = [...this.modelCalls.values()].some(
			(item) => item.budgetId === budget.id && item.state === "unknown",
		)
			? "suspended"
			: Date.parse(budget.deadline) <= Date.now() ||
				  budget.spentCalls >= budget.maxCalls ||
				  totals.spentInput >= budget.maxInputTokens ||
				  totals.spentOutput >= budget.maxOutputTokens ||
				  (budget.maxUsd !== null &&
						totals.spentUsd >= Number(budget.maxUsd))
				? "exhausted"
				: "active";
		return copy(call);
	}

	async listModelCalls(runId: string): Promise<ModelCall[]> {
		return [...this.modelCalls.values()]
			.filter((call) => call.runId === runId)
			.map(copy);
	}

	async getModelCallResponseByKey(logicalCallKey: string): Promise<{
		call: ModelCall;
		response: JsonValue | null;
	} | null> {
		const call = [...this.modelCalls.values()].find(
			(item) =>
				item.logicalCallKey === logicalCallKey && item.attempt === 1,
		);

		if (!call) return null;

		const run = this.interpretationRuns.get(call.runId);
		const ids = [
			...new Set([
				...(run?.eventIds ?? []),
				...(this.modelCallContextSourceIds.get(call.id) ?? []),
			]),
		];
		const current = new Set(await this.currentSourceEventIds(ids));

		return {
			call: copy(call),
			response: ids.every((id) => current.has(id))
				? copy(this.modelCallResponses.get(call.id) ?? null)
				: null,
		};
	}

	async observationAcceptedSourceEventIds(
		ids: readonly string[],
	): Promise<string[]> {
		return [
			...new Set(
				(await this.listProposals())
					.filter(
						(proposal) =>
							proposal.requestedBy === "observation-agent" &&
							proposal.state === "auto_applied",
					)
					.flatMap((proposal) => proposal.evidenceIds),
			),
		].filter((id) => ids.includes(id));
	}

	async completeObservationAgent(input: {
		runId: string;
		dispositionId: string;
		owner: string;
		writes: number;
	}): Promise<void> {
		const disposition = this.dispositions.get(input.dispositionId);

		if (
			!disposition ||
			disposition.leaseOwner !== input.owner ||
			disposition.state !== "processing"
		) {
			throw new DomainError(
				"Observation completion lease is unavailable.",
				"CONFLICT",
			);
		}
		await this.completeInterpretationRun(input.runId, {
			workflow: "one-agent-per-observation",
			writes: input.writes,
		});
		this.dispositions.set(disposition.id, {
			...disposition,
			runId: input.runId,
			state: "processed",
			retryable: false,
			leaseOwner: null,
			leaseUntil: null,
			finishedAt: new Date().toISOString(),
			reasonCode: input.writes
				? "observation_agent_applied"
				: "observation_agent_no_change",
		});
	}

	async getObservationAgentCheckpoint(
		runId: string,
	): Promise<
		import("../domain/evidence-store.js").ObservationAgentCheckpoint | null
	> {
		const run = await this.getInterpretationRun(runId);
		const checkpoint = this.observationAgentCheckpoints.get(runId);

		return run?.state === "running" && checkpoint ? copy(checkpoint) : null;
	}

	async saveObservationAgentCheckpoint(input: {
		runId: string;
		dispositionId: string;
		owner: string;
		checkpoint: import("../domain/evidence-store.js").ObservationAgentCheckpoint;
	}): Promise<void> {
		const disposition = this.dispositions.get(input.dispositionId);
		const run = await this.getInterpretationRun(input.runId);

		if (
			!disposition ||
			disposition.leaseOwner !== input.owner ||
			disposition.state !== "processing" ||
			run?.state !== "running"
		) {
			throw new DomainError(
				"Observation lease or run is unavailable.",
				"CONFLICT",
			);
		}
		this.dispositions.set(disposition.id, {
			...disposition,
			runId: input.runId,
		});
		this.observationAgentCheckpoints.set(
			input.runId,
			copy(input.checkpoint),
		);
	}

	async createV2Run(input: V2RunCreate): Promise<InterpretationRun> {
		if (this.evidenceBudgets.get(input.budgetId)?.state !== "active") {
			throw new DomainError(
				"Active inference budget was not found.",
				"INVALID",
			);
		}

		const run: InterpretationRun = {
			id: randomUUID(),
			inputHash: input.inputHash,
			model: input.model,
			state: "running",
			eventIds: copy(input.eventIds),
			output: null,
			error: null,
			createdAt: new Date().toISOString(),
			completedAt: null,
		};

		this.interpretationRuns.set(run.id, run);
		this.v2RunMetadata.set(run.id, copy(input));
		return copy(run);
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
		const event = [...this.eventsByProviderId.values()].find(
			(candidate) => candidate.id === input.eventId,
		);

		if (!event || this.revokedEventIds.has(event.id))
			throw new DomainError(
				"Active source event was not found.",
				"NOT_FOUND",
			);

		const origin =
			event.observationIdentity?.originObservationKey ??
			`unresolved-receipt:${event.id}`;
		const previous = [...this.dispositions.values()]
			.filter(
				(item) =>
					item.originObservationKey === origin &&
					item.pipelineVersion === input.pipelineVersion &&
					item.state !== "duplicate",
			)
			.sort((a, b) => b.attempt - a.attempt)[0];

		if (
			previous &&
			(previous.state === "pending" || previous.state === "processing")
		) {
			if (
				previous.leaseUntil &&
				Date.parse(previous.leaseUntil) > Date.parse(input.now)
			) {
				return { kind: "busy", disposition: copy(previous) };
			}
			previous.state = "failed";
			previous.reasonCode = "lease_expired";
			previous.retryable = previous.attempt < 3;
			previous.leaseOwner = null;
			previous.leaseUntil = null;
			previous.finishedAt = input.now;
			if (previous.attempt >= 3)
				return { kind: "terminal", disposition: copy(previous) };
		} else if (
			previous &&
			previous.sourceEventId === event.id &&
			!["failed", "partial", "unresolved"].includes(previous.state) &&
			!(
				previous.state === "no_claim" &&
				input.reopenNoClaim &&
				previous.attempt === 1
			)
		) {
			return { kind: "terminal", disposition: copy(previous) };
		} else if (
			previous &&
			previous.sourceEventId === event.id &&
			previous.attempt >= 3
		) {
			previous.retryable = false;
			return { kind: "terminal", disposition: copy(previous) };
		} else if (previous && previous.sourceEventId !== event.id) {
			const existing = [...this.dispositions.values()].find(
				(item) =>
					item.sourceEventId === event.id &&
					item.pipelineVersion === input.pipelineVersion &&
					item.state === "duplicate",
			);

			if (existing)
				return { kind: "duplicate", disposition: copy(existing) };

			const duplicate: ObservationDisposition = {
				id: randomUUID(),
				sourceEventId: event.id,
				canonicalEventId: previous.sourceEventId,
				originObservationKey: origin,
				pipelineVersion: input.pipelineVersion,
				attempt: 1,
				runId: null,
				state: "duplicate",
				claimIds: [],
				reasonCode: "same_origin_version",
				retryable: false,
				nextAttemptAt: null,
				leaseOwner: null,
				leaseUntil: null,
				createdAt: input.now,
				finishedAt: input.now,
			};

			this.dispositions.set(duplicate.id, duplicate);
			return { kind: "duplicate", disposition: copy(duplicate) };
		}

		const attempt =
			1 +
			Math.max(
				0,
				...[...this.dispositions.values()]
					.filter(
						(item) =>
							item.sourceEventId === event.id &&
							item.pipelineVersion === input.pipelineVersion,
					)
					.map((item) => item.attempt),
			);
		const disposition: ObservationDisposition = {
			id: randomUUID(),
			sourceEventId: event.id,
			canonicalEventId: null,
			originObservationKey: origin,
			pipelineVersion: input.pipelineVersion,
			attempt,
			runId: null,
			state: "processing",
			claimIds: [],
			reasonCode: null,
			retryable: false,
			nextAttemptAt: null,
			leaseOwner: input.workerId,
			leaseUntil: new Date(
				Date.parse(input.now) + input.leaseSeconds * 1000,
			).toISOString(),
			createdAt: input.now,
			finishedAt: null,
		};

		this.dispositions.set(disposition.id, disposition);
		return { kind: "claimed", disposition: copy(disposition) };
	}

	async getLatestObservationDisposition(
		eventId: string,
		pipelineVersion: string,
	): Promise<ObservationDisposition | null> {
		const latest = [...this.dispositions.values()]
			.filter(
				(item) =>
					item.sourceEventId === eventId &&
					item.pipelineVersion === pipelineVersion,
			)
			.sort(
				(left, right) =>
					right.attempt - left.attempt ||
					right.createdAt.localeCompare(left.createdAt),
			)[0];

		return latest ? copy(latest) : null;
	}

	async getEvidenceCoverage(pipelineVersion: string) {
		const coverage = emptyEvidenceCoverage(pipelineVersion);
		const current = new Set(
			await this.currentSourceEventIds(
				[...this.eventsByProviderId.values()].map((event) => event.id),
			),
		);

		for (const event of this.eventsByProviderId.values()) {
			if (!current.has(event.id)) continue;

			const latest = await this.getLatestObservationDisposition(
				event.id,
				pipelineVersion,
			);

			coverage.activeObservations += 1;
			coverage.states[latest?.state ?? "unseen"] += 1;
			if (
				latest &&
				["failed", "partial", "unresolved"].includes(latest.state) &&
				latest.retryable &&
				latest.attempt < 3
			) {
				coverage.retryBacklog += 1;
				if (
					!coverage.oldestRetryAt ||
					latest.createdAt < coverage.oldestRetryAt
				) {
					coverage.oldestRetryAt = latest.createdAt;
				}
			}
		}

		const jobs = [...this.outboxJobs.values()].filter((job) =>
			job.topic.startsWith("evidence."),
		);

		coverage.evidenceJobs = {
			pending: jobs.filter((job) => job.state === "pending").length,
			running: jobs.filter((job) => job.state === "running").length,
			failed: jobs.filter((job) => job.state === "failed").length,
			oldestPendingAt:
				jobs
					.filter((job) => job.state === "pending")
					.map((job) => job.createdAt)
					.sort()[0] ?? null,
		};

		const [activeClaims, activeAssessments] = await Promise.all([
			this.getClaims([...this.evidenceClaims.keys()]),
			Promise.all(
				[...this.evidenceAssessments.keys()].map((id) =>
					this.getAssessment(id),
				),
			),
		]);

		coverage.outputs = {
			savedClaims: activeClaims.length,
			savedAssessments: activeAssessments.filter(Boolean).length,
			pendingAssessedProposals: [...this.proposals.values()].filter(
				(proposal) =>
					proposal.assessmentId &&
					["pending", "escalated"].includes(proposal.state),
			).length,
			acceptedAssessedTaskRevisions: [...this.revisions.values()]
				.flat()
				.filter((revision) => revision.decisionMetadata?.assessmentId)
				.length,
		};
		return coverage;
	}

	async failObservationClaims(input: {
		leases: { dispositionId: string; attempt: number; owner: string }[];
		runId: string | null;
		reasonCode: string;
	}): Promise<void> {
		for (const lease of input.leases) {
			const current = this.dispositions.get(lease.dispositionId);

			if (
				!current ||
				current.state !== "processing" ||
				current.attempt !== lease.attempt ||
				current.leaseOwner !== lease.owner
			)
				continue;
			current.state = "failed";
			current.reasonCode = input.reasonCode;
			current.retryable = current.attempt < 3;
			current.runId = input.runId;
			current.leaseOwner = null;
			current.leaseUntil = null;
			current.finishedAt = new Date().toISOString();
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

		const run = this.interpretationRuns.get(input.runId);

		if (
			!run ||
			run.state !== "running" ||
			run.inputHash !== input.inputHash ||
			run.eventIds.some((id) => this.revokedEventIds.has(id))
		) {
			throw new DomainError(
				"Extraction run is missing, stale, or has a different input hash.",
				"CONFLICT",
			);
		}

		const activeIds = new Set(run.eventIds);
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

		const existing = [...this.evidenceClaims.values()]
			.filter((claim) => claim.extractionRunId === run.id)
			.sort((a, b) => a.ordinal - b.ordinal);

		if (existing.length > 0) {
			if (
				existing.length !== input.claims.length ||
				existing.some(
					(claim, index) =>
						claim.contentHash !== contentHash(input.claims[index]),
				)
			) {
				throw new DomainError(
					"A different extraction is already saved for this run.",
					"CONFLICT",
				);
			}
			return {
				claims: copy(existing),
				dispositions: copy(
					[...this.dispositions.values()].filter(
						(item) => item.runId === run.id,
					),
				),
			};
		}
		if (input.claims.length === 0) {
			const prior = [...this.dispositions.values()].filter(
				(item) => item.runId === run.id,
			);

			if (prior.length > 0) {
				if (
					prior.length !== input.dispositions.length ||
					prior.some(
						(row) =>
							!input.dispositions.some(
								(item) =>
									item.eventId === row.sourceEventId &&
									item.state === row.state &&
									item.reasonCode === row.reasonCode,
							),
					)
				) {
					throw new DomainError(
						"A different extraction is already saved for this run.",
						"CONFLICT",
					);
				}
				return { claims: [], dispositions: copy(prior) };
			}
		}

		const leases = input.expectedLeases.map((lease) =>
			this.dispositions.get(lease.dispositionId),
		);

		if (
			leases.length !== input.dispositions.length ||
			leases.some(
				(item, index) =>
					!item ||
					item.state !== "processing" ||
					item.attempt !== input.expectedLeases[index]!.attempt ||
					item.leaseOwner !== input.expectedLeases[index]!.owner ||
					!item.leaseUntil ||
					Date.parse(item.leaseUntil) <= Date.now(),
			)
		)
			throw new DomainError(
				"Extraction lease expired or changed owner.",
				"CONFLICT",
			);

		const events = new Map(
			[...this.eventsByProviderId.values()]
				.filter((event) => !this.revokedEventIds.has(event.id))
				.map((event) => [event.id, event]),
		);

		for (const claim of input.claims) validateClaimBody(claim, events);

		const claims: EvidenceClaim[] = input.claims.map((body, ordinal) => ({
			id: randomUUID(),
			extractionRunId: run.id,
			episodeKey: input.episodeKey,
			ordinal,
			inputHash: input.inputHash,
			contentHash: contentHash(body),
			body: copy(body),
			createdAt: new Date().toISOString(),
		}));

		for (const item of input.dispositions) {
			const disposition = this.dispositions.get(item.dispositionId);

			if (
				!disposition ||
				disposition.sourceEventId !== item.eventId ||
				!run.eventIds.includes(item.eventId) ||
				item.claimOrdinals.some((ordinal) => !claims[ordinal])
			) {
				throw new DomainError(
					"Extraction disposition does not match its lease or claim ordinals.",
					"INVALID",
				);
			}
			if (
				["extracted", "partial"].includes(item.state) &&
				item.claimOrdinals.length === 0
			) {
				throw new DomainError(
					"Extracted disposition must reference a claim.",
					"INVALID",
				);
			}
			if (item.state === "no_claim" && !item.reasonCode)
				throw new DomainError(
					"No-claim disposition needs a reason.",
					"INVALID",
				);
		}
		for (const claim of claims) this.evidenceClaims.set(claim.id, claim);

		const dispositions = input.dispositions.map((item) => {
			const disposition = this.dispositions.get(item.dispositionId)!;

			disposition.state = item.state;
			disposition.claimIds = item.claimOrdinals.map(
				(ordinal) => claims[ordinal]!.id,
			);
			disposition.reasonCode = item.reasonCode;
			disposition.retryable =
				(item.state === "partial" || item.state === "unresolved") &&
				disposition.attempt < 3;
			disposition.runId = run.id;
			disposition.leaseOwner = null;
			disposition.leaseUntil = null;
			disposition.finishedAt = new Date().toISOString();
			return copy(disposition);
		});

		return { claims: copy(claims), dispositions };
	}

	async getClaims(ids: readonly string[]): Promise<EvidenceClaim[]> {
		return ids
			.flatMap((id) => this.evidenceClaims.get(id) ?? [])
			.filter((claim) =>
				claim.body.spans.every(
					(span) => !this.revokedEventIds.has(span.eventId),
				),
			)
			.map(copy);
	}

	async listClaimsByRun(runId: string): Promise<EvidenceClaim[]> {
		return [...this.evidenceClaims.values()]
			.filter((claim) => claim.extractionRunId === runId)
			.filter((claim) =>
				claim.body.spans.every(
					(span) => !this.revokedEventIds.has(span.eventId),
				),
			)
			.sort(
				(left, right) =>
					left.ordinal - right.ordinal ||
					left.id.localeCompare(right.id),
			)
			.map(copy);
	}

	async listClaimsForTask(
		taskId: string,
		afterClaimId: string | null,
		limit: number,
	): Promise<EvidenceClaim[]> {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
			throw new DomainError("Invalid task claim page size.", "INVALID");
		}

		const creationAssessmentIds = new Set(
			(this.revisions.get(taskId) ?? []).flatMap((revision) => {
				const proposal = this.proposals.get(revision.proposalId);

				return proposal?.kind === "task_create" && proposal.assessmentId
					? [proposal.assessmentId]
					: [];
			}),
		);
		const ids = new Set(
			[...this.evidenceAssessments.values()]
				.filter(
					(assessment) =>
						(assessment.targetType === "task" &&
							assessment.targetId === taskId) ||
						(assessment.targetType === "task_create" &&
							creationAssessmentIds.has(assessment.id)),
				)
				.flatMap((assessment) => assessment.claimIds),
		);

		return [...ids]
			.filter((id) => !afterClaimId || id > afterClaimId)
			.sort()
			.slice(0, limit)
			.flatMap((id) => this.evidenceClaims.get(id) ?? [])
			.filter((claim) =>
				claim.body.spans.every(
					(span) => !this.revokedEventIds.has(span.eventId),
				),
			)
			.map(copy);
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

		const linked = new Set(
			[...this.evidenceAssessments.values()]
				.filter(
					(assessment) =>
						assessment.targetType === "task" &&
						assessment.targetId === taskId,
				)
				.flatMap((assessment) => assessment.claimIds),
		);

		return [...this.evidenceClaims.values()]
			.filter(
				(claim) =>
					!linked.has(claim.id) &&
					claim.createdAt <= through &&
					(!after || claim.createdAt >= after) &&
					(!cursor ||
						claim.createdAt > cursor.createdAt ||
						(claim.createdAt === cursor.createdAt &&
							claim.id > cursor.id)) &&
					claim.body.spans.every(
						(span) => !this.revokedEventIds.has(span.eventId),
					),
			)
			.sort(
				(left, right) =>
					left.createdAt.localeCompare(right.createdAt) ||
					left.id.localeCompare(right.id),
			)
			.slice(0, limit)
			.map(copy);
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

		const ids = new Set<string>();

		for (const assessment of this.evidenceAssessments.values()) {
			if (
				!assessment.claimIds.some((id) =>
					this.evidenceClaims
						.get(id)
						?.body.spans.some((span) => span.eventId === eventId),
				)
			)
				continue;
			if (assessment.targetType === "task" && assessment.targetId)
				ids.add(assessment.targetId);
			if (assessment.targetType === "task_create") {
				for (const [taskId, revisions] of this.revisions) {
					if (
						revisions.some(
							(revision) =>
								this.proposals.get(revision.proposalId)
									?.assessmentId === assessment.id,
						)
					) {
						ids.add(taskId);
					}
				}
			}
		}
		for (const [taskId, revisions] of this.revisions) {
			if (
				revisions.some(
					(revision) =>
						Object.values(
							revision.decisionMetadata?.sourceEventIdsByField ??
								{},
						).some((ids) => ids.includes(eventId)) ||
						this.proposals
							.get(revision.proposalId)
							?.evidenceIds.includes(eventId),
				)
			)
				ids.add(taskId);
		}
		for (const assessment of this.evidenceAssessments.values()) {
			if (
				assessment.targetType === "task" &&
				assessment.targetId &&
				[...this.modelCalls.values()].some(
					(call) =>
						call.runId === assessment.runId &&
						(
							this.modelCallContextSourceIds.get(call.id) ?? []
						).includes(eventId),
				)
			) {
				ids.add(assessment.targetId);
			}
		}
		return [...ids]
			.filter((id) => !afterTaskId || id > afterTaskId)
			.sort()
			.slice(0, limit);
	}

	async saveAssessment(
		input: Omit<EvidenceAssessment, "id" | "createdAt">,
		dependencies: readonly unknown[],
	): Promise<EvidenceAssessment> {
		if (
			dependencies.length > 0 ||
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

		const existing = [...this.evidenceAssessments.values()].find(
			(item) => item.assessmentKey === input.assessmentKey,
		);

		if (existing) {
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
			return copy(existing);
		}

		const run = this.interpretationRuns.get(input.runId);

		if (!run)
			throw new DomainError("Assessment run was not found.", "NOT_FOUND");

		const contextual = await this.listModelCallContextSourceIds(
			input.runId,
		);

		if (
			run.eventIds.some((id) => this.revokedEventIds.has(id)) ||
			(await this.currentSourceEventIds(contextual)).length !==
				contextual.length
		) {
			throw new DomainError(
				"Assessment model context was revoked or superseded.",
				"CONFLICT",
			);
		}

		const claims = input.claimIds.map((id) => this.evidenceClaims.get(id));

		if (claims.some((claim) => !claim))
			throw new DomainError(
				"Assessment claim is unavailable.",
				"INVALID",
			);

		const spans = claims.flatMap((claim) => claim!.body.spans);
		const allowedSpans = new Set(spans.map((span) => contentHash(span)));

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

		const sources = new Map(
			[...this.eventsByProviderId.values()]
				.filter((event) => !this.revokedEventIds.has(event.id))
				.map((event) => [event.id, event]),
		);

		if (
			spans.some(
				(span) =>
					sources.get(span.eventId)?.observationIdentity
						?.originObservationKey !== span.originObservationKey ||
					sources.get(span.eventId)?.observationIdentity
						?.sourceVersionKey !== span.sourceVersionKey,
			)
		) {
			throw new DomainError(
				"Assessment source was revoked or changed.",
				"INVALID",
			);
		}
		if (input.targetType === "task") {
			const currentTask = this.tasks.get(input.targetId!);
			const metadata = this.v2RunMetadata.get(input.runId);
			const historicalRun = Boolean(
				metadata?.knowledgeCutoff &&
				[
					"source_reinterpret",
					"cached_reassess",
					"historical_eval",
				].includes(metadata.replayMode),
			);
			const task = historicalRun
				? ((this.revisions.get(input.targetId!) ?? []).find(
						(revision) =>
							String(revision.version) === input.targetVersion &&
							revision.appliedAt <= metadata!.knowledgeCutoff!,
					)?.current ?? null)
				: currentTask &&
					  String(currentTask.version) === input.targetVersion
					? currentTask
					: null;

			if (!task)
				throw new DomainError(
					"Assessment target version changed.",
					"CONFLICT",
				);
			if (
				input.contractVersion !==
					(task.outcomeContract?.version ?? null) ||
				input.body.criteria.some(
					(item) =>
						!task.outcomeContract?.criteria.some(
							(criterion) => criterion.id === item.criterionId,
						),
				)
			) {
				throw new DomainError(
					"Assessment criterion or contract version is invalid.",
					"INVALID",
				);
			}
		} else if (input.targetType === "context") {
			const metadata = this.v2RunMetadata.get(input.runId);
			const entry = metadata?.knowledgeCutoff
				? (this.contextRevisions.get(input.targetId!) ?? [])
						.filter(
							(revision) =>
								revision.appliedAt <= metadata.knowledgeCutoff!,
						)
						.sort((a, b) => b.version - a.version)[0]?.current
				: [...this.contextBySourceRef.values()].find(
						(entry) => entry.id === input.targetId,
					);

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

		const assessment: EvidenceAssessment = {
			...copy(input),
			id: randomUUID(),
			createdAt: new Date().toISOString(),
		};

		this.evidenceAssessments.set(assessment.id, assessment);
		return copy(assessment);
	}

	async getAssessment(id: string): Promise<EvidenceAssessment | null> {
		const assessment = this.evidenceAssessments.get(id);

		if (
			!assessment ||
			[...this.modelCalls.values()].some(
				(call) =>
					call.runId === assessment.runId &&
					(this.modelCallContextSourceIds.get(call.id) ?? []).some(
						(sourceId) => this.revokedEventIds.has(sourceId),
					),
			) ||
			assessment.claimIds.some((claimId) => {
				const claim = this.evidenceClaims.get(claimId);

				return (
					!claim ||
					claim.body.spans.some((span) =>
						this.revokedEventIds.has(span.eventId),
					)
				);
			})
		)
			return null;
		return copy(assessment);
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

		const candidates = [...this.evidenceAssessments.values()]
			.filter(
				(assessment) =>
					assessment.targetType === "task" &&
					assessment.targetId === taskId,
			)
			.sort(
				(left, right) =>
					right.createdAt.localeCompare(left.createdAt) ||
					right.id.localeCompare(left.id),
			)
			.slice(0, limit);
		const visible = await Promise.all(
			candidates.map((assessment) => this.getAssessment(assessment.id)),
		);

		return visible.filter(
			(assessment): assessment is EvidenceAssessment =>
				assessment !== null,
		);
	}

	async listModelCallContextSourceIds(runId: string): Promise<string[]> {
		return [
			...new Set(
				[...this.modelCalls.values()]
					.filter((call) => call.runId === runId)
					.flatMap(
						(call) =>
							this.modelCallContextSourceIds.get(call.id) ?? [],
					),
			),
		].sort();
	}

	async listSourceEvents(
		limit: number,
	): Promise<EventAppendResult["event"][]> {
		return [...this.eventsByProviderId.values()]
			.filter((event) => !this.revokedEventIds.has(event.id))
			.sort((left, right) =>
				right.receivedAt.localeCompare(left.receivedAt),
			)
			.slice(0, limit)
			.map(copy);
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
		return [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					!this.revokedEventIds.has(event.id) &&
					event.provider === input.provider &&
					event.installationKey === input.installationKey &&
					event.visibility === input.visibility &&
					Date.parse(event.receivedAt) <= Date.parse(input.cutoff) &&
					Date.parse(event.occurredAt) <= Date.parse(input.cutoff),
			)
			.sort(
				(left, right) =>
					right.receivedAt.localeCompare(left.receivedAt) ||
					right.id.localeCompare(left.id),
			)
			.slice(0, input.limit)
			.map(copy);
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

		const current = new Set(
			await this.currentSourceEventIds(
				[...this.eventsByProviderId.values()].map((event) => event.id),
			),
		);

		return [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					current.has(event.id) &&
					(!cursor ||
						event.receivedAt > cursor.receivedAt ||
						(event.receivedAt === cursor.receivedAt &&
							event.id > cursor.id)),
			)
			.sort(
				(left, right) =>
					left.receivedAt.localeCompare(right.receivedAt) ||
					left.id.localeCompare(right.id),
			)
			.slice(0, limit)
			.map(copy);
	}

	async listSourceDocuments(
		limit: number,
		at?: string,
	): Promise<SourceEvent[]> {
		const current = new Set(
			await this.currentSourceEventIds(
				[...this.eventsByProviderId.values()].map((event) => event.id),
				at,
			),
		);

		return [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					(event.eventKind === "source.document.retrieved" ||
						(event.provider === "slack" &&
							[
								"message.explicitly_captured",
								"message.imported",
								"message.observed",
								"message.edited",
							].includes(event.eventKind))) &&
					current.has(event.id) &&
					(!at || event.receivedAt <= at),
			)
			.sort((left, right) =>
				right.receivedAt.localeCompare(left.receivedAt),
			)
			.slice(0, limit)
			.map(copy);
	}

	async getLatestSourceEventBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
	): Promise<SourceEvent | null> {
		const matching = [...this.eventsByProviderId.values()]
			.filter(
				(candidate) =>
					candidate.provider === provider &&
					candidate.installationKey === installationKey &&
					candidate.sourceRef === sourceRef,
			)
			.sort(
				(left, right) =>
					right.occurredAt.localeCompare(left.occurredAt) ||
					right.receivedAt.localeCompare(left.receivedAt) ||
					right.id.localeCompare(left.id),
			)[0];
		const key =
			matching?.observationIdentity?.canonicalObjectKey ??
			matching?.sourceRef;
		const event = key
			? [...this.eventsByProviderId.values()]
					.filter(
						(candidate) =>
							candidate.provider === provider &&
							candidate.installationKey === installationKey &&
							(candidate.observationIdentity
								?.canonicalObjectKey ?? candidate.sourceRef) ===
								key,
					)
					.sort(
						(left, right) =>
							right.occurredAt.localeCompare(left.occurredAt) ||
							right.receivedAt.localeCompare(left.receivedAt) ||
							right.id.localeCompare(left.id),
					)[0]
			: null;

		return event && !this.revokedEventIds.has(event.id)
			? copy(event)
			: null;
	}

	async currentSourceEventIds(
		ids: readonly string[],
		at?: string,
	): Promise<string[]> {
		const wanted = new Set(ids);

		const key = (event: SourceEvent) =>
			`${event.provider}\u0000${event.installationKey}\u0000${event.observationIdentity?.canonicalObjectKey ?? event.sourceRef}`;

		const order = (left: SourceEvent, right: SourceEvent) =>
			left.occurredAt.localeCompare(right.occurredAt) ||
			left.receivedAt.localeCompare(right.receivedAt) ||
			left.id.localeCompare(right.id);

		const groups = new Map<string, SourceEvent[]>();

		for (const event of this.eventsByProviderId.values()) {
			if (at && event.receivedAt > at) continue;

			const group = groups.get(key(event)) ?? [];

			group.push(event);
			groups.set(key(event), group);
		}

		const current: string[] = [];

		for (const group of groups.values()) {
			group.sort(order);
			for (const event of group) {
				if (!wanted.has(event.id) || this.revokedEventIds.has(event.id))
					continue;

				const version = event.observationIdentity?.sourceVersionKey;
				const newerBlocks = group.some(
					(newer) =>
						order(newer, event) > 0 &&
						(!version ||
							newer.observationIdentity?.sourceVersionKey !==
								version ||
							this.revokedEventIds.has(newer.id)),
				);

				if (!newerBlocks) current.push(event.id);
			}
		}
		return current;
	}

	async listActiveSourceRefs(
		provider: string,
		installationKey: string,
		visibility: string,
	): Promise<string[]> {
		return [
			...new Set(
				[...this.eventsByProviderId.values()]
					.filter(
						(event) =>
							event.provider === provider &&
							event.installationKey === installationKey &&
							event.visibility === visibility &&
							!this.revokedEventIds.has(event.id),
					)
					.map((event) => event.sourceRef),
			),
		].sort();
	}

	async getSourceEvents(ids: string[]): Promise<SourceEvent[]> {
		const wanted = new Set(ids);

		return [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					wanted.has(event.id) && !this.revokedEventIds.has(event.id),
			)
			.map(copy);
	}

	async getSourceEventScope(id: string): Promise<{
		provider: string;
		installationKey: string;
		visibility: string;
		canonicalObjectKey: string;
	} | null> {
		const event = [...this.eventsByProviderId.values()].find(
			(candidate) => candidate.id === id,
		);

		return event
			? {
					provider: event.provider,
					installationKey: event.installationKey,
					visibility: event.visibility,
					canonicalObjectKey:
						event.observationIdentity?.canonicalObjectKey ??
						event.sourceRef,
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
		const event = [...this.eventsByProviderId.values()].find(
			(candidate) =>
				candidate.id === input.eventId &&
				!this.revokedEventIds.has(candidate.id),
		);
		const previous = event
			? await this.getLatestObservationDisposition(
					event.id,
					input.pipelineVersion,
				)
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
		const existing = [...this.outboxJobs.values()].find(
			(job) => job.dedupeKey === dedupeKey,
		);

		if (existing) return copy(existing);

		const job = await this.enqueueOutboxJob({
			topic: "evidence.source.ready",
			dedupeKey,
			payload: {
				pipelineVersion: input.pipelineVersion,
				dispatchEpoch: input.dispatchEpoch,
				eventId: event.id,
				sourceVersionKey:
					event.observationIdentity?.sourceVersionKey ?? null,
				reason: "manual_reopen",
				requestedBy: input.actor,
				reviewReason: input.reason,
			},
		});

		await this.appendAuditEvent({
			actor: input.actor,
			action: "evidence.no_claim_reopened",
			targetType: "source_event",
			targetId: event.id,
			sourceEventId: event.id,
			proposalId: null,
			details: {
				pipelineVersion: input.pipelineVersion,
				jobId: job.id,
				reason: input.reason,
			},
		});
		return job;
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
		return [...this.revokedEventIds]
			.filter((id) => !afterEventId || id > afterEventId)
			.sort()
			.slice(0, limit);
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
		return [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					event.supersedesEventId &&
					(!afterNewEventId || event.id > afterNewEventId),
			)
			.sort((left, right) => left.id.localeCompare(right.id))
			.slice(0, limit)
			.map((event) => ({
				oldEventId: event.supersedesEventId!,
				newEventId: event.id,
			}));
	}

	async revokeSourceEvent(id: string): Promise<boolean> {
		const exists = [...this.eventsByProviderId.values()].some(
			(event) => event.id === id,
		);

		if (!exists || this.revokedEventIds.has(id)) return false;
		this.revokedEventIds.add(id);
		for (const run of this.interpretationRuns.values()) {
			if (
				run.eventIds.includes(id) ||
				[...this.modelCalls.values()].some(
					(call) =>
						call.runId === run.id &&
						(
							this.modelCallContextSourceIds.get(call.id) ?? []
						).includes(id),
				)
			) {
				run.output = null;
				run.error = null;
			}
		}
		for (const call of this.modelCalls.values()) {
			if (
				this.interpretationRuns
					.get(call.runId)
					?.eventIds.includes(id) ||
				(this.modelCallContextSourceIds.get(call.id) ?? []).includes(id)
			) {
				this.modelCallResponses.delete(call.id);
			}
		}
		this.workEntityVectors.clear();
		await this.enqueueOutboxJob({
			topic: "evidence.source.revoked",
			dedupeKey: `evidence:revoked:${id}:start`,
			payload: { eventId: id, afterTaskId: null },
		});
		return true;
	}

	async revokeSourceEventsBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
		exceptEventId?: string,
	): Promise<string[]> {
		return this.revokeMatchingSourceEvents(
			(event) =>
				event.provider === provider &&
				event.installationKey === installationKey &&
				event.sourceRef === sourceRef,
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
			(event) =>
				event.provider === provider &&
				event.installationKey === installationKey &&
				event.visibility === visibility,
			exceptEventId,
		);
	}

	async upsertContextEntry(input: NewContextEntry): Promise<ContextEntry> {
		const existing = this.contextBySourceRef.get(input.sourceRef);
		const pathOwner = [...this.contextBySourceRef.values()].find(
			(entry) =>
				entry.path === input.path &&
				entry.sourceRef !== input.sourceRef,
		);

		if (pathOwner)
			throw new DomainError(
				`Context path ${input.path} already exists.`,
				"CONFLICT",
			);

		const entry = {
			...copy(input),
			id: existing?.id ?? randomUUID(),
			updatedAt: new Date().toISOString(),
		} as ContextEntry;

		this.contextBySourceRef.set(input.sourceRef, entry);
		return copy(entry);
	}

	private async revokeMatchingSourceEvents(
		matches: (event: SourceEvent) => boolean,
		exceptEventId?: string,
	): Promise<string[]> {
		const ids = [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					event.id !== exceptEventId &&
					!this.revokedEventIds.has(event.id) &&
					matches(event),
			)
			.map((event) => event.id);

		for (const id of ids) {
			this.revokedEventIds.add(id);
			await this.enqueueOutboxJob({
				topic: "evidence.source.revoked",
				dedupeKey: `evidence:revoked:${id}:start`,
				payload: { eventId: id, afterTaskId: null },
			});
		}
		for (const run of this.interpretationRuns.values()) {
			if (
				run.eventIds.some((id) => ids.includes(id)) ||
				[...this.modelCalls.values()].some(
					(call) =>
						call.runId === run.id &&
						(
							this.modelCallContextSourceIds.get(call.id) ?? []
						).some((sourceId) => ids.includes(sourceId)),
				)
			) {
				run.output = null;
				run.error = null;
			}
		}
		for (const call of this.modelCalls.values()) {
			if (
				this.interpretationRuns
					.get(call.runId)
					?.eventIds.some((eventId) => ids.includes(eventId)) ||
				(this.modelCallContextSourceIds.get(call.id) ?? []).some(
					(eventId) => ids.includes(eventId),
				)
			) {
				this.modelCallResponses.delete(call.id);
			}
		}
		if (ids.length > 0) this.workEntityVectors.clear();
		return ids;
	}

	async getContextEntry(id: string): Promise<ContextEntry | null> {
		const entry = [...this.contextBySourceRef.values()].find(
			(candidate) => candidate.id === id,
		);

		return entry &&
			!entry.evidenceIds.some((eventId) =>
				this.revokedEventIds.has(eventId),
			)
			? copy(entry)
			: null;
	}

	async getContextEntryRefreshTarget(
		id: string,
	): Promise<Pick<
		ContextEntry,
		"id" | "kind" | "sourceRef" | "path" | "evidenceIds"
	> | null> {
		const entry = [...this.contextBySourceRef.values()].find(
			(candidate) => candidate.id === id,
		);

		return entry
			? {
					id: entry.id,
					kind: entry.kind,
					sourceRef: entry.sourceRef,
					path: entry.path,
					evidenceIds: copy(entry.evidenceIds),
				}
			: null;
	}

	async listContextEntries(): Promise<ContextEntry[]> {
		return [...this.contextBySourceRef.values()]
			.filter(
				(entry) =>
					!entry.evidenceIds.some((eventId) =>
						this.revokedEventIds.has(eventId),
					),
			)
			.sort((a, b) => a.path.localeCompare(b.path))
			.map(copy);
	}

	async listContextRevisions(
		contextEntryId?: string,
	): Promise<ContextRevision[]> {
		const revisions = contextEntryId
			? (this.contextRevisions.get(contextEntryId) ?? [])
			: [...this.contextRevisions.values()].flat();

		return revisions
			.toSorted(
				(left, right) =>
					left.appliedAt.localeCompare(right.appliedAt) ||
					left.version - right.version,
			)
			.map(copy);
	}

	async getContextRevisionByProposal(
		proposalId: string,
	): Promise<ContextRevision | null> {
		const revision = [...this.contextRevisions.values()]
			.flat()
			.find((candidate) => candidate.proposalId === proposalId);

		return revision ? copy(revision) : null;
	}

	async searchContextEntries(
		query: string,
		limit: number,
	): Promise<ContextEntry[]> {
		const searchTerms = [
			...new Set(
				query.toLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ??
					[],
			),
		].filter((term) => term.length > 1);

		return (await this.listContextEntries())
			.map((entry) => {
				const text =
					`${entry.path} ${entry.title} ${entry.kind === "file" ? entry.body : `${entry.factType} ${entry.value}`}`.toLowerCase();

				return {
					entry,
					score: searchTerms.reduce(
						(total, term) =>
							total +
							(entry.path.toLowerCase().includes(term) ? 5 : 0) +
							(text.includes(term) ? 1 : 0),
						0,
					),
				};
			})
			.filter(({ score }) => searchTerms.length === 0 || score > 0)
			.sort(
				(left, right) =>
					right.score - left.score ||
					right.entry.updatedAt.localeCompare(left.entry.updatedAt),
			)
			.slice(0, limit)
			.map(({ entry }) => entry);
	}

	async createProposal(input: NewProposal): Promise<Proposal> {
		if (input.applicationKey) {
			const existing = [...this.proposals.values()].find(
				(proposal) => proposal.applicationKey === input.applicationKey,
			);

			if (existing) {
				if (
					existing.assessmentId !== (input.assessmentId ?? null) ||
					existing.taskId !== input.taskId ||
					existing.baseVersion !== input.baseVersion ||
					contentHash(existing.changes) !==
						contentHash(input.changes) ||
					contentHash(existing.evidenceIds) !==
						contentHash(input.evidenceIds)
				) {
					throw new DomainError(
						"Application key belongs to a different proposal.",
						"CONFLICT",
					);
				}
				return copy(existing);
			}
		}
		if (input.clientEventId) {
			const existing = await this.findProposalByClientEvent(
				input.requestedBy,
				input.clientEventId,
			);

			if (existing) return existing;
		}

		const proposal = {
			...copy(input),
			clientEventId: input.clientEventId ?? null,
			assessmentId: input.assessmentId ?? null,
			applicationKey: input.applicationKey ?? null,
			decisionMetadata: input.decisionMetadata ?? null,
			id: randomUUID(),
			state: "pending",
			createdAt: new Date().toISOString(),
			decidedAt: null,
			decidedBy: null,
			decisionNote: null,
		} as Proposal;

		this.proposals.set(proposal.id, proposal);
		return copy(proposal);
	}

	async getProposal(id: string): Promise<Proposal | null> {
		const proposal = this.proposals.get(id);

		return proposal ? copy(proposal) : null;
	}

	async findProposalByClientEvent(
		requestedBy: string,
		clientEventId: string,
	): Promise<Proposal | null> {
		const proposal = [...this.proposals.values()].find(
			(candidate) =>
				candidate.requestedBy === requestedBy &&
				candidate.clientEventId === clientEventId,
		);

		return proposal ? copy(proposal) : null;
	}

	async listProposals(state?: ProposalState): Promise<Proposal[]> {
		return [...this.proposals.values()]
			.filter((proposal) => !state || proposal.state === state)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map(copy);
	}

	async findOpenProposal(
		taskId: string | null,
		changes: ProposalChanges,
	): Promise<Proposal | null> {
		const target = JSON.stringify(changes);
		const found = [...this.proposals.values()].find(
			(proposal) =>
				isOpenProposalState(proposal.state) &&
				proposal.taskId === taskId &&
				JSON.stringify(proposal.changes) === target,
		);

		return found ? copy(found) : null;
	}

	async replaceProposal(input: ReplaceProposalInput): Promise<Proposal> {
		const original = this.proposals.get(input.proposalId);

		if (!original)
			throw new DomainError(
				`Proposal ${input.proposalId} does not exist.`,
				"NOT_FOUND",
			);
		if (!isOpenProposalState(original.state)) {
			throw new DomainError(
				`Proposal ${original.id} is already ${original.state}.`,
				"CONFLICT",
			);
		}

		const now = new Date().toISOString();
		const replacement = {
			...copy(input.replacement),
			clientEventId: input.replacement.clientEventId ?? null,
			id: randomUUID(),
			state: "pending",
			createdAt: now,
			decidedAt: null,
			decidedBy: null,
			decisionNote: null,
		} as Proposal;

		this.proposals.set(replacement.id, replacement);
		this.proposals.set(original.id, {
			...original,
			state: "superseded",
			decidedAt: now,
			decidedBy: input.decidedBy,
			decisionNote: input.decisionNote,
		});
		this.recordDecisionEffects(
			original.id,
			input.decidedBy,
			input.auditAction,
			{ replacementProposalId: replacement.id },
			"proposal.decided",
			`proposal-decision:${original.id}:superseded`,
			{ proposalId: original.id, state: "superseded" },
		);
		return copy(replacement);
	}

	async decideProposal(
		id: string,
		decision: DecideProposalInput,
	): Promise<Proposal> {
		const proposal = this.proposals.get(id);

		if (!proposal)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (!isOpenProposalState(proposal.state)) {
			throw new DomainError(
				`Proposal ${id} is already ${proposal.state}.`,
				"CONFLICT",
			);
		}

		const decided: Proposal = {
			...proposal,
			state: decision.state,
			decidedAt: new Date().toISOString(),
			decidedBy: decision.decidedBy,
			decisionNote: decision.decisionNote,
		};

		this.proposals.set(id, decided);
		this.recordDecisionEffects(
			id,
			decision.decidedBy,
			decision.auditAction,
			decision.auditDetails ?? {},
			"proposal.decided",
			`proposal-decision:${id}:${decision.state}`,
			{ proposalId: id, state: decision.state },
		);
		return copy(decided);
	}

	private assertOrderedAssessedSourceVersions(sourceIds: string[]): void {
		const events = [...this.eventsByProviderId.values()];
		const cited = sourceIds.map((id) =>
			events.find((event) => event.id === id),
		);

		if (
			cited.some(
				(event) =>
					!event?.observationIdentity?.canonicalObjectKey ||
					!event.observationIdentity.sourceVersionKey ||
					this.revokedEventIds.has(event.id),
			)
		) {
			throw new DomainError(
				"Assessed source identity is unavailable.",
				"CONFLICT",
			);
		}

		const keys = [
			...new Set(
				cited.map(
					(event) => event!.observationIdentity!.canonicalObjectKey,
				),
			),
		];

		for (const key of keys) {
			const versions = events.filter(
				(event) =>
					event.observationIdentity?.canonicalObjectKey === key,
			);

			if (versions.length > 100) {
				throw new DomainError(
					"Assessed source version history exceeds the review bound.",
					"CONFLICT",
				);
			}

			const citedForKey = cited.filter(
				(event) =>
					event!.observationIdentity!.canonicalObjectKey === key,
			);
			const citedVersions = new Set(
				citedForKey.map(
					(event) => event!.observationIdentity!.sourceVersionKey,
				),
			);

			if (
				citedVersions.size !== 1 ||
				versions.some(
					(event) =>
						event.observationIdentity?.sourceVersionKey ===
							citedForKey[0]!.observationIdentity!
								.sourceVersionKey &&
						this.revokedEventIds.has(event.id),
				)
			) {
				throw new DomainError(
					"Assessed source version is unavailable or ambiguous.",
					"CONFLICT",
				);
			}

			const byId = new Map(versions.map((event) => [event.id, event]));
			const reached = new Set<string>();

			for (const start of versions.filter(
				(event) =>
					event.observationIdentity?.sourceVersionKey ===
					citedForKey[0]!.observationIdentity!.sourceVersionKey,
			)) {
				let cursor: typeof start | undefined = start;
				const seen = new Set<string>();

				while (cursor && !seen.has(cursor.id)) {
					seen.add(cursor.id);
					reached.add(cursor.observationIdentity!.sourceVersionKey);
					cursor = cursor.supersedesEventId
						? byId.get(cursor.supersedesEventId)
						: undefined;
				}
			}
			if (
				versions.some(
					(event) =>
						!event.observationIdentity?.sourceVersionKey ||
						!reached.has(
							event.observationIdentity.sourceVersionKey,
						),
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
		const proposal = this.proposals.get(input.proposalId);

		if (!proposal)
			throw new DomainError(
				`Proposal ${input.proposalId} does not exist.`,
				"NOT_FOUND",
			);
		if (proposal.assessmentId) {
			const assessment = this.evidenceAssessments.get(
				proposal.assessmentId,
			);

			if (!assessment)
				throw new DomainError(
					"Assessed decision is unavailable.",
					"CONFLICT",
				);

			const contextIds = await this.listModelCallContextSourceIds(
				assessment.runId,
			);

			if (
				(await this.currentSourceEventIds(contextIds)).length !==
				contextIds.length
			) {
				throw new DomainError(
					"Assessed model context changed before approval.",
					"CONFLICT",
				);
			}
		}
		if (!isOpenProposalState(proposal.state)) {
			if (
				proposal.state === input.state &&
				proposal.decidedBy === input.decidedBy &&
				proposal.decisionNote === input.decisionNote &&
				proposal.evidenceIds.every(
					(id) => !this.revokedEventIds.has(id),
				)
			) {
				if (proposal.assessmentId)
					this.assertOrderedAssessedSourceVersions(
						proposal.evidenceIds,
					);

				const revision = [...this.revisions.values()]
					.flat()
					.find((item) => item.proposalId === proposal.id);

				if (revision) return copy(revision);
			}
			throw new DomainError(
				`Proposal ${proposal.id} is already ${proposal.state}.`,
				"CONFLICT",
			);
		}
		if (
			input.state === "auto_applied" &&
			!input.observationEventId &&
			([...this.outboxJobs.values()].some(
				(job) =>
					job.state === "failed" && job.topic.startsWith("evidence."),
			) ||
				[...this.proposals.values()].some(
					(candidate) =>
						candidate.state === "rejected" &&
						typeof candidate.assessmentId === "string" &&
						this.evidenceAssessments
							.get(candidate.assessmentId)
							?.reasonCodes.includes("authorized_attestation"),
				))
		) {
			throw new DomainError(
				"Automatic evidence application is disabled by an operational failure or rejected attestation.",
				"CONFLICT",
			);
		}
		if (isContextProposal(proposal)) {
			throw new DomainError(
				"Context proposals require context approval.",
				"INVALID",
			);
		}
		if (proposal.assessmentId)
			this.assertOrderedAssessedSourceVersions(proposal.evidenceIds);

		const now = new Date().toISOString();
		const observation = input.observationEventId
			? (await this.getSourceEvents([input.observationEventId]))[0]
			: null;

		if (
			input.observationEventId &&
			(!observation ||
				!proposal.evidenceIds.includes(observation.id) ||
				proposal.assessmentId ||
				proposal.requestedBy !== "observation-agent")
		) {
			throw new DomainError(
				"Invalid observation agent receipt.",
				"INVALID",
			);
		}

		const stateTime = observation?.occurredAt ?? now;
		const previous = proposal.taskId
			? (this.tasks.get(proposal.taskId) ?? null)
			: null;
		let decisionMetadata: DecisionMetadata | null = null;
		let current: Task;

		if (proposal.kind === "task_create") {
			if (proposal.taskId)
				throw new DomainError(
					"Create proposal cannot target a task.",
					"INVALID",
				);
			if (proposal.assessmentId) {
				const assessment = this.evidenceAssessments.get(
					proposal.assessmentId,
				);

				if (
					!assessment ||
					assessment.reasonCodes.includes("historical_evaluation") ||
					assessment.targetType !== "task_create" ||
					assessment.targetId !== null ||
					assessment.claimIds.length === 0 ||
					assessment.disposition === "rejected" ||
					assessment.disposition === "no_change"
				) {
					throw new DomainError(
						"Assessed creation is unavailable.",
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

				const claims = assessment.claimIds.map((id) =>
					this.evidenceClaims.get(id),
				);

				if (claims.some((claim) => !claim))
					throw new DomainError(
						"Assessed request claim is unavailable.",
						"CONFLICT",
					);

				const spans = claims.flatMap((claim) => claim!.body.spans);
				const sourceIds = [
					...new Set(spans.map((span) => span.eventId)),
				].sort();
				const sources = new Map(
					[...this.eventsByProviderId.values()].map((event) => [
						event.id,
						event,
					]),
				);

				if (
					claims.some((claim) => claim!.body.kind !== "request") ||
					spans.length === 0 ||
					sourceIds.length !== proposal.evidenceIds.length ||
					spans.some((span) => {
						const source = sources.get(span.eventId);

						return (
							!source ||
							this.revokedEventIds.has(span.eventId) ||
							!proposal.evidenceIds.includes(span.eventId) ||
							source.observationIdentity?.sourceVersionKey !==
								span.sourceVersionKey ||
							source.observationIdentity?.originObservationKey !==
								span.originObservationKey
						);
					})
				) {
					throw new DomainError(
						"Assessed request source is unavailable.",
						"CONFLICT",
					);
				}
				decisionMetadata = {
					schemaVersion: 1,
					assessmentId: assessment.id,
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

			if (fields.externalRef) {
				const duplicate = [...this.tasks.values()].find(
					(task) => task.externalRef === fields.externalRef,
				);

				if (duplicate)
					throw new DomainError(
						`Task source ${fields.externalRef} already exists.`,
						"CONFLICT",
					);
			}
			current = {
				...copy(fields),
				id: randomUUID(),
				version: 1,
				createdAt: stateTime,
				updatedAt: stateTime,
			};
		} else {
			if (!previous)
				throw new DomainError(
					`Task ${proposal.taskId ?? ""} does not exist.`,
					"NOT_FOUND",
				);
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
				const assessment = this.evidenceAssessments.get(
					proposal.assessmentId,
				);

				if (!assessment)
					throw new DomainError(
						"Assessed decision is unavailable.",
						"CONFLICT",
					);
				if (assessment.reasonCodes.includes("historical_evaluation")) {
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
					const latest = [...(this.revisions.get(previous.id) ?? [])]
						.reverse()
						.find(
							(revision) =>
								revision.previous !== null &&
								JSON.stringify(
									revision.previous[field.operation.field],
								) !==
									JSON.stringify(
										revision.current[field.operation.field],
									),
						);
					const latestEffectiveAt =
						latest?.decisionMetadata?.effectiveAtByField[
							field.operation.field
						] ?? latest?.appliedAt;

					if (
						latestEffectiveAt &&
						(!field.effectiveAt ||
							!Number.isFinite(Date.parse(field.effectiveAt)) ||
							Date.parse(field.effectiveAt) <
								Date.parse(latestEffectiveAt))
					) {
						throw new DomainError(
							"Assessed evidence predates the accepted task field.",
							"CONFLICT",
						);
					}
				}
				for (const field of assessment.body.fields) {
					if (
						field.operation.field !== "status" ||
						field.operation.op !== "set" ||
						field.operation.value !== "done"
					)
						continue;

					const ids = field.operation.supportingClaimIds;

					if (
						ids.length === 0 ||
						ids.some((id) => {
							const claim = this.evidenceClaims.get(id);

							return (
								!claim ||
								(!explicitlyAssertsTaskDone(claim.body) &&
									!(
										claim.body.kind ===
											"completion_report" &&
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
									))
							);
						})
					)
						throw new DomainError(
							"Task completion lacks a reviewed bounded report.",
							"CONFLICT",
						);
				}

				const policy = decideEvidenceApplication({
					task: previous,
					assessment,
				});
				const sourceIds = [
					...new Set(
						assessment.body.fields.flatMap((field) =>
							field.support.map((span) => span.eventId),
						),
					),
				].sort();

				if (
					assessment.targetId !== previous.id ||
					assessment.targetVersion !== String(previous.version) ||
					sourceIds.length === 0 ||
					sourceIds.some((id) => this.revokedEventIds.has(id)) ||
					sourceIds.some(
						(id) => !proposal.evidenceIds.includes(id),
					) ||
					policy.disposition === "rejected" ||
					policy.disposition === "no_change"
				) {
					throw new DomainError(
						"Assessed decision or its source is unavailable.",
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
					assessment.reasonCodes.includes("authorized_attestation") &&
					assessment.reasonCodes.includes(
						`authority_policy:${input.authorityPolicy.id}:v${input.authorityPolicy.version}`,
					) &&
					input.decidedBy ===
						`policy:authority:${input.authorityPolicy.id}:v${input.authorityPolicy.version}`
				) {
					const claim = this.evidenceClaims.get(
						assessment.claimIds[0]!,
					)?.body;
					const source = [...this.eventsByProviderId.values()].find(
						(event) => event.id === sourceIds[0],
					);
					const member =
						this.members.find(
							(item) => item.id === claim?.speakerMemberId,
						) ?? null;
					const identities = this.memberIdentities.filter(
						(identity) =>
							identity.memberId === member?.id &&
							identity.provider === source?.provider &&
							identity.installationKey ===
								source.installationKey &&
							identity.status === "active",
					);
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
						identities.length === 1 &&
						authorizedStatusAttestation({
							claim,
							task: previous,
							source,
							member,
							identity: identities[0]!,
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
				decisionMetadata = {
					schemaVersion: 1,
					assessmentId: assessment.id,
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
					sourceEventIdsByField: Object.fromEntries(
						assessment.body.fields.map((field) => [
							field.operation.field,
							[
								...new Set(
									field.support.map((span) => span.eventId),
								),
							].sort(),
						]),
					),
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
		}
		if (current.projectId) {
			const linked = this.projects.get(current.projectId);

			if (
				!linked ||
				(current.project &&
					![linked.name, ...linked.aliases].some(
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

		if (observation) {
			const fields =
				proposal.kind === "task_create"
					? ["creation", ...Object.keys(proposal.changes)]
					: Object.keys(proposal.changes);

			decisionMetadata = {
				schemaVersion: 1,
				assessmentId: null,
				basis: "model_inferred",
				policyVersion: "observation-agent-v1",
				contractVersion: current.outcomeContract?.version ?? null,
				effectiveAtByField: Object.fromEntries(
					fields.map((field) => [field, observation.occurredAt]),
				),
				sourceEventIdsByField: Object.fromEntries(
					fields.map((field) => [
						field,
						[...new Set(proposal.evidenceIds)].sort(),
					]),
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
				basis: input.state === "approved" ? "manual" : "legacy_unknown",
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
							changedFields.map((field) => [field, sourceIds]),
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

		const decided: Proposal = {
			...proposal,
			state: input.state,
			decidedAt: now,
			decidedBy: input.decidedBy,
			decisionNote: input.decisionNote,
			decisionMetadata,
		};
		const revision: TaskRevision = {
			id: randomUUID(),
			taskId: current.id,
			version: current.version,
			proposalId: proposal.id,
			previous: previous ? copy(previous) : null,
			current: copy(current),
			appliedAt: stateTime,
			appliedBy: input.decidedBy,
			decisionMetadata,
		};

		this.tasks.set(current.id, current);
		this.projectAcceptedTask(current);
		this.proposals.set(proposal.id, decided);

		const revisions = this.revisions.get(current.id) ?? [];

		revisions.push(revision);
		this.revisions.set(current.id, revisions);
		this.recordDecisionEffects(
			proposal.id,
			input.decidedBy,
			input.auditAction,
			input.auditDetails ?? {},
			"projection.task.revised",
			`task-revision:${revision.id}`,
			{
				proposalId: proposal.id,
				taskId: current.id,
				revisionId: revision.id,
				version: current.version,
			},
		);
		return copy(revision);
	}

	async approveAndApplyContextProposal(
		input: ApproveAndApplyProposalInput,
	): Promise<ContextEntry> {
		const proposal = this.proposals.get(input.proposalId);

		if (!proposal)
			throw new DomainError(
				`Proposal ${input.proposalId} does not exist.`,
				"NOT_FOUND",
			);
		if (!isOpenProposalState(proposal.state)) {
			if (
				proposal.state === input.state &&
				proposal.decidedBy === input.decidedBy &&
				proposal.decisionNote === input.decisionNote &&
				isContextProposal(proposal) &&
				proposal.evidenceIds.length > 0 &&
				proposal.evidenceIds.every(
					(id) => !this.revokedEventIds.has(id),
				)
			) {
				if (proposal.assessmentId)
					this.assertOrderedAssessedSourceVersions(
						proposal.evidenceIds,
					);

				const revision = [...this.contextRevisions.values()]
					.flat()
					.find((item) => item.proposalId === proposal.id);

				if (revision) return copy(revision.current);
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

		const sourceById = new Map(
			[...this.eventsByProviderId.values()]
				.filter((event) => !this.revokedEventIds.has(event.id))
				.map((event) => [event.id, event]),
		);
		const sourceEvent = sourceById.get(sourceEventId);

		if (!sourceEvent || sourceIds.some((id) => !sourceById.has(id))) {
			throw new DomainError(
				"A context proposal requires active evidence.",
				"CONFLICT",
			);
		}
		if (proposal.requestedBy === "evidence-summary") {
			if (
				proposal.kind !== "context_file_upsert" ||
				sourceIds.length !== 1 ||
				sourceEvent.eventKind !== "source.document.retrieved" ||
				(await this.currentSourceEventIds(sourceIds)).length !== 1 ||
				input.state === "auto_applied" ||
				input.decidedBy.startsWith("intelligence:") ||
				!input.decisionNote?.trim()
			) {
				throw new DomainError(
					"A refreshed summary requires current evidence and human review.",
					"FORBIDDEN",
				);
			}
		}
		if (proposal.assessmentId)
			this.assertOrderedAssessedSourceVersions(sourceIds);

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

			const assessment = this.evidenceAssessments.get(
				proposal.assessmentId,
			);

			contextAssessment = assessment ?? null;
			if (
				!assessment ||
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

			const claims = assessment.claimIds.map((id) =>
				this.evidenceClaims.get(id),
			);
			const spans = claims.flatMap((claim) => claim?.body.spans ?? []);
			const claim = claims[0]?.body;
			const canonicalObject = spans[0]
				? sourceById.get(spans[0].eventId)?.observationIdentity
						?.canonicalObjectKey
				: null;
			const factIdentity =
				claim?.assertedField &&
				claim.subjectRefs.length &&
				canonicalObject
					? contentHash({
							source: canonicalObject,
							field: claim.assertedField,
							subjects: [...new Set(claim.subjectRefs)].sort(),
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
					const source = sourceById.get(span.eventId);

					return (
						!source ||
						source.observationIdentity?.originObservationKey !==
							span.originObservationKey ||
						source.observationIdentity?.sourceVersionKey !==
							span.sourceVersionKey
					);
				})
			) {
				throw new DomainError(
					"Context source version is stale or unsupported.",
					"CONFLICT",
				);
			}
		}

		const fields = contextEntryFromProposal(
			proposal,
			sourceEventId,
			sourceEvent.contentHash,
			sourceEvent.occurredAt,
		);
		const observation = input.observationEventId
			? sourceById.get(input.observationEventId)
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
			fields.effectiveFrom = observation.occurredAt;
		}

		const existing = this.contextBySourceRef.get(fields.sourceRef);

		if (
			contextAssessment?.targetType === "context" &&
			(!existing ||
				existing.kind !== "fact" ||
				existing.id !== contextAssessment.targetId ||
				contentHash(existing) !== contextAssessment.targetVersion ||
				fields.path !== existing.path ||
				fields.kind !== "fact" ||
				fields.factType !== existing.factType)
		) {
			throw new DomainError(
				"Accepted context fact changed after assessment.",
				"CONFLICT",
			);
		}
		if (proposal.assessmentId && existing) {
			const nextEffective = Date.parse(
				fields.effectiveFrom ?? sourceEvent.occurredAt,
			);
			const oldEffective = Date.parse(
				existing.effectiveFrom ?? existing.updatedAt,
			);
			const previousSource = sourceById.get(existing.sourceEventId);

			if (
				nextEffective < oldEffective ||
				(nextEffective === oldEffective &&
					Date.parse(sourceEvent.receivedAt) <=
						Date.parse(
							previousSource?.receivedAt ??
								"9999-12-31T00:00:00.000Z",
						))
			) {
				throw new DomainError(
					"A newer accepted context fact already exists.",
					"CONFLICT",
				);
			}
		}

		const pathOwner = [...this.contextBySourceRef.values()].find(
			(entry) =>
				entry.path === fields.path &&
				entry.sourceRef !== fields.sourceRef,
		);

		if (pathOwner)
			throw new DomainError(
				`Context path ${fields.path} already exists.`,
				"CONFLICT",
			);

		const now = new Date().toISOString();
		const entry = {
			...copy(fields),
			id: existing?.id ?? randomUUID(),
			updatedAt: observation?.occurredAt ?? now,
		} as ContextEntry;
		const revisions = this.contextRevisions.get(entry.id) ?? [];
		const revision: ContextRevision = {
			id: randomUUID(),
			contextEntryId: entry.id,
			version: revisions.length + 1,
			proposalId: proposal.id,
			previous: existing ? copy(existing) : null,
			current: copy(entry),
			appliedAt: observation?.occurredAt ?? now,
			appliedBy: input.decidedBy,
		};

		this.contextBySourceRef.set(entry.sourceRef, entry);
		revisions.push(revision);
		this.contextRevisions.set(entry.id, revisions);
		this.proposals.set(proposal.id, {
			...proposal,
			state: input.state,
			decidedAt: now,
			decidedBy: input.decidedBy,
			decisionNote: input.decisionNote,
		});
		this.recordDecisionEffects(
			proposal.id,
			input.decidedBy,
			input.auditAction,
			input.auditDetails ?? {},
			"projection.context.updated",
			`context-proposal:${proposal.id}`,
			{
				proposalId: proposal.id,
				contextEntryId: entry.id,
				revisionId: revision.id,
				version: revision.version,
				path: entry.path,
			},
		);
		return copy(entry);
	}

	async listUninterpretedSourceEvents(
		providers: string[],
		limit: number,
		model?: string,
	): Promise<EventAppendResult["event"][]> {
		const processed = new Set(
			[...this.interpretationRuns.values()]
				.filter(
					(run) =>
						run.state === "completed" &&
						(!model || run.model === model),
				)
				.flatMap((run) => run.eventIds),
		);

		return [...this.eventsByProviderId.values()]
			.filter(
				(event) =>
					isInterpretationEligibleSourceEvent(event) &&
					providers.some((selector) => {
						const separator = selector.indexOf(":");

						return separator < 0
							? event.provider === selector
							: event.provider === selector.slice(0, separator) &&
									event.eventKind ===
										selector.slice(separator + 1);
					}) &&
					!processed.has(event.id) &&
					!this.revokedEventIds.has(event.id),
			)
			.sort((left, right) =>
				left.occurredAt.localeCompare(right.occurredAt),
			)
			.slice(0, limit)
			.map(copy);
	}

	async createInterpretationRun(
		input: NewInterpretationRun,
	): Promise<InterpretationRun> {
		const run: InterpretationRun = {
			...copy(input),
			id: randomUUID(),
			state: "running",
			output: null,
			error: null,
			createdAt: new Date().toISOString(),
			completedAt: null,
		};

		this.interpretationRuns.set(run.id, run);
		return copy(run);
	}

	async completeInterpretationRun(
		id: string,
		output: JsonValue,
	): Promise<InterpretationRun> {
		const run = this.interpretationRuns.get(id);

		if (!run)
			throw new DomainError(
				`Interpretation run ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (run.eventIds.some((eventId) => this.revokedEventIds.has(eventId))) {
			throw new DomainError(
				"Interpretation source was revoked before completion.",
				"CONFLICT",
			);
		}

		const completed: InterpretationRun = {
			...run,
			state: "completed",
			output: copy(output),
			completedAt: new Date().toISOString(),
		};

		this.interpretationRuns.set(id, completed);
		return copy(completed);
	}

	async failInterpretationRun(
		id: string,
		error: string,
	): Promise<InterpretationRun> {
		const run = this.interpretationRuns.get(id);

		if (!run)
			throw new DomainError(
				`Interpretation run ${id} does not exist.`,
				"NOT_FOUND",
			);

		const failed: InterpretationRun = {
			...run,
			state: "failed",
			error: run.eventIds.some((eventId) =>
				this.revokedEventIds.has(eventId),
			)
				? "source_revoked"
				: error,
			completedAt: new Date().toISOString(),
		};

		this.interpretationRuns.set(id, failed);
		return copy(failed);
	}

	async getInterpretationRun(id: string): Promise<InterpretationRun | null> {
		const run = this.interpretationRuns.get(id);

		return run ? copy(run) : null;
	}

	async listInterpretationRuns(limit: number): Promise<InterpretationRun[]> {
		return [...this.interpretationRuns.values()]
			.sort((left, right) =>
				right.createdAt.localeCompare(left.createdAt),
			)
			.slice(0, limit)
			.map(copy);
	}

	async getTask(id: string): Promise<Task | null> {
		const task = this.tasks.get(id);

		return task ? copy(task) : null;
	}

	async listProjects(): Promise<Project[]> {
		return [...this.projects.values()]
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(copy);
	}

	async createProjectProposal(
		input: NewProjectProposal,
	): Promise<ProjectProposal> {
		const proposal: ProjectProposal = {
			...copy(input),
			id: randomUUID(),
			state: "pending",
			createdAt: new Date().toISOString(),
			decidedAt: null,
			decidedBy: null,
			decisionNote: null,
		};

		this.projectProposals.set(proposal.id, proposal);
		return copy(proposal);
	}

	async getProjectProposal(id: string): Promise<ProjectProposal | null> {
		const proposal = this.projectProposals.get(id);

		return proposal ? copy(proposal) : null;
	}

	async listProjectProposals(): Promise<ProjectProposal[]> {
		return [...this.projectProposals.values()]
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map(copy);
	}

	async decideProjectProposal(
		id: string,
		state: "rejected" | "superseded",
		actor: string,
		note: string | null,
	): Promise<ProjectProposal> {
		const proposal = this.projectProposals.get(id);

		if (!proposal)
			throw new DomainError(
				`Project proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (!isOpenProposalState(proposal.state))
			throw new DomainError(
				"Project proposal is already decided.",
				"CONFLICT",
			);

		const decided = {
			...proposal,
			state,
			decidedAt: new Date().toISOString(),
			decidedBy: actor,
			decisionNote: note,
		};

		this.projectProposals.set(id, decided);
		await this.appendAuditEvent({
			actor,
			action: `project_proposal.${state}`,
			targetType: "project_proposal",
			targetId: id,
			sourceEventId: null,
			proposalId: null,
			details: { projectId: proposal.projectId },
		});
		return copy(decided);
	}

	async approveProjectProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<ProjectRevision> {
		const proposal = this.projectProposals.get(id);

		if (!proposal)
			throw new DomainError(
				`Project proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (!isOpenProposalState(proposal.state))
			throw new DomainError(
				"Project proposal is already decided.",
				"CONFLICT",
			);

		const now = new Date().toISOString();
		const previous = proposal.projectId
			? (this.projects.get(proposal.projectId) ?? null)
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
		if (
			[...this.projects.values()].some(
				(project) =>
					project.id !== previous?.id &&
					project.name.toLowerCase() === name.toLowerCase(),
			)
		) {
			throw new DomainError(
				"A project with this name already exists.",
				"CONFLICT",
			);
		}

		const current: Project = {
			id: previous?.id ?? randomUUID(),
			organizationId: this.organization.id,
			version: (previous?.version ?? 0) + 1,
			name,
			aliases: [
				...new Set([
					...(proposal.changes.aliases ?? previous?.aliases ?? []),
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
		const revision: ProjectRevision = {
			id: randomUUID(),
			projectId: current.id,
			version: current.version,
			proposalId: id,
			previous: previous ? copy(previous) : null,
			current: copy(current),
			appliedAt: now,
			appliedBy: actor,
		};

		this.projects.set(current.id, current);
		this.projectProposals.set(id, {
			...proposal,
			state: "approved",
			decidedAt: now,
			decidedBy: actor,
			decisionNote: note,
		});

		const revisions = this.projectRevisions.get(current.id) ?? [];

		revisions.push(revision);
		this.projectRevisions.set(current.id, revisions);
		await this.appendAuditEvent({
			actor,
			action: "project_proposal.approved",
			targetType: "project",
			targetId: current.id,
			sourceEventId: null,
			proposalId: null,
			details: { projectProposalId: id, version: current.version },
		});
		return copy(revision);
	}

	async listProjectRevisions(projectId: string): Promise<ProjectRevision[]> {
		return (this.projectRevisions.get(projectId) ?? []).map(copy);
	}

	async listWorkstreams(projectId?: string): Promise<Workstream[]> {
		return [...this.workstreams.values()]
			.filter(
				(workstream) =>
					!projectId || workstream.projectId === projectId,
			)
			.sort((left, right) => left.name.localeCompare(right.name))
			.map(copy);
	}

	async listWorkLinks(taskId?: string): Promise<WorkLink[]> {
		return [...this.workLinks.values()]
			.filter((link) => !taskId || link.taskId === taskId)
			.sort((left, right) =>
				left.targetRef.localeCompare(right.targetRef),
			)
			.map(copy);
	}

	async listWorkLinkRevisions(): Promise<WorkLinkRevision[]> {
		return [...this.workLinkRevisions.values()]
			.flat()
			.sort(
				(left, right) =>
					left.changedAt.localeCompare(right.changedAt) ||
					left.id.localeCompare(right.id),
			)
			.map(copy);
	}

	async upsertWorkLink(input: {
		taskId: string;
		targetTaskId: string | null;
		targetRef: string;
		linkType: WorkLink["linkType"];
		changedBy?: string;
		proposalId?: string | null;
	}): Promise<WorkLink> {
		const existing = [...this.workLinks.values()].find(
			(link) =>
				link.taskId === input.taskId &&
				link.targetRef === input.targetRef &&
				link.linkType === input.linkType,
		);

		if (existing && existing.targetTaskId === input.targetTaskId)
			return copy(existing);

		const now = new Date().toISOString();
		const link: WorkLink = existing
			? { ...existing, targetTaskId: input.targetTaskId, updatedAt: now }
			: {
					id: randomUUID(),
					organizationId: this.organization.id,
					taskId: input.taskId,
					targetTaskId: input.targetTaskId,
					targetRef: input.targetRef,
					linkType: input.linkType,
					createdAt: now,
					updatedAt: now,
				};

		this.workLinks.set(link.id, link);

		const revisions = this.workLinkRevisions.get(link.id) ?? [];

		revisions.push({
			id: randomUUID(),
			organizationId: this.organization.id,
			linkId: link.id,
			version: revisions.length + 1,
			previous: existing ? copy(existing) : null,
			current: copy(link),
			changedAt: now,
			changedBy: input.changedBy ?? "system:unattributed",
			proposalId: input.proposalId ?? null,
		});
		this.workLinkRevisions.set(link.id, revisions);
		return copy(link);
	}

	async findTaskByExternalRef(externalRef: string): Promise<Task | null> {
		const task = [...this.tasks.values()].find(
			(candidate) => candidate.externalRef === externalRef,
		);

		return task ? copy(task) : null;
	}

	async listTasks(): Promise<Task[]> {
		return [...this.tasks.values()]
			.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
			.map(copy);
	}

	async listTaskRevisions(taskId?: string): Promise<TaskRevision[]> {
		return (
			taskId
				? (this.revisions.get(taskId) ?? [])
				: [...this.revisions.values()].flat()
		).map(copy);
	}

	async getTaskRevisionByProposal(
		proposalId: string,
	): Promise<TaskRevision | null> {
		const revision = [...this.revisions.values()]
			.flat()
			.find((candidate) => candidate.proposalId === proposalId);

		return revision ? copy(revision) : null;
	}

	async listTaskProposals(taskId: string): Promise<Proposal[]> {
		const revisionProposalIds = new Set(
			(this.revisions.get(taskId) ?? []).map(
				(revision) => revision.proposalId,
			),
		);

		return [...this.proposals.values()]
			.filter(
				(proposal) =>
					proposal.taskId === taskId ||
					revisionProposalIds.has(proposal.id),
			)
			.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
			.map(copy);
	}

	async rebuildCurrentProjections(
		input: RebuildCurrentProjectionsInput,
	): Promise<void> {
		for (const task of input.tasks) this.tasks.set(task.id, copy(task));
		for (const entry of input.context)
			this.contextBySourceRef.set(entry.sourceRef, copy(entry));
		this.workLinks.clear();
		for (const revisions of this.workLinkRevisions.values()) {
			const latest = revisions.toSorted(
				(a, b) => b.version - a.version,
			)[0];

			if (latest) this.workLinks.set(latest.linkId, copy(latest.current));
		}
		for (const task of input.tasks) this.projectAcceptedTask(task);
		this.audits.push({
			id: randomUUID(),
			organizationId: this.organization.id,
			actor: input.actor,
			action: "projection.rebuilt",
			targetType: "organization",
			targetId: this.organization.id,
			sourceEventId: null,
			proposalId: null,
			details: copy(input.details),
			occurredAt: new Date().toISOString(),
		});
	}

	private projectAcceptedTask(task: Task): void {
		const now = new Date().toISOString();

		for (const [id, link] of this.workLinks) {
			if (link.taskId === task.id && !this.workLinkRevisions.has(id))
				this.workLinks.delete(id);
		}
		for (const targetRef of [...new Set(task.dependencyRefs)]) {
			const target = [...this.tasks.values()].find(
				(candidate) => candidate.externalRef === targetRef,
			);

			if (
				target?.id === task.id ||
				[...this.workLinks.values()].some(
					(link) =>
						link.taskId === task.id &&
						link.linkType === "depends_on" &&
						link.targetRef === targetRef,
				)
			)
				continue;

			const link: WorkLink = {
				id: randomUUID(),
				organizationId: this.organization.id,
				taskId: task.id,
				targetTaskId: target?.id ?? null,
				targetRef,
				linkType: "depends_on",
				createdAt: now,
				updatedAt: now,
			};

			this.workLinks.set(link.id, link);
		}
		if (task.externalRef) {
			for (const [id, link] of this.workLinks) {
				if (
					link.targetRef === task.externalRef &&
					link.targetTaskId !== task.id &&
					!this.workLinkRevisions.has(id)
				) {
					this.workLinks.set(id, {
						...link,
						targetTaskId: task.id,
						updatedAt: now,
					});
				}
			}
		}
	}

	private recordDecisionEffects(
		proposalId: string,
		actor: string,
		action: string,
		details: Record<string, JsonValue>,
		topic: string,
		dedupeKey: string,
		payload: JsonValue,
	): void {
		const now = new Date().toISOString();

		this.audits.push({
			id: randomUUID(),
			organizationId: this.organization.id,
			actor,
			action,
			targetType: "proposal",
			targetId: proposalId,
			sourceEventId: null,
			proposalId,
			details: copy(details),
			occurredAt: now,
		});
		if (
			[...this.outboxJobs.values()].some(
				(job) => job.dedupeKey === dedupeKey,
			)
		)
			return;

		const job: OutboxJob = {
			id: randomUUID(),
			organizationId: this.organization.id,
			topic,
			dedupeKey,
			payload: copy(payload),
			state: "pending",
			attempts: 0,
			availableAt: now,
			lockedAt: null,
			lockedBy: null,
			completedAt: null,
			lastError: null,
			createdAt: now,
			updatedAt: now,
		};

		this.outboxJobs.set(job.id, job);
	}

	async close(): Promise<void> {}
}
