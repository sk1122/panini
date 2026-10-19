import { randomUUID } from "node:crypto";
import pg from "pg";
import { expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";
import { OpenAIClaimExtractor } from "../src/intelligence/claim-extractor.js";
import { OutboxDispatcher } from "../src/outbox/runtime.js";
import { createTaskEvidenceReassessHandler } from "../src/reconciliation/task-evidence-reassess.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 87).toString("base64");

it("resumes paged target discovery and links an earlier logger commit as review-only context", async () => {
	if (!databaseUrl?.includes("panini_e2e"))
		throw new Error("Isolated panini_e2e database required");

	const pool = new pg.Pool({ connectionString: databaseUrl });
	const organizationId = randomUUID();

	await pool.query(
		"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
		[
			organizationId,
			`target-reassess-${organizationId}`,
			"Target reassess E2E",
		],
	);

	let store = new PostgresLedgerStore(databaseUrl, key, organizationId);
	const pipelineVersion = `target-reassess-${organizationId}`;
	const dispatchEpoch = `${pipelineVersion}:synthetic-budget`;
	const visibility = "github:repository:example/repo";
	let interrupted = false;
	let modelCalls = 0;

	try {
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: false,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);
		const events = [];

		for (let index = 0; index < 12; index += 1) {
			const sha = index.toString(16).padStart(40, "0");
			const message =
				index === 11
					? "Repair logger result recording"
					: `Independent maintenance item ${index}`;

			events.push(
				(
					await store.appendSourceEvent({
						provider: "github",
						installationKey: "app-1",
						providerEventId: `42:commit.snapshot:${organizationId}:${index}`,
						eventKind: "commit.snapshot",
						occurredAt: "2026-10-01T01:00:00.000Z",
						fetchedAt: "2026-10-01T01:00:01.000Z",
						sourceRef: `github:42:commit.snapshot:${sha}`,
						sourceUrl: `https://github.com/example/repo/commit/${sha}`,
						contentHash: `${organizationId}:${index}`,
						visibility,
						payloadVersion: "github-rest-v1",
						payload: {
							repositoryId: 42,
							repository: "example/repo",
							sha,
							message,
							authorLogin: "contributor",
							text: message,
						},
					})
				).event,
			);
		}

		const budget = await store.createInferenceBudget({
			label: organizationId,
			maxCalls: 10,
			maxInputTokens: 100_000,
			maxOutputTokens: 20_000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const extractor = new OpenAIClaimExtractor({
			store,
			apiKey: "unused",
			model: "mock-model",
			allowedVisibilities: [visibility],
			fetcher: async () => {
				modelCalls += 1;
				throw new Error(
					"Deterministic commit extraction must not call a model.",
				);
			},
		});
		const initial = new EvidencePipeline({
			store,
			ledger,
			pipelineVersion,
			extractor,
			identityResolver: {
				async resolve() {
					throw new Error("No task exists yet.");
				},
			},
		});
		const extracted = await initial.run({
			eventIds: events.map((event) => event.id),
			budgetId: budget.id,
			evaluationClock: new Date().toISOString(),
			knowledgeCutoff: null,
		});

		expect(extracted.claimCount).toBe(24);
		expect(modelCalls).toBe(0);

		const messageClaim = (
			await store.listClaimsByRun(extracted.runId!)
		).find(
			(claim) =>
				claim.body.kind === "context_statement" &&
				claim.body.statement === "Repair logger result recording",
		)!;
		const task = await ledger.createTask(
			{
				clientEventId: organizationId,
				title: "Repair logger result recording",
				description: "Verify logger output",
				status: "in_progress",
			},
			"user:e2e",
		);

		// Source/creation notifications are outside this targeted-reassessment fixture.
		await pool.query(
			"UPDATE outbox_jobs SET state='completed' WHERE organization_id=$1",
			[organizationId],
		);
		await store.enqueueOutboxJob({
			topic: "evidence.task.reassess",
			dedupeKey: `target-discovery:${organizationId}`,
			payload: {
				pipelineVersion,
				taskId: task.id,
				taskVersion: task.version,
				afterClaimId: null,
			},
		});

		const makeDispatcher = (
			current: PostgresLedgerStore,
			failOnce: boolean,
		) => {
			const currentLedger = new TeamLedger(
				current,
				new ProposalPolicy({
					autoApproveNewTasks: false,
					autoApproveContext: false,
					requireReviewForTaskChanges: true,
				}),
			);
			const pipeline = new EvidencePipeline({
				store: current,
				ledger: currentLedger,
				pipelineVersion,
				extractor: {
					name: "saved-claims-only",
					async extract() {
						throw new Error(
							"Target reassessment must reuse saved claims.",
						);
					},
				},
				identityResolver: {
					async resolve({ claim }) {
						if (
							claim.statement !== "Repair logger result recording"
						) {
							throw new Error(
								"Unrelated claim was selected for identity.",
							);
						}
						return {
							relationship: "related" as const,
							targetId: task.id,
							alternativeTargetIds: [],
							reasons: ["logger_message"],
						};
					},
				},
			});
			const reassess = createTaskEvidenceReassessHandler({
				store: current,
				evidencePipeline: pipeline,
				evidenceVersion: pipelineVersion,
				evidenceDispatchEpoch: dispatchEpoch,
				evidenceBudgetId: budget.id,
				policy: { mode: "review" },
				intelligenceModel: "mock-model",
				allowedVisibilities: [visibility],
				semanticDiscoveryEnabled: false,
				async semanticDiscoveryScores() {
					return { scores: [], screened: 0 };
				},
			});

			return new OutboxDispatcher(current, {
				workerId: `e2e:${randomUUID()}`,
				batchSize: 1,
				leaseSeconds: 10,
				pollIntervalMs: 100,
				maxAttempts: 3,
				retryBaseMs: 100,
				retryMaximumMs: 1000,
				handlers: new Map([
					[
						"evidence.task.reassess",
						async (job) => {
							await reassess(job);
							if (
								failOnce &&
								!interrupted &&
								(job.payload as { stage?: string }).stage ===
									"discover"
							) {
								interrupted = true;
								throw new Error(
									"Synthetic crash after persisted discovery cursor",
								);
							}
						},
					],
					["evidence.task.search_manifest", async () => {}],
				]),
				log: { info() {}, error() {} },
			});
		};

		let dispatcher = makeDispatcher(store, true);

		for (let index = 0; index < 15 && !interrupted; index += 1) {
			await dispatcher.runOnce();
			// Jobs use the database clock; allow newly enqueued work and retries to become due.
			if (!interrupted)
				await new Promise((resolve) => setTimeout(resolve, 110));
		}
		expect(interrupted).toBe(true);
		expect(
			(
				await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count
      FROM outbox_jobs WHERE organization_id=$1 AND topic='evidence.task.reassess'
        AND payload->>'discoveryCursor' IS NOT NULL`,
					[organizationId],
				)
			).rows[0]?.count,
		).not.toBe("0");
		await store.close();
		store = new PostgresLedgerStore(databaseUrl, key, organizationId);
		dispatcher = makeDispatcher(store, false);
		for (let index = 0; index < 50; index += 1) {
			await dispatcher.runOnce();

			const pending = (
				await pool.query<{ count: string }>(
					`SELECT count(*)::text AS count
        FROM outbox_jobs WHERE organization_id=$1 AND state IN ('pending','running')`,
					[organizationId],
				)
			).rows[0]?.count;

			if (pending === "0") break;
			await new Promise((resolve) => setTimeout(resolve, 110));
		}

		const jobs = (
			await pool.query<{
				topic: string;
				state: string;
				payload: Record<string, unknown>;
			}>(
				"SELECT topic,state,payload FROM outbox_jobs WHERE organization_id=$1 ORDER BY created_at,id",
				[organizationId],
			)
		).rows;

		expect(
			jobs
				.filter((job) => job.topic === "evidence.task.reassess")
				.every((job) => job.state === "completed"),
		).toBe(true);

		const manifests = jobs.filter(
			(job) => job.topic === "evidence.task.search_manifest",
		);

		expect(manifests).toHaveLength(1);
		expect(manifests[0]?.payload).toMatchObject({
			reason: "completed",
			selectedClaimIds: expect.arrayContaining([messageClaim.id]),
		});
		expect(
			(await store.listClaimsForTask(task.id, null, 10)).map(
				(claim) => claim.id,
			),
		).toContain(messageClaim.id);

		const assessments = await store.listAssessmentsForTask(task.id, 10);

		expect(assessments).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					claimIds: [messageClaim.id],
					disposition: "review_required",
					reasonCodes: expect.arrayContaining([
						"commit_message_context_only",
					]),
				}),
			]),
		);
		expect((await store.getTask(task.id))?.status).toBe("in_progress");
		expect(modelCalls).toBe(0);
	} finally {
		await store.close();
		await pool.end();
	}
}, 30_000);
