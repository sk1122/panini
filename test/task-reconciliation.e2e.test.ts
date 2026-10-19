import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { SourceEventInput } from "../src/domain/types.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { JevObservationRouter } from "../src/intelligence/jev-router.js";
import { EmbeddingObservationEpisodeGrouper } from "../src/intelligence/observation-episodes.js";
import type {
	EvidenceInterpreter,
	IntelligenceConfig,
	InterpretationFinding,
} from "../src/intelligence/types.js";
import type { EmbeddingAdapter } from "../src/retrieval/embedding-adapter.js";
import { EmbeddingJevWorkEntityRetriever } from "../src/retrieval/work-entity-retriever.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const config: IntelligenceConfig = {
	enabled: true,
	mode: "manual",
	intervalSeconds: 900,
	maxEventsPerRun: 50,
	maxEvidenceCharacters: 60_000,
	maxSourceDocumentCharacters: 320_000,
	maxContextCharacters: 30_000,
	minimumConfidence: 0.7,
	completionMinimumConfidence: 0.85,
	completionMinimumEvidenceItems: 2,
	completionEvidenceProviders: ["slack"],
	sourceProviders: ["slack", "github"],
};

function slack(
	id: string,
	text: string,
	at: string,
	threadTs: string,
): SourceEventInput {
	return {
		provider: "slack",
		installationKey: "workspace",
		providerEventId: id,
		eventKind: "message.observed",
		occurredAt: at,
		fetchedAt: at,
		sourceRef: `slack:T1:C1:${id}`,
		sourceUrl: null,
		contentHash: id,
		visibility: "company",
		payloadVersion: "e2e",
		payload: {
			teamId: "T1",
			channel: "C1",
			messageTs: id,
			threadTs,
			messageUserId: "same-author",
			text,
		},
	};
}

function commit(id: string, message: string, at: string): SourceEventInput {
	return {
		provider: "github",
		installationKey: "repo",
		providerEventId: id,
		eventKind: "commit.snapshot",
		occurredAt: at,
		fetchedAt: at,
		sourceRef: `github:1:commit.snapshot:${id}`,
		sourceUrl: null,
		contentHash: id,
		visibility: "company",
		payloadVersion: "e2e",
		payload: {
			repositoryId: 1,
			repository: "example/sozu",
			sha: id,
			message,
			text: message,
		},
	};
}

function finding(
	task: {
		id: string;
		title: string;
		description: string;
		status: string;
		priority: string;
	},
	evidenceEventIds: string[],
): InterpretationFinding {
	return {
		kind: "task_change",
		taskId: task.id,
		title: task.title,
		description: task.description,
		status: "done",
		priority: "high",
		owner: null,
		project: null,
		dueDate: null,
		dependencyRefs: [],
		contextPath: null,
		contextTitle: null,
		contextBody: null,
		contextFactType: null,
		contextFactValue: null,
		rationale: "The linked request and completion support delivery.",
		confidence: 0.95,
		evidenceEventIds,
		caveats: [],
	};
}

