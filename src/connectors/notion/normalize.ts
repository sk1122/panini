import type { NotionSourceConfig } from "../../config.js";
import { contextSlug } from "../../domain/context-catalog.js";
import { contentHash } from "../../domain/content-hash.js";
import type {
	JsonValue,
	Observation,
	TaskFields,
	TaskPriority,
	TaskStatus,
} from "../../domain/types.js";
import type {
	NotionBlock,
	NotionPage,
	NotionProperty,
	NotionRichText,
} from "./types.js";

function richText(value: NotionRichText[] | undefined): string {
	return (value ?? [])
		.map((item) => item.plain_text ?? "")
		.join("")
		.trim();
}

function propertyText(property: NotionProperty | undefined): string {
	if (!property) return "";
	if (property.title) return richText(property.title);
	if (property.rich_text) return richText(property.rich_text);
	if (property.status) return property.status.name ?? "";
	if (property.select) return property.select.name ?? "";
	if (property.multi_select)
		return property.multi_select
			.map((item) => item.name ?? "")
			.filter(Boolean)
			.join(", ");
	if (property.people)
		return property.people
			.map((person) => person.name ?? person.id ?? "")
			.filter(Boolean)
			.join(", ");
	if (property.date) return property.date.start ?? "";
	if (property.relation)
		return property.relation.map((relation) => relation.id).join(", ");
	if (typeof property.checkbox === "boolean")
		return String(property.checkbox);
	if (typeof property.number === "number") return String(property.number);
	if (property.url) return property.url;
	if (property.email) return property.email;
	if (property.phone_number) return property.phone_number;
	if (property.formula) {
		if (property.formula.string) return property.formula.string;
		if (typeof property.formula.number === "number")
			return String(property.formula.number);
		if (typeof property.formula.boolean === "boolean")
			return String(property.formula.boolean);
		return property.formula.date?.start ?? "";
	}
	return "";
}

function pageTitle(page: NotionPage): string {
	const titleProperty = Object.values(page.properties).find(
		(property) => property.type === "title" || property.title,
	);

	return propertyText(titleProperty) || "Untitled";
}

function normalizeStatus(
	value: string,
	configured: Record<string, TaskStatus>,
): TaskStatus {
	const key = value.trim().toLowerCase();
	const explicit = Object.entries(configured).find(
		([label]) => label.toLowerCase() === key,
	)?.[1];

	if (explicit) return explicit;
	if (["planned", "ready", "next"].includes(key)) return "planned";
	if (
		["in progress", "in-progress", "doing", "active", "started"].includes(
			key,
		)
	)
		return "in_progress";
	if (["blocked", "stuck"].includes(key)) return "blocked";
	if (["review", "in review", "qa"].includes(key)) return "review";
	if (["done", "complete", "completed", "shipped"].includes(key))
		return "done";
	if (["cancelled", "canceled", "won't do"].includes(key)) return "cancelled";
	return "backlog";
}

function normalizePriority(value: string): TaskPriority {
	const key = value.trim().toLowerCase();

	if (["urgent", "critical", "p0"].includes(key)) return "urgent";
	if (["high", "p1"].includes(key)) return "high";
	if (["low", "p3", "p4"].includes(key)) return "low";
	return "medium";
}

function blockText(block: NotionBlock): string {
	const data = block[block.type];

	if (!data || typeof data !== "object") return "";

	const rich = (data as { rich_text?: NotionRichText[] }).rich_text;
	const text = richText(rich);

	if (!text) return "";
	if (block.type === "heading_1") return `# ${text}`;
	if (block.type === "heading_2") return `## ${text}`;
	if (block.type === "heading_3") return `### ${text}`;
	if (block.type === "bulleted_list_item") return `- ${text}`;
	if (block.type === "numbered_list_item") return `1. ${text}`;
	if (block.type === "to_do")
		return `- [${(data as { checked?: boolean }).checked ? "x" : " "}] ${text}`;
	if (block.type === "quote") return `> ${text}`;
	return text;
}

