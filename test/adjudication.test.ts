import { describe, expect, it, vi } from "vitest";
import { AutonomousAdjudicator } from "../src/adjudication/engine.js";
import { adjudicationJsonSchemaFor } from "../src/adjudication/schema.js";
import type {
	AdjudicationBatchInput,
	AdjudicationBatchOutput,
	AdjudicationConfig,
	AdjudicationProvider,
} from "../src/adjudication/types.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import type { SourceEventInput } from "../src/domain/types.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const config: AdjudicationConfig = {
	enabled: true,
	mode: "manual",
	intervalSeconds: 30,
	maxProposalsPerRun: 20,
	maxEvidenceCharacters: 80_000,
	maxHistoryCharacters: 60_000,
	maxHistoryItems: 30,
	approvalMinimumConfidence: 0.8,
};

class StubAdjudicator implements AdjudicationProvider {
	readonly name = "stub:adjudicator";
	readonly adjudicate =
		vi.fn<
			(input: AdjudicationBatchInput) => Promise<AdjudicationBatchOutput>
		>();

	constructor(
		output: (input: AdjudicationBatchInput) => AdjudicationBatchOutput,
	) {
		this.adjudicate.mockImplementation(async (input) => output(input));
	}
}

function evidence(
	providerEventId: string,
	occurredAt: string,
	payload: SourceEventInput["payload"] = {},
): SourceEventInput {
	return {
		provider: "notion",
		installationKey: "default",
		providerEventId,
		eventKind: "source.document.retrieved",
		occurredAt,
		fetchedAt: occurredAt,
		sourceRef: `notion:page:${providerEventId}`,
		sourceUrl: `https://notion.so/${providerEventId}`,
		contentHash: providerEventId,
		visibility: "company",
		payloadVersion: "test",
		payload,
	};
}

function makeSystem(provider: AdjudicationProvider) {
	const store = new MemoryLedgerStore();
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			mode: "autonomous",
			autoApproveNewTasks: false,
			autoApproveContext: false,
			requireReviewForTaskChanges: true,
		}),
	);
	const adjudicator = new AutonomousAdjudicator({
		store,
		ledger,
		provider,
		companyName: "Example Company",
		config,
		completionPolicy: {
			minimumEvidenceItems: 2,
			evidenceProviders: ["github", "agent"],
		},
		log: { info() {}, error() {} },
	});

	return { store, ledger, adjudicator };
}

