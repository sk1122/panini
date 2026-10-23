import { createHash, randomBytes, randomUUID } from "node:crypto";
import { contentHash } from "./content-hash.js";
import {
	createContextIndex,
	isContextEffective,
	normalizeContextLinks,
	normalizeContextPath,
} from "./context-catalog.js";
import { DomainError } from "./errors.js";
import {
	acceptedSourceEvents,
	currentSourceEvents,
	visibleAcceptedTasks as filterAcceptedTasksBySource,
} from "./accepted-source-access.js";
import {
	normalizeAgentWorkspacePath,
	parseAgentWorkspaceUri,
} from "./agent-workspace.js";
import {
	canReadContextEntry,
	canRecallContextEntry,
	canReadContextPath,
	canReadProject,
	canReadProposal,
	canReadTask,
	canReadVisibility,
	intersectContextScopes,
	normalizeAgentDataScope,
	normalizeContextScope,
	type AccessScope,
} from "./access.js";
import { ProposalPolicy } from "./policy.js";
import { compileTaskPatch } from "../store/task-changes.js";
import { decideEvidenceApplication } from "../intelligence/decision-policy.js";
import {
	meteredExternalFetch,
	meteredProviderFetch,
} from "../intelligence/external-call-meter.js";
import type {
	EvidenceAssessment,
	EvidenceAuthorityPolicy,
	OutcomeContractDraft,
	TaskPatchOperation,
} from "./evidence-types.js";
import { buildWorkEvidenceBundle } from "../reconciliation/evidence-bundle.js";
import {
	PostgresContextCompiler,
	type ContextRetriever,
	type RetrievalQuery,
} from "../retrieval/context-compiler.js";
import {
	LedgerSourceDocumentLibrary,
	type SourceDocumentListInput,
	type SourceDocumentReadInput,
	type SourceDocumentReader,
} from "../retrieval/source-document-library.js";
import type { LedgerStore } from "./store.js";
import {
	agentCapabilities,
	type AgentCapability,
	type AgentDataScope,
	type AgentHarness,
	type AgentProfile,
	type AgentWorkspaceFile,
	type AgentWorkspaceFileSummary,
	type AgentDevice,
	isContextProposal,
	isOpenProposalState,
	type BoardSnapshot,
	type ContextEntry,
	type ContextFactProposalChanges,
	type ContextFactType,
	type ContextFactValue,
	type ContextFileProposalChanges,
	type ContextIndex,
	type ContextLifecycleState,
	type ContextLink,
	type ContextPack,
	type ConnectorSyncState,
	type ConnectorSyncStateUpdate,
	type NewProposal,
	type JsonValue,
	type Member,
	type Observation,
	type Proposal,
	type ProposalChanges,
	type ProposalDetail,
	type Project,
	type ProjectChanges,
	type ProjectProposal,
	type ProjectRevision,
	type RetrievalResult,
	type RepositoryMapping,
	type SourceInstallation,
	type SourceInstallationUpdate,
	type SourceEvent,
	type SourceDocumentRead,
	type SourceDocumentSummary,
	type Task,
	type TaskDetail,
	type TaskFields,
	type TaskProposalChanges,
	type WorkspaceSnapshot,
	type WorkGraph,
	type WorkLink,
	type NewAgentDevice,
	type NewRepositoryMapping,
} from "./types.js";

export interface CreateAgentProfileInput {
	memberId: string;
	name: string;
	harness: AgentHarness;
	description?: string;
	capabilities?: AgentCapability[];
	dataScope?: Partial<AgentDataScope>;
}

export interface AgentEnrollment {
	profile: AgentProfile;
	secret: string;
}

export interface AuthenticatedAgent {
	profile: AgentProfile;
	member: Member;
}

export type ProposalAdjudicationAction =
	"approve" | "reject" | "supersede" | "escalate";

export interface ProposalAdjudicationInput {
	action: ProposalAdjudicationAction;
	actor: string;
	note: string;
	details: Record<string, JsonValue>;
}

export interface ProposalAdjudicationResult {
	proposal: Proposal;
	applied: Task | ContextEntry | null;
	replacedProposalId: string | null;
}

function newEnrollmentSecret(): {
	secret: string;
	tokenHash: string;
	tokenHint: string;
} {
	const secret = `tl_agent_${randomBytes(32).toString("base64url")}`;

	return {
		secret,
		tokenHash: createHash("sha256").update(secret).digest("hex"),
		tokenHint: secret.slice(-6),
	};
}

function enrollmentHash(secret: string): string {
	return createHash("sha256").update(secret).digest("hex");
}

export interface AgentProposalInput {
	clientEventId?: string;
	taskId: string;
	baseRevision?: number;
	changes: TaskProposalChanges;
	rationale: string;
	requestedBy: string;
	evidenceIds?: string[];
}

export interface ProposeTaskCreationInput extends CreateTaskInput {
	result?: import("./evidence-types.js").WorkResult;
	clientEventId?: string;
	externalRef: string;
	sourceUrl?: string | null;
	rationale: string;
	requestedBy: string;
	evidenceIds: string[];
	assessmentId?: string | null;
}

interface ProposeContextBaseInput {
	clientEventId?: string;
	assessmentId?: string | null;
	sourceRef: string;
	path: string;
	title: string;
	sourceUrl?: string | null;
	rationale: string;
	requestedBy: string;
	evidenceIds: string[];
	lifecycleState?: ContextLifecycleState;
	effectiveFrom?: string;
	effectiveTo?: string | null;
	links?: ContextLink[];
}

export interface ProposeContextFileInput extends ProposeContextBaseInput {
	body: string;
}

export interface ProposeContextFactInput extends ProposeContextBaseInput {
	factType: ContextFactType;
	value: ContextFactValue;
}

export type CreateContextEntryInput = (
	| { kind: "file"; path: string; title: string; body: string }
	| {
			kind: "fact";
			path: string;
			title: string;
			factType: ContextFactType;
			value: ContextFactValue;
	  }
) & {
	clientEventId?: string;
	lifecycleState?: ContextLifecycleState;
	effectiveFrom?: string;
	effectiveTo?: string | null;
	links?: ContextLink[];
};

export interface CreateTaskInput {
	clientEventId?: string;
	title: string;
	description?: string;
	status?: TaskFields["status"];
	priority?: TaskFields["priority"];
	owner?: string | null;
	project?: string | null;
	projectId?: string | null;
	dueDate?: string | null;
	dependencyRefs?: string[];
}

export interface IngestResult {
	duplicate: boolean;
	proposal: Proposal | null;
	task: Task | null;
}

export interface ReviseContextLifecycleInput {
	lifecycleState: ContextLifecycleState;
	reason: string;
	effectiveFrom?: string;
	effectiveTo?: string | null;
	links?: ContextLink[];
	clientEventId?: string;
}

const mutableTaskKeys = [
	"title",
	"description",
	"status",
	"priority",
	"owner",
	"project",
	"projectId",
	"dueDate",
	"dependencyRefs",
	"sourceUrl",
] as const satisfies readonly (keyof TaskFields)[];

function changedFields(
	current: Task,
	incoming: TaskFields,
): TaskProposalChanges {
	const changes: TaskProposalChanges = {};

	for (const key of mutableTaskKeys) {
		const before = current[key];
		const after = incoming[key];

		if (JSON.stringify(before) !== JSON.stringify(after)) {
			Object.assign(changes, { [key]: after });
		}
	}
	return changes;
}

function contextTemporalChanges(
	input: ProposeContextBaseInput,
): Pick<
	ContextFileProposalChanges,
	"lifecycleState" | "effectiveFrom" | "effectiveTo" | "links"
> {
	const parseTime = (value: string, label: string): string => {
		const parsed = new Date(value);

		if (Number.isNaN(parsed.getTime()))
			throw new DomainError(
				`${label} must be an ISO timestamp.`,
				"INVALID",
			);
		return parsed.toISOString();
	};

	const effectiveFrom = input.effectiveFrom
		? parseTime(input.effectiveFrom, "Effective from")
		: undefined;
	const effectiveTo = input.effectiveTo
		? parseTime(input.effectiveTo, "Effective to")
		: input.effectiveTo;

	if (effectiveFrom && effectiveTo && effectiveTo <= effectiveFrom) {
		throw new DomainError(
			"Effective to must be later than effective from.",
			"INVALID",
		);
	}
	return {
		...(input.lifecycleState
			? { lifecycleState: input.lifecycleState }
			: {}),
		...(effectiveFrom ? { effectiveFrom } : {}),
		...(effectiveTo !== undefined ? { effectiveTo } : {}),
		...(input.links ? { links: normalizeContextLinks(input.links) } : {}),
	};
}

export class TeamLedger {
	private readonly retriever: ContextRetriever;
	private readonly sourceDocuments: SourceDocumentReader;

	constructor(
		private readonly store: LedgerStore,
		private readonly policy: ProposalPolicy,
		retriever?: ContextRetriever,
		sourceDocuments?: SourceDocumentReader,
	) {
		this.sourceDocuments =
			sourceDocuments ?? new LedgerSourceDocumentLibrary(store);
		this.retriever =
			retriever ??
			new PostgresContextCompiler(store, this.sourceDocuments);
	}

	async workspace(): Promise<WorkspaceSnapshot> {
		const [
			organization,
			members,
			memberIdentities,
			installations,
			connectorSyncs,
		] = await Promise.all([
			this.store.getOrganization(),
			this.store.listMembers(),
			this.store.listMemberIdentities(),
			this.store.listSourceInstallations(),
			this.store.listConnectorSyncStates(),
		]);

		return {
			organization,
			members,
			memberIdentities,
			installations,
			connectorSyncs,
			generatedAt: new Date().toISOString(),
		};
	}

	async companyProjection(access: AccessScope = { kind: "admin" }) {
		const [workspace, graph, entries, audit] = await Promise.all([
			this.workspace(),
			this.workGraph(access),
			this.visibleContextEntries(access),
			access.kind === "admin"
				? this.store.listAuditEvents(50)
				: Promise.resolve([]),
		]);
		const now = new Date().toISOString();
		const activeInstallations = workspace.installations.filter(
			(installation) =>
				installation.status !== "disabled" &&
				installation.status !== "revoked",
		);
		const activeIds = new Set(
			activeInstallations.map((installation) => installation.id),
		);
		const activeSyncs = workspace.connectorSyncs.filter((sync) =>
			activeIds.has(sync.installationId),
		);

		const stale = (installation: SourceInstallation) =>
			(installation.provider === "github" ||
				installation.provider === "notion") &&
			(!installation.lastSuccessAt ||
				Date.now() - new Date(installation.lastSuccessAt).getTime() >
					45 * 60_000);

		const staleSync = (sync: (typeof workspace.connectorSyncs)[number]) => {
			const installation = activeInstallations.find(
				(item) => item.id === sync.installationId,
			);

			return Boolean(
				installation &&
				(installation.provider === "github" ||
					installation.provider === "notion") &&
				(!sync.lastSuccessAt ||
					Date.now() - new Date(sync.lastSuccessAt).getTime() >
						45 * 60_000),
			);
		};

		const sourceCoverage = (
			access.kind === "admin" ? activeInstallations : []
		).map((installation) => ({
			...installation,
			stale: stale(installation),
			scopes: activeSyncs
				.filter((sync) => sync.installationId === installation.id)
				.map((sync) => ({ ...sync, stale: staleSync(sync) })),
		}));

		return {
			organization: workspace.organization,
			generatedAt: now,
			outcomes: graph.projects.filter(
				(project) => project.status === "active",
			),
			activeWorkstreams: graph.workstreams.filter(
				(stream) => stream.status === "active",
			),
			blockers: graph.tasks.filter((task) => task.status === "blocked"),
			recentDecisions: audit
				.filter(
					(event) =>
						event.action.startsWith("proposal.") ||
						event.action.startsWith("context."),
				)
				.slice(0, 12),
			sourceCoverage,
			memoryHealth: {
				total: entries.length,
				currentAccepted: entries.filter((entry) =>
					isContextEffective(entry, now),
				).length,
				needsReview: entries.filter(
					(entry) => entry.lifecycleState === "needs_review",
				).length,
				superseded: entries.filter(
					(entry) => entry.lifecycleState === "superseded",
				).length,
				outsideEffectiveInterval: entries.filter(
					(entry) =>
						entry.lifecycleState === "accepted" &&
						!isContextEffective(entry, now),
				).length,
				coverageIncomplete:
					activeInstallations.length === 0 ||
					activeInstallations.some(
						(installation) => installation.status !== "healthy",
					) ||
					activeInstallations.some(stale) ||
					activeSyncs.some(
						(sync) => sync.status !== "healthy" || staleSync(sync),
					),
			},
		};
	}

	async peopleProjection(access: AccessScope = { kind: "admin" }) {
		const [workspace, tasks, profiles, entries] = await Promise.all([
			this.workspace(),
			this.store.listTasks(),
			this.store.listAgentProfiles(),
			this.visibleContextEntries(access),
		]);
		const revisionsByTask = await Promise.all(
			tasks.map((task) => this.store.listTaskRevisions(task.id)),
		);

		return {
			generatedAt: new Date().toISOString(),
			people: workspace.members.map((member) => {
				const normalizedName =
					member.displayName.toLocaleLowerCase("en");
				const currentWork = tasks.filter(
					(task) =>
						task.owner?.toLocaleLowerCase("en") ===
							normalizedName &&
						task.status !== "done" &&
						task.status !== "cancelled",
				);
				const historicalTaskIds = tasks.flatMap((task, index) => {
					const contributed = revisionsByTask[index]!.some(
						(revision) =>
							revision.previous?.owner?.toLocaleLowerCase(
								"en",
							) === normalizedName ||
							revision.current.owner?.toLocaleLowerCase("en") ===
								normalizedName,
					);

					return contributed ? [task.id] : [];
				});

				return {
					member,
					identities:
						access.kind === "admin"
							? workspace.memberIdentities.filter(
									(identity) =>
										identity.memberId === member.id,
								)
							: [],
					currentWork,
					historicalTaskIds,
					contextEntryIds: entries
						.filter((entry) =>
							entry.links.some(
								(link) =>
									link.type === "member" &&
									(link.targetId === member.id ||
										link.targetRef.toLocaleLowerCase(
											"en",
										) === normalizedName),
							),
						)
						.map((entry) => entry.id),
					agents: profiles.filter(
						(profile) =>
							profile.memberId === member.id &&
							(access.kind === "admin" ||
								profile.memberId === access.memberId),
					),
				};
			}),
		};
	}

