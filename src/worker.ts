import { ObservationAgent } from "./intelligence/observation-agent.js";
import { hostname } from "node:os";
import { writeFile } from "node:fs/promises";
import { z } from "zod";
import pg from "pg";
import { NotionClient } from "./connectors/notion/client.js";
import { NotionPoller } from "./connectors/notion/poller.js";
import { SlackCaptureAdapter, SlackWebApiClient } from "./connectors/slack/socket-mode.js";
import { syncSlackMemberDirectory } from "./connectors/slack/startup-sync.js";
import { SlackSocketSupervisor } from "./connectors/slack/supervisor.js";
import { projectionOutboxHandlers } from "./outbox/projection-handler.js";
import { OutboxDispatcher } from "./outbox/runtime.js";
import { createPaniniCore } from "./runtime/core.js";
import { ContextEmbeddingIndexer } from "./retrieval/context-embedding-indexer.js";
import { GithubAppClient } from "./connectors/github/app-client.js";
import { GithubCriterionVerifier } from "./connectors/github/criterion-verifier.js";
import { GithubRepositorySync } from "./connectors/github/sync.js";
import { OutboxQueue } from "./outbox/runtime.js";
import { JevWorkJudge } from "./reconciliation/jev-work-judge.js";
import { OpenAIWorkProseDrafter } from "./reconciliation/openai-work-drafter.js";
import { WorkSuggestionEngine } from "./reconciliation/work-suggestions.js";
import { TaskStatusSuggestionEngine } from "./reconciliation/task-status-suggestions.js";
import { ContinuousReconciliationLoop } from "./reconciliation/continuous-reconciliation.js";
import { createTaskEvidenceReassessHandler } from "./reconciliation/task-evidence-reassess.js";
import { EvidenceDiscoverySweep } from "./reconciliation/evidence-discovery.js";
import { EvidencePipeline } from "./intelligence/evidence-pipeline.js";
import { OpenAIClaimExtractor } from "./intelligence/claim-extractor.js";
import { identityText,
  workEmbeddingPermissionFingerprint } from "./intelligence/task-identity.js";
import { OpenAIWorkSearchResolver } from "./intelligence/work-search-resolver.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "./intelligence/model-price.js";
import { BudgetedVoyageEmbeddings } from "./intelligence/voyage-work-embeddings.js";
import { OpenAIEvidenceJudge } from "./intelligence/evidence-judge.js";
import { OpenAIContextSummarizer } from "./intelligence/context-summary.js";
import { meteredExternalFetch, meteredProviderFetch } from "./intelligence/external-call-meter.js";
import { evidencePipelineMode } from "./config.js";
import { contentHash } from "./domain/content-hash.js";
import { acceptedTaskSourceEventIds, visibleAcceptedTasks } from "./domain/accepted-source-access.js";
import { containsCredentialLikeText } from "./retrieval/external-text-policy.js";
import type { EvidenceClaim } from "./domain/evidence-types.js";
import type { Task } from "./domain/types.js";

function cosineSimilarity(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0; let leftNorm = 0; let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! ** 2;
    rightNorm += right[index]! ** 2;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : -1;
}

const workerConfigSchema = z.object({
  batchSize: z.coerce.number().int().min(1).max(500).default(50),
  leaseSeconds: z.coerce.number().int().min(10).max(3_600).default(60),
  pollIntervalMs: z.coerce.number().int().min(100).max(60_000).default(1_000),
  maxAttempts: z.coerce.number().int().min(1).max(100).default(8),
  retryBaseMs: z.coerce.number().int().min(100).max(60_000).default(1_000),
  retryMaximumMs: z.coerce.number().int().min(1_000).max(86_400_000).default(300_000),
});

type ScoredClaim = { id: string; score: number };

const intelligenceRunPayloadSchema = z.object({
  eventIds: z.array(z.string().uuid()).max(20).default([]),
}).passthrough();

const { config, store, ledger, intelligence, adjudicator, log, embedding } = await createPaniniCore();
if (!config.databaseUrl) {
  throw new Error("DATABASE_URL is required for the worker because in-memory jobs cannot be shared with the server.");
}
const workerConfig = workerConfigSchema.parse({
  batchSize: process.env.OUTBOX_BATCH_SIZE,
  leaseSeconds: process.env.OUTBOX_LEASE_SECONDS,
  pollIntervalMs: process.env.OUTBOX_POLL_INTERVAL_MS,
  maxAttempts: process.env.OUTBOX_MAX_ATTEMPTS,
  retryBaseMs: process.env.OUTBOX_RETRY_BASE_MS,
  retryMaximumMs: process.env.OUTBOX_RETRY_MAXIMUM_MS,
});
const workerId = process.env.PANINI_WORKER_ID || `worker:${hostname()}:${process.pid}`;
const evidenceMode = evidencePipelineMode(config.app);
const evidenceV2Enabled = evidenceMode !== "legacy";
const observationAgentEnabled = evidenceMode === "agent";
const evidenceBudgetId = process.env.PANINI_EVIDENCE_V2_BUDGET_ID;
const evidenceVersion = process.env.PANINI_EVIDENCE_V2_VERSION
  ?? config.app.intelligence.evidenceV2.pipelineVersion;
const workEmbeddings = evidenceV2Enabled && (observationAgentEnabled || config.app.intelligence.evidenceV2.workEmbeddingsEnabled)
  ? new BudgetedVoyageEmbeddings({ store, apiKey: config.openrouterApiKey ?? "", endpoint: config.openrouterEmbeddingEndpoint ?? "https://openrouter.ai/api/v1/embeddings" }) : null;
