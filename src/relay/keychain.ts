import { spawn } from "node:child_process";
import { z } from "zod";

const relaySecretsSchema = z
	.object({
		privateKeyPem: z.string().min(1),
		outboxEncryptionKey: z.string().min(1),
	})
	.strict();

export type RelaySecrets = z.infer<typeof relaySecretsSchema>;

export interface KeychainRunner {
	(args: string[], standardInput?: string): Promise<{ stdout: string }>;
}

async function macOsSecurity(
	args: string[],
	standardInput?: string,
): Promise<{ stdout: string }> {
	return new Promise((resolve, reject) => {
		// `security add-generic-password -w` reads from a terminal, not a plain
		// pipe. macOS ships `script`, which supplies that terminal while keeping
		// the password in stdin and out of both command lines.
		const program = standardInput === undefined ? "security" : "script";
		const commandArgs =
			standardInput === undefined
				? args
				: ["-q", "/dev/null", "security", ...args];
		const child = spawn(program, commandArgs, {
			stdio: ["pipe", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;

		const collect = (target: Buffer[], chunk: Buffer) => {
			outputBytes += chunk.length;
			if (outputBytes > 1_000_000) {
				child.kill();
				reject(
					new Error(
						"The macOS security command exceeded its output limit.",
					),
				);
				return;
			}
			target.push(chunk);
		};

		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0)
				return resolve({
					stdout: Buffer.concat(stdout).toString("utf8"),
				});
			reject(
				new Error(
					`The macOS security command failed (${code ?? "signal"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
				),
			);
		});
		child.stdin.end(standardInput);
	});
}

/** Stores relay signing and outbox keys in the user's macOS login keychain. */
export class RelayKeychain {
	constructor(
		private readonly service = "work.panini.relay",
		private readonly runner: KeychainRunner = macOsSecurity,
		private readonly platform = process.platform,
	) {}

	async set(account: string, secrets: RelaySecrets): Promise<void> {
		this.requireMacOs();

		const value = JSON.stringify(relaySecretsSchema.parse(secrets));

		// With -w at the end, `security` prompts on the pseudo-terminal supplied by
		// the runner. Keeping the JSON in stdin prevents relay keys from appearing
		// in process listings.
		await this.runner(
			[
				"add-generic-password",
				"-a",
				account,
				"-s",
				this.service,
				"-U",
				"-w",
			],
			`${value}\n`,
		);
	}

	async get(account: string): Promise<RelaySecrets> {
		this.requireMacOs();

		const result = await this.runner([
			"find-generic-password",
			"-a",
			account,
			"-s",
			this.service,
			"-w",
		]);

		return relaySecretsSchema.parse(JSON.parse(result.stdout.trim()));
	}

	async delete(account: string): Promise<void> {
		this.requireMacOs();
		await this.runner([
			"delete-generic-password",
			"-a",
			account,
			"-s",
			this.service,
		]);
	}

	private requireMacOs(): void {
		if (this.platform !== "darwin") {
			throw new Error(
				"The packaged relay keychain adapter currently supports macOS only; no file-backed secret fallback is permitted.",
			);
		}
	}
}
