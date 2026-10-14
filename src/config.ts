import { readFile } from "node:fs/promises";
import YAML from "yaml";
import type { GithubAppCredentials } from "./connectors/github/app-client.js";
import { z } from "zod";
import { taskStatuses } from "./domain/types.js";
import type { PipelineMode } from "./domain/evidence-types.js";

const propertyMappingSchema = z.object({
  title: z.string().default("Name"),
  description: z.string().optional(),
  status: z.string().default("Status"),
  owner: z.string().optional(),
  dueDate: z.string().optional(),
  priority: z.string().optional(),
  project: z.string().optional(),
  dependencies: z.string().optional(),
});

const notionSourceSchema = z.object({
  key: z.string().min(1),
  kind: z.enum(["page", "data_source", "workspace"]),
  resourceId: z.string().min(1).optional(),
  ingestAs: z.enum(["task_board", "company_context"]),
  contextPath: z.string().min(1).max(500).optional(),
  visibility: z.string().default("company"),
  properties: propertyMappingSchema.optional(),
  statusMap: z.record(z.string(), z.enum(taskStatuses)).default({}),
}).superRefine((source, context) => {
  if (source.kind !== "workspace" && !source.resourceId) {
    context.addIssue({
      code: "custom",
      path: ["resourceId"],
      message: "resourceId is required for page and data_source sources.",
    });
  }
  if (source.kind === "workspace" && source.ingestAs !== "company_context") {
    context.addIssue({
      code: "custom",
      path: ["ingestAs"],
      message: "workspace discovery must ingest pages as company_context evidence.",
    });
  }
});

export const evidenceV2Default = {
  mode: "agent" as const, pipelineVersion: "observation-agent-v1",
  policyVersion: "evidence-policy-v1", maxActiveObservations: 20,
  maxContextObservations: 20, maxInputTokens: 24_000,
  debounceSeconds: 30, maxDebounceSeconds: 300,
  lexicalCandidates: 20, semanticCandidates: 20, maxCandidates: 40,
  workEmbeddingsEnabled: true,
  maxMutableEvidenceAgeSeconds: 900, maxRequiredCheckpointAgeSeconds: 900,
  maxEscalations: 1, maxEvidenceExpansions: 1, maxAutomaticRetries: 2,
  escalation: null as null,
  sweepIntervalSeconds: 86_400, sweepBatchSize: 100, noClaimSamplePercent: 10,
  autoApplyClasses: [] as [], authorityPolicies: [] as [],
  artifactLimits: { requests: 10, files: 20, bytes: 204_800, contextTokens: 12_000 },
};