const escalationConfig = config.app.intelligence.evidenceV2.escalation;
if (evidenceV2Enabled && !observationAgentEnabled && escalationConfig
  && (escalationConfig.model === "gpt-6-luna"
    || escalationConfig.priceBasis.model !== escalationConfig.model)) {
  throw new Error("Evidence escalation requires a distinct model and matching explicit price basis.");
}
if (!observationAgentEnabled && (config.app.intelligence.evidenceV2.autoApplyClasses.includes("task_terminal")
  || (evidenceMode === "apply" && config.app.intelligence.evidenceV2.autoApplyClasses.length > 0
    && config.app.intelligence.evidenceV2.authorityPolicies.length === 0))) {
  throw new Error("Automatic evidence application requires an explicit nonterminal authority policy; terminal application remains disabled.");
}
if (evidenceV2Enabled && (!config.intelligenceApiKey || config.intelligenceModel !== "gpt-6-luna"
  || !evidenceBudgetId || !z.uuid().safeParse(evidenceBudgetId).success
  || !evidenceVersion || !config.jevWorkAllowedVisibilities.length
  || (!observationAgentEnabled && config.app.policy.mode !== "manual_review")
  || config.retrievalProvider !== "postgres" || config.embeddingProvider !== "disabled"
  || (!observationAgentEnabled && (config.app.policy.autoApproveNewTasks || config.app.policy.autoApproveContext
    || !config.app.policy.requireReviewForTaskChanges)))) {
  throw new Error("Evidence v2 requires an explicit budget, version, pinned model, source access and local retrieval (legacy evidence modes also require manual review policy).");
}
if (evidenceV2Enabled) {
  const budget = await store.getInferenceBudget(evidenceBudgetId!);
  if (!budget || budget.state !== "active" || Date.parse(budget.deadline) <= Date.now()
    || budget.reservedCalls !== 0 || budget.spentCalls >= budget.maxCalls) {
    throw new Error("Evidence v2 budget is missing, expired, exhausted, or has unsettled calls.");
  }
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  try {
    const organization = await store.getOrganization();
    const legacy = await pool.query<{ pending: string }>(
      `SELECT count(*)::text AS pending FROM outbox_jobs
        WHERE organization_id=$1 AND state IN ('pending','running')
          AND topic IN ('intelligence.run_requested','adjudication.run_requested')`,
      [organization.id],
    );
    if (Number(legacy.rows[0]?.pending ?? 0) > 0) {
      throw new Error("Drain pending legacy interpretation and adjudication jobs before enabling evidence v2.");
    }
  } finally { await pool.end(); }
}

let notionPoller: NotionPoller | null = null;
if (config.app.notion.enabled) {
  if (!config.notionToken) throw new Error("NOTION_TOKEN is required when the Notion connector is enabled.");
  const installation = await ledger.configureInstallation({
    provider: "notion",
    installationKey: "default",
    displayName: "Notion",
    transport: "poll",
    config: {
      roots: config.app.notion.sources.flatMap((source) => source.resourceId ? [source.resourceId] : []),
      workspaceDiscovery: config.app.notion.sources.some((source) => source.kind === "workspace"),
      apiVersion: config.app.notion.apiVersion,
    },
  }, "system:worker-startup");
  notionPoller = new NotionPoller(
    new NotionClient({ token: config.notionToken, apiVersion: config.app.notion.apiVersion,
      fetch: meteredProviderFetch(store, { provider: "notion", purpose: "source_ingestion" }) }),
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
    throw new Error("SLACK_APP_TOKEN and SLACK_BOT_TOKEN are required when the Slack connector is enabled.");
  }
  const installation = await ledger.configureInstallation({
    provider: "slack",
    installationKey: config.app.slack.installationKey,
    displayName: "Slack",
    transport: "socket_mode",
    config: {
      channels: config.app.slack.channels,
      captureMode: config.app.slack.captureMode,
      captureReactions: config.app.slack.captureReactions,
    },
  }, "system:worker-startup");
  slackInstallationId = installation.id;
  slackAdapter = new SlackCaptureAdapter(
    config.app.slack,
    new SlackWebApiClient(config.slackBotToken,
      meteredProviderFetch(store, { provider: "slack", purpose: "source_ingestion" })),
    intelligence,
    ledger,
  );
  slackSupervisor = new SlackSocketSupervisor({
    appToken: config.slackAppToken,
    adapter: slackAdapter,
    ledger,
    installationId: installation.id,
    fetchImpl: meteredProviderFetch(store, { provider: "slack", purpose: "socket_open" }),
    acquireLease: () => store.acquireSingletonLease(`connector:slack:${installation.id}`, workerId),
    releaseLease: () => store.releaseSingletonLease(`connector:slack:${installation.id}`, workerId),
    log,
  });
}

const handlers = projectionOutboxHandlers(store);
const evidenceDispatchEpoch = `${evidenceVersion}:${evidenceBudgetId}`;
const evidenceDiscovery = evidenceV2Enabled
  ? new EvidenceDiscoverySweep(store, evidenceVersion!,
      config.app.intelligence.evidenceV2.sweepBatchSize,
      evidenceDispatchEpoch, config.app.intelligence.evidenceV2.noClaimSamplePercent) : null;
