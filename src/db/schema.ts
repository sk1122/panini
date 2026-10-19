import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	foreignKey,
	index,
	integer,
	jsonb,
	numeric,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";
import type {
	AgentCapability,
	AgentDataScope,
	PrivacyMode,
	AgentHarness,
	ContextEntry,
	ContextLifecycleState,
	ContextLink,
	JsonValue,
	ProposalChanges,
	ProposalKind,
	ProposalState,
	Project,
	WorkContainerStatus,
	WorkLink,
	WorkLinkType,
	SourceInstallationStatus,
	SourceInstallationTransport,
	ConnectorSyncStatus,
	SourceProvider,
	Task,
	TaskFields,
} from "../domain/types.js";
import type { StoredInterpretationState } from "../intelligence/types.js";
import type { EncryptedPayload } from "../security/payload-cipher.js";

const timestamps = {
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
};

export const organizations = pgTable(
	"organizations",
	{
		id: uuid("id").primaryKey(),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("organizations_slug_idx").on(sql`lower(${table.slug})`),
	],
);

export const members = pgTable(
	"members",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		subject: text("subject").notNull(),
		displayName: text("display_name").notNull(),
		email: text("email"),
		role: text("role")
			.notNull()
			.$type<"owner" | "admin" | "reviewer" | "member">(),
		status: text("status").notNull().$type<"active" | "disabled">(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("members_organization_subject_idx").on(
			table.organizationId,
			table.subject,
		),
		check(
			"members_role_check",
			sql`${table.role} IN ('owner','admin','reviewer','member')`,
		),
		check(
			"members_status_check",
			sql`${table.status} IN ('active','disabled')`,
		),
	],
);

export const memberIdentities = pgTable(
	"member_identities",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		memberId: uuid("member_id").references(() => members.id, {
			onDelete: "cascade",
		}),
		provider: text("provider").notNull().$type<SourceProvider>(),
		installationKey: text("installation_key").notNull(),
		externalId: text("external_id").notNull(),
		displayName: text("display_name"),
		email: text("email"),
		status: text("status").notNull().$type<"active" | "disabled">(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("member_identities_provider_external_idx").on(
			table.organizationId,
			table.provider,
			table.installationKey,
			table.externalId,
		),
		index("member_identities_member_idx").on(
			table.organizationId,
			table.memberId,
		),
		check(
			"member_identities_provider_check",
			sql`${table.provider} IN ('notion','slack','github','agent','manual')`,
		),
		check(
			"member_identities_status_check",
			sql`${table.status} IN ('active','disabled')`,
		),
	],
);

// Source identities remain separate from accounts that can sign in.
export const memberAccounts = pgTable(
	"member_accounts",
	{
		memberId: uuid("member_id")
			.primaryKey()
			.references(() => members.id, { onDelete: "cascade" }),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		email: text("email").notNull(),
		passwordHash: text("password_hash"),
		githubUserId: text("github_user_id"),
		githubLogin: text("github_login"),
		onboardingCompletedAt: timestamp("onboarding_completed_at", {
			withTimezone: true,
		}),
		passwordChangedAt: timestamp("password_changed_at", {
			withTimezone: true,
		})
			.notNull()
			.defaultNow(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("member_accounts_email_idx").on(
			table.organizationId,
			table.email,
		),
		uniqueIndex("member_accounts_github_idx").on(
			table.organizationId,
			table.githubUserId,
		),
	],
);

export const githubLoginFlows = pgTable(
	"github_login_flows",
	{
		stateHash: text("state_hash").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		browserHash: text("browser_hash").notNull(),
		payload: text("payload").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [index("github_login_flows_expiry_idx").on(table.expiresAt)],
);

export const webSessions = pgTable(
	"web_sessions",
	{
		tokenHash: text("token_hash").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "cascade" }),
		csrf: text("csrf").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		index("web_sessions_member_idx").on(
			table.organizationId,
			table.memberId,
		),
		index("web_sessions_expiry_idx").on(table.expiresAt),
	],
);

export const accountTokens = pgTable(
	"account_tokens",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tokenHash: text("token_hash").notNull(),
		purpose: text("purpose").notNull().$type<"invite" | "reset">(),
		email: text("email").notNull(),
		role: text("role")
			.notNull()
			.$type<"owner" | "admin" | "reviewer" | "member">(),
		memberId: uuid("member_id").references(() => members.id, {
			onDelete: "cascade",
		}),
		createdBy: uuid("created_by").references(() => members.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		consumedAt: timestamp("consumed_at", { withTimezone: true }),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("account_tokens_hash_idx").on(table.tokenHash),
		index("account_tokens_org_idx").on(table.organizationId, table.purpose),
		check(
			"account_tokens_purpose_check",
			sql`${table.purpose} IN ('invite','reset')`,
		),
		check(
			"account_tokens_role_check",
			sql`${table.role} IN ('owner','admin','reviewer','member')`,
		),
	],
);

export const authRateLimits = pgTable(
	"auth_rate_limits",
	{
		keyHash: text("key_hash").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		attempts: integer("attempts").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
	},
	(table) => [index("auth_rate_limits_expiry_idx").on(table.expiresAt)],
);

export const sourceInstallations = pgTable(
	"source_installations",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		provider: text("provider").notNull().$type<SourceProvider>(),
		installationKey: text("installation_key").notNull(),
		displayName: text("display_name").notNull(),
		transport: text("transport")
			.notNull()
			.$type<SourceInstallationTransport>(),
		status: text("status").notNull().$type<SourceInstallationStatus>(),
		config: jsonb("config")
			.notNull()
			.$type<Record<string, JsonValue>>()
			.default({}),
		lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
		lastEventAt: timestamp("last_event_at", { withTimezone: true }),
		lastError: text("last_error"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("source_installations_organization_provider_key_idx").on(
			table.organizationId,
			table.provider,
			table.installationKey,
		),
		index("source_installations_status_idx").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		check(
			"source_installations_provider_check",
			sql`${table.provider} IN ('notion','slack','github','agent','manual')`,
		),
		check(
			"source_installations_transport_check",
			sql`${table.transport} IN ('poll','socket_mode','webhook','local')`,
		),
		check(
			"source_installations_status_check",
			sql`${table.status} IN ('configured','healthy','degraded','revoked','disabled')`,
		),
	],
);

