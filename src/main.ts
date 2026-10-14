import { buildHttpServer } from "./http/server.js";
import { OutboxQueue } from "./outbox/runtime.js";
import { ReplayVerifier } from "./replay/verifier.js";
import { createPaniniCore } from "./runtime/core.js";
import { IdentityService } from "./security/identity.js";
import { z } from "zod";
import { evidencePipelineMode } from "./config.js";

const { config, store, ledger, intelligence, adjudicator, proposalClassifier, embedding } = await createPaniniCore();
const evidenceV2Enabled = evidencePipelineMode(config.app) !== "legacy";
const observationAgentEnabled = evidencePipelineMode(config.app) === "agent";
if (!observationAgentEnabled && (config.app.intelligence.evidenceV2.autoApplyClasses.includes("task_terminal")
  || (evidencePipelineMode(config.app) === "apply"
    && config.app.intelligence.evidenceV2.autoApplyClasses.length > 0
    && config.app.intelligence.evidenceV2.authorityPolicies.length === 0))) {
  throw new Error("Automatic evidence application requires an explicit nonterminal authority policy; terminal application remains disabled.");
}
if (evidenceV2Enabled && !observationAgentEnabled
  && (config.app.policy.mode !== "manual_review" || config.app.policy.autoApproveNewTasks
    || config.app.policy.autoApproveContext || !config.app.policy.requireReviewForTaskChanges
    || config.intelligenceModel !== "gpt-6-luna" || !config.intelligenceApiKey
    || config.retrievalProvider !== "postgres" || config.embeddingProvider !== "disabled"
    || !config.jevWorkAllowedVisibilities.length
    || !(process.env.PANINI_EVIDENCE_V2_VERSION ?? config.app.intelligence.evidenceV2.pipelineVersion)
    || !z.uuid().safeParse(process.env.PANINI_EVIDENCE_V2_BUDGET_ID).success)) {
  throw new Error("Evidence v2 requires an explicit budget, version, pinned model, source access, local retrieval, and manual review policy.");
}
if (evidenceV2Enabled && !observationAgentEnabled) {
  const budget = await store.getInferenceBudget(process.env.PANINI_EVIDENCE_V2_BUDGET_ID!);
  if (!budget || budget.state !== "active" || Date.parse(budget.deadline) <= Date.now()
    || budget.spentCalls >= budget.maxCalls) {
    throw new Error("Evidence v2 budget is missing, expired, or exhausted.");
  }
}
const identity = config.databaseUrl ? new IdentityService(config.databaseUrl) : undefined;
if ((config.app.github?.enabled || config.githubApp) && !config.githubWebhookSecret) {
  throw new Error("GITHUB_WEBHOOK_SECRET is required when the GitHub connector is enabled.");
}

if (config.app.github?.enabled && !config.githubApp) {
  await ledger.configureInstallation({
    provider: "github",
    installationKey: config.app.github.installationKey,
    displayName: "GitHub",
    transport: "webhook",
    config: { repositories: config.app.github.repositories },
  }, "system:startup");
}

const app = await buildHttpServer({
  ledger,
  config,
  intelligence,
  adjudicator,
  proposalClassifier: evidenceV2Enabled ? null : proposalClassifier,
  jobs: new OutboxQueue(store),
  replay: new ReplayVerifier(store),
  ...(identity ? { identity } : {}),
});
if (!config.databaseUrl) app.log.warn("DATABASE_URL is unset. Data will be held in memory and lost on restart.");
if (!config.adminToken) app.log.warn("APP_ADMIN_TOKEN is unset. API routes are unprotected; MCP still requires an active agent enrollment secret.");
if (config.app.intelligence.enabled && !intelligence.isConfigured()) {
  app.log.warn("Legacy LLM interpretation is not wired while Jev decisions are evaluated in shadow mode.");
}
if (config.app.adjudication.enabled && !adjudicator.isConfigured()) {
  app.log.warn("Legacy LLM adjudication is not wired; proposals require review.");
}

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
