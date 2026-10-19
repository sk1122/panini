import { contentHash } from "../domain/content-hash.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerStore } from "../domain/store.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import type { SourceEvent } from "../domain/types.js";
import { eventText } from "./evidence-bundle.js";
import type { JevWorkJudge, WorkJudgment } from "./jev-work-judge.js";
import type { WorkProseDrafter } from "./openai-work-drafter.js";

const model = "jev-work-suggestion-v7";
const maximumAgeMs = 120 * 24 * 60 * 60_000;
const currentActionAgeMs = 30 * 24 * 60 * 60_000;
const imperative =
	/^(?:\d+[.)]\s*)?(run|retest|test|verify|check|fix|build|implement|add|replay|prepare|investigate|ship|create|update)\b/i;

function firstMeaningfulLine(text: string): string {
	return (
		text
			.replace(/<@[A-Z0-9]+>/g, " ")
			.split("\n")
			.map((line) => line.trim())
			.find(Boolean) ?? ""
	);
}

function normalizedWords(text: string): string {
	return (text.toLocaleLowerCase("en").match(/[\p{L}\p{N}]+/gu) ?? []).join(
		" ",
	);
}

function extractiveTaskTitle(title: string, sourceText: string): boolean {
	const phrase = normalizedWords(title);

	return (
		title.length >= 12 &&
		title.length <= 180 &&
		phrase.split(" ").length >= 3 &&
		!/\b(it|this|that|these|those|them|stuff|things|something)\b/i.test(
			title,
		) &&
		!/\b(as well|and then)\s*$/i.test(title) &&
		` ${normalizedWords(sourceText)} `.includes(` ${phrase} `)
	);
}

function eligibleProjectSignal(event: SourceEvent, now: number): boolean {
	return (
		now - Date.parse(event.occurredAt) <= maximumAgeMs &&
		eventText(event).trim().length >= 60
	);
}

function similarProjectName(title: string, names: string[]): boolean {
	const terms = new Set(
		(title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
			(term) =>
				term.length >= 4 &&
				!["plan", "project", "development", "system"].includes(term),
		),
	);

	return names.some((name) => {
		const nameTerms = new Set(
			(name.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
				(term) =>
					term.length >= 4 &&
					!["plan", "project", "development", "system"].includes(
						term,
					),
			),
		);
		const matched = [...terms].filter((term) => nameTerms.has(term)).length;

		return (
			matched >= 2 &&
			matched / Math.min(terms.size || 1, nameTerms.size || 1) >= 0.6
		);
	});
}

function projectContextOverlap(
	name: string,
	outcome: string,
	texts: string[],
): boolean {
	const broad = new Set([
		"project",
		"task",
		"work",
		"source",
		"system",
		"process",
		"team",
		"build",
		"create",
	]);
	const terms = new Set(
		normalizedWords(`${name} ${outcome}`)
			.split(" ")
			.filter((term) => term.length >= 5 && !broad.has(term)),
	);
	const evidence = new Set(normalizedWords(texts.join(" ")).split(" "));
	const matches = [...terms].filter((term) => evidence.has(term)).length;

	return matches >= 2 || (matches >= 1 && texts.length >= 2);
}

function descriptionSupportedByPrimary(
	description: string,
	source: string,
): boolean {
	const stop = new Set([
		"outcome",
		"work",
		"done",
		"source",
		"task",
		"this",
		"that",
		"with",
		"from",
		"then",
		"will",
		"have",
		"been",
		"when",
		"each",
		"into",
		"using",
		"after",
		"before",
	]);
	const terms = normalizedWords(description)
		.split(" ")
		.filter((term) => term.length >= 4 && !stop.has(term));

	if (!terms.length) return false;

	const sourceTerms = new Set(normalizedWords(source).split(" "));

	return (
		terms.filter((term) => sourceTerms.has(term)).length / terms.length >=
		0.6
	);
}

