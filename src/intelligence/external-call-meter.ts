import { createHash, randomUUID } from "node:crypto";
import type { LedgerStore } from "../domain/store.js";

function numeric(value: unknown): number | null {
	return typeof value === "number" &&
		Number.isSafeInteger(value) &&
		value >= 0
		? value
		: null;
}

function nonnegativeCost(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: null;
}

/** Single-process guard for legacy evaluation; unknown usage stops further calls. */
export class ExternalEvaluationLimiter {
	private calls = 0;
	private inputBytes = 0;
	private outputReservation = 0;
	private stopped = false;
	private readonly deadline: number;

	constructor(
		private readonly caps: {
			maxCalls: number;
			maxInputTokens: number;
			maxOutputTokens: number;
			maxWallSeconds: number;
		},
	) {
		if (
			Object.values(caps).some(
				(value) => !Number.isSafeInteger(value) || value < 1,
			) ||
			caps.maxCalls > 100_000 ||
			caps.maxInputTokens > 1_000_000_000_000 ||
			caps.maxOutputTokens > 1_000_000_000_000 ||
			caps.maxWallSeconds > 86_400
		) {
			throw new Error(
				"Legacy evaluation caps must be finite positive integers.",
			);
		}
		this.deadline = Date.now() + caps.maxWallSeconds * 1_000;
	}

	reserve(requestBytes: number, outputTokens: number): void {
		if (
			this.stopped ||
			Date.now() >= this.deadline ||
			this.calls + 1 > this.caps.maxCalls ||
			this.inputBytes + requestBytes > this.caps.maxInputTokens ||
			this.outputReservation + outputTokens > this.caps.maxOutputTokens
		) {
			this.stopped = true;
			throw new Error(
				"Legacy evaluation budget exhausted or usage unknown.",
			);
		}
		this.calls += 1;
		this.inputBytes += requestBytes;
		this.outputReservation += outputTokens;
	}

	observe(outputTokens: number | null, reservedForCall: number): void {
		if (outputTokens === null || outputTokens > reservedForCall)
			this.stopped = true;
	}

	stop(): void {
		this.stopped = true;
	}

	snapshot() {
		return {
			calls: this.calls,
			conservativeInputBytes: this.inputBytes,
			reservedOutputTokens: this.outputReservation,
			stopped: this.stopped,
			deadline: new Date(this.deadline).toISOString(),
			costComplete: false,
		};
	}
}