const workSearchResolver = evidenceV2Enabled && !observationAgentEnabled ? new OpenAIWorkSearchResolver({
  store, apiKey: config.intelligenceApiKey!, model: "gpt-6-luna",
  allowedVisibilities: config.jevWorkAllowedVisibilities,
  priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl: config.intelligenceBaseUrl,
  ...(workEmbeddings ? { embeddings: workEmbeddings } : {}),
}) : null;
const evidencePipeline = evidenceV2Enabled && evidenceMode !== "agent" ? new EvidencePipeline({ store, ledger,
  pipelineVersion: evidenceVersion!,
  policyVersion: config.app.intelligence.evidenceV2.policyVersion,
  maxRequiredCheckpointAgeSeconds: config.app.intelligence.evidenceV2.maxRequiredCheckpointAgeSeconds,
  maxEvidenceExpansions: config.app.intelligence.evidenceV2.maxEvidenceExpansions,
  sourceContext: { allowedVisibilities: config.jevWorkAllowedVisibilities,
    maxEvents: config.app.intelligence.evidenceV2.maxContextObservations,
    maxPayloadBytes: config.app.intelligence.evidenceV2.maxInputTokens },
  extractor: new OpenAIClaimExtractor({ store, apiKey: config.intelligenceApiKey!, model: "gpt-6-luna",
    allowedVisibilities: config.jevWorkAllowedVisibilities,
    priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl: config.intelligenceBaseUrl }),
  identityResolver: workSearchResolver!, contextResolver: workSearchResolver!,
  judge: new OpenAIEvidenceJudge({ store, apiKey: config.intelligenceApiKey!,
    model: "gpt-6-luna", allowedVisibilities: config.jevWorkAllowedVisibilities,
    priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl: config.intelligenceBaseUrl }),
  ...(escalationConfig && config.app.intelligence.evidenceV2.maxEscalations === 1 ? {
    escalation: { modelVersion: escalationConfig.model, maxAttempts: 1 as const,
      identityResolver: new OpenAIWorkSearchResolver({ store,
        apiKey: config.intelligenceApiKey!, model: escalationConfig.model,
        allowedVisibilities: config.jevWorkAllowedVisibilities,
        priceBasis: escalationConfig.priceBasis,
        ...(workEmbeddings ? { embeddings: workEmbeddings } : {}),
        baseUrl: config.intelligenceBaseUrl }),
      judge: new OpenAIEvidenceJudge({ store, apiKey: config.intelligenceApiKey!,
        model: escalationConfig.model, allowedVisibilities: config.jevWorkAllowedVisibilities,
        priceBasis: escalationConfig.priceBasis,
        baseUrl: config.intelligenceBaseUrl }) },
  } : {}),
  ...(config.githubApp ? { artifactVerifier: new GithubCriterionVerifier({ store, ledger,
    client: new GithubAppClient(config.githubApp,
      meteredProviderFetch(store, { provider: "github", purpose: "artifact_verification" })),
    allowedVisibilities: config.jevWorkAllowedVisibilities,
    limits: config.app.intelligence.evidenceV2.artifactLimits }) } : {}),
  application: { mode: evidenceMode,
    autoApplyClasses: config.app.intelligence.evidenceV2.autoApplyClasses,
    authorityPolicies: config.app.intelligence.evidenceV2.authorityPolicies },
}) : null;
const observationAgent = observationAgentEnabled ? new ObservationAgent({ store, ledger, embeddings: workEmbeddings!,
  apiKey: config.intelligenceApiKey!, model: "gpt-6-luna", pipelineVersion: evidenceVersion,
  allowedVisibilities: config.jevWorkAllowedVisibilities,
  priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl: config.intelligenceBaseUrl,
  maxContextEvents: config.app.intelligence.evidenceV2.maxContextObservations,
  maxContextBytes: config.app.intelligence.evidenceV2.maxInputTokens,
}) : null;
const contextSummarizer = evidenceV2Enabled && !observationAgentEnabled ? new OpenAIContextSummarizer({ store,
  apiKey: config.intelligenceApiKey!, model: "gpt-6-luna",
  allowedVisibilities: config.jevWorkAllowedVisibilities,
  priceBasis: GPT6_LUNA_PRICE_2026_10_01, baseUrl: config.intelligenceBaseUrl }) : null;
