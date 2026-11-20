import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { pantryConnection } from "./panini-token.mjs";

// Never block Claude: every failure path exits 0 quietly.
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

function connection() {
	return pantryConnection();
}

function git(args) {
	const result = spawnSync("git", args, {
		cwd: input.cwd || process.cwd(),
		encoding: "utf8",
		timeout: 1_000,
		stdio: ["ignore", "pipe", "ignore"],
	});

	return result.status === 0 ? result.stdout.trim() : null;
}

function repository() {
	const remote = git(["remote", "get-url", "origin"]);
	const match = remote && /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(remote);

	return match ? match[1] : null;
}

const lifecycle = {
	SessionStart: "session_start",
	SessionEnd: "session_end",
	StopFailure: "session_failed",
}[event];
const target = connection();

/** The session as plain text: what was said and done, without tool output. */
function compactTranscript(path) {
	let lines;

	try {
		lines = readFileSync(path, "utf8").split("\n");
	} catch {
		return "";
	}

	const parts = [];

	for (const line of lines) {
		let entry;

		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (entry.isSidechain || !["user", "assistant"].includes(entry.type))
			continue;

		const content = entry.message?.content;
		const blocks =
			typeof content === "string"
				? [{ type: "text", text: content }]
				: Array.isArray(content)
					? content
					: [];

		for (const block of blocks) {
			if (block.type === "text" && block.text?.trim())
				parts.push(
					`${entry.type === "user" ? "USER" : "AGENT"}: ${block.text.trim().slice(0, 4_000)}`,
				);
			else if (block.type === "tool_use") {
				const detail =
					block.input?.file_path ||
					block.input?.command ||
					block.input?.pattern ||
					"";

				parts.push(
					`AGENT did ${block.name}${detail ? ": " + String(detail).slice(0, 200) : ""}`,
				);
			}
		}
	}

	// Keep the request at the start and the most recent work.
	const text = parts.join("\n");

	return text.length <= 120_000
		? text
		: text.slice(0, 20_000) + "\n…\n" + text.slice(-100_000);
}

if (
	lifecycle === "session_end" &&
	target &&
	input.session_id &&
	input.transcript_path
) {
	const transcript = compactTranscript(String(input.transcript_path));

	if (transcript.length > 200)
		await fetch(new URL("/api/agent/hooks/transcript", target.url).href, {
			method: "POST",
			headers: {
				authorization: `Bearer ${target.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				clientSessionId: String(input.session_id).slice(0, 200),
				transcript,
				harness: "claude_code",
				...(repository() ? { repository: repository() } : {}),
			}),
			signal: AbortSignal.timeout(3_000),
		}).catch(() => undefined);
}

if (lifecycle && target && input.session_id) {
	try {
		const response = await fetch(
			new URL("/api/agent/hooks", target.url).href,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${target.token}`,
					"content-type": "application/json",
				},
				body: JSON.stringify({
					event: lifecycle,
					clientSessionId: String(input.session_id).slice(0, 200),
					harness: "claude_code",
					...(repository() ? { repository: repository() } : {}),
					...(git(["branch", "--show-current"])
						? { branch: git(["branch", "--show-current"]) }
						: {}),
				}),
				signal: AbortSignal.timeout(3_000),
			},
		);

		if (response.ok && lifecycle === "session_start") {
			const body = await response.json();

			// SessionStart may add context: the session's claims, last handoff and team notes.
			if (body.brief)
				process.stdout.write(
					JSON.stringify({
						hookSpecificOutput: {
							hookEventName: "SessionStart",
							additionalContext: `Panini: ${body.brief}`,
						},
					}),
				);
		}
	} catch {
		process.stderr.write(
			"Panini was unreachable; Claude work was not blocked.\n",
		);
	}
	process.exit(0);
}

// The code the agent changed: one record per Edit, MultiEdit or Write.
if (event === "PostToolUse") {
	const tool = String(input.tool_name || "");
	const toolInput = input.tool_input || {};
	const file = String(toolInput.file_path || "");

	if (
		!target ||
		!input.session_id ||
		!file ||
		!/^(Edit|MultiEdit|Write)$/.test(tool)
	)
		process.exit(0);

	const root = git(["rev-parse", "--show-toplevel"]);
	const filePath =
		root && file.startsWith(root + "/")
			? file.slice(root.length + 1)
			: file;
	const pairs =
		tool === "MultiEdit"
			? (toolInput.edits || []).map((edit) => [
					edit.old_string,
					edit.new_string,
				])
			: [[toolInput.old_string, toolInput.new_string]];
	const before =
		tool === "Write"
			? null
			: pairs.map(([old]) => String(old ?? "")).join("\n…\n");
	const after =
		tool === "Write"
			? String(toolInput.content ?? "")
			: pairs.map(([, next]) => String(next ?? "")).join("\n…\n");

	try {
		await fetch(new URL("/api/agent/hooks/edit", target.url).href, {
			method: "POST",
			headers: {
				authorization: `Bearer ${target.token}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				clientSessionId: String(input.session_id).slice(0, 200),
				toolUseId: String(
					input.tool_use_id || `${tool}:${file}:${Date.now()}`,
				).slice(0, 200),
				tool,
				filePath: filePath.slice(0, 500),
				before: before === null ? null : before.slice(0, 400_000),
				after: after.slice(0, 400_000),
				harness: "claude_code",
				...(repository() ? { repository: repository() } : {}),
				...(git(["branch", "--show-current"])
					? { branch: git(["branch", "--show-current"]) }
					: {}),
			}),
			signal: AbortSignal.timeout(3_000),
		});
	} catch {
		// Never block Claude.
	}
	process.exit(0);
}

// Task checkpoints keep using the signed, offline-capable relay.
if (event !== "TaskCompleted") process.exit(0);

const reportId = `claude-hook-${createHash("sha256")
	.update(
		JSON.stringify({
			event,
			sessionId: input.session_id || null,
			taskId: input.task_id || null,
			toolUseId: input.tool_use_id || null,
		}),
	)
	.digest("hex")}`;
const result = spawnSync(
	process.env.PANINI_RELAY_BIN || "panini-relay",
	["enqueue", "--report", "-"],
	{
		input: JSON.stringify({
			reportId,
			workItemId: process.env.PANINI_TASK_ID || null,
			phase: "delivered",
			outcome: "Claude Code reported a task checkpoint.",
			artifactRefs: [],
			verification: [],
			occurredAt: new Date().toISOString(),
		}),
		encoding: "utf8",
		timeout: 4_000,
		stdio: ["pipe", "ignore", "pipe"],
		shell: false,
	},
);

if (result.error || result.status !== 0)
	process.stderr.write(
		"Panini relay did not accept the metadata-only hook receipt; Claude work was not blocked.\n",
	);
process.exit(0);
