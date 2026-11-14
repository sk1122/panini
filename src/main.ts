import { buildHttpServer } from "./http/server.js";
import { OutboxQueue } from "./outbox/runtime.js";
import { ReplayVerifier } from "./replay/verifier.js";
import { createPaniniCore } from "./runtime/core.js";
import { IdentityService } from "./security/identity.js";
import { evidencePipelineMode } from "./config.js";

const { config, store, ledger, embedding } = await createPaniniCore();

if (
	config.app.intelligence.enabled &&
	evidencePipelineMode(config.app) !== "agent"
)
	throw new Error(
		`Evidence mode "${evidencePipelineMode(config.app)}" was removed. Use intelligence.evidenceV2.mode: agent.`,
	);

const identity = config.databaseUrl
	? new IdentityService(config.databaseUrl)
	: undefined;

if (
	(config.app.github?.enabled || config.githubApp) &&
	!config.githubWebhookSecret
) {
	throw new Error(
		"GITHUB_WEBHOOK_SECRET is required when the GitHub connector is enabled.",
	);
}

if (config.app.github?.enabled && !config.githubApp) {
	await ledger.configureInstallation(
		{
			provider: "github",
			installationKey: config.app.github.installationKey,
			displayName: "GitHub",
			transport: "webhook",
			config: { repositories: config.app.github.repositories },
		},
		"system:startup",
	);
}

const app = await buildHttpServer({
	ledger,
	config,
	jobs: new OutboxQueue(store),
	replay: new ReplayVerifier(store),
	...(identity ? { identity } : {}),
});

if (!config.adminToken)
	app.log.warn(
		"APP_ADMIN_TOKEN is unset. API routes are unprotected; MCP still requires an active agent enrollment secret.",
	);

await app.listen({ host: config.host, port: config.port });

const shutdown = async (signal: string) => {
	app.log.info({ signal }, "Shutting down.");
	await app.close();
	await identity?.close();
	await embedding?.index.close();
	await store.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