export const connectorSyncStates = pgTable(
	"connector_sync_states",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		installationId: uuid("installation_id")
			.notNull()
			.references(() => sourceInstallations.id, { onDelete: "cascade" }),
		resourceKey: text("resource_key").notNull(),
		status: text("status")
			.notNull()
			.$type<ConnectorSyncStatus>()
			.default("idle"),
		cursor: jsonb("cursor")
			.notNull()
			.$type<Record<string, JsonValue>>()
			.default({}),
		lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
		lastSuccessAt: timestamp("last_success_at", { withTimezone: true }),
		lastRepairAt: timestamp("last_repair_at", { withTimezone: true }),
		lastError: text("last_error"),
		observedCount: integer("observed_count").notNull().default(0),
		revokedCount: integer("revoked_count").notNull().default(0),
		...timestamps,
	},
	(table) => [
		uniqueIndex("connector_sync_states_installation_resource_idx").on(
			table.installationId,
			table.resourceKey,
		),
		index("connector_sync_states_organization_status_idx").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		check(
			"connector_sync_states_status_check",
			sql`${table.status} IN ('idle','running','healthy','degraded','revoked')`,
		),
		check(
			"connector_sync_states_counts_check",
			sql`${table.observedCount} >= 0 AND ${table.revokedCount} >= 0`,
		),
	],
);

export const sourceEvents = pgTable(
	"source_events",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		installationId: uuid("installation_id").references(
			() => sourceInstallations.id,
			{ onDelete: "set null" },
		),
		provider: text("provider").notNull(),
		installationKey: text("installation_key").notNull(),
		providerEventId: text("provider_event_id").notNull(),
		eventKind: text("event_kind").notNull(),
		occurredAt: timestamp("occurred_at", { withTimezone: true }).notNull(),
		fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		sourceRef: text("source_ref").notNull(),
		canonicalObjectKey: text("canonical_object_key"),
		sourceVersionKey: text("source_version_key"),
		semanticContentHash: text("semantic_content_hash"),
		originObservationKey: text("origin_observation_key"),
		authorizationVersion: integer("authorization_version")
			.notNull()
			.default(1),
		sourceUrl: text("source_url"),
		contentHash: text("content_hash").notNull(),
		visibility: text("visibility").notNull(),
		payloadVersion: text("payload_version").notNull(),
		legacyPayload: jsonb("payload").$type<JsonValue>(),
		contentState: text("content_state")
			.notNull()
			.default("active")
			.$type<"active" | "revoked" | "deleted">(),
		processingState: text("processing_state")
			.notNull()
			.default("received")
			.$type<"received" | "processed" | "ignored" | "failed">(),
		processingNote: text("processing_note"),
		supersedesEventId: uuid("supersedes_event_id"),
		revokedAt: timestamp("revoked_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("source_events_org_id_uq").on(
			table.organizationId,
			table.id,
		),
		uniqueIndex("source_events_organization_provider_event_idx").on(
			table.organizationId,
			table.provider,
			table.installationKey,
			table.providerEventId,
		),
		index("source_events_source_ref_idx").on(
			table.organizationId,
			table.sourceRef,
			table.receivedAt,
		),
		index("source_events_canonical_version_idx").on(
			table.organizationId,
			table.provider,
			table.installationKey,
			table.canonicalObjectKey,
			table.sourceVersionKey,
		),
		index("source_events_origin_idx").on(
			table.organizationId,
			table.originObservationKey,
		),
		check(
			"source_events_authorization_version_check",
			sql`${table.authorizationVersion} > 0`,
		),
		index("source_events_installation_idx").on(
			table.installationId,
			table.receivedAt,
		),
		check(
			"source_events_content_state_check",
			sql`${table.contentState} IN ('active','revoked','deleted')`,
		),
		check(
			"source_events_processing_state_check",
			sql`${table.processingState} IN ('received','processed','ignored','failed')`,
		),
	],
);

export const sourceEventContents = pgTable("source_event_contents", {
	sourceEventId: uuid("source_event_id")
		.primaryKey()
		.references(() => sourceEvents.id, { onDelete: "cascade" }),
	ciphertext: text("ciphertext").notNull(),
	iv: text("iv").notNull(),
	authTag: text("auth_tag").notNull(),
	keyVersion: text("key_version").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true })
		.notNull()
		.defaultNow(),
	revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

export const projects = pgTable(
	"projects",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		version: integer("version").notNull().default(1),
		name: text("name").notNull(),
		aliases: jsonb("aliases").notNull().$type<string[]>().default([]),
		slug: text("slug").notNull(),
		outcome: text("outcome").notNull().default(""),
		owner: text("owner"),
		status: text("status")
			.notNull()
			.$type<WorkContainerStatus>()
			.default("active"),
		sourceRef: text("source_ref").notNull(),
		sourceUrl: text("source_url"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("projects_organization_name_idx").on(
			table.organizationId,
			sql`lower(${table.name})`,
		),
		uniqueIndex("projects_organization_slug_idx").on(
			table.organizationId,
			table.slug,
		),
		check(
			"projects_status_check",
			sql`${table.status} IN ('active','paused','completed','archived')`,
		),
		check("projects_version_check", sql`${table.version} > 0`),
	],
);

export const projectProposals = pgTable(
	"project_proposals",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind")
			.notNull()
			.$type<"project_create" | "project_change">(),
		projectId: uuid("project_id").references(() => projects.id, {
			onDelete: "cascade",
		}),
		baseVersion: integer("base_version"),
		changes: jsonb("changes")
			.notNull()
			.$type<import("../domain/types.js").ProjectChanges>(),
		evidenceIds: jsonb("evidence_ids").notNull().$type<string[]>(),
		rationale: text("rationale").notNull(),
		requestedBy: text("requested_by").notNull(),
		state: text("state")
			.notNull()
			.$type<ProposalState>()
			.default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		decidedBy: text("decided_by"),
		decisionNote: text("decision_note"),
		assessmentId: uuid("assessment_id"),
		applicationKey: text("application_key"),
		decisionMetadata: jsonb("decision_metadata").$type<JsonValue>(),
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.assessmentId],
			foreignColumns: [
				evidenceAssessments.organizationId,
				evidenceAssessments.id,
			],
		}),
		uniqueIndex("project_proposals_application_key_uq")
			.on(table.organizationId, table.applicationKey)
			.where(sql`${table.applicationKey} IS NOT NULL`),
		index("project_proposals_organization_state_idx").on(
			table.organizationId,
			table.state,
			table.createdAt,
		),
		check(
			"project_proposals_kind_check",
			sql`${table.kind} IN ('project_create','project_change')`,
		),
	],
);

