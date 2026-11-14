#!/usr/bin/env node
import { cp, mkdir, readFile, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(
	await readFile(join(packageRoot, "package.json"), "utf8"),
);

const selfhostCommands = new Set([
	"init",
	"doctor",
	"start",
	"stop",
	"backup",
	"restore",
	"update",
	"recover",
]);
const command = process.argv[2];

if (command === "selfhost") process.argv.splice(2, 1);
if (["--help", "-h", "help"].includes(command)) {
	console.log(`Panini ${manifest.version}: memory and a work ledger for your agents.

Usage:
  npx panini-work                 Start Panini with a demo company (no Docker, no API key)
  npx panini-work --empty         Start with no demo data
  npx panini-work connect --url <url>
                                  Connect Claude Code or another agent
  npx panini-work selfhost init   Set up a Docker self-hosted install

Options for start:
  --port <port>                   Web port (default 4141)
  --directory <dir>               Where data is kept (default ./.panini/quickstart)
  --database-url <url>            Use an existing PostgreSQL instead of the embedded one

  --version                       Print the version`);
} else if (["--version", "-v"].includes(command)) {
	console.log(manifest.version);
} else if (command === "connect") {
	process.argv.splice(2, 1);
	await import(
		pathToFileURL(
			join(packageRoot, "dist", "src", "quickstart", "connect.js"),
		).href
	);
} else if (
	command === undefined ||
	command === "up" ||
	command.startsWith("--")
) {
	// Quickstart: embedded PostgreSQL, a demo company, no Docker and no API key.
	if (command === "up") process.argv.splice(2, 1);
	await import(
		pathToFileURL(join(packageRoot, "dist", "src", "quickstart", "cli.js"))
			.href
	);
} else if (!selfhostCommands.has(process.argv[2])) {
	console.error(
		`Unknown command ${command}. Use: panini, panini connect, or panini selfhost <init|doctor|start|stop|backup|restore|update|recover>.`,
	);
	process.exitCode = 2;
} else {
	const index = process.argv.indexOf("--directory");

	if (index !== -1 && !process.argv[index + 1])
		throw new Error("--directory requires a path.");

	const directory = resolve(
		index === -1 ? process.cwd() : process.argv[index + 1],
	);
	const releaseParent = join(directory, ".panini", "releases");
	const release = join(releaseParent, manifest.version);
	let installed = false;

	try {
		await stat(join(release, "pnpm-lock.yaml"));
		await stat(join(release, "scripts", "selfhost.mjs"));
		installed = true;
	} catch {
		/* The release has not been staged yet. */
	}
	if (!installed) {
		await mkdir(releaseParent, { recursive: true, mode: 0o700 });

		const staging = join(
			releaseParent,
			"." + manifest.version + "-" + randomUUID(),
		);

		await mkdir(staging, { mode: 0o700 });
		for (const name of [
			"Dockerfile",
			"compose.yaml",
			"compose.https.yaml",
			"package.json",
			"pnpm-workspace.yaml",
			"tsconfig.json",
			"tsconfig.build.json",
			"tsconfig.client.json",
			"src",
			"drizzle",
			"public",
			"integrations",
			"config",
			"scripts",
		])
			await cp(join(packageRoot, name), join(staging, name), {
				recursive: true,
			});
		await cp(
			join(packageRoot, "package-assets", "pnpm-lock.yaml"),
			join(staging, "pnpm-lock.yaml"),
		);
		try {
			await rename(staging, release);
		} catch (error) {
			if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY")
				throw error;
		}
	}
	if (index === -1) process.argv.push("--directory", directory);
	if (!process.argv.includes("--project"))
		process.argv.push("--project", "panini");
	process.env.PANINI_CLI_MODE = "package";
	await import(pathToFileURL(join(release, "scripts", "selfhost.mjs")).href);
}
