import type { NotionBlock, NotionListResponse, NotionPage } from "./types.js";

export class NotionApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
		this.name = "NotionApiError";
	}
}

export interface NotionClientOptions {
	token: string;
	apiVersion: string;
	baseUrl?: string;
	fetch?: typeof globalThis.fetch;
}

export class NotionClient {
	private readonly baseUrl: string;
	private readonly requestFetch: typeof globalThis.fetch;

	constructor(private readonly options: NotionClientOptions) {
		this.baseUrl = options.baseUrl ?? "https://api.notion.com/v1";
		this.requestFetch = options.fetch ?? globalThis.fetch;
	}

	async retrievePage(pageId: string): Promise<NotionPage> {
		return this.request<NotionPage>(`/pages/${encodeURIComponent(pageId)}`);
	}

	async queryDataSource(dataSourceId: string): Promise<NotionPage[]> {
		const pages: NotionPage[] = [];
		let cursor: string | null = null;

		do {
			const body: { page_size: number; start_cursor?: string } = {
				page_size: 100,
			};

			if (cursor) body.start_cursor = cursor;

			const response = await this.request<NotionListResponse<NotionPage>>(
				`/data_sources/${encodeURIComponent(dataSourceId)}/query`,
				{ method: "POST", body: JSON.stringify(body) },
			);

			pages.push(...response.results);
			cursor = response.has_more ? response.next_cursor : null;
		} while (cursor);
		return pages;
	}

	async searchPages(): Promise<NotionPage[]> {
		const pages: NotionPage[] = [];
		let cursor: string | null = null;

		do {
			const body: {
				page_size: number;
				start_cursor?: string;
				filter: { property: "object"; value: "page" };
				sort: {
					direction: "descending";
					timestamp: "last_edited_time";
				};
			} = {
				page_size: 100,
				filter: { property: "object", value: "page" },
				sort: {
					direction: "descending",
					timestamp: "last_edited_time",
				},
			};

			if (cursor) body.start_cursor = cursor;

			const response = await this.request<NotionListResponse<NotionPage>>(
				"/search",
				{ method: "POST", body: JSON.stringify(body) },
			);

			pages.push(...response.results);
			cursor = response.has_more ? response.next_cursor : null;
		} while (cursor);
		return pages;
	}

	async retrieveBlockTree(
		blockId: string,
		maximumBlocks = 10_000,
	): Promise<NotionBlock[]> {
		const collected: NotionBlock[] = [];

		const visit = async (parentId: string): Promise<void> => {
			let cursor: string | null = null;

			do {
				const query = new URLSearchParams({ page_size: "100" });

				if (cursor) query.set("start_cursor", cursor);

				const response = await this.request<
					NotionListResponse<NotionBlock>
				>(`/blocks/${encodeURIComponent(parentId)}/children?${query}`);

				for (const block of response.results) {
					if (collected.length >= maximumBlocks)
						throw new Error(
							`Notion page exceeded ${maximumBlocks} blocks.`,
						);
					collected.push(block);
					// Child pages are discovered and ingested independently. Crossing this edge
					// would flatten the whole workspace into every ancestor document.
					if (
						block.has_children &&
						block.type !== "child_page" &&
						block.type !== "child_database"
					) {
						await visit(block.id);
					}
				}
				cursor = response.has_more ? response.next_cursor : null;
			} while (cursor);
		};

		await visit(blockId);
		return collected;
	}

	private async request<T>(path: string, init?: RequestInit): Promise<T> {
		let attempt = 0;

		while (true) {
			const response = await this.requestFetch(`${this.baseUrl}${path}`, {
				...init,
				headers: {
					Authorization: `Bearer ${this.options.token}`,
					"Notion-Version": this.options.apiVersion,
					"Content-Type": "application/json",
					...init?.headers,
				},
			});

			if (response.status === 429 && attempt < 4) {
				const retryAfter = Number(
					response.headers.get("retry-after") ?? "1",
				);

				await new Promise((resolve) =>
					setTimeout(resolve, Math.max(1, retryAfter) * 1_000),
				);
				attempt += 1;
				continue;
			}
			if (!response.ok) {
				throw new NotionApiError(
					`Notion request failed with ${response.status}.`,
					response.status,
				);
			}
			return (await response.json()) as T;
		}
	}
}
