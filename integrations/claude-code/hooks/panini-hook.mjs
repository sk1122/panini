import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
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
