export interface ModelUsage {
	inputTokens: number;
	cachedInputTokens: number;
	outputTokens: number;
}

export function openAIResponseUsage(payload: unknown): ModelUsage | undefined {
	if (!payload || typeof payload !== "object") return undefined;

	const usage = (payload as { usage?: unknown }).usage;

	if (!usage || typeof usage !== "object") return undefined;

	const record = usage as {
		input_tokens?: unknown;
		output_tokens?: unknown;
		input_tokens_details?: { cached_tokens?: unknown };
	};

	if (
		typeof record.input_tokens !== "number" ||
		typeof record.output_tokens !== "number"
	)
		return undefined;
	return {
		inputTokens: record.input_tokens,
		cachedInputTokens:
			typeof record.input_tokens_details?.cached_tokens === "number"
				? record.input_tokens_details.cached_tokens
				: 0,
		outputTokens: record.output_tokens,
	};
}
