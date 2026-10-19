import type {
	ClaimBody,
	EvidenceAuthorityPolicy,
	OutcomeCriterion,
} from "../domain/evidence-types.js";
import type {
	Member,
	MemberIdentity,
	SourceEvent,
	Task,
} from "../domain/types.js";

const attestation =
	/^PANINI_STATUS task=([0-9a-f-]{36}) status=(backlog|planned|in_progress|blocked|review|cancelled)$/;

/** Only an exact, attributed source command can grant nonterminal automatic authority. */
export function authorizedStatusAttestation(input: {
	claim: ClaimBody;
	task: Task;
	source: SourceEvent;
	member: Member | null;
	identity: MemberIdentity | null;
	policy: EvidenceAuthorityPolicy;
	clock?: string;
}): boolean {
	const { claim, task, source, member, identity, policy } = input;
	const ageSeconds =
		(Date.parse(input.clock ?? new Date().toISOString()) -
			Date.parse(source.fetchedAt)) /
		1_000;

	if (
		claim.kind !== "progress_report" ||
		claim.assertedField !== "status" ||
		typeof claim.assertedValue !== "string" ||
		claim.spans.length !== 1 ||
		!member ||
		member.status !== "active" ||
		!identity ||
		identity.status !== "active" ||
		identity.memberId !== member.id ||
		claim.speakerMemberId !== member.id ||
		source.provider !== "slack" ||
		identity.provider !== source.provider ||
		identity.installationKey !== source.installationKey ||
		!policy.providers.includes(source.provider) ||
		!policy.installationKeys.includes(source.installationKey) ||
		!policy.objectKinds.includes(source.eventKind) ||
		!policy.criterionKinds.includes("status_nonterminal") ||
		!policy.audience.includes(source.visibility) ||
		!Number.isFinite(ageSeconds) ||
		ageSeconds < 0 ||
		ageSeconds > (policy.maxAttestationAgeSeconds ?? 900) ||
		!(
			policy.memberIds.includes(member.id) ||
			policy.roles.includes(member.role)
		)
	)
		return false;

	const payload =
		source.payload &&
		typeof source.payload === "object" &&
		!Array.isArray(source.payload)
			? source.payload
			: null;

	if (
		typeof payload?.user !== "string" ||
		payload.user !== identity.externalId ||
		typeof payload.text !== "string"
	)
		return false;

	const span = claim.spans[0]!;

	if (
		span.eventId !== source.id ||
		span.originObservationKey !==
			source.observationIdentity?.originObservationKey ||
		span.sourceVersionKey !==
			source.observationIdentity?.sourceVersionKey ||
		span.locator.kind !== "text" ||
		span.locator.jsonPointer !== "/text"
	)
		return false;

	const quoted = payload.text
		.slice(span.locator.startUtf16, span.locator.endUtf16)
		.trim();
	const match = attestation.exec(quoted);

	return Boolean(
		match &&
		match[1]!.toLowerCase() === task.id.toLowerCase() &&
		match[2] === claim.assertedValue,
	);
}

/** A single exact, attributed Slack command may satisfy only its named accepted criterion. */
export function authorizedCriterionAttestation(input: {
	claim: ClaimBody;
	task: Task;
	criterion: OutcomeCriterion;
	source: SourceEvent;
	member: Member | null;
	identity: MemberIdentity | null;
	policy: EvidenceAuthorityPolicy;
}): boolean {
	const { claim, task, criterion, source, member, identity, policy } = input;

	if (
		criterion.evidenceRule.kind !== "authorized_attestation" ||
		criterion.evidenceRule.authorityPolicyId !== policy.id ||
		claim.kind !== "progress_report" ||
		claim.assertedField !== "criterion_attestation" ||
		claim.assertedValue !== criterion.id ||
		claim.spans.length !== 1 ||
		!claim.subjectRefs.includes(task.id) ||
		!claim.subjectRefs.includes(criterion.id) ||
		!member ||
		member.status !== "active" ||
		!identity ||
		identity.status !== "active" ||
		identity.memberId !== member.id ||
		claim.speakerMemberId !== member.id ||
		source.provider !== "slack" ||
		identity.provider !== source.provider ||
		identity.installationKey !== source.installationKey ||
		!policy.providers.includes(source.provider) ||
		!policy.installationKeys.includes(source.installationKey) ||
		!policy.objectKinds.includes(source.eventKind) ||
		!policy.criterionKinds.includes("authorized_attestation") ||
		!policy.audience.includes(source.visibility) ||
		!(
			policy.memberIds.includes(member.id) ||
			policy.roles.includes(member.role)
		)
	)
		return false;

	const payload =
		source.payload &&
		typeof source.payload === "object" &&
		!Array.isArray(source.payload)
			? source.payload
			: null;

	if (
		typeof payload?.user !== "string" ||
		payload.user !== identity.externalId ||
		typeof payload.text !== "string"
	)
		return false;

	const span = claim.spans[0]!;

	if (
		span.eventId !== source.id ||
		span.originObservationKey !==
			source.observationIdentity?.originObservationKey ||
		span.sourceVersionKey !==
			source.observationIdentity?.sourceVersionKey ||
		span.locator.kind !== "text" ||
		span.locator.jsonPointer !== "/text" ||
		span.locator.startUtf16 !== 0 ||
		span.locator.endUtf16 !== payload.text.length
	)
		return false;
	return (
		payload.text ===
		`PANINI_CRITERION task=${task.id} criterion=${encodeURIComponent(criterion.id)} satisfied`
	);
}
