import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type {
	Observation,
	SourceEventInput,
	Task,
	TaskFields,
} from "../src/domain/types.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import type {
	EvidenceInterpreter,
	EvidenceInterpreterInput,
	EvidenceRouter,
	IntelligenceConfig,
	InterpretationOutput,
} from "../src/intelligence/types.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const intelligenceConfig: IntelligenceConfig = {
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
	completionEvidenceProviders: [
		"github",
		"git",
		"codex",
		"claude_code",
		"agent",
	],
	sourceProviders: [
		"notion:source.document.retrieved",
		"slack",
		"github",
		"git",
		"codex",
		"claude_code",
		"agent",
		"manual",
	],
};

const baseFields: TaskFields = {
	externalRef: "notion:page:task-1",
	title: "Ship the onboarding guide",
	description: "Document and publish the first-run path.",
	status: "in_progress",
	priority: "high",
	owner: "Rina",
	project: "Onboarding",
	dueDate: "2026-09-18",
	dependencyRefs: [],
	sourceUrl: "https://notion.so/task-1",
};

function baselineObservation(): Observation {
	return {
		event: {
			provider: "legacy-board",
			installationKey: "default",
			providerEventId: "baseline-task-1",
			eventKind: "snapshot.retrieved",
			occurredAt: "2026-09-12T08:00:00.000Z",
			fetchedAt: "2026-09-12T08:01:00.000Z",
			sourceRef: baseFields.externalRef!,
			sourceUrl: baseFields.sourceUrl,
			contentHash: "baseline-task-1",
			visibility: "company",
			payloadVersion: "test",
			payload: { title: baseFields.title },
		},
		signal: { type: "task_snapshot", fields: baseFields },
	};
}

function evidence(
	providerEventId: string,
	provider: string,
	payload: SourceEventInput["payload"],
): SourceEventInput {
	return {
		provider,
		installationKey: "test",
		providerEventId,
		eventKind: "work.observed",
		occurredAt: "2026-09-12T09:00:00.000Z",
		fetchedAt: "2026-09-12T09:01:00.000Z",
		sourceRef: `${provider}:${providerEventId}`,
		sourceUrl: null,
		contentHash: providerEventId,
		visibility: "company",
		payloadVersion: "test",
		payload,
	};
}

class ScriptedInterpreter implements EvidenceInterpreter {
	readonly name = "scripted-test";

	constructor(
		private readonly output: (
			input: EvidenceInterpreterInput,
		) => InterpretationOutput,
	) {}

	async interpret(
		input: EvidenceInterpreterInput,
	): Promise<InterpretationOutput> {
		return this.output(input);
	}
}

function makeSystem(
	output: (input: EvidenceInterpreterInput) => InterpretationOutput,
	router?: EvidenceRouter,
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
	const intelligence = new EvidenceIntelligence({
		store,
		ledger,
		interpreter: new ScriptedInterpreter(output),
		router: router ?? null,
		companyName: "Example Company",
		config: intelligenceConfig,
		log: { info() {}, error() {} },
	});

	return { store, ledger, intelligence };
}

