import { fetchProvider } from "./provider-fetch.js";
import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import type { JsonValue } from "../domain/types.js";
import { containsCredentialLikeText } from "../retrieval/external-text-policy.js";
import type { WorkEmbeddings } from "./work-embeddings.js";

export const VOYAGE4_PRICE_2026_10_02 = {
	id: "openrouter-voyageai-voyage-4-2026-10-02",
	model: "voyageai/voyage-4",
	inputUsdPerMillion: 0.06,
	sourceUrl: "https://openrouter.ai/voyageai/voyage-4",
} as const;

function usd(tokens: number, reserve: boolean): string {
	const amount =
		(tokens *
			VOYAGE4_PRICE_2026_10_02.inputUsdPerMillion *
			(reserve ? 1.25 : 1)) /
		1_000_000;

	return (Math.ceil(amount * 100_000_000) / 100_000_000).toFixed(8);
}

/** Budgeted Voyage 4 embeddings through the configured OpenRouter account. */
export class BudgetedVoyageEmbeddings implements WorkEmbeddings {
	readonly model = VOYAGE4_PRICE_2026_10_02.model;
	readonly modelVersion = VOYAGE4_PRICE_2026_10_02.model;
	readonly dimensions = 1024;
	private readonly fetcher: typeof fetch;
	private readonly endpoint: string;

	constructor(
		private readonly options: {
			store: LedgerStore;
			apiKey: string;
			fetcher?: typeof fetch;
			endpoint?: string;
			timeoutMs?: number;
		},
	) {
		if (!options.apiKey)
			throw new Error("Voyage 4 requires an OpenRouter API key.");
		this.fetcher = (input, init) =>
			fetchProvider(input, init, options.fetcher ?? fetch);
		this.endpoint =
			options.endpoint ?? "https://openrouter.ai/api/v1/embeddings";
	}

