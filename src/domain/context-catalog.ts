import { contentHash } from "./content-hash.js";
import { DomainError } from "./errors.js";
import type {
	ContextEntry,
	ContextFact,
	ContextFactProposalChanges,
	ContextFile,
	ContextFileProposalChanges,
	ContextIndex,
	ContextLink,
	ContextProposalChanges,
	ContextTreeNode,
	NewContextEntry,
	Proposal,
} from "./types.js";

export function contextSlug(value: string): string {
	return (
		value
			.normalize("NFKD")
			.replace(/[\u0300-\u036f]/g, "")
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 100) || "untitled"
	);
}

export function normalizeContextPath(
	input: string,
	kind: "file" | "fact",
): string {
	const raw = input.trim().replaceAll("\\", "/");

	if (!raw || /[\u0000-\u001f?#]/.test(raw)) {
		throw new DomainError(
			"Context path contains unsupported characters.",
			"INVALID",
		);
	}

	const segments = raw
		.split("/")
		.filter((segment) => segment && segment !== ".");

	if (segments.some((segment) => segment === "..")) {
		throw new DomainError(
			"Context path cannot traverse parent folders.",
			"INVALID",
		);
	}
	if (
		segments.some((segment) => segment.length > 120) ||
		segments.length === 0
	) {
		throw new DomainError("Context path is invalid.", "INVALID");
	}

	let path = `/${segments.join("/")}`;

	if (kind === "file" && !/\.[a-z0-9]{1,12}$/i.test(path)) path += ".md";
	if (path.length > 500)
		throw new DomainError("Context path is too long.", "INVALID");
	return path;
}

type ContextProposal = Extract<
	Proposal,
	{ kind: "context_update" | "context_file_upsert" | "context_fact_upsert" }
>;

export function contextEntryFromProposal(
	proposal: ContextProposal,
	sourceEventId: string,
	evidenceContentHash: string,
	sourceOccurredAt: string,
): NewContextEntry {
	if (proposal.kind === "context_fact_upsert") {
		const changes: ContextFactProposalChanges = proposal.changes;

		return {
			kind: "fact",
			sourceEventId,
			sourceRef: changes.sourceRef,
			path: normalizeContextPath(changes.path, "fact"),
			title: changes.title.trim(),
			factType: changes.factType,
			value: changes.value,
			sourceUrl: changes.sourceUrl,
			contentHash: evidenceContentHash || contentHash(changes),
			evidenceIds: proposal.evidenceIds,
			lifecycleState: changes.lifecycleState ?? "accepted",
			effectiveFrom: changes.effectiveFrom ?? sourceOccurredAt,
			effectiveTo: changes.effectiveTo ?? null,
			links: normalizeContextLinks(changes.links ?? []),
		};
	}

	const changes: ContextFileProposalChanges =
		proposal.kind === "context_update"
			? legacyFileChanges(proposal.changes)
			: proposal.changes;

	return {
		kind: "file",
		sourceEventId,
		sourceRef: changes.sourceRef,
		path: normalizeContextPath(changes.path, "file"),
		title: changes.title.trim(),
		body: changes.body,
		sourceUrl: changes.sourceUrl,
		contentHash: evidenceContentHash || contentHash(changes),
		evidenceIds: proposal.evidenceIds,
		lifecycleState: changes.lifecycleState ?? "accepted",
		effectiveFrom: changes.effectiveFrom ?? sourceOccurredAt,
		effectiveTo: changes.effectiveTo ?? null,
		links: normalizeContextLinks(changes.links ?? []),
	};
}

export function normalizeContextLinks(input: ContextLink[]): ContextLink[] {
	const result = new Map<string, ContextLink>();

	for (const link of input) {
		const targetRef = link.targetRef.trim();
		const targetId = link.targetId?.trim() || null;

		if (!targetRef)
			throw new DomainError(
				"A context link requires a target reference.",
				"INVALID",
			);

		const normalized = { type: link.type, targetId, targetRef };

		result.set(
			`${link.type}:${targetId ?? ""}:${targetRef.toLocaleLowerCase("en")}`,
			normalized,
		);
	}
	return [...result.values()].sort(
		(left, right) =>
			left.type.localeCompare(right.type) ||
			left.targetRef.localeCompare(right.targetRef),
	);
}

export function isContextEffective(
	entry: ContextEntry,
	at = new Date().toISOString(),
): boolean {
	return (
		entry.lifecycleState === "accepted" &&
		entry.effectiveFrom <= at &&
		(entry.effectiveTo === null || at < entry.effectiveTo)
	);
}

function legacyFileChanges(
	changes: ContextProposalChanges,
): ContextFileProposalChanges {
	return {
		sourceRef: changes.sourceRef,
		path: `/legacy/${contextSlug(changes.key)}.md`,
		title: changes.title,
		body: changes.body,
		sourceUrl: changes.sourceUrl,
	};
}

function entryNode(entry: ContextEntry): ContextTreeNode {
	const name = entry.path.split("/").at(-1) ?? entry.title;

	return {
		kind: entry.kind,
		name,
		path: entry.path,
		entryId: entry.id,
		lifecycleState: entry.lifecycleState,
		effectiveFrom: entry.effectiveFrom,
		effectiveTo: entry.effectiveTo,
		children: [],
	};
}

function sortTree(nodes: ContextTreeNode[]): ContextTreeNode[] {
	const rank = { folder: 0, file: 1, fact: 2 } as const;

	nodes.sort(
		(left, right) =>
			rank[left.kind] - rank[right.kind] ||
			left.name.localeCompare(right.name),
	);
	for (const node of nodes) sortTree(node.children);
	return nodes;
}

export function buildContextTree(entries: ContextEntry[]): ContextTreeNode[] {
	const roots: ContextTreeNode[] = [];
	const folders = new Map<string, ContextTreeNode>();

	for (const entry of [...entries].sort((left, right) =>
		left.path.localeCompare(right.path),
	)) {
		const segments = entry.path.split("/").filter(Boolean);
		let parent = roots;
		let currentPath = "";

		for (const segment of segments.slice(0, -1)) {
			currentPath += `/${segment}`;

			let folder = folders.get(currentPath);

			if (!folder) {
				folder = {
					kind: "folder",
					name: segment,
					path: currentPath,
					entryId: null,
					lifecycleState: null,
					effectiveFrom: null,
					effectiveTo: null,
					children: [],
				};
				folders.set(currentPath, folder);
				parent.push(folder);
			}
			parent = folder.children;
		}
		parent.push(entryNode(entry));
	}
	return sortTree(roots);
}

export function createContextIndex(
	entries: ContextEntry[],
	now = new Date().toISOString(),
): ContextIndex {
	const facts = entries.filter(
		(entry): entry is ContextFact => entry.kind === "fact",
	);
	const files = entries
		.filter((entry): entry is ContextFile => entry.kind === "file")
		.map(({ body, ...file }) => ({
			...file,
			excerpt: body.length > 220 ? `${body.slice(0, 219)}…` : body,
			characterCount: body.length,
		}));
	const tree = buildContextTree(entries);

	const countFolders = (nodes: ContextTreeNode[]): number =>
		nodes.reduce(
			(total, node) =>
				total +
				(node.kind === "folder" ? 1 : 0) +
				countFolders(node.children),
			0,
		);

	return {
		generatedAt: now,
		tree,
		facts,
		files,
		counts: {
			facts: facts.length,
			files: files.length,
			folders: countFolders(tree),
			accepted: entries.filter((entry) => isContextEffective(entry, now))
				.length,
			needsReview: entries.filter(
				(entry) => entry.lifecycleState === "needs_review",
			).length,
			superseded: entries.filter(
				(entry) => entry.lifecycleState === "superseded",
			).length,
			outsideEffectiveInterval: entries.filter(
				(entry) =>
					entry.lifecycleState === "accepted" &&
					!isContextEffective(entry, now),
			).length,
		},
	};
}
