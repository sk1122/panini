import { extractSessionDecisions } from "./decisions/from-session.js";
import {
	claudeFetcher,
	isClaudeModel,
} from "./intelligence/claude-responses.js";
import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import { ObservationAgent } from "./intelligence/observation-agent.js";
import { NotionClient } from "./connectors/notion/client.js";
import { NotionPoller } from "./connectors/notion/poller.js";
import {
	SlackCaptureAdapter,
	SlackWebApiClient,
} from "./connectors/slack/socket-mode.js";
import { syncSlackMemberDirectory } from "./connectors/slack/startup-sync.js";
import { SlackSocketSupervisor } from "./connectors/slack/supervisor.js";
import { projectionOutboxHandlers } from "./outbox/projection-handler.js";
import { OutboxDispatcher, OutboxQueue } from "./outbox/runtime.js";
import { createPaniniCore } from "./runtime/core.js";
import { ContextEmbeddingIndexer } from "./retrieval/context-embedding-indexer.js";
import { GithubAppClient } from "./connectors/github/app-client.js";
import { GithubRepositorySync } from "./connectors/github/sync.js";
import { EvidenceDiscoverySweep } from "./reconciliation/evidence-discovery.js";
import { priceBasisFor, settledCost } from "./intelligence/model-price.js";
import { BudgetedVoyageEmbeddings } from "./intelligence/voyage-work-embeddings.js";
import { meteredProviderFetch } from "./intelligence/external-call-meter.js";
import { evidencePipelineMode } from "./config.js";
import type { SourceEventInput } from "./domain/types.js";
import { runReconcile } from "./reconcile/runner.js";

/*
 * The worker runs connectors, the outbox, and the observation agent. The agent
 * reads new source observations once per reconcile interval (or at once with
 * PANINI_RECONCILE_MODE=live). Agent claims, reports and handoffs never wait for it.
 */

const workerConfigSchema = z.object({
	batchSize: z.coerce.number().int().min(1).max(500).default(50),
	leaseSeconds: z.coerce.number().int().min(10).max(3_600).default(60),
	pollIntervalMs: z.coerce.number().int().min(100).max(60_000).default(1_000),
	maxAttempts: z.coerce.number().int().min(1).max(100).default(8),
	retryBaseMs: z.coerce.number().int().min(100).max(60_000).default(1_000),
	retryMaximumMs: z.coerce
		.number()
		.int()
		.min(1_000)
		.max(86_400_000)
		.default(300_000),
});

const { config, store, ledger, log, embedding } = await createPaniniCore();

if (!config.databaseUrl) {
	throw new Error(
		"DATABASE_URL is required for the worker because jobs are shared with the server.",
	);
}

const workerConfig = workerConfigSchema.parse({
	batchSize: process.env.OUTBOX_BATCH_SIZE,
	leaseSeconds: process.env.OUTBOX_LEASE_SECONDS,
	pollIntervalMs: process.env.OUTBOX_POLL_INTERVAL_MS,
	maxAttempts: process.env.OUTBOX_MAX_ATTEMPTS,
	retryBaseMs: process.env.OUTBOX_RETRY_BASE_MS,
	retryMaximumMs: process.env.OUTBOX_RETRY_MAXIMUM_MS,
});
const workerId =
	process.env.PANINI_WORKER_ID || `worker:${hostname()}:${process.pid}`;
const recorder = {
	record: (input: SourceEventInput) => store.appendSourceEvent(input),
};
const evidenceMode = evidencePipelineMode(config.app);

if (config.app.intelligence.enabled && evidenceMode !== "agent")
	throw new Error(
		`Evidence mode "${evidenceMode}" was removed. Use intelligence.evidenceV2.mode: agent.`,
	);

const observationAgentEnabled = config.app.intelligence.enabled;
const evidenceBudgetId = process.env.PANINI_EVIDENCE_V2_BUDGET_ID;
const evidenceVersion =
	process.env.PANINI_EVIDENCE_V2_VERSION ??
	config.app.intelligence.evidenceV2.pipelineVersion;