export const projectRevisions = pgTable(
	"project_revisions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		proposalId: uuid("proposal_id")
			.notNull()
			.references(() => projectProposals.id),
		previous: jsonb("previous").$type<Project | null>(),
		current: jsonb("current").notNull().$type<Project>(),
		appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
		appliedBy: text("applied_by").notNull(),
		decisionMetadata: jsonb("decision_metadata").$type<JsonValue>(),
	},
	(table) => [
		uniqueIndex("project_revisions_project_version_idx").on(
			table.projectId,
			table.version,
		),
		uniqueIndex("project_revisions_proposal_idx").on(table.proposalId),
	],
);

export const workstreams = pgTable(
	"workstreams",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		projectId: uuid("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		outcome: text("outcome").notNull().default(""),
		owner: text("owner"),
		status: text("status")
			.notNull()
			.$type<WorkContainerStatus>()
			.default("active"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("workstreams_project_name_idx").on(
			table.projectId,
			sql`lower(${table.name})`,
		),
		index("workstreams_organization_status_idx").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		check(
			"workstreams_status_check",
			sql`${table.status} IN ('active','paused','completed','archived')`,
		),
	],
);

export const tasks = pgTable(
	"tasks",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		externalRef: text("external_ref"),
		document: jsonb("document").notNull().$type<TaskFields>(),
		version: integer("version").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
	},
	(table) => [
		uniqueIndex("tasks_organization_external_ref_idx").on(
			table.organizationId,
			table.externalRef,
		),
		index("tasks_organization_updated_at_idx").on(
			table.organizationId,
			table.updatedAt,
		),
		check("tasks_version_check", sql`${table.version} > 0`),
	],
);

export const proposals = pgTable(
	"proposals",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		clientEventId: text("client_event_id"),
		kind: text("kind").notNull().$type<ProposalKind>(),
		taskId: uuid("task_id").references(() => tasks.id, {
			onDelete: "cascade",
		}),
		baseVersion: integer("base_version"),
		state: text("state").notNull().$type<ProposalState>(),
		changes: jsonb("changes").notNull().$type<ProposalChanges>(),
		rationale: text("rationale").notNull(),
		requestedBy: text("requested_by").notNull(),
		evidenceIds: jsonb("evidence_ids").notNull().$type<string[]>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		decidedAt: timestamp("decided_at", { withTimezone: true }),
		decidedBy: text("decided_by"),
		decisionNote: text("decision_note"),
		assessmentId: uuid("assessment_id"),
		applicationKey: text("application_key"),
		decisionMetadata: jsonb("decision_metadata").$type<JsonValue>(),
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.assessmentId],
			foreignColumns: [
				evidenceAssessments.organizationId,
				evidenceAssessments.id,
			],
		}),
		uniqueIndex("proposals_application_key_uq")
			.on(table.organizationId, table.applicationKey)
			.where(sql`${table.applicationKey} IS NOT NULL`),
		index("proposals_organization_state_created_idx").on(
			table.organizationId,
			table.state,
			table.createdAt,
		),
		uniqueIndex("proposals_organization_requester_client_event_idx")
			.on(table.organizationId, table.requestedBy, table.clientEventId)
			.where(sql`${table.clientEventId} IS NOT NULL`),
		check(
			"proposals_kind_check",
			sql`${table.kind} IN ('task_create','task_change','context_update','context_file_upsert','context_fact_upsert')`,
		),
		check(
			"proposals_state_check",
			sql`${table.state} IN ('pending','escalated','approved','rejected','auto_applied','superseded')`,
		),
	],
);

export const taskRevisions = pgTable(
	"task_revisions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		proposalId: uuid("proposal_id")
			.notNull()
			.references(() => proposals.id, { onDelete: "restrict" }),
		previous: jsonb("previous").$type<Task>(),
		current: jsonb("current").notNull().$type<Task>(),
		appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
		appliedBy: text("applied_by").notNull(),
		decisionMetadata: jsonb("decision_metadata").$type<JsonValue>(),
	},
	(table) => [
		uniqueIndex("task_revisions_task_version_idx").on(
			table.taskId,
			table.version,
		),
		uniqueIndex("task_revisions_proposal_idx").on(table.proposalId),
	],
);

export const workLinks = pgTable(
	"work_links",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id, { onDelete: "cascade" }),
		targetTaskId: uuid("target_task_id").references(() => tasks.id, {
			onDelete: "set null",
		}),
		targetRef: text("target_ref").notNull(),
		linkType: text("link_type").notNull().$type<WorkLinkType>(),
		...timestamps,
	},
	(table) => [
		uniqueIndex("work_links_organization_id_id_idx").on(
			table.organizationId,
			table.id,
		),
		uniqueIndex("work_links_task_target_type_idx").on(
			table.taskId,
			table.targetRef,
			table.linkType,
		),
		index("work_links_organization_target_idx").on(
			table.organizationId,
			table.targetTaskId,
			table.linkType,
		),
		check(
			"work_links_type_check",
			sql`${table.linkType} IN ('depends_on','blocks','relates_to','duplicates')`,
		),
		check(
			"work_links_not_self_check",
			sql`${table.targetTaskId} IS NULL OR ${table.targetTaskId} <> ${table.taskId}`,
		),
	],
);

export const workLinkRevisions = pgTable(
	"work_link_revisions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		linkId: uuid("link_id").notNull(),
		version: integer("version").notNull(),
		previous: jsonb("previous").$type<WorkLink>(),
		current: jsonb("current").notNull().$type<WorkLink>(),
		changedAt: timestamp("changed_at", { withTimezone: true }).notNull(),
		changedBy: text("changed_by").notNull(),
		proposalId: uuid("proposal_id").references(() => proposals.id, {
			onDelete: "restrict",
		}),
	},
	(table) => [
		foreignKey({
			columns: [table.organizationId, table.linkId],
			foreignColumns: [workLinks.organizationId, workLinks.id],
		}).onDelete("cascade"),
		uniqueIndex("work_link_revisions_link_version_idx").on(
			table.linkId,
			table.version,
		),
		index("work_link_revisions_organization_changed_idx").on(
			table.organizationId,
			table.changedAt,
		),
	],
);

