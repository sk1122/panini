import type { EmbeddingAdapter } from "./embedding-adapter.js";

export interface OpenRouterEmbeddingOptions {
	apiKey: string;
	model?: string;
	fetcher?: typeof fetch;
	endpoint?: string;
	timeoutMs?: number;
}

/** OpenRouter's embedding transport. It never owns Panini's document or access rules. */
export class OpenRouterEmbeddingAdapter implements EmbeddingAdapter {
	readonly model: string;
	private readonly fetcher: typeof fetch;
	private readonly endpoint: string;
	private readonly timeoutMs: number;

	constructor(private readonly options: OpenRouterEmbeddingOptions) {
		if (!options.apiKey)
			throw new Error("An OpenRouter API key is required.");
		this.model = options.model ?? "voyageai/voyage-4";
		this.fetcher = options.fetcher ?? fetch;
		this.endpoint =
			options.endpoint ?? "https://openrouter.ai/api/v1/embeddings";
		this.timeoutMs = options.timeoutMs ?? 20_000;
	}

	async embed(texts: readonly string[]): Promise<number[][]> {
		return this.request(texts);
	}

	async embedQuery(text: string): Promise<number[]> {
		const [vector] = await this.request([text], "search_query");

		if (!vector) throw new Error("OpenRouter returned no query embedding.");
		return vector;
	}

	async embedDocuments(texts: readonly string[]): Promise<number[][]> {
		return this.request(texts, "search_document");
	}

	private async request(
		texts: readonly string[],
		inputType?: "search_query" | "search_document",
	): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (
			texts.length > 16 ||
			texts.some((text) => !text.trim() || text.length > 12_000)
		) {
			throw new Error(
				"Embedding input exceeds the adapter's batch or text limit.",
			);
		}

		const response = await this.fetcher(this.endpoint, {
			method: "POST",
			headers: {
				authorization: `Bearer ${this.options.apiKey}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				model: this.model,
				input: texts,
				...(inputType ? { input_type: inputType } : {}),
			}),
			signal: AbortSignal.timeout(this.timeoutMs),
		});

		if (!response.ok)
			throw new Error(
				`OpenRouter embedding request failed: HTTP ${response.status}`,
			);

		const body = (await response.json()) as {
			model?: unknown;
			data?: unknown;
		};
		// OpenRouter can report the routed model without its provider prefix.
		const responseModel = this.model.split("/").at(-1);

		if (
			(body.model !== this.model && body.model !== responseModel) ||
			!Array.isArray(body.data) ||
			body.data.length !== texts.length
		) {
			throw new Error(
				"OpenRouter returned an unexpected embedding model or count.",
			);
		}

		const vectors: number[][] = Array.from({ length: texts.length });

		for (const item of body.data) {
			if (!item || typeof item !== "object")
				throw new Error(
					"OpenRouter returned an invalid embedding item.",
				);

			const { index, embedding } = item as {
				index?: unknown;
				embedding?: unknown;
			};

			if (
				!Number.isInteger(index) ||
				(index as number) < 0 ||
				(index as number) >= texts.length ||
				vectors[index as number] ||
				!Array.isArray(embedding) ||
				embedding.length === 0 ||
				embedding.length > 16_384 ||
				embedding.some(
					(value) =>
						typeof value !== "number" || !Number.isFinite(value),
				) ||
				!embedding.some((value) => value !== 0)
			) {
				throw new Error(
					"OpenRouter returned an invalid embedding vector.",
				);
			}
			vectors[index as number] = embedding as number[];
		}

		const dimensions = vectors[0]?.length;

		if (
			!dimensions ||
			vectors.some((vector) => vector?.length !== dimensions)
		) {
			throw new Error(
				"OpenRouter returned missing or inconsistent embedding dimensions.",
			);
		}
		return vectors;
	}
}