if (
	observationAgentEnabled &&
	(!config.intelligenceApiKey ||
		!priceBasisFor(config.intelligenceModel ?? "") ||
		!evidenceBudgetId ||
		!z.uuid().safeParse(evidenceBudgetId).success ||
		!evidenceVersion ||
		!config.jevWorkAllowedVisibilities.length)
) {
	throw new Error(
		"The observation agent needs INTELLIGENCE_API_KEY, a model with known prices (gpt-6-luna, claude-haiku-5-5, or INTELLIGENCE_PRICE_INPUT_PER_MILLION and INTELLIGENCE_PRICE_OUTPUT_PER_MILLION), PANINI_EVIDENCE_V2_BUDGET_ID, PANINI_EVIDENCE_V2_VERSION and JEV_WORK_ALLOWED_VISIBILITIES.",
	);
}
if (observationAgentEnabled) {
	const budget = await store.getInferenceBudget(evidenceBudgetId!);

	if (
		!budget ||
		budget.state !== "active" ||
		Date.parse(budget.deadline) <= Date.now() ||
		budget.reservedCalls !== 0 ||
		budget.spentCalls >= budget.maxCalls
	) {
		throw new Error(
			"The inference budget is missing, expired, exhausted, or has unsettled calls.",
		);
	}
}

let notionPoller: NotionPoller | null = null;

if (config.app.notion.enabled) {
	if (!config.notionToken)
		throw new Error(
			"NOTION_TOKEN is required when the Notion connector is enabled.",
		);

	const installation = await ledger.configureInstallation(
		{
			provider: "notion",
			installationKey: "default",
			displayName: "Notion",
			transport: "poll",
			config: {
				roots: config.app.notion.sources.flatMap((source) =>
					source.resourceId ? [source.resourceId] : [],
				),
				workspaceDiscovery: config.app.notion.sources.some(
					(source) => source.kind === "workspace",
				),
				apiVersion: config.app.notion.apiVersion,
			},
		},
		"system:worker-startup",
	);

	notionPoller = new NotionPoller(
		new NotionClient({
			token: config.notionToken,
			apiVersion: config.app.notion.apiVersion,
			fetch: meteredProviderFetch(store, {
				provider: "notion",
				purpose: "source_ingestion",
			}),
		}),
		ledger,
		config.app.notion,
		log,
		installation.id,
	);
}

let slackSupervisor: SlackSocketSupervisor | null = null;
let slackAdapter: SlackCaptureAdapter | null = null;
let slackInstallationId: string | null = null;

if (config.app.slack?.enabled) {
	if (!config.slackAppToken || !config.slackBotToken) {
		throw new Error(
			"SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required when the Slack connector is enabled.",
		);
	}

	const installation = await ledger.configureInstallation(
		{
			provider: "slack",
			installationKey: config.app.slack.installationKey,
			displayName: "Slack",
			transport: "socket_mode",
			config: {
				channels: config.app.slack.channels,
				captureMode: config.app.slack.captureMode,
				captureReactions: config.app.slack.captureReactions,
			},
		},
		"system:worker-startup",
	);

	slackInstallationId = installation.id;
	slackAdapter = new SlackCaptureAdapter(
		config.app.slack,
		new SlackWebApiClient(
			config.slackBotToken,
			meteredProviderFetch(store, {
				provider: "slack",
				purpose: "source_ingestion",
			}),
		),
		recorder,
		ledger,
	);
	slackSupervisor = new SlackSocketSupervisor({
		appToken: config.slackAppToken,
		adapter: slackAdapter,
		ledger,
		installationId: installation.id,
		fetchImpl: meteredProviderFetch(store, {
			provider: "slack",
			purpose: "socket_open",
		}),
		acquireLease: () =>
			store.acquireSingletonLease(
				`connector:slack:${installation.id}`,
				workerId,
			),
		releaseLease: () =>
			store.releaseSingletonLease(
				`connector:slack:${installation.id}`,
				workerId,
			),
		log,
	});
}

const handlers = projectionOutboxHandlers(store);
const evidenceDispatchEpoch = `${evidenceVersion}:${evidenceBudgetId}`;
const evidenceDiscovery = observationAgentEnabled
	? new EvidenceDiscoverySweep(
			store,
			evidenceVersion!,
			config.app.intelligence.evidenceV2.sweepBatchSize,
			evidenceDispatchEpoch,
			config.app.intelligence.evidenceV2.noClaimSamplePercent,
		)
	: null;
