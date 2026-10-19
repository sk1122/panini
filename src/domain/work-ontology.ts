import { createHash } from "node:crypto";
import { z } from "zod";
import { contentHash } from "./content-hash.js";
import { DomainError } from "./errors.js";
import type { ClaimBody, EvidenceClaim } from "./evidence-types.js";
import type { SourceEvent } from "./types.js";
import {
	atPointer,
	validateClaimBody,
} from "../intelligence/claim-validation.js";

export const workEvidenceSchema = z.strictObject({
	kind: z.enum(["execution", "artifact"]),
	claimKind: z
		.enum([
			"request",
			"progress_report",
			"completion_report",
			"artifact_observation",
			"correction",
			"cancellation",
		])
		.nullish(),
	claimedCorrectionIds: z.array(z.uuid()).max(30).nullish(),
	name: z.string().trim().min(1).max(300),
	externalRef: z.url().nullable(),
	revision: z.string().min(1).max(300).nullable(),
	environment: z.string().min(1).max(100).nullable(),
	result: z.enum([
		"unknown",
		"succeeded",
		"failed",
		"mixed",
		"not_applicable",
	]),
	statement: z.string().trim().min(1).max(4000),
	sourcePointer: z
		.string()
		.max(500)
		.describe(
			"JSON pointer relative to the active payload root. For payload.text use /text, not /payload/text or /observation/payload/text.",
		),
	quote: z.string().min(1).max(8000),
	taskId: z.uuid().nullable(),
	contractVersion: z
		.number()
		.int()
		.positive()
		.nullable()
		.describe(
			"Current approved OutcomeContract version, or null when there is no approved contract. Inferred WorkScope is not an approved contract.",
		),
	criterionIds: z
		.array(z.string().min(1).max(100))
		.max(30)
		.describe(
			"Only criterion IDs from the current approved OutcomeContract. Use [] without an approved contract. Inferred WorkScope req: IDs are not approved criterion IDs.",
		),
	relationship: z.enum(["attempts", "supports", "contradicts", "references"]),
	relatedEntityId: z.uuid().nullable(),
});

export type WorkEvidenceInput = z.infer<typeof workEvidenceSchema>;

export interface WorkEvidenceWrite {
	key: string;
	runId: string;
	eventId: string;
	leaseOwner: string;
	allowedVisibilities: string[];
	evidence: WorkEvidenceInput;
}

export interface WorkEvidenceRead {
	taskId?: string | null;
	entityId?: string | null;
	allowedVisibilities: string[] | null;
	allowedTaskIds?: string[];
	/** Null is an internal complete-record read for one task, not a public tool limit. */
	limit: number | null;
}

export interface WorkEvidence {
	id: string;
	entity: Pick<
		WorkEvidenceInput,
		"kind" | "name" | "externalRef" | "revision" | "environment"
	> & { id: string; identityBasis: "source_local" };
	claim: EvidenceClaim;
	taskId: string | null;
	contractVersion: number | null;
	criterionIds: string[];
	relationship: WorkEvidenceInput["relationship"];
	relatedEntityId: string | null;
	contractCurrent?: boolean | null;
	basis: "source_reported";
	linkBasis: "model_inferred";
	/** A mapped source account does not grant scope or approval authority. */
	authorityBasis: "identity_only" | "unknown";
	claimedCorrectionIds: string[];
	correctionStatus: "none" | "claimed_unresolved";
}

