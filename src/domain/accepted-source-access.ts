import { canReadTask, canReadVisibility, type AccessScope } from "./access.js";
import type { LedgerStore } from "./store.js";
import type { Proposal, SourceEvent, Task } from "./types.js";

/** Current derived views may cite only the latest active version of each mutable source. */
export async function currentSourceEvents(
	store: LedgerStore,
	ids: readonly string[],
	at?: string,
): Promise<SourceEvent[]> {
	const unique = [...new Set(ids)];
	const [events, currentIds] = await Promise.all([
		store.getSourceEvents(unique),
		store.currentSourceEventIds(unique, at),
	]);
	const latest = new Set(currentIds);

	return events.filter((event) => latest.has(event.id));
}

/** Agent-accepted state may cite an older existing receipt. Revocation still removes it. */
export async function acceptedSourceEvents(
	store: LedgerStore,
	ids: readonly string[],
	at?: string,
): Promise<SourceEvent[]> {
	const unique = [...new Set(ids)];
	const [events, currentIds, agentAcceptedIds] = await Promise.all([
		store.getSourceEvents(unique),
		store.currentSourceEventIds(unique, at),
		store.observationAcceptedSourceEventIds(unique),
	]);
	const allowed = new Set([...currentIds, ...agentAcceptedIds]);

	return events.filter(
		(event) => allowed.has(event.id) && (!at || event.receivedAt <= at),
	);
}

/** The receipts behind each current field, excluding evidence for overwritten fields. */
export async function acceptedTaskSourceLineage(
	store: LedgerStore,
	tasks: Task[],
	at?: string,
): Promise<Map<string, Map<string, string[]>>> {
	if (tasks.length === 0) return new Map();

	const ids = new Set(tasks.map((task) => task.id));
	const lineage = new Map<string, Map<string, string[]>>();
	const revisions = (
		await store.listTaskRevisions(
			tasks.length === 1 ? tasks[0]!.id : undefined,
		)
	)
		.filter(
			(revision) =>
				ids.has(revision.taskId) && (!at || revision.appliedAt <= at),
		)
		.sort(
			(left, right) =>
				left.taskId.localeCompare(right.taskId) ||
				left.version - right.version,
		);
	const legacyProposalIds = new Set(
		revisions
			.filter((revision) => !revision.decisionMetadata)
			.map((revision) => revision.proposalId),
	);
	const legacyProposals =
		legacyProposalIds.size === 0
			? new Map<string, Proposal>()
			: new Map(
					(await store.listProposals())
						.filter((proposal) =>
							legacyProposalIds.has(proposal.id),
						)
						.map((proposal) => [proposal.id, proposal]),
				);

	for (const revision of revisions) {
		const fields =
			lineage.get(revision.taskId) ?? new Map<string, string[]>();
		const support = revision.decisionMetadata?.sourceEventIdsByField ?? {};

		if (support.creation?.length) fields.set("creation", support.creation);

		const legacyEvidence = revision.decisionMetadata
			? []
			: (legacyProposals.get(revision.proposalId)?.evidenceIds ?? []);

		if (!revision.previous && legacyEvidence.length > 0)
			fields.set("creation", legacyEvidence);
		for (const [key, value] of Object.entries(revision.current)) {
			if (["id", "version", "createdAt", "updatedAt"].includes(key))
				continue;

			const before = revision.previous?.[key as keyof Task];

			if (
				revision.previous &&
				!support[key] &&
				JSON.stringify(before ?? null) === JSON.stringify(value ?? null)
			)
				continue;
			fields.set(key, support[key] ?? legacyEvidence);
		}
		lineage.set(revision.taskId, fields);
	}
	return lineage;
}

export async function acceptedTaskSourceEventIds(
	store: LedgerStore,
	tasks: Task[],
	at?: string,
): Promise<string[]> {
	const lineage = await acceptedTaskSourceLineage(store, tasks, at);

	return [
		...new Set(
			[...lineage.values()].flatMap((fields) =>
				[...fields.values()].flat(),
			),
		),
	].sort();
}

/** A derived task is readable only while every source supporting its current fields is readable. */
export async function visibleAcceptedTasks(
	store: LedgerStore,
	tasks: Task[],
	access: AccessScope,
	sourceVisibilityAllowlist?: readonly string[],
	at?: string,
): Promise<Task[]> {
	const scoped = tasks.filter((task) => canReadTask(access, task));

	if (scoped.length === 0) return [];

	const lineage = await acceptedTaskSourceLineage(store, scoped, at);
	const sourceIds = [
		...new Set(
			[...lineage.values()].flatMap((fields) =>
				[...fields.values()].flat(),
			),
		),
	];
	const sources = new Map(
		(await acceptedSourceEvents(store, sourceIds, at)).map((event) => [
			event.id,
			event,
		]),
	);

	return scoped.filter((task) =>
		[...(lineage.get(task.id)?.values() ?? [])].every((fieldIds) =>
			fieldIds.every((id) => {
				const source = sources.get(id);

				return Boolean(
					source &&
					(!at || source.receivedAt <= at) &&
					(sourceVisibilityAllowlist
						? sourceVisibilityAllowlist.includes(source.visibility)
						: canReadVisibility(access, source.visibility)),
				);
			}),
		),
	);
}
