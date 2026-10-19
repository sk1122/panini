import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { Observation, TaskFields } from "../src/domain/types.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { EmbeddingObservationEpisodeGrouper } from "../src/intelligence/observation-episodes.js";
import type {
	EvidenceInterpreter,
	EvidenceInterpreterInput,
	InterpretationOutput,
} from "../src/intelligence/types.js";
import { EmbeddingJevWorkEntityRetriever } from "../src/retrieval/work-entity-retriever.js";
import type { EmbeddingAdapter } from "../src/retrieval/embedding-adapter.js";
import { ContinuousReconciliationLoop } from "../src/reconciliation/continuous-reconciliation.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const integration = databaseUrl ? describe : describe.skip;
const { Pool } = pg;
const testEncryptionKey = Buffer.alloc(32, 7).toString("base64");

integration("PostgreSQL ledger", () => {
	let store: PostgresLedgerStore;
	let ledger: TeamLedger;
	let pool: pg.Pool;

	beforeAll(() => {
		store = new PostgresLedgerStore(databaseUrl!, testEncryptionKey);
		ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		pool = new Pool({ connectionString: databaseUrl });
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

	it("runs the grouped embedding, Jev, interpretation, and recurring reconciliation flow end to end", async () => {
		const organizationId = randomUUID();

		await pool.query(
			"INSERT INTO organizations (id, slug, name) VALUES ($1,$2,$3)",
			[organizationId, `episode-${organizationId}`, "Episode E2E"],
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
			const slack = await isolatedStore.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: `slack-${organizationId}`,
				eventKind: "message.observed",
				occurredAt: "2026-09-21T08:00:00.000Z",
				fetchedAt: "2026-09-21T08:00:01.000Z",
				sourceRef: "slack:T1:C1:100.1",
				sourceUrl: null,
				contentHash: `slack-${organizationId}`,
				visibility: "company",
				payloadVersion: "e2e",
				payload: {
					channel: "C1",
					messageTs: "100.1",
					threadTs: "100.1",
					text: "Document the production rollback procedure and verify the rollback runbook.",
				},
			});
			const github = await isolatedStore.appendSourceEvent({
				provider: "github",
				installationKey: "G1",
				providerEventId: `github-${organizationId}`,
				eventKind: "pull_request.snapshot",
				occurredAt: "2026-09-21T09:00:00.000Z",
				fetchedAt: "2026-09-21T09:00:01.000Z",
				sourceRef: "github:1:pull_request.snapshot:42",
				sourceUrl: null,
				contentHash: `github-${organizationId}`,
				visibility: "company",
				payloadVersion: "e2e",
				payload: {
					repository: "example/service",
					pullId: "42",
					title: "Add production rollback runbook",
					text: "Add production rollback runbook and verification steps.",
				},
			});

			const create = async (title: string) => {
				const proposal = await isolatedLedger.proposeTaskCreation({
					externalRef: `e2e:${organizationId}:${title}`,
					title,
					description:
						"Create and verify the production rollback instructions.",
					status: "in_progress",
					priority: "high",
					owner: null,
					project: null,
					projectId: null,
					rationale: "E2E baseline",
					requestedBy: "test:e2e",
					evidenceIds: [slack.event.id, github.event.id],
				});

				return isolatedLedger.approveProposal(
					proposal.id,
					"test:e2e",
					"E2E baseline",
				) as Promise<import("../src/domain/types.js").Task>;
			};

			const canonical = await create(
				"Document the production rollback procedure",
			);
			const duplicate = await create(
				"Write the production rollback runbook",
			);

			const vector = (text: string): number[] => [
				/rollback/i.test(text) ? 1 : 0,
				/billing/i.test(text) ? 1 : 0,
				/unrelated/i.test(text) ? 1 : 0,
			];

			let documentEmbeddingCalls = 0;
			const embedding: EmbeddingAdapter = {
				model: "voyageai/voyage-4",
				async embed(texts) {
					return texts.map(vector);
				},
				async embedQuery(text) {
					return vector(text);
				},
				async embedDocuments(texts) {
					documentEmbeddingCalls += 1;
					return texts.map(vector);
				},
			};
			const jevFetcher = (async (
				_url: string | URL | Request,
				init?: RequestInit,
			) => {
				const body = JSON.parse(String(init?.body)) as {
					state: { query: string; candidate: { text: string } };
				};
				const relevant =
					/rollback/i.test(body.state.query) &&
					/rollback/i.test(body.state.candidate.text)
						? 0.97
						: 0.05;

				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: { relevant: { type: "noul", noul: relevant } },
					}),
					{ status: 200 },
				);
			}) as typeof fetch;
			let calls = 0;
			const interpreter: EvidenceInterpreter = {
				name: "e2e-interpreter:episode-reconciliation-v1",
				async interpret(
					input: EvidenceInterpreterInput,
				): Promise<InterpretationOutput> {
					calls += 1;
					if (calls > 1)
						return {
							summary: "Accepted state is consistent.",
							findings: [],
						};
					expect(input.events).toHaveLength(2);
					expect(input.retrieval).toMatchObject({
						provider: "embedding_jev",
						embeddingModel: "voyageai/voyage-4",
						episodeGrouping: "semantic",
					});
					expect(input.tasks.map((task) => task.id)).toEqual(
						expect.arrayContaining([canonical.id, duplicate.id]),
					);
					return {
						summary:
							"Two Tasks represent the same rollback deliverable.",
						findings: [
							{
								kind: "task_duplicate",
								taskId: duplicate.id,
								duplicateOfTaskId: canonical.id,
								title: null,
								description: null,
								status: null,
								priority: null,
								owner: null,
								project: null,
								projectId: null,
								projectOutcome: null,
								projectStatus: null,
								dueDate: null,
								dependencyRefs: [],
								contextPath: null,
								contextTitle: null,
								contextBody: null,
								contextFactType: null,
								contextFactValue: null,
								rationale:
									"Both cited observations describe one rollback runbook deliverable.",
								confidence: 0.98,
								evidenceEventIds: input.events.map(
									(event) => event.id,
								),
								caveats: [],
							},
						],
					};
				},
			};
			const grouper = new EmbeddingObservationEpisodeGrouper(embedding, [
				"company",
			]);

			await grouper.group([slack.event, github.event]);
			await grouper.group([slack.event, github.event]);
			expect(documentEmbeddingCalls).toBe(1);

			const entityRetriever = new EmbeddingJevWorkEntityRetriever({
				apiKey: "e2e",
				embedding,
				fetcher: jevFetcher,
			});
			const intelligence = new EvidenceIntelligence({
				store: isolatedStore,
				ledger: isolatedLedger,
				interpreter,
				router: {
					name: "e2e-router",
					async route(events) {
						return events.map((event) => ({
							eventId: event.id,
							route: "task" as const,
							confidence: 0.99,
						}));
					},
				},
				episodeGrouper: grouper,
				entityRetriever,
				companyName: "Episode E2E",
				config: {
					enabled: true,
					mode: "manual",
					intervalSeconds: 900,
					maxEventsPerRun: 20,
					maxEvidenceCharacters: 60_000,
					maxSourceDocumentCharacters: 320_000,
					maxContextCharacters: 30_000,
					minimumConfidence: 0.7,
					completionMinimumConfidence: 0.85,
					completionMinimumEvidenceItems: 2,
					completionEvidenceProviders: ["github", "agent"],
					sourceProviders: ["slack", "github"],
					reconciliationEnabled: true,
					reconciliationIntervalSeconds: 900,
					reconciliationMinimumAgeSeconds: 0,
				},
				log: { info() {}, error() {} },
			});

			const report = await intelligence.run();

			expect(report.outcomes).toMatchObject([
				{ kind: "task_duplicate", state: "applied" },
			]);
			expect(await isolatedLedger.getTask(duplicate.id)).toMatchObject({
				status: "cancelled",
				version: 2,
			});
			expect((await isolatedLedger.workGraph()).links).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						taskId: duplicate.id,
						targetTaskId: canonical.id,
						linkType: "duplicates",
					}),
				]),
			);

			const loop = new ContinuousReconciliationLoop(
				isolatedStore,
				isolatedLedger,
				intelligence,
				{
					intervalSeconds: 900,
					minimumAgeSeconds: 0,
					log: { info() {}, error() {} },
				},
			);

			expect((await loop.runOnce()).state).toBe("reconciled");
			expect((await loop.runOnce()).state).toBe("reconciled");
			expect((await loop.runOnce()).state).toBe("idle");
			expect(
				(await isolatedStore.listAuditEvents(100)).filter(
					(event) =>
						event.action ===
						"intelligence.reconciliation.completed",
				),
			).toHaveLength(2);
		} finally {
			await isolatedStore.close();
		}
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
		expect(
			await replay.rebuild({
				apply: true,
				actor: "operator:postgres-rebuild",
			}),
		).toMatchObject({
			applied: true,
			after: { ok: true },
		});
		expect(await store.listAuditEvents(1_000)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "projection.rebuilt",
					actor: "operator:postgres-rebuild",
				}),
			]),
		);
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