export const contextEntries = pgTable(
	"context_entries",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind").notNull().$type<"file" | "fact">(),
		sourceEventId: uuid("source_event_id")
			.notNull()
			.references(() => sourceEvents.id, { onDelete: "restrict" }),
		sourceRef: text("source_ref").notNull(),
		path: text("path").notNull(),
		title: text("title").notNull(),
		body: text("body"),
		factType: text("fact_type"),
		factValue: jsonb("fact_value").$type<string | number | boolean>(),
		sourceUrl: text("source_url"),
		contentHash: text("content_hash").notNull(),
		evidenceIds: uuid("evidence_ids")
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		lifecycleState: text("lifecycle_state")
			.notNull()
			.default("accepted")
			.$type<ContextLifecycleState>(),
		effectiveFrom: timestamp("effective_from", { withTimezone: true })
			.notNull()
			.defaultNow(),
		effectiveTo: timestamp("effective_to", { withTimezone: true }),
		links: jsonb("links")
			.notNull()
			.default(sql`'[]'::jsonb`)
			.$type<ContextLink[]>(),
		derivationMetadata: jsonb("derivation_metadata")
			.notNull()
			.default(
				sql`'{"schemaVersion":1,"claimIds":[],"summaryKind":"legacy","freshness":"unknown","generatedBy":null}'::jsonb`,
			)
			.$type<JsonValue>(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("context_entries_organization_source_ref_idx").on(
			table.organizationId,
			table.sourceRef,
		),
		uniqueIndex("context_entries_organization_path_idx").on(
			table.organizationId,
			table.path,
		),
		index("context_entries_organization_kind_path_idx").on(
			table.organizationId,
			table.kind,
			table.path,
		),
		index("context_entries_evidence_ids_idx").using(
			"gin",
			table.evidenceIds,
		),
		index("context_entries_organization_lifecycle_effective_idx").on(
			table.organizationId,
			table.lifecycleState,
			table.effectiveFrom,
			table.effectiveTo,
		),
		index("context_entries_links_idx").using("gin", table.links),
		index("context_entries_search_idx").using(
			"gin",
			sql`to_tsvector('simple', ${table.path} || ' ' || ${table.title} || ' ' || coalesce(${table.body}, '') || ' ' || coalesce(${table.factType}, '') || ' ' || coalesce(${table.factValue}::text, ''))`,
		),
		check(
			"context_entries_kind_check",
			sql`${table.kind} IN ('file','fact')`,
		),
		check(
			"context_entries_lifecycle_check",
			sql`${table.lifecycleState} IN ('accepted','needs_review','superseded')`,
		),
		check(
			"context_entries_effective_interval_check",
			sql`${table.effectiveTo} IS NULL OR ${table.effectiveTo} > ${table.effectiveFrom}`,
		),
		check(
			"context_entries_shape_check",
			sql`(
        (${table.kind} = 'file' AND ${table.body} IS NOT NULL AND ${table.factType} IS NULL AND ${table.factValue} IS NULL)
        OR
        (${table.kind} = 'fact' AND ${table.body} IS NULL AND ${table.factType} IN (
          'identity','decision','policy','constraint','preference','relationship','metric','reference','other'
        ) AND jsonb_typeof(${table.factValue}) IN ('string','number','boolean'))
      )`,
		),
	],
);

export const contextRevisions = pgTable(
	"context_revisions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		contextEntryId: uuid("context_entry_id")
			.notNull()
			.references(() => contextEntries.id, { onDelete: "cascade" }),
		version: integer("version").notNull(),
		proposalId: uuid("proposal_id")
			.notNull()
			.references(() => proposals.id, { onDelete: "restrict" }),
		previous: jsonb("previous").$type<ContextEntry>(),
		current: jsonb("current").notNull().$type<ContextEntry>(),
		appliedAt: timestamp("applied_at", { withTimezone: true }).notNull(),
		appliedBy: text("applied_by").notNull(),
		decisionMetadata: jsonb("decision_metadata").$type<JsonValue>(),
	},
	(table) => [
		uniqueIndex("context_revisions_entry_version_idx").on(
			table.contextEntryId,
			table.version,
		),
		uniqueIndex("context_revisions_proposal_idx").on(table.proposalId),
	],
);

/** Disposable vectors over currently accepted context files, never canonical memory. */
export const contextDocumentEmbeddings = pgTable(
	"context_document_embeddings",
	{
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		contextEntryId: uuid("context_entry_id")
			.notNull()
			.references(() => contextEntries.id, { onDelete: "cascade" }),
		model: text("model").notNull(),
		inputHash: text("input_hash").notNull(),
		vectors: jsonb("vectors").notNull().$type<number[][]>(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("context_document_embeddings_entry_idx").on(
			table.organizationId,
			table.contextEntryId,
		),
		index("context_document_embeddings_model_idx").on(
			table.organizationId,
			table.model,
		),
	],
);

export const interpretationRuns = pgTable(
	"interpretation_runs",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		inputHash: text("input_hash").notNull(),
		model: text("model").notNull(),
		state: text("state").notNull().$type<StoredInterpretationState>(),
		eventIds: uuid("event_ids").array().notNull(),
		output: jsonb("output").$type<JsonValue>(),
		schemaVersion: integer("schema_version").notNull().default(1),
		pipelineVersion: text("pipeline_version"),
		promptVersion: text("prompt_version"),
		policyVersion: text("policy_version"),
		configHash: text("config_hash"),
		replayMode: text("replay_mode"),
		evaluationClock: timestamp("evaluation_clock", { withTimezone: true }),
		knowledgeCutoff: timestamp("knowledge_cutoff", { withTimezone: true }),
		manifestEnvelope: jsonb("manifest_envelope").$type<EncryptedPayload>(),
		outputEnvelope: jsonb("output_envelope").$type<EncryptedPayload>(),
		contentState: text("content_state").notNull().default("active"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		completedAt: timestamp("completed_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("interpretation_runs_org_id_uq").on(
			table.organizationId,
			table.id,
		),
		index("interpretation_runs_organization_state_created_idx").on(
			table.organizationId,
			table.state,
			table.createdAt,
		),
		index("interpretation_runs_event_ids_idx").using("gin", table.eventIds),
		check(
			"interpretation_runs_state_check",
			sql`${table.state} IN ('running','completed','failed')`,
		),
		check(
			"interpretation_runs_schema_version_check",
			sql`${table.schemaVersion} IN (1,2)`,
		),
		check(
			"interpretation_runs_replay_mode_check",
			sql`${table.replayMode} IS NULL OR ${table.replayMode} IN ('live','accepted_rebuild','cached_reassess','source_reinterpret','historical_eval')`,
		),
		check(
			"interpretation_runs_content_state_check",
			sql`${table.contentState} IN ('active','revoked','deleted')`,
		),
	],
);

export const evidenceClaims = pgTable(
	"evidence_claims",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		extractionRunId: uuid("extraction_run_id").notNull(),
		episodeKey: text("episode_key").notNull(),
		ordinal: integer("ordinal").notNull(),
		schemaVersion: integer("schema_version").notNull().default(1),
		kind: text("kind").notNull(),
		inputHash: text("input_hash").notNull(),
		contentHash: text("content_hash").notNull(),
		bodyEnvelope: jsonb("body_envelope").$type<EncryptedPayload>(),
		contentState: text("content_state").notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("evidence_claims_org_id_uq").on(
			table.organizationId,
			table.id,
		),
		uniqueIndex("evidence_claims_run_ordinal_uq").on(
			table.organizationId,
			table.extractionRunId,
			table.ordinal,
		),
		foreignKey({
			columns: [table.organizationId, table.extractionRunId],
			foreignColumns: [
				interpretationRuns.organizationId,
				interpretationRuns.id,
			],
		}),
		index("evidence_claims_episode_idx").on(
			table.organizationId,
			table.episodeKey,
			table.createdAt,
			table.id,
		),
		index("evidence_claims_discovery_idx").on(
			table.organizationId,
			table.createdAt,
			table.id,
		),
		check("evidence_claims_ordinal_check", sql`${table.ordinal} >= 0`),
		check("evidence_claims_schema_check", sql`${table.schemaVersion} = 1`),
		check(
			"evidence_claims_kind_check",
			sql`${table.kind} IN ('request','progress_report','completion_report','artifact_observation','correction','cancellation','context_statement')`,
		),
		check(
			"evidence_claims_state_check",
			sql`${table.contentState} IN ('active','revoked','deleted')`,
		),
		check(
			"evidence_claims_body_check",
			sql`${table.contentState} <> 'active' OR ${table.bodyEnvelope} IS NOT NULL`,
		),
	],
);

