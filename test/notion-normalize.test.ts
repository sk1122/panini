import { describe, expect, it } from "vitest";
import type { NotionSourceConfig } from "../src/config.js";
import {
	contentHash,
	normalizeNotionPage,
} from "../src/connectors/notion/normalize.js";
import type { NotionPage } from "../src/connectors/notion/types.js";

const source: NotionSourceConfig = {
	key: "projects",
	kind: "data_source",
	resourceId: "data-source",
	ingestAs: "task_board",
	visibility: "company",
	statusMap: { Waiting: "blocked" },
	properties: {
		title: "Work item",
		status: "Stage",
		owner: "Owner",
		dueDate: "Due",
		priority: "Priority",
		project: "Project",
		dependencies: "Blocked by",
	},
};

const page: NotionPage = {
	object: "page",
	id: "page-9",
	created_time: "2026-09-01T10:00:00.000Z",
	last_edited_time: "2026-09-12T10:00:00.000Z",
	url: "https://notion.so/page-9",
	properties: {
		"Work item": {
			type: "title",
			title: [{ plain_text: "Resolve launch blocker" }],
		},
		Stage: { type: "status", status: { name: "Waiting" } },
		Owner: { type: "people", people: [{ id: "person-1", name: "Noor" }] },
		Due: { type: "date", date: { start: "2026-09-20" } },
		Priority: { type: "select", select: { name: "P0" } },
		Project: { type: "select", select: { name: "Launch" } },
		"Blocked by": { type: "relation", relation: [{ id: "page-2" }] },
	},
};

describe("Notion normalization", () => {
	it("maps configured Notion properties into canonical task fields", () => {
		const observation = normalizeNotionPage(source, page);

		expect(observation.signal).toEqual({
			type: "task_snapshot",
			fields: {
				externalRef: "notion:page:page-9",
				title: "Resolve launch blocker",
				description: "",
				status: "blocked",
				priority: "urgent",
				owner: "Noor",
				project: "Launch",
				dueDate: "2026-09-20",
				dependencyRefs: ["notion:page:page-2"],
				sourceUrl: "https://notion.so/page-9",
			},
		});
	});

	it("produces stable hashes regardless of object key order", () => {
		expect(contentHash({ a: 1, b: { c: 2 } })).toBe(
			contentHash({ b: { c: 2 }, a: 1 }),
		);
	});

	it("captures company context as an extraction-ready source document, not accepted memory", () => {
		const contextSource: NotionSourceConfig = {
			key: "handbook",
			kind: "page",
			resourceId: "page-9",
			ingestAs: "company_context",
			contextPath: "/company/handbook",
			visibility: "company",
			statusMap: {},
		};
		const observation = normalizeNotionPage(contextSource, page, [
			{
				object: "block",
				id: "heading",
				type: "heading_1",
				has_children: false,
				heading_1: {
					rich_text: [{ plain_text: "Working agreements" }],
				},
			},
			{
				object: "block",
				id: "body",
				type: "paragraph",
				has_children: false,
				paragraph: {
					rich_text: [
						{ plain_text: "Production changes require review." },
					],
				},
			},
		]);

		expect(observation.signal).toEqual({
			type: "source_document_snapshot",
			suggestedPath: "/company/handbook",
			title: "Resolve launch blocker",
		});
		expect(observation.event).toMatchObject({
			provider: "notion",
			eventKind: "source.document.retrieved",
			payload: {
				document: {
					title: "Resolve launch blocker",
					suggestedPath: "/company/handbook",
					markdown:
						"# Working agreements\n\nProduction changes require review.",
				},
			},
		});
	});

	it("keeps configured database rows as separate source documents with their properties", () => {
		const observation = normalizeNotionPage(
			{ ...source, ingestAs: "company_context" },
			page,
		);

		expect(observation.signal).toMatchObject({
			type: "source_document_snapshot",
		});
		expect(observation.event.payload).toMatchObject({
			document: {
				suggestedPath:
					"/sources/notion/pages/resolve-launch-blocker-page9.md",
				markdown: expect.stringContaining("Stage: Waiting"),
			},
		});
		expect(
			(observation.event.payload as { document: { markdown: string } })
				.document.markdown,
		).toContain("Owner: Noor");
	});

	it("gives each workspace-discovered page a stable unique evidence ref and suggested path", () => {
		const workspaceSource: NotionSourceConfig = {
			key: "workspace-pages",
			kind: "workspace",
			ingestAs: "company_context",
			contextPath: "/sources/notion/pages",
			visibility: "company",
			statusMap: {},
		};

		const observation = normalizeNotionPage(workspaceSource, page, []);

		expect(observation.event.sourceRef).toBe(
			"notion:workspace-page:page-9",
		);
		expect(observation.event.payload).toMatchObject({
			document: {
				suggestedPath:
					"/sources/notion/pages/resolve-launch-blocker-page9.md",
			},
		});
	});

	it("ignores expiring Notion file credentials without hiding a real attachment change", () => {
		const contextSource: NotionSourceConfig = {
			key: "handbook",
			kind: "page",
			resourceId: "page-9",
			ingestAs: "company_context",
			contextPath: "/company/handbook.md",
			visibility: "company",
			statusMap: {},
		};

		const attachment = (
			path: string,
			signature: string,
			expiry: string,
		) => ({
			object: "block" as const,
			id: "attachment",
			type: "file",
			has_children: false,
			file: {
				type: "file",
				file: {
					url: `https://prod-files-secure.s3.us-west-2.amazonaws.com/${path}?X-Amz-Signature=${signature}`,
					expiry_time: expiry,
				},
			},
		});

		const firstPage = {
			...page,
			request_id: "first-request",
		} as NotionPage;
		const refreshedPage = {
			...page,
			request_id: "second-request",
		} as NotionPage;
		const first = normalizeNotionPage(contextSource, firstPage, [
			attachment(
				"stable/report.pdf",
				"first",
				"2026-09-17T10:00:00.000Z",
			),
		]);
		const refreshed = normalizeNotionPage(contextSource, refreshedPage, [
			attachment(
				"stable/report.pdf",
				"second",
				"2026-09-17T11:00:00.000Z",
			),
		]);
		const replaced = normalizeNotionPage(contextSource, page, [
			attachment(
				"changed/report.pdf",
				"third",
				"2026-09-17T12:00:00.000Z",
			),
		]);

		expect(refreshed.event.providerEventId).toBe(
			first.event.providerEventId,
		);
		expect(refreshed.event.contentHash).toBe(first.event.contentHash);
		expect(replaced.event.providerEventId).not.toBe(
			first.event.providerEventId,
		);
		expect(replaced.event.contentHash).not.toBe(first.event.contentHash);
	});
});