handlers.set("evidence.source.recorded", async (job) => {
  if (!evidenceDiscovery) return;
  const payload = z.object({ eventId: z.uuid() }).parse(job.payload);
  const event = (await store.getSourceEvents([payload.eventId]))[0];
  if (!event || !config.jevWorkAllowedVisibilities.includes(event.visibility)
    || (!observationAgentEnabled && !(await store.currentSourceEventIds([event.id])).includes(event.id))) return;
  await store.enqueueOutboxJob({ topic: "evidence.source.ready",
    dedupeKey: `evidence:source:${evidenceDispatchEpoch}:${event.id}`,
    payload: { pipelineVersion: evidenceVersion!, eventId: event.id,
      dispatchEpoch: evidenceDispatchEpoch,
      sourceVersionKey: event.observationIdentity?.sourceVersionKey ?? null,
      reason: "source_recorded" } });
});
if (evidenceDiscovery && evidencePipeline) {
  const semanticDiscoveryScores = async (task: Task, claims: EvidenceClaim[],
    evaluationClock: string): Promise<{ scores: ScoredClaim[]; screened: number }> => {
    if (!workEmbeddings || claims.length === 0) return { scores: [], screened: 0 };
    const visible = await visibleAcceptedTasks(store, [task], { kind: "admin" },
      config.jevWorkAllowedVisibilities);
    const taskText = identityText(task);
    const safe = claims.map((claim) => ({ claim, text: claim.body.statement }))
      .filter((item) => item.text.trim() && !containsCredentialLikeText(item.text));
    if (visible.length !== 1 || !taskText.trim() || containsCredentialLikeText(taskText)
      || safe.length === 0) return { scores: [], screened: claims.length };
    const fingerprint = await workEmbeddingPermissionFingerprint(store,
      config.jevWorkAllowedVisibilities, config.app.intelligence.evidenceV2.policyVersion);
    const taskHash = contentHash(taskText);
    let taskVector = await store.getWorkEntityEmbedding({ entityType: "task", entityId: task.id,
      model: workEmbeddings.model, modelVersion: workEmbeddings.modelVersion,
      inputHash: taskHash, permissionFingerprint: fingerprint });
    const vectors = new Map<string, number[]>();
    const missing = [] as typeof safe;
    for (const item of safe) {
      const vector = await store.getWorkEntityEmbedding({ entityType: "claim", entityId: item.claim.id,
        model: workEmbeddings.model, modelVersion: workEmbeddings.modelVersion,
        inputHash: contentHash(item.text), permissionFingerprint: fingerprint });
      if (vector) vectors.set(item.claim.id, vector);
      else missing.push(item);
    }
    if (!taskVector || missing.length > 0) {
      const eventIds = [...new Set(safe.flatMap((item) =>
        item.claim.body.spans.map((span) => span.eventId)))].sort();
      const run = await store.createV2Run({ model: workEmbeddings.model,
        inputHash: contentHash({ taskId: task.id, taskHash,
          claimIds: safe.map((item) => item.claim.id), fingerprint }),
        eventIds, pipelineVersion: evidenceVersion!, promptVersion: "target-discovery-embedding-v1",
        policyVersion: config.app.intelligence.evidenceV2.policyVersion,
        configHash: contentHash({ model: workEmbeddings.model, dimensions: workEmbeddings.dimensions,
          allowedVisibilities: [...config.jevWorkAllowedVisibilities].sort() }),
        replayMode: "cached_reassess", evaluationClock, knowledgeCutoff: null,
        budgetId: evidenceBudgetId!, manifest: { kind: "target_discovery_embedding",
          taskId: task.id, claimIds: safe.map((item) => item.claim.id), eventIds } });
      try {
        if (!taskVector) {
          const [embedded] = await workEmbeddings.embed({ texts: [taskText], runId: run.id,
            budgetId: evidenceBudgetId!, purpose: "documents",
            contextualSourceEventIds: await acceptedTaskSourceEventIds(store, [task]) });
          if (!embedded) throw new Error("Target discovery task vector is missing.");
          taskVector = embedded;
          await store.putWorkEntityEmbedding({ entityType: "task", entityId: task.id,
            model: workEmbeddings.model, modelVersion: workEmbeddings.modelVersion,
            inputHash: taskHash, permissionFingerprint: fingerprint, vector: embedded });
        }
        for (let start = 0; start < missing.length; start += 16) {
          const batch = missing.slice(start, start + 16);
          const embedded = await workEmbeddings.embed({ texts: batch.map((item) => item.text),
            runId: run.id, budgetId: evidenceBudgetId!, purpose: "documents" });
          for (const [index, item] of batch.entries()) {
            const vector = embedded[index];
            if (!vector) throw new Error("Target discovery claim vector is missing.");
            await store.putWorkEntityEmbedding({ entityType: "claim", entityId: item.claim.id,
              model: workEmbeddings.model, modelVersion: workEmbeddings.modelVersion,
              inputHash: contentHash(item.text), permissionFingerprint: fingerprint, vector });
            vectors.set(item.claim.id, vector);
          }
        }
        await store.completeInterpretationRun(run.id, { kind: "target_discovery_embedding",
          taskId: task.id, embeddedClaims: missing.length });
      } catch (error) {
        await store.failInterpretationRun(run.id, "target_discovery_embedding_failed").catch(() => {});
        throw error;
      }
    }
    return { scores: safe.map((item) => ({ id: item.claim.id,
      score: cosineSimilarity(taskVector!, vectors.get(item.claim.id) ?? []) })),
    screened: claims.length - safe.length };
  };
  handlers.set("evidence.supersession.sweep", async (job) => {
    const payload = z.object({ dispatchEpoch: z.string(), afterEventId: z.uuid().nullable() }).parse(job.payload);
    if (payload.dispatchEpoch !== evidenceVersion) return;
    const pairs = await store.listSourceSupersessions(payload.afterEventId, 100);
    for (const pair of pairs) {
      await store.enqueueOutboxJob({ topic: "evidence.source.superseded",
        dedupeKey: `evidence:superseded:${evidenceVersion}:${pair.oldEventId}:${pair.newEventId}:start`,
        payload: { eventId: pair.oldEventId, newEventId: pair.newEventId, afterTaskId: null } });
    }
    if (pairs.length === 100) {
      const cursor = pairs.at(-1)!.newEventId;
      await store.enqueueOutboxJob({ topic: "evidence.supersession.sweep",
        dedupeKey: `evidence:supersession-sweep:${evidenceVersion}:after:${cursor}`,
        payload: { dispatchEpoch: evidenceVersion, afterEventId: cursor } });
    }
  });
  handlers.set("evidence.revocation.sweep", async (job) => {
    const payload = z.object({ dispatchEpoch: z.string(), afterEventId: z.uuid().nullable() }).parse(job.payload);
    if (payload.dispatchEpoch !== evidenceVersion) return;
    const ids = await store.listRevokedSourceEventIds(payload.afterEventId, 100);
    for (const eventId of ids) {
      await store.enqueueOutboxJob({ topic: "evidence.source.revoked",
        dedupeKey: `evidence:revoked:${evidenceVersion}:${eventId}:start`,
        payload: { eventId, afterTaskId: null } });
    }
    if (ids.length === 100) {
      const cursor = ids.at(-1)!;
      await store.enqueueOutboxJob({ topic: "evidence.revocation.sweep",
        dedupeKey: `evidence:revocation-sweep:${evidenceVersion}:after:${cursor}`,
        payload: { dispatchEpoch: evidenceVersion, afterEventId: cursor } });
    }
  });
  const reassessAffectedSource = async (job: { topic: string; payload: unknown }) => {
    const payload = z.object({ eventId: z.uuid(), newEventId: z.uuid().optional(),
      afterTaskId: z.uuid().nullable() }).parse(job.payload);
    if (job.topic === "evidence.source.superseded" && !payload.newEventId) {
      throw new Error("A superseded source job requires the replacement event ID.");
    }
    const sourceKey = job.topic === "evidence.source.superseded"
      ? `superseded:${payload.eventId}:${payload.newEventId}` : `revoked:${payload.eventId}`;
    if (payload.afterTaskId === null) {
      await store.enqueueOutboxJob({ topic: "evidence.context.refresh.scan",
        dedupeKey: `evidence:context:${sourceKey}:${evidenceVersion}:start`,
        payload: { eventId: payload.eventId,
          ...(payload.newEventId ? { newEventId: payload.newEventId } : {}),
          afterEntryId: null } });
    }
    const taskIds = await store.listAffectedTaskIdsBySource(payload.eventId, payload.afterTaskId, 100);
    for (const taskId of taskIds) {
      const task = await store.getTask(taskId);
      if (!task) continue;
      await store.enqueueOutboxJob({ topic: "evidence.task.reassess",
        dedupeKey: `evidence:${sourceKey}:${evidenceDispatchEpoch}:task:${taskId}:${task.version}`,
        payload: { pipelineVersion: evidenceVersion!, taskId,
          taskVersion: task.version, afterClaimId: null } });
    }
    if (taskIds.length === 100) {
      const cursor = taskIds.at(-1)!;
      await store.enqueueOutboxJob({ topic: job.topic,
        dedupeKey: `evidence:${sourceKey}:after:${cursor}`,
        payload: { eventId: payload.eventId, ...(payload.newEventId
          ? { newEventId: payload.newEventId } : {}), afterTaskId: cursor } });
    }
  };
  handlers.set("evidence.source.revoked", reassessAffectedSource);
  handlers.set("evidence.source.superseded", reassessAffectedSource);
  handlers.set("evidence.context.refresh.scan", async (job) => {
    const payload = z.object({ eventId: z.uuid(), newEventId: z.uuid().optional(),
      afterEntryId: z.uuid().nullable() }).parse(job.payload);
    const sourceKey = payload.newEventId
      ? `superseded:${payload.eventId}:${payload.newEventId}` : `revoked:${payload.eventId}`;
    const entryIds = await store.listAffectedContextEntryIdsBySource(
      payload.eventId, payload.afterEntryId, 100);
    for (const entryId of entryIds) {
      await store.enqueueOutboxJob({ topic: "evidence.context.refresh",
        dedupeKey: `evidence:context:${sourceKey}:${evidenceVersion}:entry:${entryId}`,
        payload: { eventId: payload.eventId, entryId,
          ...(payload.newEventId ? { newEventId: payload.newEventId } : {}) } });
    }
    if (entryIds.length === 100) {
      const cursor = entryIds.at(-1)!;
      await store.enqueueOutboxJob({ topic: "evidence.context.refresh.scan",
        dedupeKey: `evidence:context:${sourceKey}:${evidenceVersion}:after:${cursor}`,
        payload: { eventId: payload.eventId,
          ...(payload.newEventId ? { newEventId: payload.newEventId } : {}),
          afterEntryId: cursor } });
    }
  });
  handlers.set("evidence.context.refresh", async (job) => {
    const payload = z.object({ eventId: z.uuid(), entryId: z.uuid(),
      newEventId: z.uuid().optional() }).parse(job.payload);
    let refreshReason = payload.newEventId ? "source_superseded" : "source_revoked";
    if (payload.newEventId) {
      const replacement = (await store.getSourceEvents([payload.newEventId]))[0];
      const oldScope = await store.getSourceEventScope(payload.eventId);
      const sameScope = Boolean(replacement && oldScope
        && replacement.provider === oldScope.provider
        && replacement.installationKey === oldScope.installationKey
        && replacement.visibility === oldScope.visibility
        && (replacement.observationIdentity?.canonicalObjectKey ?? replacement.sourceRef)
          === oldScope.canonicalObjectKey);
      if (!replacement) refreshReason = "replacement_unavailable";
      else if (!sameScope) refreshReason = "replacement_scope_changed";
      else if (!config.jevWorkAllowedVisibilities.includes(replacement.visibility)) {
        refreshReason = "replacement_egress_denied";
      }
      if (replacement && sameScope && config.jevWorkAllowedVisibilities.includes(replacement.visibility)) {
        await store.enqueueOutboxJob({ topic: "evidence.source.ready",
          dedupeKey: `evidence:context-refresh:${evidenceDispatchEpoch}:${replacement.id}`,
          payload: { pipelineVersion: evidenceVersion!, dispatchEpoch: evidenceDispatchEpoch,
            eventId: replacement.id, reason: "context_refresh" } });
        const entry = await store.getContextEntryRefreshTarget(payload.entryId);
        const current = await store.currentSourceEventIds([replacement.id]);
        if (entry?.kind === "file" && entry.evidenceIds.includes(payload.eventId)
          && replacement.eventKind === "source.document.retrieved"
          && current.includes(replacement.id) && contextSummarizer) {
          const clientEventId = `evidence-summary:${contentHash({ entryId: entry.id,
            sourceEventId: replacement.id, sourceVersionKey:
              replacement.observationIdentity?.sourceVersionKey ?? null,
            summarizer: contextSummarizer.name })}`;
          const prior = await store.findProposalByClientEvent("evidence-summary", clientEventId);
          if (!prior) {
            const document = replacement.payload && typeof replacement.payload === "object"
              && !Array.isArray(replacement.payload) ? replacement.payload.document : null;
            const refreshedTitle = document && typeof document === "object"
              && !Array.isArray(document) && typeof document.title === "string"
              ? document.title.slice(0, 200) : "Updated source document";
            const inputHash = contentHash({ kind: "context_summary_refresh",
              clientEventId, sourceEventId: replacement.id,
              sourceVersionKey: replacement.observationIdentity?.sourceVersionKey ?? null });
            const run = await store.createV2Run({ model: contextSummarizer.name,
              inputHash, eventIds: [replacement.id], pipelineVersion: evidenceVersion!,
              promptVersion: contextSummarizer.name,
              policyVersion: config.app.intelligence.evidenceV2.policyVersion,
              configHash: contentHash({ model: "gpt-6-luna", summarizer: contextSummarizer.name,
                allowedVisibilities: [...config.jevWorkAllowedVisibilities].sort() }),
              replayMode: "live", evaluationClock: new Date().toISOString(),
              knowledgeCutoff: null, budgetId: evidenceBudgetId!, manifest: {
                kind: "context_summary_refresh", entryId: entry.id,
                previousSourceEventId: payload.eventId, sourceEventId: replacement.id } });
            try {
              const summary = await contextSummarizer.summarize({ source: replacement,
                runId: run.id, budgetId: evidenceBudgetId! });
              if (!(await store.currentSourceEventIds([replacement.id])).includes(replacement.id)) {
                throw new Error("Context refresh source changed before proposal creation.");
              }
              const proposal = await ledger.proposeContextFile({ clientEventId,
                sourceRef: entry.sourceRef, path: entry.path, title: refreshedTitle,
                body: summary.body, sourceUrl: replacement.sourceUrl,
                rationale: "Source document changed; refreshed summary requires human review.",
                requestedBy: "evidence-summary", evidenceIds: [replacement.id],
                effectiveFrom: replacement.occurredAt });
              await store.completeInterpretationRun(run.id, { kind: "context_summary_refresh",
                sourceEventId: replacement.id, proposalId: proposal.id,
                bodyHash: contentHash(summary.body), omittedSections: summary.omittedSections,
                reusedCall: summary.reusedCall });
            } catch {
              await store.failInterpretationRun(run.id, "context_summary_refresh_unresolved")
                .catch(() => {});
              await store.appendAuditEvent({ actor: "system:evidence-reconciliation",
                action: "evidence.context_refresh_unresolved", targetType: "context_entry",
                targetId: entry.id, sourceEventId: replacement.id, proposalId: null,
                details: { reason: "summary_or_source_unavailable", runId: run.id } });
              throw new Error("Context summary refresh remains unresolved.");
            }
          }
        }
      }
    }
    await store.appendAuditEvent({ actor: "system:evidence-reconciliation",
      action: "evidence.context_refresh_required", targetType: "context_entry",
      targetId: payload.entryId, sourceEventId: payload.eventId, proposalId: null,
      details: { replacementEventId: payload.newEventId ?? null,
        reason: refreshReason,
        refreshJobId: job.id } });
  });
  const verifyTaskProjection = handlers.get("projection.task.revised")!;
  handlers.set("projection.task.revised", async (job) => {
    await verifyTaskProjection(job);
    const payload = z.object({ taskId: z.uuid(), version: z.number().int().positive() }).parse(job.payload);
    await store.enqueueOutboxJob({ topic: "evidence.task.reassess",
      dedupeKey: `evidence:task:${evidenceDispatchEpoch}:${payload.taskId}:${payload.version}:start`,
      payload: { pipelineVersion: evidenceVersion!, taskId: payload.taskId,
        taskVersion: payload.version, afterClaimId: null } });
  });
  handlers.set("evidence.task.reassess", createTaskEvidenceReassessHandler({
    store, evidencePipeline: evidencePipeline!, evidenceVersion: evidenceVersion!,
    evidenceDispatchEpoch, evidenceBudgetId: evidenceBudgetId!,
    policy: config.app.intelligence.evidenceV2,
    intelligenceModel: config.intelligenceModel,
    allowedVisibilities: config.jevWorkAllowedVisibilities,
    semanticDiscoveryEnabled: Boolean(workEmbeddings), semanticDiscoveryScores,
  }));
  // The completed outbox row is a durable, deduplicated search manifest.
  handlers.set("evidence.task.search_manifest", async () => {});
  handlers.set("evidence.discovery.sweep", async (job) => {
    if ((job.payload as { dispatchEpoch?: string }).dispatchEpoch !== evidenceDispatchEpoch) return;
    await evidenceDiscovery.handle(job);
  });
  handlers.set("evidence.source.ready", async (job) => {
    const payload = z.object({ pipelineVersion: z.string(), dispatchEpoch: z.string(),
      eventId: z.uuid(), reason: z.string().optional() }).parse(job.payload);
    if (payload.pipelineVersion !== evidenceVersion || payload.dispatchEpoch !== evidenceDispatchEpoch) return;
    const event = (await store.getSourceEvents([payload.eventId]))[0];
    if (!event || !config.jevWorkAllowedVisibilities.includes(event.visibility)
      || (!observationAgentEnabled && !(await store.currentSourceEventIds([event.id])).includes(event.id))) return;
    await evidencePipeline.run({ eventIds: [event.id], budgetId: evidenceBudgetId!,
      evaluationClock: new Date().toISOString(), knowledgeCutoff: null,
      reopenNoClaim: payload.reason === "no_claim_sample" || payload.reason === "manual_reopen" });
  });
}
if (observationAgent && evidenceDiscovery) {
  // Storage applies source revocations synchronously. Retired reassessment jobs
  // have no semantic role in the single observation workflow.
  for (const topic of ["evidence.supersession.sweep", "evidence.revocation.sweep",
    "evidence.source.revoked", "evidence.source.superseded", "evidence.context.refresh.scan",
    "evidence.context.refresh", "evidence.task.reassess", "evidence.task.search_manifest"]) {
    handlers.set(topic, async () => {});
  }
  handlers.set("evidence.discovery.sweep", async (job) => {
    if ((job.payload as { dispatchEpoch?: string }).dispatchEpoch !== evidenceDispatchEpoch) return;
    await evidenceDiscovery.handle(job);
  });
  handlers.set("evidence.source.ready", async (job) => {
    const payload = z.object({ pipelineVersion: z.string(), dispatchEpoch: z.string(), eventId: z.uuid() }).parse(job.payload);
    if (payload.pipelineVersion !== evidenceVersion || payload.dispatchEpoch !== evidenceDispatchEpoch) return;
    await observationAgent.run({ eventId: payload.eventId, budgetId: evidenceBudgetId! });
  });
}
const githubSync = config.githubApp
  ? new GithubRepositorySync(new GithubAppClient(config.githubApp,
      meteredProviderFetch(store, { provider: "github", purpose: "source_ingestion" })), ledger, intelligence)
  : null;
