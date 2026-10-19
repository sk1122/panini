import { createHash } from "node:crypto";
import type { JsonValue, SourceEventInput } from "../domain/types.js";

export interface ObservationIdentity {
	canonicalObjectKey: string;
	sourceVersionKey: string;
	semanticContentHash: string;
	originObservationKey: string;
}

function stable(value: JsonValue): string {
	if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
	if (value && typeof value === "object") {
		return `{${Object.keys(value)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${stable(value[key]!)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value);
}

function hash(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

function lifecycle(kind: string): string {
	return /delet|remov|revok/i.test(kind) ? "deleted" : "active";
}

function object(value: JsonValue): Record<string, JsonValue> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? value
		: null;
}

function string(value: JsonValue | undefined): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function canonicalObject(
	input: SourceEventInput,
	payload: Record<string, JsonValue>,
): string | null {
	if (input.provider === "slack") {
		const match = /^slack:([^:]+):([^:]+):([^:]+)$/.exec(input.sourceRef);
		const team = string(payload.teamId) ?? match?.[1];
		const channel = string(payload.channel) ?? match?.[2];
		const ts = string(payload.messageTs) ?? match?.[3];

		return team && channel && ts
			? `slack:${input.installationKey}:${team}:${channel}:${ts}`
			: null;
	}
	if (input.provider === "notion") {
		const match = /^notion:(?:workspace-page|page):([0-9a-f-]+)$/i.exec(
			input.sourceRef,
		);

		return match
			? `notion:${input.installationKey}:page:${match[1]!.toLowerCase()}`
			: null;
	}
	if (input.provider === "github") {
		if (
			input.eventKind === "artifact.verification" &&
			input.sourceRef.startsWith("github:verification:")
		) {
			return `github:${input.installationKey}:${input.sourceRef}`;
		}

		const stableRest = /^github:\d+:[^:]+:.+$/.test(input.sourceRef);

		if (stableRest)
			return `github:${input.installationKey}:${input.sourceRef}`;

		// A webhook delivery ID is a receipt, not an artifact ID.
		const artifactUrl =
			input.sourceUrl &&
			/^https:\/\/github\.com\/[^/]+\/[^/]+\/(pull|commit|issues)\/[^/?#]+/.test(
				input.sourceUrl,
			)
				? input.sourceUrl.split(/[?#]/, 1)[0]
				: null;

		return artifactUrl
			? `github:${input.installationKey}:${artifactUrl}`
			: null;
	}
	return /^(agent|manual):/.test(input.sourceRef)
		? `${input.provider}:${input.installationKey}:${input.sourceRef}`
		: null;
}

function semanticPayload(
	input: SourceEventInput,
	payload: Record<string, JsonValue>,
): JsonValue | null {
	if (input.provider === "slack") {
		const text = string(payload.text);

		return text === null ? null : { text };
	}
	if (input.provider === "github") {
		return payload;
	}
	if (input.provider === "notion") {
		const document = object(payload.document ?? null);
		const page = object(payload.page ?? null);
		const markdown = document?.markdown ?? null;

		return {
			page: page
				? {
						properties: page.properties ?? null,
						archived: page.archived ?? null,
						in_trash: page.in_trash ?? null,
					}
				: null,
			blocks:
				typeof markdown === "string" ? null : (payload.blocks ?? null),
			document: document
				? { title: document.title ?? null, markdown }
				: null,
		};
	}
	return payload;
}

/** Delivery IDs and fetch times never affect semantic source identity. */
export function observationIdentity(
	input: SourceEventInput,
): ObservationIdentity | null {
	if (!input.provider || !input.installationKey || !input.sourceRef)
		return null;

	const payload = object(input.payload);

	if (!payload) return null;

	const canonicalObjectKey = canonicalObject(input, payload);
	const semantic = semanticPayload(input, payload);

	if (!canonicalObjectKey || semantic === null) return null;

	const semanticContentHash = hash(stable(semantic));
	const sourceVersionKey = hash(
		`${lifecycle(input.eventKind)}:${semanticContentHash}`,
	);

	return {
		canonicalObjectKey,
		sourceVersionKey,
		semanticContentHash,
		originObservationKey: hash(`${canonicalObjectKey}:${sourceVersionKey}`),
	};
}