/** Bounds and deduplication only. Jev, not a keyword filter, decides task intent. */
export function eligibleWorkSignal(
	event: SourceEvent,
	now = Date.now(),
): boolean {
	if (now - Date.parse(event.occurredAt) > maximumAgeMs) return false;

	const text = eventText(event).trim();

	if (text.length < 25) return false;
	if (event.provider === "agent") return event.eventKind.startsWith("work.");
	if (event.provider === "slack")
		return event.eventKind.startsWith("message.");
	if (event.provider === "github")
		return ["pull_request.snapshot", "commit.snapshot"].includes(
			event.eventKind,
		);
	if (event.provider === "notion")
		return ["source.document.retrieved", "snapshot.retrieved"].includes(
			event.eventKind,
		);
	return false;
}

function takeAcrossProviders(
	events: SourceEvent[],
	limit: number,
): SourceEvent[] {
	const groups = new Map<string, SourceEvent[]>();

	// Backfill receipt time is not work time. Prefer the latest source occurrence.
	for (const event of [...events].sort(
		(left, right) =>
			right.occurredAt.localeCompare(left.occurredAt) ||
			right.receivedAt.localeCompare(left.receivedAt),
	)) {
		const group = groups.get(event.provider) ?? [];

		group.push(event);
		groups.set(event.provider, group);
	}

	const providers = [...groups.keys()].sort((left, right) =>
		(groups.get(right)?.[0]?.occurredAt ?? "").localeCompare(
			groups.get(left)?.[0]?.occurredAt ?? "",
		),
	);
	const selected: SourceEvent[] = [];

	while (selected.length < limit && providers.length) {
		for (const provider of [...providers]) {
			const next = groups.get(provider)?.shift();

			if (next) selected.push(next);
			if (!groups.get(provider)?.length)
				providers.splice(providers.indexOf(provider), 1);
			if (selected.length >= limit) break;
		}
	}
	return selected;
}

