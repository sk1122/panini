#!/usr/bin/env node
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, readFile, chmod, mkdir, stat } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

// No shell sourcing, interpolation or secret values in output. Requires Node >=22 and Compose v2.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const command = args[0] ?? "help";

const option = (name, fallback) => {
	const i = args.indexOf(name);

	return i === -1 ? fallback : args[i + 1];
};

const directory = resolve(option("--directory", root));
const envFile = resolve(directory, ".env");
const composeFile = resolve(root, option("--compose-file", "compose.yaml"));
const compose = ["compose", "--env-file", envFile, "-f", composeFile];

if (args.includes("--https"))
	compose.push("-f", resolve(root, "compose.https.yaml"));

const project = option("--project");

if (project) compose.push("-p", project);

const run = (program, argv, options = {}) =>
	new Promise((accept, reject) => {
		const child = spawn(program, argv, {
			cwd: root,
			stdio: "inherit",
			...options,
		});
		let output = "";

		if (child.stdout && options.capture)
			child.stdout.on("data", (chunk) => {
				output += chunk;
			});
		child.on("error", reject);
		child.on("close", (code) =>
			code === 0
				? accept(output.trim())
				: reject(new Error(`${program} failed (exit ${code}).`)),
		);
	});

const docker = (...values) => run("docker", [...compose, ...values]);

const db = (script, options = {}) =>
	run(
		"docker",
		[...compose, "exec", "-T", "postgres", "sh", "-c", script],
		options,
	);

const readEnvironment = async () => parseEnv(await readFile(envFile, "utf8"));

function origin(value) {
	const url = new URL(value);

	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(
				url.protocol === "http:" &&
				["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
			))
	) {
		throw new Error(
			"Use an HTTPS origin; HTTP is allowed only on loopback.",
		);
	}
	return url.origin;
}

async function backup(file) {
	const target = resolve(file);

	await mkdir(dirname(target), { recursive: true, mode: 0o700 });

	const handle = await open(target, "wx", 0o600);

	try {
		await db(
			'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --no-acl',
			{ stdio: ["ignore", handle.fd, "inherit"] },
		);
		await handle.sync();
	} catch (error) {
		throw new Error(
			`Backup failed; ${target} may be incomplete. Do not restore it.`,
			{ cause: error },
		);
	} finally {
		await handle.close();
	}
	console.log(
		`Database saved privately to ${target}. Back up .env and custom config separately in encrypted storage; the encryption key is required to recover evidence.`,
	);
}

