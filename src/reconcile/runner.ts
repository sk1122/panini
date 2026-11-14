import { randomUUID } from "node:crypto";
import type pg from "pg";
import type { LedgerStore } from "../domain/store.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import type { SourceEvent } from "../domain/types.js";

/*
 * The scheduled reconcile run (spec 15.2). The worker model no longer runs per
 * message: once per interval (default 24 hours) or on "Run now", it walks every
 * source observation received since the last completed run, in arrival order.
 * Structured agent events were already applied by rules and are skipped.
 */

export type ReconcileTrigger = "schedule" | "manual";

export interface ReconcileRun {
	id: string;
	trigger: ReconcileTrigger;
	state: "running" | "completed" | "failed";
	cursor: { receivedAt: string; id: string } | null;
	processed: number;
	duplicates: number;
	skipped: number;
	failed: number;
	error: string | null;
	digest: string | null;
	startedAt: string;
	finishedAt: string | null;
}

interface RunRow {
	id: string;
	trigger: ReconcileTrigger;
	state: ReconcileRun["state"];
	cursor_received_at: Date | null;
	cursor_id: string | null;
	processed: number;
	duplicates: number;
	skipped: number;
	failed: number;
	error: string | null;
	digest: string | null;
	started_at: Date;
	finished_at: Date | null;
}

function fromRow(row: RunRow): ReconcileRun {
	return {
		id: row.id,
		trigger: row.trigger,
		state: row.state,
		cursor:
			row.cursor_received_at && row.cursor_id
				? {
						receivedAt: row.cursor_received_at.toISOString(),
						id: row.cursor_id,
					}
				: null,
		processed: row.processed,
		duplicates: row.duplicates,
		skipped: row.skipped,
		failed: row.failed,
		error: row.error,
		digest: row.digest,
		startedAt: row.started_at.toISOString(),
		finishedAt: row.finished_at?.toISOString() ?? null,
	};
}

export class PostgresReconcileRuns {
	constructor(
		private readonly pool: pg.Pool,
		private readonly organizationId: string,
	) {}

	async list(limit = 10): Promise<ReconcileRun[]> {
		const { rows } = await this.pool.query<RunRow>(
			"SELECT * FROM reconcile_runs WHERE organization_id=$1 ORDER BY started_at DESC LIMIT $2",
			[this.organizationId, limit],
		);

		return rows.map(fromRow);
	}

	async lastCompleted(): Promise<ReconcileRun | null> {
		const { rows } = await this.pool.query<RunRow>(
			"SELECT * FROM reconcile_runs WHERE organization_id=$1 AND state='completed' ORDER BY started_at DESC LIMIT 1",
			[this.organizationId],
		);

		return rows[0] ? fromRow(rows[0]) : null;
	}

	/** A crashed run older than its lease is marked failed so the next one can start. */
	async start(
		trigger: ReconcileTrigger,
		staleAfterMs = 6 * 3_600_000,
	): Promise<ReconcileRun | null> {
		await this.pool.query(
			`UPDATE reconcile_runs SET state='failed', error='Run did not finish.', finished_at=now()
       WHERE organization_id=$1 AND state='running' AND started_at < $2`,
			[this.organizationId, new Date(Date.now() - staleAfterMs)],
		);

		const previous = await this.lastCompleted();

		try {
			const { rows } = await this.pool.query<RunRow>(
				`INSERT INTO reconcile_runs (id,organization_id,trigger,state,cursor_received_at,cursor_id)
         VALUES ($1,$2,$3,'running',$4,$5) RETURNING *`,
				[
					randomUUID(),
					this.organizationId,
					trigger,
					previous?.cursor?.receivedAt ?? null,
					previous?.cursor?.id ?? null,
				],
			);

			return fromRow(rows[0]!);
		} catch (error) {
			// The partial unique index allows one running run per company.
			if ((error as { code?: string }).code === "23505") return null;
			throw error;
		}
	}

	async finish(run: ReconcileRun): Promise<void> {
		await this.pool.query(
			`UPDATE reconcile_runs SET state=$3, cursor_received_at=$4, cursor_id=$5, processed=$6,
         duplicates=$7, skipped=$8, failed=$9, error=$10, digest=$11, finished_at=now()
       WHERE organization_id=$1 AND id=$2`,
			[
				this.organizationId,
				run.id,
				run.state,
				run.cursor?.receivedAt ?? null,
				run.cursor?.id ?? null,
				run.processed,
				run.duplicates,
				run.skipped,
				run.failed,
				run.error,
				run.digest,
			],
		);
	}
}