export const evidenceAssessments = pgTable(
	"evidence_assessments",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		runId: uuid("run_id").notNull(),
		assessmentKey: text("assessment_key").notNull(),
		targetType: text("target_type").notNull(),
		targetId: uuid("target_id"),
		targetVersion: text("target_version"),
		contractVersion: integer("contract_version"),
		claimIds: uuid("claim_ids").array().notNull(),
		evidenceFingerprint: text("evidence_fingerprint").notNull(),
		permissionFingerprint: text("permission_fingerprint").notNull(),
		policyVersion: text("policy_version").notNull(),
		modelVersion: text("model_version").notNull(),
		relationship: text("relationship").notNull(),
		disposition: text("disposition").notNull(),
		reasonCodes: text("reason_codes")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		bodyEnvelope: jsonb("body_envelope").$type<EncryptedPayload>(),
		contentState: text("content_state").notNull().default("active"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("evidence_assessments_org_id_uq").on(
			table.organizationId,
			table.id,
		),
		uniqueIndex("evidence_assessments_key_uq").on(
			table.organizationId,
			table.assessmentKey,
		),
		foreignKey({
			columns: [table.organizationId, table.runId],
			foreignColumns: [
				interpretationRuns.organizationId,
				interpretationRuns.id,
			],
		}),
		index("evidence_assessments_target_idx").on(
			table.organizationId,
			table.targetType,
			table.targetId,
			table.createdAt,
			table.id,
		),
		index("evidence_assessments_claims_idx").using("gin", table.claimIds),
		check(
			"evidence_assessments_target_type_check",
			sql`${table.targetType} IN ('task','project','context','task_create','project_create','context_create')`,
		),
		check(
			"evidence_assessments_contract_version_check",
			sql`${table.contractVersion} IS NULL OR ${table.contractVersion} > 0`,
		),
		check(
			"evidence_assessments_target_check",
			sql`((${table.targetType} IN ('task_create','project_create','context_create') AND ${table.targetId} IS NULL AND ${table.targetVersion} IS NULL) OR (${table.targetType} IN ('task','project','context') AND ${table.targetId} IS NOT NULL AND ${table.targetVersion} IS NOT NULL))`,
		),
		check(
			"evidence_assessments_claims_check",
			sql`cardinality(${table.claimIds}) > 0`,
		),
		check(
			"evidence_assessments_relationship_check",
			sql`${table.relationship} IN ('same_outcome','part_of','related','unrelated','uncertain')`,
		),
		check(
			"evidence_assessments_disposition_check",
			sql`${table.disposition} IN ('eligible','review_required','rejected','no_change')`,
		),
		check(
			"evidence_assessments_state_check",
			sql`${table.contentState} IN ('active','revoked','deleted')`,
		),
		check(
			"evidence_assessments_body_check",
			sql`${table.contentState} <> 'active' OR ${table.bodyEnvelope} IS NOT NULL`,
		),
	],
);

export const observationDispositions = pgTable(
	"observation_dispositions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		sourceEventId: uuid("source_event_id").notNull(),
		canonicalEventId: uuid("canonical_event_id"),
		originObservationKey: text("origin_observation_key").notNull(),
		pipelineVersion: text("pipeline_version").notNull(),
		attempt: integer("attempt").notNull(),
		runId: uuid("run_id"),
		state: text("state").notNull(),
		claimIds: uuid("claim_ids")
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		reasonCode: text("reason_code"),
		retryable: boolean("retryable").notNull().default(false),
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		leaseOwner: text("lease_owner"),
		leaseUntil: timestamp("lease_until", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("observation_dispositions_attempt_uq").on(
			table.organizationId,
			table.sourceEventId,
			table.pipelineVersion,
			table.attempt,
		),
		uniqueIndex("observation_dispositions_active_origin_uq")
			.on(
				table.organizationId,
				table.originObservationKey,
				table.pipelineVersion,
			)
			.where(sql`${table.state} IN ('pending','processing')`),
		foreignKey({
			columns: [table.organizationId, table.sourceEventId],
			foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
		}),
		foreignKey({
			columns: [table.organizationId, table.canonicalEventId],
			foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
		}),
		foreignKey({
			columns: [table.organizationId, table.runId],
			foreignColumns: [
				interpretationRuns.organizationId,
				interpretationRuns.id,
			],
		}),
		index("observation_dispositions_retry_idx").on(
			table.organizationId,
			table.state,
			table.nextAttemptAt,
			table.id,
		),
		index("observation_dispositions_source_latest_idx").on(
			table.organizationId,
			table.sourceEventId,
			table.pipelineVersion,
			table.attempt,
		),
		check(
			"observation_dispositions_state_check",
			sql`${table.state} IN ('pending','processing','processed','extracted','partial','no_claim','duplicate','unresolved','failed')`,
		),
		check(
			"observation_dispositions_attempt_check",
			sql`${table.attempt} > 0`,
		),
		check(
			"observation_dispositions_processing_check",
			sql`${table.state} <> 'processing' OR (${table.leaseOwner} IS NOT NULL AND ${table.leaseUntil} IS NOT NULL)`,
		),
		check(
			"observation_dispositions_duplicate_check",
			sql`${table.state} <> 'duplicate' OR ${table.canonicalEventId} IS NOT NULL`,
		),
		check(
			"observation_dispositions_no_claim_check",
			sql`${table.state} <> 'no_claim' OR ${table.reasonCode} IS NOT NULL`,
		),
		check(
			"observation_dispositions_claims_check",
			sql`${table.state} NOT IN ('extracted','partial') OR cardinality(${table.claimIds}) > 0`,
		),
	],
);