if (notionPoller) handlers.set("connector.notion.sync_requested", async () => { await notionPoller!.sync(); });
if (githubSync) handlers.set("connector.github.sync_requested", async (job) => {
  const payload = z.object({ installationId: z.string().uuid() }).parse(job.payload);
  await githubSync.syncInstallation(payload.installationId);
});
if (!evidenceV2Enabled && intelligence.isConfigured()) handlers.set("intelligence.run_requested", async (job) => {
  const payload = intelligenceRunPayloadSchema.parse(job.payload);
  await intelligence.run({ eventIds: payload.eventIds });
});
if (!evidenceV2Enabled && adjudicator.isConfigured()) handlers.set("adjudication.run_requested", async () => { await adjudicator.run(); });
const dispatcher = new OutboxDispatcher(store, {
  ...workerConfig,
  leaseSeconds: evidenceV2Enabled ? Math.max(workerConfig.leaseSeconds, 1800) : workerConfig.leaseSeconds,
  workerId,
  handlers,
  log,
});

const githubQueue = githubSync ? new OutboxQueue(store) : null;
const scheduleGithubSync = async () => {
  if (!githubQueue) return;
  const installations = (await ledger.workspace()).installations.filter((installation) =>
    installation.provider === "github" && installation.status !== "revoked" && installation.status !== "disabled");
  const bucket = Math.floor(Date.now() / (15 * 60_000));
  for (const installation of installations) {
    await githubQueue.enqueue("connector.github.sync_requested",
      `github-periodic:${installation.id}:${bucket}`, { installationId: installation.id });
  }
};
// Sweep each minute so a restart late in a bucket cannot delay the next sync
// by almost 30 minutes. The bucketed outbox key still enqueues only once/15m.
const githubTimer = githubSync ? setInterval(() => {
  void scheduleGithubSync().catch((error) => log.error("GitHub reconciliation scheduling failed.", { error: String(error) }));
}, 60_000) : null;
if (githubSync) await scheduleGithubSync();

