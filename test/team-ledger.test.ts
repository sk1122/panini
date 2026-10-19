import { describe, expect, it } from "vitest";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { Observation, TaskFields } from "../src/domain/types.js";
import { MemoryLedgerStore } from "../src/store/memory.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { renderContextPackMarkdown } from "../src/retrieval/context-compiler.js";

const baseFields: TaskFields = {
	externalRef: "notion:page:task-1",
	title: "Ship the onboarding guide",
	description: "Document the first-run path.",
	status: "in_progress",
	priority: "high",
	owner: "Rina",
	project: "Onboarding",
	dueDate: "2026-09-18",
	dependencyRefs: [],
	sourceUrl: "https://notion.so/task-1",
};

function taskObservation(
	id: string,
	fields: TaskFields = baseFields,
): Observation {
	return {
		event: {
			provider: "legacy-board",
			installationKey: "default",
			providerEventId: id,
			eventKind: "snapshot.retrieved",
			occurredAt: "2026-09-12T08:00:00.000Z",
			fetchedAt: "2026-09-12T08:01:00.000Z",
			sourceRef: fields.externalRef!,
			sourceUrl: fields.sourceUrl,
			contentHash: id,
			visibility: "company",
			payloadVersion: "test",
			payload: { id },
		},
		signal: { type: "task_snapshot", fields },
	};
}

function makeLedger() {
	const store = new MemoryLedgerStore();
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			autoApproveNewTasks: true,
			autoApproveContext: true,
			requireReviewForTaskChanges: true,
		}),
	);

	return { ledger, store };
}

async function importAndApprove(ledger: TeamLedger, observation: Observation) {
	const result = await ledger.ingest(observation);

	if (!result.proposal)
		throw new Error("Expected a pending import proposal.");

	const task = await ledger.approveProposal(
		result.proposal.id,
		"user:reviewer",
		"Reviewed source task.",
	);

	if (!("version" in task)) throw new Error("Expected an accepted task.");
	return { ...result, task };
}

