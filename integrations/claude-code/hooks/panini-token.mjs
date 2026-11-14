import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const KEYCHAIN_SERVICE = "work.panini.agent";

/**
 * The agent's Panini connection. The token comes from PANINI_AGENT_TOKEN, the
 * macOS login keychain, or (on other systems) ~/.panini/agent.json, in that order.
 */
export function pantryConnection() {
	let saved = {};

	try {
		saved = JSON.parse(
			readFileSync(join(homedir(), ".panini", "agent.json"), "utf8"),
		);
	} catch {
		/* Not connected yet. */
	}

	const url = process.env.PANINI_URL || saved.url;

	if (!url) return null;
	if (process.env.PANINI_AGENT_TOKEN)
		return { url, token: process.env.PANINI_AGENT_TOKEN };
	if (saved.token) return { url, token: saved.token };
	if (saved.tokenStore === "keychain" && process.platform === "darwin") {
		const found = spawnSync(
			"security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", url, "-w"],
			{
				encoding: "utf8",
				timeout: 3_000,
				stdio: ["ignore", "pipe", "ignore"],
			},
		);

		if (found.status === 0 && found.stdout.trim())
			return { url, token: found.stdout.trim() };
	}
	return null;
}
