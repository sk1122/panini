/** The provider seam for both document and query vectors. One adapter owns one model. */
export interface EmbeddingAdapter {
  readonly model: string;
  embed(texts: readonly string[]): Promise<number[][]>;
  /** Optional asymmetric retrieval methods. Voyage models use these input types. */
  embedQuery?(text: string): Promise<number[]>;
  embedDocuments?(texts: readonly string[]): Promise<number[][]>;
}
