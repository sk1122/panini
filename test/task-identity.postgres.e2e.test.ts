import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { OpenAITaskIdentityResolver } from "../src/intelligence/task-identity.js";
import { BudgetedWorkEmbeddings } from "../src/intelligence/work-embeddings.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 29).toString("base64");

describe("Scoped task identity with persisted model accounting", () => {
	let store: PostgresLedgerStore;
	let ledger: TeamLedger;
	let pool: pg.Pool;
	const organizationId = randomUUID();

	beforeAll(async () => {
		if (!databaseUrl || !databaseUrl.includes("panini_e2e"))
			throw new Error("Isolated panini_e2e database required");
		pool = new pg.Pool({ connectionString: databaseUrl });
		await pool.query(
			"INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
			[organizationId, `identity-e2e-${organizationId}`, "Identity E2E"],
		);
		store = new PostgresLedgerStore(databaseUrl, key, organizationId);
		ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: false,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);
		expect(
			(
				await pool.query<{ current_database: string }>(
					"SELECT current_database()",
				)
			).rows[0]?.current_database,
		).toBe("panini_e2e");
	});
	afterAll(async () => {
		await store?.close();
		await pool?.end();
	});

	it("identifies an explicit request as new work when the accepted board is empty", async () => {
		const marker = randomUUID();

		expect(await store.listTasks()).toEqual([]);

		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: "Please build a weekly importer health report.",
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 1000,
			maxOutputTokens: 500,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async () => {
				throw new Error("An empty catalog needs no model call.");
			},
		});
		const claim = {
			schemaVersion: 1 as const,
			kind: "request" as const,
			statement: "Please build a weekly importer health report.",
			subjectRefs: [],
			speakerMemberId: null,
			assertedField: null,
			assertedValue: null,
			assertedAt: event.occurredAt,
			validFrom: null,
			validTo: null,
			temporalBasis: "relative_to_source" as const,
			spans: [],
			derivedFromClaimIds: [],
			supersedesClaimIds: [],
			caveats: [],
		};

		expect(
			await resolver.resolve({
				claim,
				events: [event],
				budgetId: budget.id,
				runId: run.id,
			}),
		).toMatchObject({ relationship: "unrelated", targetId: null });
		expect(
			await resolver.resolveMany({
				claims: [claim],
				events: [event],
				budgetId: budget.id,
				runId: run.id,
			}),
		).toMatchObject([{ relationship: "unrelated", targetId: null }]);
		expect(await store.listModelCalls(run.id)).toEqual([]);
	});

	it("keeps a narrow retest distinct from the broader repair despite a strong title match", async () => {
		const marker = randomUUID();
		const task = await ledger.createTask(
			{
				clientEventId: marker,
				title: `Repair causal worker ${marker}`,
				description: "Implement the full causal-worker repair",
				status: "in_progress",
			},
			"user:e2e",
		);
		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: `The bounded causal worker retest is done for ${marker}. The repair remains open.`,
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50000,
			maxOutputTokens: 2000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		let sentCandidates: unknown[] = [];
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as {
					input: string;
				};

				sentCandidates = (
					JSON.parse(request.input) as { candidates: unknown[] }
				).candidates;
				return new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											relationship: "part_of",
											targetId: task.id,
											alternativeTargetIds: [],
											reasons: [
												"The retest is only one step of the full repair.",
											],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 120, output_tokens: 30 },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		const result = await resolver.resolve({
			claim: {
				schemaVersion: 1,
				kind: "completion_report",
				statement: "The bounded causal worker retest is done.",
				subjectRefs: [],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "done",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source",
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			},
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(result).toMatchObject({
			relationship: "part_of",
			targetId: task.id,
		});
		expect(sentCandidates).toEqual(
			expect.arrayContaining([expect.objectContaining({ id: task.id })]),
		);
		expect(await store.listModelCalls(run.id)).toMatchObject([
			{ purpose: "identity", state: "succeeded" },
		]);
	});

	it("considers a small task catalog when a completion report shares no title words", async () => {
		const marker = randomUUID();
		const task = await ledger.createTask(
			{
				clientEventId: marker,
				title: `Launch ingestion pipeline ${marker}`,
				description: "Deliver an end-to-end data path",
				status: "in_progress",
			},
			"user:e2e",
		);
		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: "The intake is finished.",
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50000,
			maxOutputTokens: 2000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		let sawTarget = false;
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as {
					input: string;
				};

				sawTarget = (
					JSON.parse(request.input) as {
						candidates: { id: string }[];
					}
				).candidates.some((candidate) => candidate.id === task.id);
				return new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											relationship: "same_outcome",
											targetId: task.id,
											alternativeTargetIds: [],
											reasons: [],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 120, output_tokens: 30 },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});
		const result = await resolver.resolve({
			claim: {
				schemaVersion: 1,
				kind: "completion_report",
				statement: "The intake is finished.",
				subjectRefs: [],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "done",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source",
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			},
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(sawTarget).toBe(true);
		expect(result.targetId).toBe(task.id);
	});

	it("abstains when the model returns a task outside the supplied candidates", async () => {
		const marker = randomUUID();

		await ledger.createTask(
			{
				clientEventId: `${marker}-task`,
				title: `Verify launch ${marker}`,
				description: "Verify launch",
				status: "in_progress",
			},
			"user:e2e",
		);

		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: "Launch verified.",
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50000,
			maxOutputTokens: 2000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-abstain-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		const invalidId = randomUUID();
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async () =>
				new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											relationship: "same_outcome",
											targetId: invalidId,
											alternativeTargetIds: [],
											reasons: [],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 120, output_tokens: 30 },
					}),
					{ status: 200 },
				),
		});
		const result = await resolver.resolve({
			claim: {
				schemaVersion: 1,
				kind: "completion_report",
				statement: "Launch verified.",
				subjectRefs: [],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "done",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source",
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			},
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(result).toMatchObject({
			relationship: "uncertain",
			targetId: null,
			reasons: ["invalid_model_target"],
		});
	});

	it("keeps malformed identity output as an explicit unresolved decision", async () => {
		const marker = randomUUID();

		await ledger.createTask(
			{
				clientEventId: `${marker}-task`,
				title: `Verify migration ${marker}`,
				description: "Verify migration",
				status: "in_progress",
			},
			"user:e2e",
		);

		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: "Migration verified.",
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50000,
			maxOutputTokens: 2000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-malformed-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async () =>
				new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: "malformed identity result",
									},
								],
							},
						],
						usage: { input_tokens: 120, output_tokens: 30 },
					}),
					{ status: 200 },
				),
		});
		const result = await resolver.resolve({
			claim: {
				schemaVersion: 1,
				kind: "completion_report",
				statement: "Migration verified.",
				subjectRefs: [],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "done",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source",
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			},
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(result).toMatchObject({
			relationship: "uncertain",
			targetId: null,
			reasons: ["invalid_model_output"],
		});
	});

	it("redacts credential-like task context while keeping the candidate available", async () => {
		const marker = randomUUID();
		const sentinel = "secret: abcdefghijklmnopqrstuvwxyz1234";
		const task = await ledger.createTask(
			{
				clientEventId: `${marker}-task`,
				title: `Verify credential rotation ${marker}`,
				description: `Check the rotation. ${sentinel}`,
				status: "in_progress",
			},
			"user:e2e",
		);
		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: "Rotation verified.",
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50000,
			maxOutputTokens: 2000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-redaction-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		let sent = "";
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async (_url, init) => {
				sent = String(init?.body);
				return new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											relationship: "same_outcome",
											targetId: task.id,
											alternativeTargetIds: [],
											reasons: [],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 120, output_tokens: 30 },
					}),
					{ status: 200 },
				);
			},
		});
		const result = await resolver.resolve({
			claim: {
				schemaVersion: 1,
				kind: "completion_report",
				statement: "Rotation verified.",
				subjectRefs: [],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "done",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source",
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			},
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(result.targetId).toBe(task.id);
		expect(sent).not.toContain(sentinel);
		expect(sent).toContain(task.id);
	});

	it("does not send source-private accepted task text to identity resolution", async () => {
		const marker = randomUUID();
		const sentinel = `Private launch forecast ${marker}`;
		const task = await ledger.createTask(
			{
				clientEventId: `${marker}-task`,
				title: sentinel,
				description: sentinel,
				status: "in_progress",
			},
			"user:e2e",
		);
		const privateEvent = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: `${marker}-private`,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C9:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C9",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C9",
					messageTs: marker,
					text: sentinel,
				},
			})
		).event;
		const proposal = await ledger.propose({
			taskId: task.id,
			baseRevision: task.version,
			changes: { status: "blocked" },
			rationale: sentinel,
			requestedBy: "user:e2e",
			evidenceIds: [privateEvent.id],
		});

		await ledger.approveProposal(
			proposal.id,
			"user:e2e",
			"Private source review.",
		);

		const publicEvent = (
			await store.appendSourceEvent({
				provider: "manual",
				installationKey: "test",
				providerEventId: `${marker}-public`,
				eventKind: "source.document.retrieved",
				occurredAt: "2026-10-01T01:00:02.000Z",
				fetchedAt: "2026-10-01T01:00:03.000Z",
				sourceRef: `manual:${marker}`,
				sourceUrl: null,
				contentHash: `${marker}-public`,
				visibility: "company",
				payloadVersion: "test-v1",
				payload: { text: "Launch status changed." },
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 2,
			maxInputTokens: 50000,
			maxOutputTokens: 4000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [publicEvent.id],
			pipelineVersion: "identity-private-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:04.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		const requests: string[] = [];
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["company"],
			allowTaskContextEgress: true,
			fetcher: async (_url, init) => {
				requests.push(String(init?.body));
				return new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											relationship: "uncertain",
											targetId: null,
											alternativeTargetIds: [],
											reasons: ["insufficient_scope"],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 120, output_tokens: 30 },
					}),
					{ status: 200 },
				);
			},
		});
		const claim = {
			schemaVersion: 1 as const,
			kind: "progress_report" as const,
			statement: "Launch status changed.",
			subjectRefs: [],
			speakerMemberId: null,
			assertedField: "status",
			assertedValue: "blocked",
			assertedAt: publicEvent.occurredAt,
			validFrom: null,
			validTo: null,
			temporalBasis: "relative_to_source" as const,
			spans: [],
			derivedFromClaimIds: [],
			supersedesClaimIds: [],
			caveats: [],
		};

		await resolver.resolve({
			claim,
			events: [publicEvent],
			budgetId: budget.id,
			runId: run.id,
		});
		expect(requests.length).toBe(1);
		expect(requests[0]).not.toContain(sentinel);
		expect(requests[0]).not.toContain(task.id);
	});

	it("does not call a hidden-only catalog empty and propose duplicate work", async () => {
		const isolatedId = randomUUID();
		const marker = randomUUID();

		await pool.query(
			"INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
			[
				isolatedId,
				`identity-hidden-${isolatedId}`,
				"Hidden identity E2E",
			],
		);

		const isolatedStore = new PostgresLedgerStore(
			databaseUrl!,
			key,
			isolatedId,
		);

		try {
			const isolatedLedger = new TeamLedger(
				isolatedStore,
				new ProposalPolicy({
					autoApproveNewTasks: false,
					autoApproveContext: false,
					requireReviewForTaskChanges: true,
				}),
			);
			const task = await isolatedLedger.createTask(
				{
					clientEventId: marker,
					title: "Private launch task",
					description: "Private launch task",
					status: "in_progress",
				},
				"user:e2e",
			);
			const source = (
				await isolatedStore.appendSourceEvent({
					provider: "slack",
					installationKey: "T1",
					providerEventId: `${marker}-private`,
					eventKind: "message.observed",
					occurredAt: "2026-10-01T01:00:00.000Z",
					fetchedAt: "2026-10-01T01:00:01.000Z",
					sourceRef: `slack:T1:C9:${marker}`,
					sourceUrl: null,
					contentHash: marker,
					visibility: "slack:channel:C9",
					payloadVersion: "test-v1",
					payload: {
						teamId: "T1",
						channel: "C9",
						messageTs: marker,
						text: "Private launch task",
					},
				})
			).event;
			const proposal = await isolatedLedger.propose({
				taskId: task.id,
				baseRevision: task.version,
				changes: { status: "blocked" },
				rationale: "Private blocker",
				requestedBy: "user:e2e",
				evidenceIds: [source.id],
			});

			await isolatedLedger.approveProposal(
				proposal.id,
				"user:e2e",
				"Private source review.",
			);

			const publicEvent = (
				await isolatedStore.appendSourceEvent({
					provider: "manual",
					installationKey: "test",
					providerEventId: `${marker}-public`,
					eventKind: "source.document.retrieved",
					occurredAt: "2026-10-01T01:00:02.000Z",
					fetchedAt: "2026-10-01T01:00:03.000Z",
					sourceRef: `manual:${marker}`,
					sourceUrl: null,
					contentHash: `${marker}-public`,
					visibility: "company",
					payloadVersion: "test-v1",
					payload: { text: "Please launch task." },
				})
			).event;
			const budget = await isolatedStore.createInferenceBudget({
				label: marker,
				maxCalls: 1,
				maxInputTokens: 1000,
				maxOutputTokens: 500,
				maxUsd: null,
				deadline: new Date(Date.now() + 120_000).toISOString(),
				priceBasis: null,
			});
			const run = await isolatedStore.createV2Run({
				model: "mock-model",
				inputHash: marker,
				eventIds: [publicEvent.id],
				pipelineVersion: "identity-hidden-e2e",
				promptVersion: "v1",
				policyVersion: "v1",
				configHash: marker,
				replayMode: "live",
				evaluationClock: "2026-10-01T01:00:04.000Z",
				knowledgeCutoff: null,
				budgetId: budget.id,
				manifest: {},
			});
			const resolver = new OpenAITaskIdentityResolver({
				store: isolatedStore,
				apiKey: "mock-key",
				model: "mock-model",
				allowedVisibilities: ["company"],
				allowTaskContextEgress: true,
				fetcher: async () => {
					throw new Error(
						"A hidden-only catalog requires no model call.",
					);
				},
			});
			const claim = {
				schemaVersion: 1 as const,
				kind: "request" as const,
				statement: "Please launch task.",
				subjectRefs: [],
				speakerMemberId: null,
				assertedField: null,
				assertedValue: null,
				assertedAt: publicEvent.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source" as const,
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			};

			expect(
				await resolver.resolve({
					claim,
					events: [publicEvent],
					budgetId: budget.id,
					runId: run.id,
				}),
			).toMatchObject({ relationship: "uncertain", targetId: null });
			expect(await isolatedStore.listModelCalls(run.id)).toEqual([]);
		} finally {
			await isolatedStore.close();
		}
	});

	it("resolves several completion reports with one budgeted identity request", async () => {
		const marker = randomUUID();
		const task = await ledger.createTask(
			{
				clientEventId: `${marker}-task`,
				title: `Ship importer ${marker}`,
				description: "Ship the importer",
				status: "in_progress",
			},
			"user:e2e",
		);
		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "slack:channel:C1",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: "The importer shipped. The monitor shipped.",
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50000,
			maxOutputTokens: 5000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-batch-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		let calls = 0;
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["slack:channel:C1"],
			allowTaskContextEgress: true,
			fetcher: async () => {
				calls += 1;
				return new Response(
					JSON.stringify({
						id: `response-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											results: [
												{
													claimIndex: 0,
													relationship:
														"same_outcome",
													targetId: task.id,
													alternativeTargetIds: [],
													reasons: [],
												},
												{
													claimIndex: 1,
													relationship: "part_of",
													targetId: task.id,
													alternativeTargetIds: [],
													reasons: ["narrow_monitor"],
												},
											],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 500, output_tokens: 100 },
					}),
					{ status: 200 },
				);
			},
		});

		const claim = (statement: string) => ({
			schemaVersion: 1 as const,
			kind: "completion_report" as const,
			statement,
			subjectRefs: [],
			speakerMemberId: null,
			assertedField: "status",
			assertedValue: "done",
			assertedAt: event.occurredAt,
			validFrom: null,
			validTo: null,
			temporalBasis: "relative_to_source" as const,
			spans: [],
			derivedFromClaimIds: [],
			supersedesClaimIds: [],
			caveats: [],
		});

		const result = await resolver.resolveMany({
			claims: [
				claim("The importer shipped."),
				claim("The monitor shipped."),
			],
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(result).toMatchObject([
			{ relationship: "same_outcome", targetId: task.id },
			{ relationship: "part_of", targetId: task.id },
		]);
		expect(calls).toBe(1);
		expect(await store.listModelCalls(run.id)).toHaveLength(1);
	});

	it("keeps a large lexical catalog reviewable when semantic retrieval is unavailable", async () => {
		const isolatedId = randomUUID();

		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[
				isolatedId,
				`identity-lexical-${isolatedId}`,
				"Identity lexical E2E",
			],
		);

		const scoped = new PostgresLedgerStore(databaseUrl!, key, isolatedId);
		const scopedLedger = new TeamLedger(
			scoped,
			new ProposalPolicy({
				autoApproveNewTasks: false,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);

		try {
			const marker = randomUUID();

			for (let index = 0; index < 40; index += 1) {
				await scopedLedger.createTask(
					{
						clientEventId: `${marker}:${index}`,
						title: `Unrelated catalog item ${index}`,
						description: "A separate activity",
						status: "in_progress",
					},
					"user:e2e",
				);
			}

			const target = await scopedLedger.createTask(
				{
					clientEventId: `${marker}:target`,
					title: "Lighthouse exporter repair",
					description: "Repair the lighthouse exporter",
					status: "in_progress",
				},
				"user:e2e",
			);
			const now = new Date().toISOString();
			const event = (
				await scoped.appendSourceEvent({
					provider: "slack",
					installationKey: "T1",
					providerEventId: marker,
					eventKind: "message.observed",
					occurredAt: now,
					fetchedAt: now,
					sourceRef: `slack:T1:C1:${marker}`,
					sourceUrl: null,
					contentHash: marker,
					visibility: "company",
					payloadVersion: "test-v1",
					payload: {
						teamId: "T1",
						channel: "C1",
						messageTs: marker,
						text: "The lighthouse exporter repair is blocked.",
					},
				})
			).event;
			const budget = await scoped.createInferenceBudget({
				label: marker,
				maxCalls: 1,
				maxInputTokens: 50000,
				maxOutputTokens: 2000,
				maxUsd: null,
				deadline: new Date(Date.now() + 120000).toISOString(),
				priceBasis: null,
			});
			const run = await scoped.createV2Run({
				model: "mock-model",
				inputHash: marker,
				eventIds: [event.id],
				pipelineVersion: "identity-lexical-e2e",
				promptVersion: "v1",
				policyVersion: "v1",
				configHash: marker,
				replayMode: "live",
				evaluationClock: now,
				knowledgeCutoff: null,
				budgetId: budget.id,
				manifest: {},
			});
			let sawTarget = false;
			const resolver = new OpenAITaskIdentityResolver({
				store: scoped,
				apiKey: "mock-key",
				model: "mock-model",
				allowedVisibilities: ["company"],
				allowTaskContextEgress: true,
				fetcher: async (_url, init) => {
					const request = JSON.parse(String(init?.body)) as {
						input: string;
					};
					const candidates = (
						JSON.parse(request.input) as {
							candidates: { id: string }[];
						}
					).candidates;

					sawTarget = candidates.some(
						(candidate) => candidate.id === target.id,
					);
					return new Response(
						JSON.stringify({
							id: `identity-${marker}`,
							model: "mock-model",
							status: "completed",
							output: [
								{
									type: "message",
									content: [
										{
											type: "output_text",
											text: JSON.stringify({
												relationship: "same_outcome",
												targetId: target.id,
												alternativeTargetIds: [],
												reasons: [],
											}),
										},
									],
								},
							],
							usage: { input_tokens: 100, output_tokens: 20 },
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				},
			});
			const result = await resolver.resolve({
				claim: {
					schemaVersion: 1,
					kind: "progress_report",
					statement: "The lighthouse exporter repair is blocked.",
					subjectRefs: [],
					speakerMemberId: null,
					assertedField: "status",
					assertedValue: "blocked",
					assertedAt: now,
					validFrom: null,
					validTo: null,
					temporalBasis: "relative_to_source",
					spans: [],
					derivedFromClaimIds: [],
					supersedesClaimIds: [],
					caveats: [],
				},
				events: [event],
				budgetId: budget.id,
				runId: run.id,
			});

			expect(sawTarget).toBe(true);
			expect(result).toMatchObject({
				relationship: "same_outcome",
				targetId: target.id,
			});
			expect(result.reasons).toContain("semantic_retrieval_disabled");
			expect(await scoped.listModelCalls(run.id)).toMatchObject([
				{ purpose: "identity", state: "succeeded" },
			]);
		} finally {
			await scoped.close();
		}
	});

	it("retains an exact ID beyond 100 tasks and reuses only unchanged embeddings after restart", async () => {
		const isolatedId = randomUUID();

		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[isolatedId, `identity-cache-${isolatedId}`, "Identity cache E2E"],
		);

		let scoped = new PostgresLedgerStore(databaseUrl!, key, isolatedId);
		let scopedLedger = new TeamLedger(
			scoped,
			new ProposalPolicy({
				autoApproveNewTasks: false,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);

		try {
			const marker = randomUUID();
			const tasks = [];

			for (let index = 0; index < 105; index += 1) {
				tasks.push(
					await scopedLedger.createTask(
						{
							clientEventId: `${marker}:${index}`,
							title: `Catalog item ${index} ${marker.slice(0, 8)}`,
							description: `Independent scope number ${index}`,
							status: "in_progress",
						},
						"user:e2e",
					),
				);
			}

			const target = tasks.at(-1)!;
			const event = (
				await scoped.appendSourceEvent({
					provider: "slack",
					installationKey: "T1",
					providerEventId: marker,
					eventKind: "message.observed",
					occurredAt: new Date().toISOString(),
					fetchedAt: new Date().toISOString(),
					sourceRef: `slack:T1:C1:${marker}`,
					sourceUrl: null,
					contentHash: marker,
					visibility: "company",
					payloadVersion: "test-v1",
					payload: {
						teamId: "T1",
						channel: "C1",
						messageTs: marker,
						text: "The referenced task is blocked.",
					},
				})
			).event;
			const budget = await scoped.createInferenceBudget({
				label: marker,
				maxCalls: 40,
				maxInputTokens: 2_000_000,
				maxOutputTokens: 20_000,
				maxUsd: null,
				deadline: new Date(Date.now() + 120_000).toISOString(),
				priceBasis: null,
			});
			const claim = {
				schemaVersion: 1 as const,
				kind: "progress_report" as const,
				statement: "The referenced task is blocked.",
				subjectRefs: [target.id],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "blocked",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source" as const,
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			};
			const embeddingBatchSizes: number[] = [];
			let sawTarget = 0;

			const resolve = async (step: string) => {
				const run = await scoped.createV2Run({
					model: "mock-model",
					inputHash: `${marker}:${step}`,
					eventIds: [event.id],
					pipelineVersion: `identity-cache-${marker}`,
					promptVersion: "v1",
					policyVersion: "v1",
					configHash: marker,
					replayMode: "live",
					evaluationClock: new Date().toISOString(),
					knowledgeCutoff: null,
					budgetId: budget.id,
					manifest: {},
				});
				const embeddings = new BudgetedWorkEmbeddings({
					store: scoped,
					apiKey: "mock-key",
					fetcher: async (_url, init) => {
						const request = JSON.parse(String(init?.body)) as {
							input: string[];
						};

						embeddingBatchSizes.push(request.input.length);
						return new Response(
							JSON.stringify({
								model: "text-embedding-3-small",
								data: request.input.map((_text, index) => ({
									index,
									embedding: Array.from(
										{ length: 256 },
										(_, dimension) =>
											dimension === 0 ? 1 : 0,
									),
								})),
								usage: {
									prompt_tokens: 100,
									total_tokens: 100,
								},
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					},
				});
				const resolver = new OpenAITaskIdentityResolver({
					store: scoped,
					apiKey: "mock-key",
					model: "mock-model",
					allowedVisibilities: ["company"],
					allowTaskContextEgress: true,
					embeddings,
					fetcher: async (_url, init) => {
						const request = JSON.parse(String(init?.body)) as {
							input: string;
						};
						const candidates = (
							JSON.parse(request.input) as {
								candidates: { id: string }[];
							}
						).candidates;

						if (
							candidates.some(
								(candidate) => candidate.id === target.id,
							)
						)
							sawTarget += 1;
						return new Response(
							JSON.stringify({
								id: `identity-${step}`,
								model: "mock-model",
								status: "completed",
								output: [
									{
										type: "message",
										content: [
											{
												type: "output_text",
												text: JSON.stringify({
													relationship:
														"same_outcome",
													targetId: target.id,
													alternativeTargetIds: [],
													reasons: [
														"explicit_subject",
													],
												}),
											},
										],
									},
								],
								usage: { input_tokens: 100, output_tokens: 20 },
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						);
					},
				});

				expect(
					await resolver.resolve({
						claim,
						events: [event],
						budgetId: budget.id,
						runId: run.id,
					}),
				).toMatchObject({
					relationship: "same_outcome",
					targetId: target.id,
				});
			};

			await resolve("initial");
			expect(
				embeddingBatchSizes.reduce((sum, count) => sum + count, 0),
			).toBe(106);
			await scoped.close();
			scoped = new PostgresLedgerStore(databaseUrl!, key, isolatedId);
			scopedLedger = new TeamLedger(
				scoped,
				new ProposalPolicy({
					autoApproveNewTasks: false,
					autoApproveContext: false,
					requireReviewForTaskChanges: true,
				}),
			);
			embeddingBatchSizes.length = 0;
			await resolve("after-restart");
			expect(embeddingBatchSizes).toEqual([1]);

			const statusProposal = await scopedLedger.propose({
				taskId: target.id,
				baseRevision: target.version,
				changes: { status: "review" },
				rationale: "Status-only update",
				requestedBy: "user:e2e",
				evidenceIds: [],
			});

			await scopedLedger.approveProposal(
				statusProposal.id,
				"user:e2e",
				"Reviewed status.",
			);
			embeddingBatchSizes.length = 0;
			await resolve("status-only");
			expect(embeddingBatchSizes).toEqual([1]);

			const updated = await scopedLedger.getTask(target.id);
			const descriptionProposal = await scopedLedger.propose({
				taskId: target.id,
				baseRevision: updated!.version,
				changes: { description: "Changed identity-relevant scope" },
				rationale: "Scope correction",
				requestedBy: "user:e2e",
				evidenceIds: [],
			});

			await scopedLedger.approveProposal(
				descriptionProposal.id,
				"user:e2e",
				"Reviewed scope.",
			);
			embeddingBatchSizes.length = 0;
			await resolve("scope-change");
			expect(embeddingBatchSizes.sort((a, b) => a - b)).toEqual([1, 1]);
			expect(sawTarget).toBe(4);
		} finally {
			await scoped.close();
		}
	});

	it("resolves an explicit artifact ID after the accepted task is renamed", async () => {
		const marker = randomUUID();
		const externalRef = `ARTIFACT-${marker.slice(0, 8).toUpperCase()}`;
		const creation = await ledger.proposeTaskCreation({
			externalRef,
			title: `Old logger title ${marker}`,
			description: "Repair the logger artifact",
			status: "in_progress",
			rationale: "Imported artifact",
			requestedBy: "user:e2e",
			evidenceIds: [],
		});
		const created = await ledger.approveProposal(
			creation.id,
			"user:e2e",
			"Confirmed artifact.",
		);

		if (!("version" in created)) throw new Error("Expected a task");

		const rename = await ledger.propose({
			taskId: created.id,
			baseRevision: created.version,
			changes: { title: `Renamed observability work ${marker}` },
			rationale: "Accepted rename",
			requestedBy: "user:e2e",
			evidenceIds: [],
		});

		await ledger.approveProposal(
			rename.id,
			"user:e2e",
			"Confirmed rename.",
		);

		const event = (
			await store.appendSourceEvent({
				provider: "slack",
				installationKey: "T1",
				providerEventId: marker,
				eventKind: "message.observed",
				occurredAt: "2026-10-01T01:00:00.000Z",
				fetchedAt: "2026-10-01T01:00:01.000Z",
				sourceRef: `slack:T1:C1:${marker}`,
				sourceUrl: null,
				contentHash: marker,
				visibility: "company",
				payloadVersion: "test-v1",
				payload: {
					teamId: "T1",
					channel: "C1",
					messageTs: marker,
					text: `${externalRef} now passes its logger verification.`,
				},
			})
		).event;
		const budget = await store.createInferenceBudget({
			label: marker,
			maxCalls: 1,
			maxInputTokens: 50_000,
			maxOutputTokens: 2_000,
			maxUsd: null,
			deadline: new Date(Date.now() + 120_000).toISOString(),
			priceBasis: null,
		});
		const run = await store.createV2Run({
			model: "mock-model",
			inputHash: marker,
			eventIds: [event.id],
			pipelineVersion: "identity-rename-e2e",
			promptVersion: "v1",
			policyVersion: "v1",
			configHash: marker,
			replayMode: "live",
			evaluationClock: "2026-10-01T01:00:02.000Z",
			knowledgeCutoff: null,
			budgetId: budget.id,
			manifest: {},
		});
		let candidates: {
			id: string;
			title: string;
			externalRef: string | null;
		}[] = [];
		const resolver = new OpenAITaskIdentityResolver({
			store,
			apiKey: "mock-key",
			model: "mock-model",
			allowedVisibilities: ["company"],
			allowTaskContextEgress: true,
			fetcher: async (_url, init) => {
				const request = JSON.parse(String(init?.body)) as {
					input: string;
				};

				candidates = (
					JSON.parse(request.input) as {
						candidates: typeof candidates;
					}
				).candidates;
				return new Response(
					JSON.stringify({
						id: `identity-${marker}`,
						model: "mock-model",
						status: "completed",
						output: [
							{
								type: "message",
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											relationship: "same_outcome",
											targetId: created.id,
											alternativeTargetIds: [],
											reasons: ["explicit_artifact_id"],
										}),
									},
								],
							},
						],
						usage: { input_tokens: 100, output_tokens: 20 },
					}),
					{ status: 200 },
				);
			},
		});
		const result = await resolver.resolve({
			claim: {
				schemaVersion: 1,
				kind: "completion_report",
				statement: `${externalRef} now passes its logger verification.`,
				subjectRefs: [externalRef],
				speakerMemberId: null,
				assertedField: "status",
				assertedValue: "done",
				assertedAt: event.occurredAt,
				validFrom: null,
				validTo: null,
				temporalBasis: "relative_to_source",
				spans: [],
				derivedFromClaimIds: [],
				supersedesClaimIds: [],
				caveats: [],
			},
			events: [event],
			budgetId: budget.id,
			runId: run.id,
		});

		expect(result).toMatchObject({
			relationship: "same_outcome",
			targetId: created.id,
		});
		expect(candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: created.id,
					externalRef,
					title: `Renamed observability work ${marker}`,
				}),
			]),
		);
		expect(
			(await store.listTasks()).filter(
				(task) => task.externalRef === externalRef,
			),
		).toHaveLength(1);
	});
});
