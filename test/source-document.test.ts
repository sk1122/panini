import { describe, expect, it } from "vitest";
import type { SourceEvent } from "../src/domain/types.js";
import {
	extractPrimaryMermaid,
	preservePrimarySourceDiagram,
} from "../src/intelligence/source-document.js";

function source(markdown: string): SourceEvent {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		provider: "notion",
		installationKey: "default",
		providerEventId: "architecture-v1",
		eventKind: "source.document.retrieved",
		occurredAt: "2026-09-16T00:00:00.000Z",
		fetchedAt: "2026-09-16T00:00:01.000Z",
		receivedAt: "2026-09-16T00:00:02.000Z",
		sourceRef: "notion:architecture",
		sourceUrl: "https://notion.example/architecture",
		contentHash: "source-hash",
		visibility: "company",
		payloadVersion: "test",
		payload: { document: { title: "Architecture", markdown } },
	};
}

describe("source-document structure preservation", () => {
	it("extracts a raw Notion Mermaid diagram without swallowing later sections", () => {
		const diagram = extractPrimaryMermaid(
			[
				"## One diagram",
				"flowchart TD",
				"  A --> B",
				"  B --> C",
				"",
				"## Explanation",
				"This prose is not part of the diagram.",
			].join("\n"),
		);

		expect(diagram).toBe("flowchart TD\n  A --> B\n  B --> C");
	});

	it("carries the source-authored primary diagram into a prose context synthesis", () => {
		const body = preservePrimarySourceDiagram(
			"# Architecture\n\nA concise summary.",
			[
				source(
					[
						"## One diagram",
						"flowchart LR",
						"  Source --> Ledger",
						"  Ledger --> Board",
						"",
						"## Details",
						"Long explanation.",
					].join("\n"),
				),
			],
		);

		expect(body).toContain("## Source architecture diagram");
		expect(body).toContain(
			"```mermaid\nflowchart LR\n  Source --> Ledger\n  Ledger --> Board\n```",
		);
		expect(body).not.toContain("Long explanation.");
	});
});
