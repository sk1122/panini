import {
	evidencePipelineMode,
	loadConfig,
	type RuntimeConfig,
} from "../config.js";
import { migrate } from "../db/migrate.js";
import { ProposalPolicy } from "../domain/policy.js";
import type { LedgerStore } from "../domain/store.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { PostgresLedgerStore } from "../store/postgres.js";
import { PostgresContextCompiler } from "../retrieval/context-compiler.js";
import { PostgresContextEmbeddingIndex } from "../retrieval/context-embedding-index.js";
import { OpenRouterEmbeddingAdapter } from "../retrieval/openrouter-embedding-adapter.js";
import { EmbeddingDocumentRanker } from "../retrieval/embedding-document-ranker.js";
import {
	meteredExternalFetch,
	type ExternalEvaluationLimiter,
} from "../intelligence/external-call-meter.js";

export interface RuntimeLog {
	info(message: string, fields?: object): void;
	error(message: string, fields?: object): void;
}

export interface PaniniCore {
	config: RuntimeConfig;
	store: LedgerStore;
	ledger: TeamLedger;
	log: RuntimeLog;
	embedding: {
		adapter: OpenRouterEmbeddingAdapter;
		index: PostgresContextEmbeddingIndex;
	} | null;
}

export interface CreatePaniniCoreOptions {
	runMigrations?: boolean;
	coverageAsOf?: string;
	externalEvaluationLimiter?: ExternalEvaluationLimiter;
	externalEvaluationRunId?: string;
}

export async function createPaniniCore(
	options: CreatePaniniCoreOptions = {},
): Promise<PaniniCore> {
	const config = await loadConfig();

	if (!config.databaseUrl)
		throw new Error(
			"DATABASE_URL is required. For a quick local install with its own database, run: npx panini-work",
		);
	if (!config.contentEncryptionKey) {
		throw new Error(
			"CONTENT_ENCRYPTION_KEY is required when PostgreSQL storage is enabled.",
		);
	}
	if (options.runMigrations ?? config.autoMigrate)
		await migrate(config.databaseUrl);

	const store: LedgerStore = new PostgresLedgerStore(
		config.databaseUrl,
		config.contentEncryptionKey,
	);

	const externalFetch = (
		provider: "openai" | "openrouter",
		purpose: string,
	) =>
		meteredExternalFetch(store, {
			provider,
			purpose,
			...(options.externalEvaluationLimiter
				? { limiter: options.externalEvaluationLimiter }
				: {}),
			...(options.externalEvaluationRunId
				? { evaluationRunId: options.externalEvaluationRunId }
				: {}),
		});

	const organization = await store.getOrganization();

	if (
		evidencePipelineMode(config.app) === "shadow" &&
		organization.id !== process.env.PANINI_SHADOW_ORGANIZATION_ID
	) {
		throw new Error("Shadow evidence organization assertion failed.");
	}
	// Once the first person completes setup, the durable company name is authoritative.
	// Before setup, keep the configured name for existing installations.
	if (organization.name !== config.app.company.name) {
		const { IdentityService } = await import("../security/identity.js");
		const identity = config.databaseUrl
			? new IdentityService(config.databaseUrl, organization.id)
			: null;

		try {
			if (!identity)
				await store.setOrganizationName(config.app.company.name);
			else
				config.app.company.name = (
					await identity.initializeCompanyName(
						config.app.company.name,
					)
				).name;
		} finally {
			await identity?.close();
		}
	}

	const embedding =
		config.embeddingProvider === "openrouter"
			? {
					adapter: new OpenRouterEmbeddingAdapter({
						apiKey: config.openrouterApiKey!,
						model: config.openrouterEmbeddingModel,
						fetcher: externalFetch("openrouter", "embed"),
					}),
					index: new PostgresContextEmbeddingIndex(
						config.databaseUrl!,
						organization.id,
					),
				}
			: null;
	// Optional semantic ranking of context documents when embeddings are configured.
	const retriever = embedding
		? new PostgresContextCompiler(
				store,
				undefined,
				undefined,
				new EmbeddingDocumentRanker(embedding.index, embedding.adapter),
			)
		: undefined;
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy(config.app.policy),
		retriever,
	);
	const log: RuntimeLog = {
		info: (message, fields) => console.info(message, fields ?? {}),
		error: (message, fields) => console.error(message, fields ?? {}),
	};

	return { config, store, ledger, log, embedding };
}
