import { randomUUID } from "node:crypto";
import type pg from "pg";
import {
	CLAIM_TTL_MS,
	SESSION_EXPIRY_MS,
	countActivity,
	deriveClaimState,
	deriveSessionState,
	validateHandoff,
	type ActivityEvent,
	type AgentLedgerStore,
	type AgentSession,
	type ClaimResult,
	type ClaimState,
	type HandoffNote,
	type NewActivityEvent,
	type NewHandoffNote,
	type NewTeamNote,
	type SessionStartInput,
	type SessionSummary,
	type StoredSessionState,
	type TaskClaim,
	type TeamNote,
	type TeamNoteState,
} from "../domain/agent-ledger.js";
import { DomainError } from "../domain/errors.js";

interface SessionRow {
	id: string;
	agent_profile_id: string;
	member_id: string;
	client_session_id: string;
	harness: string | null;
	repository: string | null;
	branch: string | null;
	objective: string | null;
	state: StoredSessionState;
	started_at: Date;
	last_seen_at: Date;
	ended_at: Date | null;
	cost_usd: string | null;
	input_tokens: string | null;
	output_tokens: string | null;
}

interface ClaimRow {
	id: string;
	task_id: string;
	session_id: string;
	agent_profile_id: string;
	member_id: string;
	state: ClaimState;
	inferred: boolean;
	claimed_at: Date;
	expires_at: Date;
	released_at: Date | null;
	session_state: StoredSessionState | null;
	session_last_seen_at: Date | null;
}

const iso = (value: Date | null): string | null =>
	value ? value.toISOString() : null;

const num = (value: string | null): number | null =>
	value === null ? null : Number(value);

function sessionFromRow(row: SessionRow, now = Date.now()): AgentSession {
	return {
		id: row.id,
		agentProfileId: row.agent_profile_id,
		memberId: row.member_id,
		clientSessionId: row.client_session_id,
		harness: row.harness,
		repository: row.repository,
		branch: row.branch,
		objective: row.objective,
		state: deriveSessionState(
			row.state,
			row.last_seen_at.toISOString(),
			now,
		),
		startedAt: row.started_at.toISOString(),
		lastSeenAt: row.last_seen_at.toISOString(),
		endedAt: iso(row.ended_at),
		costUsd: num(row.cost_usd),
		inputTokens: num(row.input_tokens),
		outputTokens: num(row.output_tokens),
	};
}

function claimFromRow(row: ClaimRow, now = Date.now()): TaskClaim {
	const claim: TaskClaim = {
		id: row.id,
		taskId: row.task_id,
		sessionId: row.session_id,
		agentProfileId: row.agent_profile_id,
		memberId: row.member_id,
		state: row.state,
		inferred: row.inferred,
		claimedAt: row.claimed_at.toISOString(),
		expiresAt: row.expires_at.toISOString(),
		releasedAt: iso(row.released_at),
	};
	const session =
		row.session_state && row.session_last_seen_at
			? ({
					state: deriveSessionState(
						row.session_state,
						row.session_last_seen_at.toISOString(),
						now,
					),
				} as AgentSession)
			: null;

	return { ...claim, state: deriveClaimState(claim, session, now) };
}

const CLAIM_SELECT = `SELECT c.*, s.state AS session_state, s.last_seen_at AS session_last_seen_at
 FROM task_claims c LEFT JOIN agent_sessions s ON s.id=c.session_id`;

