import { randomBytes } from "node:crypto";
import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import YAML from "yaml";

export interface SetupResult {
	path: string;
	generated: string[];
	alreadyConfigured: string[];
}

export interface SlackSetupResult {
	environmentFile: string;
	configFile: string;
	channelCount: number;
	captureMode: "reaction" | "all_messages";
	captureReactions: string[];
}

function valueOf(contents: string, key: string): string | null {
	const line = contents
		.split(/\r?\n/)
		.find((candidate) => candidate.startsWith(`${key}=`));

	return line ? line.slice(key.length + 1).trim() || null : null;
}

function setValue(contents: string, key: string, value: string): string {
	const lines = contents.split(/\r?\n/);
	const index = lines.findIndex((line) => line.startsWith(`${key}=`));

	if (index >= 0) lines[index] = `${key}=${value}`;
	else lines.push(`${key}=${value}`);
	return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

function checkoutPath(cwd: string, path: string, label: string): string {
	const target = resolve(cwd, path);
	const relation = relative(resolve(cwd), target);

	if (relation.startsWith(".."))
		throw new Error(`${label} must be inside the current Panini checkout.`);
	return target;
}

async function atomicWrite(
	target: string,
	contents: string,
	mode: number,
): Promise<void> {
	const temporary = resolve(
		dirname(target),
		`.panini-${process.pid}-${randomBytes(6).toString("hex")}.tmp`,
	);

	await writeFile(temporary, contents, {
		encoding: "utf8",
		mode,
		flag: "wx",
	});
	await chmod(temporary, mode);
	await rename(temporary, target);
}

export async function initializeEnvironment(
	path = ".env",
	cwd = process.cwd(),
): Promise<SetupResult> {
	const target = checkoutPath(cwd, path, "The environment file");
	let contents: string;

	try {
		contents = await readFile(target, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		contents = "NODE_ENV=development\nHOST=127.0.0.1\nPORT=4141\n";
	}

	const generated: string[] = [];
	const alreadyConfigured: string[] = [];
	const values: Record<string, () => string> = {
		CONTENT_ENCRYPTION_KEY: () => randomBytes(32).toString("base64"),
		APP_ADMIN_TOKEN: () =>
			`panini_admin_${randomBytes(32).toString("base64url")}`,
	};

	for (const [key, generate] of Object.entries(values)) {
		if (valueOf(contents, key)) {
			alreadyConfigured.push(key);
			continue;
		}
		contents = setValue(contents, key, generate());
		generated.push(key);
	}

	if (generated.length > 0 || !(await fileExists(target))) {
		await atomicWrite(target, contents, 0o600);
	} else {
		await chmod(target, 0o600);
	}
	return { path: target, generated, alreadyConfigured };
}

export async function configureSlack(
	input: {
		appToken: string;
		botToken: string;
		channels: string[];
		captureMode?: "reaction" | "all_messages";
		captureReactions?: string[];
	},
	envPath = ".env",
	cwd = process.cwd(),
): Promise<SlackSetupResult> {
	if (!input.appToken.startsWith("xapp-"))
		throw new Error("SLACK_APP_TOKEN must start with xapp-.");
	if (!input.botToken.startsWith("xoxb-"))
		throw new Error("SLACK_BOT_TOKEN must start with xoxb-.");
	if (input.appToken.includes("\n") || input.botToken.includes("\n"))
		throw new Error("Slack tokens cannot contain newlines.");

	const channels = [
		...new Set(
			input.channels.map((channel) => channel.trim()).filter(Boolean),
		),
	];

	if (
		channels.length === 0 ||
		channels.some((channel) => !/^C[A-Z0-9]+$/.test(channel))
	) {
		throw new Error(
			"Provide at least one public Slack channel ID such as C012ABCDEF.",
		);
	}

	const captureReactions = [
		...new Set(
			(input.captureReactions ?? ["panini", "bookmark"])
				.map((reaction) => reaction.trim().replace(/^:|:$/g, ""))
				.filter(Boolean),
		),
	];

	if (captureReactions.length === 0)
		throw new Error("Provide at least one capture reaction.");

	const captureMode = input.captureMode ?? "reaction";

	const environmentFile = checkoutPath(cwd, envPath, "The environment file");
	const existingEnvironment = await readFile(environmentFile, "utf8");
	let nextEnvironment = setValue(
		existingEnvironment,
		"SLACK_APP_TOKEN",
		input.appToken,
	);

	nextEnvironment = setValue(
		nextEnvironment,
		"SLACK_BOT_TOKEN",
		input.botToken,
	);

	const configuredPath =
		valueOf(nextEnvironment, "APP_CONFIG_PATH") ??
		"./config/panini.example.yaml";
	const configFile = checkoutPath(
		cwd,
		configuredPath,
		"The application config file",
	);
	const rawConfig = YAML.parse(await readFile(configFile, "utf8")) as Record<
		string,
		unknown
	>;

	rawConfig.slack = {
		enabled: true,
		installationKey: "default",
		channels,
		captureMode,
		captureReactions,
	};

	await atomicWrite(environmentFile, nextEnvironment, 0o600);
	await atomicWrite(
		configFile,
		YAML.stringify(rawConfig, { lineWidth: 0 }),
		0o600,
	);
	return {
		environmentFile,
		configFile,
		channelCount: channels.length,
		captureMode,
		captureReactions,
	};
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await readFile(path);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

export async function environmentDoctor(path = ".env", cwd = process.cwd()) {
	const target = resolve(cwd, path);
	const contents = await readFile(target, "utf8");

	return {
		path: target,
		node: process.versions.node,
		checks: {
			contentEncryptionKey: Boolean(
				valueOf(contents, "CONTENT_ENCRYPTION_KEY"),
			),
			adminToken: Boolean(valueOf(contents, "APP_ADMIN_TOKEN")),
			databaseUrl: Boolean(valueOf(contents, "DATABASE_URL")),
			appConfigPath:
				valueOf(contents, "APP_CONFIG_PATH") ??
				"./config/panini.example.yaml",
		},
	};
}
