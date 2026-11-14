// Live run of the nightly agent on Claude. Skipped unless PANINI_LIVE_ANTHROPIC_KEY is set.
// Failure cases written first:
// 1. Claude rejects the translated request (tool schema, format or thinking replay) -> run throws.
// 2. A tool call comes back but its result is not replayed in Claude's shape -> second turn 400s.
// 3. Usage is not mapped, so the call stays "unknown" and spends no budget -> cost check fails.
// 4. A chat report of finished work changes nothing -> task status check fails.
// 5. A new request in chat creates no task -> task count check fails.
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import pg from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { migrate } from "../src/db/migrate.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { claudeFetcher } from "../src/intelligence/claude-responses.js";
import { CLAUDE_HAIKU_5_5_PRICE_2026_11_03 } from "../src/intelligence/model-price.js";
import { ObservationAgent } from "../src/intelligence/observation-agent.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const apiKey = process.env.PANINI_LIVE_ANTHROPIC_KEY;
const organizationId = randomUUID();
let pool: pg.Pool, store: PostgresLedgerStore, ledger: TeamLedger;

beforeAll(async () => {
	if (!apiKey) return;
	if (!databaseUrl?.includes("panini_e2e"))
		throw new Error("Disposable panini_e2e required");
	await migrate(databaseUrl);
	pool = new pg.Pool({ connectionString: databaseUrl });
	await pool.query(
		"INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
		[organizationId, `claude-${organizationId}`, "Claude live E2E"],
	);
	store = new PostgresLedgerStore(
		databaseUrl,
		Buffer.alloc(32, 43).toString("base64"),
		organizationId,
	);
	ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			autoApproveNewTasks: false,
			autoApproveContext: false,
			requireReviewForTaskChanges: true,
		}),
	);
});
afterAll(async () => {
	await store?.close();
	await pool?.end();
});

// Shaped like a real Slack message, so evidence can cite it.
async function slack(text: string, occurredAt: string, user: string) {
	const messageTs = `${Date.parse(occurredAt) / 1000}.000100`;
	const payload = { teamId: "T1", channel: "C1", user, messageTs, text };

	return (
		await store.appendSourceEvent({
			provider: "slack",
			installationKey: "T1",
			providerEventId: randomUUID(),
			eventKind: "message.observed",
			occurredAt,
			fetchedAt: new Date().toISOString(),
			sourceRef: `slack:T1:C1:${messageTs}`,
			sourceUrl: null,
			contentHash: randomUUID(),
			visibility: "company",
			payloadVersion: "slack-live-fixture",
			payload,
		})
	).event;
}

it.skipIf(!apiKey)(
	"runs the nightly agent on Claude Haiku 5.5 and updates work directly",
	async () => {
		const task = await ledger.createTask(
			{
				title: "Add exponential backoff to login retries",
				description:
					"Login retries hammer the auth service after an outage. Add exponential backoff with jitter.",
				status: "in_progress",
				owner: "Asha",
			},
			"user:e2e",
		);
		const budget = await store.createInferenceBudget({
			label: `claude-live-${randomUUID()}`,
			maxCalls: 60,
			maxInputTokens: 3_000_000,
			maxOutputTokens: 400_000,
			maxUsd: "1",
			deadline: new Date(Date.now() + 600_000).toISOString(),
			priceBasis: null,
		});
		const claude = claudeFetcher(apiKey!);
		const toolLog: unknown[] = [];
		const agent = new ObservationAgent({
			store,
			ledger,
			apiKey: apiKey!,
			model: CLAUDE_HAIKU_5_5_PRICE_2026_11_03.model,
			pipelineVersion: `claude-live-${organizationId}`,
			allowedVisibilities: ["company"],
			priceBasis: CLAUDE_HAIKU_5_5_PRICE_2026_11_03,
			// Print Claude's own error text, so a rejected request is diagnosable.
			fetcher: async (input, init) => {
				const response = await claude(input, init);

				if (!response.ok)
					console.error(
						"Claude rejected:",
						await response.clone().text(),
					);
				else {
					const sent = JSON.parse(String(init?.body ?? "{}"));
					const last = (sent.input ?? []).at(-1);

					if (last?.type === "function_call_output")
						toolLog.push({
							result: String(last.output).slice(0, 400),
						});

					const reply = await response.clone().json();

					if (sent.text?.format)
						toolLog.push({
							assessment: sent.text.format.name,
							answer: reply.output
								?.flatMap((item: any) => item.content ?? [])
								.map((part: any) => part.text)
								.join("")
								.slice(0, 1500),
						});
					for (const item of reply.output ?? [])
						if (item.type === "function_call")
							toolLog.push({
								call: item.name,
								arguments: String(item.arguments).slice(0, 400),
							});
				}
				return response;
			},
			workOntology: true,
		});

		const done = await slack(
			"Login retry with exponential backoff and jitter is merged (PR #218) and deployed to production. The exponential backoff work is finished.",
			"2026-11-14T10:00:00.000Z",
			"U_ASHA",
		);
		const first = await agent.run({
			eventId: done.id,
			budgetId: budget.id,
		});
		const afterDone = await store.getTask(task.id);

		const ask = await slack(
			"Can someone add a status page for the auth service? Customers keep asking whether login is down. Ravi, can you take it this week?",
			"2026-11-14T11:00:00.000Z",
			"U_ASHA",
		);
		const second = await agent.run({
			eventId: ask.id,
			budgetId: budget.id,
		});
		const tasks = await store.listTasks();
		const statusPage = tasks.find((item) =>
			/status page/i.test(item.title),
		);
		const calls = [
			...(await store.listModelCalls(first.runId!)),
			...(await store.listModelCalls(second.runId!)),
		];
		const cost = calls.reduce(
			(sum, call) => sum + Number(call.costUsd ?? 0),
			0,
		);

		await mkdir("artifacts/claude-live", { recursive: true });
		await writeFile(
			"artifacts/claude-live/haiku-nightly-run.json",
			JSON.stringify(
				{
					model: CLAUDE_HAIKU_5_5_PRICE_2026_11_03.model,
					runs: [first, second],
					taskBefore: { title: task.title, status: task.status },
					taskAfter: afterDone && {
						status: afterDone.status,
						result: afterDone.result,
					},
					createdTask: statusPage && {
						title: statusPage.title,
						status: statusPage.status,
						owner: statusPage.owner,
					},
					modelCalls: calls.map((call) => ({
						purpose: call.purpose,
						state: call.state,
						inputTokens: call.inputTokens,
						outputTokens: call.outputTokens,
						costUsd: call.costUsd,
					})),
					totalCostUsd: cost,
					toolLog,
				},
				null,
				2,
			),
		);

		expect(first.state).toBe("completed");
		expect(second.state).toBe("completed");
		expect(calls.length).toBeGreaterThan(1);
		expect(calls.every((call) => call.state === "succeeded")).toBe(true);
		expect(cost).toBeGreaterThan(0);
		expect(afterDone?.status).not.toBe("in_progress");
		expect(statusPage).toBeDefined();
	},
	600_000,
);