export function needsModel(
	event: SourceEvent,
	allowedVisibilities: readonly string[],
): boolean {
	if (event.provider === "agent" && event.eventKind.startsWith("ledger."))
		return false;
	return allowedVisibilities.includes(event.visibility);
}

/** One conversation: a Slack thread, a pull request, a task, or else the source itself. */
export function threadKey(event: SourceEvent): string {
	const payload = (event.payload ?? {}) as Record<string, unknown>;

	if (event.provider === "slack" && typeof payload.channel === "string")
		return `slack:${payload.channel}:${String(payload.threadTs ?? payload.messageTs ?? event.sourceRef)}`;
	if (event.provider === "github") {
		const pull = /pull\/(\d+)|pr:(\d+)|pulls?:(\d+)/i.exec(event.sourceRef);

		if (pull) return `github:${pull.slice(1).find(Boolean)}`;
	}
	if (typeof payload.taskId === "string") return `task:${payload.taskId}`;
	return event.sourceRef;
}

async function inParallel<T>(
	items: T[],
	limit: number,
	work: (item: T) => Promise<void>,
): Promise<void> {
	let next = 0;

	await Promise.all(
		Array.from(
			{ length: Math.max(1, Math.min(limit, items.length)) },
			async () => {
				while (next < items.length) await work(items[next++]!);
			},
		),
	);
}

export async function runReconcile(input: {
	store: LedgerStore;
	runs: PostgresReconcileRuns;
	ledger: TeamLedger;
	trigger: ReconcileTrigger;
	allowedVisibilities: readonly string[];
	observe: (eventId: string) => Promise<{ state: string }>;
	/** How many threads run at once (PANINI_RECONCILE_CONCURRENCY, default 3). */
	concurrency?: number;
	deliverDigest?: (markdown: string) => Promise<void>;
	log: { info(message: string, fields?: object): void };
}): Promise<ReconcileRun | null> {
	const run = await input.runs.start(input.trigger);

	if (!run) {
		input.log.info("A reconcile run is already in progress.");
		return null;
	}

	// Arrival times are stamped by the app's clock, so the cutoff must use it too.
	const started = new Date().toISOString();

	try {
		for (;;) {
			const page = await input.store.listSourceEventsAfter(
				run.cursor,
				100,
			);
			// Events that arrive during the run wait for the next run.
			const window = page.filter((event) => event.receivedAt <= started);
			const threads = new Map<string, SourceEvent[]>();

			for (const event of window) {
				if (!needsModel(event, input.allowedVisibilities)) {
					run.skipped += 1;
					continue;
				}

				const key = threadKey(event);

				threads.set(key, [...(threads.get(key) ?? []), event]);
			}
			// Different threads run at the same time; messages in one thread stay in order.
			await inParallel(
				[...threads.values()],
				input.concurrency ?? 3,
				async (events) => {
					// Within a thread, follow message time; arrival order breaks ties.
					const ordered = [...events].sort(
						(a, b) =>
							a.occurredAt.localeCompare(b.occurredAt) ||
							a.receivedAt.localeCompare(b.receivedAt) ||
							a.id.localeCompare(b.id),
					);

					for (const event of ordered) {
						const result = await input.observe(event.id);

						if (result.state === "duplicate") run.duplicates += 1;
						else if (result.state === "failed") run.failed += 1;
						else run.processed += 1;
					}
				},
			);

			// Advance only after the whole page is handled; an error retries the page next run.
			const last = window.at(-1);

			if (last) run.cursor = { receivedAt: last.receivedAt, id: last.id };
			if (page.length < 100 || window.length < page.length) break;
		}
		run.state = "completed";
	} catch (error) {
		run.state = "failed";
		run.error =
			error instanceof Error
				? error.message.slice(0, 500)
				: "Unknown error";
	}

	try {
		run.digest = (
			await input.ledger.digest(
				{ kind: "admin" },
				{ title: `Panini digest (${run.state} run)` },
			)
		).markdown;
		await input.deliverDigest?.(run.digest);
	} catch (error) {
		input.log.info("Digest delivery failed.", {
			error: error instanceof Error ? error.message : String(error),
		});
	}
	await input.runs.finish(run);
	input.log.info("Reconcile run finished.", {
		state: run.state,
		processed: run.processed,
		duplicates: run.duplicates,
		skipped: run.skipped,
		failed: run.failed,
	});
	return run;
}