function system(
	interpreter: EvidenceInterpreter,
	onWorkQuery?: (query: string) => void,
) {
	const store = new MemoryLedgerStore();
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			autoApproveNewTasks: true,
			autoApproveContext: true,
			requireReviewForTaskChanges: true,
		}),
	);
	const embedding: EmbeddingAdapter = {
		model: "e2e-embedding",
		async embed(texts) {
			return texts.map(() => [1, 0]);
		},
		async embedDocuments(texts) {
			return texts.map(() => [1, 0]);
		},
		async embedQuery() {
			return [1, 0];
		},
	};
	const jev = (async (url: string | URL | Request, init?: RequestInit) => {
		const body = JSON.parse(String(init?.body)) as {
			model: string;
			state: {
				observations?: Array<{ text: string }>;
				query?: string;
				candidate?: { text: string };
			};
		};

		expect(String(url)).toBe("https://openrouter.ai/api/alpha/decisions");
		expect(new Headers(init?.headers).get("authorization")).toBe(
			"Bearer e2e",
		);
		expect(body.model).toBe("typesafe/jev-1.13");
		if (body.state.observations) {
			const answers = Object.fromEntries(
				body.state.observations.map((item, index) => [
					`observation_${index}`,
					{
						type: "choice",
						choice: /irrelevant chatter/i.test(item.text)
							? "neither"
							: /retest|marketless|causal|standup/i.test(
										item.text,
								  )
								? "task"
								: "information",
						confidence: 0.9,
					},
				]),
			);

			return new Response(
				JSON.stringify({
					model: "typesafe/jev-1.13-20260917",
					answers,
				}),
			);
		}

		const query = body.state.query ?? "";

		onWorkQuery?.(query);

		const candidate = body.state.candidate?.text ?? "";
		const relevant =
			/retest/i.test(query) && /retest/i.test(candidate)
				? 0.98
				: /marketless/i.test(query) && /marketless/i.test(candidate)
					? 0.97
					: 0.1;

		return new Response(
			JSON.stringify({
				model: "typesafe/jev-1.13-20260917",
				answers: { relevant: { type: "noul", noul: relevant } },
			}),
		);
	}) as typeof fetch;
	const intelligence = new EvidenceIntelligence({
		store,
		ledger,
		interpreter,
		router: new JevObservationRouter({
			apiKey: "e2e",
			allowedVisibilities: ["company"],
			fetcher: jev,
		}),
		episodeGrouper: new EmbeddingObservationEpisodeGrouper(embedding, [
			"company",
		]),
		entityRetriever: new EmbeddingJevWorkEntityRetriever({
			apiKey: "e2e",
			embedding,
			fetcher: jev,
		}),
		companyName: "Sozu E2E",
		config,
		log: { info() {}, error() {} },
	});

	return { store, ledger, intelligence };
}