try {
	if (command === "init") {
		const url = origin(option("--url", "http://127.0.0.1:4141"));

		await mkdir(directory, { recursive: true, mode: 0o700 });

		let existing;

		try {
			existing = await readEnvironment();
		} catch (error) {
			if (error.code !== "ENOENT") throw error;
		}
		if (existing) {
			await chmod(envFile, 0o600);
			console.log(
				"Existing .env preserved. Set POSTGRES_PASSWORD to the existing database password and PANINI_PUBLIC_URL before upgrading; no secrets were replaced.",
			);
		} else {
			const password = randomBytes(32).toString("hex");
			const handle = await open(envFile, "wx", 0o600);

			try {
				await handle.writeFile(
					[
						"NODE_ENV=production",
						`PANINI_PUBLIC_URL=${url}`,
						"PANINI_TRUST_PROXY=false",
						`POSTGRES_PASSWORD=${password}`,
						"POSTGRES_PORT=55432",
						"PANINI_PORT=4141",
						`DATABASE_URL=postgres://team_ledger:${password}@127.0.0.1:55432/team_ledger`,
						`CONTENT_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`,
						`APP_ADMIN_TOKEN=panini_admin_${randomBytes(32).toString("base64url")}`,
						"APP_CONFIG_PATH=./config/panini.selfhost.yaml",
						"TEAM_LEDGER_CONTAINER_CONFIG_PATH=/app/config/panini.selfhost.yaml",
						"AUTO_MIGRATE=false",
						"RETRIEVAL_PROVIDER=postgres",
						"EMBEDDING_PROVIDER=disabled",
						"",
					].join("\n"),
				);
			} finally {
				await handle.close();
			}
			console.log(
				"Created private .env with new secrets. Store an encrypted off-host copy. Use APP_ADMIN_TOKEN from this file only to create the first owner.",
			);
		}
	} else if (command === "doctor") {
		const env = await readEnvironment();

		origin(env.PANINI_PUBLIC_URL);
		if (
			!env.POSTGRES_PASSWORD ||
			!/^[A-Za-z0-9_-]+$/.test(env.POSTGRES_PASSWORD)
		)
			throw new Error(
				"POSTGRES_PASSWORD must be set and URL-safe. Preserve the password of an existing database.",
			);
		if (
			!env.APP_ADMIN_TOKEN ||
			env.APP_ADMIN_TOKEN.length < 32 ||
			Buffer.from(env.CONTENT_ENCRYPTION_KEY ?? "", "base64").length !==
				32
		)
			throw new Error("Missing or invalid installation/encryption keys.");
		if (((await stat(envFile)).mode & 0o077) !== 0)
			throw new Error(".env must be private: chmod 600 .env");
		await docker("config", "--quiet");
		await docker("ps");
		console.log(
			"Configuration valid. Containers listed above; this does not prove external TLS, connectors or backups.",
		);
	} else if (command === "start") {
		await docker("up", "-d", "--build", "--wait", "--wait-timeout", "180");
		await docker("ps");
	} else if (command === "stop") {
		await docker("stop");
		console.log("Services stopped; containers and volumes preserved.");
	} else if (command === "backup") {
		if (!option("--file"))
			throw new Error("Provide --file /private/path/database.dump");
		await backup(option("--file"));
	} else if (command === "restore") {
		if (!option("--file"))
			throw new Error(
				"Provide a trusted --file backup. Restore runs SQL; never use an untrusted dump.",
			);

		const running = await run(
			"docker",
			[...compose, "ps", "--status", "running", "--services"],
			{ stdio: ["ignore", "pipe", "inherit"], capture: true },
		);

		if (
			running
				.split("\n")
				.some((service) => ["app", "worker"].includes(service))
		)
			throw new Error(
				"Stop app and worker before restore. Keep only PostgreSQL running.",
			);

		const tables = await db(
			'exec psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "SELECT count(*) FROM pg_tables WHERE schemaname NOT IN (\'pg_catalog\',\'information_schema\')"',
			{ stdio: ["ignore", "pipe", "inherit"], capture: true },
		);

		if (tables !== "0")
			throw new Error(
				"Restore refused: target database is not empty. Use a separate clean installation; nothing was deleted.",
			);

		const handle = await open(resolve(option("--file")), "r");

		try {
			await db(
				'exec pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction --exit-on-error --no-owner --no-acl',
				{ stdio: [handle.fd, "inherit", "inherit"] },
			);
		} finally {
			await handle.close();
		}
		console.log(
			"Restore completed. Confirm the original CONTENT_ENCRYPTION_KEY is installed, then start services and verify evidence.",
		);
	} else if (command === "update") {
		if (!option("--file"))
			throw new Error(
				"Update requires --file /private/path/pre-update.dump. Check out a reviewed release first.",
			);
		await docker("build"); // Fail before downtime if the new image does not build.
		await docker("stop", "app", "worker");
		await backup(option("--file"));
		await docker("run", "--rm", "migrate");
		await docker("up", "-d", "--wait", "--wait-timeout", "180");
		console.log(
			"Update started. Inspect health and logs. On failure services remain stopped; restore into a clean database, never downgrade schema in place.",
		);
	} else if (command === "recover") {
		const email = option("--email");

		if (!email || !email.includes("@"))
			throw new Error("Provide --email for an existing active account.");
		await docker(
			"run",
			"--rm",
			"--no-deps",
			"app",
			"node",
			"dist/src/setup/recover.js",
			email,
		);
	} else {
		const executable =
			process.env.PANINI_CLI_MODE === "package"
				? "panini"
				: "node scripts/selfhost.mjs";

		console.log(
			`Usage: ${executable} init|doctor|start|stop|backup|restore|update|recover [--directory /private/panini] [--url https://panini.example.com] [--https] [--file /private/path/backup.dump] [--email owner@example.com]`,
		);
	}
} catch (error) {
	console.error(error.message);
	process.exitCode = 1;
}