const observationAgent = observationAgentEnabled
	? new ObservationAgent({
			workOntology: process.env.PANINI_WORK_ONTOLOGY !== "0",
			store,
			ledger,
			embeddings: new BudgetedVoyageEmbeddings({
				store,
				apiKey: config.openrouterApiKey ?? "",
				endpoint:
					config.openrouterEmbeddingEndpoint ??
					"https://openrouter.ai/api/v1/embeddings",
			}),
			apiKey: config.intelligenceApiKey!,
			model: config.intelligenceModel!,
			pipelineVersion: evidenceVersion,
			allowedVisibilities: config.jevWorkAllowedVisibilities,
			priceBasis: priceBasisFor(config.intelligenceModel!)!,
			baseUrl: config.intelligenceBaseUrl,
			// Claude models go through the Claude adapter (Messages API).
			...(isClaudeModel(config.intelligenceModel)
				? { fetcher: claudeFetcher(config.intelligenceApiKey!) }
				: {}),
			maxContextEvents:
				config.app.intelligence.evidenceV2.maxContextObservations,
			maxContextBytes: config.app.intelligence.evidenceV2.maxInputTokens,
		})
	: null;
const baseVisibilities = config.jevWorkAllowedVisibilities.length
	? config.jevWorkAllowedVisibilities
	: ["company"];
// One shared list, refreshed before each run, so the agent sees changes.
const allowedVisibilities = [...baseVisibilities];

/*
 * A source an admin connected from the app is one the run may read. Repositories
 * can change at any time, so their labels are read from the installations.
 */
async function refreshAllowedVisibilities() {
	const fromApp = Boolean((await store.connectorCredentials?.all())?.github);
	const repositories = fromApp
		? (await store.listSourceInstallations())
				.filter(
					(installation) =>
						installation.provider === "github" &&
						!["revoked", "disabled"].includes(installation.status),
				)
				.flatMap((installation) =>
					(
						(installation.config as { repositories?: string[] })
							.repositories ?? []
					).map((name) => `github:repository:${name.toLowerCase()}`),
				)
		: [];

	allowedVisibilities.splice(
		0,
		allowedVisibilities.length,
		...new Set([...baseVisibilities, ...repositories]),
	);
}

/*
 * The model for this run: the server's environment first, otherwise the
 * model and key an admin chose in the app. A workspace choice gets a monthly
 * spending cap (PANINI_MONTHLY_MODEL_BUDGET_USD, default 10).
 */
let workspaceAgent: { key: string; agent: ObservationAgent } | null = null;

async function currentObserver(): Promise<{
	agent: ObservationAgent;
	budgetId: string;
} | null> {
	if (observationAgent)
		return { agent: observationAgent, budgetId: evidenceBudgetId! };

	const settings = await store.modelSettings?.get();
	const price = settings && priceBasisFor(settings.model);

	if (!settings || !price) return null;

	const key = `${settings.model}:${settings.updatedAt}`;

	if (workspaceAgent?.key !== key)
		workspaceAgent = {
			key,
			agent: new ObservationAgent({
				workOntology: process.env.PANINI_WORK_ONTOLOGY !== "0",
				store,
				ledger,
				apiKey: settings.apiKey,
				model: settings.model,
				pipelineVersion: evidenceVersion,
				allowedVisibilities,
				priceBasis: price,
				...(isClaudeModel(settings.model)
					? { fetcher: claudeFetcher(settings.apiKey) }
					: {}),
				maxContextEvents:
					config.app.intelligence.evidenceV2.maxContextObservations,
				maxContextBytes:
					config.app.intelligence.evidenceV2.maxInputTokens,
			}),
		};

	let budget = settings.budgetId
		? await store.getInferenceBudget(settings.budgetId)
		: null;

	// A lost call suspends the budget. Charge it at its reserved maximum and keep
	// the same budget, so the monthly cap holds and interrupted work can resume.
	if (budget?.state === "suspended") {
		for (const call of await store.listUnknownModelCalls(budget.id))
			await store.reconcileUnknownModelCallAtReservedBound(call.id);
		budget = await store.getInferenceBudget(budget.id);
	}

	let budgetId = budget?.id ?? null;

	if (
		!budget ||
		budget.state !== "active" ||
		Date.parse(budget.deadline) <= Date.now() + 3_600_000 ||
		budget.spentCalls >= budget.maxCalls
	) {
		budgetId = (
			await store.createInferenceBudget({
				label: `nightly run ${new Date().toISOString().slice(0, 7)}`,
				maxCalls: 100_000,
				maxInputTokens: 2_000_000_000,
				maxOutputTokens: 50_000_000,
				maxUsd: process.env.PANINI_MONTHLY_MODEL_BUDGET_USD ?? "10",
				deadline: new Date(Date.now() + 30 * 86_400_000).toISOString(),
				priceBasis: null,
			})
		).id;
		await store.modelSettings!.setBudget(budgetId);
	}
	return { agent: workspaceAgent.agent, budgetId: budgetId! };
}

