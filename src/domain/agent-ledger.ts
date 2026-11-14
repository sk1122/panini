import { DomainError } from "./errors.js";

/** A session is idle after this long without a call. */
export const SESSION_IDLE_MS = 10 * 60_000;
/** A session expires after this long without a call; its claims are released. */
export const SESSION_EXPIRY_MS = 60 * 60_000;
/** Default claim length; any call from the session about the task renews it. */
export const CLAIM_TTL_MS = 2 * 60 * 60_000;

export type StoredSessionState = "active" | "ended" | "failed";
export type SessionState = StoredSessionState | "idle" | "expired";
export type ClaimState = "active" | "released" | "expired" | "taken_over";
export type ActivityClass =
	"read" | "search" | "write" | "propose" | "report" | "claim" | "session";
export type ActivityOutcome = "ok" | "denied" | "error";
export type TeamNoteState = "open" | "promoted" | "dismissed";

export interface AgentSession {
	id: string;
	agentProfileId: string;
	memberId: string;
	clientSessionId: string;
	harness: string | null;
	repository: string | null;
	branch: string | null;
	objective: string | null;
	state: SessionState;
	startedAt: string;
	lastSeenAt: string;
	endedAt: string | null;
	costUsd: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
}

export interface SessionCounts {
	reads: number;
	writes: number;
	denied: number;
	errors: number;
}

export interface SessionSummary extends AgentSession {
	counts: SessionCounts;
	claims: TaskClaim[];
}

export interface TaskClaim {
	id: string;
	taskId: string;
	sessionId: string;
	agentProfileId: string;
	memberId: string;
	state: ClaimState;
	inferred: boolean;
	claimedAt: string;
	expiresAt: string;
	releasedAt: string | null;
}

export interface ActivityEvent {
	id: string;
	occurredAt: string;
	agentProfileId: string;
	memberId: string;
	sessionId: string | null;
	tool: string;
	actionClass: ActivityClass;
	targetIds: string[];
	resultCount: number | null;
	outcome: ActivityOutcome;
	detail: string | null;
	durationMs: number;
}

export type NewActivityEvent = Omit<ActivityEvent, "id" | "occurredAt"> & {
	occurredAt?: string;
};

export interface HandoffNote {
	id: string;
	taskId: string;
	sessionId: string | null;
	agentProfileId: string | null;
	memberId: string | null;
	author: string;
	done: string;
	notDone: string;
	openQuestions: string;
	nextStep: string;
	artifacts: string[];
	sourceEventId: string;
	createdAt: string;
}

export type NewHandoffNote = Omit<HandoffNote, "id" | "createdAt">;

export interface TeamNote {
	id: string;
	author: string;
	agentProfileId: string | null;
	memberId: string | null;
	sessionId: string | null;
	project: string | null;
	taskId: string | null;
	text: string;
	links: string[];
	visibility: string;
	state: TeamNoteState;
	sourceEventId: string;
	createdAt: string;
	updatedAt: string;
}

export type NewTeamNote = Omit<
	TeamNote,
	"id" | "state" | "createdAt" | "updatedAt"
>;

export interface SessionStartInput {
	agentProfileId: string;
	memberId: string;
	clientSessionId: string | null;
	harness?: string | null;
	repository?: string | null;
	branch?: string | null;
	objective?: string | null;
	now?: string;
}

export interface ClaimResult {
	claim: TaskClaim;
	others: TaskClaim[];
	created: boolean;
}

/** Storage for the agent ledger. Every method is scoped to one organization. */
export interface AgentLedgerStore {
	/** Find the session by client id, or the profile's latest live session, or create one. */
	resolveSession(input: SessionStartInput): Promise<AgentSession>;
	endSession(
		id: string,
		state: "ended" | "failed",
		now?: string,
	): Promise<AgentSession | null>;
	getSession(id: string): Promise<AgentSession | null>;
	listSessions(filter: {
		agentProfileIds?: string[];
		since?: string;
		limit?: number;
	}): Promise<SessionSummary[]>;
	addSessionUsage(
		id: string,
		usage: {
			costUsd?: number;
			inputTokens?: number;
			outputTokens?: number;
		},
	): Promise<void>;
	recordActivity(event: NewActivityEvent): Promise<ActivityEvent>;
	listActivity(filter: {
		sessionId?: string;
		agentProfileIds?: string[];
		limit?: number;
	}): Promise<ActivityEvent[]>;
	claimTask(input: {
		taskId: string;
		session: AgentSession;
		inferred?: boolean;
		ttlMs?: number;
		now?: string;
	}): Promise<ClaimResult>;
	releaseClaims(
		filter: { sessionId?: string; taskId?: string; claimId?: string },
		state: Exclude<ClaimState, "active">,
		now?: string,
	): Promise<TaskClaim[]>;
	listClaims(filter: {
		taskIds?: string[];
		active?: boolean;
		limit?: number;
	}): Promise<TaskClaim[]>;
	addHandoff(note: NewHandoffNote): Promise<HandoffNote>;
	listHandoffs(taskId: string, limit?: number): Promise<HandoffNote[]>;
	addNote(note: NewTeamNote): Promise<TeamNote>;
	listNotes(filter: {
		state?: TeamNoteState;
		limit?: number;
	}): Promise<TeamNote[]>;
	setNoteState(id: string, state: TeamNoteState): Promise<TeamNote>;
}

export function deriveSessionState(
	stored: StoredSessionState,
	lastSeenAt: string,
	now = Date.now(),
): SessionState {
	if (stored !== "active") return stored;

	const quiet = now - Date.parse(lastSeenAt);

	if (quiet > SESSION_EXPIRY_MS) return "expired";
	if (quiet > SESSION_IDLE_MS) return "idle";
	return "active";
}

export function isLiveSession(session: AgentSession): boolean {
	return session.state === "active" || session.state === "idle";
}

export function deriveClaimState(
	claim: TaskClaim,
	session: AgentSession | null,
	now = Date.now(),
): ClaimState {
	if (claim.state !== "active") return claim.state;
	if (Date.parse(claim.expiresAt) <= now) return "expired";
	if (!session || !isLiveSession(session)) return "expired";
	return "active";
}

const MAX_TEXT = 4_000;

export function validateHandoff(input: {
	done: string;
	notDone: string;
	openQuestions: string;
	nextStep: string;
}): void {
	const total =
		input.done.length +
		input.notDone.length +
		input.openQuestions.length +
		input.nextStep.length;

	if (total === 0)
		throw new DomainError("A handoff note cannot be empty.", "INVALID");
	if (total > MAX_TEXT)
		throw new DomainError(
			`A handoff note is limited to ${MAX_TEXT} characters.`,
			"INVALID",
		);
}

export function countActivity(
	events: Pick<ActivityEvent, "actionClass" | "outcome">[],
): SessionCounts {
	return events.reduce(
		(counts, event) => {
			if (event.outcome === "denied") counts.denied += 1;
			else if (event.outcome === "error") counts.errors += 1;
			else if (
				event.actionClass === "read" ||
				event.actionClass === "search"
			)
				counts.reads += 1;
			else if (event.actionClass !== "session") counts.writes += 1;
			return counts;
		},
		{ reads: 0, writes: 0, denied: 0, errors: 0 },
	);
}