/** Exact provenance is mechanical. The statement and task association remain interpretations. */
export function prepareWorkEvidence(
	raw: WorkEvidenceInput,
	event: SourceEvent,
): {
	input: WorkEvidenceInput;
	identityHash: string;
	claim: ClaimBody;
	reporterExternalId: string | null;
} {
	const input = workEvidenceSchema.parse(raw);
	const value = atPointer(event.payload, input.sourcePointer);

	if (typeof value !== "string")
		throw new DomainError(
			"sourcePointer must identify a string relative to the active payload root: for payload.text use /text, not /payload/text or /observation/payload/text.",
			"INVALID",
		);

	const start = typeof value === "string" ? value.indexOf(input.quote) : -1;

	if (!event.observationIdentity)
		throw new DomainError(
			"Work evidence requires a native source observation identity; this source cannot support evidence spans.",
			"INVALID",
		);
	if (start < 0)
		throw new DomainError(
			"Work evidence requires an exact quote in the active source.",
			"INVALID",
		);

	const nativePointers = [
		"/sha",
		"/headSha",
		"/revision",
		"/environment",
		"/environment/name",
	];
	const nativeSpans: ClaimBody["spans"] = [];

	for (const anchor of [
		input.externalRef,
		input.revision,
		input.environment,
	]) {
		if (!anchor || input.quote.includes(anchor)) continue;
		if (anchor === input.externalRef && anchor === event.sourceUrl)
			continue;

		const pointer = nativePointers.find(
			(pointer) => atPointer(event.payload, pointer) === anchor,
		);

		if (!pointer)
			throw new DomainError(
				"Reference, revision and environment must occur in the quote or exact native source metadata.",
				"INVALID",
			);
		nativeSpans.push({
			eventId: event.id,
			originObservationKey:
				event.observationIdentity.originObservationKey,
			sourceVersionKey: event.observationIdentity.sourceVersionKey,
			locator: {
				kind: "structured",
				jsonPointer: pointer,
				valueHash: contentHash(anchor),
			},
		});
	}
	if (input.externalRef && !/^https?:\/\//.test(input.externalRef))
		throw new DomainError(
			"Work references must use HTTP or HTTPS.",
			"INVALID",
		);
	if (
		!input.taskId &&
		(input.contractVersion !== null || input.criterionIds.length > 0)
	)
		throw new DomainError("Criterion support requires a task.", "INVALID");
	if (
		(input.claimedCorrectionIds?.length ?? 0) > 0 &&
		input.claimKind !== "correction"
	)
		throw new DomainError(
			"Correction targets require a correction assertion.",
			"INVALID",
		);

	if (input.kind !== "artifact" && input.relatedEntityId)
		throw new DomainError(
			"Only an artifact can name its producing execution.",
			"INVALID",
		);

	const claim: ClaimBody = {
		schemaVersion: 1,
		kind:
			input.claimKind ??
			(input.kind === "artifact"
				? "artifact_observation"
				: "progress_report"),
		statement: input.statement,
		subjectRefs: input.taskId ? [input.taskId] : [],
		speakerMemberId: null,
		assertedField: "work_evidence",
		assertedValue: { result: input.result },
		assertedAt: event.occurredAt,
		validFrom: null,
		validTo: null,
		temporalBasis: "relative_to_source",
		spans: [
			{
				eventId: event.id,
				originObservationKey:
					event.observationIdentity.originObservationKey,
				sourceVersionKey: event.observationIdentity.sourceVersionKey,
				locator: {
					kind: "text",
					jsonPointer: input.sourcePointer,
					startUtf16: start,
					endUtf16: start + input.quote.length,
					spanHash: createHash("sha256")
						.update(input.quote)
						.digest("hex"),
				},
			},
		],
		derivedFromClaimIds: [],
		supersedesClaimIds: [],
		caveats: [
			"Source-reported result; task and criterion links are model interpretations, not independent verification.",
		],
	};

	claim.spans.push(...nativeSpans);
	validateClaimBody(claim, new Map([[event.id, event]]));

	const reporterPointers =
		event.provider === "slack"
			? ["/user", "/message/user", "/event/user"]
			: event.provider === "github"
				? ["/sender/login", "/actor/login"]
				: [];
	const reporter = reporterPointers
		.map((pointer) => atPointer(event.payload, pointer))
		.find((value) => typeof value === "string" && value.length > 0);

	return {
		input,
		claim,
		reporterExternalId: typeof reporter === "string" ? reporter : null,
		identityHash: contentHash({
			identityVersion: "source-local-v2",
			kind: input.kind,
			// A URL can identify a shared dashboard, project or mutable report.
			// Preserve separate source-local entities until equivalence is established.
			origin: event.observationIdentity.originObservationKey,
			name: input.name,
			quote: input.quote,
			sourcePointer: input.sourcePointer,
			revision: input.revision,
			environment: input.environment,
		}),
	};
}
