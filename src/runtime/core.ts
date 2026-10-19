import {
	evidencePipelineMode,
	loadConfig,
	type RuntimeConfig,
} from "../config.js";
import { AutonomousAdjudicator } from "../adjudication/engine.js";
import { migrate } from "../db/migrate.js";
import { ProposalPolicy } from "../domain/policy.js";
import type { LedgerStore } from "../domain/store.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { EvidenceIntelligence } from "../intelligence/engine.js";
import { OpenAIResponsesInterpreter } from "../intelligence/openai-responses.js";
import { JevObservationRouter } from "../intelligence/jev-router.js";
import { MemoryLedgerStore } from "../store/memory.js";
import { PostgresLedgerStore } from "../store/postgres.js";
import { PostgresContextCompiler } from "../retrieval/context-compiler.js";
import { JevRelevanceRanker } from "../retrieval/jev-ranker.js";
import { PostgresContextEmbeddingIndex } from "../retrieval/context-embedding-index.js";
import { OpenRouterEmbeddingAdapter } from "../retrieval/openrouter-embedding-adapter.js";
import { EmbeddingDocumentRanker } from "../retrieval/embedding-document-ranker.js";
import { EmbeddingObservationEpisodeGrouper } from "../intelligence/observation-episodes.js";
import { EmbeddingJevWorkEntityRetriever } from "../retrieval/work-entity-retriever.js";
import {
	JevProposalFitClassifier,
	type ProposalFitClassifier,
} from "../adjudication/proposal-fit-classifier.js";
import { JevWorkJudge } from "../reconciliation/jev-work-judge.js";
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
	intelligence: EvidenceIntelligence;
	adjudicator: AutonomousAdjudicator;
	proposalClassifier: ProposalFitClassifier | null;
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

	if (config.databaseUrl && !config.contentEncryptionKey) {
		throw new Error(
			"CONTENT_ENCRYPTION_KEY is required when PostgreSQL storage is enabled.",
		);
	}
	if (config.databaseUrl && (options.runMigrations ?? config.autoMigrate))
		await migrate(config.databaseUrl);

	const store: LedgerStore = config.databaseUrl
		? new PostgresLedgerStore(
				config.databaseUrl,
				config.contentEncryptionKey!,
			)
		: new MemoryLedgerStore(config.app.company.name);

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
	const retriever =
		config.retrievalProvider === "jev"
			? new PostgresContextCompiler(
					store,
					undefined,
					new JevRelevanceRanker({
						apiKey: config.jevApiKey!,
						fetcher: externalFetch("openrouter", "rank"),
					}),
					embedding
						? new EmbeddingDocumentRanker(
								embedding.index,
								embedding.adapter,
							)
						: undefined,
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
	const legacyIntelligenceEnabled =
		evidencePipelineMode(config.app) === "legacy";
	const interpreter =
		legacyIntelligenceEnabled &&
		config.intelligenceApiKey &&
		config.intelligenceModel
			? new OpenAIResponsesInterpreter({
					apiKey: config.intelligenceApiKey,
					model: config.intelligenceModel,
					baseUrl: config.intelligenceBaseUrl,
					fetcher: externalFetch("openai", "interpret"),
				})
			: null;
	const router =
		legacyIntelligenceEnabled &&
		config.jevApiKey &&
		config.jevWorkAllowedVisibilities.length > 0
			? new JevObservationRouter({
					apiKey: config.jevApiKey,
					allowedVisibilities: config.jevWorkAllowedVisibilities,
					fetcher: externalFetch("openrouter", "route"),
				})
			: null;
	const proposalClassifier =
		legacyIntelligenceEnabled &&
		config.jevApiKey &&
		config.jevWorkAllowedVisibilities.length > 0
			? new JevProposalFitClassifier({
					apiKey: config.jevApiKey,
					allowedVisibilities: config.jevWorkAllowedVisibilities,
					fetcher: externalFetch("openrouter", "proposal_fit"),
				})
			: null;
	const episodeGrouper = new EmbeddingObservationEpisodeGrouper(
		embedding?.adapter ?? null,
		config.jevWorkAllowedVisibilities,
	);
	const entityRetriever =
		legacyIntelligenceEnabled && embedding && config.jevApiKey
			? new EmbeddingJevWorkEntityRetriever({
					apiKey: config.jevApiKey,
					embedding: embedding.adapter,
					fetcher: externalFetch("openrouter", "entity_rank"),
				})
			: null;
	const workJudge =
		legacyIntelligenceEnabled &&
		config.jevApiKey &&
		config.jevWorkAllowedVisibilities.length > 0
			? new JevWorkJudge({
					apiKey: config.jevApiKey,
					allowedVisibilities: config.jevWorkAllowedVisibilities,
					fetcher: externalFetch("openrouter", "work_judge"),
				})
			: null;
	const intelligence = new EvidenceIntelligence({
		store,
		ledger,
		interpreter,
		router,
		episodeGrouper,
		entityRetriever,
		workJudge,
		workChangeJudge: workJudge,
		workClaimJudge: workJudge,
		...(options.coverageAsOf ? { coverageAsOf: options.coverageAsOf } : {}),
		companyName: config.app.company.name,
		config: config.app.intelligence,
		log,
	});
	const adjudicationProvider = null;
	const adjudicator = new AutonomousAdjudicator({
		store,
		ledger,
		provider: adjudicationProvider,
		companyName: config.app.company.name,
		config: config.app.adjudication,
		completionPolicy: {
			minimumEvidenceItems:
				config.app.intelligence.completionMinimumEvidenceItems,
			evidenceProviders:
				config.app.intelligence.completionEvidenceProviders,
		},
		log,
	});

	return {
		config,
		store,
		ledger,
		intelligence,
		adjudicator,
		proposalClassifier,
		log,
		embedding,
	};
}
