import { DomainError } from "./errors.js";
import { isContextEffective } from "./context-catalog.js";
import type {
	AgentDataScope,
	ContextEntry,
	Proposal,
	SourceEvent,
	Task,
} from "./types.js";

export type AccessScope =
	| { kind: "admin" }
	| { kind: "member"; organizationId: string; memberId: string }
	| {
			kind: "agent";
			organizationId: string;
			memberId: string;
			agentProfileId: string;
			dataScope: AgentDataScope;
	  };

export function normalizeContextScope(input: string): string {
	const raw = input.trim().replaceAll("\\", "/");

	if (!raw || /[\u0000-\u001f?#]/.test(raw)) {
		throw new DomainError(
			"A context scope contains unsupported characters.",
			"INVALID",
		);
	}

	const segments = raw
		.split("/")
		.filter((segment) => segment && segment !== ".");

	if (segments.some((segment) => segment === "..")) {
		throw new DomainError(
			"A context scope cannot traverse parent folders.",
			"INVALID",
		);
	}
	return segments.length === 0 ? "/" : `/${segments.join("/")}`;
}

function pathWithin(path: string, scope: string): boolean {
	return scope === "/" || path === scope || path.startsWith(`${scope}/`);
}

export function intersectContextScopes(
	left: string[],
	right: string[],
): string[] {
	const intersections = left.flatMap((leftPath) =>
		right.flatMap((rightPath) => {
			const normalizedLeft = normalizeContextScope(leftPath);
			const normalizedRight = normalizeContextScope(rightPath);

			if (pathWithin(normalizedLeft, normalizedRight))
				return [normalizedLeft];
			if (pathWithin(normalizedRight, normalizedLeft))
				return [normalizedRight];
			return [];
		}),
	);

	return [...new Set(intersections)];
}

export function canReadContextPath(access: AccessScope, path: string): boolean {
	return (
		access.kind !== "agent" ||
		access.dataScope.contextPaths.some((scope) => pathWithin(path, scope))
	);
}

export function canReadVisibility(
	access: AccessScope,
	visibility: string,
): boolean {
	if (access.kind === "admin") return true;
	if (access.kind === "member")
		return (
			visibility === "company" ||
			visibility === `member:${access.memberId}`
		);
	return (
		access.dataScope.sourceVisibilities.includes(visibility) ||
		visibility === `member:${access.memberId}`
	);
}

export function canReadProject(
	access: AccessScope,
	project: string | null,
): boolean {
	if (access.kind !== "agent") return true;
	// A deliberately granted wildcard covers future projects and unassigned work.
	if (access.dataScope.projects.includes("*")) return true;
	if (!project) return false;
	return access.dataScope.projects.some(
		(allowed) =>
			allowed.toLocaleLowerCase("en") === project.toLocaleLowerCase("en"),
	);
}

export function canReadTask(access: AccessScope, task: Task): boolean {
	return (
		canReadProject(access, task.projectId ?? null) ||
		canReadProject(access, task.project)
	);
}

function proposalEvidenceIsReadable(
	access: AccessScope,
	proposal: Proposal,
	evidence: SourceEvent[],
): boolean {
	const expected = new Set(proposal.evidenceIds);

	return (
		evidence.length === expected.size &&
		evidence.every(
			(event) =>
				expected.has(event.id) &&
				canReadVisibility(access, event.visibility),
		)
	);
}

/**
 * Authorize the complete proposal envelope, including its target and evidence.
 * Pending proposals can contain source-derived rationale that is not yet
 * accepted memory, so target access alone is intentionally insufficient.
 */
export function canReadProposal(
	access: AccessScope,
	proposal: Proposal,
	task: Task | null,
	evidence: SourceEvent[],
): boolean {
	if (!proposalEvidenceIsReadable(access, proposal, evidence)) return false;
	if (access.kind === "admin") return true;
	if (proposal.kind === "task_change") {
		if (!task || !canReadTask(access, task)) return false;
		return (
			proposal.changes.project === undefined ||
			canReadProject(access, proposal.changes.project)
		);
	}
	if (proposal.kind === "task_create")
		return canReadProject(access, proposal.changes.project ?? null);
	if (proposal.kind === "context_update")
		return canReadContextPath(access, proposal.changes.key);
	if (
		proposal.kind === "context_file_upsert" ||
		proposal.kind === "context_fact_upsert"
	) {
		return canReadContextPath(access, proposal.changes.path);
	}
	return false;
}

export function canReadContextEntry(
	access: AccessScope,
	entry: ContextEntry,
	evidence: SourceEvent[],
): boolean {
	if (!canReadContextPath(access, entry.path)) return false;
	if (access.kind === "agent") {
		const projectLinks = entry.links.filter(
			(link) => link.type === "project",
		);
		const nestedWorkLinks = entry.links.filter(
			(link) => link.type === "workstream" || link.type === "task",
		);

		if (nestedWorkLinks.length > 0 && projectLinks.length === 0)
			return false;
		if (
			projectLinks.length > 0 &&
			!projectLinks.some(
				(link) =>
					canReadProject(access, link.targetRef) ||
					(link.targetId
						? canReadProject(access, link.targetId)
						: false),
			)
		)
			return false;
	}

	const expected = new Set(entry.evidenceIds);

	if (
		evidence.length !== expected.size ||
		evidence.some((event) => !expected.has(event.id))
	)
		return false;
	return evidence.every((event) =>
		canReadVisibility(access, event.visibility),
	);
}

export function canRecallContextEntry(
	access: AccessScope,
	entry: ContextEntry,
	evidence: SourceEvent[],
	at = new Date().toISOString(),
): boolean {
	return (
		isContextEffective(entry, at) &&
		evidence.every((event) => event.receivedAt <= at) &&
		canReadContextEntry(access, entry, evidence)
	);
}

export function normalizeAgentDataScope(
	input?: Partial<AgentDataScope>,
): AgentDataScope {
	const projects = [
		...new Set(
			(input?.projects ?? [])
				.map((value) => value.trim())
				.filter(Boolean),
		),
	];
	const contextPaths = [
		...new Set((input?.contextPaths ?? ["/"]).map(normalizeContextScope)),
	];
	const sourceVisibilities = [
		...new Set(
			(input?.sourceVisibilities ?? ["company"])
				.map((value) => value.trim())
				.filter(Boolean),
		),
	];

	if (contextPaths.length === 0)
		throw new DomainError(
			"An agent profile requires at least one context path scope.",
			"INVALID",
		);
	if (sourceVisibilities.length === 0)
		throw new DomainError(
			"An agent profile requires at least one source visibility grant.",
			"INVALID",
		);
	return { projects, contextPaths, sourceVisibilities };
}