describe("TeamLedger", () => {
	it("reconciles Notion and Slack identities into one organization member", async () => {
		const { ledger } = makeLedger();
		const notion = await ledger.reconcileMemberIdentity(
			{
				provider: "notion",
				installationKey: "default",
				externalId: "person-mira",
				displayName: "Mira Shah",
				email: "mira@example.test",
				status: "active",
			},
			"connector:notion-members",
		);
		const slack = await ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T1",
				externalId: "U-MIRA",
				displayName: "  Mira Shah  ",
				status: "active",
			},
			"connector:slack-members",
		);

		expect(notion).toMatchObject({
			matchedBy: "created",
			member: { displayName: "Mira Shah" },
		});
		expect(slack).toMatchObject({
			matchedBy: "display_name",
			member: { id: notion.member!.id },
		});

		const workspace = await ledger.workspace();

		expect(
			workspace.members.filter(
				(member) => member.subject !== "bootstrap:local-admin",
			),
		).toHaveLength(1);
		expect(workspace.memberIdentities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					memberId: notion.member!.id,
					provider: "notion",
					externalId: "person-mira",
				}),
				expect.objectContaining({
					memberId: notion.member!.id,
					provider: "slack",
					externalId: "U-MIRA",
				}),
			]),
		);
	});

	it("keeps ambiguous provider identities separate and resolves opaque identities only after a profile arrives", async () => {
		const { ledger, store } = makeLedger();
		const first = await store.upsertMember({
			subject: "manual:alex-one",
			displayName: "Alex",
		});
		const second = await store.upsertMember({
			subject: "manual:alex-two",
			displayName: "Alex",
		});
		const ambiguous = await ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T1",
				externalId: "U-ALEX",
				displayName: "Alex",
			},
			"connector:slack-members",
		);

		expect(ambiguous).toMatchObject({
			matchedBy: "created",
			member: { displayName: "Alex" },
		});
		expect(ambiguous.member?.id).not.toBe(first.id);
		expect(ambiguous.member?.id).not.toBe(second.id);

		const unresolved = await ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T1",
				externalId: "U-OPAQUE",
				displayName: null,
			},
			"connector:slack-messages",
		);

		expect(unresolved).toMatchObject({
			matchedBy: "unresolved",
			member: null,
			identity: { memberId: null },
		});

		const resolved = await ledger.reconcileMemberIdentity(
			{
				provider: "slack",
				installationKey: "T1",
				externalId: "U-OPAQUE",
				displayName: "Priya",
			},
			"connector:slack-members",
		);

		expect(resolved).toMatchObject({
			matchedBy: "created",
			member: { displayName: "Priya" },
		});
		expect(resolved.identity.id).toBe(unresolved.identity.id);
		expect(resolved.identity.memberId).toBe(resolved.member?.id);
	});

	it("holds a new source task for review and deduplicates its evidence", async () => {
		const { ledger } = makeLedger();
		const first = await ledger.ingest(taskObservation("snapshot-1"));

		expect(first.duplicate).toBe(false);
		expect(first.proposal?.state).toBe("pending");
		expect(first.task).toBeNull();
		expect((await ledger.board()).tasks).toHaveLength(0);

		const accepted = await ledger.approveProposal(
			first.proposal!.id,
			"user:reviewer",
			"Reviewed source task.",
		);

		expect(accepted).toMatchObject({ title: baseFields.title, version: 1 });

		const duplicate = await ledger.ingest(taskObservation("snapshot-1"));

		expect(duplicate).toEqual({
			duplicate: true,
			proposal: null,
			task: null,
		});
		expect((await ledger.board()).tasks).toHaveLength(1);

		const detail = await ledger.taskDetail(accepted.id);

		expect(detail.proposals).toMatchObject([
			{
				id: first.proposal!.id,
				kind: "task_create",
				evidenceIds: [expect.any(String)],
			},
		]);
		expect(detail.evidence).toMatchObject([
			{
				provider: "legacy-board",
				sourceRef: baseFields.externalRef,
			},
		]);
	});

	it("keeps Notion task rows as evidence without proposing Tasks", async () => {
		const { ledger, store } = makeLedger();
		const first = taskObservation("notion-row-1");

		first.event.provider = "notion";

		const result = await ledger.ingest(first);

		expect(result).toEqual({
			duplicate: false,
			proposal: null,
			task: null,
		});
		expect((await ledger.board()).tasks).toEqual([]);
		expect((await ledger.board()).proposals).toEqual([]);
		expect((await store.listSourceEvents(10))[0]).toMatchObject({
			provider: "notion",
			sourceRef: baseFields.externalRef,
		});
	});

	it("holds connector changes for review until a person approves them", async () => {
		const { ledger, store } = makeLedger();
		const imported = await importAndApprove(
			ledger,
			taskObservation("snapshot-1"),
		);
		const taskId = imported.task!.id;
		const changedFields: TaskFields = {
			...baseFields,
			status: "done",
			owner: "Mateo",
		};

		const result = await ledger.ingest(
			taskObservation("snapshot-2", changedFields),
		);

		expect(result.proposal).toMatchObject({
			state: "pending",
			changes: { status: "done", owner: "Mateo" },
		});
		expect((await ledger.getTask(taskId))?.status).toBe("in_progress");

		const approved = await ledger.approveProposal(
			result.proposal!.id,
			"user:reviewer",
			"Matched the source page.",
		);

		expect(approved).toMatchObject({
			status: "done",
			owner: "Mateo",
			version: 2,
		});
		expect(await store.listTaskRevisions(taskId)).toHaveLength(2);
		expect(
			(await store.listAuditEvents(100)).filter(
				(event) => event.proposalId === result.proposal!.id,
			),
		).toMatchObject([
			{ action: "proposal.approved", targetId: result.proposal!.id },
		]);
		expect(
			(await store.listOutboxJobs(100)).filter(
				(job) =>
					typeof job.payload === "object" &&
					job.payload !== null &&
					!Array.isArray(job.payload) &&
					job.payload.proposalId === result.proposal!.id,
			),
		).toMatchObject([
			{ state: "pending", topic: "projection.task.revised", attempts: 0 },
		]);
	});

	it("leases outbox jobs to one worker and records retries durably", async () => {
		const { ledger, store } = makeLedger();

		await ledger.createTask({ title: "Dispatch me once" }, "user:reviewer");

		const [claimed] = await store.claimOutboxJobs("worker:one", 1, 30);

		expect(claimed).toMatchObject({
			state: "running",
			attempts: 1,
			lockedBy: "worker:one",
		});
		await expect(
			store.completeOutboxJob(claimed!.id, "worker:two"),
		).rejects.toMatchObject({ code: "CONFLICT" });

		const retried = await store.failOutboxJob(
			claimed!.id,
			"worker:one",
			"temporary transport failure",
			"2000-01-01T00:00:00.000Z",
		);

		expect(retried).toMatchObject({
			state: "pending",
			lockedBy: null,
			lastError: "temporary transport failure",
		});

		const [reclaimed] = await store.claimOutboxJobs("worker:two", 1, 30);

		expect(reclaimed).toMatchObject({
			id: claimed!.id,
			state: "running",
			attempts: 2,
			lockedBy: "worker:two",
		});
		expect(
			await store.completeOutboxJob(reclaimed!.id, "worker:two"),
		).toMatchObject({ state: "completed", lockedBy: null });
	});

	it("rejects a stale proposal without partially approving it", async () => {
		const { ledger } = makeLedger();
		const imported = await importAndApprove(
			ledger,
			taskObservation("snapshot-1"),
		);
		const first = await ledger.propose({
			taskId: imported.task!.id,
			changes: { status: "review" },
			rationale: "Implementation is ready for review.",
			requestedBy: "agent:one",
		});
		const second = await ledger.propose({
			taskId: imported.task!.id,
			changes: { status: "blocked" },
			rationale: "A dependency is unavailable.",
			requestedBy: "agent:two",
		});

		await ledger.approveProposal(first.id, "user:reviewer", null);
		await expect(
			ledger.approveProposal(second.id, "user:reviewer", null),
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect((await ledger.getProposal(second.id))?.state).toBe("pending");
	});

	it("keeps source documents as evidence and revokes the superseded snapshot without accepting raw memory", async () => {
		const { ledger } = makeLedger();

		const observation = (id: string, body: string): Observation => ({
			event: {
				provider: "notion",
				installationKey: "default",
				providerEventId: id,
				eventKind: "snapshot.retrieved",
				occurredAt: "2026-09-12T08:00:00.000Z",
				fetchedAt: "2026-09-12T08:01:00.000Z",
				sourceRef: "notion:page:handbook",
				sourceUrl: "https://notion.so/handbook",
				contentHash: id,
				visibility: "company",
				payloadVersion: "test",
				payload: { body },
			},
			signal: {
				type: "source_document_snapshot",
				suggestedPath: "/company/handbook",
				title: "Handbook",
			},
		});

		await ledger.ingest(observation("context-1", "First edition"));
		await ledger.ingest(observation("context-2", "Second edition"));
		expect((await ledger.contextPack()).entries).toEqual([]);
		expect(await ledger.listEvidence()).toMatchObject([
			{
				providerEventId: "context-2",
				payload: { body: "Second edition" },
			},
		]);
	});

	it("preserves proposal history when editing and rebases stale changes explicitly", async () => {
		const { ledger } = makeLedger();
		const imported = await importAndApprove(
			ledger,
			taskObservation("snapshot-1"),
		);
		const original = await ledger.propose({
			taskId: imported.task!.id,
			changes: { status: "blocked" },
			rationale: "A dependency is missing.",
			requestedBy: "agent:one",
		});
		const edited = await ledger.editProposal(
			original.id,
			{ status: "review" },
			"The dependency arrived.",
			"user:reviewer",
		);

		expect(await ledger.getProposal(original.id)).toMatchObject({
			state: "superseded",
		});
		expect(edited).toMatchObject({
			state: "pending",
			changes: { status: "review" },
		});

		const competing = await ledger.propose({
			taskId: imported.task!.id,
			changes: { owner: "Mateo" },
			rationale: "Ownership moved.",
			requestedBy: "agent:two",
		});

		await ledger.approveProposal(competing.id, "user:reviewer", null);
		expect((await ledger.proposalDetail(edited.id)).stale).toBe(true);

		const rebased = await ledger.rebaseProposal(edited.id, "user:reviewer");

		expect(rebased.baseVersion).toBe(2);
		expect((await ledger.proposalDetail(rebased.id)).stale).toBe(false);
	});

	it("deduplicates agent proposal retries durably and requires the caller's base revision", async () => {
		const { ledger } = makeLedger();
		const task = (
			await importAndApprove(
				ledger,
				taskObservation("idempotent-agent-proposal"),
			)
		).task;
		const input = {
			clientEventId: "agent-command-1",
			taskId: task.id,
			baseRevision: task.version,
			changes: { status: "blocked" as const },
			rationale: "A named dependency is unavailable.",
			requestedBy: "agent:one",
			evidenceIds: [],
		};
		const first = await ledger.propose(input);

		expect((await ledger.propose(input)).id).toBe(first.id);
		await ledger.approveProposal(first.id, "user:reviewer", null);
		expect(await ledger.propose(input)).toMatchObject({
			id: first.id,
			state: "approved",
		});

		await expect(
			ledger.propose({ ...input, changes: { status: "done" } }),
		).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(
			ledger.propose({
				...input,
				clientEventId: "agent-command-2",
				changes: { owner: "Mira" },
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("undoes an accepted change by writing a new revision", async () => {
		const { ledger } = makeLedger();
		const imported = await importAndApprove(
			ledger,
			taskObservation("snapshot-1"),
		);
		const proposal = await ledger.propose({
			taskId: imported.task!.id,
			changes: { status: "done" },
			rationale: "Delivery was verified.",
			requestedBy: "agent:one",
		});

		await ledger.approveProposal(proposal.id, "user:reviewer", null);

		const undone = await ledger.undoTask(
			imported.task!.id,
			"user:reviewer",
			"Completion was premature.",
		);

		expect(undone).toMatchObject({ status: "in_progress", version: 3 });
		expect((await ledger.taskDetail(undone.id)).revisions).toHaveLength(3);
	});

	it("undoes a Project link when the original Task had no projectId field", async () => {
		const { ledger, store } = makeLedger();
		const project = await ledger.createProject(
			{ name: "Bayesian core", outcome: "Verify Bayesian updates." },
			"user:reviewer",
		);
		const task = await ledger.createTask(
			{ title: "Measure propagation" },
			"user:reviewer",
		);
		const proposal = await ledger.propose({
			taskId: task.id,
			changes: { projectId: project.id, project: project.name },
			rationale: "Link to the cited plan.",
			requestedBy: "agent:one",
		});

		await ledger.approveProposal(proposal.id, "user:reviewer", null);

		const undone = await ledger.undoTask(
			task.id,
			"user:reviewer",
			null,
			"undo-project-link",
		);

		expect(undone.projectId).toBeNull();
		expect(undone.project).toBeNull();

		const undoProposal = await store.findProposalByClientEvent(
			"user:reviewer",
			"undo-project-link",
		);

		expect(undoProposal?.changes).toEqual({
			projectId: null,
			project: null,
		});
	});

	it("retrieves accepted context with citations and a version manifest", async () => {
		const { ledger, store } = makeLedger();

		await ledger.createContextEntry(
			{
				kind: "file",
				clientEventId: "context-search",
				path: "/policies/deployments.md",
				title: "Deployment policy",
				body: "Production deployments require review.",
			},
			"user:reviewer",
		);

		const result = await ledger.retrieve({
			objective: "prepare a production deployment",
			query: "review",
			characterBudget: 2_000,
		});

		expect(result).toMatchObject({
			provider: "postgres",
			entries: [{ path: "/policies/deployments.md" }],
			citations: [
				{ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
			],
			manifest: {
				returnedCount: 1,
				entryVersions: [
					{ contentHash: expect.stringMatching(/^[a-f0-9]{64}$/) },
				],
			},
		});

		const evidenceId = result.entries[0]!.evidenceIds[0]!;

		expect(await ledger.revokeEvidence(evidenceId, "user:admin")).toBe(
			true,
		);

		const afterDeletion = await ledger.retrieve({
			objective: "prepare a production deployment",
			query: "review",
		});

		expect(afterDeletion.entries).toEqual([]);
		expect(await ledger.getContextEntry(result.entries[0]!.id)).toBeNull();
		expect(await new ReplayVerifier(store).verify()).toMatchObject({
			ok: true,
			tasks: { ok: true },
			context: { ok: true },
		});
	});

	it("abstains when an explicit query has only a weak lexical overlap", async () => {
		const { ledger } = makeLedger();

		await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/architecture/retrieval-protocol",
				title: "Retrieval protocol",
				factType: "constraint",
				value: "Use deterministic ranking for accepted context.",
			},
			"user:reviewer",
		);

		const result = await ledger.retrieve({
			objective: "Find the payroll security rule",
			query: "quasar payroll rotation protocol",
			characterBudget: 8_000,
		});

		expect(result.status).toBe("abstained");
		expect(result.abstentionReason).toContain(
			"No sufficiently relevant accepted context or work matched",
		);
		expect(result.entries).toEqual([]);
	});

	it("keeps both structured and rendered context packs inside the declared response budget", async () => {
		const { ledger } = makeLedger();

		await ledger.createContextEntry(
			{
				kind: "file",
				path: "/architecture/oversized.md",
				title: "Oversized architecture",
				body: `# Architecture\n\n${"verified design detail ".repeat(1_000)}`,
			},
			"user:reviewer",
		);

		const result = await ledger.retrieve({
			objective: "Read the oversized architecture",
			query: "oversized architecture",
			characterBudget: 8_000,
		});
		const rendered = renderContextPackMarkdown(result);

		expect(JSON.stringify(result).length).toBeLessThanOrEqual(8_000);
		expect(rendered.length).toBeLessThanOrEqual(8_000);
		expect(result.manifest.usedCharacters).toBe(
			Math.max(JSON.stringify(result).length, rendered.length),
		);
		expect(result.omitted).toContainEqual(
			expect.objectContaining({ reason: "character_budget" }),
		);
	});

	it("quarantines unsafe context through an immutable lifecycle revision and preserves temporal scope", async () => {
		const { ledger } = makeLedger();
		const entry = await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/projects/alpha/release-gate",
				title: "Alpha release gate",
				factType: "policy",
				value: "Use the approved release gate.",
				effectiveFrom: "2026-09-01T00:00:00.000Z",
				links: [
					{ type: "project", targetId: null, targetRef: "Alpha" },
				],
			},
			"user:reviewer",
		);

		const alpha = await ledger.retrieve({
			objective: "Read the Alpha release policy",
			query: "Alpha release gate",
			project: "Alpha",
			at: "2026-09-17T10:00:00.000Z",
		});
		const beta = await ledger.retrieve({
			objective: "Read the Beta release policy",
			query: "release gate",
			project: "Beta",
			at: "2026-09-17T10:00:00.000Z",
		});

		expect(alpha.entries).toEqual([
			expect.objectContaining({
				id: entry.id,
				lifecycleState: "accepted",
			}),
		]);
		expect(beta.entries).toEqual([]);

		const quarantined = await ledger.reviseContextLifecycle(
			entry.id,
			{
				lifecycleState: "needs_review",
				reason: "The operational state is stale and must be reverified.",
				clientEventId: "quarantine-alpha-release-gate",
			},
			"user:reviewer",
		);

		expect(quarantined).toMatchObject({
			id: entry.id,
			lifecycleState: "needs_review",
		});
		expect(
			(
				await ledger.retrieve({
					objective: "Read the Alpha release policy",
					query: "Alpha release gate",
					project: "Alpha",
					at: "2026-09-17T10:00:00.000Z",
				})
			).entries,
		).toEqual([]);

		const detail = await ledger.contextDetail(entry.id);

		expect(detail.revisions).toHaveLength(2);
		expect(detail.revisions[1]).toMatchObject({
			previous: { lifecycleState: "accepted" },
			current: { lifecycleState: "needs_review" },
		});
		expect(detail.entry.evidenceIds).toHaveLength(2);
	});

	it("does not retrieve accepted context outside its effective interval", async () => {
		const { ledger } = makeLedger();

		await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/plans/completed-rollout",
				title: "Completed rollout window",
				factType: "reference",
				value: "The rollout ran during the first week of September.",
				effectiveFrom: "2026-09-01T00:00:00.000Z",
				effectiveTo: "2026-09-08T00:00:00.000Z",
			},
			"user:reviewer",
		);

		expect(
			(
				await ledger.retrieve({
					objective: "Reconstruct the rollout",
					query: "completed rollout window",
					at: "2026-09-05T00:00:00.000Z",
				})
			).entries,
		).toHaveLength(1);
		expect(
			(
				await ledger.retrieve({
					objective: "Understand the current rollout",
					query: "completed rollout window",
					at: "2026-09-17T00:00:00.000Z",
				})
			).entries,
		).toEqual([]);
	});

	it("returns evidence only for context revisions visible to the requesting agent", async () => {
		const { ledger, store } = makeLedger();
		const publicEvidence = await store.appendSourceEvent({
			provider: "manual",
			installationKey: "reviewer",
			providerEventId: "public-history-evidence",
			eventKind: "context.fact.reviewed",
			occurredAt: "2026-09-15T08:00:00.000Z",
			fetchedAt: "2026-09-15T08:00:01.000Z",
			sourceRef: "manual:release-gate",
			sourceUrl: null,
			contentHash: "public-history-evidence",
			visibility: "company",
			payloadVersion: "test",
			payload: { value: "Public release gate." },
		});
		const privateEvidence = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "workspace",
			providerEventId: "private-history-evidence",
			eventKind: "message.explicitly_captured",
			occurredAt: "2026-09-16T08:00:00.000Z",
			fetchedAt: "2026-09-16T08:00:01.000Z",
			sourceRef: "slack:T1:C-PRIVATE:1",
			sourceUrl: "https://slack.example/private/1",
			contentHash: "private-history-evidence",
			visibility: "slack:channel:C-PRIVATE",
			payloadVersion: "test",
			payload: { text: "Private replacement gate." },
		});
		const first = await ledger.proposeContextFact({
			sourceRef: "company:release-gate",
			path: "/policies/release-gate",
			title: "Release gate",
			factType: "policy",
			value: "Public release gate.",
			rationale: "Publish the reviewed company policy.",
			requestedBy: "member:reviewer",
			evidenceIds: [publicEvidence.event.id],
		});
		const entry = await ledger.approveProposal(
			first.id,
			"member:reviewer",
			"Approved public policy.",
		);
		const replacement = await ledger.proposeContextFact({
			sourceRef: "company:release-gate",
			path: "/policies/release-gate",
			title: "Release gate",
			factType: "policy",
			value: "Private replacement gate.",
			rationale: "Replace the policy from a private discussion.",
			requestedBy: "member:reviewer",
			evidenceIds: [privateEvidence.event.id],
		});

		await ledger.approveProposal(
			replacement.id,
			"member:reviewer",
			"Approved private replacement.",
		);

		const workspace = await ledger.workspace();
		const history = await ledger.contextHistoryForAccess(entry.id, {
			kind: "agent",
			organizationId: workspace.organization.id,
			memberId: workspace.members[0]!.id,
			agentProfileId: "00000000-0000-4000-8000-000000000099",
			dataScope: {
				projects: [],
				contextPaths: ["/policies"],
				sourceVisibilities: ["company"],
			},
		});

		expect(history.revisions).toHaveLength(1);
		expect(history.revisions[0]!.current).toMatchObject({
			kind: "fact",
			value: "Public release gate.",
		});
		expect(history.evidence).toEqual([
			expect.objectContaining({
				id: publicEvidence.event.id,
				visibility: "company",
			}),
		]);
		expect(history.evidence).not.toContainEqual(
			expect.objectContaining({ id: privateEvidence.event.id }),
		);
	});

	it("compiles an agent-readable context outline and reconciled work brief", async () => {
		const { ledger } = makeLedger();
		const blocked = await importAndApprove(
			ledger,
			taskObservation("context-task-blocked", {
				...baseFields,
				externalRef: "WORK-1",
				title: "Restore the source credential",
				status: "blocked",
			}),
		);
		const planned = await importAndApprove(
			ledger,
			taskObservation("context-task-planned", {
				...baseFields,
				externalRef: "WORK-2",
				title: "Run the verified pipeline",
				status: "planned",
				dependencyRefs: ["WORK-1"],
			}),
		);
		const done = await importAndApprove(
			ledger,
			taskObservation("context-task-done", {
				...baseFields,
				externalRef: "WORK-3",
				title: "Create the repository",
				status: "done",
			}),
		);

		await ledger.createContextEntry(
			{
				kind: "file",
				path: "/architecture/pipeline.md",
				title: "Pipeline architecture",
				body: "```mermaid\nflowchart LR\n  A --> B\n```",
			},
			"user:reviewer",
		);
		await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/policies/completion",
				title: "Completion policy",
				factType: "policy",
				value: "Verify delivery before marking work done.",
			},
			"user:reviewer",
		);

		const result = await ledger.retrieve({
			objective: "Understand the system and current work",
			query: "",
			limit: 20,
			characterBudget: 10_000,
		});

		expect(result.outline).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					key: "architecture",
					entries: [
						expect.objectContaining({
							path: "/architecture/pipeline.md",
						}),
					],
				}),
				expect.objectContaining({
					key: "policies",
					entries: [
						expect.objectContaining({
							path: "/policies/completion",
						}),
					],
				}),
			]),
		);
		expect(result.work).toMatchObject({
			counts: { total: 3, remaining: 2, completed: 1, cancelled: 0 },
			blockedTaskIds: [blocked.task!.id],
			remainingTaskIds: [planned.task!.id],
			recentlyCompletedTaskIds: [done.task!.id],
			dependencyEdges: [
				{
					taskId: planned.task!.id,
					dependsOnTaskId: blocked.task!.id,
					reference: "WORK-1",
				},
			],
			pendingProposalIds: [],
			escalatedProposalIds: [],
		});

		const markdown = renderContextPackMarkdown(result);

		expect(markdown).toContain("# Agent context pack");
		expect(markdown).toContain("### Blocked");
		expect(markdown).toContain("### Remaining");
		expect(markdown).toContain("### Recently completed");
		expect(markdown).toContain("flowchart LR");
	});

	it("replays accepted task and context revisions to the same projection hashes", async () => {
		const { ledger, store } = makeLedger();

		await importAndApprove(ledger, taskObservation("replay-task"));
		await ledger.createContextEntry(
			{
				kind: "file",
				clientEventId: "replay-context",
				path: "/decisions/replay.md",
				title: "Replay",
				body: "Rebuild from revisions.",
			},
			"user:reviewer",
		);

		const result = await new ReplayVerifier(store).verify();

		expect(result).toMatchObject({
			ok: true,
			tasks: { projectionCount: 1, replayedCount: 1, ok: true },
			context: { projectionCount: 1, replayedCount: 1, ok: true },
		});
		expect(result.tasks.projectionHash).toBe(result.tasks.replayedHash);
		expect(result.context.projectionHash).toBe(result.context.replayedHash);
	});

	it("projects accepted project and typed dependency records", async () => {
		const { ledger } = makeLedger();
		const project = await ledger.createProject(
			{ name: "Launch", outcome: "Release the product." },
			"user:reviewer",
		);
		const prerequisite: TaskFields = {
			...baseFields,
			externalRef: "notion:page:foundation",
			title: "Build the foundation",
			project: "Launch",
		};
		const dependent: TaskFields = {
			...baseFields,
			externalRef: "notion:page:release",
			title: "Release the product",
			project: "Launch",
			dependencyRefs: [
				"notion:page:foundation",
				"external:legal-approval",
			],
		};
		const foundation = (
			await importAndApprove(
				ledger,
				taskObservation("graph-foundation", prerequisite),
			)
		).task;
		const release = (
			await importAndApprove(
				ledger,
				taskObservation("graph-release", dependent),
			)
		).task;

		const graph = await ledger.workGraph();

		expect(graph.projects).toMatchObject([
			{ name: "Launch", status: "active" },
		]);
		expect(release.projectId).toBe(project.id);
		expect(graph.workstreams).toEqual([]);
		expect(graph.links).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					taskId: release.id,
					targetTaskId: foundation.id,
					targetRef: prerequisite.externalRef,
					linkType: "depends_on",
				}),
				expect.objectContaining({
					taskId: release.id,
					targetTaskId: null,
					targetRef: "external:legal-approval",
					linkType: "depends_on",
				}),
			]),
		);
	});

	it("keeps project changes in a cited, versioned review path", async () => {
		const { ledger, store } = makeLedger();
		const project = await ledger.createProject(
			{ name: "Launch", outcome: "Ship the first release." },
			"user:reviewer",
		);
		const evidence = await store.appendSourceEvent({
			provider: "manual",
			installationKey: "user:reviewer",
			providerEventId: "project-update",
			eventKind: "project.decision",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:00:00Z",
			sourceRef: "manual:project-update",
			sourceUrl: null,
			contentHash: "project-update",
			visibility: "company",
			payloadVersion: "test",
			payload: { decision: "Launch is ready for review." },
		});
		const proposal = await ledger.proposeProjectChange(project.id, {
			baseVersion: 1,
			changes: { status: "paused", outcome: "Wait for launch approval." },
			rationale: "Approval is pending.",
			requestedBy: "agent:test",
			evidenceIds: [evidence.event.id],
		});

		expect((await ledger.projectDetail(project.id)).project.status).toBe(
			"active",
		);

		const revision = await ledger.approveProjectProposal(
			proposal.id,
			"user:reviewer",
			"Confirmed the approval gate.",
		);

		expect(revision.current).toMatchObject({
			id: project.id,
			version: 2,
			status: "paused",
		});
		expect((await ledger.projectDetail(project.id)).revisions).toHaveLength(
			2,
		);
		await expect(
			ledger.proposeProjectChange(project.id, {
				baseVersion: 1,
				changes: { status: "completed" },
				rationale: "Stale update.",
				requestedBy: "agent:test",
				evidenceIds: [evidence.event.id],
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("shows exact-reference GitHub activity without changing accepted task status", async () => {
		const { ledger, store } = makeLedger();
		const task = await ledger.createTask(
			{ title: "ACME-42 Ship import", status: "in_progress" },
			"user:reviewer",
		);
		const receipt = await store.appendSourceEvent({
			provider: "github",
			installationKey: "12",
			providerEventId: "pull-7",
			eventKind: "pull_request.snapshot",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: "github:42:pull_request:7",
			sourceUrl: "https://github.com/acme/pilot/pull/7",
			contentHash: "pull-7",
			visibility: "github:repository:acme/pilot",
			payloadVersion: "test",
			payload: {
				title: "ACME-42 implementation",
				state: "closed",
				mergedAt: "2026-09-20T00:00:00Z",
			},
		});

		expect((await ledger.taskDetail(task.id)).activityCandidates).toEqual([
			expect.objectContaining({
				id: receipt.event.id,
				eventKind: "pull_request.snapshot",
			}),
		]);
		expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
		await ledger.revokeEvidence(receipt.event.id, "user:reviewer");
		expect((await ledger.taskDetail(task.id)).activityCandidates).toEqual(
			[],
		);
	});

	it("shows an agent report on its explicit task and preserves accepted status", async () => {
		const { ledger, store } = makeLedger();
		const task = await ledger.createTask(
			{ title: "Verify import replay", status: "in_progress" },
			"user:reviewer",
		);
		const report = await store.appendSourceEvent({
			provider: "agent",
			installationKey: "profile-1",
			providerEventId: "checkpoint-1",
			eventKind: "work.checkpoint",
			occurredAt: "2026-09-20T00:00:00Z",
			fetchedAt: "2026-09-20T00:01:00Z",
			sourceRef: `team-ledger:task:${task.id}`,
			sourceUrl: null,
			contentHash: "checkpoint-1",
			visibility: "company",
			payloadVersion: "work-report-v1",
			payload: {
				workItemId: task.id,
				phase: "checkpoint",
				outcome: "Replay found duplicate rows.",
			},
		});

		expect(
			(await ledger.taskDetail(task.id)).activityCandidates,
		).toContainEqual(
			expect.objectContaining({
				id: report.event.id,
				eventKind: "work.checkpoint",
			}),
		);
		expect((await ledger.getTask(task.id))?.status).toBe("in_progress");
	});

	it("previews and applies a guarded projection rebuild from immutable revisions", async () => {
		const { ledger, store } = makeLedger();

		await importAndApprove(ledger, taskObservation("rebuild-task"));

		const replay = new ReplayVerifier(store);
		const preview = await replay.rebuild({
			apply: false,
			actor: "operator:test",
		});

		expect(preview).toMatchObject({
			applied: false,
			eligible: true,
			before: { ok: true },
			after: { ok: true },
		});

		const applied = await replay.rebuild({
			apply: true,
			actor: "operator:test",
		});

		expect(applied).toMatchObject({
			applied: true,
			eligible: true,
			after: { ok: true },
		});
		expect(await store.listAuditEvents(10)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "projection.rebuilt",
					actor: "operator:test",
				}),
			]),
		);
	});
});