// Spec 15.2: the model runs as a scheduled reconcile, not per message.
const reconcileMode =
	process.env.PANINI_RECONCILE_MODE === "live" ? "live" : "scheduled";
const reconcileIntervalMs =
	Math.max(1, Number(process.env.PANINI_RECONCILE_INTERVAL_HOURS ?? 24)) *
	3_600_000;

handlers.set("evidence.source.recorded", async (job) => {
	if (!observationAgent && !(await store.modelSettings?.get())) return;

	const payload = z.object({ eventId: z.uuid() }).parse(job.payload);
	const event = (await store.getSourceEvents([payload.eventId]))[0];

	await refreshAllowedVisibilities();
	if (
		!event ||
		// Claims, handoffs and decision drafts were applied by rules in the fast lane.
		(event.provider === "agent" && event.eventKind.startsWith("ledger.")) ||
		!allowedVisibilities.includes(event.visibility) ||
		// Scheduled mode waits for the reconcile run, except a message someone
		// marked with the capture reaction: that thread runs now.
		(reconcileMode === "scheduled" &&
			event.eventKind !== "message.explicitly_captured")
	)
		return;
	await store.enqueueOutboxJob({
		topic: "evidence.source.ready",
		dedupeKey: `evidence:source:${evidenceDispatchEpoch}:${event.id}`,
		payload: {
			pipelineVersion: evidenceVersion!,
			eventId: event.id,
			dispatchEpoch: evidenceDispatchEpoch,
			sourceVersionKey:
				event.observationIdentity?.sourceVersionKey ?? null,
			reason: "source_recorded",
		},
	});
});
// Jobs from removed pipelines are acknowledged so old queues drain.
for (const topic of [
	"evidence.supersession.sweep",
	"evidence.revocation.sweep",
	"evidence.source.revoked",
	"evidence.source.superseded",
	"evidence.context.refresh.scan",
	"evidence.context.refresh",
	"evidence.task.reassess",
	"evidence.task.search_manifest",
	"intelligence.run_requested",
	"adjudication.run_requested",
]) {
	handlers.set(topic, async () => {});
}
if (evidenceDiscovery)
	handlers.set("evidence.discovery.sweep", async (job) => {
		// The scheduled reconcile run replaces the per-message discovery sweep.
		if (
			reconcileMode === "scheduled" ||
			(job.payload as { dispatchEpoch?: string }).dispatchEpoch !==
				evidenceDispatchEpoch
		)
			return;
		await evidenceDiscovery.handle(job);
	});
handlers.set("evidence.source.ready", async (job) => {
	const payload = z
		.object({
			pipelineVersion: z.string(),
			dispatchEpoch: z.string(),
			eventId: z.uuid(),
		})
		.parse(job.payload);

	if (
		payload.pipelineVersion !== evidenceVersion ||
		payload.dispatchEpoch !== evidenceDispatchEpoch
	)
		return;

	const observer = await currentObserver();

	if (!observer) return;
	await observer.agent.run({
		eventId: payload.eventId,
		budgetId: observer.budgetId,
	});
});

/*
 * Reads ended sessions' conversations with the workspace's model and records
 * the decisions each agent made. The transcript is deleted once it is read.
 */
async function extractSessionDecisionsFor(only?: string) {
	const decisions = store.decisions;
	const settings = await store.modelSettings?.get();
	const price = settings && priceBasisFor(settings.model);
	const observer = settings && price ? await currentObserver() : null;

	if (!decisions || !settings || !price || !observer) return;

	for (const sessionId of only
		? [only]
		: await decisions.pendingTranscripts()) {
		const budget = await store.getInferenceBudget(observer.budgetId);

		if (!budget || budget.state !== "active") return;

		const transcript = await decisions.readTranscript(sessionId);
		const session = transcript
			? await ledger.agents.getSession(sessionId)
			: null;

		if (!transcript || !session) continue;

		const result = await extractSessionDecisions({
			transcript,
			model: settings.model,
			apiKey: settings.apiKey,
			fetcher: isClaudeModel(settings.model)
				? claudeFetcher(settings.apiKey)
				: fetch,
		});

		await decisions.chargeBudget(
			observer.budgetId,
			settledCost(
				result.inputTokens,
				result.cachedInputTokens,
				result.outputTokens,
				price,
			) ?? "0",
			result.inputTokens,
			result.outputTokens,
		);

		const agentName =
			(await store.listAgentProfiles()).find(
				(profile) => profile.id === session.agentProfileId,
			)?.name ?? "Agent";

		for (const found of result.decisions)
			await decisions.record({
				sourceKind: "session",
				sourceKey: `session:${session.id}:${found.title
					.toLowerCase()
					.replace(/[^a-z0-9]+/g, "-")
					.slice(0, 80)}`,
				title: found.title,
				category: found.category,
				statement: found.statement,
				reason: found.reason,
				alternatives: found.alternatives,
				evidence: found.quote,
				decidedBy: agentName,
				agentProfileId: session.agentProfileId,
				ownerMemberId: session.memberId,
				sessionId: session.id,
				repository: session.repository,
				silent: !found.askedByUser,
				decidedAt: session.endedAt ?? new Date().toISOString(),
			});
		await decisions.deleteTranscript(sessionId);
		log.info("Session decisions extracted.", {
			sessionId,
			decisions: result.decisions.length,
		});
	}
}