const workAllowed = config.jevWorkAllowedVisibilities.filter((visibility) =>
  config.workDraftAllowedVisibilities.includes(visibility));
const workJudge = config.jevApiKey && workAllowed.length
  ? new JevWorkJudge({ apiKey: config.jevApiKey, allowedVisibilities: workAllowed,
      fetcher: meteredExternalFetch(store, { provider: "openrouter", purpose: "work_judge" }) }) : null;
const workDrafter = config.intelligenceApiKey && config.intelligenceModel && workAllowed.length
  ? new OpenAIWorkProseDrafter({ apiKey: config.intelligenceApiKey,
      model: config.intelligenceModel, baseUrl: config.intelligenceBaseUrl,
      allowedVisibilities: workAllowed,
      fetcher: meteredExternalFetch(store, { provider: "openai", purpose: "work_prose" }) }) : null;
const workSuggestions = !evidenceV2Enabled && !intelligence.isConfigured()
  && process.env.WORK_SUGGESTIONS_ENABLED === "true" && workJudge && workDrafter
  ? new WorkSuggestionEngine(store, ledger, workJudge, workDrafter, workAllowed, true)
  : null;
// The six-case live shadow pilot could not establish task identity and status
// reliably. Keep this generic scanner available for a later calibrated rollout.
const statusSuggestions = !evidenceV2Enabled && process.env.WORK_STATUS_SUGGESTIONS_ENABLED === "true" && workJudge && workDrafter
  ? new TaskStatusSuggestionEngine(store, ledger, workJudge, workDrafter, workAllowed)
  : null;
