import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import type { SourceEvent, Task } from "../domain/types.js";
import { eventText, type WorkEvidenceBundle } from "./evidence-bundle.js";
import type { JevWorkJudge } from "./jev-work-judge.js";
import type { WorkProseDrafter } from "./openai-work-drafter.js";
import type { WorkSuggestionReport } from "./work-suggestions.js";

const model = "jev-task-status-v1";
const maxAgeMs = 120 * 24 * 60 * 60_000;
const stopWords = new Set([
	"the",
	"and",
	"for",
	"from",
	"into",
	"with",
	"task",
	"work",
	"run",
	"check",
	"make",
	"build",
	"implement",
	"verify",
	"create",
	"update",
	"system",
	"pipeline",
	"source",
	"sources",
]);

function terms(value: string): Set<string> {
	return new Set(
		(value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
			.map((term) =>
				term.length > 5 && term.endsWith("s")
					? term.slice(0, -1)
					: term,
			)
			.filter((term) => term.length >= 3 && !stopWords.has(term)),
	);
}

function matchScore(task: Task, event: SourceEvent): number {
	const payload =
		event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
			? (event.payload as Record<string, unknown>)
			: {};

	if (event.provider === "agent" && payload.workItemId === task.id)
		return 100;

	const title = terms(task.title);
	const sourceText = eventText(event);
	// Long plans and transcripts often mention several unrelated work items.
	// Status evidence needs a focused reference near the start of an observation.
	const source = terms(sourceText.slice(0, 1_200));
	const matching = [...title].filter((term) => source.has(term));

	if (title.size < 2 || matching.length < 2) return 0;

	const lengthPenalty =
		sourceText.length > 2_000 ? 0.4 : sourceText.length > 1_200 ? 0.7 : 1;

	return (
		(matching.length / title.size + matching.length / 10) * lengthPenalty
	);
}

/** Candidate retrieval only. Jev must still establish task identity and supported status. */
export function statusEvidence(
	task: Task,
	events: SourceEvent[],
	allowedVisibilities: string[],
	now = Date.now(),
): SourceEvent[] {
	const seen = new Set<string>();
	const scored = events
		.filter((event) => {
			if (
				!allowedVisibilities.includes(event.visibility) ||
				seen.has(event.sourceRef)
			)
				return false;
			seen.add(event.sourceRef);
			if (now - Date.parse(event.occurredAt) > maxAgeMs) return false;
			if (
				!["notion", "slack", "github", "agent"].includes(event.provider)
			)
				return false;
			// The old Notion task board is baseline context. A Notion document can
			// contribute only when it names this exact Task, not by broad topic overlap.
			if (event.provider === "notion")
				return (
					event.eventKind === "source.document.retrieved" &&
					eventText(event)
						.toLowerCase()
						.includes(task.title.toLowerCase())
				);
			return eventText(event).trim().length >= 40;
		})
		.map((event) => ({ event, score: matchScore(task, event) }))
		.filter((item) => item.score > 0)
		.sort(
			(left, right) =>
				right.score - left.score ||
				right.event.occurredAt.localeCompare(left.event.occurredAt),
		);
	const selected: SourceEvent[] = [];
	const perProvider = new Map<string, number>();

	for (const { event } of scored) {
		if ((perProvider.get(event.provider) ?? 0) >= 4) continue;
		selected.push(event);
		perProvider.set(
			event.provider,
			(perProvider.get(event.provider) ?? 0) + 1,
		);
		if (selected.length === 8) break;
	}
	return selected.sort((left, right) =>
		left.occurredAt.localeCompare(right.occurredAt),
	);
}

/** Produces cited pending status proposals; neither models nor this scanner accept them. */
export class TaskStatusSuggestionEngine {
	constructor(
		private readonly store: LedgerStore,
		private readonly ledger: TeamLedger,
		private readonly judge: Pick<
			JevWorkJudge,
			"judgeTaskStatus" | "supportsDraft"
		>,
		private readonly drafter: WorkProseDrafter,
		private readonly allowedVisibilities: string[],
	) {}

	async run(limit = 3, taskIds?: string[]): Promise<WorkSuggestionReport[]> {
		const [tasks, events, runs] = await Promise.all([
			this.store.listTasks(),
			this.store.listSourceEvents(2_000),
			this.store.listInterpretationRuns(2_000),
		]);
		const today = Date.now() - 24 * 60 * 60_000;
		const remaining = Math.max(
			0,
			12 -
				runs.filter(
					(run) =>
						run.model === model &&
						Date.parse(run.createdAt) >= today,
				).length,
		);

		if (!remaining) return [];

		const prior = new Set(
			runs
				.filter((run) => run.model === model)
				.map((run) => run.inputHash),
		);
		const selected = tasks
			.filter(
				(task) =>
					!["cancelled", "done"].includes(task.status) &&
					(!taskIds || taskIds.includes(task.id)),
			)
			.map((task) => ({
				task,
				evidence: statusEvidence(
					task,
					events,
					this.allowedVisibilities,
				),
			}))
			.filter((item) => item.evidence.length)
			.map((item) => ({
				...item,
				hash: contentHash({
					model,
					taskId: item.task.id,
					version: item.task.version,
					evidenceIds: item.evidence.map((event) => event.id),
				}),
			}))
			.filter((item) => !prior.has(item.hash))
			.sort((left, right) =>
				right.evidence
					.at(-1)!
					.occurredAt.localeCompare(left.evidence.at(-1)!.occurredAt),
			)
			.slice(0, Math.min(limit, remaining));
		const reports: WorkSuggestionReport[] = [];

		for (const { task, evidence, hash } of selected) {
			const run = await this.store.createInterpretationRun({
				inputHash: hash,
				model,
				eventIds: evidence.map((event) => event.id),
			});

			try {
				const report = await this.suggest(task, evidence);

				await this.store.completeInterpretationRun(
					run.id,
					JSON.parse(JSON.stringify(report)),
				);
				reports.push(report);
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : String(error);

				await this.store.failInterpretationRun(run.id, reason);
				reports.push({
					eventId: evidence[0]!.id,
					outcome: "failed",
					reason,
				});
			}
		}
		return reports;
	}

	private async suggest(
		task: Task,
		evidence: SourceEvent[],
	): Promise<WorkSuggestionReport> {
		const eventId = evidence[0]!.id;

		const skip = (reason: string): WorkSuggestionReport => ({
			eventId,
			outcome: "skipped",
			reason,
		});

		const judgment = await this.judge.judgeTaskStatus(task, evidence);
		const target = judgment.status.choice;

		if (
			target === "unchanged" ||
			target === "uncertain" ||
			target === task.status ||
			judgment.status.confidence < 0.85 ||
			judgment.directMatchProbability < 0.85 ||
			judgment.statusSupportProbability < 0.9
		)
			return skip("Current status or task identity is not established.");
		if (
			target === "done" &&
			(judgment.completionSupportProbability < 0.95 ||
				new Set(evidence.map((event) => event.provider)).size < 2)
		) {
			return skip("Completion lacks direct, independent verification.");
		}

		const spans = evidence.map((event) => ({
			eventId: event.id,
			provider: event.provider,
			sourceRef: event.sourceRef,
			sourceUrl: event.sourceUrl,
			visibility: event.visibility,
			occurredAt: event.occurredAt,
			fetchedAt: event.fetchedAt,
			text: eventText(event),
		}));
		const bundle: WorkEvidenceBundle = {
			primaryEventId: eventId,
			spans,
			candidates: [
				{
					kind: "task",
					id: task.id,
					title: task.title,
					reason: "exact_name",
				},
			],
			references: [],
			coverage: {
				scanned: evidence.length,
				limit: 8,
				bounded: false,
				omittedMatches: 0,
			},
		};
		const draft = await this.drafter.draft(bundle, {
			kind: "change_explanation",
			candidateId: task.id,
			evidenceEventIds: evidence.map((event) => event.id),
		});

		if (
			!draft.text ||
			(await this.judge.supportsDraft(bundle, draft)) < 0.85
		) {
			return skip(
				"The explanation was not directly supported by the sources.",
			);
		}

		const proposal = await this.ledger.propose({
			clientEventId: `status-suggestion:${task.id}:${task.version}:${contentHash(evidence.map((event) => event.id))}`,
			taskId: task.id,
			baseRevision: task.version,
			changes: { status: target },
			rationale: `${draft.text} Jev status ${target} ${judgment.status.confidence.toFixed(2)}; direct match ${judgment.directMatchProbability.toFixed(2)}. Review before accepting.`,
			requestedBy: "system:task-status-suggestion",
			evidenceIds: evidence.map((event) => event.id),
		});

		return {
			eventId,
			outcome: "proposal",
			reason: `Review ${target} status.`,
			proposalId: proposal.id,
		};
	}
}