function signalPriority(event: SourceEvent): number {
	if (event.provider === "agent") return 5;

	const text = eventText(event);

	// Candidate ordering only; Jev still decides whether the observation is a Task.
	if (
		event.provider === "slack" &&
		text.length >= 40 &&
		/\b(working on|implementing|building|fixing|blocked on|stuck on|need to|we should|will need to|next step|going to)\b/i.test(
			text,
		)
	)
		return 4;
	if (imperative.test(firstMeaningfulLine(text)) && text.length >= 70)
		return 3;
	if (
		event.provider === "github" &&
		event.eventKind === "pull_request.snapshot" &&
		/\b(open|draft)\b/i.test(text)
	)
		return 2;
	if (
		event.provider === "notion" &&
		/(?:^|\n)\s*(?:#{1,3}\s*)?(?:purpose|goal|outcome)\b/im.test(text)
	)
		return 2;
	if (imperative.test(firstMeaningfulLine(text))) return 1;
	return 0;
}

function takeForReplay(events: SourceEvent[], limit: number): SourceEvent[] {
	const selected: SourceEvent[] = [];

	for (const priority of [5, 4, 3, 2, 1, 0]) {
		selected.push(
			...takeAcrossProviders(
				events.filter((event) => signalPriority(event) === priority),
				limit - selected.length,
			),
		);
		if (selected.length >= limit) break;
	}
	return selected;
}

export interface WorkSuggestionReport {
	eventId: string;
	outcome: "accepted" | "proposal" | "skipped" | "failed";
	reason: string;
	proposalId?: string;
}

/** Bounded Jev-first replay. All accepted changes still pass through the proposal revision writer. */
export class WorkSuggestionEngine {
	private readonly pendingAttempts = new Set<string>();
	private readonly backfillAttempts = new Set<string>();

	constructor(
		private readonly store: LedgerStore,
		private readonly ledger: TeamLedger,
		private readonly judge: Pick<
			JevWorkJudge,
			"judge" | "supportsDraft" | "judgeProject"
		>,
		private readonly drafter: WorkProseDrafter,
		private readonly allowedVisibilities: string[],
		private readonly autoAcceptStrongNewTasks = false,
	) {}

	async run(eventIds?: string[], limit = 3): Promise<WorkSuggestionReport[]> {
		await this.retireStaleTaskProposals();
		if (this.autoAcceptStrongNewTasks) {
			await this.repairUnsupportedDescriptions();
			await this.acceptPendingTaskSuggestions();
			await this.linkUnassignedTasks();
		}

		const allRuns = await this.store.listInterpretationRuns(2_000);
		const pastRuns = allRuns.filter((run) => run.model === model);
		const today = Date.now() - 24 * 60 * 60_000;
		// A newly evaluated decision policy has its own bounded pilot. Older
		// versions must not consume its entire first-day sample after rollout.
		const remaining = Math.max(
			0,
			40 -
				pastRuns.filter((run) => Date.parse(run.createdAt) >= today)
					.length,
		);

		if (remaining === 0) return [];

		const seen = new Set(
			allRuns
				.filter((run) => run.model === model && run.state !== "running")
				.flatMap((run) => run.eventIds),
		);
		const events = eventIds?.length
			? await this.store.getSourceEvents(eventIds.slice(0, limit))
			: await this.store.listSourceEvents(2_000);
		const seenSourceRefs = new Set<string>();
		const seenContent = new Set<string>();
		const eligible = events.filter((event) => {
			if (seenSourceRefs.has(event.sourceRef)) return false;
			seenSourceRefs.add(event.sourceRef);

			const contentKey = `${event.provider}:${event.visibility}:${normalizedWords(eventText(event))}`;

			if (seenContent.has(contentKey)) return false;
			seenContent.add(contentKey);
			return (
				!seen.has(event.id) &&
				this.allowedVisibilities.includes(event.visibility) &&
				eligibleWorkSignal(event)
			);
		});
		const maximum = Math.min(limit, remaining);
		const selected = eventIds?.length
			? eligible.slice(0, maximum)
			: takeForReplay(eligible, maximum);
		const reports: WorkSuggestionReport[] = [];

		for (const event of selected) {
			const run = await this.store.createInterpretationRun({
				inputHash: contentHash({
					model,
					eventId: event.id,
					contentHash: event.contentHash,
				}),
				model,
				eventIds: [event.id],
			});

			try {
				const report = await this.suggest(event);

				await this.store.completeInterpretationRun(
					run.id,
					JSON.parse(JSON.stringify(report)),
				);
				reports.push(report);
			} catch (error) {
				const reason =
					error instanceof Error ? error.message : String(error);

				await this.store.failInterpretationRun(run.id, reason);
				reports.push({ eventId: event.id, outcome: "failed", reason });
			}
		}
		return reports;
	}

	private async retireStaleTaskProposals(): Promise<void> {
		const proposals = (await this.store.listProposals("pending")).filter(
			(proposal) =>
				proposal.kind === "task_create" &&
				proposal.requestedBy === "system:work-suggestion",
		);

		for (const proposal of proposals) {
			const evidence = await this.store.getSourceEvents(
				proposal.evidenceIds,
			);

			if (
				evidence.some(
					(event) =>
						Date.now() - Date.parse(event.occurredAt) <=
						currentActionAgeMs,
				)
			)
				continue;
			try {
				await this.ledger.rejectProposal(
					proposal.id,
					"system:work-suggestion",
					"The cited action is older than 30 days with no recent supporting observation.",
				);
			} catch (error) {
				if (
					!(error instanceof DomainError) ||
					error.code !== "CONFLICT"
				)
					throw error;
			}
		}
	}

	private async resolveProject(
		title: string,
		bundle: Awaited<ReturnType<TeamLedger["workEvidenceBundle"]>>,
	): Promise<{ id: string; name: string; evidenceIds: string[] } | null> {
		const projects = await this.store.listProjects();
		const decision = await this.judge.judgeProject(title, bundle, projects);
		const evidenceEventIds = bundle.spans.map((span) => span.eventId);
		const existing = projects.find(
			(project) => project.id === decision.selectedProjectId,
		);

		if (
			existing &&
			decision.target.confidence >= 0.8 &&
			decision.relationshipProbability >= 0.4 &&
			projectContextOverlap(
				existing.name,
				existing.outcome,
				bundle.spans.map((span) => span.text),
			)
		) {
			return {
				id: existing.id,
				name: existing.name,
				evidenceIds: evidenceEventIds,
			};
		}
		if (
			decision.target.choice !== "new_project" ||
			decision.target.confidence < 0.75 ||
			decision.relationshipProbability < 0.7 ||
			decision.distinctOutcomeProbability < 0.8
		)
			return null;
		// A new Project needs an outcome stated in more than the Task request itself.
		if (new Set(bundle.spans.map((span) => span.sourceRef)).size < 2)
			return null;

		const nameDraft = await this.drafter.draft(bundle, {
			kind: "project_name",
			candidateId: null,
			evidenceEventIds,
		});
		const outcomeDraft = await this.drafter.draft(bundle, {
			kind: "project_purpose",
			candidateId: null,
			evidenceEventIds,
		});

		if (
			(await this.judge.supportsDraft(bundle, nameDraft)) < 0.85 ||
			(await this.judge.supportsDraft(bundle, outcomeDraft)) < 0.85
		)
			return null;

		const name = nameDraft.text.trim();

		if (
			name.length < 8 ||
			name.length > 120 ||
			name.split(/\s+/).length < 2 ||
			similarProjectName(
				name,
				projects.flatMap((project) => [
					project.name,
					...project.aliases,
				]),
			)
		)
			return null;

		const outcome = outcomeDraft.text.trim();

		if (
			!outcome ||
			outcome.length > 500 ||
			!projectContextOverlap(
				name,
				outcome,
				bundle.spans.map((span) => span.text),
			)
		)
			return null;

		const proposal = await this.ledger.proposeProjectCreation({
			changes: {
				name,
				outcome,
				owner: null,
				sourceUrl: bundle.spans[0]?.sourceUrl ?? null,
			},
			rationale: `Jev established a distinct Project outcome from cited messages; the LLM supplied only source-supported wording. Project ${decision.target.confidence.toFixed(2)}, relationship ${decision.relationshipProbability.toFixed(2)}.`,
			requestedBy: "system:work-suggestion",
			evidenceIds: evidenceEventIds,
		});
		const revision = await this.ledger.approveProjectProposal(
			proposal.id,
			"system:work-suggestion",
			"Source-backed Project created by the automatic work pipeline.",
		);

		return {
			id: revision.current.id,
			name: revision.current.name,
			evidenceIds: evidenceEventIds,
		};
	}

	private async acceptPendingTaskSuggestions(): Promise<void> {
		const pending = (await this.store.listProposals("pending"))
			.filter(
				(proposal) =>
					proposal.kind === "task_create" &&
					proposal.requestedBy === "system:work-suggestion",
			)
			.slice(0, 12);

		for (const proposal of pending) {
			if (this.pendingAttempts.has(proposal.id)) continue;
			this.pendingAttempts.add(proposal.id);
			try {
				const primaryId = proposal.evidenceIds[0];

				if (!primaryId || !proposal.changes.title) continue;

				const bundle = await this.ledger.workEvidenceBundle(
					primaryId,
					this.allowedVisibilities,
				);

				if (
					!bundle.spans.some(
						(span) =>
							Date.now() - Date.parse(span.occurredAt) <=
							currentActionAgeMs,
					)
				)
					continue;

				const project = await this.resolveProject(
					proposal.changes.title,
					bundle,
				);

				if (!project) {
					await this.ledger.rejectProposal(
						proposal.id,
						"system:work-suggestion",
						"The cited sources do not establish a Project relationship for automatic acceptance.",
					);
					continue;
				}

				const edited = await this.ledger.editProposal(
					proposal.id,
					{
						...proposal.changes,
						projectId: project.id,
						project: project.name,
					},
					`${proposal.rationale} Project linked by LLM interpretation of cited evidence.`,
					"system:work-suggestion",
				);

				await this.ledger.approveProposal(
					edited.id,
					"system:work-suggestion",
					"Source-backed Task and Project accepted by the automatic work pipeline.",
				);
			} catch (error) {
				this.pendingAttempts.delete(proposal.id);
				console.error(
					"Pending Task suggestion reconciliation failed.",
					error,
				);
			}
		}
	}

	private async linkUnassignedTasks(): Promise<void> {
		const tasks = (await this.store.listTasks())
			.filter(
				(task) =>
					!task.projectId &&
					task.externalRef?.startsWith("panini:source:"),
			)
			.slice(0, 12);

		for (const task of tasks) {
			if (this.backfillAttempts.has(task.id)) continue;
			this.backfillAttempts.add(task.id);
			try {
				const eventId = task.externalRef!.slice(
					"panini:source:".length,
				);
				const bundle = await this.ledger.workEvidenceBundle(
					eventId,
					this.allowedVisibilities,
				);
				const project = await this.resolveProject(task.title, bundle);

				if (!project) continue;

				const proposal = await this.ledger.propose({
					clientEventId: `work-project-link:${task.id}:${project.id}`,
					taskId: task.id,
					baseRevision: task.version,
					changes: { project: project.name, projectId: project.id },
					rationale:
						"LLM linked this Task to a cited Project outcome after Jev classified the source.",
					requestedBy: "system:work-suggestion",
					evidenceIds: project.evidenceIds,
				});

				await this.ledger.approveProposal(
					proposal.id,
					"system:work-suggestion",
					"Source-backed Project assignment accepted by the automatic work pipeline.",
				);
			} catch (error) {
				this.backfillAttempts.delete(task.id);
				console.error(
					"Existing Task Project assignment failed.",
					error,
				);
			}
		}
	}

	private async repairUnsupportedDescriptions(): Promise<void> {
		const tasks = (await this.store.listTasks())
			.filter(
				(task) =>
					task.version === 1 &&
					task.description &&
					task.externalRef?.startsWith("panini:source:"),
			)
			.slice(0, 20);

		for (const task of tasks) {
			const eventId = task.externalRef!.slice("panini:source:".length);
			const [primary] = await this.store.getSourceEvents([eventId]);

			if (
				!primary ||
				descriptionSupportedByPrimary(
					task.description,
					eventText(primary),
				)
			)
				continue;

			const [creation] = await this.store.listTaskRevisions(task.id);
			const sourceProposal = creation
				? await this.store.getProposal(creation.proposalId)
				: null;

			if (
				sourceProposal?.requestedBy !== "system:work-suggestion" ||
				!sourceProposal.rationale.startsWith(
					"Jev classified a concrete Task action",
				)
			)
				continue;

			const proposal = await this.ledger.propose({
				clientEventId: `work-description-repair:${task.id}`,
				taskId: task.id,
				baseRevision: task.version,
				changes: { description: "" },
				rationale:
					"The generated description included claims absent from the Task's primary source, so its source link and title remain without unsupported detail.",
				requestedBy: "system:work-suggestion",
				evidenceIds: [eventId],
			});

			await this.ledger.approveProposal(
				proposal.id,
				"system:work-suggestion",
				"Removed an unsupported generated description; retained the source-linked Task.",
			);
		}
	}

	private async suggest(event: SourceEvent): Promise<WorkSuggestionReport> {
		const bundle = await this.ledger.workEvidenceBundle(
			event.id,
			this.allowedVisibilities,
		);
		const judgment = await this.judge.judge(bundle);

		if (event.provider === "agent")
			return this.suggestAgentUpdate(event, bundle, judgment);

		const skip = (reason: string): WorkSuggestionReport => ({
			eventId: event.id,
			outcome: "skipped",
			reason,
		});

		if (
			judgment.kind.choice === "project_outcome" &&
			eligibleProjectSignal(event, Date.now())
		) {
			return this.suggestProject(event, bundle, judgment);
		}
		if (
			!bundle.spans.some(
				(span) =>
					Date.now() - Date.parse(span.occurredAt) <=
					currentActionAgeMs,
			)
		) {
			return skip("No recent observation supports a current Task.");
		}
		if (
			judgment.kind.choice !== "task_action" ||
			judgment.kind.confidence < 0.8 ||
			judgment.concreteActionProbability < 0.75
		)
			return skip("No supported, concrete task action.");
		if (
			event.provider === "notion" &&
			!bundle.spans.some((span) => span.provider !== "notion")
		) {
			return skip(
				"A Notion row or page alone cannot create or change a Task.",
			);
		}
		if (
			judgment.selectedCandidate?.kind === "task" &&
			judgment.target.confidence >= 0.8
		) {
			return this.suggestExistingTask(event, bundle, judgment);
		}

		const projectCandidate = judgment.selectedCandidate?.kind === "project";
		const minimumTargetConfidence =
			judgment.kind.confidence >= 0.95 &&
			judgment.concreteActionProbability >= 0.8
				? 0.55
				: 0.6;

		if (
			(!projectCandidate && judgment.target.choice !== "new_task") ||
			judgment.target.confidence < minimumTargetConfidence
		) {
			return skip("The Task identity is existing or uncertain.");
		}
		// Similarity finds candidates but cannot establish identity. Avoid duplicate work.
		if (
			bundle.candidates.some(
				(candidate) =>
					candidate.kind === "task" &&
					candidate.reason !== "lexical_overlap",
			) ||
			(bundle.candidates.some((candidate) => candidate.kind === "task") &&
				judgment.target.confidence < 0.85)
		) {
			return skip("An existing Task may already represent this work.");
		}

		const titleDraft = await this.drafter.draft(bundle, {
			kind: "task_title",
			candidateId: null,
			evidenceEventIds: [event.id],
		});

		if (
			!extractiveTaskTitle(titleDraft.text, bundle.spans[0]?.text ?? "")
		) {
			return skip(
				"The LLM title was not directly supported by the source.",
			);
		}

		const descriptionDraft = await this.drafter.draft(bundle, {
			kind: "task_description",
			candidateId: null,
			evidenceEventIds: [event.id],
		});
		const description =
			descriptionDraft.text &&
			descriptionDraft.evidenceEventIds.length === 1 &&
			descriptionDraft.evidenceEventIds[0] === event.id &&
			descriptionSupportedByPrimary(
				descriptionDraft.text,
				bundle.spans[0]?.text ?? "",
			)
				? descriptionDraft.text
				: "";
		const cited = new Set(bundle.spans.map((span) => span.eventId));

		if (
			(await this.store.listProposals("pending")).some(
				(proposal) =>
					proposal.kind === "task_create" &&
					proposal.evidenceIds.some((id) => cited.has(id)),
			)
		) {
			return skip(
				"A pending Task proposal already cites this work evidence.",
			);
		}

		const project = this.autoAcceptStrongNewTasks
			? await this.resolveProject(titleDraft.text, bundle)
			: null;

		if (this.autoAcceptStrongNewTasks && !project)
			return skip("No source-backed Project assignment was established.");

		const proposal = await this.ledger.proposeTaskCreation({
			clientEventId: `work-suggestion:${event.id}`,
			externalRef: `panini:source:${event.id}`,
			title: titleDraft.text,
			description,
			status: "backlog",
			priority: "medium",
			owner: null,
			project: project?.name ?? null,
			projectId: project?.id ?? null,
			sourceUrl: event.sourceUrl,
			rationale: `Jev classified a concrete Task action in ${event.provider} evidence. Task ${judgment.kind.confidence.toFixed(2)}, new target ${judgment.target.confidence.toFixed(2)}; the LLM title was copied from the source and the Project was interpreted from cited context.`,
			requestedBy: "system:work-suggestion",
			evidenceIds: bundle.spans.map((span) => span.eventId),
		});

		if (this.autoAcceptStrongNewTasks) {
			await this.ledger.approveProposal(
				proposal.id,
				"system:work-suggestion",
				"Source-backed Task and Project accepted by the automatic work pipeline.",
			);
			return {
				eventId: event.id,
				outcome: "accepted",
				reason: "Source-backed Task created.",
				proposalId: proposal.id,
			};
		}
		return {
			eventId: event.id,
			outcome: "proposal",
			reason: "Review required.",
			proposalId: proposal.id,
		};
	}

	private async suggestExistingTask(
		event: SourceEvent,
		bundle: Awaited<ReturnType<TeamLedger["workEvidenceBundle"]>>,
		judgment: WorkJudgment,
	): Promise<WorkSuggestionReport> {
		const skip = (reason: string): WorkSuggestionReport => ({
			eventId: event.id,
			outcome: "skipped",
			reason,
		});

		const candidate = judgment.selectedCandidate;

		if (candidate?.kind !== "task")
			return skip("No Task target was established.");

		const task = await this.store.getTask(candidate.id);

		if (!task || ["done", "cancelled"].includes(task.status))
			return skip("The target Task is closed or missing.");
		if (this.autoAcceptStrongNewTasks)
			return skip(
				"Existing Task status automation has not passed evaluation.",
			);

		const next =
			judgment.stage.choice === "active"
				? "in_progress"
				: judgment.stage.choice === "blocked"
					? "blocked"
					: ["review", "delivery_candidate"].includes(
								judgment.stage.choice,
						  )
						? "review"
						: null;

		if (!next || next === task.status || judgment.stage.confidence < 0.8) {
			return skip("No supported change to the existing Task stage.");
		}

		const draft = await this.drafter.draft(bundle, {
			kind: "change_explanation",
			candidateId: task.id,
			evidenceEventIds: [event.id],
		});

		if (
			!draft.text ||
			(await this.judge.supportsDraft(bundle, draft)) < 0.85
		) {
			return skip(
				"The LLM explanation was not directly supported by the source.",
			);
		}

		const proposal = await this.ledger.propose({
			clientEventId: `work-suggestion:${event.id}:${task.id}`,
			taskId: task.id,
			baseRevision: task.version,
			changes: { status: next },
			rationale: `${draft.text} Jev stage ${judgment.stage.choice} ${judgment.stage.confidence.toFixed(2)}.`,
			requestedBy: "system:work-suggestion",
			evidenceIds: [event.id],
		});

		return {
			eventId: event.id,
			outcome: "proposal",
			reason: "Existing Task stage needs review.",
			proposalId: proposal.id,
		};
	}

	private async suggestAgentUpdate(
		event: SourceEvent,
		bundle: Awaited<ReturnType<TeamLedger["workEvidenceBundle"]>>,
		judgment: Awaited<ReturnType<JevWorkJudge["judge"]>>,
	): Promise<WorkSuggestionReport> {
		const skip = (reason: string): WorkSuggestionReport => ({
			eventId: event.id,
			outcome: "skipped",
			reason,
		});

		const payload = event.payload as { workItemId: string; phase: string };
		const task = await this.store.getTask(payload.workItemId);

		if (!task || ["done", "cancelled"].includes(task.status))
			return skip("The reported task is unavailable or closed.");
		if (this.autoAcceptStrongNewTasks)
			return skip(
				"Agent Task status automation has not passed evaluation.",
			);
		if (
			judgment.selectedCandidate?.kind !== "task" ||
			judgment.selectedCandidate.id !== task.id ||
			judgment.target.confidence < 0.8
		)
			return skip("Jev did not confirm the reported Task identity.");

		const stage = judgment.stage;
		const proposed =
			payload.phase === "started" &&
			stage.choice === "active" &&
			stage.confidence >= 0.7
				? "in_progress"
				: payload.phase === "blocked" &&
					  stage.choice === "blocked" &&
					  stage.confidence >= 0.7
					? "blocked"
					: ["delivered", "verified"].includes(payload.phase) &&
						  ["review", "delivery_candidate"].includes(
								stage.choice,
						  ) &&
						  stage.confidence >= 0.7
						? "review"
						: null;

		if (!proposed || task.status === proposed)
			return skip(
				"The agent report does not support a new reviewed stage.",
			);

		const draft = await this.drafter.draft(bundle, {
			kind: "change_explanation",
			candidateId: task.id,
			evidenceEventIds: [event.id],
		});

		if (
			!draft.text ||
			(await this.judge.supportsDraft(bundle, draft)) < 0.85
		) {
			return skip(
				"The agent report explanation was not directly supported by the source.",
			);
		}

		const proposal = await this.ledger.propose({
			clientEventId: `work-suggestion:${event.id}`,
			taskId: task.id,
			baseRevision: task.version,
			changes: { status: proposed },
			rationale: `${draft.text} Structured agent ${payload.phase} report; Jev stage ${stage.choice} ${stage.confidence.toFixed(2)}. Review the cited verification before accepting. No agent report alone marks work done.`,
			requestedBy: "system:work-suggestion",
			evidenceIds: [event.id],
		});

		return {
			eventId: event.id,
			outcome: "proposal",
			reason: "Agent stage review required.",
			proposalId: proposal.id,
		};
	}

	private async suggestProject(
		event: SourceEvent,
		bundle: Awaited<ReturnType<TeamLedger["workEvidenceBundle"]>>,
		judgment: WorkJudgment,
	): Promise<WorkSuggestionReport> {
		const skip = (reason: string): WorkSuggestionReport => ({
			eventId: event.id,
			outcome: "skipped",
			reason,
		});

		const independentSources =
			new Set(bundle.spans.map((span) => span.provider)).size >= 2;
		const recentAction = bundle.spans.some(
			(span) =>
				Date.now() - Date.parse(span.occurredAt) <=
					45 * 24 * 60 * 60_000 &&
				((span.provider === "slack" &&
					imperative.test(firstMeaningfulLine(span.text))) ||
					(span.provider === "agent" &&
						/\b(started|blocked|delivered|verified|checkpoint)\b/i.test(
							span.text,
						))),
		);

		if (!independentSources || !recentAction)
			return skip(
				"No independent recent action supports this Project outcome.",
			);
		if (
			judgment.kind.choice !== "project_outcome" ||
			judgment.kind.confidence < 0.85 ||
			judgment.target.choice !== "new_project" ||
			judgment.target.confidence < 0.85 ||
			judgment.concreteActionProbability < 0.8
		) {
			return skip(
				"A distinct, current Project outcome is not established.",
			);
		}

		const evidenceEventIds = bundle.spans.map((span) => span.eventId);
		const nameDraft = await this.drafter.draft(bundle, {
			kind: "project_name",
			candidateId: null,
			evidenceEventIds,
		});
		const name = nameDraft.text.trim();

		if (
			name.length < 8 ||
			name.length > 120 ||
			name.split(/\s+/).length < 2 ||
			(await this.judge.supportsDraft(bundle, nameDraft)) < 0.9
		) {
			return skip(
				"The drafted Project name is not sufficiently supported.",
			);
		}

		const projects = await this.store.listProjects();

		if (
			similarProjectName(
				name,
				projects.flatMap((project) => [
					project.name,
					...project.aliases,
				]),
			)
		) {
			return skip(
				"A similar Project already exists; identity needs review.",
			);
		}

		const draft = await this.drafter.draft(bundle, {
			kind: "project_purpose",
			candidateId: null,
			evidenceEventIds,
		});

		if (
			!draft.text ||
			(await this.judge.supportsDraft(bundle, draft)) < 0.9
		) {
			return skip(
				"The drafted Project outcome is not sufficiently supported.",
			);
		}

		const existing = (await this.store.listProjectProposals()).find(
			(proposal) =>
				proposal.state === "pending" &&
				proposal.kind === "project_create" &&
				(proposal.evidenceIds.some((id) =>
					evidenceEventIds.includes(id),
				) ||
					similarProjectName(name, [proposal.changes.name ?? ""])),
		);

		if (existing)
			return skip("A Project proposal already cites this document.");

		const proposal = await this.ledger.proposeProjectCreation({
			changes: {
				name,
				outcome: draft.text,
				owner: null,
				sourceUrl: event.sourceUrl,
			},
			rationale: `Independent sources and a recent action support a distinct outcome. Jev: Project ${judgment.kind.confidence.toFixed(2)}, new target ${judgment.target.confidence.toFixed(2)}. Review scope and identity before approval.`,
			requestedBy: "system:work-suggestion",
			evidenceIds: evidenceEventIds,
		});

		if (this.autoAcceptStrongNewTasks) {
			await this.ledger.approveProjectProposal(
				proposal.id,
				"system:work-suggestion",
				"Independent cited sources and Jev-supported outcome accepted by the automatic work pipeline.",
			);
			return {
				eventId: event.id,
				outcome: "accepted",
				reason: "Source-backed Project created.",
				proposalId: proposal.id,
			};
		}
		return {
			eventId: event.id,
			outcome: "proposal",
			reason: "Project review required.",
			proposalId: proposal.id,
		};
	}
}
