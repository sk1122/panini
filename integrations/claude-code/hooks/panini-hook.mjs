import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  size += value.length;
  if (size > 1_000_000) process.exit(0);
  chunks.push(value);
}

let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  process.exit(0);
}

const event = String(input.hook_event_name || "Unknown");
const mapping = {
  SessionStart: ["started", "Claude Code session started."],
  TaskCompleted: ["delivered", "Claude Code reported a task checkpoint."],
  StopFailure: ["failed", "Claude Code reported a failed stop."],
  SessionEnd: ["checkpoint", "Claude Code session ended."],
};
const selected = mapping[event];
if (!selected) process.exit(0);

const stableReceiptMaterial = JSON.stringify({
  event,
  sessionId: input.session_id || null,
  taskId: input.task_id || null,
  toolUseId: input.tool_use_id || null,
  stopReason: input.stop_reason || null,
});
const reportId = `claude-hook-${createHash("sha256").update(stableReceiptMaterial).digest("hex")}`;
const report = {
  reportId,
  workItemId: process.env.PANINI_TASK_ID || null,
  phase: selected[0],
  outcome: selected[1],
  artifactRefs: [],
  verification: [],
  occurredAt: new Date().toISOString(),
};

const relay = process.env.PANINI_RELAY_BIN || "panini-relay";
const result = spawnSync(relay, ["enqueue", "--report", "-"], {
  input: JSON.stringify(report),
  encoding: "utf8",
  timeout: 4_000,
  stdio: ["pipe", "ignore", "pipe"],
  shell: false,
});
if (result.error || result.status !== 0) {
  process.stderr.write("Panini relay did not accept the metadata-only hook receipt; Claude work was not blocked.\n");
}
process.exit(0);
