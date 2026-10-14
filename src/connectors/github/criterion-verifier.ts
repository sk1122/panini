import { contentHash } from "../../domain/content-hash.js";
import type { LedgerStore } from "../../domain/store.js";
import type { TeamLedger } from "../../domain/team-ledger.js";
import type { OutcomeCriterion } from "../../domain/evidence-types.js";
import type { Task } from "../../domain/types.js";
import { acceptedTaskSourceEventIds } from "../../domain/accepted-source-access.js";
import type { GithubAppClient } from "./app-client.js";
import { GithubEvidenceVerifier } from "./evidence-verifier.js";

function target(refs: readonly string[]): { repository: string; pullNumber: number; sha: string } | null {
  const shas = refs.filter((ref) => /^[0-9a-f]{40}$/i.test(ref));
  const pulls = refs.flatMap((ref) => {
    const match = ref.match(/^https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/pull\/(\d+)\/?$/)
      ?? ref.match(/^github:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+):pull:(\d+)$/);
    return match ? [{ repository: match[1]!, pullNumber: Number(match[2]) }] : [];
  });
  return shas.length === 1 && pulls.length === 1 && Number.isSafeInteger(pulls[0]!.pullNumber)
    ? { ...pulls[0]!, sha: shas[0]!.toLowerCase() } : null;
}

/** Read-only, exact-revision verification for an accepted outcome criterion. */
export class GithubCriterionVerifier {
  constructor(private readonly options: { store: LedgerStore; ledger: TeamLedger;
    client: GithubAppClient; allowedVisibilities: readonly string[];
    limits?: { requests: number; files: number; bytes: number; contextTokens: number } }) {}

  async verify(input: { task: Task; criterion: OutcomeCriterion; runId: string; budgetId: string }): Promise<{
    sourceEventId: string | null; reasonCodes: string[];
  }> {
    if (!["check_passed", "merged", "deployed"].includes(input.criterion.evidenceRule.kind)) {
      return { sourceEventId: null, reasonCodes: ["unsupported_verification_rule"] };
    }
    const parsed = target(input.criterion.evidenceRule.artifactRefs);
    if (!parsed) return { sourceEventId: null, reasonCodes: ["exact_pull_and_sha_required"] };
    const visibility = `github:repository:${parsed.repository.toLowerCase()}`;
    if (!this.options.allowedVisibilities.includes(visibility)) {
      return { sourceEventId: null, reasonCodes: ["verification_egress_not_authorized"] };
    }
    const contextualSourceEventIds = await acceptedTaskSourceEventIds(this.options.store, [input.task]);
    const [contextEvents, currentIds] = await Promise.all([
      this.options.store.getSourceEvents(contextualSourceEventIds),
      this.options.store.currentSourceEventIds(contextualSourceEventIds),
    ]);
    const current = new Set(currentIds);
    if (contextEvents.length !== contextualSourceEventIds.length
      || contextEvents.some((event) => !current.has(event.id)
        || !this.options.allowedVisibilities.includes(event.visibility))) {
      return { sourceEventId: null, reasonCodes: ["verification_context_not_authorized"] };
    }
    const installations = (await this.options.ledger.workspace()).installations.filter((installation) =>
      installation.provider === "github" && installation.status !== "revoked"
        && installation.status !== "disabled");
    const mapped = installations.flatMap((installation) => {
      const config = installation.config;
      if (typeof config.installationId !== "number" || !Array.isArray(config.repositories)
        || !Array.isArray(config.repositoryIds)) return [];
      const index = config.repositories.findIndex((name) => typeof name === "string"
        && name.toLowerCase() === parsed.repository.toLowerCase());
      const repositoryId = config.repositoryIds[index];
      return index >= 0 && typeof repositoryId === "number"
        ? [{ installation, installationId: config.installationId, repositoryId }] : [];
    });
    if (mapped.length !== 1) return { sourceEventId: null,
      reasonCodes: [mapped.length === 0 ? "repository_installation_missing" : "repository_installation_ambiguous"] };
    const mapping = mapped[0]!;
    const request = { repository: parsed.repository, pullNumber: parsed.pullNumber,
      requiredHeadSha: parsed.sha, requiredChecks: input.criterion.evidenceRule.requiredCheckNames,
      requireMerge: input.criterion.evidenceRule.kind !== "check_passed",
      requiredDeploymentEnvironment: input.criterion.evidenceRule.kind === "deployed"
        ? input.criterion.evidenceRule.requiredEnvironment : null,
      installationId: mapping.installationId, criterionId: input.criterion.id };
    const reservation = await this.options.store.reserveModelCall({ budgetId: input.budgetId,
      runId: input.runId, purpose: "artifact_fetch",
      logicalCallKey: contentHash({ runId: input.runId, request }), attempt: 1,
      provider: "github", model: "github-rest", requestHash: contentHash(request),
      request, cacheKey: null, contextualSourceEventIds,
      estimatedInputTokens: 0, estimatedOutputTokens: 0,
      estimatedUsd: "0.00000000" });
    if (reservation.kind === "exhausted") return { sourceEventId: null,
      reasonCodes: ["verification_budget_exhausted"] };
    if (reservation.call.state !== "reserved") return { sourceEventId: null,
      reasonCodes: ["verification_call_already_dispatched"] };
    await this.options.store.markModelCallDispatched(reservation.call.id, new Date().toISOString());
    try {
      const token = await this.options.client.installationToken(mapping.installationId, [mapping.repositoryId]);
      const verifier = new GithubEvidenceVerifier({ client: this.options.client,
        store: this.options.store, installationKey: mapping.installation.installationKey,
        ...(this.options.limits ? { maxRequests: Math.max(0, this.options.limits.requests - 1),
          maxFiles: this.options.limits.files, maxBytes: this.options.limits.bytes,
          maxContextTokens: this.options.limits.contextTokens } : {}) });
      const result = await verifier.verify({ ...request, token });
      await this.options.store.settleModelCall({ callId: reservation.call.id,
        state: "succeeded", providerRequestId: null, resolvedModelVersion: null,
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, embeddingItems: null,
        costUsd: "0.00000000", costBasis: "known_zero", errorCode: null,
        response: { state: result.state, reasonCodes: result.reasonCodes,
          requestCount: result.requestCount + 1, installationTokenRequests: 1,
          sourceEventId: result.sourceEventId },
        finishedAt: new Date().toISOString() });
      return { sourceEventId: result.sourceEventId, reasonCodes: result.reasonCodes };
    } catch {
      await this.options.store.settleModelCall({ callId: reservation.call.id,
        state: "failed", providerRequestId: null, resolvedModelVersion: null,
        inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, embeddingItems: null,
        costUsd: "0.00000000", costBasis: "known_zero", errorCode: "artifact_fetch_failed",
        response: null, finishedAt: new Date().toISOString() });
      return { sourceEventId: null, reasonCodes: ["artifact_fetch_failed"] };
    }
  }
}