	async historyProjection(
		limit = 200,
		view: "all" | "changes" = "all",
		access: AccessScope = { kind: "admin" },
	) {
		const [tasks, allContextRevisions, audit, evidence, proposals] =
			await Promise.all([
				this.store.listTasks(),
				this.store.listContextRevisions(),
				view === "all" && access.kind === "admin"
					? this.store.listAuditEvents(limit)
					: Promise.resolve([]),
				view === "all"
					? this.store.listSourceEvents(limit)
					: Promise.resolve([]),
				view === "changes"
					? this.store.listProposals()
					: Promise.resolve([]),
			]);
		const contextRevisions = (
			await Promise.all(
				allContextRevisions.map(async (revision) => {
					const [currentEvidence, previousEvidence] =
						await Promise.all([
							acceptedSourceEvents(
								this.store,
								revision.current.evidenceIds,
							),
							revision.previous
								? acceptedSourceEvents(
										this.store,
										revision.previous.evidenceIds,
									)
								: Promise.resolve([]),
						]);

					if (
						!canReadContextEntry(
							access,
							revision.current,
							currentEvidence,
						)
					)
						return null;
					return revision.previous &&
						!canReadContextEntry(
							access,
							revision.previous,
							previousEvidence,
						)
						? { ...revision, previous: null }
						: revision;
				}),
			)
		).filter((revision) => revision !== null);
		const visibleTasks = await this.visibleAcceptedTasks(tasks, access);
		const historySafeTasks = (
			await Promise.all(
				visibleTasks.map(async (task) =>
					(await this.canReadTaskHistorySources(task.id, access))
						? task
						: null,
				),
			)
		).filter((task) => task !== null);
		const taskRevisions = (
			await Promise.all(
				historySafeTasks.map((task) =>
					this.store.listTaskRevisions(task.id),
				),
			)
		).flat();
		const proposalsById = new Map(
			(await this.visibleProposals(proposals, access)).map((proposal) => [
				proposal.id,
				proposal,
			]),
		);
		const labels: Record<string, string> = {
			title: "Title",
			description: "Description",
			status: "Status",
			owner: "Owner",
			project: "Project",
			priority: "Priority",
			dueDate: "Due date",
			dependencyRefs: "Dependencies",
			value: "Statement",
			body: "Document",
			lifecycleState: "Review state",
			effectiveFrom: "Effective from",
			effectiveTo: "Effective until",
		};

		const changes = (previous: object | null, current: object) =>
			Object.entries(labels).flatMap(([field, label]) => {
				if (!(field in current)) return [];

				const before = previous
					? (previous as Record<string, unknown>)[field]
					: null;
				const after = (current as Record<string, unknown>)[field];

				return previous &&
					JSON.stringify(before) === JSON.stringify(after)
					? []
					: [{ label, before, after }];
			});

		const items = [
			...taskRevisions.map((revision) => ({
				id: revision.id,
				type: "task_revision" as const,
				state: "accepted" as const,
				subjectId: revision.taskId,
				title: revision.current.title,
				summary: revision.previous
					? `Task updated · ${revision.current.status.replaceAll("_", " ")}`
					: "Task added",
				occurredAt: revision.appliedAt,
				actor: revision.appliedBy,
				proposalId: revision.proposalId,
				changes: changes(revision.previous, revision.current),
				reason:
					proposalsById.get(revision.proposalId)?.rationale ?? null,
			})),
			...contextRevisions.map((revision) => ({
				id: revision.id,
				type: "context_revision" as const,
				state: revision.current.lifecycleState,
				subjectId: revision.contextEntryId,
				title: revision.current.title,
				summary: revision.previous
					? "Knowledge updated"
					: "Knowledge added",
				occurredAt: revision.appliedAt,
				actor: revision.appliedBy,
				proposalId: revision.proposalId,
				changes: changes(revision.previous, revision.current),
				reason:
					proposalsById.get(revision.proposalId)?.rationale ?? null,
			})),
			...evidence
				.filter((event) => canReadVisibility(access, event.visibility))
				.map(({ payload: _payload, ...event }) => ({
					id: event.id,
					type: "source_observation" as const,
					state: "observed" as const,
					subjectId: event.sourceRef,
					title: event.sourceRef,
					summary: `${event.provider}: ${event.eventKind}`,
					occurredAt: event.occurredAt,
					actor: `connector:${event.provider}`,
					proposalId: null,
				})),
			...audit.map((event) => ({
				id: event.id,
				type: "audit_event" as const,
				state: event.action.includes("rejected")
					? "rejected"
					: event.action.includes("escalated")
						? "escalated"
						: "recorded",
				subjectId: event.targetId,
				title: event.targetType,
				summary: event.action,
				occurredAt: event.occurredAt,
				actor: event.actor,
				proposalId: event.proposalId,
			})),
		]
			.sort((left, right) =>
				right.occurredAt.localeCompare(left.occurredAt),
			)
			.slice(0, limit);

		return { items, generatedAt: new Date().toISOString() };
	}

