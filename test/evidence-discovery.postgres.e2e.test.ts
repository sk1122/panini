import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvidenceDiscoverySweep } from "../src/reconciliation/evidence-discovery.js";
import { OutboxDispatcher } from "../src/outbox/runtime.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { EvidencePipeline } from "../src/intelligence/evidence-pipeline.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const organizationId = randomUUID();

describe("durable evidence discovery over PostgreSQL", () => {
	let pool: pg.Pool;
	let store: PostgresLedgerStore;

	beforeAll(async () => {
		if (!databaseUrl || !databaseUrl.includes("panini_e2e"))
			throw new Error("Isolated test database required");
		pool = new pg.Pool({ connectionString: databaseUrl });
		expect(
			(
				await pool.query<{ current_database: string }>(
					"SELECT current_database()",
				)
			).rows[0]?.current_database,
		).toBe("panini_e2e");
		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[organizationId, `discovery-${organizationId}`, "Discovery E2E"],
		);
		store = new PostgresLedgerStore(
			databaseUrl,
			Buffer.alloc(32, 83).toString("base64"),
			organizationId,
		);
	});
	afterAll(async () => {
		await store?.close();
		await pool?.end();
	});

	it("resumes a bounded source sweep and deduplicates receipt jobs after an interrupted acknowledgment", async () => {
		const ids: string[] = [];

		for (let index = 0; index < 3; index += 1) {
			const event = (
				await store.appendSourceEvent({
					provider: "manual",
					installationKey: "e2e",
					providerEventId: randomUUID(),
					eventKind: "message.observed",
					occurredAt: new Date().toISOString(),
					fetchedAt: new Date().toISOString(),
					sourceRef: `manual:${randomUUID()}`,
					sourceUrl: null,
					contentHash: randomUUID(),
					visibility: "company",
					payloadVersion: "1",
					payload: { text: `Receipt ${index}` },
				})
			).event;

			ids.push(event.id);
		}

		const sweep = new EvidenceDiscoverySweep(store, "evidence-v2-e2e", 2);

		await sweep.schedule("2026-10-01");

		let interrupted = false;
		const seen: string[] = [];
		const dispatcher = new OutboxDispatcher(store, {
			workerId: `e2e:${randomUUID()}`,
			batchSize: 1,
			leaseSeconds: 10,
			pollIntervalMs: 100,
			maxAttempts: 3,
			retryBaseMs: 100,
			retryMaximumMs: 1000,
			handlers: new Map([
				["evidence.source.recorded", async () => {}],
				[
					"evidence.discovery.sweep",
					async (job) => {
						await sweep.handle(job);
						if (!interrupted) {
							interrupted = true;
							throw new Error("Interrupted after enqueue");
						}
					},
				],
				[
					"evidence.source.ready",
					async (job) => {
						const payload = job.payload as { eventId: string };

						seen.push(payload.eventId);
					},
				],
			]),
			log: { info() {}, error() {} },
		});

		for (let i = 0; i < 12; i += 1) {
			await dispatcher.runOnce();
			await new Promise((resolve) => setTimeout(resolve, 110));
		}
		expect(interrupted).toBe(true);
		expect(seen.sort()).toEqual(ids.sort());

		const jobs = await store.listOutboxJobs(20);

		expect(
			jobs.filter((job) => job.topic === "evidence.source.ready"),
		).toHaveLength(3);
		expect(jobs.every((job) => job.state === "completed")).toBe(true);
		expect(
			jobs.filter((job) => job.topic === "evidence.discovery.sweep")
				.length,
		).toBeGreaterThan(1);
		await sweep.schedule("2026-10-01");
		expect((await store.listOutboxJobs(20)).length).toBe(jobs.length);
	}, 30_000);

	it("records a source notification atomically once for a new receipt", async () => {
		const providerEventId = randomUUID();
		const source = {
			provider: "manual",
			installationKey: "e2e",
			providerEventId,
			eventKind: "message.observed",
			occurredAt: new Date().toISOString(),
			fetchedAt: new Date().toISOString(),
			sourceRef: `manual:${providerEventId}`,
			sourceUrl: null,
			contentHash: randomUUID(),
			visibility: "company",
			payloadVersion: "1",
			payload: { text: "A newly observed request" },
		};
		const first = await store.appendSourceEvent(source);
		const duplicate = await store.appendSourceEvent(source);

		expect(first.inserted).toBe(true);
		expect(duplicate.inserted).toBe(false);

		const jobs = (await store.listOutboxJobs(50)).filter(
			(job) =>
				job.topic === "evidence.source.recorded" &&
				(job.payload as { eventId?: string }).eventId ===
					first.event.id,
		);

		expect(jobs).toHaveLength(1);
		expect(jobs[0]).toMatchObject({
			state: "pending",
			payload: { eventId: first.event.id },
		});
	});

	it("recovers an expired outbox lease without accepting the former worker's acknowledgment", async () => {
		const isolatedOrgId = randomUUID();

		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[isolatedOrgId, `lease-${isolatedOrgId}`, "Lease recovery E2E"],
		);

		const isolated = new PostgresLedgerStore(
			databaseUrl!,
			Buffer.alloc(32, 83).toString("base64"),
			isolatedOrgId,
		);

		try {
			const dedupeKey = `evidence:lease:${randomUUID()}`;
			const queued = await isolated.enqueueOutboxJob({
				topic: "evidence.source.ready",
				dedupeKey,
				payload: { marker: dedupeKey },
			});
			const first = await isolated.claimOutboxJobs("worker:former", 1, 1);

			expect(first.map((job) => job.id)).toEqual([queued.id]);
			await pool.query(
				"UPDATE outbox_jobs SET locked_at=now()-interval '2 seconds' WHERE id=$1",
				[queued.id],
			);

			const second = await isolated.claimOutboxJobs(
				"worker:recovered",
				1,
				1,
			);

			expect(second.map((job) => job.id)).toEqual([queued.id]);
			expect(second[0]?.attempts).toBe(2);
			await expect(
				isolated.completeOutboxJob(queued.id, "worker:former"),
			).rejects.toMatchObject({ code: "CONFLICT" });
			expect(
				(
					await isolated.completeOutboxJob(
						queued.id,
						"worker:recovered",
					)
				).state,
			).toBe("completed");
			expect(
				(
					await isolated.enqueueOutboxJob({
						topic: "evidence.source.ready",
						dedupeKey,
						payload: { marker: dedupeKey },
					})
				).id,
			).toBe(queued.id);
			expect(await isolated.listOutboxJobs(10)).toHaveLength(1);
		} finally {
			await isolated.close();
		}
	});

	it("leaves manual task review available after an unrelated connector job fails", async () => {
		const isolatedOrgId = randomUUID();

		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[
				isolatedOrgId,
				`connector-failure-${isolatedOrgId}`,
				"Connector failure E2E",
			],
		);

		const isolated = new PostgresLedgerStore(
			databaseUrl!,
			Buffer.alloc(32, 83).toString("base64"),
			isolatedOrgId,
		);

		try {
			const job = await isolated.enqueueOutboxJob({
				topic: "connector.notion.sync_requested",
				dedupeKey: `notion-failure:${isolatedOrgId}`,
				payload: { reason: "synthetic_failure" },
			});
			const dispatcher = new OutboxDispatcher(isolated, {
				workerId: `e2e:${isolatedOrgId}`,
				batchSize: 1,
				leaseSeconds: 10,
				pollIntervalMs: 100,
				maxAttempts: 1,
				retryBaseMs: 100,
				retryMaximumMs: 1000,
				handlers: new Map([
					[
						"connector.notion.sync_requested",
						async () => {
							throw new Error(
								"synthetic unrelated connector failure",
							);
						},
					],
				]),
				log: { info() {}, error() {} },
			});

			await dispatcher.runOnce();
			expect(
				(await isolated.listOutboxJobs(10)).find(
					(item) => item.id === job.id,
				)?.state,
			).toBe("failed");

			const ledger = new TeamLedger(
				isolated,
				new ProposalPolicy({
					autoApproveNewTasks: false,
					autoApproveContext: false,
					requireReviewForTaskChanges: true,
				}),
			);
			const task = await ledger.createTask(
				{
					clientEventId: randomUUID(),
					title: "Manual repair review",
					status: "in_progress",
				},
				"user:e2e",
			);
			const proposal = await ledger.propose({
				taskId: task.id,
				baseRevision: task.version,
				changes: { status: "blocked" },
				rationale: "Reviewer decision after connector failure",
				requestedBy: "user:e2e",
				evidenceIds: [],
			});

			await ledger.approveProposal(
				proposal.id,
				"user:e2e",
				"Unrelated connector is not required.",
			);
			expect((await ledger.getTask(task.id))?.status).toBe("blocked");
		} finally {
			await isolated.close();
		}
	});

	it("stops unchanged unresolved extraction after three attempts across a store restart", async () => {
		const isolatedOrgId = randomUUID();

		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[isolatedOrgId, `retry-cap-${isolatedOrgId}`, "Retry cap E2E"],
		);

		let scoped = new PostgresLedgerStore(
			databaseUrl!,
			Buffer.alloc(32, 83).toString("base64"),
			isolatedOrgId,
		);
		const pipelineVersion = `retry-cap-${isolatedOrgId}`;
		let extractions = 0;

		try {
			const marker = randomUUID();
			const event = (
				await scoped.appendSourceEvent({
					provider: "manual",
					installationKey: "e2e",
					providerEventId: marker,
					eventKind: "message.observed",
					occurredAt: new Date().toISOString(),
					fetchedAt: new Date().toISOString(),
					sourceRef: `manual:${marker}`,
					sourceUrl: null,
					contentHash: marker,
					visibility: "company",
					payloadVersion: "1",
					payload: { text: "Ambiguous, unresolved source" },
				})
			).event;
			const budget = await scoped.createInferenceBudget({
				label: marker,
				maxCalls: 1,
				maxInputTokens: 1000,
				maxOutputTokens: 500,
				maxUsd: null,
				deadline: new Date(Date.now() + 60_000).toISOString(),
				priceBasis: null,
			});

			const run = async () => {
				const ledger = new TeamLedger(
					scoped,
					new ProposalPolicy({
						autoApproveNewTasks: false,
						autoApproveContext: false,
						requireReviewForTaskChanges: true,
					}),
				);
				const pipeline = new EvidencePipeline({
					store: scoped,
					ledger,
					pipelineVersion,
					extractor: {
						name: "fixture-extractor",
						async extract() {
							extractions += 1;
							return {
								claims: [],
								dispositions: [
									{
										eventId: event.id,
										state: "unresolved" as const,
										claimOrdinals: [],
										reasonCode: "ambiguous_input",
									},
								],
							};
						},
					},
					identityResolver: {
						async resolve() {
							throw new Error("No claim to resolve.");
						},
					},
				});

				return pipeline.run({
					eventIds: [event.id],
					budgetId: budget.id,
					evaluationClock: new Date().toISOString(),
					knowledgeCutoff: null,
				});
			};

			await run();
			expect(
				(
					await scoped.getLatestObservationDisposition(
						event.id,
						pipelineVersion,
					)
				)?.attempt,
			).toBe(1);

			const sweep = (day: string) =>
				new EvidenceDiscoverySweep(
					scoped,
					pipelineVersion,
					10,
					pipelineVersion,
					0,
				).schedule(day);

			const second = await sweep("2026-10-03");

			expect(
				(
					await new EvidenceDiscoverySweep(
						scoped,
						pipelineVersion,
						10,
						pipelineVersion,
						0,
					).handle(second)
				).queuedReceipts,
			).toBe(1);
			await run();
			await scoped.close();
			scoped = new PostgresLedgerStore(
				databaseUrl!,
				Buffer.alloc(32, 83).toString("base64"),
				isolatedOrgId,
			);

			const third = await sweep("2026-10-04");

			expect(
				(
					await new EvidenceDiscoverySweep(
						scoped,
						pipelineVersion,
						10,
						pipelineVersion,
						0,
					).handle(third)
				).queuedReceipts,
			).toBe(1);
			await run();
			expect(
				await scoped.getLatestObservationDisposition(
					event.id,
					pipelineVersion,
				),
			).toMatchObject({
				state: "unresolved",
				attempt: 3,
				retryable: false,
			});

			const fourth = await sweep("2026-10-05");

			expect(
				(
					await new EvidenceDiscoverySweep(
						scoped,
						pipelineVersion,
						10,
						pipelineVersion,
						0,
					).handle(fourth)
				).queuedReceipts,
			).toBe(0);
			expect((await run()).state).toBe("no_evidence");
			expect(extractions).toBe(3);
		} finally {
			await scoped.close();
		}
	});
});
