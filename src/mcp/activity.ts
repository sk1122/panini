import type { ActivityClass, AgentSession } from "../domain/agent-ledger.js";
import { DomainError } from "../domain/errors.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import { SpanExporter } from "../telemetry/otlp.js";
import { currentMcpPrincipal, mcpAccessScope } from "./principal.js";

// Optional: every agent tool call also becomes an OpenTelemetry `execute_tool` span.
let exporter: SpanExporter | null | undefined;

const spans = () => (exporter ??= SpanExporter.fromEnvironment());

const classes: Record<string, ActivityClass> = {
	work_search: "search",
	context_search: "search",
	agent_file_write: "write",
	agent_file_delete: "write",
	user_file_write: "write",
	user_file_delete: "write",
	proposal_create: "propose",
	task_create_proposal: "propose",
	context_proposal_create: "propose",
	outcome_contract_proposal_create: "propose",
	decision_propose: "propose",
	work_report: "report",
	handoff_write: "report",
	note_drop: "report",
	task_claim: "claim",
	task_release: "claim",
	session_end: "session",
};

export function actionClassFor(tool: string): ActivityClass {
	return classes[tool] ?? "read";
}

const uuidPattern =
	/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** Ids only: the log records what was touched, never prompt text or returned content. */
export function collectIds(value: unknown, limit = 100): string[] {
	const ids = new Set<string>();

	const visit = (item: unknown, depth: number) => {
		if (ids.size >= limit || depth > 8 || item === null) return;
		if (typeof item === "string") {
			for (const match of item.matchAll(uuidPattern)) {
				ids.add(match[0].toLowerCase());
				if (ids.size >= limit) return;
			}
			return;
		}
		if (Array.isArray(item)) {
			for (const entry of item) visit(entry, depth + 1);
			return;
		}
		if (typeof item === "object")
			for (const [key, entry] of Object.entries(item)) {
				// Long text fields can quote ids from other places; ids live in id-like keys.
				if (
					typeof entry === "string" &&
					entry.length > 200 &&
					!/id$|ids$|uri$/i.test(key)
				)
					continue;
				visit(entry, depth + 1);
			}
	};

	visit(value, 0);
	return [...ids];
}

/** The session this request belongs to; resolved once per request. */
export function mcpSession(ledger: TeamLedger): Promise<AgentSession> | null {
	const principal = currentMcpPrincipal();

	if (principal.kind !== "agent") return null;

	const access = mcpAccessScope();

	if (access.kind !== "agent") return null;
	principal.session ??= ledger.resolveAgentSession(access, {
		clientSessionId: principal.sessionHint?.clientSessionId ?? null,
		harness: principal.sessionHint?.harness ?? principal.profile.harness,
		repository: principal.sessionHint?.repository ?? null,
		branch: principal.sessionHint?.branch ?? null,
	});
	return principal.session;
}

type Handler = (...args: never[]) => unknown;

/** Wrap one MCP tool so every call by an agent lands in the activity log. */
export function instrumentTool<T extends Handler>(
	ledger: TeamLedger,
	tool: string,
	handler: T,
): T {
	return (async (...args: Parameters<T>) => {
		const principal = currentMcpPrincipal();

		if (principal.kind !== "agent") return handler(...args);

		const started = Date.now();
		const session = await mcpSession(ledger);
		const input = args[0];

		const record = (
			outcome: "ok" | "denied" | "error",
			output: unknown,
			detail: string | null,
		) => {
			const targetIds = collectIds([input, output]);

			spans()?.record({
				name: `execute_tool ${tool}`,
				startMs: started,
				endMs: Date.now(),
				ok: outcome === "ok",
				attributes: {
					"gen_ai.operation.name": "execute_tool",
					"gen_ai.tool.name": tool,
					"panini.agent.profile_id": principal.profile.id,
					"panini.agent.name": principal.profile.name,
					"panini.member.id": principal.member.id,
					"panini.session.id": session?.id ?? "",
					"panini.action_class": actionClassFor(tool),
					"panini.outcome": outcome,
					"panini.target.count": targetIds.length,
				},
			});

			return ledger.agents
				.recordActivity({
					agentProfileId: principal.profile.id,
					memberId: principal.member.id,
					sessionId: session?.id ?? null,
					tool,
					actionClass: actionClassFor(tool),
					targetIds,
					resultCount: outcome === "ok" ? targetIds.length : null,
					outcome,
					detail,
					durationMs: Date.now() - started,
				})
				.catch(() => undefined);
		};

		try {
			const result = (await handler(...args)) as {
				structuredContent?: unknown;
				isError?: boolean;
			};

			await record(
				result?.isError ? "error" : "ok",
				result?.structuredContent ?? null,
				null,
			);
			return result;
		} catch (error) {
			const denied =
				error instanceof DomainError && error.code === "FORBIDDEN";

			await record(
				denied ? "denied" : "error",
				null,
				error instanceof Error ? error.message : "Unknown error",
			);
			throw error;
		}
	}) as unknown as T;
}
