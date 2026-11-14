import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	SlackCaptureAdapter,
	type SlackMessage,
} from "../src/connectors/slack/socket-mode.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const orgId = randomUUID();

describe("Slack catch-up in disposable PostgreSQL", () => {
	let pool: pg.Pool;
	let store: PostgresLedgerStore;

	beforeAll(async () => {
		if (!databaseUrl?.includes("panini_e2e"))
			throw new Error("Disposable panini_e2e database required");
		pool = new pg.Pool({ connectionString: databaseUrl });
		await pool.query(
			"INSERT INTO organizations(id,slug,name) VALUES($1,$2,$3)",
			[orgId, `slack-catchup-${orgId}`, "Slack Catchup E2E"],
		);
		store = new PostgresLedgerStore(
			databaseUrl,
			Buffer.alloc(32, 42).toString("base64"),
			orgId,
		);
	});
	afterAll(async () => {
		await store?.close();
		await pool?.end();
	});

	it("captures newer top-level messages and replies to old roots only once", async () => {
		const cutoff = "2026-09-27T09:05:30.087Z";
		const oldTs = String(Date.parse("2026-09-25T00:00:00Z") / 1000);
		const newTs = String(Date.parse("2026-09-29T00:00:00Z") / 1000);
		const replyTs = String(Date.parse("2026-09-29T01:00:00Z") / 1000);

		const message = (
			ts: string,
			text: string,
			threadTs: string | null = null,
			replyCount = 0,
		): SlackMessage => ({
			channel: "C1",
			ts,
			threadTs,
			user: null,
			text,
			permalink: null,
			replyCount,
		});

		const oldRoot = message(oldTs, "Old thread root", null, 1);
		const newRoot = message(newTs, "New top-level update");
		const reply = message(replyTs, "New reply on old root", oldTs);
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: false,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);
		const client = {
			async identifyWorkspace() {
				return { teamId: "T1", workspaceUrl: null };
			},
			async getMessage() {
				return oldRoot;
			},
			async listMembers() {
				return { members: [], nextCursor: null };
			},
			async listChannelMessages() {
				return { messages: [newRoot, oldRoot], nextCursor: null };
			},
			async listThreadReplies() {
				return { messages: [oldRoot, reply], nextCursor: null };
			},
		};
		const adapter = new SlackCaptureAdapter(
			{
				installationKey: "T1",
				channels: ["C1"],
				captureMode: "all_messages",
				captureReactions: [],
			},
			client,
			{ record: (input) => store.appendSourceEvent(input) },
			ledger,
		);
		const first = await adapter.backfill({ occurredAfter: cutoff });

		expect(first).toMatchObject({ captured: 2, errors: [] });

		const second = await adapter.backfill({ occurredAfter: cutoff });

		expect(second).toMatchObject({
			captured: 0,
			duplicates: 2,
			errors: [],
		});

		const rows = await pool.query<{ source_ref: string }>(
			"SELECT source_ref FROM source_events WHERE organization_id=$1 AND provider='slack' ORDER BY source_ref",
			[orgId],
		);

		expect(rows.rows.map((row) => row.source_ref)).toEqual([
			`slack:T1:C1:${newTs}`,
			`slack:T1:C1:${replyTs}`,
		]);
		expect((await ledger.board()).tasks).toHaveLength(0);
	});
});
