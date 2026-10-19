#!/usr/bin/env node
import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { RelayKeychain } from "./keychain.js";
import { RelayOutbox } from "./outbox.js";
import { workReportSchema } from "./protocol.js";

const relayConfigSchema = z
	.object({
		version: z.literal("panini-relay-config-v1"),
		serverUrl: z
			.string()
			.url()
			.refine(
				(value) =>
					value.startsWith("http://") || value.startsWith("https://"),
				"Server URL must use HTTP or HTTPS.",
			),
		deviceId: z.string().uuid().nullable(),
		publicKeyPem: z.string().min(1),
		keychainAccount: z.string().min(1),
		outboxPath: z.string().min(1),
		paused: z.boolean(),
	})
	.strict();

type RelayConfig = z.infer<typeof relayConfigSchema>;

function defaultConfigPath(): string {
	return (
		process.env.PANINI_RELAY_CONFIG ??
		join(homedir(), ".config", "panini", "relay.json")
	);
}

function option(args: string[], name: string): string | null {
	const index = args.indexOf(name);

	return index >= 0 ? (args[index + 1] ?? null) : null;
}

async function loadConfig(path: string): Promise<RelayConfig> {
	return relayConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

async function saveConfig(path: string, config: RelayConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await writeFile(path, `${JSON.stringify(config, null, 2)}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	await chmod(path, 0o600);
}

function accountFor(path: string): string {
	return `relay-${createHash("sha256").update(resolve(path)).digest("hex").slice(0, 16)}`;
}

function output(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function readStandardInput(): Promise<string> {
	const chunks: Buffer[] = [];

	for await (const chunk of process.stdin)
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks).toString("utf8");
}

async function initialize(
	args: string[],
	configPath: string,
	keychain: RelayKeychain,
): Promise<void> {
	const serverUrl = option(args, "--server");

	if (!serverUrl)
		throw new Error("init requires --server https://panini.example.");

	const { privateKey, publicKey } = generateKeyPairSync("ed25519");
	const keychainAccount = accountFor(configPath);

	await keychain.set(keychainAccount, {
		privateKeyPem: privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString(),
		outboxEncryptionKey: randomBytes(32).toString("base64"),
	});

	const config = relayConfigSchema.parse({
		version: "panini-relay-config-v1",
		serverUrl: serverUrl.replace(/\/$/, ""),
		deviceId: null,
		publicKeyPem: publicKey
			.export({ type: "spki", format: "pem" })
			.toString(),
		keychainAccount,
		outboxPath: resolve(dirname(configPath), "relay-outbox.sqlite"),
		paused: false,
	});

	await saveConfig(configPath, config);
	output({
		initialized: true,
		configPath,
		publicKeyPem: config.publicKeyPem,
		next: "Enroll this public key in Panini, then run panini-relay enroll --device-id DEVICE_UUID.",
	});
}

async function enroll(args: string[], configPath: string): Promise<void> {
	const deviceId = option(args, "--device-id");

	if (!deviceId) throw new Error("enroll requires --device-id DEVICE_UUID.");

	const config = await loadConfig(configPath);
	const updated = relayConfigSchema.parse({ ...config, deviceId });

	await saveConfig(configPath, updated);
	output({
		enrolled: true,
		deviceId: updated.deviceId,
		serverUrl: updated.serverUrl,
	});
}

async function enqueueReport(
	args: string[],
	configPath: string,
	keychain: RelayKeychain,
): Promise<void> {
	const reportPath = option(args, "--report");

	if (!reportPath)
		throw new Error(
			"enqueue requires --report PATH or --report - for stdin.",
		);

	const config = await loadConfig(configPath);

	if (!config.deviceId)
		throw new Error(
			"The relay is not enrolled. Run panini-relay enroll first.",
		);

	const secrets = await keychain.get(config.keychainAccount);
	const reportText =
		reportPath === "-"
			? await readStandardInput()
			: await readFile(resolve(reportPath), "utf8");
	const report = workReportSchema.parse(JSON.parse(reportText));
	const outbox = new RelayOutbox(
		config.outboxPath,
		secrets.outboxEncryptionKey,
	);

	try {
		output(outbox.enqueue(config.deviceId, report, secrets.privateKeyPem));
	} finally {
		outbox.close();
	}
}

async function flush(
	configPath: string,
	keychain: RelayKeychain,
): Promise<void> {
	const config = await loadConfig(configPath);

	if (config.paused)
		throw new Error(
			"The relay is paused. Run panini-relay resume before delivery.",
		);

	const secrets = await keychain.get(config.keychainAccount);
	const outbox = new RelayOutbox(
		config.outboxPath,
		secrets.outboxEncryptionKey,
	);

	try {
		const result = await outbox.flush(async (delivery) => {
			const response = await fetch(
				`${config.serverUrl}/api/relay/work-reports`,
				{
					method: "POST",
					headers: {
						"content-type": "application/json",
						"x-panini-signature": delivery.signature,
					},
					body: new Uint8Array(delivery.body),
				},
			);
			const message = (await response.text()).slice(0, 2_000);

			return {
				accepted: response.ok,
				retryable:
					response.status === 408 ||
					response.status === 425 ||
					response.status === 429 ||
					response.status >= 500,
				message,
			};
		});

		output({
			...result,
			pending: outbox.count("pending"),
			failed: outbox.count("failed"),
		});
	} finally {
		outbox.close();
	}
}

async function setPaused(configPath: string, paused: boolean): Promise<void> {
	const config = await loadConfig(configPath);

	await saveConfig(configPath, { ...config, paused });
	output({ paused });
}

async function status(
	configPath: string,
	keychain: RelayKeychain,
): Promise<void> {
	const config = await loadConfig(configPath);
	const secrets = await keychain.get(config.keychainAccount);
	const outbox = new RelayOutbox(
		config.outboxPath,
		secrets.outboxEncryptionKey,
	);

	try {
		output({
			serverUrl: config.serverUrl,
			deviceId: config.deviceId,
			enrolled: Boolean(config.deviceId),
			paused: config.paused,
			pending: outbox.count("pending"),
			delivered: outbox.count("delivered"),
			failed: outbox.count("failed"),
			privateKeyStoredInKeychain: true,
		});
	} finally {
		outbox.close();
	}
}

export async function runRelayCli(
	args = process.argv.slice(2),
	keychain = new RelayKeychain(),
): Promise<void> {
	const command = args[0];
	const configPath = resolve(option(args, "--config") ?? defaultConfigPath());

	if (command === "init") return initialize(args, configPath, keychain);
	if (command === "enroll") return enroll(args, configPath);
	if (command === "enqueue") return enqueueReport(args, configPath, keychain);
	if (command === "flush") return flush(configPath, keychain);
	if (command === "pause") return setPaused(configPath, true);
	if (command === "resume") return setPaused(configPath, false);
	if (command === "status") return status(configPath, keychain);
	throw new Error(
		"Usage: panini-relay <init|enroll|enqueue|flush|pause|resume|status> [options]",
	);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
	await runRelayCli().catch((error) => {
		process.stderr.write(
			`${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exitCode = 1;
	});
}