describe("AutonomousAdjudicator", () => {
	it("constrains structured output to the supplied proposal IDs and exact decision count", () => {
		const ids = [
			"00000000-0000-4000-8000-000000000010",
			"00000000-0000-4000-8000-000000000011",
		];
		const schema = adjudicationJsonSchemaFor(ids);

		expect(schema.properties.decisions).toMatchObject({
			minItems: 2,
			maxItems: 2,
		});
		expect(schema.properties.decisions.items.properties.proposalId).toEqual(
			{ type: "string", enum: ids },
		);
	});

	it("approves a supported proposal from evidence time and accepted history", async () => {
		const provider = new StubAdjudicator((input) => {
			expect(input.cases).toHaveLength(1);
			expect(input.cases[0]).toMatchObject({
				candidateEvidenceOccurredAt: {
					latest: "2026-09-15T10:00:00.000Z",
				},
				acceptedHistory: [],
			});
			expect(input.evidence[0]).toMatchObject({
				provider: "notion",
				occurredAt: "2026-09-15T10:00:00.000Z",
			});
			return {
				decisions: [
					{
						proposalId: input.cases[0]!.proposal.id,
						action: "approve",
						confidence: 0.94,
						rationale:
							"The handbook explicitly records a durable policy.",
						temporalBasis:
							"The cited snapshot was current when observed.",
						historicalBasis: [
							"No accepted value exists at this path.",
						],
					},
				],
			};
		});
		const { store, ledger, adjudicator } = makeSystem(provider);
		const event = (
			await store.appendSourceEvent(
				evidence("policy-1", "2026-09-15T10:00:00.000Z", {
					text: "Deployments require green integration tests.",
				}),
			)
		).event;
		const proposal = await ledger.proposeContextFact({
			sourceRef: "intelligence:policy:deployments",
			path: "/policies/deployments/integration-tests",
			title: "Deployment integration tests",
			factType: "policy",
			value: "Deployments require green integration tests.",
			sourceUrl: event.sourceUrl,
			rationale: "The current handbook states this policy.",
			requestedBy: "intelligence:test",
			evidenceIds: [event.id],
		});

		const report = await adjudicator.run();

		expect(report.outcomes).toMatchObject([
			{
				proposalId: proposal.id,
				action: "approve",
				state: "approved",
				source: "model",
			},
		]);
		expect((await ledger.contextPack()).entries).toMatchObject([
			{
				path: "/policies/deployments/integration-tests",
				value: "Deployments require green integration tests.",
			},
		]);
		expect(await store.listAuditEvents(10)).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					action: "proposal.autonomously_approved",
					actor: "adjudicator:stub:adjudicator",
				}),
			]),
		);
	});

	it("supersedes an older context claim without asking the model", async () => {
		const provider = new StubAdjudicator(() => ({ decisions: [] }));
		const { store, ledger, adjudicator } = makeSystem(provider);
		const newer = (
			await store.appendSourceEvent(
				evidence("newer", "2026-09-15T10:00:00.000Z"),
			)
		).event;
		const accepted = await ledger.proposeContextFact({
			sourceRef: "intelligence:policy:release-window",
			path: "/policies/releases/window",
			title: "Release window",
			factType: "policy",
			value: "Releases happen on Thursday.",
			rationale: "New handbook edition.",
			requestedBy: "intelligence:test",
			evidenceIds: [newer.id],
		});

		await ledger.approveProposal(
			accepted.id,
			"user:admin",
			"Initial accepted policy.",
		);

		const older = (
			await store.appendSourceEvent(
				evidence("older", "2026-09-14T10:00:00.000Z"),
			)
		).event;
		const proposal = await ledger.proposeContextFact({
			sourceRef: "intelligence:policy:release-window",
			path: "/policies/releases/window",
			title: "Release window",
			factType: "policy",
			value: "Releases happen on Tuesday.",
			rationale: "Older handbook edition.",
			requestedBy: "intelligence:test",
			evidenceIds: [older.id],
		});

		const report = await adjudicator.run();

		expect(provider.adjudicate).not.toHaveBeenCalled();
		expect(report.outcomes).toMatchObject([
			{
				proposalId: proposal.id,
				action: "supersede",
				state: "superseded",
				source: "deterministic",
			},
		]);
		expect((await ledger.contextPack()).entries[0]).toMatchObject({
			value: "Releases happen on Thursday.",
		});
	});

	it("marks only a rare unresolved conflict as escalated and still permits a human resolution", async () => {
		const provider = new StubAdjudicator((input) => ({
			decisions: [
				{
					proposalId: input.cases[0]!.proposal.id,
					action: "escalate",
					confidence: 0.88,
					rationale:
						"Two current owners make mutually exclusive claims with equal authority.",
					temporalBasis:
						"Both claims describe the same effective date.",
					historicalBasis: [
						"Accepted history does not establish which owner supersedes the other.",
					],
				},
			],
		}));
		const { store, ledger, adjudicator } = makeSystem(provider);
		const event = (
			await store.appendSourceEvent(
				evidence("ownership-conflict", "2026-09-15T10:00:00.000Z"),
			)
		).event;
		const proposal = await ledger.proposeContextFact({
			sourceRef: "intelligence:relationship:incident-owner",
			path: "/ownership/incidents",
			title: "Incident owner",
			factType: "relationship",
			value: "Rina owns incident coordination.",
			rationale: "One of two current sources assigns ownership.",
			requestedBy: "intelligence:test",
			evidenceIds: [event.id],
		});

		const report = await adjudicator.run();

		expect(report.outcomes).toMatchObject([
			{ proposalId: proposal.id, action: "escalate", state: "escalated" },
		]);
		expect((await ledger.board()).proposals).toMatchObject([
			{ id: proposal.id, state: "escalated" },
		]);
		await ledger.rejectProposal(
			proposal.id,
			"user:admin",
			"Checked the source owners; this claim is not current.",
		);
		expect(await ledger.getProposal(proposal.id)).toMatchObject({
			state: "rejected",
			decidedBy: "user:admin",
		});
	});

	it("escalates a low-confidence model approval instead of mutating accepted state", async () => {
		const provider = new StubAdjudicator((input) => ({
			decisions: [
				{
					proposalId: input.cases[0]!.proposal.id,
					action: "approve",
					confidence: 0.55,
					rationale:
						"The wording may be a recommendation rather than a policy.",
					temporalBasis: "Only one current snapshot is available.",
					historicalBasis: [],
				},
			],
		}));
		const { store, ledger, adjudicator } = makeSystem(provider);
		const event = (
			await store.appendSourceEvent(
				evidence("ambiguous", "2026-09-15T10:00:00.000Z"),
			)
		).event;
		const proposal = await ledger.proposeContextFact({
			sourceRef: "intelligence:preference:deploy-time",
			path: "/preferences/deployments/time",
			title: "Deployment time",
			factType: "preference",
			value: "Prefer morning deployments.",
			rationale: "A planning note mentions mornings.",
			requestedBy: "intelligence:test",
			evidenceIds: [event.id],
		});

		const report = await adjudicator.run();

		expect(report.outcomes).toMatchObject([
			{
				proposalId: proposal.id,
				action: "escalate",
				state: "escalated",
				confidence: 0.55,
			},
		]);
		expect((await ledger.contextPack()).entries).toEqual([]);
	});

	it("preserves a stale proposal and approves an autonomous replacement when later history is non-conflicting", async () => {
		const provider = new StubAdjudicator((input) => {
			expect(input.cases[0]).toMatchObject({ staleBase: true });
			expect(
				input.cases[0]!.acceptedHistory.map((item) => item.version),
			).toEqual([2, 1]);
			return {
				decisions: [
					{
						proposalId: input.cases[0]!.proposal.id,
						action: "approve",
						confidence: 0.93,
						rationale:
							"The blocker remains current and does not conflict with the later ownership revision.",
						temporalBasis:
							"The blocker request remains the latest evidence for status.",
						historicalBasis: [
							"Revision 2 changed owner, not status.",
						],
					},
				],
			};
		});
		const { ledger, adjudicator } = makeSystem(provider);
		const task = await ledger.createTask(
			{ title: "Prepare release", owner: "Rina" },
			"user:admin",
		);
		const stale = await ledger.propose({
			taskId: task.id,
			baseRevision: task.version,
			changes: { status: "blocked" },
			rationale: "The signing key is unavailable.",
			requestedBy: "agent:release",
			evidenceIds: [],
		});
		const ownership = await ledger.propose({
			taskId: task.id,
			baseRevision: task.version,
			changes: { owner: "Mateo" },
			rationale: "Release ownership changed.",
			requestedBy: "agent:planning",
			evidenceIds: [],
		});

		await ledger.approveProposal(
			ownership.id,
			"user:admin",
			"Ownership confirmed.",
		);

		const report = await adjudicator.run();

		expect(report.outcomes).toMatchObject([
			{
				proposalId: stale.id,
				action: "approve",
				state: "approved",
				replacementProposalId: expect.any(String),
			},
		]);
		expect(await ledger.getProposal(stale.id)).toMatchObject({
			state: "superseded",
			decidedBy: "adjudicator:stub:adjudicator",
		});
		expect(await ledger.getTask(task.id)).toMatchObject({
			owner: "Mateo",
			status: "blocked",
			version: 3,
		});
	});
});