const evidenceV2Schema = z.strictObject({
  mode: z.enum(["agent", "legacy", "shadow", "review", "apply"]).default("agent"),
  pipelineVersion: z.string().min(1).default(evidenceV2Default.pipelineVersion),
  policyVersion: z.string().min(1).default(evidenceV2Default.policyVersion),
  maxActiveObservations: z.number().int().min(1).max(100).default(20),
  maxContextObservations: z.number().int().min(1).max(100).default(20),
  maxInputTokens: z.number().int().min(1_000).max(100_000).default(24_000),
  debounceSeconds: z.number().int().min(1).max(3_600).default(30),
  maxDebounceSeconds: z.number().int().min(1).max(7_200).default(300),
  lexicalCandidates: z.number().int().min(1).max(100).default(20),
  semanticCandidates: z.number().int().min(1).max(100).default(20),
  maxCandidates: z.number().int().min(1).max(100).default(40),
  workEmbeddingsEnabled: z.boolean().default(true),
  maxMutableEvidenceAgeSeconds: z.number().int().min(1).max(86_400).default(900),
  maxRequiredCheckpointAgeSeconds: z.number().int().min(1).max(86_400).default(900),
  maxEscalations: z.number().int().min(0).max(1).default(1),
  maxEvidenceExpansions: z.number().int().min(0).max(1).default(1),
  escalation: z.strictObject({ model: z.string().min(1),
    priceBasis: z.strictObject({ id: z.string().min(1), model: z.string().min(1),
      inputUsdPerMillion: z.number().nonnegative(),
      cachedInputUsdPerMillion: z.number().nonnegative(),
      outputUsdPerMillion: z.number().nonnegative(),
      sourceUrl: z.url() }) }).nullable().default(null),
  maxAutomaticRetries: z.number().int().min(0).max(10).default(2),
  sweepIntervalSeconds: z.number().int().min(60).max(604_800).default(86_400),
  sweepBatchSize: z.number().int().min(1).max(100).default(100),
  noClaimSamplePercent: z.number().int().min(0).max(100).default(10),
  autoApplyClasses: z.array(z.enum(["task_nonterminal", "task_terminal"])).default([]),
  authorityPolicies: z.array(z.strictObject({
    id: z.string().min(1), version: z.number().int().positive(),
    memberIds: z.array(z.uuid()), roles: z.array(z.string()),
    providers: z.array(z.string()), installationKeys: z.array(z.string()),
    objectKinds: z.array(z.string()), criterionKinds: z.array(z.string()),
    audience: z.array(z.string()),
    maxAttestationAgeSeconds: z.number().int().min(1).max(86_400).optional(),
  })).default([]),
  artifactLimits: z.strictObject({
    requests: z.number().int().min(1).max(100).default(10),
    files: z.number().int().min(1).max(100).default(20),
    bytes: z.number().int().min(1_024).max(10_000_000).default(204_800),
    contextTokens: z.number().int().min(1_000).max(100_000).default(12_000),
  }).default(evidenceV2Default.artifactLimits),
}).default(evidenceV2Default);

const intelligenceSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["manual", "interval"]).default("manual"),
  intervalSeconds: z.number().int().min(30).default(900),
  maxEventsPerRun: z.number().int().min(1).max(500).default(50),
  maxEvidenceCharacters: z.number().int().min(1_000).max(500_000).default(60_000),
  maxSourceDocumentCharacters: z.number().int().min(1_000).max(500_000).default(320_000),
  maxContextCharacters: z.number().int().min(1_000).max(500_000).default(30_000),
  minimumConfidence: z.number().min(0).max(1).default(0.7),
  completionMinimumConfidence: z.number().min(0).max(1).default(0.85),
  completionMinimumEvidenceItems: z.number().int().min(1).max(10).default(2),
  completionEvidenceProviders: z.array(z.string().min(1)).default(["github", "git", "codex", "claude_code", "agent"]),
  reconciliationEnabled: z.boolean().default(true),
  reconciliationIntervalSeconds: z.number().int().min(60).default(900),
  reconciliationMinimumAgeSeconds: z.number().int().min(0).default(300),
  sourceProviders: z.array(z.string().min(1)).default(["notion:source.document.retrieved", "slack", "github", "git", "codex", "claude_code", "agent", "manual"]),
  evidenceV2: evidenceV2Schema,
});

const adjudicationSchema = z.object({
  enabled: z.boolean().default(false),
  mode: z.enum(["manual", "interval"]).default("manual"),
  intervalSeconds: z.number().int().min(10).default(30),
  maxProposalsPerRun: z.number().int().min(1).max(100).default(20),
  maxEvidenceCharacters: z.number().int().min(1_000).max(500_000).default(80_000),
  maxHistoryCharacters: z.number().int().min(1_000).max(500_000).default(60_000),
  maxHistoryItems: z.number().int().min(1).max(100).default(30),
  approvalMinimumConfidence: z.number().min(0).max(1).default(0.8),
});

const slackSchema = z.object({
  enabled: z.boolean().default(false),
  installationKey: z.string().min(1).default("default"),
  channels: z.array(z.string().min(1)).default([]),
  captureMode: z.enum(["reaction", "all_messages"]).default("reaction"),
  captureReactions: z.array(z.string().min(1)).default(["panini", "bookmark"]),
}).optional();