export const evidenceDependencies = pgTable(
	"evidence_dependencies",
	{
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		dependentType: text("dependent_type").notNull(),
		dependentId: uuid("dependent_id").notNull(),
		fieldKey: text("field_key").notNull().default("$"),
		sourceEventId: uuid("source_event_id").notNull(),
		originObservationKey: text("origin_observation_key").notNull(),
		sourceVersionKey: text("source_version_key").notNull(),
		sourceAuthorizationVersion: integer(
			"source_authorization_version",
		).notNull(),
		relationship: text("relationship").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.organizationId,
				table.dependentType,
				table.dependentId,
				table.fieldKey,
				table.sourceEventId,
				table.relationship,
			],
		}),
		foreignKey({
			columns: [table.organizationId, table.sourceEventId],
			foreignColumns: [sourceEvents.organizationId, sourceEvents.id],
		}),
		index("evidence_dependencies_reverse_idx").on(
			table.organizationId,
			table.sourceEventId,
			table.dependentType,
			table.dependentId,
		),
		index("evidence_dependencies_origin_idx").on(
			table.organizationId,
			table.originObservationKey,
		),
		check(
			"evidence_dependencies_dependent_type_check",
			sql`${table.dependentType} IN ('claim','assessment','task_revision','project_revision','context_revision','interpretation_run','model_call')`,
		),
		check(
			"evidence_dependencies_auth_check",
			sql`${table.sourceAuthorizationVersion} > 0`,
		),
		check(
			"evidence_dependencies_relationship_check",
			sql`${table.relationship} IN ('supports','contradicts','context')`,
		),
	],
);

export const inferenceBudgets = pgTable(
	"inference_budgets",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		label: text("label").notNull(),
		state: text("state").notNull(),
		maxCalls: bigint("max_calls", { mode: "number" }).notNull(),
		maxInputTokens: bigint("max_input_tokens", {
			mode: "number",
		}).notNull(),
		maxOutputTokens: bigint("max_output_tokens", {
			mode: "number",
		}).notNull(),
		maxUsd: numeric("max_usd", { precision: 18, scale: 8 }),
		deadline: timestamp("deadline", { withTimezone: true }).notNull(),
		reservedCalls: bigint("reserved_calls", { mode: "number" })
			.notNull()
			.default(0),
		reservedInputTokens: bigint("reserved_input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		reservedOutputTokens: bigint("reserved_output_tokens", {
			mode: "number",
		})
			.notNull()
			.default(0),
		reservedUsd: numeric("reserved_usd", { precision: 18, scale: 8 })
			.notNull()
			.default("0"),
		spentCalls: bigint("spent_calls", { mode: "number" })
			.notNull()
			.default(0),
		spentInputTokens: bigint("spent_input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		spentOutputTokens: bigint("spent_output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		spentUsd: numeric("spent_usd", { precision: 18, scale: 8 })
			.notNull()
			.default("0"),
		priceBasis: jsonb("price_basis").$type<JsonValue>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("inference_budgets_org_id_uq").on(
			table.organizationId,
			table.id,
		),
		check(
			"inference_budgets_state_check",
			sql`${table.state} IN ('active','exhausted','suspended','closed')`,
		),
		check(
			"inference_budgets_max_check",
			sql`${table.maxCalls}>0 AND ${table.maxInputTokens}>0 AND ${table.maxOutputTokens}>0 AND (${table.maxUsd} IS NULL OR ${table.maxUsd}>0)`,
		),
		check(
			"inference_budgets_reserved_check",
			sql`${table.reservedCalls}>=0 AND ${table.reservedInputTokens}>=0 AND ${table.reservedOutputTokens}>=0 AND ${table.reservedUsd}>=0`,
		),
		check(
			"inference_budgets_spent_check",
			sql`${table.spentCalls}>=0 AND ${table.spentInputTokens}>=0 AND ${table.spentOutputTokens}>=0 AND ${table.spentUsd}>=0`,
		),
	],
);

