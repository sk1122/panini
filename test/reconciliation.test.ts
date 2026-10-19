import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { JevWorkJudge } from "../src/reconciliation/jev-work-judge.js";
import { OpenAIWorkProseDrafter } from "../src/reconciliation/openai-work-drafter.js";
import {
	WorkSuggestionEngine,
	eligibleWorkSignal,
} from "../src/reconciliation/work-suggestions.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

function setup() {
	const store = new MemoryLedgerStore();
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			autoApproveNewTasks: false,
			autoApproveContext: false,
			requireReviewForTaskChanges: true,
		}),
	);

	return { store, ledger };
}

async function event(
	store: MemoryLedgerStore,
	provider: string,
	id: string,
	text: string,
	visibility = "company",
) {
	return store.appendSourceEvent({
		provider,
		installationKey: "test",
		providerEventId: id,
		eventKind:
			provider === "slack" ? "message.observed" : `${provider}.observed`,
		occurredAt: "2026-09-20T00:00:00Z",
		fetchedAt: "2026-09-20T00:01:00Z",
		sourceRef: `${provider}:${id}`,
		sourceUrl: null,
		contentHash: id,
		visibility,
		payloadVersion: "test",
		payload: { text },
	});
}

describe("work reconciliation shadow path", () => {
	it("does not auto-change an existing Task's status from a Jev stage classification", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{ title: "Verify source replay", status: "planned" },
			"user:reviewer",
		);
		const source = await store.appendSourceEvent({
			provider: "agent",
			installationKey: "test",
			providerEventId: "agent-blocker",
			eventKind: "work.blocked",
			occurredAt: new Date().toISOString(),
			fetchedAt: new Date().toISOString(),
			sourceRef: `team-ledger:task:${task.id}`,
			sourceUrl: null,
			contentHash: "agent-blocker",
			visibility: "company",
			payloadVersion: "work-report-v1",
			payload: {
				workItemId: task.id,
				phase: "blocked",
				outcome: "The replay is blocked by a missing table.",
			},
		});
		const judge = {
			judge: async () => ({
				kind: { choice: "task_action", confidence: 0.99 },
				target: { choice: "candidate_0", confidence: 0.99 },
				selectedCandidate: { kind: "task", id: task.id },
				stage: { choice: "blocked", confidence: 0.99 },
				concreteActionProbability: 0.99,
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("Status prose should not run");
			},
		};
		const engine = new WorkSuggestionEngine(
			store,
			ledger,
			judge,
			drafter,
			["company"],
			true,
		);

		expect((await engine.run([source.event.id]))[0]?.outcome).toBe(
			"skipped",
		);
		expect((await store.getTask(task.id))?.status).toBe("planned");
		expect(await store.listProposals("pending")).toHaveLength(0);
	});

	it("turns a structured agent blocker into a review proposal without changing task status", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{ title: "Verify source replay", status: "planned" },
			"user:reviewer",
		);
		const now = new Date().toISOString();
		const report = await store.appendSourceEvent({
			provider: "agent",
			installationKey: "profile-1",
			providerEventId: "blocker-report",
			eventKind: "work.blocked",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: `team-ledger:task:${task.id}`,
			sourceUrl: null,
			contentHash: "blocker-report",
			visibility: "company",
			payloadVersion: "work-report-v1",
			payload: {
				workItemId: task.id,
				phase: "blocked",
				outcome: "The source replay failed at the migration step.",
				verification: ["Migration exited with a missing table error."],
			},
		});

		expect(eligibleWorkSignal(report.event)).toBe(true);

		const judge = {
			judge: async () => ({
				target: { choice: "candidate_0", confidence: 0.95 },
				selectedCandidate: { kind: "task", id: task.id },
				stage: { choice: "blocked", confidence: 0.9 },
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async (
				_bundle: unknown,
				intent: { evidenceEventIds: string[] },
			) => ({
				text: "The source replay outcome was reported with verification.",
				evidenceEventIds: intent.evidenceEventIds,
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		expect((await engine.run([report.event.id]))[0]?.outcome).toBe(
			"proposal",
		);

		const proposal = (await store.listProposals("pending"))[0];

		expect(proposal?.changes).toEqual({ status: "blocked" });
		expect(proposal?.evidenceIds).toEqual([report.event.id]);
		expect((await ledger.getTask(task.id))?.status).toBe("planned");

		const verified = await store.appendSourceEvent({
			provider: "agent",
			installationKey: "profile-1",
			providerEventId: "verified-report",
			eventKind: "work.verified",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: `team-ledger:task:${task.id}`,
			sourceUrl: null,
			contentHash: "verified-report",
			visibility: "company",
			payloadVersion: "work-report-v1",
			payload: {
				workItemId: task.id,
				phase: "verified",
				outcome: "The replay verification was reported complete.",
				verification: ["A verification artifact was attached."],
			},
		});
		const deliveryJudge = {
			judge: async () => ({
				target: { choice: "candidate_0", confidence: 0.95 },
				selectedCandidate: { kind: "task", id: task.id },
				stage: { choice: "delivery_candidate", confidence: 0.9 },
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const deliveryEngine = new WorkSuggestionEngine(
			store,
			ledger,
			deliveryJudge,
			drafter,
			["company"],
		);

		expect(
			(await deliveryEngine.run([verified.event.id]))[0]?.outcome,
		).toBe("proposal");
		expect(
			(await store.listProposals("pending")).map((item) => item.changes),
		).toContainEqual({ status: "review" });
		expect((await ledger.getTask(task.id))?.status).toBe("planned");
	});

	it("suggests a Project only when a Notion purpose has independent current work evidence", async () => {
		const { store, ledger } = setup();
		const now = new Date().toISOString();
		const olderPlan = new Date(
			Date.now() - 45 * 24 * 60 * 60_000,
		).toISOString();
		const notion = await store.appendSourceEvent({
			provider: "notion",
			installationKey: "test",
			providerEventId: "project-page",
			eventKind: "source.document.retrieved",
			occurredAt: olderPlan,
			fetchedAt: now,
			sourceRef: "notion:project-page",
			sourceUrl: "https://notion.so/project-page",
			contentHash: "project-page",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				document: {
					title: "Atlas source coverage",
					markdown:
						"## Purpose\nBuild a source coverage map for every active feed and verify missing observations before publication.\n".repeat(
							3,
						),
				},
			},
		});
		const judge = {
			judge: async () => ({
				kind: { choice: "project_outcome", confidence: 0.92 },
				target: { choice: "new_project", confidence: 0.93 },
				concreteActionProbability: 0.91,
			}),
			supportsDraft: async () => 0.95,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async (
				_bundle: unknown,
				request: { kind: string; evidenceEventIds: string[] },
			) => ({
				text:
					request.kind === "project_name"
						? "Atlas source coverage"
						: "Map active feed coverage and verify missing observations.",
				evidenceEventIds: request.evidenceEventIds,
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		expect((await engine.run([notion.event.id]))[0]).toMatchObject({
			outcome: "skipped",
		});

		// A fresh run after new corroborating evidence uses a new source event version.
		const {
			id: _id,
			receivedAt: _receivedAt,
			...sourceInput
		} = notion.event;
		const linked = await store.appendSourceEvent({
			...sourceInput,
			providerEventId: "project-page-v2",
			contentHash: "project-page-v2",
		});

		await event(
			store,
			"slack",
			"atlas-work",
			"<@U12345> build Atlas source coverage and verify missing observations this week.",
		);

		const result = await engine.run([linked.event.id]);

		expect(result[0]?.outcome).toBe("proposal");

		const proposals = await store.listProjectProposals();

		expect(proposals).toHaveLength(1);
		expect(proposals[0]).toMatchObject({
			state: "pending",
			kind: "project_create",
			changes: { name: "Atlas source coverage", owner: null },
		});
		expect(proposals[0]?.evidenceIds).toContain(linked.event.id);
		expect(await store.listProjects()).toHaveLength(0);
	});

	it("can suggest a Project from linked Slack and GitHub evidence without a Notion page", async () => {
		const { store, ledger } = setup();
		const action = await event(
			store,
			"slack",
			"source-coverage-action",
			"Build Atlas source coverage on feature/atlas-source and verify missing observations this week.",
		);
		const now = new Date().toISOString();
		const pull = await store.appendSourceEvent({
			provider: "github",
			installationKey: "test",
			providerEventId: "atlas-pr",
			eventKind: "pull_request.snapshot",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: "github:atlas-pr",
			sourceUrl: "https://github.com/acme/atlas/pull/1",
			contentHash: "atlas-pr",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				title: "Atlas source coverage",
				head: "feature/atlas-source",
				state: "open",
			},
		});
		const judge = {
			judge: async () => ({
				kind: { choice: "project_outcome", confidence: 0.94 },
				target: { choice: "new_project", confidence: 0.94 },
				concreteActionProbability: 0.92,
			}),
			supportsDraft: async () => 0.95,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async (
				_bundle: unknown,
				request: { kind: string; evidenceEventIds: string[] },
			) => ({
				text:
					request.kind === "project_name"
						? "Atlas source coverage"
						: "Cover active feeds and verify missing source observations.",
				evidenceEventIds: request.evidenceEventIds,
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		expect((await engine.run([action.event.id]))[0]?.outcome).toBe(
			"proposal",
		);
		expect((await store.listProjectProposals())[0]?.evidenceIds).toEqual(
			expect.arrayContaining([action.event.id, pull.event.id]),
		);

		const repeated = await event(
			store,
			"slack",
			"source-coverage-repeat",
			"Build Atlas source coverage on feature/atlas-source and verify missing observations this week.",
		);

		expect((await engine.run([repeated.event.id]))[0]?.outcome).toBe(
			"skipped",
		);
		expect(await store.listProjectProposals()).toHaveLength(1);
		expect(await store.listProjects()).toHaveLength(0);
	});

	it("creates one cited review proposal from a direct Slack action and never accepts it", async () => {
		const { store, ledger } = setup();
		const source = await event(
			store,
			"slack",
			"direct-retest",
			"<@U12345> run a clean causal-worker retest on the causal-edge branch.\nCheck the queue drains.",
		);
		const judge = {
			judge: async () => ({
				kind: { choice: "task_action", confidence: 0.95 },
				target: { choice: "new_task", confidence: 0.9 },
				concreteActionProbability: 0.94,
			}),
			supportsDraft: async () => 0.95,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async (_bundle: unknown, request: { kind: string }) => ({
				text:
					request.kind === "task_title"
						? "Run a clean causal-worker retest on the causal-edge branch"
						: "Check that the queue drains.",
				evidenceEventIds: [source.event.id],
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);
		const first = await engine.run([source.event.id]);

		expect(first[0]?.outcome).toBe("proposal");

		const proposals = await store.listProposals("pending");

		expect(proposals).toHaveLength(1);
		expect(proposals[0]?.changes).toMatchObject({
			title: "Run a clean causal-worker retest on the causal-edge branch",
			status: "backlog",
			owner: null,
			projectId: null,
		});
		expect(proposals[0]?.evidenceIds).toContain(source.event.id);
		expect(await store.listTasks()).toHaveLength(0);
		expect(await engine.run([source.event.id])).toEqual([]);
		expect(await store.listProposals("pending")).toHaveLength(1);
	});

	it("accepts a Jev-classified Task after Jev links it to a cited Project", async () => {
		const { store, ledger } = setup();
		const project = await ledger.createProject(
			{
				name: "Causal worker retest",
				outcome:
					"Verify the causal worker replay against disposable Postgres and Redis.",
			},
			"user:reviewer",
		);
		const now = new Date().toISOString();
		const source = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "test",
			providerEventId: "recent-retest",
			eventKind: "message.observed",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: "slack:recent-retest",
			sourceUrl: null,
			contentHash: "recent-retest",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				text: "Run a clean causal-worker retest on disposable Postgres and Redis.",
			},
		});
		const judge = {
			judge: async () => ({
				kind: { choice: "task_action", confidence: 0.94 },
				target: { choice: "new_task", confidence: 0.62 },
				stage: { choice: "planned" },
				concreteActionProbability: 0.9,
			}),
			supportsDraft: async () => 0.95,
			judgeProject: async () => ({
				target: { choice: "project_0", confidence: 0.9 },
				selectedProjectId: project.id,
				relationshipProbability: 0.46,
				distinctOutcomeProbability: 0.1,
			}),
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async (_bundle: unknown, request: { kind: string }) => ({
				text:
					request.kind === "task_title"
						? "Run a clean causal-worker retest on disposable Postgres and Redis"
						: "",
				evidenceEventIds: [source.event.id],
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(
			store,
			ledger,
			judge,
			drafter,
			["company"],
			true,
		);

		expect((await engine.run([source.event.id]))[0]?.outcome).toBe(
			"accepted",
		);
		expect((await store.listTasks()).map((task) => task.title)).toEqual([
			"Run a clean causal-worker retest on disposable Postgres and Redis",
		]);
		expect((await store.listTasks())[0]?.projectId).toBe(project.id);
		expect(await store.listProposals("pending")).toHaveLength(0);
		expect(
			await store.listTaskRevisions((await store.listTasks())[0]!.id),
		).toHaveLength(1);
	});

	it("uses the Slack thread parent to establish a distinct run before automatic Project and Task creation", async () => {
		const { store, ledger } = setup();
		const now = new Date().toISOString();
		const parent = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "test",
			providerEventId: "1789128253.156859",
			eventKind: "message.observed",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: "slack:T:C:1789128253.156859",
			sourceUrl: "https://slack.test/archives/C/p1789128253156859",
			contentHash: "parent",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				text: "Run the full evidence process again using a balanced official account list.",
			},
		});
		const reply = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "test",
			providerEventId: "1789206786.325979",
			eventKind: "message.observed",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: "slack:T:C:1789206786.325979",
			sourceUrl:
				"https://slack.test/archives/C/p1789206786325979?thread_ts=1789128253.156859&cid=C",
			contentHash: "reply",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				text: "Add five official accounts from each side to the list for the full evidence run.",
			},
		});
		const laterRun = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "test",
			providerEventId: "later-evidence-run",
			eventKind: "message.observed",
			occurredAt: now,
			fetchedAt: now,
			sourceRef: "slack:T:C:later-evidence-run",
			sourceUrl: "https://slack.test/archives/C/later-evidence-run",
			contentHash: "later-evidence-run",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				text: "The official account list for both sides feeds the full evidence run after reel transcription and source filtering.",
			},
		});
		const bundle = await ledger.workEvidenceBundle(reply.event.id, [
			"company",
		]);

		expect(bundle.spans.map((span) => span.eventId)).toEqual(
			expect.arrayContaining([
				reply.event.id,
				parent.event.id,
				laterRun.event.id,
			]),
		);

		const judge = {
			judge: async () => ({
				kind: { choice: "task_action", confidence: 0.95 },
				target: { choice: "new_task", confidence: 0.9 },
				stage: { choice: "planned" },
				concreteActionProbability: 0.95,
			}),
			supportsDraft: async () => 0.95,
			judgeProject: async () => ({
				target: { choice: "new_project", confidence: 0.9 },
				selectedProjectId: null,
				relationshipProbability: 0.9,
				distinctOutcomeProbability: 0.9,
			}),
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async (_bundle: unknown, request: { kind: string }) => ({
				text:
					request.kind === "task_title"
						? "Add five official accounts from each side to the list"
						: request.kind === "project_name"
							? "Balanced account evidence run"
							: request.kind === "project_purpose"
								? "Run the full evidence process again using a balanced official account list."
								: "",
				evidenceEventIds: [reply.event.id],
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(
			store,
			ledger,
			judge,
			drafter,
			["company"],
			true,
		);

		expect((await engine.run([reply.event.id]))[0]?.outcome).toBe(
			"accepted",
		);

		const [project] = await store.listProjects();
		const [task] = await store.listTasks();

		expect(project?.name).toBe("Balanced account evidence run");
		expect(task?.projectId).toBe(project?.id);
		expect(await store.listProposals("pending")).toHaveLength(0);
		expect(
			(await store.listProjectProposals()).map(
				(proposal) => proposal.state,
			),
		).toEqual(["approved"]);
	});

	it("moves an older pending source suggestion through Project assignment into accepted Tasks", async () => {
		const { store, ledger } = setup();
		const project = await ledger.createProject(
			{
				name: "Evidence replay",
				outcome: "Run and verify the evidence replay.",
			},
			"user:reviewer",
		);
		const source = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "test",
			providerEventId: "pending-replay",
			eventKind: "message.observed",
			occurredAt: new Date().toISOString(),
			fetchedAt: new Date().toISOString(),
			sourceRef: "slack:pending-replay",
			sourceUrl: null,
			contentHash: "pending-replay",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				text: "Run the evidence replay and verify source ordering.",
			},
		});

		await ledger.proposeTaskCreation({
			clientEventId: `work-suggestion:${source.event.id}`,
			externalRef: `panini:source:${source.event.id}`,
			title: "Run the evidence replay",
			status: "backlog",
			priority: "medium",
			owner: null,
			project: null,
			projectId: null,
			rationale: "Earlier Jev classification and LLM title.",
			requestedBy: "system:work-suggestion",
			evidenceIds: [source.event.id],
		});

		const judge = {
			judge: async () => {
				throw new Error("No new classification needed");
			},
			supportsDraft: async () => 0.95,
			judgeProject: async () => ({
				target: { choice: "project_0", confidence: 0.9 },
				selectedProjectId: project.id,
				relationshipProbability: 0.9,
				distinctOutcomeProbability: 0.1,
			}),
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("No title draft needed");
			},
		};
		const engine = new WorkSuggestionEngine(
			store,
			ledger,
			judge,
			drafter,
			["company"],
			true,
		);

		expect(await engine.run(undefined, 0)).toEqual([]);
		expect((await store.listTasks())[0]).toMatchObject({
			projectId: project.id,
			project: project.name,
		});
		expect(await store.listProposals("pending")).toHaveLength(0);
	});

	it("clears a generated cross-thread description that the Task's primary source cannot support", async () => {
		const { store, ledger } = setup();
		const project = await ledger.createProject(
			{
				name: "Reel collection",
				outcome: "Collect and filter reel data.",
			},
			"user:reviewer",
		);
		const source = await event(
			store,
			"slack",
			"api-filter-task",
			"See if there are APIs with filters; otherwise continue scraping creators.",
		);
		const proposal = await ledger.proposeTaskCreation({
			externalRef: `panini:source:${source.event.id}`,
			title: "See if there are APIs with filters",
			description:
				"Run an unrelated causal-worker retest on Postgres and Redis.",
			projectId: project.id,
			project: project.name,
			status: "backlog",
			priority: "medium",
			rationale:
				"Jev classified a concrete Task action in slack evidence.",
			requestedBy: "system:work-suggestion",
			evidenceIds: [source.event.id],
		});
		const task = await ledger.approveProposal(
			proposal.id,
			"system:work-suggestion",
			"Automatic work creation.",
		);
		const judge = {
			judge: async () => {
				throw new Error("No classification needed");
			},
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("No draft needed");
			},
		};
		const engine = new WorkSuggestionEngine(
			store,
			ledger,
			judge,
			drafter,
			["company"],
			true,
		);

		await engine.run(undefined, 0);
		expect((await store.getTask(task.id))?.description).toBe("");
		expect((await store.getTask(task.id))?.version).toBe(2);
		expect(
			(await store.listTaskRevisions(task.id))[1]?.current.projectId,
		).toBe(project.id);
	});

	it("asks Jev about ordinary discussion and does not create a duplicate of a shortlisted task", async () => {
		const { store, ledger } = setup();
		const discussion = await event(
			store,
			"slack",
			"discussion",
			"Shall I run pairing with embeddings?",
		);

		expect(eligibleWorkSignal(discussion.event)).toBe(true);

		const question = await event(
			store,
			"slack",
			"question",
			"did it add edges in the database after the run?",
		);

		expect(eligibleWorkSignal(question.event)).toBe(true);

		const numbered = await event(
			store,
			"slack",
			"numbered",
			"<@U12345>\n1. check how many tweets we fetched for the CJP timeline",
		);

		expect(eligibleWorkSignal(numbered.event)).toBe(true);
		await ledger.createTask(
			{
				title: "Run a clean causal-worker retest on the causal-edge branch",
			},
			"user:reviewer",
		);

		const source = await event(
			store,
			"slack",
			"retest-duplicate",
			"<@U12345> run a clean causal-worker retest on the causal-edge branch.\nCheck the queue drains.",
		);
		const judge = {
			judge: async () => ({
				kind: { choice: "task_action", confidence: 0.95 },
				target: { choice: "new_task", confidence: 0.9 },
				concreteActionProbability: 0.94,
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => ({
				text: "Retest",
				evidenceEventIds: [source.event.id],
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		expect((await engine.run([source.event.id]))[0]).toMatchObject({
			outcome: "skipped",
			reason: "An existing Task may already represent this work.",
		});
		expect(await store.listProposals("pending")).toHaveLength(0);
	});

	it("drops a Jev-negative observation before any LLM call", async () => {
		const { store, ledger } = setup();
		const source = await event(
			store,
			"slack",
			"question-only",
			"Shall we discuss the graph options tomorrow?",
		);
		let draftCalls = 0;
		const judge = {
			judge: async () => ({
				kind: { choice: "discussion", confidence: 0.94 },
				target: { choice: "unrelated", confidence: 0.9 },
				concreteActionProbability: 0.04,
			}),
			supportsDraft: async () => {
				throw new Error("Unexpected support check");
			},
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				draftCalls++;
				throw new Error("Unexpected LLM call");
			},
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		expect((await engine.run([source.event.id]))[0]).toMatchObject({
			outcome: "skipped",
		});
		expect(draftCalls).toBe(0);
		expect(await store.listProposals("pending")).toHaveLength(0);
		expect(await store.getSourceEvents([source.event.id])).toHaveLength(1);
	});

	it("rejects an extractive but context-free Task title", async () => {
		const { store, ledger } = setup();
		const source = await event(
			store,
			"slack",
			"vague-title",
			"We need to filter it and then share.",
		);
		const judge = {
			judge: async () => ({
				kind: { choice: "task_action", confidence: 0.98 },
				target: { choice: "new_task", confidence: 0.95 },
				concreteActionProbability: 0.94,
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => ({
				text: "filter it and then share",
				evidenceEventIds: [source.event.id],
				model: "test",
			}),
		};
		const engine = new WorkSuggestionEngine(
			store,
			ledger,
			judge,
			drafter,
			["company"],
			true,
		);

		expect((await engine.run([source.event.id]))[0]).toMatchObject({
			outcome: "skipped",
			reason: "The LLM title was not directly supported by the source.",
		});
		expect(await store.listTasks()).toHaveLength(0);
		expect(await store.listProposals("pending")).toHaveLength(0);
	});

	it("does not let old pilot runs exhaust the revised Jev-first pilot", async () => {
		const { store, ledger } = setup();

		for (let index = 0; index < 20; index++) {
			const run = await store.createInterpretationRun({
				model: "jev-work-suggestion-v1",
				inputHash: `old-${index}`,
				eventIds: [],
			});

			await store.completeInterpretationRun(run.id, {
				outcome: "skipped",
			});
		}

		const source = await event(
			store,
			"slack",
			"new-policy-question",
			"Should we discuss graph options tomorrow?",
		);
		const judge = {
			judge: async () => ({
				kind: { choice: "discussion", confidence: 0.9 },
				target: { choice: "unrelated", confidence: 0.9 },
				concreteActionProbability: 0.05,
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("Unexpected LLM call");
			},
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		expect((await engine.run([source.event.id]))[0]?.outcome).toBe(
			"skipped",
		);
	});

	it("replays direct work requests before newer background discussion", async () => {
		const { store, ledger } = setup();
		const action = await event(
			store,
			"slack",
			"action-first",
			"Run the replay and verify source ordering.",
		);

		await event(
			store,
			"slack",
			"discussion-later",
			"The pipeline has many possible designs and tradeoffs to consider.",
		);

		const seen: string[] = [];
		const judge = {
			judge: async (bundle: { primaryEventId: string }) => {
				seen.push(bundle.primaryEventId);
				return {
					kind: { choice: "activity_only", confidence: 0.9 },
					concreteActionProbability: 0.1,
				};
			},
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("Unexpected LLM call");
			},
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		await engine.run(undefined, 1);
		expect(seen).toEqual([action.event.id]);
	});
	it("does not resend observations already screened by the current policy or duplicate source text", async () => {
		const { store, ledger } = setup();
		const old = await event(
			store,
			"slack",
			"already-screened",
			"Run a detailed source replay for the import path.",
		);
		const prior = await store.createInterpretationRun({
			model: "jev-work-suggestion-v7",
			inputHash: "previous",
			eventIds: [old.event.id],
		});

		await store.completeInterpretationRun(prior.id, { outcome: "skipped" });

		const fresh = await event(
			store,
			"slack",
			"fresh-one",
			"We need to verify the graph source ordering in detail.",
		);
		const duplicate = await event(
			store,
			"slack",
			"fresh-duplicate",
			"We need to verify the graph source ordering in detail.",
		);
		const seen: string[] = [];
		const judge = {
			judge: async (bundle: { primaryEventId: string }) => {
				seen.push(bundle.primaryEventId);
				return {
					kind: { choice: "activity_only", confidence: 0.9 },
					concreteActionProbability: 0.1,
				};
			},
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("Unexpected LLM call");
			},
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		await engine.run(undefined, 3);
		expect(seen).toHaveLength(1);
		expect([fresh.event.id, duplicate.event.id]).toContain(seen[0]);
	});
	it("retires a stale system Task suggestion without touching source evidence", async () => {
		const { store, ledger } = setup();
		const old = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "test",
			providerEventId: "old-request",
			eventKind: "message.observed",
			occurredAt: "2026-07-01T00:00:00Z",
			fetchedAt: "2026-07-01T00:00:00Z",
			sourceRef: "slack:old-request",
			sourceUrl: null,
			contentHash: "old-request",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				text: "Add the callback redirect URL to the service configuration.",
			},
		});
		const proposal = await ledger.proposeTaskCreation({
			externalRef: `panini:source:${old.event.id}`,
			title: "Add the callback redirect URL",
			rationale: "Previous source suggestion.",
			requestedBy: "system:work-suggestion",
			evidenceIds: [old.event.id],
		});
		const judge = {
			judge: async () => ({
				kind: { choice: "activity_only", confidence: 0.9 },
				concreteActionProbability: 0.1,
			}),
			supportsDraft: async () => 1,
		} as unknown as JevWorkJudge;
		const drafter = {
			draft: async () => {
				throw new Error("Unexpected LLM call");
			},
		};
		const engine = new WorkSuggestionEngine(store, ledger, judge, drafter, [
			"company",
		]);

		await engine.run([old.event.id]);
		expect((await store.getProposal(proposal.id))?.state).toBe("rejected");
		expect(await store.getSourceEvents([old.event.id])).toHaveLength(1);
	});
	it("shortlists an existing task when a Notion row contains its exact title", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{ title: "Collect data sources and create document" },
			"user:reviewer",
		);
		const source = await store.appendSourceEvent({
			provider: "notion",
			installationKey: "test",
			providerEventId: "notion-page-1",
			eventKind: "snapshot.retrieved",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: "notion:page:3b9a3e6b-d738-807b-a64d-da7d6f7d58a2",
			sourceUrl: null,
			contentHash: "notion-page-1",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				page: {
					parent: {
						data_source_id: "3b9a3e6b-d738-8082-9753-000bae65efcd",
					},
					properties: {
						Name: {
							type: "title",
							title: [{ plain_text: task.title }],
						},
						Status: {
							type: "status",
							status: { name: "In progress" },
						},
						Assign: {
							type: "people",
							people: [{ name: "Pariksheet Deshmukh" }],
						},
					},
				},
				blocks: [],
			},
		});

		await store.appendSourceEvent({
			provider: "notion",
			installationKey: "test",
			providerEventId: "notion-page-2",
			eventKind: "snapshot.retrieved",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: "notion:page:3b9a3e6b-d738-8018-a478-c3b1f880866b",
			sourceUrl: null,
			contentHash: "notion-page-2",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				page: {
					parent: {
						data_source_id: "3b9a3e6b-d738-8082-9753-000bae65efcd",
					},
					properties: {
						Name: {
							type: "title",
							title: [{ plain_text: "An unrelated work item" }],
						},
					},
				},
				blocks: [],
			},
		});

		const bundle = await ledger.workEvidenceBundle(source.event.id, [
			"company",
		]);

		expect(bundle.spans).toHaveLength(1);
		expect(bundle.references).toEqual([]);
		expect(bundle.spans[0]?.text).toContain("Assign: Pariksheet Deshmukh");
		expect(bundle.spans[0]?.text).not.toContain("3b9a3e6b-d738-8082");
		expect(bundle.candidates).toContainEqual({
			kind: "task",
			id: task.id,
			title: task.title,
			reason: "exact_name",
		});
	});

	it("joins exact references across sources but keeps them as candidates", async () => {
		const { store, ledger } = setup();
		const project = await ledger.createProject(
			{ name: "Import", outcome: "Ship a verified import." },
			"user:reviewer",
		);
		const task = await ledger.createTask(
			{
				title: "ACME-42 Ship import",
				project: "Import",
				projectId: project.id,
			},
			"user:reviewer",
		);
		const pull = await event(
			store,
			"github",
			"pr-7",
			"ACME-42 import PR merged; CI failing",
			"github:repository:acme/pilot",
		);
		const message = await event(
			store,
			"slack",
			"message-1",
			"ACME-42 is blocked on CI in Import",
		);

		await event(store, "slack", "message-2", "Unrelated lunch plans");

		const bundle = await ledger.workEvidenceBundle(pull.event.id, [
			"company",
			"github:repository:acme/pilot",
		]);

		expect(bundle.spans.map((span) => span.eventId)).toEqual(
			expect.arrayContaining([pull.event.id, message.event.id]),
		);
		expect(bundle.spans).toHaveLength(2);
		expect(bundle.candidates).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "task",
					id: task.id,
					reason: "exact_reference",
				}),
			]),
		);
		expect((await ledger.getTask(task.id))?.status).toBe("backlog");
		await expect(
			ledger.workEvidenceBundle(pull.event.id, ["company"]),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("shortlists a paraphrased existing task without treating lexical overlap as identity", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{
				title: "Run the June 15–July 31 CJP time-ordered evidence experiment",
			},
			"user:reviewer",
		);

		await ledger.createTask(
			{
				title: "Run the held-out calibration evaluation against market-only performance",
			},
			"user:reviewer",
		);

		const message = await event(
			store,
			"slack",
			"cjp-replay",
			"Check tweets fetched in the June 15 to July 31 timeline, filter the CJP reels, then run the evidence pipeline in posting-day order.",
		);
		const bundle = await ledger.workEvidenceBundle(message.event.id, [
			"company",
		]);

		expect(bundle.candidates).toContainEqual({
			kind: "task",
			id: task.id,
			title: task.title,
			reason: "lexical_overlap",
		});
		expect((await ledger.getTask(task.id))?.status).toBe("backlog");
	});

	it("keeps manual receipts out of the hosted work evidence bundle", async () => {
		const { store, ledger } = setup();
		const message = await event(
			store,
			"slack",
			"approved-request",
			"Run a source replay for ACME-42.",
		);

		await event(
			store,
			"manual",
			"private-receipt",
			"Run a source replay for ACME-42 with private notes.",
		);

		const bundle = await ledger.workEvidenceBundle(message.event.id, [
			"company",
		]);

		expect(bundle.spans.map((span) => span.provider)).toEqual(["slack"]);
	});

	it("finds a verbose existing task from two distinctive technical terms", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{
				title: "Figure out CPT initialization for the bayesian graph, or a better LLM-driven logLR",
			},
			"user:reviewer",
		);
		const message = await event(
			store,
			"slack",
			"cpt-loglr",
			"Figure out CPTs and logLR soon.",
		);
		const bundle = await ledger.workEvidenceBundle(message.event.id, [
			"company",
		]);

		expect(bundle.candidates).toContainEqual({
			kind: "task",
			id: task.id,
			title: task.title,
			reason: "lexical_overlap",
		});
	});

	it("uses an agent report's explicit work item ID and outcome as evidence", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{ title: "Verify import replay" },
			"user:reviewer",
		);
		const report = await store.appendSourceEvent({
			provider: "agent",
			installationKey: "profile-1",
			providerEventId: "report-1",
			eventKind: "work.checkpoint",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: `team-ledger:task:${task.id}`,
			sourceUrl: null,
			contentHash: "report-1",
			visibility: "company",
			payloadVersion: "work-report-v1",
			payload: {
				workItemId: task.id,
				phase: "checkpoint",
				outcome: "Replay found duplicate import rows.",
				verification: ["The duplicate-row check failed."],
			},
		});
		const bundle = await ledger.workEvidenceBundle(report.event.id, [
			"company",
		]);

		expect(bundle.candidates).toContainEqual({
			kind: "task",
			id: task.id,
			title: task.title,
			reason: "explicit_task_id",
		});
		expect(bundle.spans[0]?.text).toContain(
			"Replay found duplicate import rows.",
		);
	});

	it("pairs an exact GitHub branch mention and a named Notion plan with Slack evidence", async () => {
		const { store, ledger } = setup();
		const message = await event(
			store,
			"slack",
			"retest",
			"Retest feature/causal-edge against the Bayesian core development plan.",
		);
		const pull = await store.appendSourceEvent({
			provider: "github",
			installationKey: "12",
			providerEventId: "pr-8",
			eventKind: "pull_request.snapshot",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: "github:42:pull_request:8",
			sourceUrl: "https://github.com/acme/pilot/pull/8",
			contentHash: "pr-8",
			visibility: "github:repository:acme/pilot",
			payloadVersion: "test",
			payload: {
				title: "Causal edge",
				head: "feature/causal-edge",
				state: "open",
			},
		});
		const notion = await store.appendSourceEvent({
			provider: "notion",
			installationKey: "test",
			providerEventId: "plan-1",
			eventKind: "source.document.retrieved",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: "notion:plan-1",
			sourceUrl: null,
			contentHash: "plan-1",
			visibility: "company",
			payloadVersion: "test",
			payload: {
				document: {
					title: "Bayesian core development plan",
					markdown: "Build the causal graph.",
				},
			},
		});
		const bundle = await ledger.workEvidenceBundle(message.event.id, [
			"company",
			"github:repository:acme/pilot",
		]);

		expect(bundle.spans.map((span) => span.eventId)).toEqual(
			expect.arrayContaining([
				message.event.id,
				pull.event.id,
				notion.event.id,
			]),
		);
	});

	it("accepts only bounded typed Jev answers and never applies them", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{ title: "ACME-42 Ship import" },
			"user:reviewer",
		);
		const pull = await event(
			store,
			"github",
			"pr-7",
			"ACME-42 merged",
			"github:repository:acme/pilot",
		);
		const bundle = await ledger.workEvidenceBundle(pull.event.id, [
			"github:repository:acme/pilot",
		]);
		let requestBody: Record<string, unknown> | null = null;

		const judge = new JevWorkJudge({
			apiKey: "test-key",
			allowedVisibilities: ["github:repository:acme/pilot"],
			fetcher: (async (_url, init) => {
				requestBody = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;

				const choice = (selected: string, options: string[]) => ({
					type: "choice",
					choice: selected,
					confidence: 1,
					probabilities: Object.fromEntries(
						options.map((option) => [
							option,
							option === selected ? 1 : 0,
						]),
					),
				});

				const questions = (requestBody.questions ?? {}) as Record<
					string,
					{ criteria?: Record<string, string> }
				>;

				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: {
							kind: choice(
								"activity_only",
								Object.keys(questions.kind!.criteria!),
							),
							target: choice(
								"candidate_0",
								Object.keys(questions.target!.criteria!),
							),
							stage: choice(
								"delivery_candidate",
								Object.keys(questions.stage!.criteria!),
							),
							explicit_owner: { type: "noul", noul: 0.01 },
							concrete_action: { type: "noul", noul: 0.1 },
						},
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});

		const judgment = await judge.judge(bundle);

		expect(judgment).toMatchObject({
			selectedCandidate: { id: task.id },
			stage: { choice: "delivery_candidate" },
		});
		expect((requestBody as Record<string, unknown> | null)?.model).toBe(
			"typesafe/jev-1.13",
		);
		expect((await ledger.getTask(task.id))?.status).toBe("backlog");
	});

	it("rejects a malformed Jev probability distribution", async () => {
		const { store, ledger } = setup();
		const source = await event(
			store,
			"slack",
			"bad-distribution",
			"ACME-42 is under review",
		);
		const bundle = await ledger.workEvidenceBundle(source.event.id, [
			"company",
		]);

		const judge = new JevWorkJudge({
			apiKey: "test-key",
			allowedVisibilities: ["company"],
			fetcher: (async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as {
					questions: Record<
						string,
						{ criteria: Record<string, string> }
					>;
				};

				const choice = (name: string) => {
					const keys = Object.keys(body.questions[name]!.criteria);

					return {
						type: "choice",
						choice: keys[0],
						confidence: 0.8,
						probabilities: Object.fromEntries(
							keys.map((key) => [key, 0.5]),
						),
					};
				};

				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: {
							kind: choice("kind"),
							target: choice("target"),
							stage: choice("stage"),
							explicit_owner: { type: "noul", noul: 0.1 },
							concrete_action: { type: "noul", noul: 0.1 },
						},
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});

		await expect(judge.judge(bundle)).rejects.toThrow(
			"incomplete Choice distribution",
		);
	});

	it("keeps Project selection in Jev and bounds the visible Projects and evidence", async () => {
		const { store, ledger } = setup();
		const project = await ledger.createProject(
			{
				name: "Reel processing",
				outcome: "Process reels for evidence generation.",
			},
			"user:reviewer",
		);
		const source = await event(
			store,
			"slack",
			"ocr-deploy",
			"Deploy the OCR package for reel processing.",
		);
		const bundle = await ledger.workEvidenceBundle(source.event.id, [
			"company",
		]);
		let body: Record<string, any> = {};
		const judge = new JevWorkJudge({
			apiKey: "test",
			allowedVisibilities: ["company"],
			fetcher: (async (_url, init) => {
				body = JSON.parse(String(init?.body)) as Record<string, any>;

				const choices = Object.keys(body.questions.target.criteria);

				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: {
							target: {
								type: "choice",
								choice: "project_0",
								confidence: 0.9,
								probabilities: Object.fromEntries(
									choices.map((choice) => [
										choice,
										choice === "project_0" ? 0.9 : 0.05,
									]),
								),
							},
							relationship: { type: "noul", noul: 0.92 },
							distinct_outcome: { type: "noul", noul: 0.1 },
						},
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});

		expect(
			(
				await judge.judgeProject("Deploy the OCR package", bundle, [
					project,
				])
			).selectedProjectId,
		).toBe(project.id);
		expect(body.state.projects).toEqual([
			{
				option: "project_0",
				name: project.name,
				aliases: [],
				outcome: project.outcome,
			},
		]);
		expect(
			body.state.evidence.map(
				(item: { eventId: string }) => item.eventId,
			),
		).toEqual([source.event.id]);
	});

	it("lets the LLM write wording only for fixed target and evidence, then checks draft support separately", async () => {
		const { store, ledger } = setup();
		const task = await ledger.createTask(
			{ title: "ACME-42 Ship import" },
			"user:reviewer",
		);
		const source = await event(
			store,
			"slack",
			"assigned-work",
			"ACME-42 import must validate duplicate rows.",
		);
		const bundle = await ledger.workEvidenceBundle(source.event.id, [
			"company",
		]);
		let sent: Record<string, unknown> | null = null;
		const drafter = new OpenAIWorkProseDrafter({
			apiKey: "test-key",
			model: "test-model",
			allowedVisibilities: ["company"],
			fetcher: (async (_url, init) => {
				sent = JSON.parse(String(init?.body)) as Record<
					string,
					unknown
				>;
				return new Response(
					JSON.stringify({
						status: "completed",
						output_text: JSON.stringify({
							text: "Validate duplicate import rows.",
						}),
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});
		const draft = await drafter.draft(bundle, {
			kind: "task_description",
			candidateId: task.id,
			evidenceEventIds: [source.event.id],
		});

		expect(draft).toEqual({
			text: "Validate duplicate import rows.",
			model: "test-model",
			evidenceEventIds: [source.event.id],
		});

		const request = sent as Record<string, unknown> | null;

		expect(request?.store).toBe(false);
		expect(JSON.parse(String(request?.input))).toMatchObject({
			kind: "task_description",
			selectedCandidate: { title: task.title },
			evidence: [{ eventId: source.event.id }],
		});
		await expect(
			drafter.draft(bundle, {
				kind: "task_title",
				candidateId: "wrong-id",
				evidenceEventIds: [source.event.id],
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		const judge = new JevWorkJudge({
			apiKey: "test-key",
			allowedVisibilities: ["company"],
			fetcher: (async (_url, init) => {
				const body = JSON.parse(String(init?.body)) as {
					questions: Record<string, unknown>;
				};

				expect(Object.keys(body.questions)).toEqual(["supported"]);
				return new Response(
					JSON.stringify({
						model: "typesafe/jev-1.13-20260917",
						answers: {
							supported: { type: "noul", noul: 0.9 },
						},
					}),
					{ status: 200 },
				);
			}) as typeof fetch,
		});

		expect(await judge.supportsDraft(bundle, draft)).toBe(0.9);
		expect((await ledger.getTask(task.id))?.description).toBe("");
	});
});