let workSuggestionRunning = false;
const scanWorkSuggestions = async (limit = 3) => {
  if (!workSuggestions || workSuggestionRunning) return;
  workSuggestionRunning = true;
  try {
    const reports = await workSuggestions.run(undefined, limit);
    for (const report of reports) {
      if (report.outcome === "failed") log.error("Work suggestion failed.", report);
      else if (report.outcome === "proposal") log.info("Work suggestion needs review.", report);
      else if (report.outcome === "accepted") log.info("Source-backed Task created.", report);
    }
  } catch (error) {
    log.error("Work suggestion scan failed.", { error: String(error) });
  } finally { workSuggestionRunning = false; }
};
const workSuggestionTimer = workSuggestions ? setInterval(() => void scanWorkSuggestions(), 15 * 60_000) : null;
if (workSuggestions) void scanWorkSuggestions(40);
let statusSuggestionRunning = false;
const scanStatusSuggestions = async () => {
  if (!statusSuggestions || statusSuggestionRunning) return;
  statusSuggestionRunning = true;
  try {
    const reports = await statusSuggestions.run();
    for (const report of reports) {
      if (report.outcome === "failed") log.error("Task status suggestion failed.", report);
      else if (report.outcome === "proposal") log.info("Task status needs review.", report);
    }
  } catch (error) {
    log.error("Task status scan failed.", { error: String(error) });
  } finally { statusSuggestionRunning = false; }
};
const statusSuggestionTimer = statusSuggestions ? setInterval(() => void scanStatusSuggestions(), 15 * 60_000) : null;
if (statusSuggestions) void scanStatusSuggestions();
const reconciliation = !evidenceV2Enabled && intelligence.isConfigured() && config.app.intelligence.reconciliationEnabled
  ? new ContinuousReconciliationLoop(store, ledger, intelligence, {
      intervalSeconds: config.app.intelligence.reconciliationIntervalSeconds,
      minimumAgeSeconds: config.app.intelligence.reconciliationMinimumAgeSeconds,
      log,
    })
  : null;

