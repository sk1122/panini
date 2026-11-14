import type { ActivityEvent, AgentSession } from "./agent-ledger.js";

/*
 * Turns an agent session's tool calls into short sentences a person can read:
 * "Started working on 'Fix login retry'" instead of "task_claim · 5 items".
 */

export interface StoryLine {
	at: string;
	text: string;
	kind: "read" | "write" | "problem" | "session";
}

const quote = (title: string) => `“${title}”`;

function taskOf(event: ActivityEvent, titles: Map<string, string>) {
	const id = event.targetIds.find((target) => titles.has(target));

	return id ? quote(titles.get(id)!) : "a task";
}

const reasons: [RegExp, string][] = [
	[/source:read/, "it may not read raw sources"],
	[/work:propose/, "it may not change work"],
	[/context:propose/, "it may not propose context"],
	[/evidence:report/, "it may not report work"],
	[/project scope|outside its project/, "the task is outside its projects"],
	[
		/cannot read this task|cannot read this context/,
		"it may not see that item",
	],
];

export function blockedText(tool: string, detail: string | null): string {
	const reason =
		reasons.find(([pattern]) => pattern.test(detail ?? ""))?.[1] ??
		"it lacks permission";

	return `${actionName(tool)} was blocked: ${reason}`;
}

function actionName(tool: string): string {
	const names: Record<string, string> = {
		source_read: "Reading a source document",
		memory_read: "Reading an item",
		task_claim: "Claiming a task",
		work_report: "Reporting work",
		proposal_create: "Proposing a change",
		task_create_proposal: "Proposing a task",
		context_proposal_create: "Proposing context",
		decision_propose: "Recording a decision",
		note_drop: "Sharing a note",
		handoff_write: "Writing a handoff",
	};

	return names[tool] ?? "A request";
}

function sentence(
	event: ActivityEvent,
	titles: Map<string, string>,
	session: AgentSession,
): StoryLine | null {
	const at = event.occurredAt;

	if (event.outcome === "denied")
		return {
			at,
			text: blockedText(event.tool, event.detail),
			kind: "problem",
		};
	if (event.outcome === "error")
		return {
			at,
			text: `${actionName(event.tool)} failed`,
			kind: "problem",
		};

	switch (event.tool) {
		case "hook:session_start":
			return {
				at,
				text: `Started a session${session.repository ? ` in ${session.repository}` : ""}${session.branch ? ` on ${session.branch}` : ""}`,
				kind: "session",
			};
		case "hook:session_end":
		case "session_end":
			return { at, text: "Ended the session", kind: "session" };
		case "hook:session_failed":
			return {
				at,
				text: "The session stopped with an error",
				kind: "problem",
			};
		case "context_get":
			return { at, text: "Read the company context", kind: "read" };
		case "context_read":
		case "memory_read":
		case "history_get":
			return { at, text: "Opened company knowledge", kind: "read" };
		case "source_read":
			return { at, text: "Read a source document", kind: "read" };
		case "work_search":
		case "context_search":
			return { at, text: "Searched for work", kind: "read" };
		case "task_claim":
			return {
				at,
				text: `Started working on ${taskOf(event, titles)}`,
				kind: "write",
			};
		case "task_release":
			return {
				at,
				text: `Stopped working on ${taskOf(event, titles)}`,
				kind: "write",
			};
		case "work_report":
			return {
				at,
				text: `Reported progress on ${taskOf(event, titles)}`,
				kind: "write",
			};
		case "handoff_write":
			return {
				at,
				text: `Left a handoff note on ${taskOf(event, titles)}`,
				kind: "write",
			};
		case "note_drop":
			return { at, text: "Shared a note with the team", kind: "write" };
		case "decision_propose":
			return { at, text: "Recorded a decision", kind: "write" };
		case "proposal_create":
		case "task_create_proposal":
		case "context_proposal_create":
		case "outcome_contract_proposal_create":
			return { at, text: "Changed company work", kind: "write" };
		case "agent_file_write":
		case "agent_file_delete":
		case "user_file_write":
		case "user_file_delete":
			return { at, text: "Updated its private notes", kind: "write" };
		default:
			// Connection checks and private-note reads are not worth a line.
			return null;
	}
}

/** Oldest first; repeated lines collapse into one with a count. */
export function describeSession(
	events: ActivityEvent[],
	titles: Map<string, string>,
	session: AgentSession,
): StoryLine[] {
	const lines: (StoryLine & { times: number })[] = [];

	for (const event of events) {
		const line = sentence(event, titles, session);

		if (!line) continue;

		const last = lines.at(-1);

		if (last && last.text === line.text) last.times += 1;
		else lines.push({ ...line, times: 1 });
	}
	return lines.map(({ times, ...line }) => ({
		...line,
		text: times > 1 ? `${line.text} (${times} times)` : line.text,
	}));
}
