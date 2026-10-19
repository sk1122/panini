import type { ContextFile } from "../domain/types.js";
import type { ContextEmbeddingIndex } from "./context-embedding-index.js";
import type { EmbeddingAdapter } from "./embedding-adapter.js";
import { containsCredentialLikeText } from "./external-text-policy.js";

export interface SemanticDocumentRanker {
	readonly model: string;
	rank(
		question: string,
		authorizedFiles: ContextFile[],
	): Promise<Map<string, number>>;
}

/** Locates accepted files only; the context compiler still decides access and content. */
export class EmbeddingDocumentRanker implements SemanticDocumentRanker {
	constructor(
		private readonly index: Pick<ContextEmbeddingIndex, "search">,
		private readonly adapter: EmbeddingAdapter,
	) {}

	get model(): string {
		return this.adapter.model;
	}

	async rank(
		question: string,
		authorizedFiles: ContextFile[],
	): Promise<Map<string, number>> {
		if (authorizedFiles.length === 0 || !question.trim()) return new Map();
		if (containsCredentialLikeText(question))
			throw new Error("Embedding credential screen blocked the query.");

		const queryVector = this.adapter.embedQuery
			? await this.adapter.embedQuery(question.slice(0, 12_000))
			: (await this.adapter.embed([question.slice(0, 12_000)]))[0];

		if (!queryVector)
			throw new Error("The embedding adapter returned no query vector.");
		return this.index.search(
			this.adapter.model,
			queryVector,
			authorizedFiles,
		);
	}
}
