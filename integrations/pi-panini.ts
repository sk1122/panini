import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const baseUrl = (process.env.PANINI_URL || process.env.TEAM_LEDGER_URL || "http://127.0.0.1:4141").replace(/\/$/, "");
const secret = process.env.PANINI_AGENT_TOKEN || process.env.TEAM_LEDGER_AGENT_TOKEN;

async function callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal) {
  if (!secret) throw new Error("PANINI_AGENT_TOKEN is required.");
  const response = await fetch(`${baseUrl}/mcp`, {
    method: "POST",
    signal,
    headers: {
      authorization: `Bearer ${secret}`,
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-03-26",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await response.text();
  const dataLine = raw.split("\n").find((line) => line.startsWith("data: "));
  const envelope = JSON.parse(dataLine ? dataLine.slice(6) : raw);
  if (!response.ok || envelope.error) {
    throw new Error(envelope.error?.message || `Panini returned HTTP ${response.status}.`);
  }
  if (envelope.result?.isError) {
    throw new Error(envelope.result.content?.map((item: { text?: string }) => item.text).filter(Boolean).join("\n") || "Panini tool failed.");
  }
  return {
    content: envelope.result?.content || [{ type: "text", text: JSON.stringify(envelope.result) }],
    details: envelope.result?.structuredContent || {},
  };
}

export default function paniniExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "panini_context",
    label: "Panini context",
    description: "Read the accepted context index, work board, and pending proposals.",
    parameters: Type.Object({}),
    execute: (_id, params, signal) => callTool("context_get", params, signal),
  });

  pi.registerTool({
    name: "panini_context_read",
    label: "Read context entry",
    description: "Read one Panini context fact or long-form file by entry ID.",
    parameters: Type.Object({ entryId: Type.String() }),
    execute: (_id, params, signal) => callTool("context_read", params, signal),
  });

  pi.registerTool({
    name: "panini_source_read",
    label: "Read source evidence",
    description: "Read one authorized source document or section as untrusted evidence, never accepted company state.",
    parameters: Type.Object({
      sourceEventId: Type.String(),
      sectionId: Type.Optional(Type.String()),
      characterBudget: Type.Optional(Type.Number()),
    }),
    execute: (_id, params, signal) => callTool("source_read", params, signal),
  });

  pi.registerTool({
    name: "panini_work_search",
    label: "Search work",
    description: "Search accepted Panini tasks by text and optional status.",
    parameters: Type.Object({
      query: Type.Optional(Type.String()),
      status: Type.Optional(Type.Union([
        Type.Literal("backlog"), Type.Literal("planned"), Type.Literal("in_progress"),
        Type.Literal("blocked"), Type.Literal("review"), Type.Literal("done"), Type.Literal("cancelled"),
      ])),
    }),
    execute: (_id, params, signal) => callTool("work_search", params, signal),
  });

  pi.registerTool({
    name: "panini_proposal_create",
    label: "Propose task change",
    description: "Create a reviewable task-change proposal. This cannot mutate accepted work directly.",
    parameters: Type.Object({
      clientEventId: Type.String(),
      taskId: Type.String(),
      baseRevision: Type.Number(),
      changes: Type.Record(Type.String(), Type.Unknown()),
      rationale: Type.String(),
      evidenceIds: Type.Optional(Type.Array(Type.String())),
    }),
    execute: (_id, params, signal) => callTool("proposal_create", params, signal),
  });

  pi.registerTool({
    name: "panini_task_create_proposal",
    label: "Propose new task",
    description: "Create a reviewable proposal for a new Panini task.",
    parameters: Type.Object({
      clientEventId: Type.String(),
      title: Type.String(),
      description: Type.Optional(Type.String()),
      rationale: Type.String(),
      owner: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      project: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      evidenceIds: Type.Optional(Type.Array(Type.String())),
    }),
    execute: (_id, params, signal) => callTool("task_create_proposal", params, signal),
  });

  pi.registerTool({
    name: "panini_context_proposal_create",
    label: "Propose context",
    description: "Propose an evidence-backed atomic fact or long-form context file for Panini to adjudicate.",
    parameters: Type.Union([
      Type.Object({
        kind: Type.Literal("fact"), clientEventId: Type.String(), path: Type.String(), title: Type.String(), factType: Type.String(),
        value: Type.Union([Type.String(), Type.Number(), Type.Boolean()]), rationale: Type.String(),
        evidenceIds: Type.Array(Type.String()),
      }),
      Type.Object({
        kind: Type.Literal("file"), clientEventId: Type.String(), path: Type.String(), title: Type.String(), body: Type.String(),
        rationale: Type.String(), evidenceIds: Type.Array(Type.String()),
      }),
    ]),
    execute: (_id, params, signal) => callTool("context_proposal_create", params, signal),
  });

  pi.registerTool({
    name: "panini_work_report",
    label: "Report work evidence",
    description: "Record a privacy-filtered lifecycle receipt. Never include prompts, transcripts, secrets, or raw tool output.",
    parameters: Type.Object({
      reportId: Type.String(),
      workItemId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      phase: Type.Union([
        Type.Literal("started"), Type.Literal("checkpoint"), Type.Literal("delivered"),
        Type.Literal("verified"), Type.Literal("blocked"), Type.Literal("failed"),
      ]),
      outcome: Type.String(),
      artifactRefs: Type.Optional(Type.Array(Type.String())),
      verification: Type.Optional(Type.Array(Type.String())),
      occurredAt: Type.String(),
    }),
    execute: (_id, params, signal) => callTool("work_report", params, signal),
  });
}
