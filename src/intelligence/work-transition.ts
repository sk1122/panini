import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import type { JsonValue } from "../domain/types.js";
import {
	parseWorkTransitionResponse,
	workTransitionAssessmentSchema,
	workTransitionInstructions,
	workScopeInstructions,
	workScopeDefinitionSchema,
	parseWorkScopeResponse,
	type WorkTransitionContext,
	type WorkScopeDefinitionContext,
} from "../domain/work-state.js";
import {
	reservedCost,
	settledCost,
	type TokenPriceBasis,
} from "./model-price.js";
import { z } from "zod";

interface WorkModelOptions {
	store: LedgerStore;
	context: { sources: { id: string }[] };
	key: string;
	runId: string;
	budgetId: string;
	model: string;
	apiKey: string;
	baseUrl?: string | undefined;
	priceBasis: TokenPriceBasis;
	fetcher: typeof fetch;
}

async function callWorkModel(
	input: WorkModelOptions & {
		schema: z.ZodType;
		instructions: string;
		schemaName: string;
	},
) {
	const { $schema: _schema, ...schema } = z.toJSONSchema(input.schema);
	const request = {
		model: input.model,
		store: false,
		instructions: input.instructions,
		input: [{ role: "user", content: JSON.stringify(input.context) }],
		text: {
			format: {
				type: "json_schema",
				name: input.schemaName,
				strict: true,
				schema,
			},
		},
		reasoning: { effort: "medium" },
		max_output_tokens: 3000,
	};
	const key = contentHash({
		purpose: input.schemaName,
		key: input.key,
		runId: input.runId,
		request,
	});
	const previous = await input.store.getModelCallResponseByKey(key);

	if (previous?.call.state === "succeeded" && previous.response)
		return {
			response: previous.response,
			modelCallId: previous.call.id,
		};
	if (previous && previous.call.state !== "reserved")
		throw new Error(
			"Work transition provider result is unsettled; do not resend it",
		);

	if (
		(await input.store.listModelCalls(input.runId)).some((call) =>
			["unknown", "dispatched"].includes(call.state),
		)
	)
		throw new Error(
			"An earlier provider request is unsettled; reconcile it before spending",
		);

	const estimate = Buffer.byteLength(JSON.stringify(request));
	const reservation = await input.store.reserveModelCall({
		budgetId: input.budgetId,
		runId: input.runId,
		purpose: "verify",
		logicalCallKey: key,
		attempt: 1,
		provider: "openai",
		model: input.model,
		requestHash: contentHash(request),
		request: request as unknown as JsonValue,
		cacheKey: null,
		contextualSourceEventIds: input.context.sources.map(
			(source) => source.id,
		),
		estimatedInputTokens: estimate,
		estimatedOutputTokens: 3000,
		estimatedUsd: reservedCost(estimate, 3000, input.priceBasis),
	});

	if (reservation.kind === "exhausted")
		throw new Error("Work transition budget exhausted");

	const callId = reservation.call.id;

	await input.store.markModelCallDispatched(callId, new Date().toISOString());

	let data: any;
	let providerError: JsonValue | null = null;

	try {
		const response = await input.fetcher(
			`${(input.baseUrl ?? "https://api.openai.com/v1").replace(/\/$/, "")}/responses`,
			{
				method: "POST",
				headers: {
					authorization: `Bearer ${input.apiKey}`,
					"content-type": "application/json",
				},
				body: JSON.stringify(request),
				signal: AbortSignal.timeout(120_000),
			},
		);

		if (!response.ok) {
			providerError = {
				httpStatus: response.status,
				body: (await response.text()).slice(0, 16000),
			};
			throw new Error(
				`Work assessment provider returned ${response.status}`,
			);
		}
		data = await response.json();
	} catch (error) {
		await input.store.settleModelCall({
			callId,
			state: "unknown",
			providerRequestId: null,
			resolvedModelVersion: null,
			inputTokens: null,
			outputTokens: null,
			cachedInputTokens: null,
			embeddingItems: null,
			costUsd: null,
			costBasis: "unknown",
			errorCode: "provider_error",
			response: providerError,
			finishedAt: new Date().toISOString(),
		});
		throw error;
	}

	const tokens = data.usage?.input_tokens ?? null;
	const output = data.usage?.output_tokens ?? null;
	const cached = data.usage?.input_tokens_details?.cached_tokens ?? null;
	const cost = settledCost(tokens, cached, output, input.priceBasis);

	await input.store.settleModelCall({
		callId,
		state: tokens === null || output === null ? "unknown" : "succeeded",
		providerRequestId: data.id ?? null,
		resolvedModelVersion: data.model ?? null,
		inputTokens: tokens,
		outputTokens: output,
		cachedInputTokens: cached,
		embeddingItems: null,
		costUsd: cost,
		costBasis: cost === null ? "unknown" : "estimated",
		errorCode: null,
		response: data as JsonValue,
		finishedAt: new Date().toISOString(),
	});
	if (tokens === null || output === null)
		throw new Error("Work transition usage is unsettled");
	return {
		response: data as JsonValue,
		modelCallId: callId,
	};
}

export async function assessWorkTransition(
	input: WorkModelOptions & { context: WorkTransitionContext },
) {
	const ids = input.context.assertions.map((assertion) => assertion.id);
	const requirements = input.context.requirements.map((step) => step.id);

	if (!ids.length)
		throw new Error("Work assessment needs linked source evidence");

	const step = workTransitionAssessmentSchema.shape.requirements.element;
	const schema = workTransitionAssessmentSchema.extend({
		requirements: z
			.array(
				step.extend({
					id: requirements.length
						? z.enum(requirements)
						: step.shape.id,
					assertionIds: z.array(z.enum(ids)).max(50),
				}),
			)
			.length(requirements.length),
	});

	const result = await callWorkModel({
		...input,
		schema,
		instructions: workTransitionInstructions,
		schemaName: "work_transition_assessment",
	});

	return {
		modelCallId: result.modelCallId,
		assessment: parseWorkTransitionResponse(result.response),
	};
}

export async function defineWorkScope(
	input: WorkModelOptions & { context: WorkScopeDefinitionContext },
) {
	const result = await callWorkModel({
		...input,
		schema: workScopeDefinitionSchema,
		instructions: workScopeInstructions,
		schemaName: "work_scope_definition",
	});

	return {
		modelCallId: result.modelCallId,
		definition: parseWorkScopeResponse(result.response),
	};
}
