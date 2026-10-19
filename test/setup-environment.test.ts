import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import {
	configureSlack,
	environmentDoctor,
	initializeEnvironment,
} from "../src/setup/environment.js";

describe("Panini setup", () => {
	it("writes private secrets once and preserves them on repeat initialization", async () => {
		const directory = await mkdtemp(join(tmpdir(), "panini-setup-"));
		const first = await initializeEnvironment(".env", directory);

		expect(first.generated).toEqual([
			"CONTENT_ENCRYPTION_KEY",
			"APP_ADMIN_TOKEN",
		]);

		const firstContents = await readFile(join(directory, ".env"), "utf8");

		expect(firstContents).toMatch(/CONTENT_ENCRYPTION_KEY=\S+/);
		expect(firstContents).toMatch(/APP_ADMIN_TOKEN=panini_admin_\S+/);
		expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);

		const second = await initializeEnvironment(".env", directory);

		expect(second.generated).toEqual([]);
		expect(await readFile(join(directory, ".env"), "utf8")).toBe(
			firstContents,
		);
		expect(await environmentDoctor(".env", directory)).toMatchObject({
			checks: {
				contentEncryptionKey: true,
				adminToken: true,
				databaseUrl: false,
			},
		});
	});

	it("stores Slack tokens without returning them and enables only explicit public channels", async () => {
		const directory = await mkdtemp(join(tmpdir(), "panini-slack-"));

		await mkdir(join(directory, "config"));
		await writeFile(
			join(directory, ".env"),
			"APP_CONFIG_PATH=./config/local.yaml\n",
			{ mode: 0o600 },
		);
		await writeFile(
			join(directory, "config/local.yaml"),
			"company:\n  name: Test\n",
			"utf8",
		);

		const result = await configureSlack(
			{
				appToken: "xapp-test-app-token",
				botToken: "xoxb-test-bot-token",
				channels: ["C012ABCDEF", "C012ABCDEF", "C034GHIJKL"],
				captureReactions: [":panini:", "bookmark"],
			},
			".env",
			directory,
		);

		expect(JSON.stringify(result)).not.toContain("test-app-token");
		expect(JSON.stringify(result)).not.toContain("test-bot-token");
		expect(result).toMatchObject({
			channelCount: 2,
			captureReactions: ["panini", "bookmark"],
		});
		expect(await readFile(join(directory, ".env"), "utf8")).toContain(
			"SLACK_APP_TOKEN=xapp-test-app-token",
		);
		expect((await stat(join(directory, ".env"))).mode & 0o777).toBe(0o600);
		expect(
			YAML.parse(
				await readFile(join(directory, "config/local.yaml"), "utf8"),
			),
		).toMatchObject({
			slack: {
				enabled: true,
				installationKey: "default",
				channels: ["C012ABCDEF", "C034GHIJKL"],
				captureReactions: ["panini", "bookmark"],
			},
		});
	});
});