dispatcher.start();
const scheduleEvidenceDiscovery = async () => {
  if (evidenceDiscovery) await evidenceDiscovery.schedule(new Date().toISOString().slice(0, 10));
};
if (evidenceDiscovery) await scheduleEvidenceDiscovery();
if (evidencePipeline) await store.enqueueOutboxJob({ topic: "evidence.revocation.sweep",
  dedupeKey: `evidence:revocation-sweep:${evidenceVersion}:start`,
  payload: { dispatchEpoch: evidenceVersion, afterEventId: null } });
if (evidencePipeline) await store.enqueueOutboxJob({ topic: "evidence.supersession.sweep",
  dedupeKey: `evidence:supersession-sweep:${evidenceVersion}:start`,
  payload: { dispatchEpoch: evidenceVersion, afterEventId: null } });
const evidenceDiscoveryTimer = evidenceDiscovery ? setInterval(() => {
  void scheduleEvidenceDiscovery().catch((error) => log.error("Evidence discovery scheduling failed.", { error: String(error) }));
}, 60_000) : null;
const embeddingIndexer = embedding
  ? new ContextEmbeddingIndexer(store, embedding.index, embedding.adapter, log)
  : null;
embeddingIndexer?.start();
notionPoller?.start();
if (slackAdapter && slackInstallationId) {
  await syncSlackMemberDirectory({ adapter: slackAdapter, ledger, installationId: slackInstallationId, log });
}
if (slackAdapter && config.app.slack?.captureMode === "all_messages") {
  try {
    const report = await slackAdapter.backfill();
    if (report.errors.length > 0) {
      log.error("Slack channel history backfill completed with inaccessible channels.", report);
    } else {
      log.info("Slack channel history backfill completed.", report);
    }
  } catch (error) {
    log.error("Slack channel history backfill failed; Socket Mode will still start.", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
if (!evidenceV2Enabled) { intelligence.start(); adjudicator.start(); }
reconciliation?.start();
slackSupervisor?.start();
log.info("Panini worker started.", {
  workerId,
  notion: Boolean(notionPoller),
  slack: Boolean(slackSupervisor),
  intelligence: intelligence.isConfigured(),
  adjudication: adjudicator.isConfigured(),
  workSuggestions: Boolean(workSuggestions),
  statusSuggestions: Boolean(statusSuggestions),
  reconciliation: Boolean(reconciliation),
  evidenceV2: evidenceV2Enabled,
});

// A failed database probe does not refresh the heartbeat. The container becomes unhealthy.
const heartbeat = async () => {
  try {
    await store.getOrganization();
    await writeFile("/tmp/panini-worker-heartbeat", new Date().toISOString(), { mode: 0o600 });
  } catch (error) { log.error("Worker health probe failed.", { error: String(error) }); }
};
await heartbeat();
const heartbeatTimer = setInterval(() => void heartbeat(), 30_000);

let shuttingDown = false;
const shutdown = async (signal: string) => {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(heartbeatTimer);
  log.info("Panini worker stopping.", { signal });
  notionPoller?.stop();
  if (githubTimer) clearInterval(githubTimer);
  if (evidenceDiscoveryTimer) clearInterval(evidenceDiscoveryTimer);
  if (workSuggestionTimer) clearInterval(workSuggestionTimer);
  if (statusSuggestionTimer) clearInterval(statusSuggestionTimer);
  intelligence.stop();
  adjudicator.stop();
  reconciliation?.stop();
  slackSupervisor?.stop();
  await dispatcher.stop();
  await embeddingIndexer?.stop();
  await embedding?.index.close();
  await store.close();
};
process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));