describe("EvidenceIntelligence", () => {
	it("enforces Jev route boundaries on LLM findings", async () => {
		const router: EvidenceRouter = {
			name: "scripted-router",
			route: async (events) =>
				events.map((item) => ({
					eventId: item.id,
					route: "task",
					confidence: 0.95,
				})),
		};
		const system = makeSystem(
			(input) => ({
				summary:
					"The model tried to store information from a task-only observation.",
				findings: [
					{
						kind: "context_fact_upsert",
						taskId: null,
						title: null,
						description: null,
						status: null,
						priority: null,
						owner: null,
						project: null,
						dueDate: null,
						dependencyRefs: [],
						contextPath: "/company/invalid",
						contextTitle: "Invalid context",
						contextBody: null,
						contextFactType: "other",
						contextFactValue: "Should not be stored.",
						rationale: "Task-only evidence.",
						confidence: 0.95,
						evidenceEventIds: [input.events[0]!.id],
						caveats: [],
					},
				],
			}),
			router,
		);

		await system.intelligence.record(
			evidence("task-only-route", "slack", {
				text: "Rina will ship it.",
			}),
		);

		const report = await system.intelligence.run();

		expect(report.outcomes).toMatchObject([
			{
				state: "rejected",
				reason: "Jev did not route the cited evidence to durable information.",
			},
		]);
		expect((await system.ledger.contextPack()).entries).toEqual([]);
	});

	it("fails closed when Jev routing is unavailable", async () => {
		let interpreted = false;
		const router: EvidenceRouter = {
			name: "unavailable-router",
			route: async () => {
				throw new Error("routing unavailable");
			},
		};
		const system = makeSystem(() => {
			interpreted = true;
			return { summary: "Should not run.", findings: [] };
		}, router);

		await system.intelligence.record(
			evidence("route-failure", "slack", { text: "Rina will ship it." }),
		);

		await expect(system.intelligence.run()).rejects.toThrow(
			"routing unavailable",
		);
		expect(interpreted).toBe(false);
		expect(await system.intelligence.listRuns()).toEqual([]);
	});

	it("never interprets receipts emitted by accepted context writes", async () => {
		let interpretedEventKinds: string[] = [];
		const system = makeSystem((input) => {
			interpretedEventKinds = input.events.map(
				(event) => event.eventKind,
			);
			return {
				summary:
					"No accepted-state receipt should reach this interpreter.",
				findings: [],
			};
		});
		const authoredFact = await system.intelligence.record({
			...evidence("accepted-fact-receipt", "manual", {
				path: "/policies/review",
			}),
			eventKind: "context.fact.authored",
			payloadVersion: "manual-context-v1",
		});
		const authoredFile = await system.intelligence.record({
			...evidence("accepted-file-receipt", "manual", {
				path: "/company/handbook.md",
			}),
			eventKind: "context.file.authored",
			payloadVersion: "manual-context-v1",
		});
		const lifecycle = await system.intelligence.record({
			...evidence("context-lifecycle-receipt", "manual", {
				lifecycleState: "needs_review",
			}),
			eventKind: "context.lifecycle.reviewed",
			payloadVersion: "context-lifecycle-v1",
		});
		const observation = await system.intelligence.record(
			evidence("manual-work-observation", "manual", {
				outcome: "A human supplied a new observation for review.",
			}),
		);

		expect(
			(
				await system.store.listUninterpretedSourceEvents(["manual"], 10)
			).map((event) => event.id),
		).toEqual([observation.event.id]);
		await expect(
			system.intelligence.run({ eventIds: [lifecycle.event.id] }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const report = await system.intelligence.run();

		expect(report.eventIds).toEqual([observation.event.id]);
		expect(interpretedEventKinds).toEqual(["work.observed"]);
		expect(report.eventIds).not.toEqual(
			expect.arrayContaining([
				authoredFact.event.id,
				authoredFile.event.id,
				lifecycle.event.id,
			]),
		);
	});

	it("applies a cited completion as a reversible task revision", async () => {
		let taskId = "";
		const system = makeSystem((input) => ({
			summary:
				"The implementation was pushed and the assigned agent reported verification.",
			findings: [
				{
					kind: "task_change",
					taskId,
					title: baseFields.title,
					description: baseFields.description,
					status: "done",
					priority: baseFields.priority,
					owner: baseFields.owner,
					project: baseFields.project,
					dueDate: baseFields.dueDate,
					dependencyRefs: [],
					contextPath: null,
					contextTitle: null,
					contextBody: null,
					contextFactType: null,
					contextFactValue: null,
					rationale:
						"A reviewed code change and agent verification both support completion.",
					confidence: 0.94,
					evidenceEventIds: input.events.map((event) => event.id),
					caveats: [],
				},
			],
		}));
		const baseline = await system.ledger.ingest(baselineObservation());

		taskId = (
			(await system.ledger.approveProposal(
				baseline.proposal!.id,
				"user:reviewer",
				"Reviewed baseline",
			)) as Task
		).id;

		const pushed = await system.intelligence.record(
			evidence("push-1", "github", { sha: "abc", merged: true }),
		);
		const verified = await system.intelligence.record(
			evidence("agent-1", "codex", { outcome: "verified" }),
		);

		const report = await system.intelligence.run();

		expect(report.state).toBe("completed");
		expect(report.outcomes).toHaveLength(1);
		expect(report.outcomes[0]).toMatchObject({
			kind: "task_change",
			state: "applied",
			proposalId: expect.any(String),
		});
		expect((await system.ledger.board()).proposals).toEqual([]);
		expect((await system.ledger.getTask(taskId))?.status).toBe("done");
		expect((await system.intelligence.run()).state).toBe("no_evidence");
	});

	it("allows completion only when a configured resource checkpoint is fresh", async () => {
		let taskId = "";
		const system = makeSystem((input) => ({
			summary: "The implementation was delivered and verified.",
			findings: [
				{
					kind: "task_change",
					taskId,
					title: baseFields.title,
					description: baseFields.description,
					status: "done",
					priority: baseFields.priority,
					owner: baseFields.owner,
					project: baseFields.project,
					dueDate: baseFields.dueDate,
					dependencyRefs: [],
					contextPath: null,
					contextTitle: null,
					contextBody: null,
					contextFactType: null,
					contextFactValue: null,
					rationale: "GitHub delivery evidence supports completion.",
					confidence: 0.94,
					evidenceEventIds: input.events.map((event) => event.id),
					caveats: [],
				},
			],
		}));
		const baseline = await system.ledger.ingest(baselineObservation());

		taskId = (
			(await system.ledger.approveProposal(
				baseline.proposal!.id,
				"user:reviewer",
				"Reviewed baseline",
			)) as Task
		).id;

		const checkpointInstallation =
			await system.ledger.configureInstallation(
				{
					provider: "notion",
					installationKey: "checkpoint-import",
					displayName: "Imported checkpoint",
					transport: "poll",
					config: {},
				},
				"test:setup",
			);

		await system.ledger.updateConnectorSyncState(
			checkpointInstallation.id,
			"project-board",
			{
				status: "healthy",
				lastAttemptAt: "2026-09-12T09:00:00.000Z",
				lastSuccessAt: "2026-09-12T09:00:00.000Z",
				lastError: null,
				observedCount: 1,
				revokedCount: 0,
			},
		);

		const delivered = await system.intelligence.record(
			evidence("delivered-with-checkpoint", "github", {
				sha: "abc",
				merged: true,
			}),
		);
		const verified = await system.intelligence.record(
			evidence("verified-with-checkpoint", "codex", {
				outcome: "verified",
			}),
		);

		const stale = await system.intelligence.run();

		expect(stale.outcomes).toMatchObject([
			{
				state: "rejected",
				reason: "Terminal work state is blocked while required connector coverage is incomplete.",
			},
		]);
		expect((await system.ledger.getTask(taskId))?.status).toBe(
			"in_progress",
		);
		await system.ledger.updateConnectorSyncState(
			checkpointInstallation.id,
			"project-board",
			{
				lastSuccessAt: new Date().toISOString(),
			},
		);

		const retired = await system.ledger.configureInstallation(
			{
				provider: "notion",
				installationKey: "old-import",
				displayName: "Old import",
				transport: "poll",
				config: {},
			},
			"test:setup",
		);

		await system.ledger.updateConnectorSyncState(retired.id, "old-board", {
			status: "degraded",
			lastSuccessAt: "2020-01-01T00:00:00.000Z",
			lastError: "Old checkpoint",
		});
		await system.ledger.updateInstallation(
			retired.id,
			{ status: "disabled" },
			"test:setup",
		);

		const report = await system.intelligence.run({
			eventIds: [delivered.event.id, verified.event.id],
		});

		expect(report.outcomes).toMatchObject([{ state: "applied" }]);
		expect((await system.ledger.getTask(taskId))?.status).toBe("done");
	});

	it("supports an explicit evidence refresh after the normal run has completed", async () => {
		let calls = 0;
		const system = makeSystem(() => {
			calls += 1;
			return {
				summary: "No accepted-state change is supported.",
				findings: [
					{
						kind: "abstain",
						taskId: null,
						title: null,
						description: null,
						status: null,
						priority: null,
						owner: null,
						project: null,
						dueDate: null,
						dependencyRefs: [],
						contextPath: null,
						contextTitle: null,
						contextBody: null,
						contextFactType: null,
						contextFactValue: null,
						rationale: "The evidence is informational only.",
						confidence: 0.9,
						evidenceEventIds: [],
						caveats: [],
					},
				],
			};
		});
		const recorded = await system.intelligence.record(
			evidence("refresh-slack", "slack", {
				text: "Informational update.",
			}),
		);

		expect((await system.intelligence.run()).state).toBe("completed");
		expect((await system.intelligence.run()).state).toBe("no_evidence");
		expect(
			(await system.intelligence.run({ eventIds: [recorded.event.id] }))
				.state,
		).toBe("completed");
		expect(calls).toBe(2);
	});

	it("rejects a finding that cites an event the interpreter was never given", async () => {
		const system = makeSystem(() => ({
			summary: "Unsupported claim.",
			findings: [
				{
					kind: "task_create",
					taskId: null,
					title: "Invented task",
					description: "",
					status: "backlog",
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
					rationale: "The model invented a citation.",
					confidence: 0.99,
					evidenceEventIds: ["00000000-0000-4000-8000-000000000000"],
					caveats: [],
				},
			],
		}));

		await system.intelligence.record(
			evidence("slack-1", "slack", { text: "Maybe we should do this." }),
		);

		const report = await system.intelligence.run();

		expect(report.outcomes[0]).toMatchObject({
			state: "rejected",
			reason: "Finding cites unknown evidence.",
		});
		expect((await system.ledger.board()).proposals).toHaveLength(0);
	});

	it("rejects completion from one cited observation", async () => {
		let taskId = "";
		const system = makeSystem((input) => ({
			summary: "A commit was pushed.",
			findings: [
				{
					kind: "task_change",
					taskId,
					title: baseFields.title,
					description: baseFields.description,
					status: "done",
					priority: baseFields.priority,
					owner: baseFields.owner,
					project: baseFields.project,
					dueDate: baseFields.dueDate,
					dependencyRefs: [],
					contextPath: null,
					contextTitle: null,
					contextBody: null,
					contextFactType: null,
					contextFactValue: null,
					rationale: "A push exists.",
					confidence: 0.99,
					evidenceEventIds: [input.events[0]!.id],
					caveats: [],
				},
			],
		}));
		const baseline = await system.ledger.ingest(baselineObservation());

		taskId = (
			(await system.ledger.approveProposal(
				baseline.proposal!.id,
				"user:reviewer",
				"Reviewed baseline",
			)) as Task
		).id;
		await system.intelligence.record(
			evidence("push-only", "github", { sha: "single" }),
		);

		const report = await system.intelligence.run();

		expect(report.outcomes[0]).toMatchObject({
			state: "rejected",
			reason: "Completion lacks the configured evidence count, provider, or confidence.",
		});
		expect((await system.ledger.getTask(taskId))?.status).toBe(
			"in_progress",
		);
		expect(
			(await system.ledger.board()).proposals.filter(
				(proposal) => proposal.state === "pending",
			),
		).toHaveLength(0);
	});

	it("creates and applies a new task from cited evidence", async () => {
		const system = makeSystem((input) => ({
			summary:
				"A concrete follow-up was committed in the selected discussion.",
			findings: [
				{
					kind: "task_create",
					taskId: null,
					title: "Document the rollback procedure",
					description:
						"## Outcome\nA production rollback procedure is available to operators.\n\n## Work\n- Document the ordered rollback steps and required access.\n- Exercise the procedure against a production-shaped environment.\n\n## Done when\n- An operator can complete the documented rollback and the verification result is linked.",
					status: "planned",
					priority: "high",
					owner: "Rina",
					project: "Operations",
					dueDate: null,
					dependencyRefs: [],
					contextPath: null,
					contextTitle: null,
					contextBody: null,
					contextFactType: null,
					contextFactValue: null,
					rationale: "The team made a clear, assigned commitment.",
					confidence: 0.88,
					evidenceEventIds: [input.events[0]!.id],
					caveats: [],
				},
			],
		}));

		await system.ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T1",
				externalId: "U-RINA",
				displayName: "Rina",
				status: "active",
			},
			"test:slack-members",
		);

		const recorded = await system.intelligence.record(
			evidence("slack-2", "slack", {
				text: "Rina will document rollback.",
			}),
		);

		const report = await system.intelligence.run();

		expect(report.outcomes[0]).toMatchObject({
			kind: "task_create",
			state: "applied",
			proposalId: expect.any(String),
		});
		expect((await system.ledger.board()).proposals).toEqual([]);
		expect((await system.ledger.board()).tasks).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					title: "Document the rollback procedure",
					status: "planned",
				}),
			]),
		);

		const retry = await system.intelligence.run({
			eventIds: [recorded.event.id],
		});

		expect(retry.state).toBe("completed");
		expect(retry.outcomes[0]).toMatchObject({
			kind: "task_create",
			state: "rejected",
			reason: "A task from the same cited evidence is already accepted.",
		});
		expect((await system.ledger.board()).tasks).toHaveLength(1);
	});

	it("rejects vague AI tasks and owners outside the active organization directory", async () => {
		const system = makeSystem((input) => {
			expect(input.members).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						displayName: "Rina",
						status: "active",
						identities: [
							expect.objectContaining({
								provider: "slack",
								externalId: "U-RINA",
							}),
						],
					}),
				]),
			);
			return {
				summary: "The discussion mentioned a possible follow-up.",
				findings: [
					{
						kind: "task_create",
						taskId: null,
						title: "Follow up",
						description: "Ask about this later.",
						status: "planned",
						priority: "medium",
						owner: "Unknown Person",
						project: null,
						dueDate: null,
						dependencyRefs: [],
						contextPath: null,
						contextTitle: null,
						contextBody: null,
						contextFactType: null,
						contextFactValue: null,
						rationale: "A follow-up was mentioned.",
						confidence: 0.9,
						evidenceEventIds: [input.events[0]!.id],
						caveats: [],
					},
				],
			};
		});

		await system.ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T1",
				externalId: "U-RINA",
				displayName: "Rina",
				status: "active",
			},
			"test:slack-members",
		);
		await system.intelligence.record(
			evidence("slack-vague", "slack", { text: "Maybe follow up." }),
		);

		const report = await system.intelligence.run();

		expect(report.outcomes).toMatchObject([
			{
				state: "rejected",
				reason: "Task owner is not an active organization member.",
			},
		]);
		expect((await system.ledger.board()).proposals).toHaveLength(0);
	});

	it("applies durable context directly with its revision history", async () => {
		const system = makeSystem((input) => ({
			summary: "The team made a durable deployment decision.",
			findings: [
				{
					kind: "context_fact_upsert",
					taskId: null,
					title: null,
					description: null,
					status: null,
					priority: null,
					owner: null,
					project: null,
					dueDate: null,
					dependencyRefs: [],
					contextPath: "/policies/deployment/integration-tests",
					contextTitle: "Deployment policy",
					contextBody: null,
					contextFactType: "policy",
					contextFactValue:
						"Production deployments require a green integration suite.",
					rationale:
						"A durable policy decision was recorded in the selected discussion.",
					confidence: 0.91,
					evidenceEventIds: [input.events[0]!.id],
					caveats: [],
				},
			],
		}));

		await system.intelligence.record(
			evidence("slack-3", "slack", {
				text: "Decision: require green integration tests.",
			}),
		);

		const report = await system.intelligence.run();

		expect(report.outcomes[0]).toMatchObject({
			kind: "context_fact_upsert",
			state: "applied",
			proposalId: expect.any(String),
		});
		expect((await system.ledger.board()).proposals).toEqual([]);
		expect((await system.ledger.contextPack()).entries[0]).toMatchObject({
			kind: "fact",
			path: "/policies/deployment/integration-tests",
			value: "Production deployments require a green integration suite.",
		});
	});

	it("keeps a path-owner collision from aborting the rest of a source episode", async () => {
		const system = makeSystem((input) => ({
			summary: "The document contains two durable observations.",
			findings: [
				{
					kind: "context_file_upsert",
					taskId: null,
					title: null,
					description: null,
					status: null,
					priority: null,
					owner: null,
					project: null,
					dueDate: null,
					dependencyRefs: [],
					contextPath: "/company/theses/formation-and-review",
					contextTitle: "Conflicting thesis",
					contextBody: "An unreviewed rewrite.",
					contextFactType: null,
					contextFactValue: null,
					rationale: "The model suggested this path.",
					confidence: 0.91,
					evidenceEventIds: [input.events[0]!.id],
					caveats: [],
				},
				{
					kind: "context_fact_upsert",
					taskId: null,
					title: null,
					description: null,
					status: null,
					priority: null,
					owner: null,
					project: null,
					dueDate: null,
					dependencyRefs: [],
					contextPath: "/company/theses/independent-check",
					contextTitle: "Independent check",
					contextBody: null,
					contextFactType: "policy",
					contextFactValue: "Check new claims independently.",
					rationale: "A separate supported point.",
					confidence: 0.91,
					evidenceEventIds: [input.events[0]!.id],
					caveats: [],
				},
			],
		}));
		const original = await system.ledger.createContextEntry(
			{
				kind: "file",
				path: "/company/theses/formation-and-review.md",
				title: "Accepted thesis",
				body: "Reviewed source of truth.",
			},
			"user:reviewer",
		);

		await system.intelligence.record(
			evidence("slack-colliding-path", "slack", {
				text: "An unrelated observation used for this replay check.",
			}),
		);

		const report = await system.intelligence.run();

		expect(report.state).toBe("completed");
		expect(report.outcomes).toMatchObject([
			{
				kind: "context_file_upsert",
				state: "rejected",
				reason: "Context path is already owned by a different entry.",
			},
			{ kind: "context_fact_upsert", state: "applied" },
		]);

		const entries = (await system.ledger.contextPack()).entries;

		expect(entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: original.id,
					title: "Accepted thesis",
					body: "Reviewed source of truth.",
				}),
				expect.objectContaining({
					path: "/company/theses/independent-check",
					value: "Check new claims independently.",
				}),
			]),
		);
		expect(await system.store.listProposals("pending")).toEqual([]);
	});

	it("turns a Notion source document into multiple applied memory revisions", async () => {
		const documentMarkdown = `Start of handbook. ${"x".repeat(70_000)} End of handbook marker.`;
		const system = makeSystem((input) => {
			expect(input.events).toHaveLength(1);
			expect(input.events[0]).toMatchObject({
				provider: "notion",
				eventKind: "source.document.retrieved",
			});
			expect(input.events[0]!.payloadExcerpt).toContain(
				"End of handbook marker.",
			);
			return {
				summary:
					"Two independently changeable company facts were extracted.",
				findings: [
					{
						kind: "context_fact_upsert",
						taskId: null,
						title: null,
						description: null,
						status: null,
						priority: null,
						owner: null,
						project: null,
						dueDate: null,
						dependencyRefs: [],
						contextPath: "/company/deployments/review",
						contextTitle: "Deployment review",
						contextBody: null,
						contextFactType: "policy",
						contextFactValue: "Production changes require review.",
						rationale:
							"The handbook states a durable deployment rule.",
						confidence: 0.95,
						evidenceEventIds: [input.events[0]!.id],
						caveats: [],
					},
					{
						kind: "context_fact_upsert",
						taskId: null,
						title: null,
						description: null,
						status: null,
						priority: null,
						owner: null,
						project: null,
						dueDate: null,
						dependencyRefs: [],
						contextPath: "/company/ownership/incidents",
						contextTitle: "Incident ownership",
						contextBody: null,
						contextFactType: "relationship",
						contextFactValue:
							"The on-call engineer owns incident coordination.",
						rationale:
							"The handbook assigns a durable responsibility.",
						confidence: 0.93,
						evidenceEventIds: [input.events[0]!.id],
						caveats: [],
					},
				],
			};
		});
		const deferredSlack = await system.intelligence.record(
			evidence("slack-before-handbook", "slack", {
				text: "A separate work update.",
			}),
		);
		const source = await system.intelligence.record({
			...evidence("notion-handbook", "notion", {
				document: {
					title: "Handbook",
					suggestedPath: "/company/handbook",
					markdown: documentMarkdown,
				},
			}),
			eventKind: "source.document.retrieved",
		});

		const report = await system.intelligence.run();

		expect(report.outcomes).toMatchObject([
			{ kind: "context_fact_upsert", state: "applied" },
			{ kind: "context_fact_upsert", state: "applied" },
		]);
		expect((await system.ledger.board()).proposals).toEqual([]);
		expect((await system.ledger.contextPack()).entries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					path: "/company/deployments/review",
					evidenceIds: [source.event.id],
				}),
				expect.objectContaining({
					path: "/company/ownership/incidents",
					evidenceIds: [source.event.id],
				}),
			]),
		);
		expect(
			(
				await system.store.listUninterpretedSourceEvents(["slack"], 10)
			).map((event) => event.id),
		).toContain(deferredSlack.event.id);
	});
});
