import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { Observation, TaskFields } from "../src/domain/types.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { ReplayVerifier } from "../src/replay/verifier.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const { Pool } = pg;
const suiteOrganizationId = randomUUID();
const testEncryptionKey = Buffer.alloc(32, 7).toString("base64");

integration("PostgreSQL ledger", () => {
	let store: PostgresLedgerStore;
	let ledger: TeamLedger;
	let pool: pg.Pool;

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl });
		await pool.query(
			"INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
			[
				suiteOrganizationId,
				`postgres-suite-${suiteOrganizationId}`,
				"Postgres E2E",
			],
		);
		store = new PostgresLedgerStore(
			databaseUrl!,
			testEncryptionKey,
			suiteOrganizationId,
		);
		ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
	});

	afterAll(async () => {
		await store.close();
		await pool.end();
	});

	it("persists the Phase 1-5 workspace, review, relay, and retrieval paths", async () => {
		const marker = randomUUID();
		const installation = await ledger.configureInstallation(
			{
				provider: "notion",
				installationKey: `integration-${marker}`,
				displayName: "Integration Notion",
				transport: "poll",
				config: { roots: [marker] },
			},
			"test:postgres",
		);

		await ledger.updateInstallation(
			installation.id,
			{
				status: "healthy",
				lastSyncAt: "2026-09-16T10:00:00.000Z",
				lastSuccessAt: "2026-09-16T10:00:00.000Z",
				lastError: null,
			},
			"test:postgres",
		);

		const fields: TaskFields = {
			externalRef: `notion:page:${marker}`,
			title: `PostgreSQL integration ${marker}`,
			description: "Verifies the canonical persistence path.",
			status: "in_progress",
			priority: "high",
			owner: "Mira",
			project: "Panini",
			dueDate: null,
			dependencyRefs: [],
			sourceUrl: `https://notion.example/${marker}`,
		};

		const observation = (
			providerEventId: string,
			taskFields: TaskFields,
		): Observation => ({
			event: {
				provider: "notion",
				installationKey: installation.installationKey,
				providerEventId,
				eventKind: "snapshot.retrieved",
				occurredAt: "2026-09-16T10:00:00.000Z",
				fetchedAt: "2026-09-16T10:00:01.000Z",
				sourceRef: taskFields.externalRef!,
				sourceUrl: taskFields.sourceUrl,
				contentHash: providerEventId,
				visibility: "company",
				payloadVersion: "postgres-integration-v1",
				payload: { title: taskFields.title, status: taskFields.status },
			},
			signal: { type: "task_snapshot", fields: taskFields },
		});

		const captured = await ledger.ingest(
			observation(`create-${marker}`, fields),
		);

		expect(captured).toMatchObject({
			duplicate: false,
			task: null,
			proposal: null,
		});
		expect(
			(await ledger.ingest(observation(`create-${marker}`, fields)))
				.duplicate,
		).toBe(true);

		const created = await ledger.createTask(
			{ ...fields, clientEventId: `manual-${marker}` },
			"test:postgres",
		);

		expect(created).toMatchObject({ version: 1, status: "in_progress" });

		const createdDetail = await ledger.taskDetail(created.id);

		expect(createdDetail.proposals).toMatchObject([
			{
				kind: "task_create",
				evidenceIds: [],
			},
		]);
		expect(createdDetail.evidence).toEqual([]);

		const firstChange = await ledger.propose({
			clientEventId: `owner-change-${marker}`,
			taskId: created.id,
			baseRevision: created.version,
			changes: { owner: "Asha" },
			rationale: "Ownership was confirmed.",
			requestedBy: "agent:integration",
			evidenceIds: [],
		});

		expect(
			(
				await ledger.propose({
					clientEventId: `owner-change-${marker}`,
					taskId: created.id,
					baseRevision: created.version,
					changes: { owner: "Asha" },
					rationale: "Ownership was confirmed.",
					requestedBy: "agent:integration",
					evidenceIds: [],
				})
			).id,
		).toBe(firstChange.id);

		const staleChange = await ledger.propose({
			taskId: created.id,
			changes: { status: "review" },
			rationale: "Implementation is ready for review.",
			requestedBy: "agent:integration",
			evidenceIds: [],
		});

		await ledger.approveProposal(
			firstChange.id,
			"user:reviewer",
			"Ownership verified.",
		);
		await expect(
			ledger.approveProposal(staleChange.id, "user:reviewer", null),
		).rejects.toMatchObject({ code: "CONFLICT" });

		const rebased = await ledger.rebaseProposal(
			staleChange.id,
			"user:reviewer",
		);
		const accepted = await ledger.approveProposal(
			rebased.id,
			"user:reviewer",
			"Checks passed.",
		);

		expect(accepted).toMatchObject({
			version: 3,
			owner: "Asha",
			status: "review",
		});
		expect(
			await ledger.undoTask(
				created.id,
				"user:reviewer",
				"Restore the prior status.",
			),
		).toMatchObject({
			version: 4,
			status: "in_progress",
		});

		const context = await ledger.createContextEntry(
			{
				kind: "fact",
				path: `/decisions/${marker}`,
				title: "Integration decision",
				factType: "decision",
				value: `Use PostgreSQL ${marker}`,
			},
			"user:reviewer",
		);
		const retrieval = await ledger.retrieve({
			objective: "find the integration database decision",
			query: marker,
		});

		expect(retrieval).toMatchObject({
			provider: "postgres",
			entries: [{ id: context.id }],
			manifest: { returnedCount: 1 },
		});
		expect(retrieval.citations[0]).toMatchObject({
			entryId: context.id,
			contentHash: expect.any(String),
		});

		const member = await ledger.syncMember(
			{
				subject: `integration:${marker}`,
				displayName: `Owner ${marker}`,
			},
			"test:postgres",
		);
		const enrollment = await ledger.createAgentProfile({
			memberId: member.id,
			name: "PostgreSQL agent",
			harness: "codex",
			capabilities: ["context:read", "work:read", "evidence:report"],
		});

		expect(
			await ledger.authenticateAgentSecret(enrollment.secret),
		).toMatchObject({
			profile: { id: enrollment.profile.id },
			member: { id: member.id },
		});
		expect(await ledger.listAgentProfiles(member.id)).toHaveLength(1);

		const device = await ledger.enrollDevice(
			{
				agentProfileId: enrollment.profile.id,
				name: "Integration laptop",
				publicKey: `test-public-key-${marker}`,
				privacyMode: "metadata",
			},
			"user:owner",
		);

		expect(await ledger.getDevice(device.id)).toMatchObject({
			status: "active",
			privacyMode: "metadata",
		});

		const mapping = await ledger.configureRepositoryMapping(
			{
				repository: `Example/${marker}`,
				project: "Panini",
				contextPaths: [context.path],
			},
			"user:owner",
		);
		const replacedMapping = await ledger.configureRepositoryMapping(
			{
				repository: `example/${marker}`,
				project: "Panini Core",
				contextPaths: [context.path],
			},
			"user:owner",
		);

		expect(replacedMapping).toMatchObject({
			id: mapping.id,
			project: "Panini Core",
		});

		const eventId = context.evidenceIds[0]!;
		const encrypted = await pool.query<{
			payload: unknown;
			ciphertext: string;
		}>(
			`SELECT se.payload, sec.ciphertext
         FROM source_events se
         JOIN source_event_contents sec ON sec.source_event_id=se.id
        WHERE se.id=$1`,
			[eventId],
		);

		expect(encrypted.rows[0]?.payload).toBeNull();
		expect(encrypted.rows[0]?.ciphertext).not.toContain(marker);

		const wrongKeyStore = new PostgresLedgerStore(
			databaseUrl!,
			Buffer.alloc(32, 9).toString("base64"),
			suiteOrganizationId,
		);

		try {
			expect(
				(await wrongKeyStore.listSourceEvents(100)).find(
					(event) => event.id === eventId,
				)?.payload,
			).toEqual({ contentUnavailable: true });
			await expect(
				wrongKeyStore.getSourceEvents([eventId]),
			).rejects.toThrow();
		} finally {
			await wrongKeyStore.close();
		}

		const mutationRef = `slack:T1:C1:${marker}`;
		const originalMessage = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "T1",
			providerEventId: `slack-original-${marker}`,
			eventKind: "message.explicitly_captured",
			occurredAt: "2026-09-16T10:00:00.000Z",
			fetchedAt: "2026-09-16T10:00:01.000Z",
			sourceRef: mutationRef,
			sourceUrl: null,
			contentHash: `original-${marker}`,
			visibility: "slack:channel:C1",
			payloadVersion: "test",
			payload: { text: "original" },
		});
		const replacementMessage = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "T1",
			providerEventId: `slack-edited-${marker}`,
			eventKind: "message.edited",
			occurredAt: "2026-09-16T10:01:00.000Z",
			fetchedAt: "2026-09-16T10:01:01.000Z",
			sourceRef: mutationRef,
			sourceUrl: null,
			contentHash: `edited-${marker}`,
			visibility: "slack:channel:C1",
			payloadVersion: "test",
			payload: { text: "edited" },
			supersedesEventId: originalMessage.event.id,
		});

		expect(
			await ledger.revokeEvidenceBySourceRef(
				"slack",
				"T1",
				mutationRef,
				"connector:slack",
				replacementMessage.event.id,
			),
		).toBe(1);
		expect(
			await ledger.latestEvidenceBySourceRef("slack", "T1", mutationRef),
		).toMatchObject({
			id: replacementMessage.event.id,
			supersedesEventId: originalMessage.event.id,
		});

		const githubEvent = await store.appendSourceEvent({
			provider: "github",
			installationKey: "acme",
			providerEventId: `github-${marker}`,
			eventKind: "check_run.success",
			occurredAt: "2026-09-16T10:02:00.000Z",
			fetchedAt: "2026-09-16T10:02:01.000Z",
			sourceRef: `github:acme/panini:${marker}`,
			sourceUrl: null,
			contentHash: `github-${marker}`,
			visibility: "github:repository:acme/panini",
			payloadVersion: "test",
			payload: { conclusion: "success" },
		});

		expect(
			await ledger.revokeEvidenceByVisibility(
				"github",
				"acme",
				"github:repository:acme/panini",
				"connector:github",
			),
		).toBe(1);
		expect(
			(await ledger.listEvidence()).find(
				(event) => event.id === githubEvent.event.id,
			),
		).toBeUndefined();

		expect(await ledger.revokeEvidence(eventId, "user:owner")).toBe(true);
		expect(await ledger.getContextEntry(context.id)).toBeNull();
		expect(
			(await ledger.retrieve({ objective: marker, query: marker }))
				.entries,
		).toEqual([]);
		expect(
			(
				await pool.query(
					"SELECT 1 FROM source_event_contents WHERE source_event_id=$1",
					[eventId],
				)
			).rowCount,
		).toBe(0);

		await ledger.revokeDevice(device.id, "user:owner");
		expect(await ledger.getDevice(device.id)).toMatchObject({
			status: "revoked",
		});

		const audit = await ledger.listAuditEvents(100);

		expect(
			audit.some((event) => event.action === "proposal.approved"),
		).toBe(true);
		expect(
			audit.some((event) => event.action === "evidence.content_revoked"),
		).toBe(true);
		expect(
			audit.filter(
				(event) =>
					event.proposalId === firstChange.id &&
					event.action === "proposal.approved",
			),
		).toHaveLength(1);

		const decisionJobs = await pool.query<{
			topic: string;
			state: string;
			payload: { proposalId?: string };
		}>(
			"SELECT topic, state, payload FROM outbox_jobs WHERE payload->>'proposalId'=$1",
			[firstChange.id],
		);

		expect(decisionJobs.rows).toMatchObject([
			{ topic: "projection.task.revised", state: "pending" },
		]);

		const claimed = await store.claimOutboxJobs(
			`worker-${marker}`,
			100,
			30,
		);
		const decisionJob = claimed.find(
			(job) =>
				typeof job.payload === "object" &&
				job.payload !== null &&
				!Array.isArray(job.payload) &&
				job.payload.proposalId === firstChange.id,
		);

		expect(decisionJob).toMatchObject({
			state: "running",
			attempts: 1,
			lockedBy: `worker-${marker}`,
		});
		await expect(
			store.completeOutboxJob(decisionJob!.id, "worker:wrong"),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(
			await store.completeOutboxJob(decisionJob!.id, `worker-${marker}`),
		).toMatchObject({ state: "completed", lockedBy: null });
	});

	it("reconciles cross-provider member identities transactionally", async () => {
		const marker = randomUUID();
		const displayName = `Identity ${marker}`;
		const notion = await ledger.reconcileMemberIdentity(
			{
				provider: "notion",
				installationKey: "default",
				externalId: `person-${marker}`,
				displayName,
				email: `${marker}@example.test`,
			},
			"test:postgres-notion",
		);
		const slack = await ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T-INTEGRATION",
				externalId: `U-${marker}`,
				displayName,
			},
			"test:postgres-slack",
		);

		expect(slack).toMatchObject({
			matchedBy: "display_name",
			member: { id: notion.member!.id },
		});

		const workspace = await ledger.workspace();

		expect(
			workspace.memberIdentities.filter(
				(identity) => identity.memberId === notion.member!.id,
			),
		).toHaveLength(2);
	});

	it("isolates every repository operation by organization", async () => {
		const organizationId = randomUUID();

		await pool.query(
			"INSERT INTO organizations (id, slug, name) VALUES ($1,$2,$3)",
			[organizationId, `tenant-${organizationId}`, "Isolated tenant"],
		);

		const isolatedStore = new PostgresLedgerStore(
			databaseUrl!,
			testEncryptionKey,
			organizationId,
		);
		const isolatedLedger = new TeamLedger(
			isolatedStore,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);

		try {
			const task = await isolatedLedger.createTask(
				{ title: "Tenant-only task" },
				"member:tenant-owner",
			);

			expect(await isolatedLedger.getTask(task.id)).toMatchObject({
				title: "Tenant-only task",
			});
			expect(await ledger.getTask(task.id)).toBeNull();
			expect(
				(await ledger.board()).tasks.some(
					(candidate) => candidate.id === task.id,
				),
			).toBe(false);
			expect(
				(await store.listOutboxJobs(1_000)).some(
					(job) =>
						typeof job.payload === "object" &&
						job.payload !== null &&
						!Array.isArray(job.payload) &&
						job.payload.taskId === task.id,
				),
			).toBe(false);
		} finally {
			await isolatedStore.close();
		}
	});

	it("excludes accepted-context receipts from interpretation candidates", async () => {
		const marker = randomUUID();
		const receipt = await store.appendSourceEvent({
			provider: "manual",
			installationKey: "integration",
			providerEventId: `context-lifecycle-${marker}`,
			eventKind: "context.lifecycle.reviewed",
			occurredAt: "2026-09-17T12:00:00.000Z",
			fetchedAt: "2026-09-17T12:00:00.000Z",
			sourceRef: `manual:context-lifecycle:${marker}`,
			sourceUrl: null,
			contentHash: `context-lifecycle-${marker}`,
			visibility: "company",
			payloadVersion: "context-lifecycle-v1",
			payload: { lifecycleState: "needs_review" },
		});
		const observation = await store.appendSourceEvent({
			provider: "manual",
			installationKey: "integration",
			providerEventId: `work-observed-${marker}`,
			eventKind: "work.observed",
			occurredAt: "2026-09-17T12:01:00.000Z",
			fetchedAt: "2026-09-17T12:01:00.000Z",
			sourceRef: `manual:work-observed:${marker}`,
			sourceUrl: null,
			contentHash: `work-observed-${marker}`,
			visibility: "company",
			payloadVersion: "test",
			payload: { outcome: "A human supplied an observation." },
		});

		const candidates = await store.listUninterpretedSourceEvents(
			["manual"],
			500,
		);

		expect(candidates.map((event) => event.id)).toContain(
			observation.event.id,
		);
		expect(candidates.map((event) => event.id)).not.toContain(
			receipt.event.id,
		);
	});

	it("persists connector checkpoints, graph projections, leases, and shadow replay", async () => {
		const marker = randomUUID();
		const installation = await ledger.configureInstallation(
			{
				provider: "notion",
				installationKey: `checkpoint-${marker}`,
				displayName: "Checkpoint integration",
				transport: "poll",
				config: { roots: [marker] },
			},
			"test:postgres",
		);
		const checkpoint = await ledger.updateConnectorSyncState(
			installation.id,
			"project-board",
			{
				status: "healthy",
				cursor: {
					sourceRefs: [`notion:page:${marker}`],
					fullScan: true,
				},
				lastAttemptAt: "2026-09-16T11:00:00.000Z",
				lastSuccessAt: "2026-09-16T11:00:01.000Z",
				lastRepairAt: "2026-09-16T11:00:01.000Z",
				observedCount: 1,
				revokedCount: 0,
			},
		);

		expect((await ledger.workspace()).connectorSyncs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: checkpoint.id,
					resourceKey: "project-board",
					status: "healthy",
					observedCount: 1,
				}),
			]),
		);

		const project = `Replay graph ${marker}`;
		const graphProject = await ledger.createProject(
			{ name: project, outcome: "Publish the tested release." },
			"user:postgres-graph",
		);
		const prerequisite = await ledger.createTask(
			{
				clientEventId: `graph-prerequisite-${marker}`,
				title: "Prepare the release",
				project,
				projectId: graphProject.id,
			},
			"user:postgres-graph",
		);
		const dependent = await ledger.createTask(
			{
				clientEventId: `graph-dependent-${marker}`,
				title: "Publish the release",
				project,
				projectId: graphProject.id,
				dependencyRefs: [prerequisite.externalRef!],
			},
			"user:postgres-graph",
		);
		const graph = await ledger.workGraph();
		const projectedProject = graph.projects.find(
			(candidate) => candidate.name === project,
		);

		expect(projectedProject).toBeDefined();
		expect(graph.workstreams).toEqual([]);
		expect(graph.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					taskId: dependent.id,
					targetTaskId: prerequisite.id,
					linkType: "depends_on",
				}),
			]),
		);

		const competingStore = new PostgresLedgerStore(
			databaseUrl!,
			testEncryptionKey,
			suiteOrganizationId,
		);
		const leaseKey = `integration-lease:${marker}`;

		try {
			expect(
				await store.acquireSingletonLease(leaseKey, "worker:first"),
			).toBe(true);
			expect(
				await competingStore.acquireSingletonLease(
					leaseKey,
					"worker:second",
				),
			).toBe(false);
			await store.releaseSingletonLease(leaseKey, "worker:first");
			expect(
				await competingStore.acquireSingletonLease(
					leaseKey,
					"worker:second",
				),
			).toBe(true);
			await competingStore.releaseSingletonLease(
				leaseKey,
				"worker:second",
			);
		} finally {
			await competingStore.close();
		}

		const recordedLink = await store.upsertWorkLink({
			taskId: dependent.id,
			targetTaskId: prerequisite.id,
			targetRef: `release-artifact:${marker}`,
			linkType: "relates_to",
			changedBy: "user:postgres-graph",
		});
		const priorityChange = await ledger.propose({
			taskId: dependent.id,
			changes: { priority: "high" },
			rationale: "Prioritize release verification.",
			requestedBy: "user:postgres-graph",
		});

		await ledger.approveProposal(
			priorityChange.id,
			"user:postgres-graph",
			"Prioritized.",
		);
		expect(await store.listWorkLinks(dependent.id)).toContainEqual(
			recordedLink,
		);

		const replay = new ReplayVerifier(store);

		expect(
			await replay.rebuild({
				apply: false,
				actor: "operator:postgres-preview",
			}),
		).toMatchObject({
			applied: false,
			eligible: true,
			before: { ok: true },
		});
		await pool.query(
			"UPDATE work_links SET target_task_id=NULL WHERE id=$1",
			[recordedLink.id],
		);
		expect(
			await replay.rebuild({
				apply: false,
				actor: "test:repair-preview",
			}),
		).toMatchObject({ eligible: true, before: { ok: false } });

		expect(
			await replay.rebuild({
				apply: true,
				actor: "operator:postgres-rebuild",
			}),
		).toMatchObject({
			applied: true,
			after: { ok: true },
		});
		expect(await store.listWorkLinks(dependent.id)).toContainEqual(
			recordedLink,
		);
		expect(await store.listAuditEvents(1_000)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "projection.rebuilt",
					actor: "operator:postgres-rebuild",
				}),
			]),
		);

		const unknownId = randomUUID();

		await pool.query(
			"INSERT INTO work_links (id,organization_id,task_id,target_ref,link_type) SELECT $1,organization_id,$2,$3,'relates_to' FROM tasks WHERE id=$2",
			[unknownId, dependent.id, `unrecorded:${marker}`],
		);
		try {
			expect(
				await replay.rebuild({ apply: false, actor: "test:guard" }),
			).toMatchObject({ eligible: false });
			await expect(
				replay.rebuild({ apply: true, actor: "test:guard" }),
			).rejects.toThrow("without immutable revision history");
		} finally {
			await pool.query("DELETE FROM work_links WHERE id=$1", [unknownId]);
		}
	});

	it("selects Notion source documents for interpretation without selecting task snapshots", async () => {
		const marker = randomUUID();
		const common = {
			provider: "notion",
			installationKey: `selector-${marker}`,
			occurredAt: "2026-09-16T10:00:00.000Z",
			fetchedAt: "2026-09-16T10:00:01.000Z",
			sourceUrl: null,
			visibility: "company",
			payloadVersion: "test",
		};
		const task = await store.appendSourceEvent({
			...common,
			providerEventId: `task-${marker}`,
			eventKind: "snapshot.retrieved",
			sourceRef: `notion:page:task-${marker}`,
			contentHash: `task-${marker}`,
			payload: { title: "Task snapshot" },
		});
		const document = await store.appendSourceEvent({
			...common,
			providerEventId: `document-${marker}`,
			eventKind: "source.document.retrieved",
			sourceRef: `notion:page:document-${marker}`,
			contentHash: `document-${marker}`,
			payload: {
				document: { title: "Handbook", markdown: "A durable policy." },
			},
		});

		const candidates = await store.listUninterpretedSourceEvents(
			["notion:source.document.retrieved"],
			500,
		);

		expect(candidates.map((event) => event.id)).toContain(
			document.event.id,
		);
		expect(candidates.map((event) => event.id)).not.toContain(
			task.event.id,
		);
	});

	it("persists autonomous escalation and permits an authorized human resolution", async () => {
		const marker = randomUUID();
		const task = await ledger.createTask(
			{ title: `Escalation ${marker}` },
			"user:integration",
		);
		const proposal = await ledger.propose({
			taskId: task.id,
			baseRevision: task.version,
			changes: { owner: "Rina" },
			rationale: "Two credible sources assign different owners.",
			requestedBy: "intelligence:integration",
			evidenceIds: [],
		});

		await ledger.adjudicateProposal(proposal.id, {
			action: "escalate",
			actor: "adjudicator:integration",
			note: "Ownership evidence is contemporaneous and mutually inconsistent.",
			details: { confidence: 0.9, temporalBasis: "same effective time" },
		});

		expect(await ledger.getProposal(proposal.id)).toMatchObject({
			state: "escalated",
			decidedBy: "adjudicator:integration",
		});
		expect((await ledger.board()).proposals).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: proposal.id,
					state: "escalated",
				}),
			]),
		);
		await ledger.rejectProposal(
			proposal.id,
			"user:integration",
			"Resolved from the signed ownership record.",
		);
		expect(await ledger.getProposal(proposal.id)).toMatchObject({
			state: "rejected",
			decidedBy: "user:integration",
		});
	});
});
