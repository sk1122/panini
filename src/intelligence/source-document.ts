import type { JsonValue, SourceEvent } from "../domain/types.js";

const diagramStart =
	/^(flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b/i;

function record(
	value: JsonValue | undefined,
): { [key: string]: JsonValue } | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as { [key: string]: JsonValue })
		: null;
}

export function sourceDocumentMarkdown(event: SourceEvent): string | null {
	if (event.eventKind !== "source.document.retrieved") return null;

	const payload = record(event.payload);
	const document = record(payload?.document);

	return typeof document?.markdown === "string" ? document.markdown : null;
}

export function extractPrimaryMermaid(
	markdown: string,
	maximumCharacters = 20_000,
): string | null {
	const fenced = markdown
		.match(
			/```(?:mermaid)?\s*\n((?:flowchart|graph|sequenceDiagram|stateDiagram(?:-v2)?|classDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|gitGraph)\b[\s\S]*?)```/i,
		)?.[1]
		?.trim();

	if (fenced && fenced.length <= maximumCharacters) return fenced;

	const lines = markdown.split(/\r?\n/);
	const start = lines.findIndex((line) => diagramStart.test(line.trim()));

	if (start < 0) return null;

	const collected: string[] = [];

	for (let index = start; index < lines.length; index += 1) {
		const line = lines[index]!;

		if (index > start && /^#{1,6}\s+/.test(line.trim())) break;
		collected.push(line);
	}

	const diagram = collected.join("\n").trim();

	return diagram && diagram.length <= maximumCharacters ? diagram : null;
}

export function containsMermaidDiagram(markdown: string): boolean {
	return markdown
		.split(/\r?\n/)
		.some((line) => diagramStart.test(line.trim()));
}

/**
 * Preserve relationship structure that a prose synthesis would otherwise erase.
 * Only the first source-authored diagram is carried forward, and the accepted file
 * remains under the same 40k contract as model output.
 */
export function preservePrimarySourceDiagram(
	body: string,
	evidence: SourceEvent[],
	maximumBodyCharacters = 40_000,
): string {
	const normalized = body.trim();

	if (containsMermaidDiagram(normalized)) return normalized;
	for (const event of evidence) {
		const markdown = sourceDocumentMarkdown(event);
		const diagram = markdown ? extractPrimaryMermaid(markdown) : null;

		if (!diagram) continue;

		const addition = `\n\n## Source architecture diagram\n\nThe following diagram is preserved from the cited source because it encodes relationships that prose alone loses.\n\n\`\`\`mermaid\n${diagram}\n\`\`\``;

		return normalized.length + addition.length <= maximumBodyCharacters
			? `${normalized}${addition}`
			: normalized;
	}
	return normalized;
}