export class PostgresAgentLedger implements AgentLedgerStore {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
	) {}

	async resolveSession(input: SessionStartInput): Promise<AgentSession> {
		const now = input.now ? new Date(input.now) : new Date();

		if (input.clientSessionId) {
			const row = (
				await this.pool.query<SessionRow>(
					`INSERT INTO agent_sessions (id,organization_id,agent_profile_id,member_id,client_session_id,harness,repository,branch,objective,state,started_at,last_seen_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'active',$10,$10)
           ON CONFLICT (organization_id,agent_profile_id,client_session_id) DO UPDATE SET
             last_seen_at=GREATEST(agent_sessions.last_seen_at,EXCLUDED.last_seen_at),
             harness=COALESCE(EXCLUDED.harness,agent_sessions.harness),
             repository=COALESCE(EXCLUDED.repository,agent_sessions.repository),
             branch=COALESCE(EXCLUDED.branch,agent_sessions.branch),
             objective=COALESCE(EXCLUDED.objective,agent_sessions.objective)
           RETURNING *`,
					[
						randomUUID(),
						this.organizationId,
						input.agentProfileId,
						input.memberId,
						input.clientSessionId,
						input.harness ?? null,
						input.repository ?? null,
						input.branch ?? null,
						input.objective ?? null,
						now,
					],
				)
			).rows[0]!;

			return sessionFromRow(row, now.getTime());
		}

		const live = (
			await this.pool.query<SessionRow>(
				`UPDATE agent_sessions SET last_seen_at=GREATEST(last_seen_at,$4)
         WHERE id=(SELECT id FROM agent_sessions WHERE organization_id=$1 AND agent_profile_id=$2 AND state='active'
                   AND last_seen_at > $3 ORDER BY last_seen_at DESC LIMIT 1)
         RETURNING *`,
				[
					this.organizationId,
					input.agentProfileId,
					new Date(now.getTime() - SESSION_EXPIRY_MS),
					now,
				],
			)
		).rows[0];

		if (live) return sessionFromRow(live, now.getTime());
		return this.resolveSession({
			...input,
			clientSessionId: `implicit:${randomUUID()}`,
		});
	}

	async endSession(
		id: string,
		state: "ended" | "failed",
		now = new Date().toISOString(),
	): Promise<AgentSession | null> {
		const row = (
			await this.pool.query<SessionRow>(
				`UPDATE agent_sessions SET state=CASE WHEN state='active' THEN $3 ELSE state END,
           ended_at=COALESCE(ended_at,$4), last_seen_at=GREATEST(last_seen_at,$4)
         WHERE organization_id=$1 AND id=$2 RETURNING *`,
				[this.organizationId, id, state, now],
			)
		).rows[0];

		if (!row) return null;
		await this.releaseClaims({ sessionId: id }, "released", now);
		return sessionFromRow(row);
	}

	async getSession(id: string): Promise<AgentSession | null> {
		const row = (
			await this.pool.query<SessionRow>(
				"SELECT * FROM agent_sessions WHERE organization_id=$1 AND id=$2",
				[this.organizationId, id],
			)
		).rows[0];

		return row ? sessionFromRow(row) : null;
	}

	async listSessions(filter: {
		agentProfileIds?: string[];
		since?: string;
		limit?: number;
	}): Promise<SessionSummary[]> {
		const rows = (
			await this.pool.query<SessionRow>(
				`SELECT * FROM agent_sessions WHERE organization_id=$1
           AND ($2::uuid[] IS NULL OR agent_profile_id = ANY($2))
           AND ($3::timestamptz IS NULL OR last_seen_at >= $3)
         ORDER BY last_seen_at DESC LIMIT $4`,
				[
					this.organizationId,
					filter.agentProfileIds ?? null,
					filter.since ?? null,
					filter.limit ?? 100,
				],
			)
		).rows;

		if (rows.length === 0) return [];

		const ids = rows.map((row) => row.id);
		const [counts, claims] = await Promise.all([
			this.pool.query<{
				session_id: string;
				action_class: ActivityEvent["actionClass"];
				outcome: ActivityEvent["outcome"];
				n: string;
			}>(
				`SELECT session_id,action_class,outcome,count(*) AS n FROM agent_activity_events
         WHERE organization_id=$1 AND session_id = ANY($2) GROUP BY session_id,action_class,outcome`,
				[this.organizationId, ids],
			),
			this.pool.query<ClaimRow>(
				`${CLAIM_SELECT} WHERE c.organization_id=$1 AND c.session_id = ANY($2) ORDER BY c.claimed_at DESC`,
				[this.organizationId, ids],
			),
		]);
		const now = Date.now();

		return rows.map((row) => ({
			...sessionFromRow(row, now),
			counts: countActivity(
				counts.rows
					.filter((count) => count.session_id === row.id)
					.flatMap((count) =>
						Array.from({ length: Number(count.n) }, () => ({
							actionClass: count.action_class,
							outcome: count.outcome,
						})),
					),
			),
			claims: claims.rows
				.filter((claim) => claim.session_id === row.id)
				.map((claim) => claimFromRow(claim, now)),
		}));
	}

	async addSessionUsage(
		id: string,
		usage: {
			costUsd?: number;
			inputTokens?: number;
			outputTokens?: number;
		},
	): Promise<void> {
		await this.pool.query(
			`UPDATE agent_sessions SET
         cost_usd = CASE WHEN $3::numeric IS NULL THEN cost_usd ELSE COALESCE(cost_usd,0)+$3 END,
         input_tokens = CASE WHEN $4::bigint IS NULL THEN input_tokens ELSE COALESCE(input_tokens,0)+$4 END,
         output_tokens = CASE WHEN $5::bigint IS NULL THEN output_tokens ELSE COALESCE(output_tokens,0)+$5 END
       WHERE organization_id=$1 AND id=$2`,
			[
				this.organizationId,
				id,
				usage.costUsd ?? null,
				usage.inputTokens ?? null,
				usage.outputTokens ?? null,
			],
		);
	}

	async recordActivity(input: NewActivityEvent): Promise<ActivityEvent> {
		const event: ActivityEvent = {
			...input,
			targetIds: input.targetIds.slice(0, 100),
			detail: input.detail ? input.detail.slice(0, 500) : null,
			id: randomUUID(),
			occurredAt: input.occurredAt ?? new Date().toISOString(),
		};

		await this.pool.query(
			`INSERT INTO agent_activity_events (id,organization_id,agent_profile_id,member_id,session_id,occurred_at,tool,action_class,target_ids,result_count,outcome,detail,duration_ms)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
			[
				event.id,
				this.organizationId,
				event.agentProfileId,
				event.memberId,
				event.sessionId,
				event.occurredAt,
				event.tool,
				event.actionClass,
				event.targetIds,
				event.resultCount,
				event.outcome,
				event.detail,
				Math.max(0, Math.round(event.durationMs)),
			],
		);
		if (event.sessionId && event.targetIds.length > 0) {
			await this.pool.query(
				`UPDATE task_claims SET expires_at=GREATEST(expires_at,$4::timestamptz + make_interval(secs => $5))
         WHERE organization_id=$1 AND session_id=$2 AND state='active' AND task_id::text = ANY($3)`,
				[
					this.organizationId,
					event.sessionId,
					event.targetIds,
					event.occurredAt,
					CLAIM_TTL_MS / 1000,
				],
			);
		}
		return event;
	}

	async listActivity(filter: {
		sessionId?: string;
		agentProfileIds?: string[];
		limit?: number;
	}): Promise<ActivityEvent[]> {
		const rows = (
			await this.pool.query<{
				id: string;
				occurred_at: Date;
				agent_profile_id: string;
				member_id: string;
				session_id: string | null;
				tool: string;
				action_class: ActivityEvent["actionClass"];
				target_ids: string[];
				result_count: number | null;
				outcome: ActivityEvent["outcome"];
				detail: string | null;
				duration_ms: number;
			}>(
				`SELECT * FROM agent_activity_events WHERE organization_id=$1
           AND ($2::uuid IS NULL OR session_id=$2)
           AND ($3::uuid[] IS NULL OR agent_profile_id = ANY($3))
         ORDER BY occurred_at DESC LIMIT $4`,
				[
					this.organizationId,
					filter.sessionId ?? null,
					filter.agentProfileIds ?? null,
					filter.limit ?? 200,
				],
			)
		).rows;

		return rows.map((row) => ({
			id: row.id,
			occurredAt: row.occurred_at.toISOString(),
			agentProfileId: row.agent_profile_id,
			memberId: row.member_id,
			sessionId: row.session_id,
			tool: row.tool,
			actionClass: row.action_class,
			targetIds: row.target_ids,
			resultCount: row.result_count,
			outcome: row.outcome,
			detail: row.detail,
			durationMs: row.duration_ms,
		}));
	}

	async claimTask(input: {
		taskId: string;
		session: AgentSession;
		inferred?: boolean;
		ttlMs?: number;
		now?: string;
	}): Promise<ClaimResult> {
		const now = input.now ? new Date(input.now) : new Date();
		const expiresAt = new Date(
			now.getTime() + (input.ttlMs ?? CLAIM_TTL_MS),
		);
		const client = await this.pool.connect();

		try {
			await client.query("BEGIN");
			await client.query(
				"SELECT id FROM tasks WHERE organization_id=$1 AND id=$2 FOR UPDATE",
				[this.organizationId, input.taskId],
			);

			const live = (
				await client.query<ClaimRow>(
					`${CLAIM_SELECT} WHERE c.organization_id=$1 AND c.task_id=$2 AND c.state='active'`,
					[this.organizationId, input.taskId],
				)
			).rows
				.map((row) => claimFromRow(row, now.getTime()))
				.filter((claim) => claim.state === "active");
			const mine = live.find(
				(claim) => claim.sessionId === input.session.id,
			);
			const others = live.filter(
				(claim) => claim.sessionId !== input.session.id,
			);
			let claim: TaskClaim;
			let created = false;

			if (mine) {
				await client.query(
					"UPDATE task_claims SET expires_at=GREATEST(expires_at,$3) WHERE organization_id=$1 AND id=$2",
					[this.organizationId, mine.id, expiresAt],
				);
				claim = {
					...mine,
					expiresAt: new Date(
						Math.max(
							Date.parse(mine.expiresAt),
							expiresAt.getTime(),
						),
					).toISOString(),
				};
			} else {
				await client.query(
					`UPDATE task_claims SET state='expired', released_at=$3
           WHERE organization_id=$1 AND task_id=$2 AND session_id=$4 AND state='active'`,
					[this.organizationId, input.taskId, now, input.session.id],
				);
				claim = {
					id: randomUUID(),
					taskId: input.taskId,
					sessionId: input.session.id,
					agentProfileId: input.session.agentProfileId,
					memberId: input.session.memberId,
					state: "active",
					inferred: input.inferred ?? false,
					claimedAt: now.toISOString(),
					expiresAt: expiresAt.toISOString(),
					releasedAt: null,
				};
				await client.query(
					`INSERT INTO task_claims (id,organization_id,task_id,session_id,agent_profile_id,member_id,state,inferred,claimed_at,expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,'active',$7,$8,$9)`,
					[
						claim.id,
						this.organizationId,
						claim.taskId,
						claim.sessionId,
						claim.agentProfileId,
						claim.memberId,
						claim.inferred,
						claim.claimedAt,
						claim.expiresAt,
					],
				);
				created = true;
			}
			await client.query("COMMIT");
			return { claim, others, created };
		} catch (error) {
			await client.query("ROLLBACK");
			throw error;
		} finally {
			client.release();
		}
	}

	async releaseClaims(
		filter: { sessionId?: string; taskId?: string; claimId?: string },
		state: Exclude<ClaimState, "active">,
		now = new Date().toISOString(),
	): Promise<TaskClaim[]> {
		if (!filter.sessionId && !filter.taskId && !filter.claimId)
			throw new DomainError("A claim filter is required.", "INVALID");

		const rows = (
			await this.pool.query<ClaimRow>(
				`UPDATE task_claims c SET state=$5, released_at=$6
         WHERE c.organization_id=$1 AND c.state='active'
           AND ($2::uuid IS NULL OR c.session_id=$2)
           AND ($3::uuid IS NULL OR c.task_id=$3)
           AND ($4::uuid IS NULL OR c.id=$4)
         RETURNING c.*, NULL::text AS session_state, NULL::timestamptz AS session_last_seen_at`,
				[
					this.organizationId,
					filter.sessionId ?? null,
					filter.taskId ?? null,
					filter.claimId ?? null,
					state,
					now,
				],
			)
		).rows;

		return rows.map((row) => claimFromRow(row));
	}

	async listClaims(filter: {
		taskIds?: string[];
		active?: boolean;
		limit?: number;
	}): Promise<TaskClaim[]> {
		const rows = (
			await this.pool.query<ClaimRow>(
				`${CLAIM_SELECT} WHERE c.organization_id=$1
           AND ($2::uuid[] IS NULL OR c.task_id = ANY($2))
           AND (NOT $3 OR c.state='active')
         ORDER BY c.claimed_at DESC LIMIT $4`,
				[
					this.organizationId,
					filter.taskIds ?? null,
					filter.active ?? false,
					filter.limit ?? 200,
				],
			)
		).rows;
		const now = Date.now();

		return rows
			.map((row) => claimFromRow(row, now))
			.filter((claim) => !filter.active || claim.state === "active");
	}

	async addHandoff(input: NewHandoffNote): Promise<HandoffNote> {
		validateHandoff(input);

		const note: HandoffNote = {
			...input,
			id: randomUUID(),
			createdAt: new Date().toISOString(),
		};

		await this.pool.query(
			`INSERT INTO handoff_notes (id,organization_id,task_id,session_id,agent_profile_id,member_id,author,done,not_done,open_questions,next_step,artifacts,source_event_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
			[
				note.id,
				this.organizationId,
				note.taskId,
				note.sessionId,
				note.agentProfileId,
				note.memberId,
				note.author,
				note.done,
				note.notDone,
				note.openQuestions,
				note.nextStep,
				note.artifacts,
				note.sourceEventId,
				note.createdAt,
			],
		);
		return note;
	}

	async listHandoffs(taskId: string, limit = 5): Promise<HandoffNote[]> {
		const rows = (
			await this.pool.query<{
				id: string;
				task_id: string;
				session_id: string | null;
				agent_profile_id: string | null;
				member_id: string | null;
				author: string;
				done: string;
				not_done: string;
				open_questions: string;
				next_step: string;
				artifacts: string[];
				source_event_id: string;
				created_at: Date;
			}>(
				`SELECT * FROM handoff_notes WHERE organization_id=$1 AND task_id=$2 ORDER BY created_at DESC LIMIT $3`,
				[this.organizationId, taskId, limit],
			)
		).rows;

		return rows.map((row) => ({
			id: row.id,
			taskId: row.task_id,
			sessionId: row.session_id,
			agentProfileId: row.agent_profile_id,
			memberId: row.member_id,
			author: row.author,
			done: row.done,
			notDone: row.not_done,
			openQuestions: row.open_questions,
			nextStep: row.next_step,
			artifacts: row.artifacts,
			sourceEventId: row.source_event_id,
			createdAt: row.created_at.toISOString(),
		}));
	}

	async addNote(input: NewTeamNote): Promise<TeamNote> {
		const now = new Date().toISOString();
		const note: TeamNote = {
			...input,
			id: randomUUID(),
			state: "open",
			createdAt: now,
			updatedAt: now,
		};

		await this.pool.query(
			`INSERT INTO team_notes (id,organization_id,author,agent_profile_id,member_id,session_id,project,task_id,text,links,visibility,state,source_event_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'open',$12,$13,$13)`,
			[
				note.id,
				this.organizationId,
				note.author,
				note.agentProfileId,
				note.memberId,
				note.sessionId,
				note.project,
				note.taskId,
				note.text,
				note.links,
				note.visibility,
				note.sourceEventId,
				now,
			],
		);
		return note;
	}

	async listNotes(filter: {
		state?: TeamNoteState;
		limit?: number;
	}): Promise<TeamNote[]> {
		const rows = (
			await this.pool.query<NoteRow>(
				`SELECT * FROM team_notes WHERE organization_id=$1 AND ($2::text IS NULL OR state=$2)
         ORDER BY created_at DESC LIMIT $3`,
				[
					this.organizationId,
					filter.state ?? null,
					filter.limit ?? 100,
				],
			)
		).rows;

		return rows.map(noteFromRow);
	}

	async setNoteState(id: string, state: TeamNoteState): Promise<TeamNote> {
		const row = (
			await this.pool.query<NoteRow>(
				`UPDATE team_notes SET state=$3, updated_at=now() WHERE organization_id=$1 AND id=$2 RETURNING *`,
				[this.organizationId, id, state],
			)
		).rows[0];

		if (!row)
			throw new DomainError(`Note ${id} does not exist.`, "NOT_FOUND");
		return noteFromRow(row);
	}
}

interface NoteRow {
	id: string;
	author: string;
	agent_profile_id: string | null;
	member_id: string | null;
	session_id: string | null;
	project: string | null;
	task_id: string | null;
	text: string;
	links: string[];
	visibility: string;
	state: TeamNoteState;
	source_event_id: string;
	created_at: Date;
	updated_at: Date;
}

function noteFromRow(row: NoteRow): TeamNote {
	return {
		id: row.id,
		author: row.author,
		agentProfileId: row.agent_profile_id,
		memberId: row.member_id,
		sessionId: row.session_id,
		project: row.project,
		taskId: row.task_id,
		text: row.text,
		links: row.links,
		visibility: row.visibility,
		state: row.state,
		sourceEventId: row.source_event_id,
		createdAt: row.created_at.toISOString(),
		updatedAt: row.updated_at.toISOString(),
	};
}
