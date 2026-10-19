import { describe, expect, it, vi } from "vitest";
import { NotionClient } from "../src/connectors/notion/client.js";
import { NotionPoller } from "../src/connectors/notion/poller.js";
import type {
	NotionBlock,
	NotionPage,
} from "../src/connectors/notion/types.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

function page(id: string): NotionPage {
	return {
		object: "page",
		id,
		created_time: "2026-09-01T00:00:00.000Z",
		last_edited_time: "2026-09-12T00:00:00.000Z",
		url: `https://notion.so/${id}`,
		properties: {},
	};
}

describe("NotionClient", () => {
	it("paginates current data-source query responses and pins the API version", async () => {
		const request = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					start_cursor?: string;
				};

				if (!body.start_cursor) {
					return new Response(
						JSON.stringify({
							object: "list",
							results: [page("one")],
							has_more: true,
							next_cursor: "next",
						}),
						{
							status: 200,
							headers: { "content-type": "application/json" },
						},
					);
				}
				return new Response(
					JSON.stringify({
						object: "list",
						results: [page("two")],
						has_more: false,
						next_cursor: null,
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		const client = new NotionClient({
			token: "secret",
			apiVersion: "2026-03-11",
			baseUrl: "https://notion.test/v1",
			fetch: request as typeof fetch,
		});

		const pages = await client.queryDataSource("source-id");

		expect(pages.map((item) => item.id)).toEqual(["one", "two"]);
		expect(request).toHaveBeenCalledTimes(2);
		expect(request.mock.calls[0]?.[0]).toBe(
			"https://notion.test/v1/data_sources/source-id/query",
		);
		expect(
			new Headers(request.mock.calls[0]?.[1]?.headers).get(
				"notion-version",
			),
		).toBe("2026-03-11");
	});

	it("discovers every page shared with the integration through paginated workspace search", async () => {
		const request = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				const body = JSON.parse(String(init?.body)) as {
					start_cursor?: string;
					filter?: unknown;
				};

				expect(body.filter).toEqual({
					property: "object",
					value: "page",
				});
				return new Response(
					JSON.stringify({
						object: "list",
						results: [page(body.start_cursor ? "two" : "one")],
						has_more: !body.start_cursor,
						next_cursor: body.start_cursor ? null : "next",
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		);
		const client = new NotionClient({
			token: "secret",
			apiVersion: "2026-03-11",
			baseUrl: "https://notion.test/v1",
			fetch: request as typeof fetch,
		});

		expect((await client.searchPages()).map((item) => item.id)).toEqual([
			"one",
			"two",
		]);
		expect(request.mock.calls.map(([input]) => String(input))).toEqual([
			"https://notion.test/v1/search",
			"https://notion.test/v1/search",
		]);
	});

	it("does not flatten child pages into their parent document", async () => {
		const request = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						object: "list",
						results: [
							{
								object: "block",
								id: "child",
								type: "child_page",
								has_children: true,
								child_page: { title: "Nested" },
							},
						],
						has_more: false,
						next_cursor: null,
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				),
		);
		const client = new NotionClient({
			token: "secret",
			apiVersion: "2026-03-11",
			baseUrl: "https://notion.test/v1",
			fetch: request as typeof fetch,
		});

		expect(await client.retrieveBlockTree("root")).toHaveLength(1);
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("retrieves context trees containing more than 1,000 blocks", async () => {
		const request = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));
			const pageIndex = Number(
				url.searchParams.get("start_cursor") ?? "0",
			);
			const results: NotionBlock[] = Array.from(
				{ length: 100 },
				(_, index) => ({
					object: "block",
					id: `block-${pageIndex}-${index}`,
					type: "paragraph",
					has_children: false,
					paragraph: { rich_text: [] },
				}),
			);

			return new Response(
				JSON.stringify({
					object: "list",
					results,
					has_more: pageIndex < 10,
					next_cursor: pageIndex < 10 ? String(pageIndex + 1) : null,
				}),
				{
					status: 200,
					headers: { "content-type": "application/json" },
				},
			);
		});
		const client = new NotionClient({
			token: "secret",
			apiVersion: "2026-03-11",
			baseUrl: "https://notion.test/v1",
			fetch: request as typeof fetch,
		});

		const blocks = await client.retrieveBlockTree("root");

		expect(blocks).toHaveLength(1_100);
		expect(request).toHaveBeenCalledTimes(11);
	});

	it("projects successful and failed repair scans into installation health", async () => {
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: true,
				requireReviewForTaskChanges: true,
			}),
		);
		const installation = await ledger.configureInstallation(
			{
				provider: "notion",
				installationKey: "default",
				displayName: "Notion",
				transport: "poll",
				config: { roots: ["source-id"] },
			},
			"test",
		);
		let shouldFail = false;
		const client = new NotionClient({
			token: "secret",
			apiVersion: "2026-03-11",
			baseUrl: "https://notion.test/v1",
			fetch: vi.fn(async () =>
				shouldFail
					? new Response("permission revoked", { status: 403 })
					: new Response(
							JSON.stringify({
								object: "list",
								results: [page("health-page")],
								has_more: false,
								next_cursor: null,
							}),
							{
								status: 200,
								headers: { "content-type": "application/json" },
							},
						),
			) as typeof fetch,
		});
		const poller = new NotionPoller(
			client,
			ledger,
			{
				enabled: true,
				pollIntervalSeconds: 300,
				apiVersion: "2026-03-11",
				sources: [
					{
						key: "health",
						kind: "data_source",
						resourceId: "source-id",
						ingestAs: "task_board",
						visibility: "company",
						statusMap: {},
					},
				],
			},
			{ info: vi.fn(), error: vi.fn() },
			installation.id,
		);

		await poller.sync();

		let workspace = await ledger.workspace();

		expect(workspace.installations[0]).toMatchObject({
			status: "healthy",
			lastSyncAt: expect.any(String),
			lastSuccessAt: expect.any(String),
			lastError: null,
		});
		expect(workspace.connectorSyncs[0]).toMatchObject({
			resourceKey: "health",
			status: "healthy",
			observedCount: 1,
			revokedCount: 0,
			lastRepairAt: expect.any(String),
			cursor: { fullScan: true, sourceRefs: ["notion:page:health-page"] },
		});

		shouldFail = true;
		await poller.sync();
		workspace = await ledger.workspace();
		expect(workspace.installations[0]).toMatchObject({
			status: "degraded",
			lastError: expect.stringContaining("403"),
		});
		expect(workspace.connectorSyncs[0]).toMatchObject({
			status: "revoked",
			revokedCount: 1,
		});
		expect(await store.listSourceEvents(10)).toEqual([]);
	});

	it("discovers workspace pages without duplicating configured pages or task-board rows", async () => {
		const explicit = {
			...page("handbook"),
			parent: { type: "page_id", page_id: "root" },
		};
		const taskRow = {
			...page("task-row"),
			parent: { type: "data_source_id", data_source_id: "tasks" },
			properties: {
				Name: {
					type: "title",
					title: [{ plain_text: "Ship workspace discovery" }],
				},
				Status: { type: "status", status: { name: "In progress" } },
				Owner: {
					type: "people",
					people: [
						{
							id: "person-noor",
							name: "Noor",
							person: { email: "noor@example.test" },
						},
					],
				},
			},
		};
		const workspaceOnly = {
			...page("workspace-only"),
			parent: { type: "page_id", page_id: "handbook" },
		};
		const request = vi.fn(async (input: string | URL | Request) => {
			const url = new URL(String(input));

			if (url.pathname.endsWith("/pages/handbook"))
				return Response.json(explicit);
			if (url.pathname.endsWith("/data_sources/tasks/query")) {
				return Response.json({
					object: "list",
					results: [taskRow],
					has_more: false,
					next_cursor: null,
				});
			}
			if (url.pathname.endsWith("/search")) {
				return Response.json({
					object: "list",
					results: [explicit, taskRow, workspaceOnly],
					has_more: false,
					next_cursor: null,
				});
			}
			if (url.pathname.includes("/blocks/")) {
				return Response.json({
					object: "list",
					results: [
						{
							object: "block",
							id: `body-${url.pathname}`,
							type: "paragraph",
							has_children: false,
							paragraph: {
								rich_text: [
									{ plain_text: "A durable workspace note." },
								],
							},
						},
					],
					has_more: false,
					next_cursor: null,
				});
			}
			return new Response("not found", { status: 404 });
		});
		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy({
				autoApproveNewTasks: true,
				autoApproveContext: false,
				requireReviewForTaskChanges: true,
			}),
		);
		const poller = new NotionPoller(
			new NotionClient({
				token: "secret",
				apiVersion: "2026-03-11",
				baseUrl: "https://notion.test/v1",
				fetch: request as typeof fetch,
			}),
			ledger,
			{
				enabled: true,
				pollIntervalSeconds: 300,
				apiVersion: "2026-03-11",
				sources: [
					{
						key: "handbook",
						kind: "page",
						resourceId: "handbook",
						ingestAs: "company_context",
						visibility: "company",
						statusMap: {},
					},
					{
						key: "tasks",
						kind: "data_source",
						resourceId: "tasks",
						ingestAs: "task_board",
						visibility: "company",
						statusMap: {},
						properties: {
							title: "Name",
							status: "Status",
							owner: "Owner",
						},
					},
					{
						key: "workspace",
						kind: "workspace",
						ingestAs: "company_context",
						visibility: "company",
						statusMap: {},
						contextPath: "/sources/notion/pages",
					},
				],
			},
			{ info: vi.fn(), error: vi.fn() },
		);

		const result = await poller.sync();

		expect(
			result.sources.map((source) => ({
				source: source.source,
				fetched: source.fetched,
			})),
		).toEqual([
			{ source: "handbook", fetched: 1 },
			{ source: "tasks", fetched: 1 },
			{ source: "workspace", fetched: 1 },
		]);
		expect(
			(await store.listSourceEvents(20))
				.map((event) => event.sourceRef)
				.sort(),
		).toEqual([
			"notion:page:handbook",
			"notion:page:task-row",
			"notion:workspace-page:workspace-only",
		]);
		expect((await ledger.board()).tasks).toHaveLength(0);
		expect((await ledger.board()).proposals).toHaveLength(0);
		expect((await ledger.workspace()).members).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					subject: "notion:default:person-noor",
					displayName: "Noor",
					email: "noor@example.test",
					status: "active",
				}),
			]),
		);
		expect((await ledger.workspace()).memberIdentities).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					provider: "notion",
					installationKey: "default",
					externalId: "person-noor",
				}),
			]),
		);
	});
});
