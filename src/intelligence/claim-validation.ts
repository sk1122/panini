import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { ClaimBody } from "../domain/evidence-types.js";
import type { JsonValue, SourceEvent } from "../domain/types.js";
import { contentHash } from "../domain/content-hash.js";

export function atPointer(
	payload: JsonValue,
	pointer: string,
): JsonValue | undefined {
	if (pointer === "") return payload;
	if (!pointer.startsWith("/")) return undefined;

	let current: JsonValue | undefined = payload;

	for (const token of pointer
		.slice(1)
		.split("/")
		.map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
		if (Array.isArray(current)) {
			if (!/^(0|[1-9]\d*)$/.test(token)) return undefined;
			current = current[Number(token)];
		} else if (current && typeof current === "object") {
			current = current[token];
		} else return undefined;
	}
	return current;
}

export function validateClaimBody(
	body: ClaimBody,
	events: ReadonlyMap<string, SourceEvent>,
): void {
	if (
		body.schemaVersion !== 1 ||
		body.spans.length === 0 ||
		!body.statement.trim()
	) {
		throw new DomainError(
			"Claim requires a statement and source span.",
			"INVALID",
		);
	}
	if (
		body.validFrom &&
		body.validTo &&
		Date.parse(body.validTo) <= Date.parse(body.validFrom)
	) {
		throw new DomainError(
			"Claim validity interval is reversed.",
			"INVALID",
		);
	}
	for (const span of body.spans) {
		const event = events.get(span.eventId);

		if (
			!event ||
			!event.observationIdentity ||
			event.observationIdentity.originObservationKey !==
				span.originObservationKey ||
			event.observationIdentity.sourceVersionKey !== span.sourceVersionKey
		) {
			throw new DomainError(
				"Claim source identity is stale or unavailable.",
				"INVALID",
			);
		}
		if (span.locator.kind === "code") {
			throw new DomainError(
				"Code spans require exact-SHA artifact verification.",
				"INVALID",
			);
		}

		const value = atPointer(event.payload, span.locator.jsonPointer);

		if (value === undefined)
			throw new DomainError(
				"Claim source locator does not exist.",
				"INVALID",
			);
		if (span.locator.kind === "structured") {
			if (contentHash(value) !== span.locator.valueHash)
				throw new DomainError("Claim source value changed.", "INVALID");
		} else {
			if (
				typeof value !== "string" ||
				!Number.isSafeInteger(span.locator.startUtf16) ||
				!Number.isSafeInteger(span.locator.endUtf16) ||
				span.locator.startUtf16 < 0 ||
				span.locator.endUtf16 <= span.locator.startUtf16 ||
				span.locator.endUtf16 > value.length
			) {
				throw new DomainError("Claim text span is invalid.", "INVALID");
			}

			const actual = createHash("sha256")
				.update(
					value.slice(span.locator.startUtf16, span.locator.endUtf16),
				)
				.digest("hex");

			if (actual !== span.locator.spanHash)
				throw new DomainError(
					"Claim text span hash does not match.",
					"INVALID",
				);
		}
	}
}
