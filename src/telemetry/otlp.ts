import { randomBytes } from "node:crypto";

/*
 * Minimal OTLP/HTTP JSON support, without extra dependencies.
 * In: read token use and cost from an agent's own log export (Claude Code, Codex).
 * Out: emit one `execute_tool` span per MCP tool call to a collector.
 */

type AnyValue = {
	stringValue?: string;
	intValue?: string | number;
	doubleValue?: number;
	boolValue?: boolean;
};

interface KeyValue {
	key: string;
	value?: AnyValue;
}

interface LogRecord {
	attributes?: KeyValue[];
	body?: AnyValue;
}

interface LogsRequest {
	resourceLogs?: {
		resource?: { attributes?: KeyValue[] };
		scopeLogs?: { logRecords?: LogRecord[] }[];
	}[];
}

export interface UsageRecord {
	sessionId: string;
	costUsd: number | null;
	inputTokens: number | null;
	outputTokens: number | null;
}

function scalar(value: AnyValue | undefined): string | number | boolean | null {
	if (!value) return null;
	if (value.stringValue !== undefined) return value.stringValue;
	if (value.intValue !== undefined) return Number(value.intValue);
	if (value.doubleValue !== undefined) return value.doubleValue;
	if (value.boolValue !== undefined) return value.boolValue;
	return null;
}

function number(value: unknown): number | null {
	const parsed = typeof value === "string" ? Number(value) : value;

	return typeof parsed === "number" && Number.isFinite(parsed) && parsed >= 0
		? parsed
		: null;
}

/** API-request log records that carry a session id and token or cost figures. */
export function usageFromLogs(body: unknown): UsageRecord[] {
	const request = body as LogsRequest;
	const records: UsageRecord[] = [];

	for (const resource of request.resourceLogs ?? []) {
		const shared = Object.fromEntries(
			(resource.resource?.attributes ?? []).map((item) => [
				item.key,
				scalar(item.value),
			]),
		);

		for (const scope of resource.scopeLogs ?? [])
			for (const log of scope.logRecords ?? []) {
				const attributes = {
					...shared,
					...Object.fromEntries(
						(log.attributes ?? []).map((item) => [
							item.key,
							scalar(item.value),
						]),
					),
				};
				const name = String(
					attributes["event.name"] ?? scalar(log.body) ?? "",
				);
				const sessionId =
					attributes["session.id"] ?? attributes["conversation.id"];

				if (!/api_request$/.test(name) || typeof sessionId !== "string")
					continue;

				const usage = {
					sessionId: sessionId.slice(0, 200),
					costUsd: number(attributes.cost_usd),
					inputTokens: number(attributes.input_tokens),
					outputTokens: number(attributes.output_tokens),
				};

				if (
					usage.costUsd !== null ||
					usage.inputTokens !== null ||
					usage.outputTokens !== null
				)
					records.push(usage);
			}
	}
	return records;
}

interface Span {
	name: string;
	startMs: number;
	endMs: number;
	ok: boolean;
	attributes: Record<string, string | number>;
}

/** Batches spans and posts them to `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces`. */
export class SpanExporter {
	private queue: Span[] = [];
	private timer: NodeJS.Timeout | null = null;

	constructor(
		private readonly endpoint: string,
		private readonly headers: Record<string, string> = {},
	) {}

	static fromEnvironment(env = process.env): SpanExporter | null {
		const endpoint = env.OTEL_EXPORTER_OTLP_ENDPOINT?.replace(/\/$/, "");

		if (!endpoint) return null;

		const headers = Object.fromEntries(
			(env.OTEL_EXPORTER_OTLP_HEADERS ?? "")
				.split(",")
				.map((pair) => pair.split("="))
				.filter((pair) => pair.length >= 2 && pair[0]!.trim())
				.map(([key, ...rest]) => [key!.trim(), rest.join("=").trim()]),
		);

		return new SpanExporter(endpoint, headers);
	}

	record(span: Span): void {
		if (this.queue.length >= 1_000) this.queue.shift();
		this.queue.push(span);
		this.timer ??= setTimeout(() => void this.flush(), 2_000);
		this.timer.unref?.();
	}

	async flush(): Promise<void> {
		this.timer = null;

		const spans = this.queue.splice(0);

		if (spans.length === 0) return;

		const toNanos = (ms: number) =>
			`${BigInt(Math.round(ms)) * 1_000_000n}`;

		await fetch(`${this.endpoint}/v1/traces`, {
			method: "POST",
			headers: { "content-type": "application/json", ...this.headers },
			body: JSON.stringify({
				resourceSpans: [
					{
						resource: {
							attributes: [
								{
									key: "service.name",
									value: { stringValue: "panini" },
								},
							],
						},
						scopeSpans: [
							{
								scope: { name: "panini.mcp" },
								spans: spans.map((span) => ({
									traceId: randomBytes(16).toString("hex"),
									spanId: randomBytes(8).toString("hex"),
									name: span.name,
									kind: 2,
									startTimeUnixNano: toNanos(span.startMs),
									endTimeUnixNano: toNanos(span.endMs),
									status: { code: span.ok ? 1 : 2 },
									attributes: Object.entries(
										span.attributes,
									).map(([key, value]) => ({
										key,
										value:
											typeof value === "number"
												? { intValue: String(value) }
												: { stringValue: value },
									})),
								})),
							},
						],
					},
				],
			}),
			signal: AbortSignal.timeout(5_000),
		}).catch(() => undefined);
	}
}