function stableNotionValue(
	value: JsonValue,
	parentKey: string | null = null,
): JsonValue {
	if (Array.isArray(value))
		return value.map((item) => stableNotionValue(item, parentKey));
	if (value === null || typeof value !== "object") return value;

	const result: Record<string, JsonValue> = {};

	for (const [key, item] of Object.entries(value)) {
		if (key === "request_id") continue;
		// Notion-hosted files contain a short-lived signed URL and expiry. Those
		// transport credentials change on every fetch even when the page does not.
		if (parentKey === "file" && key === "expiry_time") continue;
		if (parentKey === "file" && key === "url" && typeof item === "string") {
			try {
				const url = new URL(item);

				result[key] = `${url.origin}${url.pathname}`;
			} catch {
				result[key] = item;
			}
			continue;
		}
		result[key] = stableNotionValue(item as JsonValue, key);
	}
	return result;
}

function notionContentHash(payload: JsonValue): string {
	return contentHash(stableNotionValue(payload));
}

export { contentHash } from "../../domain/content-hash.js";

export function normalizeNotionPage(
	source: NotionSourceConfig,
	page: NotionPage,
	blocks: NotionBlock[] = [],
	apiVersion = "2026-03-11",
): Observation {
	const fetchedAt = new Date().toISOString();
	const payload = { page, blocks } as unknown as JsonValue;
	const hash = notionContentHash(payload);
	const sourceRef =
		source.kind === "workspace"
			? `notion:workspace-page:${page.id}`
			: `notion:page:${page.id}`;
	const common = {
		provider: "notion",
		installationKey: "default",
		providerEventId: `${source.key}:${page.id}:${hash}`,
		eventKind: "snapshot.retrieved",
		occurredAt: page.last_edited_time,
		fetchedAt,
		sourceRef,
		sourceUrl: page.url || null,
		contentHash: hash,
		visibility: source.visibility,
		payloadVersion: `notion-${apiVersion}-snapshot-v2`,
		payload,
	};

	if (source.ingestAs === "company_context") {
		const title = pageTitle(page);
		const workspacePrefix = (
			source.contextPath ?? "/sources/notion/pages"
		).replace(/\/+$/, "");
		const compactPageId = page.id.replace(/-/g, "").slice(0, 8);
		const properties =
			source.kind === "data_source"
				? Object.entries(page.properties)
						.map(([name, value]) => {
							const text = propertyText(value);

							return text ? `${name}: ${text}` : "";
						})
						.filter(Boolean)
				: [];
		const document = {
			title,
			suggestedPath:
				source.kind === "workspace" || source.kind === "data_source"
					? `${workspacePrefix}/${contextSlug(title)}-${compactPageId}.md`
					: (source.contextPath ??
						`/sources/notion/${contextSlug(source.key)}.md`),
			markdown: [
				...properties,
				...blocks.map(blockText).filter(Boolean),
			].join("\n\n"),
		};
		const documentPayload = {
			document,
			page,
			blocks,
		} as unknown as JsonValue;
		const documentHash = notionContentHash(documentPayload);

		return {
			event: {
				...common,
				providerEventId: `${source.key}:document:${page.id}:${documentHash}`,
				eventKind: "source.document.retrieved",
				contentHash: documentHash,
				payload: documentPayload,
			},
			signal: {
				type: "source_document_snapshot",
				suggestedPath: document.suggestedPath,
				title: document.title,
			},
		};
	}

	const mapping = source.properties ?? { title: "Name", status: "Status" };
	const fields: TaskFields = {
		externalRef: common.sourceRef,
		title: propertyText(page.properties[mapping.title]) || pageTitle(page),
		description: mapping.description
			? propertyText(page.properties[mapping.description])
			: "",
		status: normalizeStatus(
			propertyText(page.properties[mapping.status]),
			source.statusMap,
		),
		priority: mapping.priority
			? normalizePriority(propertyText(page.properties[mapping.priority]))
			: "medium",
		owner: mapping.owner
			? propertyText(page.properties[mapping.owner]) || null
			: null,
		project: mapping.project
			? propertyText(page.properties[mapping.project]) || null
			: null,
		dueDate: mapping.dueDate
			? propertyText(page.properties[mapping.dueDate]) || null
			: null,
		dependencyRefs: mapping.dependencies
			? (page.properties[mapping.dependencies]?.relation ?? []).map(
					(relation) => `notion:page:${relation.id}`,
				)
			: [],
		sourceUrl: page.url || null,
	};

	return { event: common, signal: { type: "task_snapshot", fields } };
}
