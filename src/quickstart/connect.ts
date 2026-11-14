import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir, hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * `panini connect`: detect the harness and repository, ask a signed-in member to
 * approve in the browser, then save the agent's connection, register the MCP
 * server and install session hooks. No secret is copied by hand.
 */

const packageRoot = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);
const pantry = join(homedir(), ".panini");

function flag(name: string): string | null {
	const index = process.argv.indexOf(name);

	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

function has(command: string): boolean {
	return (
		spawnSync(process.platform === "win32" ? "where" : "which", [command], {
			stdio: "ignore",
		}).status === 0
	);
}

/**
 * `security -i` reads its command from stdin, so the token never appears in a
 * process listing and no terminal is needed. Returns false when it fails.
 */
function saveToKeychain(account: string, token: string): boolean {
	if (!/^[A-Za-z0-9_-]+$/.test(token) || /["\s]/.test(account)) return false;

	const result = spawnSync("security", ["-i"], {
		input: `add-generic-password -U -s work.panini.agent -a "${account}" -w "${token}"\n`,
		encoding: "utf8",
		timeout: 10_000,
		stdio: ["pipe", "ignore", "pipe"],
	});
	const found = spawnSync(
		"security",
		["find-generic-password", "-s", "work.panini.agent", "-a", account],
		{ stdio: "ignore", timeout: 10_000 },
	);

	return result.status === 0 && found.status === 0;
}

function detectHarness(): string {
	const chosen = flag("--harness");

	if (chosen) return chosen;
	if (has("claude")) return "claude_code";
	if (has("codex")) return "codex";
	if (has("hermes")) return "hermes";
	return "generic_mcp";
}

function detectRepository(): string | null {
	const remote = spawnSync("git", ["remote", "get-url", "origin"], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "ignore"],
	});
	const match =
		remote.status === 0
			? /[:/]([^/:\s]+\/[^/\s]+?)(?:\.git)?\s*$/.exec(remote.stdout)
			: null;

	return match ? match[1]! : null;
}

async function post(url: string, body: object) {
	const response = await fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	const json = (await response.json().catch(() => ({}))) as Record<
		string,
		unknown
	>;

	if (!response.ok)
		throw new Error(
			String(json.error ?? `Request failed: ${response.status}`),
		);
	return json;
}

function openBrowser(url: string) {
	if (process.argv.includes("--no-open")) return;

	const opener =
		process.platform === "darwin"
			? "open"
			: process.platform === "win32"
				? "explorer"
				: "xdg-open";

	spawn(opener, [url], { stdio: "ignore", detached: true }).unref();
}

async function installClaudeHelpers() {
	const directory = join(pantry, "hooks");
	const hookTarget = join(directory, "panini-hook.mjs");
	const headers = join(directory, "panini-headers.mjs");

	await mkdir(directory, { recursive: true, mode: 0o700 });
	for (const name of [
		"panini-hook.mjs",
		"panini-headers.mjs",
		"panini-token.mjs",
	])
		await copyFile(
			join(packageRoot, "integrations", "claude-code", "hooks", name),
			join(directory, name),
		);
	return { headers, hooks: await installClaudeHooks(hookTarget) };
}

async function installClaudeHooks(hookTarget: string) {
	const settingsFile = join(homedir(), ".claude", "settings.json");
	const settings = existsSync(settingsFile)
		? (JSON.parse(await readFile(settingsFile, "utf8")) as {
				hooks?: Record<string, { hooks: { command: string }[] }[]>;
			})
		: {};
	const command = `node ${JSON.stringify(hookTarget)}`;
	let changed = false;

	settings.hooks ??= {};
	for (const event of [
		"SessionStart",
		"SessionEnd",
		"StopFailure",
		"TaskCompleted",
	]) {
		const entries = (settings.hooks[event] ??= []);

		if (
			!entries.some((entry) =>
				entry.hooks?.some((hook) =>
					hook.command.includes("panini-hook.mjs"),
				),
			)
		) {
			entries.push({
				hooks: [{ type: "command", command, timeout: 5 } as never],
			});
			changed = true;
		}
	}
	if (!changed) return "already installed";
	await mkdir(dirname(settingsFile), { recursive: true });
	if (existsSync(settingsFile))
		await copyFile(settingsFile, `${settingsFile}.panini-backup`);
	await writeFile(settingsFile, JSON.stringify(settings, null, 2));
	return `added to ${settingsFile} (backup beside it)`;
}

async function identity(mcpUrl: string, token: string) {
	const response = await fetch(mcpUrl, {
		method: "POST",
		headers: {
			authorization: `Bearer ${token}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2025-03-26",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "identity_get", arguments: {} },
		}),
	});
	const text = await response.text();
	const line =
		text
			.split("\n")
			.find((item) => item.startsWith("data: "))
			?.slice(6) ?? text;

	return (JSON.parse(line) as { result?: { content?: { text: string }[] } })
		.result?.content?.[0]?.text;
}

async function main() {
	const url = (flag("--url") ?? "http://127.0.0.1:4141").replace(/\/$/, "");
	const harness = detectHarness();
	const repository = detectRepository();
	const started = await post(`${url}/api/connect/start`, {
		harness,
		...(repository ? { repository } : {}),
		hostname: hostname().slice(0, 120),
	});

	console.log(
		`Connecting ${harness.replaceAll("_", " ")}${repository ? ` for ${repository}` : ""}.`,
	);
	console.log(`Approve in your browser and check the code: ${started.code}`);
	console.log(String(started.approveUrl));
	openBrowser(String(started.approveUrl));

	const deadline = Date.now() + Number(started.expiresInSeconds) * 1000;
	let approved: Record<string, unknown> | null = null;

	while (Date.now() < deadline) {
		await new Promise((done) => setTimeout(done, 2_000));

		const result = await post(`${url}/api/connect/poll`, {
			requestId: started.requestId,
			pollToken: started.pollToken,
		});

		if (result.state === "approved") {
			approved = result;
			break;
		}
		if (result.state === "denied" || result.state === "expired")
			throw new Error(`The connect request was ${String(result.state)}.`);
	}
	if (!approved) throw new Error("The connect request expired.");

	const token = String(approved.secret);
	const mcpUrl = String(approved.mcpUrl);
	const saved = join(pantry, "agent.json");
	// On macOS the token lives in the login keychain; elsewhere in a file only you can read.
	const inKeychain =
		process.platform === "darwin" &&
		!process.argv.includes("--no-keychain") &&
		saveToKeychain(url, token);

	await mkdir(pantry, { recursive: true, mode: 0o700 });
	await writeFile(
		saved,
		JSON.stringify(
			{
				url,
				...(inKeychain ? { tokenStore: "keychain" } : { token }),
				profileId: approved.profileId,
				profileName: approved.profileName,
				harness,
			},
			null,
			2,
		),
		{ mode: 0o600 },
	);
	await chmod(saved, 0o600);
	console.log(
		inKeychain
			? `Saved the token in your macOS keychain (service work.panini.agent) and the connection to ${saved}.`
			: `Saved the connection to ${saved} (readable only by you).`,
	);

	if (harness === "claude_code" && has("claude")) {
		const helpers = await installClaudeHelpers();
		// The MCP entry runs a helper that reads the token at request time; no secret is written to ~/.claude.json.
		const entry = JSON.stringify({
			type: "http",
			url: mcpUrl,
			headersHelper: `node ${JSON.stringify(helpers.headers)}`,
		});

		spawnSync("claude", ["mcp", "remove", "panini", "-s", "user"], {
			stdio: "ignore",
		});

		const added = spawnSync(
			"claude",
			["mcp", "add-json", "--scope", "user", "panini", entry],
			{ stdio: ["ignore", "ignore", "pipe"], encoding: "utf8" },
		);

		console.log(
			added.status === 0
				? "Registered the Panini MCP server in Claude Code (user scope)."
				: `Could not register with Claude Code: ${added.stderr.trim()}`,
		);
		console.log(`Session hooks: ${helpers.hooks}.`);
	} else if (harness === "codex" && has("codex")) {
		console.log("Add Panini to Codex with:");
		console.log(
			inKeychain
				? "  export PANINI_AGENT_TOKEN=$(security find-generic-password -s work.panini.agent -a " +
						url +
						" -w)"
				: `  export PANINI_AGENT_TOKEN=$(node -e 'console.log(require(${JSON.stringify(saved)}).token)')`,
		);
		console.log(
			`  codex mcp add panini --url ${mcpUrl} --bearer-token-env-var PANINI_AGENT_TOKEN`,
		);
	} else {
		console.log(
			`Point your MCP client at ${mcpUrl} with the header "Authorization: Bearer <token from ${saved}>".`,
		);
	}

	const who = await identity(mcpUrl, token).catch(() => null);

	if (who)
		console.log(
			`\nConnected. Panini sees this agent as:\n${who.slice(0, 1200)}`,
		);
}

await main().catch((error: unknown) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