handlers.set("decisions.extract_session", async (job) => {
	const payload = z.object({ sessionId: z.uuid() }).parse(job.payload);

	await extractSessionDecisionsFor(payload.sessionId);
});
handlers.set("reconcile.run", async (job) => {
	const observer = await currentObserver();

	await refreshAllowedVisibilities();
	await extractSessionDecisionsFor().catch((error) =>
		log.error("Session decision extraction failed.", {
			error: error instanceof Error ? error.message : String(error),
		}),
	);

	if (!store.reconcileRuns || !observer) return;

	const trigger =
		(job.payload as { trigger?: string }).trigger === "manual"
			? "manual"
			: "schedule";
	const webhook = process.env.PANINI_DIGEST_WEBHOOK_URL;

	await runReconcile({
		store,
		runs: store.reconcileRuns,
		ledger,
		trigger,
		allowedVisibilities,
		observe: (eventId) =>
			observer.agent.run({ eventId, budgetId: observer.budgetId }),
		concurrency: Math.max(
			1,
			Number(process.env.PANINI_RECONCILE_CONCURRENCY ?? 3),
		),
		...(webhook
			? {
					deliverDigest: async (markdown: string) => {
						const response = await fetch(webhook, {
							method: "POST",
							headers: { "content-type": "application/json" },
							body: JSON.stringify({ text: markdown }),
							signal: AbortSignal.timeout(10_000),
						});

						if (!response.ok)
							throw new Error(
								`Digest webhook returned ${response.status}`,
							);
					},
				}
			: {}),
		log,
	});
});

const githubSync = config.githubApp
	? new GithubRepositorySync(
			new GithubAppClient(
				config.githubApp,
				meteredProviderFetch(store, {
					provider: "github",
					purpose: "source_ingestion",
				}),
			),
			ledger,
			recorder,
		)
	: null;

if (notionPoller)
	handlers.set("connector.notion.sync_requested", async () => {
		await notionPoller!.sync();
	});
if (githubSync)
	handlers.set("connector.github.sync_requested", async (job) => {
		const payload = z
			.object({ installationId: z.string().uuid() })
			.parse(job.payload);

		await githubSync.syncInstallation(payload.installationId);
	});

const dispatcher = new OutboxDispatcher(store, {
	...workerConfig,
	// A reconcile run can take a while; keep its lease.
	leaseSeconds: Math.max(workerConfig.leaseSeconds, 1800),
	workerId,
	handlers,
	log,
});

const githubQueue = githubSync ? new OutboxQueue(store) : null;

const scheduleGithubSync = async () => {
	if (!githubQueue) return;

	const installations = (await ledger.workspace()).installations.filter(
		(installation) =>
			installation.provider === "github" &&
			installation.status !== "revoked" &&
			installation.status !== "disabled",
	);
	const bucket = Math.floor(Date.now() / (15 * 60_000));

	for (const installation of installations) {
		await githubQueue.enqueue(
			"connector.github.sync_requested",
			`github-periodic:${installation.id}:${bucket}`,
			{ installationId: installation.id },
		);
	}
};

// Sweep each minute so a restart late in a bucket cannot delay the next sync
// by almost 30 minutes. The bucketed outbox key still enqueues only once/15m.
const githubTimer = githubSync
	? setInterval(() => {
			void scheduleGithubSync().catch((error) =>
				log.error("GitHub reconciliation scheduling failed.", {
					error: String(error),
				}),
			);
		}, 60_000)
	: null;

