export interface TokenPriceBasis {
	id: string;
	model: string;
	inputUsdPerMillion: number;
	cachedInputUsdPerMillion: number;
	outputUsdPerMillion: number;
	sourceUrl: string;
}

export const LUNA_PRICE_2026_10_01: TokenPriceBasis = {
	id: "openai-gpt-5.6-luna-2026-10-01",
	model: "gpt-5.6-luna",
	inputUsdPerMillion: 0.2,
	cachedInputUsdPerMillion: 0.02,
	outputUsdPerMillion: 1.2,
	sourceUrl: "https://developers.openai.com/api/docs/models/gpt-5.6-luna",
};

export const GPT6_LUNA_PRICE_2026_10_01: TokenPriceBasis = {
	id: "openai-gpt-6-luna-2026-10-01",
	model: "gpt-6-luna",
	inputUsdPerMillion: 0.1,
	cachedInputUsdPerMillion: 0.01,
	outputUsdPerMillion: 0.5,
	sourceUrl: "https://developers.openai.com/api/docs/models/gpt-6-luna",
};

export const CLAUDE_HAIKU_5_5_PRICE_2026_11_03: TokenPriceBasis = {
	id: "anthropic-claude-haiku-5-5-2026-11-03",
	model: "claude-haiku-5-5",
	inputUsdPerMillion: 0.1,
	cachedInputUsdPerMillion: 0.01,
	outputUsdPerMillion: 0.5,
	sourceUrl: "https://platform.claude.com/docs/en/about-claude/pricing",
};

export function reservedCost(
	inputTokens: number,
	outputTokens: number,
	basis: TokenPriceBasis | null,
): string | null {
	if (!basis) return null;

	// Reserve above the normal input rate because cache writes may carry a surcharge.
	const amount =
		(inputTokens * basis.inputUsdPerMillion * 1.25 +
			outputTokens * basis.outputUsdPerMillion) /
		1_000_000;

	return (Math.ceil(amount * 100_000_000) / 100_000_000).toFixed(8);
}

export function settledCost(
	inputTokens: number | null,
	cachedInputTokens: number | null,
	outputTokens: number | null,
	basis: TokenPriceBasis | null,
): string | null {
	if (!basis || inputTokens === null || outputTokens === null) return null;

	const cached = Math.min(inputTokens, Math.max(0, cachedInputTokens ?? 0));
	const amount =
		((inputTokens - cached) * basis.inputUsdPerMillion * 1.25 +
			cached * basis.cachedInputUsdPerMillion +
			outputTokens * basis.outputUsdPerMillion) /
		1_000_000;

	return (Math.ceil(amount * 100_000_000) / 100_000_000).toFixed(8);
}

/**
 * Prices for the configured model. gpt-6-luna has a built-in table; any other
 * OpenAI Responses-compatible model needs explicit prices so budgets stay real.
 */
export function priceBasisFor(
	model: string,
	env: NodeJS.ProcessEnv = process.env,
): TokenPriceBasis | null {
	if (model === GPT6_LUNA_PRICE_2026_10_01.model)
		return GPT6_LUNA_PRICE_2026_10_01;
	if (model === CLAUDE_HAIKU_5_5_PRICE_2026_11_03.model)
		return CLAUDE_HAIKU_5_5_PRICE_2026_11_03;

	const input = Number(env.INTELLIGENCE_PRICE_INPUT_PER_MILLION);
	const output = Number(env.INTELLIGENCE_PRICE_OUTPUT_PER_MILLION);
	const cached = Number(
		env.INTELLIGENCE_PRICE_CACHED_INPUT_PER_MILLION ?? input,
	);

	if (
		![input, output, cached].every(
			(value) => Number.isFinite(value) && value >= 0,
		)
	)
		return null;
	return {
		id: `configured-${model}`,
		model,
		inputUsdPerMillion: input,
		cachedInputUsdPerMillion: cached,
		outputUsdPerMillion: output,
		sourceUrl: "configured:INTELLIGENCE_PRICE_*",
	};
}