describe("source-to-task reconciliation E2E", () => {
	it("keeps a Task update from an information route when Jev confirms the exact outcome", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const task = await ledger.createTask(
			{
				title: "Integrate Polymarket and Kalshi markets",
				description: "Integrate both markets.",
				status: "planned",
				priority: "high",
			},
			"user:e2e",
		);
		const intelligence = new EvidenceIntelligence({
			store,
			ledger,
			companyName: "Sozu E2E",
			config,
			log: { info() {}, error() {} },
			router: {
				name: "jev-e2e",
				async route(events) {
					return events.map((event) => ({
						eventId: event.id,
						route: "information" as const,
						confidence: 0.98,
					}));
				},
			},
			workJudge: {
				async judgeTaskStatus() {
					return {
						model: "jev-e2e",
						directMatchProbability: 0.98,
						statusSupportProbability: 0.97,
						completionSupportProbability: 0.1,
						status: {
							type: "choice" as const,
							choice: "in_progress" as const,
							confidence: 0.97,
							probabilities: {
								planned: 0,
								in_progress: 0.97,
								blocked: 0,
								review: 0,
								done: 0,
								unchanged: 0,
								uncertain: 0.03,
							},
						},
					};
				},
			},
			interpreter: {
				name: "e2e-info-work",
				async interpret(input) {
					return {
						summary: "Partial integration",
						findings: [
							{
								...finding(
									task,
									input.events.map((event) => event.id),
								),
								status: "in_progress",
								description:
									"Polymarket is integrated; Kalshi remains open.",
							},
						],
					};
				},
			},
		});

		await intelligence.record(
			slack(
				"poly.1",
				"polymarket is integrated",
				"2026-09-20T10:00:00.000Z",
				"poly.1",
			),
		);

		const result = await intelligence.run();

		expect(result.outcomes).toMatchObject([{ state: "applied" }]);
		expect(await ledger.getTask(task.id)).toMatchObject({
			status: "in_progress",
		});
	});

	it("creates an actionable Task from an information route only when Jev confirms outstanding work", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const intelligence = new EvidenceIntelligence({
			store,
			ledger,
			companyName: "Sozu E2E",
			config,
			log: { info() {}, error() {} },
			router: {
				name: "jev-e2e",
				async route(events) {
					return events.map((event) => ({
						eventId: event.id,
						route: "information" as const,
						confidence: 0.55,
					}));
				},
			},
			workClaimJudge: {
				async judge() {
					return {
						kind: {
							type: "choice" as const,
							choice: "task_action" as const,
							confidence: 0.96,
							probabilities: {
								task_action: 0.96,
								project_outcome: 0,
								activity_only: 0,
								unrelated: 0,
								uncertain: 0.04,
							},
						},
						concreteActionProbability: 0.96,
					};
				},
			},
			interpreter: {
				name: "e2e-info-create",
				async interpret(input) {
					return {
						summary: "Calibration underway",
						findings: [
							{
								kind: "task_create",
								taskId: null,
								title: "Calibrate evidence generation",
								description: "Run more calibration tests.",
								status: "in_progress",
								priority: "high",
								owner: null,
								project: null,
								dueDate: null,
								dependencyRefs: [],
								contextPath: null,
								contextTitle: null,
								contextBody: null,
								contextFactType: null,
								contextFactValue: null,
								rationale: "Calibration is underway.",
								confidence: 0.95,
								evidenceEventIds: input.events.map(
									(event) => event.id,
								),
								caveats: [],
							},
						],
					};
				},
			},
		});

		await intelligence.record(
			slack(
				"cal.1",
				"calibrating and running more tests",
				"2026-09-20T10:00:00.000Z",
				"cal.1",
			),
		);
		expect((await intelligence.run()).outcomes).toMatchObject([
			{ state: "applied" },
		]);
		expect((await ledger.workGraph()).tasks).toMatchObject([
			{ title: "Calibrate evidence generation" },
		]);
	});

	it("rejects a shared-word memory mismatch even when the interpreter proposes a Task update", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const task = await ledger.createTask(
			{
				title: "Merge memory into the system",
				description: "Integrate the memory subsystem.",
				status: "planned",
				priority: "high",
			},
			"user:e2e",
		);
		const intelligence = new EvidenceIntelligence({
			store,
			ledger,
			companyName: "Sozu E2E",
			config,
			log: { info() {}, error() {} },
			workJudge: {
				async judgeTaskStatus() {
					return {
						model: "jev-e2e",
						directMatchProbability: 0.03,
						statusSupportProbability: 0.1,
						completionSupportProbability: 0,
						status: {
							type: "choice" as const,
							choice: "uncertain" as const,
							confidence: 0.9,
							probabilities: {
								planned: 0,
								in_progress: 0,
								blocked: 0,
								review: 0,
								done: 0,
								unchanged: 0.1,
								uncertain: 0.9,
							},
						},
					};
				},
			},
			interpreter: {
				name: "e2e-memory-mismatch",
				async interpret(input) {
					return {
						summary: "Heap issue",
						findings: [
							{
								...finding(
									task,
									input.events.map((event) => event.id),
								),
								status: "blocked",
								description: "Node heap is too small.",
							},
						],
					};
				},
			},
		});

		await intelligence.record(
			slack(
				"heap.1",
				"bump memory; node --max-old-space-size=3072",
				"2026-06-28T10:00:00.000Z",
				"heap.1",
			),
		);

		const result = await intelligence.run();

		expect(result.outcomes).toMatchObject([{ state: "rejected" }]);
		expect(await ledger.getTask(task.id)).toMatchObject({
			status: "planned",
		});
	});

	it("does not let an older source event reverse a newer accepted Task status", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const task = await ledger.createTask(
			{
				title: "Run causal-worker retest",
				description: "Run the clean retest.",
				status: "planned",
				priority: "high",
			},
			"user:e2e",
		);
		const intelligence = new EvidenceIntelligence({
			store,
			ledger,
			companyName: "Sozu E2E",
			config,
			log: { info() {}, error() {} },
			interpreter: {
				name: "e2e-chronology",
				async interpret(input) {
					const older = input.events.some((event) =>
						event.payloadExcerpt.includes("earlier blocker"),
					);

					return {
						summary: "Retest state",
						findings: [
							{
								...finding(
									task,
									input.events.map((event) => event.id),
								),
								status: older ? "blocked" : "in_progress",
								description: older
									? "Earlier blocker."
									: "Retest underway.",
							},
						],
					};
				},
			},
		});
		const newer = await intelligence.record(
			slack(
				"new.1",
				"retest underway",
				"2026-09-20T10:00:00.000Z",
				"new.1",
			),
		);
		const older = await intelligence.record(
			slack(
				"old.1",
				"earlier blocker",
				"2026-09-10T10:00:00.000Z",
				"old.1",
			),
		);

		expect(
			(await intelligence.run({ eventIds: [newer.event.id] })).outcomes,
		).toMatchObject([{ state: "applied" }]);
		expect(
			(await intelligence.run({ eventIds: [older.event.id] })).outcomes,
		).toMatchObject([{ state: "abstained" }]);
		expect(await ledger.getTask(task.id)).toMatchObject({
			status: "in_progress",
			description: "Retest underway.",
		});
	});
	it("rejects a meeting-attendance Task even when Jev and the interpreter call it work", async () => {
		const { intelligence, ledger } = system({
			name: "e2e-transient-task-interpreter",
			async interpret(input) {
				return {
					summary: "A standup attendance request was observed.",
					findings: [
						{
							kind: "task_create",
							taskId: null,
							title: "Join standup",
							description:
								"Join the standup meeting as requested by the Slack message.",
							status: "planned",
							priority: "medium",
							owner: null,
							project: null,
							dueDate: null,
							dependencyRefs: [],
							contextPath: null,
							contextTitle: null,
							contextBody: null,
							contextFactType: null,
							contextFactValue: null,
							rationale:
								"The message directly asks two people to join standup.",
							confidence: 0.95,
							evidenceEventIds: input.events.map(
								(event) => event.id,
							),
							caveats: [],
						},
					],
				};
			},
		});

		await intelligence.record(
			slack(
				"5200.000",
				"<@U1> <@U2> join standup",
				"2026-07-03T10:57:43.265Z",
				"5200.000",
			),
		);

		const report = await intelligence.run();

		expect(report.outcomes).toMatchObject([
			{ kind: "task_create", state: "rejected" },
		]);
		expect((await ledger.workGraph()).tasks).toHaveLength(0);
	});

	it("keeps a standup-related deliverable as a real Task", async () => {
		const { intelligence, ledger } = system({
			name: "e2e-standup-deliverable-interpreter",
			async interpret(input) {
				return {
					summary: "A concrete standup deliverable is requested.",
					findings: [
						{
							kind: "task_create",
							taskId: null,
							title: "Publish standup action items",
							description:
								"Prepare standup notes and publish the resulting action items.",
							status: "planned",
							priority: "medium",
							owner: null,
							project: null,
							dueDate: null,
							dependencyRefs: [],
							contextPath: null,
							contextTitle: null,
							contextBody: null,
							contextFactType: null,
							contextFactValue: null,
							rationale:
								"The message specifies a publishable work product.",
							confidence: 0.95,
							evidenceEventIds: input.events.map(
								(event) => event.id,
							),
							caveats: [],
						},
					],
				};
			},
		});

		await intelligence.record(
			slack(
				"5201.000",
				"<@U1> prepare standup notes and publish action items",
				"2026-07-03T11:00:00.000Z",
				"5201.000",
			),
		);

		const report = await intelligence.run();

		expect(report.outcomes).toMatchObject([
			{ kind: "task_create", state: "applied" },
		]);
		expect((await ledger.workGraph()).tasks).toMatchObject([
			{ title: "Publish standup action items" },
		]);
	});

	it("consumes neither routes alongside information without sending them to the interpreter", async () => {
		const seen: string[][] = [];
		const { intelligence, store } = system({
			name: "e2e-neither-batch-interpreter",
			async interpret(input) {
				seen.push(input.events.map((event) => event.payloadExcerpt));
				return {
					summary: "No accepted change is established.",
					findings: [],
				};
			},
		});
		const receipts = await Promise.all(
			[
				slack(
					"5100.000",
					"irrelevant chatter about lunch",
					"2026-09-20T11:00:00.000Z",
					"5100.000",
				),
				slack(
					"5101.000",
					"office wifi uses guest access",
					"2026-09-20T11:01:00.000Z",
					"5101.000",
				),
				slack(
					"5102.000",
					"irrelevant chatter about weather",
					"2026-09-20T11:02:00.000Z",
					"5102.000",
				),
				slack(
					"5103.000",
					"implement marketless confirmation flow",
					"2026-09-20T11:03:00.000Z",
					"5103.000",
				),
			].map((event) => intelligence.record(event)),
		);

		const first = await intelligence.run();
		const second = await intelligence.run();

		expect(first.eventIds).toEqual(
			receipts.slice(0, 3).map(({ event }) => event.id),
		);
		expect(second.eventIds).toEqual([receipts[3]!.event.id]);
		expect(seen).toHaveLength(2);
		expect(seen[0]).toHaveLength(1);
		expect(seen[0]?.[0]).toContain("office wifi uses guest access");
		expect(
			await store.listUninterpretedSourceEvents(
				["slack"],
				10,
				"e2e-neither-batch-interpreter",
			),
		).toHaveLength(0);
	});

	it("batches unrelated information without merging later work episodes", async () => {
		const seen: string[][] = [];
		const { intelligence, store } = system({
			name: "e2e-information-batch-interpreter",
			async interpret(input) {
				seen.push(input.events.map((event) => event.payloadExcerpt));
				if (seen.length === 1) expect(input.tasks).toHaveLength(0);
				return {
					summary: "No accepted change is established.",
					findings: [],
				};
			},
		});
		const information = [
			slack(
				"5000.000",
				"holiday calendar is published",
				"2026-09-20T10:00:00.000Z",
				"5000.000",
			),
			slack(
				"5001.000",
				"office wifi uses guest access",
				"2026-09-20T10:01:00.000Z",
				"5001.000",
			),
		];
		const work = [
			slack(
				"5003.000",
				"implement marketless confirmation flow",
				"2026-09-20T10:03:00.000Z",
				"5003.000",
			),
			slack(
				"5004.000",
				"run clean causal-worker retest",
				"2026-09-20T10:04:00.000Z",
				"5004.000",
			),
		];
		const receipts = await Promise.all(
			[...information, ...work].map((event) =>
				intelligence.record(event),
			),
		);

		expect(
			await store.listUninterpretedSourceEvents(
				["slack"],
				10,
				"e2e-information-batch-interpreter",
			),
		).toHaveLength(4);

		const first = await intelligence.run();

		expect(
			(await store.listInterpretationRuns(1))[0]?.output,
		).toMatchObject({
			routes: [{ route: "information" }, { route: "information" }],
		});

		const second = await intelligence.run();
		const third = await intelligence.run();

		expect(first.eventIds).toEqual(
			receipts.slice(0, 2).map(({ event }) => event.id),
		);
		expect(second.eventIds).toEqual([receipts[2]!.event.id]);
		expect(third.eventIds).toEqual([receipts[3]!.event.id]);
		expect(seen.map((batch) => batch.length)).toEqual([2, 1, 1]);
		expect(
			await store.listUninterpretedSourceEvents(
				["slack"],
				10,
				"e2e-information-batch-interpreter",
			),
		).toHaveLength(0);
	});

	it("reuses an earlier Slack thread request when its completion arrives later", async () => {
		let taskId = "";
		const interpreter: EvidenceInterpreter = {
			name: "e2e-thread-interpreter",
			async interpret(input) {
				if (
					!input.events.some((event) =>
						event.payloadExcerpt.includes("retest completed"),
					)
				) {
					return {
						summary: "The retest is requested, not complete.",
						findings: [],
					};
				}
				expect(
					input.events.map((event) => event.payloadExcerpt),
				).toEqual(
					expect.arrayContaining([
						expect.stringContaining(
							"run a clean causal-worker retest",
						),
						expect.stringContaining("retest completed"),
					]),
				);
				expect(input.events).toHaveLength(2);
				expect(input.tasks[0]?.id).toBe(taskId);
				return {
					summary: "The requested retest is complete.",
					findings: [
						finding(
							input.tasks[0]!,
							input.events.map((event) => event.id),
						),
					],
				};
			},
		};
		const { store, ledger, intelligence } = system(interpreter);
		const task = await ledger.createTask(
			{
				title: "Run clean causal-worker retest",
				description:
					"Run and report the disposable-environment retest.",
				status: "planned",
				priority: "high",
			},
			"user:e2e",
		);

		taskId = task.id;

		const request = await intelligence.record(
			slack(
				"1000.000",
				"run a clean causal-worker retest",
				"2026-09-20T05:56:00.000Z",
				"1000.000",
			),
		);

		await intelligence.run();

		const completion = await intelligence.record(
			slack(
				"2000.000",
				"retest completed",
				"2026-09-20T07:49:00.000Z",
				"1000.000",
			),
		);

		await intelligence.record(
			slack(
				"2001.000",
				"publish the design overview",
				"2026-09-20T07:50:00.000Z",
				"2001.000",
			),
		);

		const report = await intelligence.run();

		expect(report.outcomes).toMatchObject([
			{ kind: "task_change", state: "applied" },
		]);
		expect(await ledger.getTask(task.id)).toMatchObject({ status: "done" });

		const revisions = await store.listTaskRevisions(task.id);
		const proposal = await store.getProposal(revisions.at(-1)!.proposalId);

		expect(proposal?.evidenceIds).toEqual(
			expect.arrayContaining([request.event.id, completion.event.id]),
		);
		expect(report.eventIds).not.toContain(
			(await store.listUninterpretedSourceEvents(["slack"], 10))[0]?.id,
		);
	});

	it("keeps unrelated commits in one repository out of each other's work episode", async () => {
		const seen: string[][] = [];
		const { intelligence } = system({
			name: "e2e-commit-interpreter",
			async interpret(input) {
				seen.push(input.events.map((event) => event.payloadExcerpt));
				return {
					summary: "No status change from a commit alone.",
					findings: [],
				};
			},
		});

		await intelligence.record(
			commit(
				"aaaaaaa",
				"Implement marketless confirmation flow",
				"2026-09-20T10:00:00.000Z",
			),
		);
		await intelligence.record(
			commit(
				"bbbbbbb",
				"Fix causal graph card schema",
				"2026-09-20T10:01:00.000Z",
			),
		);

		await intelligence.run();
		await intelligence.run();

		expect(seen).toHaveLength(2);
		expect(seen.every((episode) => episode.length === 1)).toBe(true);
	});

	it("matches tasks using work evidence, not informational replies in the same thread", async () => {
		const queries: string[] = [];
		const { intelligence, ledger } = system(
			{
				name: "e2e-mixed-thread-interpreter",
				async interpret() {
					return {
						summary: "No status change is established.",
						findings: [],
					};
				},
			},
			(query) => queries.push(query),
		);

		await ledger.createTask(
			{
				title: "Implement marketless confirmation flow",
				status: "planned",
				description: "Implement and verify marketless confirmations.",
			},
			"user:e2e",
		);
		await intelligence.record(
			slack(
				"3000.000",
				"implement marketless confirmation flow",
				"2026-09-20T10:00:00.000Z",
				"3000.000",
			),
		);
		await intelligence.record(
			slack(
				"3001.000",
				"the system architecture uses immutable receipts",
				"2026-09-20T10:01:00.000Z",
				"3000.000",
			),
		);

		await intelligence.run();

		expect(queries).toHaveLength(1);
		expect(queries[0]).toContain("implement marketless confirmation flow");
		expect(queries[0]).not.toContain(
			"system architecture uses immutable receipts",
		);
	});

	it("does not reopen a task from an information-only thread reply", async () => {
		const seen: string[][] = [];
		const { intelligence, ledger } = system({
			name: "e2e-information-reply-interpreter",
			async interpret(input) {
				seen.push(input.events.map((event) => event.payloadExcerpt));
				return {
					summary: "No task change is established.",
					findings: [],
				};
			},
		});
		const task = await ledger.createTask(
			{
				title: "Run clean causal-worker retest",
				description:
					"Run and report the disposable-environment retest.",
				status: "planned",
			},
			"user:e2e",
		);

		await intelligence.record(
			slack(
				"4000.000",
				"run a clean causal-worker retest",
				"2026-09-20T05:56:00.000Z",
				"4000.000",
			),
		);
		await intelligence.run();
		await intelligence.record(
			slack(
				"4001.000",
				"no edges",
				"2026-09-21T05:34:00.000Z",
				"4000.000",
			),
		);

		await intelligence.run();

		expect(seen[1]).toHaveLength(1);
		expect(seen[1]?.[0]).toContain("no edges");
		expect(await ledger.getTask(task.id)).toMatchObject({
			status: "planned",
		});
	});
});