export const modelCalls = pgTable(
	"model_calls",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		budgetId: uuid("budget_id").notNull(),
		runId: uuid("run_id").notNull(),
		contextualSourceEventIds: uuid("contextual_source_event_ids")
			.array()
			.notNull()
			.default(sql`'{}'::uuid[]`),
		purpose: text("purpose").notNull(),
		logicalCallKey: text("logical_call_key").notNull(),
		attempt: integer("attempt").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		resolvedModelVersion: text("resolved_model_version"),
		state: text("state").notNull(),
		requestHash: text("request_hash").notNull(),
		requestEnvelope: jsonb("request_envelope").$type<EncryptedPayload>(),
		responseEnvelope: jsonb("response_envelope").$type<EncryptedPayload>(),
		cacheKey: text("cache_key"),
		cachedFromCallId: uuid("cached_from_call_id"),
		reservedInputTokens: bigint("reserved_input_tokens", {
			mode: "number",
		}).notNull(),
		reservedOutputTokens: bigint("reserved_output_tokens", {
			mode: "number",
		}).notNull(),
		reservedUsd: numeric("reserved_usd", { precision: 18, scale: 8 })
			.notNull()
			.default("0"),
		inputTokens: bigint("input_tokens", { mode: "number" }),
		cachedInputTokens: bigint("cached_input_tokens", { mode: "number" }),
		outputTokens: bigint("output_tokens", { mode: "number" }),
		embeddingItems: integer("embedding_items"),
		costUsd: numeric("cost_usd", { precision: 18, scale: 8 }),
		costBasis: text("cost_basis").notNull(),
		priceBasis: jsonb("price_basis").$type<JsonValue>(),
		providerRequestId: text("provider_request_id"),
		errorCode: text("error_code"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("model_calls_org_id_uq").on(table.organizationId, table.id),
		uniqueIndex("model_calls_logical_attempt_uq").on(
			table.organizationId,
			table.logicalCallKey,
			table.attempt,
		),
		foreignKey({
			columns: [table.organizationId, table.budgetId],
			foreignColumns: [
				inferenceBudgets.organizationId,
				inferenceBudgets.id,
			],
		}),
		foreignKey({
			columns: [table.organizationId, table.runId],
			foreignColumns: [
				interpretationRuns.organizationId,
				interpretationRuns.id,
			],
		}),
		foreignKey({
			columns: [table.organizationId, table.cachedFromCallId],
			foreignColumns: [table.organizationId, table.id],
		}),
		index("model_calls_run_idx").on(
			table.organizationId,
			table.runId,
			table.purpose,
			table.createdAt,
		),
		index("model_calls_context_sources_idx").using(
			"gin",
			table.contextualSourceEventIds,
		),
		index("model_calls_cache_idx")
			.on(table.organizationId, table.cacheKey, table.finishedAt)
			.where(sql`${table.state}='succeeded'`),
		check(
			"model_calls_purpose_check",
			sql`${table.purpose} IN ('observe','route','embed','rank','extract','identity','assess','verify','summarize','artifact_fetch')`,
		),
		check(
			"model_calls_state_check",
			sql`${table.state} IN ('reserved','dispatched','succeeded','failed','unknown','cancelled','cache_hit')`,
		),
		check(
			"model_calls_cost_basis_check",
			sql`${table.costBasis} IN ('provider','estimated','known_zero','unknown')`,
		),
		check("model_calls_attempt_check", sql`${table.attempt}>0`),
		check(
			"model_calls_nonnegative_check",
			sql`${table.reservedInputTokens}>=0 AND ${table.reservedOutputTokens}>=0 AND ${table.reservedUsd}>=0 AND (${table.inputTokens} IS NULL OR ${table.inputTokens}>=0) AND (${table.outputTokens} IS NULL OR ${table.outputTokens}>=0) AND (${table.cachedInputTokens} IS NULL OR ${table.cachedInputTokens}>=0) AND (${table.costUsd} IS NULL OR ${table.costUsd}>=0)`,
		),
	],
);

export const workEntityEmbeddings = pgTable(
	"work_entity_embeddings",
	{
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		entityType: text("entity_type").notNull(),
		entityId: uuid("entity_id").notNull(),
		model: text("model").notNull(),
		modelVersion: text("model_version").notNull(),
		inputHash: text("input_hash").notNull(),
		permissionFingerprint: text("permission_fingerprint").notNull(),
		vectorDimension: integer("vector_dimension").notNull(),
		vectorsEnvelope: jsonb("vectors_envelope")
			.notNull()
			.$type<EncryptedPayload>(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.organizationId,
				table.entityType,
				table.entityId,
				table.model,
				table.modelVersion,
				table.inputHash,
				table.permissionFingerprint,
			],
		}),
		check(
			"work_entity_embeddings_type_check",
			sql`${table.entityType} IN ('task','project','claim','context','query')`,
		),
		check(
			"work_entity_embeddings_dimension_check",
			sql`${table.vectorDimension}>0`,
		),
	],
);

export const agentProfiles = pgTable(
	"agent_profiles",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		memberId: uuid("member_id").references(() => members.id, {
			onDelete: "restrict",
		}),
		owner: text("owner").notNull(),
		name: text("name").notNull(),
		harness: text("harness").notNull().$type<AgentHarness>(),
		description: text("description").notNull().default(""),
		capabilities: text("capabilities")
			.array()
			.notNull()
			.$type<AgentCapability[]>(),
		dataScope: jsonb("data_scope")
			.notNull()
			.$type<AgentDataScope>()
			.default({
				projects: [],
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			}),
		status: text("status").notNull().$type<"active" | "revoked">(),
		tokenHash: text("token_hash").notNull(),
		tokenHint: text("token_hint").notNull(),
		...timestamps,
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
	},
	(table) => [
		uniqueIndex("agent_profiles_token_hash_idx").on(table.tokenHash),
		uniqueIndex("agent_profiles_organization_owner_name_idx").on(
			table.organizationId,
			sql`lower(${table.owner})`,
			sql`lower(${table.name})`,
		),
		index("agent_profiles_organization_status_idx").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		uniqueIndex("agent_profiles_member_name_idx")
			.on(table.memberId, sql`lower(${table.name})`)
			.where(sql`${table.memberId} IS NOT NULL`),
		check(
			"agent_profiles_status_check",
			sql`${table.status} IN ('active','revoked')`,
		),
		check(
			"agent_profiles_active_member_check",
			sql`${table.status} = 'revoked' OR ${table.memberId} IS NOT NULL`,
		),
		check(
			"agent_profiles_harness_check",
			sql`${table.harness} IN ('codex','claude_code','hermes','pi','generic_mcp')`,
		),
		check(
			"agent_profiles_token_hash_check",
			sql`${table.tokenHash} ~ '^[a-f0-9]{64}$'`,
		),
	],
);

export const agentWorkspaceFileRevisions = pgTable(
	"agent_workspace_file_revisions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		memberId: uuid("member_id")
			.notNull()
			.references(() => members.id, { onDelete: "restrict" }),
		agentProfileId: uuid("agent_profile_id")
			.notNull()
			.references(() => agentProfiles.id, { onDelete: "restrict" }),
		workspaceScope: text("workspace_scope").notNull().default("agent"),
		path: text("path").notNull(),
		version: integer("version").notNull(),
		byteSize: integer("byte_size").notNull(),
		ciphertext: text("ciphertext"),
		iv: text("iv"),
		authTag: text("auth_tag"),
		keyVersion: text("key_version"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		uniqueIndex("agent_workspace_profile_path_version_idx")
			.on(table.agentProfileId, table.path, table.version)
			.where(sql`${table.workspaceScope} = 'agent'`),
		uniqueIndex("user_workspace_path_version_idx")
			.on(table.organizationId, table.memberId, table.path, table.version)
			.where(sql`${table.workspaceScope} = 'user'`),
		check(
			"workspace_scope_check",
			sql`${table.workspaceScope} IN ('agent', 'user')`,
		),
		index("agent_workspace_member_profile_idx").on(
			table.organizationId,
			table.memberId,
			table.agentProfileId,
			table.path,
		),
		check(
			"agent_workspace_version_check",
			sql`${table.version} > 0 AND ${table.byteSize} >= 0`,
		),
	],
);

