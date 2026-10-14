import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import type { JsonValue } from "../domain/types.js";
import { containsCredentialLikeText } from "../retrieval/external-text-policy.js";

export const WORK_EMBEDDING_PRICE_2026_10_01 = {
  id: "openai-text-embedding-3-small-2026-10-01",
  inputUsdPerMillion: 0.02,
  sourceUrl: "https://developers.openai.com/api/docs/models/text-embedding-3-small",
} as const;

export interface WorkEmbeddings {
  readonly model: string;
  readonly modelVersion: string;
  readonly dimensions: number;
  embed(input: { texts: string[]; runId: string; budgetId: string;
    purpose: "query" | "documents"; contextualSourceEventIds?: string[] }): Promise<number[][]>;
}

function usd(tokens: number, reserve: boolean): string {
  const value = tokens * WORK_EMBEDDING_PRICE_2026_10_01.inputUsdPerMillion
    * (reserve ? 1.25 : 1) / 1_000_000;
  return (Math.ceil(value * 100_000_000) / 100_000_000).toFixed(8);
}

/** Embedding calls share the v2 run budget and never store vectors in model-call logs. */
export class BudgetedWorkEmbeddings implements WorkEmbeddings {
  readonly model = "text-embedding-3-small";
  readonly modelVersion = "text-embedding-3-small";
  readonly dimensions = 256;
  private readonly fetcher: typeof fetch;
  private readonly baseUrl: string;

  constructor(private readonly options: { store: LedgerStore; apiKey: string;
    baseUrl?: string; fetcher?: typeof fetch; timeoutMs?: number }) {
    this.fetcher = options.fetcher ?? fetch;
    this.baseUrl = (options.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "");
  }

  async embed(input: { texts: string[]; runId: string; budgetId: string;
    purpose: "query" | "documents"; contextualSourceEventIds?: string[] }): Promise<number[][]> {
    if (input.texts.length < 1 || input.texts.length > 16
      || input.texts.some((value) => !value.trim() || Buffer.byteLength(value, "utf8") > 8_000
        || containsCredentialLikeText(value))) {
      throw new Error("Work embedding input exceeds its bounded batch or text limit.");
    }
    const request = { model: this.model, input: input.texts, encoding_format: "float",
      dimensions: this.dimensions };
    const estimatedInputTokens = Buffer.byteLength(JSON.stringify(request), "utf8");
    const reservation = await this.options.store.reserveModelCall({ budgetId: input.budgetId,
      runId: input.runId, purpose: "embed",
      logicalCallKey: contentHash({ runId: input.runId, purpose: input.purpose,
        model: this.model, dimensions: this.dimensions, texts: input.texts,
        contextualSourceEventIds: input.contextualSourceEventIds ?? [] }),
      attempt: 1, provider: "openai", model: this.model,
      requestHash: contentHash(request), request: request as JsonValue,
      contextualSourceEventIds: input.contextualSourceEventIds ?? [],
      cacheKey: null, estimatedInputTokens, estimatedOutputTokens: 0,
      estimatedUsd: usd(estimatedInputTokens, true) });
    if (reservation.kind === "exhausted") throw new Error(`Work embedding budget exhausted: ${reservation.reason}`);
    if (reservation.call.state !== "reserved") throw new Error("Work embedding call was already dispatched.");
    await this.options.store.markModelCallDispatched(reservation.call.id, new Date().toISOString());
    let body: unknown;
    try {
      const response = await this.fetcher(`${this.baseUrl}/embeddings`, { method: "POST",
        headers: { authorization: `Bearer ${this.options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(request), signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000) });
      if (!response.ok) throw new Error(`OpenAI work embedding failed: HTTP ${response.status}`);
      body = await response.json();
    } catch (error) {
      await this.options.store.settleModelCall({ callId: reservation.call.id,
        state: "unknown", providerRequestId: null, resolvedModelVersion: null,
        inputTokens: null, cachedInputTokens: null, outputTokens: null,
        embeddingItems: null, costUsd: null, costBasis: "unknown",
        errorCode: error instanceof Error ? error.name : "provider_error",
        response: null, finishedAt: new Date().toISOString() });
      throw error;
    }
    const result = body as { model?: unknown; data?: unknown;
      usage?: { prompt_tokens?: unknown; total_tokens?: unknown } };
    const inputTokens = typeof result.usage?.prompt_tokens === "number"
      && Number.isSafeInteger(result.usage.prompt_tokens)
      ? result.usage.prompt_tokens : null;
    const valid = result.model === this.model && Array.isArray(result.data)
      && result.data.length === input.texts.length;
    const vectors: number[][] = Array.from({ length: input.texts.length });
    if (valid) {
      for (const item of result.data as unknown[]) {
        if (!item || typeof item !== "object") break;
        const { index, embedding } = item as { index?: unknown; embedding?: unknown };
        if (!Number.isInteger(index) || (index as number) < 0
          || (index as number) >= vectors.length || vectors[index as number]
          || !Array.isArray(embedding) || embedding.length !== this.dimensions
          || embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))
          || !embedding.some((value) => value !== 0)) break;
        vectors[index as number] = embedding as number[];
      }
    }
    const complete = valid && vectors.every((vector) => vector?.length === this.dimensions);
    await this.options.store.settleModelCall({ callId: reservation.call.id,
      state: complete && inputTokens !== null ? "succeeded" : "unknown",
      providerRequestId: null, resolvedModelVersion: typeof result.model === "string" ? result.model : null,
      inputTokens, cachedInputTokens: 0, outputTokens: complete ? 0 : null,
      embeddingItems: complete ? vectors.length : null,
      costUsd: inputTokens === null ? null : usd(inputTokens, false),
      costBasis: inputTokens === null ? "unknown" : "estimated",
      errorCode: complete ? null : "invalid_embedding_response",
      response: { model: typeof result.model === "string" ? result.model : null,
        dimensions: complete ? this.dimensions : null, itemCount: complete ? vectors.length : null },
      finishedAt: new Date().toISOString() });
    if (!complete || inputTokens === null) throw new Error("OpenAI work embedding response was incomplete.");
    return vectors;
  }
}