	async embed(input: {
		texts: string[];
		runId: string;
		budgetId: string;
		purpose: "query" | "documents";
		contextualSourceEventIds?: string[];
	}): Promise<number[][]> {
		if (
			input.texts.length < 1 ||
			input.texts.length > 128 ||
			input.texts.some(
				(text) => !text.trim() || containsCredentialLikeText(text),
			)
		) {
			throw new Error(
				"Voyage 4 input is empty, sensitive, or exceeds the batch size.",
			);
		}

		const request = {
			model: this.model,
			input: input.texts,
			input_type:
				input.purpose === "query" ? "search_query" : "search_document",
		};
		// Recover paid results even if only part of the document cache was saved.
		const recovered = new Map<string, number[]>();

		for (const call of await this.options.store.listModelCalls(
			input.runId,
		)) {
			if (
				call.purpose !== "embed" ||
				call.model !== this.model ||
				call.state !== "succeeded"
			)
				continue;

			const saved = await this.options.store.getModelCallResponseByKey(
				call.logicalCallKey,
			);
			const response = saved?.response as {
				purpose?: string;
				inputHashes?: string[];
				vectors?: number[][];
			} | null;

			if (
				response?.purpose !== input.purpose ||
				!Array.isArray(response.inputHashes) ||
				!Array.isArray(response.vectors)
			)
				continue;
			for (const [index, hash] of response.inputHashes.entries()) {
				const vector = response.vectors[index];

				if (
					Array.isArray(vector) &&
					vector.length === this.dimensions &&
					vector.every(
						(value) =>
							typeof value === "number" && Number.isFinite(value),
					) &&
					vector.some((value) => value !== 0)
				)
					recovered.set(hash, vector);
			}
		}

		const cached = input.texts.map((text) =>
			recovered.get(contentHash(text)),
		);

		if (cached.every((vector) => vector !== undefined))
			return cached as number[][];

		const estimatedInputTokens = Buffer.byteLength(
			JSON.stringify(request),
			"utf8",
		);
		const reservation = await this.options.store.reserveModelCall({
			budgetId: input.budgetId,
			runId: input.runId,
			purpose: "embed",
			logicalCallKey: contentHash({
				runId: input.runId,
				purpose: input.purpose,
				model: this.model,
				texts: input.texts,
				contextualSourceEventIds: input.contextualSourceEventIds ?? [],
			}),
			attempt: 1,
			provider: "openrouter",
			model: this.model,
			requestHash: contentHash(request),
			request: request as JsonValue,
			contextualSourceEventIds: input.contextualSourceEventIds ?? [],
			cacheKey: null,
			estimatedInputTokens,
			estimatedOutputTokens: 0,
			estimatedUsd: usd(estimatedInputTokens, true),
		});

		if (reservation.kind === "exhausted")
			throw new Error(`Voyage 4 budget exhausted: ${reservation.reason}`);
		if (reservation.call.state !== "reserved")
			throw new Error("Voyage 4 call was already dispatched.");
		await this.options.store.markModelCallDispatched(
			reservation.call.id,
			new Date().toISOString(),
		);

		let body: unknown;

		try {
			const response = await this.fetcher(this.endpoint, {
				method: "POST",
				headers: {
					authorization: `Bearer ${this.options.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(this.options.timeoutMs ?? 30_000),
			});

			if (!response.ok) {
				const failure = new Error(
					`Voyage 4 embedding failed: HTTP ${response.status}`,
				);

				failure.name = `provider_http_${response.status}`;
				throw failure;
			}
			body = await response.json();
		} catch (error) {
			await this.options.store.settleModelCall({
				callId: reservation.call.id,
				state: "unknown",
				providerRequestId: null,
				resolvedModelVersion: null,
				inputTokens: null,
				cachedInputTokens: null,
				outputTokens: null,
				embeddingItems: null,
				costUsd: null,
				costBasis: "unknown",
				errorCode:
					error instanceof Error ? error.name : "provider_error",
				response: null,
				finishedAt: new Date().toISOString(),
			});
			throw error;
		}

		const result = body as {
			id?: unknown;
			model?: unknown;
			data?: unknown;
			usage?: { prompt_tokens?: unknown };
		};
		const inputTokens =
			typeof result.usage?.prompt_tokens === "number" &&
			Number.isSafeInteger(result.usage.prompt_tokens)
				? result.usage.prompt_tokens
				: null;
		const routedModel = this.model.split("/").at(-1);
		const valid =
			(result.model === this.model || result.model === routedModel) &&
			Array.isArray(result.data) &&
			result.data.length === input.texts.length;
		const vectors: number[][] = Array.from({ length: input.texts.length });

		if (valid) {
			for (const item of result.data as unknown[]) {
				if (!item || typeof item !== "object") break;

				const { index, embedding } = item as {
					index?: unknown;
					embedding?: unknown;
				};

				if (
					!Number.isInteger(index) ||
					(index as number) < 0 ||
					(index as number) >= vectors.length ||
					vectors[index as number] ||
					!Array.isArray(embedding) ||
					embedding.length !== this.dimensions ||
					embedding.some(
						(value) =>
							typeof value !== "number" ||
							!Number.isFinite(value),
					) ||
					!embedding.some((value) => value !== 0)
				)
					break;
				vectors[index as number] = embedding as number[];
			}
		}

		const complete =
			valid &&
			vectors.every((vector) => vector?.length === this.dimensions);

		await this.options.store.settleModelCall({
			callId: reservation.call.id,
			state: complete && inputTokens !== null ? "succeeded" : "unknown",
			providerRequestId: typeof result.id === "string" ? result.id : null,
			resolvedModelVersion:
				typeof result.model === "string" ? result.model : null,
			inputTokens,
			cachedInputTokens: 0,
			outputTokens: complete ? 0 : null,
			embeddingItems: complete ? vectors.length : null,
			costUsd: inputTokens === null ? null : usd(inputTokens, false),
			costBasis: inputTokens === null ? "unknown" : "estimated",
			errorCode: complete ? null : "invalid_embedding_response",
			response: {
				model: typeof result.model === "string" ? result.model : null,
				dimensions: complete ? this.dimensions : null,
				itemCount: complete ? vectors.length : null,
				purpose: input.purpose,
				inputHashes: input.texts.map((text) => contentHash(text)),
				vectors: complete ? vectors : null,
			},
			finishedAt: new Date().toISOString(),
		});
		if (!complete || inputTokens === null)
			throw new Error("Voyage 4 embedding response was incomplete.");
		return vectors;
	}
}
