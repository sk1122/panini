import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { PayloadCipher } from "../security/payload-cipher.js";

/*
 * The decisions ledger. A decision is something an agent or person chose:
 * what, why, what else was possible, and the proof. A silent decision is one
 * an agent made without being told to; it stays "unseen" until its owner
 * acknowledges or overrides it. Nothing here ever blocks the agent.
 */

export type DecisionSource = "code" | "agent" | "record" | "session";
export type DecisionOwnerState = "unseen" | "acknowledged" | "overridden";

export interface DecisionInput {
	sourceKind: DecisionSource;
	/** Stable per decision, so recording twice changes nothing. */
	sourceKey: string;
	title: string;
	category: string;
	statement: string;
	reason?: string;
	alternatives?: string[];
	/** The proof: a diff excerpt or quote. Secrets must already be masked. */
	evidence?: string;
	decidedBy: string;
	agentProfileId?: string | null;
	ownerMemberId?: string | null;
	sessionId?: string | null;
	contextEntryId?: string | null;
	repository?: string | null;
	filePath?: string | null;
	silent: boolean;
	decidedAt: string;
}

export interface Decision {
	id: string;
	sourceKind: DecisionSource;
	title: string;
	category: string;
	statement: string;
	reason: string;
	alternatives: string[];
	evidence: string;
	decidedBy: string;
	agentProfileId: string | null;
	ownerMemberId: string | null;
	sessionId: string | null;
	contextEntryId: string | null;
	repository: string | null;
	filePath: string | null;
	silent: boolean;
	ownerState: DecisionOwnerState;
	ownerNote: string | null;
	stateChangedBy: string | null;
	stateChangedAt: string | null;
	decidedAt: string;
}