if (githubSync) await scheduleGithubSync();

dispatcher.start();

const scheduleEvidenceDiscovery = async () => {
	if (evidenceDiscovery)
		await evidenceDiscovery.schedule(new Date().toISOString().slice(0, 10));
};

if (evidenceDiscovery) await scheduleEvidenceDiscovery();

const evidenceDiscoveryTimer = evidenceDiscovery
	? setInterval(() => {
			void scheduleEvidenceDiscovery().catch((error) =>
				log.error("Evidence discovery scheduling failed.", {
					error: String(error),
				}),
			);
		}, 60_000)
	: null;
const embeddingIndexer = embedding
	? new ContextEmbeddingIndexer(
			store,
			embedding.index,
			embedding.adapter,
			log,
		)
	: null;

embeddingIndexer?.start();
notionPoller?.start();
if (slackAdapter && slackInstallationId) {
	await syncSlackMemberDirectory({
		adapter: slackAdapter,
		ledger,
		installationId: slackInstallationId,
		log,
	});
}
if (slackAdapter && config.app.slack?.captureMode === "all_messages") {
	try {
		const report = await slackAdapter.backfill();

		if (report.errors.length > 0) {
			log.error(
				"Slack channel history backfill completed with inaccessible channels.",
				report,
			);
		} else {
			log.info("Slack channel history backfill completed.", report);
		}
	} catch (error) {
		log.error(
			"Slack channel history backfill failed; Socket Mode will still start.",
			{
				error: error instanceof Error ? error.message : String(error),
			},
		);
	}
}
slackSupervisor?.start();
log.info("Panini worker started.", {
	workerId,
	notion: Boolean(notionPoller),
	slack: Boolean(slackSupervisor),
	observationAgent: observationAgent ? "server" : "workspace setting",
	reconcile: reconcileMode,
});

// A failed database probe does not refresh the heartbeat. The container becomes unhealthy.
const heartbeat = async () => {
	try {
		await store.getOrganization();
		await writeFile(
			"/tmp/panini-worker-heartbeat",
			new Date().toISOString(),
			{ mode: 0o600 },
		);
	} catch (error) {
		log.error("Worker health probe failed.", { error: String(error) });
	}
};

await heartbeat();

const reconcileTimer =
	store.reconcileRuns && reconcileMode === "scheduled"
		? setInterval(() => {
				void (async () => {
					if (
						!observationAgent &&
						!(await store.modelSettings?.get())
					)
						return;

					const last = await store.reconcileRuns!.lastCompleted();

					if (
						last?.finishedAt &&
						Date.now() - Date.parse(last.finishedAt) <
							reconcileIntervalMs
					)
						return;
					await store.enqueueOutboxJob({
						topic: "reconcile.run",
						dedupeKey: `reconcile:schedule:${Math.floor(Date.now() / reconcileIntervalMs)}`,
						payload: { trigger: "schedule" },
					});
				})().catch((error: unknown) =>
					log.error("Could not schedule the reconcile run.", {
						error:
							error instanceof Error
								? error.message
								: String(error),
					}),
				);
			}, 60_000)
		: null;
const heartbeatTimer = setInterval(() => void heartbeat(), 30_000);

let shuttingDown = false;

const shutdown = async (signal: string) => {
	if (shuttingDown) return;
	shuttingDown = true;
	clearInterval(heartbeatTimer);
	clearInterval(connectorWatch);
	if (reconcileTimer) clearInterval(reconcileTimer);
	log.info("Panini worker stopping.", { signal });
	notionPoller?.stop();
	if (githubTimer) clearInterval(githubTimer);
	if (evidenceDiscoveryTimer) clearInterval(evidenceDiscoveryTimer);
	slackSupervisor?.stop();
	await dispatcher.stop();
	await embeddingIndexer?.stop();
	await embedding?.index.close();
	await store.close();
};

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

// Connectors added or removed in the app take effect after a restart. Exit
// code 75 asks the supervisor (Docker, or npx panini-work) to start us again.
const connectorVersion = await store.connectorCredentials?.version();
const connectorWatch = setInterval(() => {
	void store.connectorCredentials
		?.version()
		.then(async (version) => {
			if (version === connectorVersion || shuttingDown) return;
			clearInterval(connectorWatch);
			log.info("Connector settings changed; restarting the worker.");
			await shutdown("connector settings changed");
			process.exit(75);
		})
		.catch(() => undefined);
}, 15_000);