	async syncMember(
		input: Parameters<LedgerStore["upsertMember"]>[0],
		actor: string,
	): Promise<Member> {
		const member = await this.store.upsertMember(input);

		await this.store.appendAuditEvent({
			actor,
			action: "member.synced",
			targetType: "member",
			targetId: member.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				subject: member.subject,
				displayName: member.displayName,
				status: member.status,
			},
		});
		return member;
	}

	async reconcileMemberIdentity(
		input: Parameters<LedgerStore["reconcileMemberIdentity"]>[0],
		actor: string,
	): Promise<Awaited<ReturnType<LedgerStore["reconcileMemberIdentity"]>>> {
		const result = await this.store.reconcileMemberIdentity(input);

		await this.store.appendAuditEvent({
			actor,
			action: result.member
				? "member.identity_reconciled"
				: "member.identity_unresolved",
			targetType: result.member ? "member" : "member_identity",
			targetId: result.member?.id ?? result.identity.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				provider: result.identity.provider,
				installationKey: result.identity.installationKey,
				externalId: result.identity.externalId,
				displayName: result.identity.displayName,
				status: result.identity.status,
				matchedBy: result.matchedBy,
			},
		});
		return result;
	}

	updateConnectorSyncState(
		installationId: string,
		resourceKey: string,
		update: ConnectorSyncStateUpdate,
	): Promise<ConnectorSyncState> {
		return this.store.upsertConnectorSyncState(
			installationId,
			resourceKey,
			update,
		);
	}

	activeSourceRefs(
		provider: string,
		installationKey: string,
		visibility: string,
	): Promise<string[]> {
		return this.store.listActiveSourceRefs(
			provider,
			installationKey,
			visibility,
		);
	}

	async configureInstallation(
		input: Parameters<LedgerStore["upsertSourceInstallation"]>[0],
		actor: string,
	): Promise<SourceInstallation> {
		if (input.provider === "github") {
			const previous = (await this.store.listSourceInstallations()).find(
				(item) =>
					item.provider === "github" &&
					item.installationKey === input.installationKey,
			);

			if (previous && Array.isArray(input.config?.repositories)) {
				const nextRepos = new Set(
					Array.isArray(input.config?.repositories)
						? input.config.repositories
								.filter(
									(name): name is string =>
										typeof name === "string",
								)
								.map((name) => name.toLowerCase())
						: [],
				);

				await this.revokeRemovedGithubRepositories(
					previous,
					nextRepos,
					actor,
				);
			}
		}

		const installation = await this.store.upsertSourceInstallation(input);

		await this.store.appendAuditEvent({
			actor,
			action: "installation.configured",
			targetType: "source_installation",
			targetId: installation.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				provider: installation.provider,
				installationKey: installation.installationKey,
			},
		});
		return installation;
	}

	async updateInstallation(
		id: string,
		update: SourceInstallationUpdate,
		actor: string,
	): Promise<SourceInstallation> {
		const previous = (await this.store.listSourceInstallations()).find(
			(item) => item.id === id,
		);

		if (
			previous?.provider === "github" &&
			(update.status === "revoked" || update.status === "disabled")
		) {
			await this.revokeRemovedGithubRepositories(
				previous,
				new Set(),
				actor,
			);
		}

		const installation = await this.store.updateSourceInstallation(
			id,
			update,
		);

		await this.store.appendAuditEvent({
			actor,
			action: `installation.${installation.status}`,
			targetType: "source_installation",
			targetId: installation.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				provider: installation.provider,
				status: installation.status,
			},
		});
		return installation;
	}

	private async revokeRemovedGithubRepositories(
		installation: SourceInstallation,
		retained: Set<string>,
		actor: string,
	): Promise<void> {
		const names = Array.isArray(installation.config.repositories)
			? installation.config.repositories.filter(
					(name): name is string => typeof name === "string",
				)
			: [];

		for (const name of names) {
			if (!retained.has(name.toLowerCase())) {
				await this.revokeEvidenceByVisibility(
					"github",
					installation.installationKey,
					`github:repository:${name.toLowerCase()}`,
					actor,
				);
			}
		}
	}

	listAuditEvents(limit = 100) {
		return this.store.listAuditEvents(limit);
	}

	async createAgentProfile(
		input: CreateAgentProfileInput,
		actor = "system:direct",
	): Promise<AgentEnrollment> {
		const name = input.name.trim();

		if (!name)
			throw new DomainError(
				"An agent profile requires a name.",
				"INVALID",
			);

		const member = await this.store.getMember(input.memberId);

		if (!member)
			throw new DomainError(
				`Workspace member ${input.memberId} does not exist.`,
				"NOT_FOUND",
			);
		if (member.status !== "active") {
			throw new DomainError(
				`Workspace member ${input.memberId} is not active.`,
				"FORBIDDEN",
			);
		}

		const capabilities = [
			...new Set(input.capabilities ?? agentCapabilities),
		];

		if (capabilities.length === 0) {
			throw new DomainError(
				"An agent profile requires at least one capability grant.",
				"INVALID",
			);
		}

		const token = newEnrollmentSecret();
		const profile = await this.store.createAgentProfile({
			memberId: member.id,
			owner: member.displayName,
			name,
			harness: input.harness,
			description: input.description?.trim() ?? "",
			capabilities,
			dataScope: normalizeAgentDataScope(input.dataScope),
			tokenHash: token.tokenHash,
			tokenHint: token.tokenHint,
		});

		await this.store.appendAuditEvent({
			actor,
			action: "agent_profile.created",
			targetType: "agent_profile",
			targetId: profile.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				owner: profile.owner,
				harness: profile.harness,
				capabilities: profile.capabilities,
			},
		});
		return { profile, secret: token.secret };
	}

	async rotateAgentSecret(
		id: string,
		actor = "system:direct",
	): Promise<AgentEnrollment> {
		const token = newEnrollmentSecret();
		const profile = await this.store.rotateAgentToken(
			id,
			token.tokenHash,
			token.tokenHint,
		);

		await this.store.appendAuditEvent({
			actor,
			action: "agent_profile.secret_rotated",
			targetType: "agent_profile",
			targetId: profile.id,
			sourceEventId: null,
			proposalId: null,
			details: {},
		});
		return { profile, secret: token.secret };
	}

	async updateAgentDataScope(
		id: string,
		scope: Partial<AgentDataScope>,
		actor = "system:direct",
	): Promise<AgentProfile> {
		const dataScope = normalizeAgentDataScope(scope);
		const profile = await this.store.updateAgentDataScope(id, dataScope);

		await this.store.appendAuditEvent({
			actor,
			action: "agent_profile.scope_updated",
			targetType: "agent_profile",
			targetId: profile.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				projects: profile.dataScope.projects,
				contextPaths: profile.dataScope.contextPaths,
				sourceVisibilities: profile.dataScope.sourceVisibilities,
			},
		});
		return profile;
	}

	async revokeAgentProfile(
		id: string,
		actor = "system:direct",
	): Promise<AgentProfile> {
		const profile = await this.store.revokeAgentProfile(id);

		await this.store.appendAuditEvent({
			actor,
			action: "agent_profile.revoked",
			targetType: "agent_profile",
			targetId: profile.id,
			sourceEventId: null,
			proposalId: null,
			details: {},
		});
		return profile;
	}

	listAgentProfiles(memberId?: string): Promise<AgentProfile[]> {
		return this.store.listAgentProfiles(memberId);
	}

	getAgentProfile(id: string): Promise<AgentProfile | null> {
		return this.store.getAgentProfile(id);
	}

	async enrollDevice(
		input: NewAgentDevice,
		actor: string,
	): Promise<AgentDevice> {
		const profile = await this.store.getAgentProfile(input.agentProfileId);

		if (!profile || profile.status !== "active")
			throw new DomainError(
				"An active agent profile is required for device enrollment.",
				"FORBIDDEN",
			);

		const device = await this.store.createAgentDevice(input);

		await this.store.appendAuditEvent({
			actor,
			action: "agent_device.enrolled",
			targetType: "agent_device",
			targetId: device.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				agentProfileId: device.agentProfileId,
				privacyMode: device.privacyMode,
			},
		});
		return device;
	}

	listDevices(agentProfileId?: string): Promise<AgentDevice[]> {
		return this.store.listAgentDevices(agentProfileId);
	}

	getDevice(id: string): Promise<AgentDevice | null> {
		return this.store.getAgentDevice(id);
	}

	touchDevice(id: string): Promise<void> {
		return this.store.touchAgentDevice(id);
	}

	async revokeDevice(id: string, actor: string): Promise<AgentDevice> {
		const device = await this.store.revokeAgentDevice(id);

		await this.store.appendAuditEvent({
			actor,
			action: "agent_device.revoked",
			targetType: "agent_device",
			targetId: device.id,
			sourceEventId: null,
			proposalId: null,
			details: { agentProfileId: device.agentProfileId },
		});
		return device;
	}

	async configureRepositoryMapping(
		input: NewRepositoryMapping,
		actor: string,
	): Promise<RepositoryMapping> {
		const mapping = await this.store.upsertRepositoryMapping({
			repository: input.repository.trim(),
			project: input.project.trim(),
			contextPaths: [
				...new Set(input.contextPaths.map(normalizeContextScope)),
			],
		});

		await this.store.appendAuditEvent({
			actor,
			action: "repository_mapping.configured",
			targetType: "repository_mapping",
			targetId: mapping.id,
			sourceEventId: null,
			proposalId: null,
			details: {
				repository: mapping.repository,
				project: mapping.project,
			},
		});
		return mapping;
	}

	listRepositoryMappings(): Promise<RepositoryMapping[]> {
		return this.store.listRepositoryMappings();
	}

	async accessForRepository(
		repository: string,
		access: AccessScope,
	): Promise<{ access: AccessScope; mapping: RepositoryMapping }> {
		const requested = repository.trim().toLocaleLowerCase("en");
		const mapping = (await this.store.listRepositoryMappings()).find(
			(candidate) =>
				candidate.repository.toLocaleLowerCase("en") === requested,
		);

		if (!mapping)
			throw new DomainError(
				`Repository ${repository} is not mapped.`,
				"NOT_FOUND",
			);
		if (access.kind !== "agent") return { access, mapping };
		if (!canReadProject(access, mapping.project)) {
			throw new DomainError(
				"The authenticated principal cannot access this repository's project.",
				"FORBIDDEN",
			);
		}

		const contextPaths =
			mapping.contextPaths.length === 0
				? access.dataScope.contextPaths
				: intersectContextScopes(
						access.dataScope.contextPaths,
						mapping.contextPaths,
					);

		if (contextPaths.length === 0) {
			throw new DomainError(
				"The authenticated principal has no context path in this repository mapping.",
				"FORBIDDEN",
			);
		}
		return {
			mapping,
			access: {
				...access,
				profileDataScope: access.profileDataScope ?? access.dataScope,
				dataScope: {
					...access.dataScope,
					projects: [mapping.project],
					contextPaths,
				},
			},
		};
	}

	async authenticateAgentSecret(
		secret: string,
	): Promise<AuthenticatedAgent | null> {
		if (!secret.startsWith("tl_agent_")) return null;

		const profile = await this.store.findActiveAgentByTokenHash(
			enrollmentHash(secret),
		);

		if (!profile?.memberId) return null;

		const member = await this.store.getMember(profile.memberId);

		if (!member || member.status !== "active") return null;
		await this.store.touchAgentProfile(profile.id);
		return { profile, member };
	}

	agentWorkspaceRoot(
		access: AccessScope,
		scope: "agent" | "user" = "agent",
	): string {
		if (access.kind !== "agent")
			throw new DomainError(
				"An agent profile is required for a private workspace.",
				"FORBIDDEN",
			);
		return `panini://${access.memberId}/${scope === "user" ? "user" : access.agentProfileId}/`;
	}

	async listAgentWorkspaceFiles(
		access: AccessScope,
		prefix = "",
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFileSummary[]> {
		if (access.kind !== "agent")
			throw new DomainError(
				"An agent profile is required for a private workspace.",
				"FORBIDDEN",
			);
		return this.store.listAgentWorkspaceFiles(
			access.memberId,
			access.agentProfileId,
			prefix ? normalizeAgentWorkspacePath(prefix) : "",
			scope,
		);
	}

	async readAgentWorkspaceFile(
		access: AccessScope,
		uri: string,
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFile | null> {
		if (access.kind !== "agent")
			throw new DomainError(
				"An agent profile is required for a private workspace.",
				"FORBIDDEN",
			);

		const parsed = parseAgentWorkspaceUri(uri);

		if (
			parsed.memberId !== access.memberId ||
			parsed.agentProfileId !==
				(scope === "user" ? "user" : access.agentProfileId)
		) {
			throw new DomainError(
				"Agent workspace URI is outside this profile.",
				"FORBIDDEN",
			);
		}
		return this.store.getAgentWorkspaceFile(
			access.memberId,
			access.agentProfileId,
			parsed.path,
			scope,
		);
	}

	async writeAgentWorkspaceFile(
		access: AccessScope,
		path: string,
		content: string | null,
		expectedVersion: number,
		scope: "agent" | "user" = "agent",
	): Promise<AgentWorkspaceFileSummary> {
		if (access.kind !== "agent")
			throw new DomainError(
				"An agent profile is required for a private workspace.",
				"FORBIDDEN",
			);

		const normalizedPath = normalizeAgentWorkspacePath(path);

		return this.store.writeAgentWorkspaceFile({
			memberId: access.memberId,
			agentProfileId: access.agentProfileId,
			path: normalizedPath,
			scope,
			content,
			expectedVersion,
		});
	}

	async ingest(observation: Observation): Promise<IngestResult> {
		const appended = await this.store.appendSourceEvent(observation.event);

		if (!appended.inserted) {
			return { duplicate: true, proposal: null, task: null };
		}

		// Notion databases are source evidence, not an authoritative work board.
		// Even a stale task_board configuration must not turn a row into a Task.
		if (
			observation.signal.type === "source_document_snapshot" ||
			observation.event.provider === "notion"
		) {
			const revokedIds = await this.store.revokeSourceEventsBySourceRef(
				appended.event.provider,
				appended.event.installationKey,
				appended.event.sourceRef,
				appended.event.id,
			);

			await this.auditEvidenceRevocations(
				revokedIds,
				`connector:${observation.event.provider}`,
				{
					provider: observation.event.provider,
					installationKey: observation.event.installationKey,
					sourceRef: observation.event.sourceRef,
					reason: "superseded_source_document",
				},
			);
			return { duplicate: false, proposal: null, task: null };
		}

		const fields = { ...observation.signal.fields };

		if (!fields.projectId && fields.project) {
			const exact = (await this.store.listProjects()).filter((project) =>
				[project.name, ...project.aliases].some(
					(name) =>
						name.toLowerCase() ===
						fields.project!.trim().toLowerCase(),
				),
			);

			if (exact.length === 1) fields.projectId = exact[0]!.id;
		}

		const current = fields.externalRef
			? await this.store.findTaskByExternalRef(fields.externalRef)
			: null;
		const proposalInput: NewProposal = current
			? {
					kind: "task_change",
					taskId: current.id,
					baseVersion: current.version,
					changes: changedFields(current, fields),
					rationale: `Observed a newer ${observation.event.provider} task snapshot.`,
					requestedBy: `connector:${observation.event.provider}`,
					evidenceIds: [appended.event.id],
				}
			: {
					kind: "task_create",
					taskId: null,
					baseVersion: null,
					changes: fields,
					rationale: `Imported a task from configured ${observation.event.provider} source.`,
					requestedBy: `connector:${observation.event.provider}`,
					evidenceIds: [appended.event.id],
				};

		if (Object.keys(proposalInput.changes).length === 0) {
			return { duplicate: false, proposal: null, task: current };
		}

		const alreadyOpen = await this.store.findOpenProposal(
			proposalInput.taskId,
			proposalInput.changes,
		);

		if (alreadyOpen) {
			return { duplicate: false, proposal: alreadyOpen, task: current };
		}

		const proposal = await this.createProposalIdempotently(proposalInput);
		const decision = this.policy.decide(proposalInput);

		if (decision.action !== "auto_apply") {
			return { duplicate: false, proposal, task: current };
		}

		const revision = await this.store.approveAndApplyProposal({
			proposalId: proposal.id,
			state: "auto_applied",
			decidedBy: "policy:default",
			decisionNote: decision.reason,
			auditAction: "proposal.auto_applied",
		});
		const decided = await this.store.getProposal(proposal.id);

		return { duplicate: false, proposal: decided, task: revision.current };
	}

	async propose(input: AgentProposalInput): Promise<Proposal> {
		if (input.clientEventId && input.baseRevision === undefined) {
			throw new DomainError(
				"A client event ID requires an explicit base revision.",
				"INVALID",
			);
		}

		const proposalInput: NewProposal = {
			clientEventId: input.clientEventId ?? null,
			kind: "task_change",
			taskId: input.taskId,
			baseVersion: input.baseRevision ?? 0,
			changes: input.changes,
			rationale: input.rationale,
			requestedBy: input.requestedBy,
			evidenceIds: input.evidenceIds ?? [],
		};

		if (input.clientEventId) {
			const existing = await this.store.findProposalByClientEvent(
				input.requestedBy,
				input.clientEventId,
			);

			if (existing) {
				this.assertIdempotentProposal(existing, proposalInput);
				return existing;
			}
		}

		const task = await this.requireTask(input.taskId);

		if (Object.keys(input.changes).length === 0) {
			throw new DomainError(
				"A proposal must change at least one task field.",
				"INVALID",
			);
		}
		if (
			input.baseRevision !== undefined &&
			input.baseRevision !== task.version
		) {
			throw new DomainError(
				`Task ${task.id} is at revision ${task.version}; proposal expected revision ${input.baseRevision}.`,
				"CONFLICT",
			);
		}

		const existing = await this.store.findOpenProposal(
			task.id,
			input.changes,
		);

		if (existing) return existing;
		proposalInput.baseVersion = task.version;
		return this.createProposalIdempotently(proposalInput);
	}

	async proposeForAccess(
		input: AgentProposalInput,
		access: AccessScope,
	): Promise<Proposal> {
		await this.getTaskForAccess(input.taskId, access);
		if (
			input.changes.project !== undefined &&
			!canReadProject(access, input.changes.project)
		) {
			throw new DomainError(
				"The authenticated principal cannot move work outside its project scope.",
				"FORBIDDEN",
			);
		}
		await this.assertEvidenceAccess(input.evidenceIds ?? [], access);
		return this.propose(input);
	}

	async proposeOutcomeContractForAccess(
		input: {
			clientEventId: string;
			taskId: string;
			baseRevision: number;
			contract: OutcomeContractDraft;
			rationale: string;
			requestedBy: string;
			evidenceIds: string[];
		},
		access: AccessScope,
	): Promise<Proposal> {
		const task = await this.getTaskForAccess(input.taskId, access);

		if (!task)
			throw new DomainError(
				`Task ${input.taskId} was not found.`,
				"NOT_FOUND",
			);

		const prior = await this.store.findProposalByClientEvent(
			input.requestedBy,
			input.clientEventId,
		);
		const priorContract =
			prior?.kind === "task_change" && "outcomeContract" in prior.changes
				? prior.changes.outcomeContract
				: null;
		const pendingAt = "1970-01-01T00:00:00.000Z";
		const contract = {
			...input.contract,
			version:
				priorContract?.version ??
				(task.outcomeContract?.version ?? 0) + 1,
			criteria: input.contract.criteria.map((criterion) => ({
				...criterion,
				acceptedBy: "pending:review",
				acceptedAt: pendingAt,
			})),
			provenance: {
				proposalId: "00000000-0000-4000-8000-000000000000",
				evidenceIds: input.evidenceIds,
				actor: "pending:review",
				acceptedAt: pendingAt,
			},
		};

		return this.proposeForAccess(
			{
				clientEventId: input.clientEventId,
				taskId: input.taskId,
				baseRevision: input.baseRevision,
				changes: { outcomeContract: contract },
				rationale: input.rationale,
				requestedBy: input.requestedBy,
				evidenceIds: input.evidenceIds,
			},
			access,
		);
	}

	async proposeTaskCreation(
		input: ProposeTaskCreationInput,
	): Promise<Proposal> {
		const changes: TaskProposalChanges = {
			externalRef: input.externalRef,
			title: input.title,
			description: input.description ?? "",
			status: input.status ?? "backlog",
			priority: input.priority ?? "medium",
			owner: input.owner ?? null,
			project: input.project ?? null,
			projectId: input.projectId ?? null,
			dueDate: input.dueDate ?? null,
			dependencyRefs: input.dependencyRefs ?? [],
			sourceUrl: input.sourceUrl ?? null,
			...(input.result !== undefined ? { result: input.result } : {}),
		};
		const proposalInput: NewProposal = {
			clientEventId: input.clientEventId ?? null,
			kind: "task_create",
			taskId: null,
			baseVersion: null,
			changes,
			rationale: input.rationale,
			requestedBy: input.requestedBy,
			evidenceIds: input.evidenceIds,
			assessmentId: input.assessmentId ?? null,
		};
		const existing = await this.store.findOpenProposal(null, changes);

		if (
			existing &&
			(!input.clientEventId ||
				(input.requestedBy === "evidence-pipeline" &&
					existing.requestedBy === "evidence-pipeline"))
		)
			return existing;
		return this.createProposalIdempotently(proposalInput);
	}

	async proposeTaskCreationForAccess(
		input: ProposeTaskCreationInput,
		access: AccessScope,
	): Promise<Proposal> {
		if (input.assessmentId) {
			throw new DomainError(
				"An assessment link is assigned by the evidence pipeline.",
				"INVALID",
			);
		}
		if (!canReadProject(access, input.project ?? null)) {
			throw new DomainError(
				"The authenticated principal cannot create work outside its project scope.",
				"FORBIDDEN",
			);
		}
		await this.assertEvidenceAccess(input.evidenceIds, access);
		return this.proposeTaskCreation(input);
	}

	async proposeContextFile(
		input: ProposeContextFileInput,
	): Promise<Proposal> {
		if (input.evidenceIds.length === 0) {
			throw new DomainError(
				"A context proposal requires evidence.",
				"INVALID",
			);
		}
		if (!input.title.trim() || !input.body.trim()) {
			throw new DomainError(
				"A context file requires a title and content.",
				"INVALID",
			);
		}

		const changes: ContextFileProposalChanges = {
			sourceRef: input.sourceRef,
			path: normalizeContextPath(input.path, "file"),
			title: input.title.trim(),
			body: input.body,
			sourceUrl: input.sourceUrl ?? null,
			...contextTemporalChanges(input),
		};
		const proposalInput: NewProposal = {
			clientEventId: input.clientEventId ?? null,
			assessmentId: input.assessmentId ?? null,
			kind: "context_file_upsert",
			taskId: null,
			baseVersion: null,
			changes,
			rationale: input.rationale,
			requestedBy: input.requestedBy,
			evidenceIds: input.evidenceIds,
		};

		if (input.clientEventId)
			return this.createProposalIdempotently(proposalInput);

		const existing = await this.store.findOpenProposal(null, changes);

		return existing ?? this.createProposalIdempotently(proposalInput);
	}

	async proposeContextFileForAccess(
		input: ProposeContextFileInput,
		access: AccessScope,
	): Promise<Proposal> {
		await this.assertContextProposalAccess(
			input.path,
			"file",
			input.evidenceIds,
			input.links ?? [],
			access,
		);
		return this.proposeContextFile(input);
	}

	async proposeContextFact(
		input: ProposeContextFactInput,
	): Promise<Proposal> {
		if (input.evidenceIds.length === 0) {
			throw new DomainError(
				"A context proposal requires evidence.",
				"INVALID",
			);
		}
		if (
			!input.title.trim() ||
			(typeof input.value === "string" && !input.value.trim())
		) {
			throw new DomainError(
				"An atomic fact requires a title and value.",
				"INVALID",
			);
		}

		const changes: ContextFactProposalChanges = {
			sourceRef: input.sourceRef,
			path: normalizeContextPath(input.path, "fact"),
			title: input.title.trim(),
			factType: input.factType,
			value: input.value,
			sourceUrl: input.sourceUrl ?? null,
			...contextTemporalChanges(input),
		};
		const proposalInput: NewProposal = {
			clientEventId: input.clientEventId ?? null,
			assessmentId: input.assessmentId ?? null,
			kind: "context_fact_upsert",
			taskId: null,
			baseVersion: null,
			changes,
			rationale: input.rationale,
			requestedBy: input.requestedBy,
			evidenceIds: input.evidenceIds,
		};

		if (input.clientEventId)
			return this.createProposalIdempotently(proposalInput);

		const existing = await this.store.findOpenProposal(null, changes);

		return existing ?? this.createProposalIdempotently(proposalInput);
	}

	async proposeContextFactForAccess(
		input: ProposeContextFactInput,
		access: AccessScope,
	): Promise<Proposal> {
		await this.assertContextProposalAccess(
			input.path,
			"fact",
			input.evidenceIds,
			input.links ?? [],
			access,
		);
		return this.proposeContextFact(input);
	}

	async createTask(input: CreateTaskInput, actor: string): Promise<Task> {
		const externalRef = input.clientEventId
			? `team-ledger:manual:${contentHash({ actor, clientEventId: input.clientEventId }).slice(0, 40)}`
			: `team-ledger:manual:${randomUUID()}`;
		const proposal = await this.createProposalIdempotently({
			clientEventId: input.clientEventId ?? null,
			kind: "task_create",
			taskId: null,
			baseVersion: null,
			changes: {
				externalRef,
				title: input.title,
				description: input.description ?? "",
				status: input.status ?? "backlog",
				priority: input.priority ?? "medium",
				owner: input.owner ?? null,
				project: input.project ?? null,
				projectId: input.projectId ?? null,
				dueDate: input.dueDate ?? null,
				dependencyRefs: input.dependencyRefs ?? [],
				sourceUrl: null,
			},
			rationale: "Created directly by an authorized board user.",
			requestedBy: actor,
			evidenceIds: [],
		});

		if (
			proposal.state === "approved" ||
			proposal.state === "auto_applied"
		) {
			const existing =
				await this.store.findTaskByExternalRef(externalRef);

			if (existing) return existing;
			throw new DomainError(
				"The accepted task proposal has no current projection.",
				"CONFLICT",
			);
		}

		const revision = await this.store.approveAndApplyProposal({
			proposalId: proposal.id,
			state: "approved",
			decidedBy: actor,
			decisionNote: "Authorized manual task creation.",
			auditAction: "proposal.approved",
		});

		return revision.current;
	}

	async proposeAssessedTaskChange(input: {
		assessmentId: string;
		operations: TaskPatchOperation[];
		rationale: string;
		requestedBy: string;
	}): Promise<Proposal> {
		const assessment = await this.store.getAssessment(input.assessmentId);

		if (
			!assessment ||
			assessment.targetType !== "task" ||
			!assessment.targetId ||
			!assessment.targetVersion
		) {
			throw new DomainError(
				"Task assessment was not found.",
				"NOT_FOUND",
			);
		}
		if (assessment.reasonCodes.includes("historical_evaluation")) {
			throw new DomainError(
				"Historical assessments cannot be applied to current work.",
				"INVALID",
			);
		}

		const partialProgress =
			assessment.relationship === "part_of" &&
			assessment.reasonCodes.includes(
				"inferred_status_requires_review",
			) &&
			input.operations.length === 1 &&
			input.operations[0]?.field === "status" &&
			input.operations[0].op === "set" &&
			input.operations[0].value === "in_progress";

		if (assessment.relationship !== "same_outcome" && !partialProgress) {
			throw new DomainError(
				"A related or partial claim cannot change the existing task.",
				"INVALID",
			);
		}
		if (
			contentHash(input.operations) !==
			contentHash(assessment.body.fields.map((field) => field.operation))
		) {
			throw new DomainError(
				"Proposed patch differs from the saved assessment.",
				"INVALID",
			);
		}

		const changes = compileTaskPatch(input.operations);
		const applicationKey = contentHash({
			assessmentId: assessment.id,
			targetId: assessment.targetId,
			baseVersion: Number(assessment.targetVersion),
			changes,
		});
		const prior = (
			await this.store.listTaskProposals(assessment.targetId)
		).find((proposal) => proposal.applicationKey === applicationKey);

		if (prior) return prior;

		const task = await this.store.getTask(assessment.targetId);

		if (!task || String(task.version) !== assessment.targetVersion) {
			throw new DomainError(
				"Assessed task version is stale.",
				"CONFLICT",
			);
		}

		const decision = decideEvidenceApplication({ task, assessment });

		if (
			decision.disposition === "rejected" ||
			decision.disposition === "no_change"
		) {
			throw new DomainError(
				"Assessment does not propose an applicable change.",
				"INVALID",
			);
		}

		const claims = await this.store.getClaims(assessment.claimIds);

		if (claims.length !== assessment.claimIds.length)
			throw new DomainError(
				"Assessment claims are unavailable.",
				"CONFLICT",
			);

		const evidenceIds = [
			...new Set(
				claims.flatMap((claim) =>
					claim.body.spans.map((span) => span.eventId),
				),
			),
		].sort();

		if (
			(await this.store.getSourceEvents(evidenceIds)).length !==
			evidenceIds.length
		) {
			throw new DomainError(
				"Assessment source evidence is unavailable.",
				"CONFLICT",
			);
		}
		if (Object.keys(changes).length === 0)
			throw new DomainError(
				"Assessment proposes no task changes.",
				"INVALID",
			);
		return this.store.createProposal({
			clientEventId: null,
			kind: "task_change",
			taskId: task.id,
			baseVersion: task.version,
			changes,
			rationale: input.rationale.trim() || assessment.body.explanation,
			requestedBy: input.requestedBy,
			evidenceIds,
			assessmentId: assessment.id,
			applicationKey,
		});
	}

	async autoApplyAssessedTaskChange(
		proposalId: string,
		authorityPolicy: EvidenceAuthorityPolicy,
	) {
		return this.store.approveAndApplyProposal({
			proposalId,
			state: "auto_applied",
			decidedBy: `policy:authority:${authorityPolicy.id}:v${authorityPolicy.version}`,
			decisionNote: "Exact status attestation from an authorized member.",
			auditAction: "proposal.auto_applied",
			authorityPolicy,
		});
	}

	async proposeProjectCreation(input: {
		changes: ProjectChanges;
		rationale: string;
		requestedBy: string;
		evidenceIds: string[];
	}): Promise<ProjectProposal> {
		const name = input.changes.name?.trim();
		const outcome = input.changes.outcome?.trim();

		if (!name || !outcome)
			throw new DomainError(
				"A new project needs a name and outcome.",
				"INVALID",
			);
		if (input.evidenceIds.length === 0)
			throw new DomainError(
				"A project proposal requires cited evidence.",
				"INVALID",
			);
		await this.requireActiveProjectEvidence(input.evidenceIds);
		return this.store.createProjectProposal({
			kind: "project_create",
			projectId: null,
			baseVersion: null,
			changes: { ...input.changes, name, outcome },
			rationale: input.rationale.trim(),
			requestedBy: input.requestedBy,
			evidenceIds: [...new Set(input.evidenceIds)],
		});
	}

	async proposeProjectChange(
		projectId: string,
		input: {
			baseVersion: number;
			changes: ProjectChanges;
			rationale: string;
			requestedBy: string;
			evidenceIds: string[];
		},
	): Promise<ProjectProposal> {
		const project = (await this.store.listProjects()).find(
			(item) => item.id === projectId,
		);

		if (!project)
			throw new DomainError(
				`Project ${projectId} does not exist.`,
				"NOT_FOUND",
			);
		if (project.version !== input.baseVersion)
			throw new DomainError("Project revision conflict.", "CONFLICT");
		if (Object.keys(input.changes).length === 0)
			throw new DomainError(
				"A project proposal needs a change.",
				"INVALID",
			);
		if (input.evidenceIds.length === 0)
			throw new DomainError(
				"A project proposal requires cited evidence.",
				"INVALID",
			);
		await this.requireActiveProjectEvidence(input.evidenceIds);
		return this.store.createProjectProposal({
			kind: "project_change",
			projectId,
			baseVersion: project.version,
			changes: input.changes,
			rationale: input.rationale.trim(),
			requestedBy: input.requestedBy,
			evidenceIds: [...new Set(input.evidenceIds)],
		});
	}

	async createProject(
		input: {
			name: string;
			outcome: string;
			owner?: string | null;
			aliases?: string[];
		},
		actor: string,
	): Promise<Project> {
		const now = new Date().toISOString();
		const event = await this.store.appendSourceEvent({
			provider: "manual",
			installationKey: actor,
			providerEventId: randomUUID(),
			eventKind: "project.authored",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: `manual:project:${randomUUID()}`,
			sourceUrl: null,
			contentHash: contentHash(input),
			visibility: "company",
			payloadVersion: "manual-project-v1",
			payload: JSON.parse(JSON.stringify(input)) as JsonValue,
		});
		const proposal = await this.proposeProjectCreation({
			changes: {
				name: input.name,
				outcome: input.outcome,
				owner: input.owner ?? null,
				aliases: input.aliases ?? [],
			},
			rationale: "Authored by an authorized workspace user.",
			requestedBy: actor,
			evidenceIds: [event.event.id],
		});

		return (
			await this.approveProjectProposal(
				proposal.id,
				actor,
				"Authorized manual project creation.",
			)
		).current;
	}

	async reviseProject(
		projectId: string,
		baseVersion: number,
		changes: ProjectChanges,
		actor: string,
	): Promise<Project> {
		const project = (await this.store.listProjects()).find(
			(item) => item.id === projectId,
		);

		if (!project)
			throw new DomainError(
				`Project ${projectId} does not exist.`,
				"NOT_FOUND",
			);
		if (project.version !== baseVersion)
			throw new DomainError("Project revision conflict.", "CONFLICT");

		const now = new Date().toISOString();
		const event = await this.store.appendSourceEvent({
			provider: "manual",
			installationKey: actor,
			providerEventId: randomUUID(),
			eventKind: "project.revision.authored",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: project.sourceRef,
			sourceUrl: project.sourceUrl,
			contentHash: contentHash({ projectId, baseVersion, changes }),
			visibility: "company",
			payloadVersion: "manual-project-revision-v1",
			payload: JSON.parse(
				JSON.stringify({ projectId, baseVersion, changes }),
			) as JsonValue,
		});
		const proposal = await this.proposeProjectChange(projectId, {
			baseVersion,
			changes,
			rationale: "Authored by an authorized workspace user.",
			requestedBy: actor,
			evidenceIds: [event.event.id],
		});

		return (
			await this.approveProjectProposal(
				proposal.id,
				actor,
				"Authorized manual project revision.",
			)
		).current;
	}

	async approveProjectProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<ProjectRevision> {
		const proposal = await this.store.getProjectProposal(id);

		if (!proposal)
			throw new DomainError(
				`Project proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		await this.requireActiveProjectEvidence(proposal.evidenceIds);
		return this.store.approveProjectProposal(id, actor, note);
	}

	async rejectProjectProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<ProjectProposal> {
		return this.store.decideProjectProposal(id, "rejected", actor, note);
	}

	async listProjectProposals(
		access: AccessScope = { kind: "admin" },
	): Promise<ProjectProposal[]> {
		const proposals = await this.store.listProjectProposals();

		if (access.kind === "admin") return proposals;

		const evidence = await this.store.getSourceEvents([
			...new Set(proposals.flatMap((proposal) => proposal.evidenceIds)),
		]);
		const readable = new Set(
			evidence
				.filter((event) => canReadVisibility(access, event.visibility))
				.map((event) => event.id),
		);
		const projects = await this.visibleAcceptedProjects(
			await this.store.listProjects(),
			access,
		);
		const visibleIds = new Set(projects.map((project) => project.id));

		return proposals.filter(
			(proposal) =>
				proposal.evidenceIds.every((id) => readable.has(id)) &&
				(!proposal.projectId || visibleIds.has(proposal.projectId)),
		);
	}

	async projectDetail(id: string, access: AccessScope = { kind: "admin" }) {
		const [projects, tasks, proposals, revisions] = await Promise.all([
			this.store.listProjects(),
			this.store.listTasks(),
			this.listProjectProposals(access),
			this.store.listProjectRevisions(id),
		]);
		const project = projects.find((item) => item.id === id);

		if (!project)
			throw new DomainError(`Project ${id} does not exist.`, "NOT_FOUND");
		if (
			(await this.visibleAcceptedProjects([project], access)).length ===
				0 ||
			!(await this.canReadProjectHistorySources(id, access))
		) {
			throw new DomainError(
				"The authenticated principal cannot read this project history.",
				"FORBIDDEN",
			);
		}
		return {
			project,
			tasks: await this.visibleAcceptedTasks(
				tasks.filter((task) => task.projectId === id),
				access,
			),
			proposals: proposals.filter(
				(proposal) =>
					proposal.projectId === id ||
					revisions.some(
						(revision) => revision.proposalId === proposal.id,
					),
			),
			revisions,
		};
	}

	async workEvidenceBundle(
		eventId: string,
		allowedVisibilities: string[],
		allowedProviders: string[] = ["notion", "slack", "github", "agent"],
	) {
		const [primary] = await this.store.getSourceEvents([eventId]);

		if (!primary)
			throw new DomainError(
				"Work evidence is missing or revoked.",
				"NOT_FOUND",
			);
		if (
			!allowedVisibilities.includes(primary.visibility) ||
			!allowedProviders.includes(primary.provider)
		) {
			throw new DomainError(
				"This source is not enabled for the work decision pilot.",
				"FORBIDDEN",
			);
		}

		const scanLimit = 2_000;
		const [recentEvents, projects, tasks] = await Promise.all([
			this.store.listSourceEvents(scanLimit),
			this.store.listProjects(),
			this.store.listTasks(),
		]);

		return buildWorkEvidenceBundle({
			primary,
			recentEvents: recentEvents.filter(
				(event) =>
					allowedVisibilities.includes(event.visibility) &&
					allowedProviders.includes(event.provider),
			),
			projects,
			tasks,
			scanLimit,
			scannedCount: recentEvents.length,
		});
	}

	private async requireActiveProjectEvidence(ids: string[]): Promise<void> {
		const unique = [...new Set(ids)];
		const evidence = await this.store.getSourceEvents(unique);

		if (evidence.length !== unique.length)
			throw new DomainError(
				"Project evidence is missing or revoked.",
				"FORBIDDEN",
			);
	}

	async createContextEntry(
		input: CreateContextEntryInput,
		actor: string,
		access: AccessScope = { kind: "admin" },
	): Promise<ContextEntry> {
		const path = normalizeContextPath(input.path, input.kind);
		const sourceRef = `team-ledger:manual-context:${input.kind}:${path}`;
		const pathOwner = (await this.store.listContextEntries()).find(
			(entry) => entry.path === path,
		);

		if (
			pathOwner &&
			!canReadContextEntry(
				access,
				pathOwner,
				await this.store.getSourceEvents(pathOwner.evidenceIds),
			)
		) {
			throw new DomainError(
				"The authenticated principal cannot change this context entry.",
				"FORBIDDEN",
			);
		}
		if (pathOwner && pathOwner.sourceRef !== sourceRef) {
			throw new DomainError(
				`Context path ${path} already belongs to another source.`,
				"CONFLICT",
			);
		}

		const title = input.title.trim();

		if (!title)
			throw new DomainError(
				"A context entry requires a title.",
				"INVALID",
			);
		if (input.kind === "file" && !input.body.trim()) {
			throw new DomainError(
				"A context file requires content.",
				"INVALID",
			);
		}

		const now = new Date().toISOString();
		const event = await this.store.appendSourceEvent({
			provider: "manual",
			installationKey: actor,
			providerEventId: input.clientEventId ?? randomUUID(),
			eventKind: `context.${input.kind}.authored`,
			occurredAt: now,
			fetchedAt: now,
			sourceRef,
			sourceUrl: null,
			contentHash: contentHash(input),
			visibility: "company",
			payloadVersion: "manual-context-v1",
			payload: JSON.parse(JSON.stringify(input)) as JsonValue,
		});
		const common = {
			...(input.clientEventId
				? { clientEventId: input.clientEventId }
				: {}),
			sourceRef: event.event.sourceRef,
			path,
			title,
			sourceUrl: null,
			rationale: "Authored directly by an authorized workspace user.",
			requestedBy: actor,
			evidenceIds: [event.event.id],
			...(input.lifecycleState
				? { lifecycleState: input.lifecycleState }
				: {}),
			...(input.effectiveFrom
				? { effectiveFrom: input.effectiveFrom }
				: {}),
			...(input.effectiveTo !== undefined
				? { effectiveTo: input.effectiveTo }
				: {}),
			...(input.links ? { links: input.links } : {}),
		};
		const proposal =
			input.kind === "file"
				? await this.proposeContextFile({ ...common, body: input.body })
				: await this.proposeContextFact({
						...common,
						factType: input.factType,
						value: input.value,
					});

		if (
			proposal.state === "approved" ||
			proposal.state === "auto_applied"
		) {
			const existing = (await this.store.listContextEntries()).find(
				(entry) => entry.sourceRef === sourceRef,
			);

			if (existing) return existing;
			throw new DomainError(
				"The accepted context proposal has no current projection.",
				"CONFLICT",
			);
		}
		return this.store.approveAndApplyContextProposal({
			proposalId: proposal.id,
			state: "approved",
			decidedBy: actor,
			decisionNote: "Authorized manual context entry.",
			auditAction: "proposal.approved",
		});
	}

	async reviseContextLifecycle(
		id: string,
		input: ReviseContextLifecycleInput,
		actor: string,
		access: AccessScope = { kind: "admin" },
	): Promise<ContextEntry> {
		const entry = await this.store.getContextEntry(id);

		if (!entry)
			throw new DomainError(
				`Context entry ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (
			!canReadContextEntry(
				access,
				entry,
				await this.store.getSourceEvents(entry.evidenceIds),
			)
		) {
			throw new DomainError(
				"The authenticated principal cannot change this context entry.",
				"FORBIDDEN",
			);
		}

		const reason = input.reason.trim();

		if (!reason)
			throw new DomainError(
				"A context lifecycle revision requires a reason.",
				"INVALID",
			);

		const now = new Date().toISOString();
		const receiptKey = input.clientEventId ?? randomUUID();
		const receipt = await this.store.appendSourceEvent({
			provider: "manual",
			installationKey: actor,
			providerEventId: receiptKey,
			eventKind: "context.lifecycle.reviewed",
			occurredAt: now,
			fetchedAt: now,
			// A lifecycle decision is a new receipt, not a replacement of the original source.
			sourceRef: `${entry.sourceRef}:lifecycle:${receiptKey}`,
			sourceUrl: entry.sourceUrl,
			contentHash: contentHash({
				contextEntryId: entry.id,
				previousState: entry.lifecycleState,
				lifecycleState: input.lifecycleState,
				effectiveFrom: input.effectiveFrom ?? entry.effectiveFrom,
				effectiveTo:
					input.effectiveTo === undefined
						? entry.effectiveTo
						: input.effectiveTo,
				links: input.links ?? entry.links,
				reason,
			}),
			visibility: "company",
			payloadVersion: "context-lifecycle-v1",
			payload: {
				contextEntryId: entry.id,
				previousState: entry.lifecycleState,
				lifecycleState: input.lifecycleState,
				reason,
			},
		});
		const common = {
			...(input.clientEventId
				? { clientEventId: input.clientEventId }
				: {}),
			sourceRef: entry.sourceRef,
			path: entry.path,
			title: entry.title,
			sourceUrl: entry.sourceUrl,
			rationale: reason,
			requestedBy: actor,
			evidenceIds: [...new Set([...entry.evidenceIds, receipt.event.id])],
			lifecycleState: input.lifecycleState,
			effectiveFrom: input.effectiveFrom ?? entry.effectiveFrom,
			effectiveTo:
				input.effectiveTo === undefined
					? entry.effectiveTo
					: input.effectiveTo,
			links: input.links ?? entry.links,
		};
		const proposal =
			entry.kind === "file"
				? await this.proposeContextFile({ ...common, body: entry.body })
				: await this.proposeContextFact({
						...common,
						factType: entry.factType,
						value: entry.value,
					});

		if (
			proposal.state === "approved" ||
			proposal.state === "auto_applied"
		) {
			const revision = await this.store.getContextRevisionByProposal(
				proposal.id,
			);

			if (revision) return revision.current;
			throw new DomainError(
				"The accepted lifecycle proposal has no immutable revision.",
				"CONFLICT",
			);
		}
		return this.store.approveAndApplyContextProposal({
			proposalId: proposal.id,
			state: "approved",
			decidedBy: actor,
			decisionNote: reason,
			auditAction: "context.lifecycle_revised",
			auditDetails: {
				previousState: entry.lifecycleState,
				lifecycleState: input.lifecycleState,
			},
		});
	}

	async approveProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<Task | ContextEntry> {
		const proposal = await this.store.getProposal(id);

		if (!proposal)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);

		const evidence = await currentSourceEvents(
			this.store,
			proposal.evidenceIds,
		);

		if (evidence.length !== new Set(proposal.evidenceIds).size) {
			throw new DomainError(
				"Proposal evidence is no longer current or available.",
				"CONFLICT",
			);
		}
		if (
			proposal.state === "approved" ||
			proposal.state === "auto_applied"
		) {
			if (isContextProposal(proposal)) {
				const revision =
					await this.store.getContextRevisionByProposal(id);

				if (revision) return revision.current;
			} else {
				const revision = await this.store.getTaskRevisionByProposal(id);

				if (revision) return revision.current;
			}
			throw new DomainError(
				`Accepted proposal ${id} has no immutable revision.`,
				"CONFLICT",
			);
		}
		if (!isOpenProposalState(proposal.state)) {
			throw new DomainError(
				`Proposal ${id} is already ${proposal.state}.`,
				"CONFLICT",
			);
		}
		if (isContextProposal(proposal)) {
			const entry = await this.store.approveAndApplyContextProposal({
				proposalId: id,
				state: "approved",
				decidedBy: actor,
				decisionNote: note,
				auditAction: "proposal.approved",
			});

			return entry;
		}

		const revision = await this.store.approveAndApplyProposal({
			proposalId: id,
			state: "approved",
			decidedBy: actor,
			decisionNote: note,
			auditAction: "proposal.approved",
		});

		return revision.current;
	}

	async rejectProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<Proposal> {
		const current = await this.store.getProposal(id);

		if (!current)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (current.state === "rejected") return current;
		if (!isOpenProposalState(current.state))
			throw new DomainError(
				`Proposal ${id} is already ${current.state}.`,
				"CONFLICT",
			);

		const proposal = await this.store.decideProposal(id, {
			state: "rejected",
			decidedBy: actor,
			decisionNote: note,
			auditAction: "proposal.rejected",
		});

		return proposal;
	}

	async editProposal(
		id: string,
		changes: ProposalChanges,
		rationale: string,
		actor: string,
		clientEventId?: string,
	): Promise<Proposal> {
		const proposal = await this.store.getProposal(id);

		if (!proposal)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (clientEventId) {
			const existing = await this.store.findProposalByClientEvent(
				actor,
				clientEventId,
			);

			if (existing) {
				this.assertIdempotentProposal(existing, {
					clientEventId,
					kind: proposal.kind,
					taskId: proposal.taskId,
					baseVersion: existing.baseVersion,
					changes,
					rationale: rationale.trim() || proposal.rationale,
					requestedBy: actor,
					evidenceIds: proposal.evidenceIds,
				} as NewProposal);
				return existing;
			}
		}
		if (!isOpenProposalState(proposal.state))
			throw new DomainError(
				`Proposal ${id} is already ${proposal.state}.`,
				"CONFLICT",
			);

		const task = proposal.taskId
			? await this.requireTask(proposal.taskId)
			: null;
		const common = {
			clientEventId: clientEventId ?? null,
			taskId: proposal.taskId,
			baseVersion: task?.version ?? proposal.baseVersion,
			rationale: rationale.trim() || proposal.rationale,
			requestedBy: actor,
			evidenceIds: proposal.evidenceIds,
		};

		return this.store.replaceProposal({
			proposalId: id,
			replacement: {
				...common,
				kind: proposal.kind,
				changes,
			} as NewProposal,
			decidedBy: actor,
			decisionNote: "Superseded by an edited proposal.",
			auditAction: "proposal.edited",
		});
	}

	async supersedeProposal(
		id: string,
		actor: string,
		note: string | null,
	): Promise<Proposal> {
		const current = await this.store.getProposal(id);

		if (!current)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (current.state === "superseded") return current;
		if (!isOpenProposalState(current.state))
			throw new DomainError(
				`Proposal ${id} is already ${current.state}.`,
				"CONFLICT",
			);

		const proposal = await this.store.decideProposal(id, {
			state: "superseded",
			decidedBy: actor,
			decisionNote: note,
			auditAction: "proposal.superseded",
		});

		return proposal;
	}

	async adjudicateProposal(
		id: string,
		input: ProposalAdjudicationInput,
	): Promise<ProposalAdjudicationResult> {
		const current = await this.store.getProposal(id);

		if (!current)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (current.state !== "pending") {
			throw new DomainError(
				`Proposal ${id} is already ${current.state}.`,
				"CONFLICT",
			);
		}

		const auditDetails = {
			...input.details,
			adjudicationAction: input.action,
		};

		if (
			input.action === "reject" ||
			input.action === "supersede" ||
			input.action === "escalate"
		) {
			const proposal = await this.store.decideProposal(id, {
				state:
					input.action === "escalate"
						? "escalated"
						: input.action === "reject"
							? "rejected"
							: "superseded",
				decidedBy: input.actor,
				decisionNote: input.note,
				auditAction:
					input.action === "escalate"
						? "proposal.autonomously_escalated"
						: input.action === "reject"
							? "proposal.autonomously_rejected"
							: "proposal.autonomously_superseded",
				auditDetails,
			});

			return { proposal, applied: null, replacedProposalId: null };
		}

		let proposal = current;
		let replacedProposalId: string | null = null;

		if (proposal.kind === "task_change" && proposal.taskId) {
			const task = await this.requireTask(proposal.taskId);

			if (task.version !== proposal.baseVersion) {
				replacedProposalId = proposal.id;
				proposal = await this.store.replaceProposal({
					proposalId: proposal.id,
					replacement: {
						clientEventId: null,
						kind: proposal.kind,
						taskId: proposal.taskId,
						baseVersion: task.version,
						changes: proposal.changes,
						rationale: proposal.rationale,
						requestedBy: input.actor,
						evidenceIds: proposal.evidenceIds,
					},
					decidedBy: input.actor,
					decisionNote: `Autonomously rebased before approval. ${input.note}`,
					auditAction: "proposal.autonomously_rebased",
				});
			}
		}

		const approval = {
			proposalId: proposal.id,
			state: "approved" as const,
			decidedBy: input.actor,
			decisionNote: input.note,
			auditAction: "proposal.autonomously_approved",
			auditDetails: {
				...auditDetails,
				...(replacedProposalId ? { replacedProposalId } : {}),
			},
		};
		const applied = isContextProposal(proposal)
			? await this.store.approveAndApplyContextProposal(approval)
			: (await this.store.approveAndApplyProposal(approval)).current;
		const decided = await this.store.getProposal(proposal.id);

		if (!decided)
			throw new DomainError(
				`Approved proposal ${proposal.id} disappeared.`,
				"CONFLICT",
			);
		return { proposal: decided, applied, replacedProposalId };
	}

	async rebaseProposal(
		id: string,
		actor: string,
		clientEventId?: string,
	): Promise<Proposal> {
		const proposal = await this.store.getProposal(id);

		if (!proposal)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);
		if (proposal.kind !== "task_change" || !proposal.taskId) {
			throw new DomainError(
				"Only a task-change proposal can be rebased.",
				"INVALID",
			);
		}
		if (clientEventId) {
			const existing = await this.store.findProposalByClientEvent(
				actor,
				clientEventId,
			);

			if (existing) {
				this.assertIdempotentProposal(existing, {
					clientEventId,
					kind: proposal.kind,
					taskId: proposal.taskId,
					baseVersion: existing.baseVersion,
					changes: proposal.changes,
					rationale: proposal.rationale,
					requestedBy: actor,
					evidenceIds: proposal.evidenceIds,
				});
				return existing;
			}
		}
		if (!isOpenProposalState(proposal.state))
			throw new DomainError(
				`Proposal ${id} is already ${proposal.state}.`,
				"CONFLICT",
			);

		const task = await this.requireTask(proposal.taskId);

		return this.store.replaceProposal({
			proposalId: id,
			replacement: {
				clientEventId: clientEventId ?? null,
				kind: proposal.kind,
				taskId: proposal.taskId,
				baseVersion: task.version,
				changes: proposal.changes,
				rationale: proposal.rationale,
				requestedBy: actor,
				evidenceIds: proposal.evidenceIds,
			},
			decidedBy: actor,
			decisionNote: "Superseded by a rebased proposal.",
			auditAction: "proposal.rebased",
		});
	}

	async undoTask(
		taskId: string,
		actor: string,
		note: string | null,
		clientEventId?: string,
	): Promise<Task> {
		if (clientEventId) {
			const existing = await this.store.findProposalByClientEvent(
				actor,
				clientEventId,
			);

			if (existing) {
				if (
					existing.taskId !== taskId ||
					existing.kind !== "task_change"
				) {
					throw new DomainError(
						`Client event ${clientEventId} was already used for another command.`,
						"CONFLICT",
					);
				}

				const revision = await this.store.getTaskRevisionByProposal(
					existing.id,
				);

				if (revision) return revision.current;
				throw new DomainError(
					`Undo proposal ${existing.id} has no immutable revision.`,
					"CONFLICT",
				);
			}
		}

		const [task, revisions] = await Promise.all([
			this.requireTask(taskId),
			this.store.listTaskRevisions(taskId),
		]);
		const previous = revisions.at(-1)?.previous;

		if (!previous)
			throw new DomainError(
				"The initial task creation cannot be undone; propose cancellation instead.",
				"CONFLICT",
			);

		const changes: TaskProposalChanges = {};

		for (const key of mutableTaskKeys) {
			if (JSON.stringify(task[key]) !== JSON.stringify(previous[key])) {
				Object.assign(changes, {
					[key]:
						key === "projectId"
							? (previous.projectId ?? null)
							: previous[key],
				});
			}
		}

		const proposal = await this.createProposalIdempotently({
			clientEventId: clientEventId ?? null,
			kind: "task_change",
			taskId,
			baseVersion: task.version,
			changes,
			rationale: `Undo task revision ${task.version}.`,
			requestedBy: actor,
			evidenceIds: [],
		});
		const revision = await this.store.approveAndApplyProposal({
			proposalId: proposal.id,
			state: "approved",
			decidedBy: actor,
			decisionNote:
				note ?? `Restored values from revision ${previous.version}.`,
			auditAction: "task.revision_undone",
			auditDetails: { revertedVersion: task.version },
		});

		return revision.current;
	}

	async board(
		access: AccessScope = { kind: "admin" },
	): Promise<BoardSnapshot> {
		const [tasks, pending, escalated] = await Promise.all([
			this.store.listTasks(),
			this.store.listProposals("pending"),
			this.store.listProposals("escalated"),
		]);
		const visibleTasks = await this.visibleAcceptedTasks(tasks, access);
		const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
		const proposals = (
			await this.visibleProposals([...pending, ...escalated], access)
		)
			.filter(
				(proposal) =>
					!proposal.taskId || visibleTaskIds.has(proposal.taskId),
			)
			.sort((left, right) =>
				right.createdAt.localeCompare(left.createdAt),
			);

		return {
			tasks: visibleTasks,
			proposals,
			generatedAt: new Date().toISOString(),
		};
	}

	async workGraph(
		access: AccessScope = { kind: "admin" },
	): Promise<WorkGraph> {
		const [projects, workstreams, tasks, links] = await Promise.all([
			this.store.listProjects(),
			this.store.listWorkstreams(),
			this.store.listTasks(),
			this.store.listWorkLinks(),
		]);
		const visibleTasks = await this.visibleAcceptedTasks(tasks, access);
		const visibleTaskIds = new Set(visibleTasks.map((task) => task.id));
		const visibleProjects = await this.visibleAcceptedProjects(
			projects,
			access,
		);
		const visibleProjectIds = new Set(
			visibleProjects.map((project) => project.id),
		);

		return {
			projects: visibleProjects,
			workstreams: workstreams.filter((item) =>
				visibleProjectIds.has(item.projectId),
			),
			tasks: visibleTasks,
			links: links.filter(
				(link) =>
					visibleTaskIds.has(link.taskId) &&
					(access.kind !== "agent" ||
						Boolean(
							link.targetTaskId &&
							visibleTaskIds.has(link.targetTaskId),
						)),
			),
			generatedAt: new Date().toISOString(),
		};
	}

	async workModelForAccess(taskId: string, access: AccessScope) {
		const task = await this.store.getTask(taskId);

		if (
			!task ||
			!canReadTask(access, task) ||
			!(await this.visibleAcceptedTasks([task], access)).length
		)
			throw new DomainError("Work task was not found.", "NOT_FOUND");

		const allowed =
			access.kind === "admin"
				? null
				: access.kind === "member"
					? ["company", `member:${access.memberId}`]
					: [
							...access.dataScope.sourceVisibilities,
							`member:${access.memberId}`,
						];
		const receipts =
			(await this.store.readWorkStateAssessments?.(taskId, allowed)) ??
			[];
		const revisions = await this.store.listTaskRevisions(taskId);

		return {
			task,
			scope: (await this.store.readWorkScope?.(taskId, allowed)) ?? null,
			evidence: await this.workEvidenceForAccess(access, {
				taskId,
				limit: 100,
			}),
			assessments: receipts.map((receipt) => ({
				id: receipt.id,
				taskVersion: receipt.context.task.version,
				scopeId: receipt.context.scope.id,
				modelCallId: receipt.modelCallId,
				changes: receipt.context.changes,
				assessment: receipt.assessment,
				appliedVersion:
					revisions.find(
						(revision) =>
							revision.decisionMetadata?.workStateAssessmentId ===
							receipt.id,
					)?.version ?? null,
				basis: "model_inferred",
				independentlyVerified: false,
			})),
		};
	}

	async workEvidenceForAccess(
		access: AccessScope,
		query: { taskId?: string; entityId?: string; limit?: number } = {},
	) {
		if (!this.store.readWorkEvidence) return [];

		const visible = await this.visibleAcceptedTasks(
			(await this.store.listTasks()).filter((task) =>
				canReadTask(access, task),
			),
			access,
		);
		const allowedVisibilities =
			access.kind === "admin"
				? null
				: access.kind === "member"
					? ["company", `member:${access.memberId}`]
					: [
							...access.dataScope.sourceVisibilities,
							`member:${access.memberId}`,
						];

		return this.store.readWorkEvidence({
			...query,
			limit: query.limit ?? 50,
			allowedVisibilities,
			allowedTaskIds: visible.map((task) => task.id),
		});
	}

	private async visibleAcceptedTasks(
		tasks: Task[],
		access: AccessScope,
	): Promise<Task[]> {
		return filterAcceptedTasksBySource(this.store, tasks, access);
	}

	private async canReadTaskHistorySources(
		taskId: string,
		access: AccessScope,
	): Promise<boolean> {
		const [proposals, revisions] = await Promise.all([
			this.store.listTaskProposals(taskId),
			this.store.listTaskRevisions(taskId),
		]);
		const sourceIds = [
			...new Set([
				...proposals.flatMap((proposal) => proposal.evidenceIds),
				...revisions.flatMap((revision) =>
					Object.values(
						revision.decisionMetadata?.sourceEventIdsByField ?? {},
					).flat(),
				),
			]),
		];
		const sources = await acceptedSourceEvents(this.store, sourceIds);

		return (
			sources.length === sourceIds.length &&
			sources.every((source) =>
				canReadVisibility(access, source.visibility),
			)
		);
	}

	private async visibleAcceptedProjects(
		projects: Project[],
		access: AccessScope,
	): Promise<Project[]> {
		const scoped = projects.filter(
			(project) =>
				canReadProject(access, project.id) ||
				canReadProject(access, project.name),
		);

		if (scoped.length === 0) return [];

		const proposals = new Map(
			(await this.store.listProjectProposals()).map((item) => [
				item.id,
				item,
			]),
		);
		const lineage = new Map<string, Map<string, string[]>>();

		for (const project of scoped) {
			const fields = new Map<string, string[]>();
			const revisions = (
				await this.store.listProjectRevisions(project.id)
			).sort((left, right) => left.version - right.version);

			for (const revision of revisions) {
				const evidenceIds =
					proposals.get(revision.proposalId)?.evidenceIds ?? [];

				if (!revision.previous && evidenceIds.length > 0)
					fields.set("creation", evidenceIds);
				for (const [key, value] of Object.entries(revision.current)) {
					if (
						[
							"id",
							"organizationId",
							"version",
							"createdAt",
							"updatedAt",
						].includes(key)
					)
						continue;

					const before = revision.previous?.[key as keyof Project];

					if (
						revision.previous &&
						JSON.stringify(before ?? null) ===
							JSON.stringify(value ?? null)
					)
						continue;
					fields.set(key, evidenceIds);
				}
			}
			lineage.set(project.id, fields);
		}

		const sourceIds = [
			...new Set(
				[...lineage.values()].flatMap((fields) =>
					[...fields.values()].flat(),
				),
			),
		];
		const sources = new Map(
			(await currentSourceEvents(this.store, sourceIds)).map((event) => [
				event.id,
				event,
			]),
		);

		return scoped.filter((project) =>
			[...(lineage.get(project.id)?.values() ?? [])].every((fieldIds) =>
				fieldIds.every((id) => {
					const source = sources.get(id);

					return Boolean(
						source && canReadVisibility(access, source.visibility),
					);
				}),
			),
		);
	}

	private async canReadProjectHistorySources(
		projectId: string,
		access: AccessScope,
	): Promise<boolean> {
		const revisions = await this.store.listProjectRevisions(projectId);
		const proposals = new Map(
			(await this.store.listProjectProposals()).map((item) => [
				item.id,
				item,
			]),
		);
		const ids = [
			...new Set(
				revisions.flatMap(
					(revision) =>
						proposals.get(revision.proposalId)?.evidenceIds ?? [],
				),
			),
		];
		const sources = await currentSourceEvents(this.store, ids);

		return (
			sources.length === ids.length &&
			sources.every((source) =>
				canReadVisibility(access, source.visibility),
			)
		);
	}

	async markTaskDuplicate(
		duplicateTaskId: string,
		canonicalTaskId: string,
		rationale: string,
		actor: string,
		evidenceIds: string[],
	): Promise<{ proposalId: string | null; link: WorkLink }> {
		if (duplicateTaskId === canonicalTaskId)
			throw new DomainError("A Task cannot duplicate itself.", "INVALID");

		const [duplicate, canonical] = await Promise.all([
			this.store.getTask(duplicateTaskId),
			this.store.getTask(canonicalTaskId),
		]);

		if (!duplicate || !canonical)
			throw new DomainError(
				"Duplicate reconciliation targets an unknown Task.",
				"NOT_FOUND",
			);

		let proposalId: string | null = null;

		if (duplicate.status !== "cancelled") {
			const proposal = await this.propose({
				clientEventId: `duplicate:${duplicateTaskId}:${canonicalTaskId}:${contentHash(evidenceIds)}`,
				taskId: duplicate.id,
				baseRevision: duplicate.version,
				changes: { status: "cancelled" },
				rationale,
				requestedBy: actor,
				evidenceIds,
			});

			await this.approveProposal(
				proposal.id,
				actor,
				"Duplicate Task cancelled; canonical Task retained with revision history.",
			);
			proposalId = proposal.id;
		}

		const link = await this.store.upsertWorkLink({
			taskId: duplicate.id,
			targetTaskId: canonical.id,
			targetRef: canonical.externalRef ?? `panini:task:${canonical.id}`,
			linkType: "duplicates",
			changedBy: actor,
			proposalId,
		});

		await this.store.appendAuditEvent({
			actor,
			action: "task.duplicate_reconciled",
			targetType: "task",
			targetId: duplicate.id,
			sourceEventId: evidenceIds[0] ?? null,
			proposalId,
			details: { canonicalTaskId: canonical.id, workLinkId: link.id },
		});
		return { proposalId, link };
	}

	async contextPack(): Promise<ContextPack> {
		const [entries, tasks, pending, escalated] = await Promise.all([
			this.store.listContextEntries(),
			this.store.listTasks(),
			this.store.listProposals("pending"),
			this.store.listProposals("escalated"),
		]);
		const pendingProposals = (
			await this.visibleProposals([...pending, ...escalated], {
				kind: "admin",
			})
		).sort((left, right) => right.createdAt.localeCompare(left.createdAt));

		return {
			entries,
			tree: createContextIndex(entries).tree,
			tasks: await this.visibleAcceptedTasks(tasks, { kind: "admin" }),
			pendingProposals,
			generatedAt: new Date().toISOString(),
		};
	}

	async contextIndex(
		access: AccessScope = { kind: "admin" },
	): Promise<ContextIndex> {
		return createContextIndex(await this.visibleContextEntries(access));
	}

	private async visibleContextEntries(
		access: AccessScope,
	): Promise<ContextEntry[]> {
		const entries = await this.store.listContextEntries();
		const evidence = await acceptedSourceEvents(this.store, [
			...new Set(entries.flatMap((entry) => entry.evidenceIds)),
		]);
		const byId = new Map(evidence.map((event) => [event.id, event]));

		return entries.filter((entry) =>
			canReadContextEntry(
				access,
				entry,
				entry.evidenceIds.flatMap((id) =>
					byId.has(id) ? [byId.get(id)!] : [],
				),
			),
		);
	}

	async visibleProposals(
		proposals: Proposal[],
		access: AccessScope,
	): Promise<Proposal[]> {
		const [evidence, tasks] = await Promise.all([
			currentSourceEvents(this.store, [
				...new Set(
					proposals.flatMap((proposal) => proposal.evidenceIds),
				),
			]),
			this.store.listTasks(),
		]);
		const byId = new Map(evidence.map((event) => [event.id, event]));
		const taskById = new Map(tasks.map((task) => [task.id, task]));
		const candidate = proposals.filter((proposal) =>
			canReadProposal(
				access,
				proposal,
				proposal.taskId
					? (taskById.get(proposal.taskId) ?? null)
					: null,
				proposal.evidenceIds.flatMap((id) =>
					byId.has(id) ? [byId.get(id)!] : [],
				),
			),
		);
		const readable = await Promise.all(
			candidate.map(
				async (proposal) =>
					!proposal.assessmentId ||
					(await this.canReadAssessmentContext(
						proposal.assessmentId,
						access,
					)),
			),
		);

		return candidate.filter((_, index) => readable[index]);
	}

	private async canReadAssessmentContext(
		assessmentId: string,
		access: AccessScope,
	): Promise<boolean> {
		const assessment = await this.store.getAssessment(assessmentId);

		if (!assessment) return false;

		const ids = await this.store.listModelCallContextSourceIds(
			assessment.runId,
		);
		const sources = await currentSourceEvents(this.store, ids);

		return (
			sources.length === ids.length &&
			sources.every((source) =>
				canReadVisibility(access, source.visibility),
			)
		);
	}

	getContextEntry(id: string): Promise<ContextEntry | null> {
		return this.store.getContextEntry(id);
	}

	async getContextEntryForAccess(
		id: string,
		access: AccessScope,
	): Promise<ContextEntry | null> {
		const entry = await this.store.getContextEntry(id);

		if (!entry) return null;

		const evidence = await acceptedSourceEvents(this.store, [
			...new Set(entry.evidenceIds),
		]);

		if (!canRecallContextEntry(access, entry, evidence)) {
			throw new DomainError(
				"The authenticated principal cannot read this context entry.",
				"FORBIDDEN",
			);
		}
		return entry;
	}

	async getTaskForAccess(
		id: string,
		access: AccessScope,
	): Promise<Task | null> {
		const task = await this.store.getTask(id);

		if (!task) return null;
		if ((await this.visibleAcceptedTasks([task], access)).length === 0) {
			throw new DomainError(
				"The authenticated principal cannot read this task.",
				"FORBIDDEN",
			);
		}
		return task;
	}

	async getProjectForAccess(
		id: string,
		access: AccessScope,
	): Promise<Project | null> {
		const project = (await this.store.listProjects()).find(
			(item) => item.id === id,
		);

		if (!project) return null;
		if (
			(await this.visibleAcceptedProjects([project], access)).length === 0
		) {
			throw new DomainError(
				"The authenticated principal cannot read this project.",
				"FORBIDDEN",
			);
		}
		return project;
	}

	async getSourceEventForAccess(
		id: string,
		access: AccessScope,
	): Promise<SourceEvent | null> {
		const event = (await this.store.getSourceEvents([id]))[0];

		if (!event) return null;
		if (!canReadVisibility(access, event.visibility)) {
			throw new DomainError(
				"The authenticated principal cannot read this source.",
				"FORBIDDEN",
			);
		}
		return event;
	}

	async getProposalForAccess(
		id: string,
		access: AccessScope,
	): Promise<Proposal | null> {
		const proposal = await this.store.getProposal(id);

		if (!proposal) return null;

		const [task, evidence] = await Promise.all([
			proposal.taskId
				? this.store.getTask(proposal.taskId)
				: Promise.resolve(null),
			this.store.getSourceEvents([...new Set(proposal.evidenceIds)]),
		]);

		if (
			!canReadProposal(access, proposal, task, evidence) ||
			(proposal.assessmentId &&
				!(await this.canReadAssessmentContext(
					proposal.assessmentId,
					access,
				)))
		) {
			throw new DomainError(
				"The authenticated principal cannot read this proposal.",
				"FORBIDDEN",
			);
		}
		if (
			proposal.taskId &&
			!(await this.canReadTaskHistorySources(proposal.taskId, access))
		) {
			throw new DomainError(
				"The authenticated principal cannot read this proposal history.",
				"FORBIDDEN",
			);
		}
		return proposal;
	}

	listSourceDocuments(
		input: SourceDocumentListInput = {},
	): Promise<SourceDocumentSummary[]> {
		return this.sourceDocuments.list(input);
	}

	readSourceDocument(
		input: SourceDocumentReadInput,
	): Promise<SourceDocumentRead> {
		return this.sourceDocuments.read(input);
	}

	async contextDetail(id: string) {
		const detail = await this.contextHistoryForAccess(id, {
			kind: "admin",
		});
		const proposals = await Promise.all(
			detail.revisions.map((revision) =>
				this.store.getProposal(revision.proposalId),
			),
		);

		return {
			...detail,
			reasons: Object.fromEntries(
				detail.revisions.map((revision, index) => [
					revision.proposalId,
					proposals[index]?.rationale ?? null,
				]),
			),
		};
	}

	async contextHistoryForAccess(id: string, access: AccessScope) {
		const revisions = await this.store.listContextRevisions(id);

		if (revisions.length === 0)
			throw new DomainError(
				`Context entry ${id} does not exist.`,
				"NOT_FOUND",
			);

		const evidence = await currentSourceEvents(this.store, [
			...new Set(
				revisions.flatMap((revision) => [
					...revision.current.evidenceIds,
					...(revision.previous?.evidenceIds ?? []),
				]),
			),
		]);
		const evidenceById = new Map(
			evidence.map((event) => [event.id, event]),
		);
		const visible = revisions.flatMap((revision) => {
			const currentEvidence = revision.current.evidenceIds.flatMap(
				(eventId) => {
					const event = evidenceById.get(eventId);

					return event ? [event] : [];
				},
			);

			if (!canReadContextEntry(access, revision.current, currentEvidence))
				return [];

			const previousEvidence =
				revision.previous?.evidenceIds.flatMap((eventId) => {
					const event = evidenceById.get(eventId);

					return event ? [event] : [];
				}) ?? [];

			return [
				revision.previous &&
				!canReadContextEntry(
					access,
					revision.previous,
					previousEvidence,
				)
					? { ...revision, previous: null }
					: revision,
			];
		});

		if (visible.length === 0) {
			throw new DomainError(
				"The authenticated principal cannot read this context history.",
				"FORBIDDEN",
			);
		}

		const visibleEvidenceIds = new Set(
			visible.flatMap((revision) => revision.current.evidenceIds),
		);

		return {
			entry: visible.at(-1)!.current,
			revisions: visible,
			evidence: evidence
				.filter((event) => visibleEvidenceIds.has(event.id))
				.map(({ payload: _payload, ...metadata }) => metadata),
		};
	}

	listEvidence(limit = 100) {
		return this.store.listSourceEvents(limit);
	}

	evidenceCoverage(pipelineVersion: string) {
		return this.store.getEvidenceCoverage(pipelineVersion);
	}

	evidenceBudget(budgetId: string) {
		return this.store.getInferenceBudget(budgetId);
	}

	externalModelFetch(
		provider: "openai" | "openrouter",
		purpose: string,
	): typeof fetch {
		return meteredExternalFetch(this.store, { provider, purpose });
	}

	externalProviderFetch(
		provider: "slack" | "notion" | "github",
		purpose: string,
	): typeof fetch {
		return meteredProviderFetch(this.store, { provider, purpose });
	}

	async reopenNoClaimEvidence(input: {
		eventId: string;
		pipelineVersion: string;
		dispatchEpoch: string;
		actor: string;
		reason: string;
	}) {
		return this.store.requestNoClaimReopen(input);
	}

	async listEvidenceForAccess(limit: number, access: AccessScope) {
		const events = await this.store.listSourceEvents(
			Math.min(500, Math.max(limit, 100)),
		);

		return events
			.filter((event) => canReadVisibility(access, event.visibility))
			.slice(0, limit);
	}

	async evidenceDetail(
		id: string,
		access: AccessScope = { kind: "admin" },
		pipelineVersion?: string,
	) {
		const event = (await this.store.getSourceEvents([id]))[0];

		if (!event || !canReadVisibility(access, event.visibility)) {
			throw new DomainError(
				`Evidence event ${id} does not exist or is unavailable.`,
				"NOT_FOUND",
			);
		}

		const disposition = pipelineVersion
			? await this.store.getLatestObservationDisposition(
					id,
					pipelineVersion,
				)
			: null;
		const run = disposition?.runId
			? await this.store.getInterpretationRun(disposition.runId)
			: null;
		const output =
			run?.output &&
			typeof run.output === "object" &&
			!Array.isArray(run.output)
				? run.output
				: null;
		const omissions = Array.isArray(output?.omissions)
			? output.omissions.filter(
					(item) =>
						item &&
						typeof item === "object" &&
						!Array.isArray(item) &&
						item.eventId === id &&
						typeof item.jsonPointer === "string" &&
						typeof item.reasonCode === "string" &&
						Number.isSafeInteger(item.startUtf16) &&
						Number.isSafeInteger(item.endUtf16),
				)
			: [];

		return { event, processing: { disposition, omissions } };
	}

	latestEvidenceBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
	) {
		return this.store.getLatestSourceEventBySourceRef(
			provider,
			installationKey,
			sourceRef,
		);
	}

	async revokeEvidence(id: string, actor: string): Promise<boolean> {
		const revoked = await this.store.revokeSourceEvent(id);

		if (revoked) {
			await this.store.appendAuditEvent({
				actor,
				action: "evidence.content_revoked",
				targetType: "source_event",
				targetId: id,
				sourceEventId: id,
				proposalId: null,
				details: { contentRemoved: true },
			});
		}
		return revoked;
	}

	async revokeEvidenceBySourceRef(
		provider: string,
		installationKey: string,
		sourceRef: string,
		actor: string,
		exceptEventId?: string,
	): Promise<number> {
		const revokedIds = await this.store.revokeSourceEventsBySourceRef(
			provider,
			installationKey,
			sourceRef,
			exceptEventId,
		);

		await this.auditEvidenceRevocations(revokedIds, actor, {
			provider,
			installationKey,
			sourceRef,
		});
		return revokedIds.length;
	}

	async revokeEvidenceByVisibility(
		provider: string,
		installationKey: string,
		visibility: string,
		actor: string,
		exceptEventId?: string,
	): Promise<number> {
		const revokedIds = await this.store.revokeSourceEventsByVisibility(
			provider,
			installationKey,
			visibility,
			exceptEventId,
		);

		await this.auditEvidenceRevocations(revokedIds, actor, {
			provider,
			installationKey,
			visibility,
		});
		return revokedIds.length;
	}

	getTask(id: string): Promise<Task | null> {
		return this.store.getTask(id);
	}

	async taskDetail(id: string): Promise<TaskDetail> {
		const task = await this.requireTask(id);
		const activityLimit = 2_000;
		const [revisions, proposals, recentEvents] = await Promise.all([
			this.store.listTaskRevisions(id),
			this.store.listTaskProposals(id),
			this.store.listSourceEvents(activityLimit),
		]);
		const evidence = await this.evidenceMetadata([
			...new Set(proposals.flatMap((proposal) => proposal.evidenceIds)),
		]);
		const references = new Set(
			`${task.externalRef ?? ""} ${task.title}`
				.toUpperCase()
				.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [],
		);
		const seen = new Set<string>();
		const activityCandidates = recentEvents
			.filter((event) => {
				if (!["github", "slack", "agent"].includes(event.provider))
					return false;

				const key =
					event.provider === "agent" ? event.id : event.sourceRef;

				if (seen.has(key)) return false;

				const agentPayload =
					event.provider === "agent" &&
					event.payload &&
					typeof event.payload === "object" &&
					!Array.isArray(event.payload)
						? event.payload
						: null;
				const explicitAgentTask =
					event.provider === "agent" &&
					(event.sourceRef === `team-ledger:task:${task.id}` ||
						agentPayload?.workItemId === task.id);

				if (explicitAgentTask) {
					seen.add(key);
					return true;
				}
				if (references.size === 0) return false;

				const text = JSON.stringify(event.payload).toUpperCase();
				const eventReferences =
					text.match(/\b[A-Z][A-Z0-9]+-\d+\b/g) ?? [];

				if (
					!eventReferences.some((reference) =>
						references.has(reference),
					)
				)
					return false;
				seen.add(key);
				return true;
			})
			.slice(0, 30)
			.map(({ payload: _payload, ...event }) => event);

		return {
			task,
			revisions,
			proposals,
			evidence,
			activityCandidates,
			activityCoverage: {
				scanned: recentEvents.length,
				limit: activityLimit,
				bounded: recentEvents.length === activityLimit,
			},
			allowedActions: [
				{
					action: "undo",
					allowed: Boolean(revisions.at(-1)?.previous),
					reason: revisions.at(-1)?.previous
						? "Creates a new revision restoring the prior accepted values."
						: "Initial creation has no prior accepted revision.",
				},
			],
		};
	}

	async taskHistoryForAccess(
		id: string,
		access: AccessScope,
	): Promise<TaskDetail> {
		const detail = await this.taskDetail(id);

		if (
			(await this.visibleAcceptedTasks([detail.task], access)).length ===
			0
		) {
			throw new DomainError(
				"The authenticated principal cannot read this task history.",
				"FORBIDDEN",
			);
		}
		if (!(await this.canReadTaskHistorySources(id, access))) {
			throw new DomainError(
				"The authenticated principal cannot read this task history.",
				"FORBIDDEN",
			);
		}

		const proposalEvidence = await currentSourceEvents(this.store, [
			...new Set(
				detail.proposals.flatMap((proposal) => proposal.evidenceIds),
			),
		]);
		const evidenceById = new Map(
			proposalEvidence.map((event) => [event.id, event]),
		);
		const proposals = await this.visibleProposals(
			detail.proposals.filter((proposal) =>
				canReadProposal(
					access,
					proposal,
					detail.task,
					proposal.evidenceIds.flatMap((eventId) => {
						const event = evidenceById.get(eventId);

						return event ? [event] : [];
					}),
				),
			),
			access,
		);
		const visibleEvidenceIds = new Set(
			proposals.flatMap((proposal) => proposal.evidenceIds),
		);

		return {
			...detail,
			proposals,
			evidence: detail.evidence.filter((event) =>
				visibleEvidenceIds.has(event.id),
			),
			activityCandidates: detail.activityCandidates.filter((event) =>
				canReadVisibility(access, event.visibility),
			),
		};
	}

	async proposalDetail(id: string): Promise<ProposalDetail> {
		const proposal = await this.store.getProposal(id);

		if (!proposal)
			throw new DomainError(
				`Proposal ${id} does not exist.`,
				"NOT_FOUND",
			);

		const before = proposal.taskId
			? await this.store.getTask(proposal.taskId)
			: null;
		const stale =
			proposal.kind === "task_change" &&
			before?.version !== proposal.baseVersion;
		const pending = isOpenProposalState(proposal.state);
		const evidence = await this.evidenceMetadata(proposal.evidenceIds);

		return {
			proposal,
			before,
			after: proposal.changes,
			evidence,
			stale,
			allowedActions: [
				{
					action: "approve",
					allowed: pending && !stale,
					reason: !pending
						? `Proposal is already ${proposal.state}.`
						: stale
							? "Rebase is required because accepted state changed."
							: "Pending proposal matches the current base revision.",
				},
				{
					action: "edit",
					allowed: pending,
					reason: pending
						? "Editing creates a replacement and preserves this proposal."
						: "Only open proposals can be edited.",
				},
				{
					action: "reject",
					allowed: pending,
					reason: pending
						? "An authorized reviewer may resolve an autonomous escalation by rejecting this proposal."
						: "Only open proposals can be rejected.",
				},
				{
					action: "supersede",
					allowed: pending,
					reason: pending
						? "This proposal may be retired without changing accepted state."
						: "Only open proposals can be superseded.",
				},
				{
					action: "rebase",
					allowed:
						pending && proposal.kind === "task_change" && stale,
					reason: stale
						? "Creates a replacement against the current accepted task revision."
						: "Rebase is only needed for a stale task change.",
				},
			],
		};
	}

	async proposalDetailForAccess(
		id: string,
		access: AccessScope,
	): Promise<ProposalDetail> {
		const detail = await this.proposalDetail(id);
		const evidence = await currentSourceEvents(
			this.store,
			detail.proposal.evidenceIds,
		);

		if (
			!canReadProposal(
				access,
				detail.proposal,
				detail.before,
				evidence,
			) ||
			(detail.proposal.assessmentId &&
				!(await this.canReadAssessmentContext(
					detail.proposal.assessmentId,
					access,
				)))
		) {
			throw new DomainError(
				"The authenticated principal cannot read this proposal.",
				"FORBIDDEN",
			);
		}
		if (
			detail.proposal.taskId &&
			!(await this.canReadTaskHistorySources(
				detail.proposal.taskId,
				access,
			))
		) {
			throw new DomainError(
				"The authenticated principal cannot read this proposal history.",
				"FORBIDDEN",
			);
		}
		return detail;
	}

	async evidenceAssessmentForAccess(
		id: string,
		access: AccessScope,
	): Promise<EvidenceAssessment> {
		const missing = () =>
			new DomainError("Assessment was not found.", "NOT_FOUND");

		const assessment = await this.store.getAssessment(id);

		if (!assessment) throw missing();
		if (access.kind !== "admin") {
			const organization = await this.store.getOrganization();

			if (access.organizationId !== organization.id) throw missing();
		}

		const claims = await this.store.getClaims(assessment.claimIds);

		if (claims.length !== assessment.claimIds.length) throw missing();

		const sourceIds = [
			...new Set([
				...claims.flatMap((claim) =>
					claim.body.spans.map((span) => span.eventId),
				),
				...(await this.store.listModelCallContextSourceIds(
					assessment.runId,
				)),
			]),
		];

		if (sourceIds.length === 0) throw missing();

		const sources = await currentSourceEvents(this.store, sourceIds);

		if (
			sources.length !== sourceIds.length ||
			sources.some(
				(event) => !canReadVisibility(access, event.visibility),
			)
		)
			throw missing();
		if (assessment.targetType === "task") {
			const task = assessment.targetId
				? await this.store.getTask(assessment.targetId)
				: null;

			if (!task || !canReadTask(access, task)) throw missing();
		} else if (
			assessment.targetType === "task_create" &&
			!canReadProject(access, null)
		) {
			throw missing();
		} else if (assessment.targetType === "context_create") {
			const paths = (await this.store.listProposals()).flatMap(
				(proposal) =>
					proposal.assessmentId === id &&
					(proposal.kind === "context_fact_upsert" ||
						proposal.kind === "context_file_upsert")
						? [proposal.changes.path]
						: [],
			);

			if (
				access.kind !== "admin" &&
				!paths.some((path) => canReadContextPath(access, path))
			)
				throw missing();
		} else if (assessment.targetType !== "task_create") {
			throw missing();
		}
		return assessment;
	}

	retrieve(input: RetrievalQuery): Promise<RetrievalResult> {
		return this.retriever.retrieve(input);
	}

	listProposals(): Promise<Proposal[]> {
		return this.store.listProposals();
	}

	getProposal(id: string): Promise<Proposal | null> {
		return this.store.getProposal(id);
	}

	private proposalRequestHash(
		input: Pick<
			NewProposal,
			| "kind"
			| "taskId"
			| "baseVersion"
			| "changes"
			| "rationale"
			| "evidenceIds"
		>,
	): string {
		return contentHash({
			kind: input.kind,
			taskId: input.taskId,
			baseVersion: input.baseVersion,
			changes: input.changes,
			rationale: input.rationale,
			evidenceIds: [...input.evidenceIds].sort(),
		});
	}

	private assertIdempotentProposal(
		existing: Proposal,
		input: NewProposal,
	): void {
		if (
			this.proposalRequestHash(existing) !==
			this.proposalRequestHash(input)
		) {
			throw new DomainError(
				`Client event ${input.clientEventId} was already used for a different proposal.`,
				"CONFLICT",
			);
		}
	}

	private async createProposalIdempotently(
		input: NewProposal,
	): Promise<Proposal> {
		if (input.clientEventId) {
			const existing = await this.store.findProposalByClientEvent(
				input.requestedBy,
				input.clientEventId,
			);

			if (existing) {
				this.assertIdempotentProposal(existing, input);
				return existing;
			}
		}

		const created = await this.store.createProposal(input);

		if (input.clientEventId) this.assertIdempotentProposal(created, input);
		return created;
	}

	private async requireTask(id: string): Promise<Task> {
		const task = await this.store.getTask(id);

		if (!task)
			throw new DomainError(`Task ${id} does not exist.`, "NOT_FOUND");
		return task;
	}

	private async assertEvidenceAccess(
		ids: string[],
		access: AccessScope,
	): Promise<void> {
		if (access.kind === "admin" || ids.length === 0) return;

		const uniqueIds = [...new Set(ids)];
		const evidence = await this.store.getSourceEvents(uniqueIds);

		if (
			evidence.length !== uniqueIds.length ||
			evidence.some(
				(event) => !canReadVisibility(access, event.visibility),
			)
		) {
			throw new DomainError(
				"The authenticated principal cannot use one or more evidence items.",
				"FORBIDDEN",
			);
		}
	}

	private async assertContextProposalAccess(
		path: string,
		kind: "file" | "fact",
		evidenceIds: string[],
		links: ContextLink[],
		access: AccessScope,
	): Promise<void> {
		const normalized = normalizeContextPath(path, kind);

		if (!canReadContextPath(access, normalized)) {
			throw new DomainError(
				"The authenticated principal cannot propose context outside its path scope.",
				"FORBIDDEN",
			);
		}

		const normalizedLinks = normalizeContextLinks(links);
		const projectLinks = normalizedLinks.filter(
			(link) => link.type === "project",
		);
		const nestedWorkLinks = normalizedLinks.filter(
			(link) => link.type === "workstream" || link.type === "task",
		);

		if (
			access.kind === "agent" &&
			nestedWorkLinks.length > 0 &&
			projectLinks.length === 0
		) {
			throw new DomainError(
				"Task- or workstream-linked context also requires an authorized project link.",
				"FORBIDDEN",
			);
		}
		if (
			projectLinks.some(
				(link) =>
					!canReadProject(access, link.targetRef) &&
					(!link.targetId || !canReadProject(access, link.targetId)),
			)
		) {
			throw new DomainError(
				"The authenticated principal cannot link context outside its project scope.",
				"FORBIDDEN",
			);
		}
		await this.assertEvidenceAccess(evidenceIds, access);
	}

	private async requirePendingProposal(id: string): Promise<Proposal> {
		const proposal = await this.store.getProposal(id);

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
		return proposal;
	}

	private async evidenceMetadata(ids: string[]) {
		return (await this.store.getSourceEvents(ids)).map(
			({ payload: _payload, ...metadata }) => metadata,
		);
	}

	private async auditEvidenceRevocations(
		sourceEventIds: string[],
		actor: string,
		details: Record<string, string>,
	): Promise<void> {
		await Promise.all(
			sourceEventIds.map((sourceEventId) =>
				this.store.appendAuditEvent({
					actor,
					action: "evidence.content_revoked",
					targetType: "source_event",
					targetId: sourceEventId,
					sourceEventId,
					proposalId: null,
					details: { ...details, contentRemoved: true },
				}),
			),
		);
	}
}