/** Records legacy adapter egress without retaining private request or response text. */
export function meteredExternalFetch(
	store: Pick<LedgerStore, "appendAuditEvent">,
	input: {
		provider: "openai" | "openrouter";
		purpose: string;
		fetcher?: typeof fetch;
		limiter?: ExternalEvaluationLimiter;
		evaluationRunId?: string;
	},
): typeof fetch {
	const transport = input.fetcher ?? fetch;

	return async (resource, init) => {
		if (typeof init?.body !== "string" || init.body.length === 0) {
			input.limiter?.stop();
			throw new Error(
				"Metered model requests require a nonempty string body.",
			);
		}

		const body = init.body;
		const requestHash = createHash("sha256").update(body).digest("hex");
		let model = "unknown";
		let declaredOutputTokens = 4_000;

		try {
			const value = JSON.parse(body) as {
				model?: unknown;
				max_output_tokens?: unknown;
			};

			if (
				typeof value.model === "string" &&
				/^[A-Za-z0-9._:/-]{1,200}$/.test(value.model)
			) {
				model = value.model;
			}

			const limit = numeric(value.max_output_tokens);

			if (limit !== null && limit > 0) declaredOutputTokens = limit;
		} catch {
			/* The request hash still identifies malformed requests. */
		}
		input.limiter?.reserve(
			Buffer.byteLength(body, "utf8"),
			declaredOutputTokens,
		);

		const callId = randomUUID();
		const details = {
			callId,
			provider: input.provider,
			purpose: input.purpose,
			model,
			requestHash,
			requestBytes: Buffer.byteLength(body, "utf8"),
			...(input.evaluationRunId
				? { evaluationRunId: input.evaluationRunId }
				: {}),
		};

		await store.appendAuditEvent({
			actor: "system:external-call-meter",
			action: "external_call.dispatched",
			targetType: "external_model_call",
			targetId: callId,
			sourceEventId: null,
			proposalId: null,
			details,
		});
		try {
			const response = await transport(resource, init);
			const payload = (await response
				.clone()
				.json()
				.catch(() => null)) as {
				usage?: {
					input_tokens?: unknown;
					output_tokens?: unknown;
					prompt_tokens?: unknown;
					completion_tokens?: unknown;
					total_tokens?: unknown;
					cost?: unknown;
				};
			} | null;
			const usage = payload?.usage;
			const returnedInputTokens = numeric(
				usage?.input_tokens ?? usage?.prompt_tokens,
			);
			const returnedOutputTokens = numeric(
				usage?.output_tokens ?? usage?.completion_tokens,
			);
			const returnedCostUsd = nonnegativeCost(usage?.cost);

			input.limiter?.observe(returnedOutputTokens, declaredOutputTokens);
			await store.appendAuditEvent({
				actor: "system:external-call-meter",
				action: "external_call.completed",
				targetType: "external_model_call",
				targetId: callId,
				sourceEventId: null,
				proposalId: null,
				details: {
					...details,
					httpStatus: response.status,
					returnedInputTokens,
					returnedOutputTokens,
					returnedTotalTokens: numeric(usage?.total_tokens),
					costBasis:
						returnedCostUsd === null
							? "unknown"
							: "provider_returned",
					costUsd: returnedCostUsd,
				},
			});
			return response;
		} catch (error) {
			input.limiter?.stop();
			await store.appendAuditEvent({
				actor: "system:external-call-meter",
				action: "external_call.unknown",
				targetType: "external_model_call",
				targetId: callId,
				sourceEventId: null,
				proposalId: null,
				details: {
					...details,
					errorType: error instanceof Error ? error.name : "unknown",
					costBasis: "unknown",
					costUsd: null,
				},
			});
			throw error;
		}
	};
}

/** Provider API request accounting; records no URL, headers, or response body. */
export function meteredProviderFetch(
	store: Pick<LedgerStore, "appendAuditEvent">,
	input: {
		provider: "slack" | "notion" | "github";
		purpose: string;
		fetcher?: typeof fetch;
	},
): typeof fetch {
	const transport = input.fetcher ?? fetch;

	return async (resource, init) => {
		const callId = randomUUID();
		const details = {
			callId,
			provider: input.provider,
			purpose: input.purpose,
			method:
				init?.method ??
				(resource instanceof Request ? resource.method : "GET"),
			requestBytes:
				typeof init?.body === "string"
					? Buffer.byteLength(init.body, "utf8")
					: null,
			costUsd: null,
			costBasis: "unknown",
		};

		await store.appendAuditEvent({
			actor: "system:external-call-meter",
			action: "external_provider.dispatched",
			targetType: "external_provider_call",
			targetId: callId,
			sourceEventId: null,
			proposalId: null,
			details,
		});
		try {
			const response = await transport(resource, init);

			await store.appendAuditEvent({
				actor: "system:external-call-meter",
				action: "external_provider.completed",
				targetType: "external_provider_call",
				targetId: callId,
				sourceEventId: null,
				proposalId: null,
				details: { ...details, httpStatus: response.status },
			});
			return response;
		} catch (error) {
			await store.appendAuditEvent({
				actor: "system:external-call-meter",
				action: "external_provider.unknown",
				targetType: "external_provider_call",
				targetId: callId,
				sourceEventId: null,
				proposalId: null,
				details: {
					...details,
					errorType: error instanceof Error ? error.name : "unknown",
				},
			});
			throw error;
		}
	};
}