const githubSchema = z.object({
  enabled: z.boolean().default(false),
  installationKey: z.string().min(1).default("default"),
  repositories: z.array(z.string().regex(/^[^/]+\/[^/]+$/)).default([]),
}).optional();

const appConfigSchema = z.object({
  company: z.object({ name: z.string().min(1).default("My Company") }).default({ name: "My Company" }),
  policy: z
    .object({
      mode: z.enum(["autonomous", "manual_review"]).default("manual_review"),
      autoApproveNewTasks: z.boolean().default(false),
      autoApproveContext: z.boolean().default(false),
      requireReviewForTaskChanges: z.boolean().default(true),
    })
    .default({ mode: "manual_review", autoApproveNewTasks: false, autoApproveContext: false, requireReviewForTaskChanges: true }),
  notion: z
    .object({
      enabled: z.boolean().default(false),
      pollIntervalSeconds: z.number().int().min(30).default(300),
      apiVersion: z.string().default("2026-03-11"),
      sources: z.array(notionSourceSchema).default([]),
    })
    .default({ enabled: false, pollIntervalSeconds: 300, apiVersion: "2026-03-11", sources: [] }),
  slack: slackSchema,
  github: githubSchema,
  intelligence: intelligenceSchema.default({
    enabled: false,
    mode: "manual",
    intervalSeconds: 900,
    maxEventsPerRun: 50,
    maxEvidenceCharacters: 60_000,
    maxSourceDocumentCharacters: 320_000,
    maxContextCharacters: 30_000,
    minimumConfidence: 0.7,
    completionMinimumConfidence: 0.85,
    completionMinimumEvidenceItems: 2,
    completionEvidenceProviders: ["github", "git", "codex", "claude_code", "agent"],
    reconciliationEnabled: true,
    reconciliationIntervalSeconds: 900,
    reconciliationMinimumAgeSeconds: 300,
    sourceProviders: ["notion:source.document.retrieved", "slack", "github", "git", "codex", "claude_code", "agent", "manual"],
    evidenceV2: evidenceV2Default,
  }),
  adjudication: adjudicationSchema.default({
    enabled: false,
    mode: "manual",
    intervalSeconds: 30,
    maxProposalsPerRun: 20,
    maxEvidenceCharacters: 80_000,
    maxHistoryCharacters: 60_000,
    maxHistoryItems: 30,
    approvalMinimumConfidence: 0.8,
  }),
});

export type AppConfig = z.infer<typeof appConfigSchema>;
export type NotionSourceConfig = z.infer<typeof notionSourceSchema>;

export function evidencePipelineMode(config: AppConfig): PipelineMode | "agent" {
  return config.intelligence.evidenceV2.mode;
}

export interface RuntimeConfig {
  app: AppConfig;
  host: string;
  port: number;
  databaseUrl: string | null;
  contentEncryptionKey?: string | null;
  autoMigrate: boolean;
  adminToken: string | null;
  publicUrl?: string;
  trustProxy?: boolean;
  notionToken: string | null;
  slackAppToken?: string | null;
  slackBotToken?: string | null;
  githubWebhookSecret?: string | null;
  githubApp: GithubAppCredentials | null;
  intelligenceApiKey: string | null;
  intelligenceModel: string | null;
  intelligenceBaseUrl: string;
  adjudicationApiKey: string | null;
  adjudicationModel: string | null;
  adjudicationBaseUrl: string;
  retrievalProvider: "postgres" | "jev";
  jevApiKey: string | null;
  jevWorkAllowedVisibilities: string[];
  workDraftAllowedVisibilities: string[];
  embeddingProvider: "disabled" | "openrouter";
  openrouterApiKey: string | null;
  openrouterEmbeddingModel: string;
  openrouterEmbeddingEndpoint?: string;
}

function envBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(value.toLowerCase());
}

