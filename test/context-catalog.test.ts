import { describe, expect, it } from "vitest";
import {
	buildContextTree,
	createContextIndex,
	normalizeContextPath,
} from "../src/domain/context-catalog.js";
import type { ContextEntry } from "../src/domain/types.js";

const common = {
	sourceEventId: "10000000-0000-4000-8000-000000000001",
	sourceUrl: null,
	contentHash: "abc",
	evidenceIds: ["10000000-0000-4000-8000-000000000001"],
	lifecycleState: "accepted" as const,
	effectiveFrom: "2026-09-15T08:00:00.000Z",
	effectiveTo: null,
	links: [],
	updatedAt: "2026-09-15T08:00:00.000Z",
};

const entries: ContextEntry[] = [
	{
		...common,
		id: "20000000-0000-4000-8000-000000000001",
		kind: "file",
		sourceRef: "notion:handbook",
		path: "/sources/notion/handbook.md",
		title: "Handbook",
		body: "A long-form company handbook.",
	},
	{
		...common,
		id: "20000000-0000-4000-8000-000000000002",
		kind: "fact",
		sourceRef: "decision:deployments",
		path: "/policies/deployment/green-suite",
		title: "Production gate",
		factType: "policy",
		value: "Production deployments require a green integration suite.",
	},
];

describe("context catalog", () => {
	it("normalizes paths without allowing traversal or URL fragments", () => {
		expect(
			normalizeContextPath(" sources\\notion\\handbook ", "file"),
		).toBe("/sources/notion/handbook.md");
		expect(normalizeContextPath("/facts/company/name", "fact")).toBe(
			"/facts/company/name",
		);
		expect(() => normalizeContextPath("../secrets", "file")).toThrow(
			"cannot traverse",
		);
		expect(() =>
			normalizeContextPath("/facts/name?old=true", "fact"),
		).toThrow("unsupported");
	});

	it("projects files and facts into a deterministic folder-first tree", () => {
		const tree = buildContextTree(entries);

		expect(tree.map((node) => node.name)).toEqual(["policies", "sources"]);
		expect(tree[0]?.children[0]?.children[0]).toMatchObject({
			kind: "fact",
			path: "/policies/deployment/green-suite",
			entryId: entries[1]!.id,
		});
	});

	it("keeps file bodies out of the index while retaining facts and useful metadata", () => {
		const index = createContextIndex(entries, "2026-09-15T09:00:00.000Z");

		expect(index.counts).toEqual({
			facts: 1,
			files: 1,
			folders: 4,
			accepted: 2,
			needsReview: 0,
			superseded: 0,
			outsideEffectiveInterval: 0,
		});
		expect(index.facts[0]).toMatchObject({
			value: "Production deployments require a green integration suite.",
		});
		expect(index.files[0]).toMatchObject({
			characterCount: 29,
			excerpt: "A long-form company handbook.",
		});
		expect(index.files[0]).not.toHaveProperty("body");
	});
});