export class PostgresDecisions {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
		private readonly cipher: PayloadCipher,
	) {}

	/** Records a decision once; returns false when it was already recorded. */
	async record(input: DecisionInput): Promise<boolean> {
		const result = await this.pool.query(
			`INSERT INTO decisions (id,organization_id,source_kind,source_key,title,category,envelope,decided_by,
			   agent_profile_id,owner_member_id,session_id,context_entry_id,repository,file_path,silent,decided_at)
			 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
			 ON CONFLICT (organization_id,source_key) DO NOTHING`,
			[
				randomUUID(),
				this.organizationId,
				input.sourceKind,
				input.sourceKey.slice(0, 500),
				input.title.slice(0, 240),
				input.category.slice(0, 60),
				JSON.stringify(
					this.cipher.encrypt({
						statement: input.statement.slice(0, 4_000),
						reason: (input.reason ?? "").slice(0, 4_000),
						alternatives: (input.alternatives ?? []).slice(0, 20),
						evidence: (input.evidence ?? "").slice(0, 8_000),
					}),
				),
				input.decidedBy.slice(0, 200),
				input.agentProfileId ?? null,
				input.ownerMemberId ?? null,
				input.sessionId ?? null,
				input.contextEntryId ?? null,
				input.repository ?? null,
				input.filePath?.slice(0, 500) ?? null,
				input.silent,
				input.decidedAt,
			],
		);

		return (result.rowCount ?? 0) > 0;
	}

	async list(limit = 300): Promise<Decision[]> {
		const rows = (
			await this.pool.query(
				`SELECT * FROM decisions WHERE organization_id=$1 ORDER BY decided_at DESC, id LIMIT $2`,
				[this.organizationId, limit],
			)
		).rows;

		return rows.map((row) => this.fromRow(row));
	}

	async get(id: string): Promise<Decision | null> {
		const row = (
			await this.pool.query(
				"SELECT * FROM decisions WHERE organization_id=$1 AND id=$2",
				[this.organizationId, id],
			)
		).rows[0];

		return row ? this.fromRow(row) : null;
	}

	async setOwnerState(
		id: string,
		state: DecisionOwnerState,
		note: string | null,
		actor: string,
	): Promise<Decision | null> {
		await this.pool.query(
			`UPDATE decisions SET owner_state=$3, owner_note=$4, state_changed_by=$5, state_changed_at=now()
			 WHERE organization_id=$1 AND id=$2`,
			[this.organizationId, id, state, note, actor],
		);
		return this.get(id);
	}

	/** Keeps a session's conversation until its decisions are extracted. */
	async saveTranscript(sessionId: string, text: string): Promise<void> {
		await this.pool.query(
			`INSERT INTO agent_session_transcripts (organization_id,session_id,envelope)
			 VALUES ($1,$2,$3)
			 ON CONFLICT (organization_id,session_id) DO UPDATE SET envelope=$3, attempts=0, created_at=now()`,
			[
				this.organizationId,
				sessionId,
				JSON.stringify(this.cipher.encrypt({ text })),
			],
		);
	}

	async pendingTranscripts(limit = 20): Promise<string[]> {
		return (
			await this.pool.query(
				`SELECT session_id FROM agent_session_transcripts
				 WHERE organization_id=$1 AND attempts < 3 ORDER BY created_at LIMIT $2`,
				[this.organizationId, limit],
			)
		).rows.map((row) => row.session_id as string);
	}

	/** Reads a transcript and counts the attempt, so a bad one is not retried forever. */
	async readTranscript(sessionId: string): Promise<string | null> {
		const row = (
			await this.pool.query(
				`UPDATE agent_session_transcripts SET attempts=attempts+1
				 WHERE organization_id=$1 AND session_id=$2 AND attempts < 3 RETURNING envelope`,
				[this.organizationId, sessionId],
			)
		).rows[0];

		return row
			? (this.cipher.decrypt(row.envelope) as unknown as { text: string })
					.text
			: null;
	}

	async deleteTranscript(sessionId: string): Promise<void> {
		await this.pool.query(
			"DELETE FROM agent_session_transcripts WHERE organization_id=$1 AND session_id=$2",
			[this.organizationId, sessionId],
		);
	}

	/** Adds a model call's cost to the monthly budget, so the cap still holds. */
	async chargeBudget(
		budgetId: string,
		usd: string,
		inputTokens: number,
		outputTokens: number,
	): Promise<void> {
		await this.pool.query(
			`UPDATE inference_budgets SET spent_calls=spent_calls+1, spent_input_tokens=spent_input_tokens+$3,
			   spent_output_tokens=spent_output_tokens+$4, spent_usd=spent_usd+$5::numeric
			 WHERE organization_id=$1 AND id=$2`,
			[this.organizationId, budgetId, inputTokens, outputTokens, usd],
		);
		await this.pool.query(
			`UPDATE inference_budgets SET state='exhausted'
			 WHERE organization_id=$1 AND id=$2 AND state='active' AND max_usd IS NOT NULL AND spent_usd >= max_usd`,
			[this.organizationId, budgetId],
		);
	}

	private fromRow(row: Record<string, unknown>): Decision {
		const text = this.cipher.decrypt(row.envelope as never) as unknown as {
			statement: string;
			reason: string;
			alternatives: string[];
			evidence: string;
		};

		const date = (value: unknown) =>
			value ? new Date(value as string).toISOString() : null;

		return {
			id: row.id as string,
			sourceKind: row.source_kind as DecisionSource,
			title: row.title as string,
			category: row.category as string,
			statement: text.statement,
			reason: text.reason,
			alternatives: text.alternatives,
			evidence: text.evidence,
			decidedBy: row.decided_by as string,
			agentProfileId: (row.agent_profile_id as string) ?? null,
			ownerMemberId: (row.owner_member_id as string) ?? null,
			sessionId: (row.session_id as string) ?? null,
			contextEntryId: (row.context_entry_id as string) ?? null,
			repository: (row.repository as string) ?? null,
			filePath: (row.file_path as string) ?? null,
			silent: row.silent as boolean,
			ownerState: row.owner_state as DecisionOwnerState,
			ownerNote: (row.owner_note as string) ?? null,
			stateChangedBy: (row.state_changed_by as string) ?? null,
			stateChangedAt: date(row.state_changed_at),
			decidedAt: date(row.decided_at)!,
		};
	}
}