export async function loadConfig(): Promise<RuntimeConfig> {
  const configPath = process.env.APP_CONFIG_PATH ?? "./config/panini.example.yaml";
  const raw = YAML.parse(await readFile(configPath, "utf8")) as unknown;
  const app = appConfigSchema.parse(raw);
  const evidenceMode = evidencePipelineMode(app);
  if (evidenceMode === "shadow") {
    const shadowUrl = process.env.PANINI_SHADOW_DATABASE_URL;
    const primaryUrl = process.env.PANINI_PRIMARY_DATABASE_URL;
    const selectedUrl = process.env.DATABASE_URL;
    if (!shadowUrl || !primaryUrl || !selectedUrl || selectedUrl !== shadowUrl
      || new URL(shadowUrl).pathname === new URL(primaryUrl).pathname
      || !process.env.PANINI_SHADOW_ORGANIZATION_ID
      || !process.env.PANINI_PRIMARY_ORGANIZATION_ID
      || process.env.PANINI_SHADOW_ORGANIZATION_ID === process.env.PANINI_PRIMARY_ORGANIZATION_ID
      || app.notion.enabled || app.slack?.enabled || app.github?.enabled
      || Boolean(process.env.GITHUB_APP_ID)) {
      throw new Error("Shadow evidence mode requires an isolated database and organization, with live source connectors disabled.");
    }
  }
  const port = Number(process.env.PORT ?? "4141");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid port number.");
  const host = process.env.HOST ?? "127.0.0.1";
  const retrievalProvider = process.env.RETRIEVAL_PROVIDER ?? "postgres";
  if (retrievalProvider !== "postgres" && retrievalProvider !== "jev") {
    throw new Error("RETRIEVAL_PROVIDER must be postgres or jev.");
  }
  if (retrievalProvider === "jev" && !process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is required when RETRIEVAL_PROVIDER=jev.");
  }
  const embeddingProvider = process.env.EMBEDDING_PROVIDER ?? "disabled";
  if (embeddingProvider !== "disabled" && embeddingProvider !== "openrouter") {
    throw new Error("EMBEDDING_PROVIDER must be disabled or openrouter.");
  }
  if (embeddingProvider === "openrouter" && (!process.env.OPENROUTER_API_KEY || !process.env.DATABASE_URL)) {
    throw new Error("OPENROUTER_API_KEY and DATABASE_URL are required when EMBEDDING_PROVIDER=openrouter.");
  }
  const adminToken = process.env.APP_ADMIN_TOKEN || null;
  const loopback = host === "127.0.0.1" || host === "localhost" || host === "::1";
  if (!adminToken && (process.env.NODE_ENV === "production" || !loopback)) {
    throw new Error("APP_ADMIN_TOKEN is required in production or when binding beyond loopback.");
  }
  const publicUrl = process.env.PANINI_PUBLIC_URL || `http://${host === "::1" ? "[::1]" : loopback ? host : "127.0.0.1"}:${port}`;
  const publicAddress = new URL(publicUrl);
  const localAddress = ["localhost", "127.0.0.1", "[::1]"].includes(publicAddress.hostname);
  if (publicAddress.username || publicAddress.password || publicAddress.search || publicAddress.hash || publicAddress.pathname !== "/"
    || (publicAddress.protocol !== "https:" && !(publicAddress.protocol === "http:" && localAddress))) {
    throw new Error("PANINI_PUBLIC_URL must be an HTTPS origin, or HTTP on loopback for local use.");
  }
  if (process.env.NODE_ENV === "production") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required in production. Memory storage is development-only.");
    if (!process.env.CONTENT_ENCRYPTION_KEY) throw new Error("CONTENT_ENCRYPTION_KEY is required in production.");
    if (!adminToken || adminToken.length < 32) throw new Error("APP_ADMIN_TOKEN must contain at least 32 characters in production.");
    if (!process.env.PANINI_PUBLIC_URL) throw new Error("PANINI_PUBLIC_URL is required in production.");
  }
  const githubAppValues = [
    process.env.GITHUB_APP_ID,
    process.env.GITHUB_CLIENT_ID,
    process.env.GITHUB_CLIENT_SECRET,
    process.env.GITHUB_APP_SLUG,
    process.env.GITHUB_APP_PRIVATE_KEY_BASE64,
    process.env.GITHUB_CALLBACK_URL,
  ];
  if (githubAppValues.some(Boolean) && !githubAppValues.every(Boolean)) {
    throw new Error("GitHub App connection requires GITHUB_APP_ID, GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, GITHUB_APP_SLUG, GITHUB_APP_PRIVATE_KEY_BASE64, and GITHUB_CALLBACK_URL.");
  }
  const githubApp = githubAppValues.every(Boolean) ? {
    appId: Number(process.env.GITHUB_APP_ID),
    clientId: process.env.GITHUB_CLIENT_ID!,
    clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    appSlug: process.env.GITHUB_APP_SLUG!,
    privateKey: Buffer.from(process.env.GITHUB_APP_PRIVATE_KEY_BASE64!, "base64").toString("utf8"),
    callbackUrl: process.env.GITHUB_CALLBACK_URL!,
  } : null;
  if (githubApp) {
    const callback = new URL(githubApp.callbackUrl);
    const localCallback = ["localhost", "127.0.0.1", "[::1]"].includes(callback.hostname);
    if (!Number.isSafeInteger(githubApp.appId) || githubApp.appId <= 0
      || (callback.protocol !== "https:" && !(localCallback && callback.protocol === "http:"))
      || callback.username || callback.password || callback.hash) {
      throw new Error("GitHub App ID or callback URL is invalid; use HTTPS except for loopback development.");
    }
  }
  return {
    app,
    host,
    port,
    databaseUrl: process.env.DATABASE_URL || null,
    contentEncryptionKey: process.env.CONTENT_ENCRYPTION_KEY || null,
    autoMigrate: envBoolean(process.env.AUTO_MIGRATE, true),
    adminToken,
    publicUrl: publicAddress.origin,
    trustProxy: envBoolean(process.env.PANINI_TRUST_PROXY, false),
    notionToken: process.env.NOTION_TOKEN || null,
    slackAppToken: process.env.SLACK_APP_TOKEN || null,
    slackBotToken: process.env.SLACK_BOT_TOKEN || null,
    githubWebhookSecret: process.env.GITHUB_WEBHOOK_SECRET || null,
    githubApp,
    intelligenceApiKey: process.env.INTELLIGENCE_API_KEY || null,
    intelligenceModel: process.env.INTELLIGENCE_MODEL || null,
    intelligenceBaseUrl: process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1",
    adjudicationApiKey: process.env.ADJUDICATION_API_KEY || process.env.INTELLIGENCE_API_KEY || null,
    adjudicationModel: process.env.ADJUDICATION_MODEL || process.env.INTELLIGENCE_MODEL || null,
    adjudicationBaseUrl: process.env.ADJUDICATION_BASE_URL || process.env.INTELLIGENCE_BASE_URL || "https://api.openai.com/v1",
    retrievalProvider,
    jevApiKey: process.env.OPENROUTER_API_KEY || null,
    jevWorkAllowedVisibilities: (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    workDraftAllowedVisibilities: (process.env.WORK_DRAFT_ALLOWED_VISIBILITIES ?? "")
      .split(",").map((value) => value.trim()).filter(Boolean),
    embeddingProvider,
    openrouterApiKey: process.env.OPENROUTER_API_KEY || null,
    openrouterEmbeddingEndpoint: process.env.OPENROUTER_EMBEDDING_ENDPOINT || "https://openrouter.ai/api/v1/embeddings",
    openrouterEmbeddingModel: process.env.OPENROUTER_EMBEDDING_MODEL || "voyageai/voyage-4",
  };
}
