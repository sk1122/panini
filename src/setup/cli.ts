import {
	configureSlack,
	environmentDoctor,
	initializeEnvironment,
} from "./environment.js";

function argument(name: string): string | null {
	const index = process.argv.indexOf(name);

	if (index >= 0) return process.argv[index + 1] ?? null;

	const inline = process.argv.find((value) => value.startsWith(`${name}=`));

	return inline ? inline.slice(name.length + 1) : null;
}

const command = process.argv[2] ?? "doctor";
const envFile = argument("--env-file") ?? ".env";

if (command === "init") {
	const result = await initializeEnvironment(envFile);

	console.log(
		JSON.stringify(
			{
				ok: true,
				environmentFile: result.path,
				generated: result.generated,
				preserved: result.alreadyConfigured,
				note: "Secret values were written with mode 0600 and were not printed.",
			},
			null,
			2,
		),
	);
} else if (command === "doctor") {
	const result = await environmentDoctor(envFile);
	const ok =
		result.checks.contentEncryptionKey &&
		result.checks.adminToken &&
		result.checks.databaseUrl;

	console.log(JSON.stringify({ ok, ...result }, null, 2));
	if (!ok) process.exitCode = 1;
} else if (command === "slack") {
	const channels = (argument("--channels") ?? "").split(",");
	const captureMode = argument("--capture-mode") ?? "reaction";

	if (captureMode !== "reaction" && captureMode !== "all_messages") {
		throw new Error("--capture-mode must be reaction or all_messages.");
	}

	const captureReactions = (
		argument("--reactions") ?? "panini,bookmark"
	).split(",");
	const appToken = process.env.SLACK_APP_TOKEN ?? "";
	const botToken = process.env.SLACK_BOT_TOKEN ?? "";

	if (!appToken || !botToken) {
		throw new Error(
			"Set SLACK_APP_TOKEN and SLACK_BOT_TOKEN in the command environment; token values are never accepted as CLI arguments or printed.",
		);
	}

	const result = await configureSlack(
		{ appToken, botToken, channels, captureMode, captureReactions },
		envFile,
	);

	console.log(
		JSON.stringify(
			{
				ok: true,
				...result,
				note: "Slack credentials were stored privately and were not printed. Restart Panini to connect.",
			},
			null,
			2,
		),
	);
} else {
	throw new Error(
		"Usage: panini-setup <init|doctor|slack> [--env-file .env] [--channels C012ABCDEF,C034GHIJKL] [--capture-mode reaction|all_messages] [--reactions panini,bookmark]",
	);
}