export const agentDevices = pgTable(
	"agent_devices",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		agentProfileId: uuid("agent_profile_id")
			.notNull()
			.references(() => agentProfiles.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		publicKey: text("public_key").notNull(),
		status: text("status").notNull().$type<"active" | "revoked">(),
		privacyMode: text("privacy_mode").notNull().$type<PrivacyMode>(),
		lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
		...timestamps,
	},
	(table) => [
		uniqueIndex("agent_devices_organization_profile_name_idx").on(
			table.organizationId,
			table.agentProfileId,
			sql`lower(${table.name})`,
		),
		index("agent_devices_organization_status_idx").on(
			table.organizationId,
			table.status,
			table.updatedAt,
		),
		check(
			"agent_devices_status_check",
			sql`${table.status} IN ('active','revoked')`,
		),
		check(
			"agent_devices_privacy_mode_check",
			sql`${table.privacyMode} IN ('metadata','approved_excerpts')`,
		),
	],
);

export const repositoryMappings = pgTable(
	"repository_mappings",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		repository: text("repository").notNull(),
		project: text("project").notNull(),
		contextPaths: text("context_paths")
			.array()
			.notNull()
			.default(sql`'{}'::text[]`),
		...timestamps,
	},
	(table) => [
		uniqueIndex("repository_mappings_organization_repository_idx").on(
			table.organizationId,
			sql`lower(${table.repository})`,
		),
	],
);

export const auditEvents = pgTable(
	"audit_events",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		actor: text("actor").notNull(),
		action: text("action").notNull(),
		targetType: text("target_type").notNull(),
		targetId: text("target_id"),
		sourceEventId: uuid("source_event_id").references(
			() => sourceEvents.id,
			{ onDelete: "set null" },
		),
		proposalId: uuid("proposal_id").references(() => proposals.id, {
			onDelete: "set null",
		}),
		details: jsonb("details")
			.notNull()
			.$type<Record<string, JsonValue>>()
			.default({}),
		occurredAt: timestamp("occurred_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
	},
	(table) => [
		index("audit_events_organization_occurred_idx").on(
			table.organizationId,
			table.occurredAt,
		),
	],
);

export const outboxJobs = pgTable(
	"outbox_jobs",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		topic: text("topic").notNull(),
		dedupeKey: text("dedupe_key").notNull(),
		payload: jsonb("payload").notNull().$type<JsonValue>(),
		state: text("state")
			.notNull()
			.$type<"pending" | "running" | "completed" | "failed">(),
		attempts: integer("attempts").notNull().default(0),
		availableAt: timestamp("available_at", { withTimezone: true })
			.notNull()
			.defaultNow(),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		leaseToken: bigint("lease_token", { mode: "number" })
			.notNull()
			.default(0),
		leaseUntil: timestamp("lease_until", { withTimezone: true }),
		completedAt: timestamp("completed_at", { withTimezone: true }),
		lastError: text("last_error"),
		...timestamps,
	},
	(table) => [
		uniqueIndex("outbox_jobs_organization_dedupe_idx").on(
			table.organizationId,
			table.dedupeKey,
		),
		index("outbox_jobs_dispatch_idx").on(
			table.organizationId,
			table.state,
			table.availableAt,
		),
		check(
			"outbox_jobs_state_check",
			sql`${table.state} IN ('pending','running','completed','failed')`,
		),
		check("outbox_jobs_lease_token_check", sql`${table.leaseToken} >= 0`),
	],
);

export const workEntities = pgTable(
	"work_entities",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		kind: text("kind").notNull().$type<"execution" | "artifact">(),
		identityHash: text("identity_hash").notNull(),
	},
	(table) => [
		uniqueIndex("work_entities_identity_idx").on(
			table.organizationId,
			table.identityHash,
		),
		check(
			"work_entities_kind_check",
			sql`${table.kind} IN ('execution','artifact')`,
		),
	],
);

export const workAssertions = pgTable(
	"work_assertions",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		entityId: uuid("entity_id")
			.notNull()
			.references(() => workEntities.id),
		taskId: uuid("task_id").references(() => tasks.id),
		claimId: uuid("claim_id")
			.notNull()
			.references(() => evidenceClaims.id),
		sourceEventId: uuid("source_event_id")
			.notNull()
			.references(() => sourceEvents.id),
		operationKey: text("operation_key").notNull(),
		inputHash: text("input_hash").notNull(),
		bodyEnvelope: jsonb("body_envelope").$type<EncryptedPayload>(),
	},
	(table) => [
		uniqueIndex("work_assertions_operation_idx").on(
			table.organizationId,
			table.operationKey,
		),
		index("work_assertions_source_idx").on(
			table.organizationId,
			table.sourceEventId,
		),
	],
);

export const workScopes = pgTable(
	"work_scopes",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id),
		sourceEventIds: uuid("source_event_ids").array().notNull(),
		bodyEnvelope: jsonb("body_envelope").$type<EncryptedPayload>(),
	},
	(table) => [
		uniqueIndex("work_scopes_task_idx").on(
			table.organizationId,
			table.taskId,
		),
	],
);

export const workStateAssessments = pgTable(
	"work_state_assessments",
	{
		id: uuid("id").primaryKey(),
		organizationId: uuid("organization_id")
			.notNull()
			.references(() => organizations.id),
		taskId: uuid("task_id")
			.notNull()
			.references(() => tasks.id),
		scopeId: uuid("scope_id")
			.notNull()
			.references(() => workScopes.id),
		runId: uuid("run_id")
			.notNull()
			.references(() => interpretationRuns.id),
		modelCallId: uuid("model_call_id")
			.notNull()
			.references(() => modelCalls.id),
		operationKey: text("operation_key").notNull(),
		sourceEventIds: uuid("source_event_ids").array().notNull(),
		bodyEnvelope: jsonb("body_envelope").$type<EncryptedPayload>(),
	},
	(table) => [
		uniqueIndex("work_state_assessments_operation_idx").on(
			table.organizationId,
			table.operationKey,
		),
	],
);
