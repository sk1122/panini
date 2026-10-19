import { randomUUID } from "node:crypto";
import { contentHash } from "../domain/content-hash.js";
import {
	explicitlyAssertsTaskDone,
	isTransientCoordinationRequest,
} from "./decision-policy.js";
import {
	assessTaskOutcomeCriteria,
	corroborationReason,
} from "./evidence-assessment.js";
import {
	authorizedCriterionAttestation,
	authorizedStatusAttestation,
} from "./authority-policy.js";
import type {
	EvidenceJudge,
	EvidenceJudgeResult,
	TargetEvidenceJudgeResult,
} from "./evidence-judge.js";
import type { LedgerStore } from "../domain/store.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import type {
	ClaimBody,
	EvidenceAuthorityPolicy,
	EvidenceClaim,
	OutcomeCriterion,
	SourceSpan,
	PipelineMode,
	ReplayMode,
	WorkRelationship,
} from "../domain/evidence-types.js";
import {
	contextFactTypes,
	type ContextFactType,
	type SourceEvent,
	type Task,
} from "../domain/types.js";
import {
	buildEvidenceSourceContext,
	observationsExplicitlyLinked,
} from "./observation-episodes.js";

export interface ExtractionResult {
	claims: ClaimBody[];
	dispositions: {
		eventId: string;
		state: "extracted" | "partial" | "no_claim" | "unresolved";
		claimOrdinals: number[];
		reasonCode: string | null;
	}[];
	omissions?: {
		eventId: string;
		jsonPointer: string;
		startUtf16: number;
		endUtf16: number;
		reasonCode: string;
	}[];
}

export interface EvidenceExtractor {
	name: string;
	extract(input: {
		events: SourceEvent[];
		contextEvents?: SourceEvent[];
		runId: string;
		budgetId: string;
	}): Promise<ExtractionResult>;
}

export interface WorkResolution {
	relationship: WorkRelationship;
	targetId: string | null;
	alternativeTargetIds: string[];
	reasons: string[];
	suggestedStatus?:
		| "backlog"
		| "planned"
		| "in_progress"
		| "blocked"
		| "review"
		| "cancelled"
		| null;
	statusBasis?: string | null;
	requestIntent?:
		"new_work" | "question_or_coordination" | "uncertain" | null;
}

export interface IdentityResolver {
	/** This resolver can relate any source observation to accepted work, not only reports. */
	supportsObservationAttribution?: boolean;
	resolve(input: {
		claim: ClaimBody;
		events: SourceEvent[];
		budgetId: string;
		runId: string;
		knowledgeCutoff?: string | null;
		contextualEventIds?: string[];
	}): Promise<WorkResolution>;
	resolveMany?(input: {
		claims: ClaimBody[];
		events: SourceEvent[];
		budgetId: string;
		runId: string;
		knowledgeCutoff?: string | null;
		contextualEventIds?: string[];
	}): Promise<WorkResolution[]>;
}

export interface ContextResolver {
	resolveContext(input: {
		claim: ClaimBody;
		events: SourceEvent[];
		budgetId: string;
		runId: string;
		knowledgeCutoff?: string | null;
	}): Promise<{
		relationship: "same_fact" | "related" | "unrelated" | "uncertain";
		targetId: string | null;
		reasons: string[];
	}>;
}

export interface ArtifactVerifier {
	verify(input: {
		task: Task;
		criterion: OutcomeCriterion;
		runId: string;
		budgetId: string;
	}): Promise<{
		sourceEventId: string | null;
		reasonCodes: string[];
	}>;
}

const assessmentPolicyBaseVersion = "evidence-policy-v8";
const reportedNonterminalStatuses = new Set([
	"backlog",
	"planned",
	"in_progress",
	"blocked",
	"review",
	"cancelled",
]);
const reportedResults = new Set([
	"succeeded",
	"failed",
	"mixed",
	"not_applicable",
]);

function sourceManifest(events: readonly SourceEvent[]) {
	return events.map((event) => ({
		eventId: event.id,
		provider: event.provider,
		installationKey: event.installationKey,
		sourceRefHash: contentHash(event.sourceRef),
		originObservationKey:
			event.observationIdentity?.originObservationKey ?? null,
		sourceVersionKey: event.observationIdentity?.sourceVersionKey ?? null,
		semanticContentHash:
			event.observationIdentity?.semanticContentHash ?? null,
		authorizationVersion: event.authorizationVersion ?? null,
		visibility: event.visibility,
		occurredAt: event.occurredAt,
		fetchedAt: event.fetchedAt,
		receivedAt: event.receivedAt,
	}));
}

export class EvidencePipeline {
	private readonly assessmentPolicyVersion: string;

	constructor(
		private readonly options: {
			store: LedgerStore;
			ledger: TeamLedger;
			pipelineVersion: string;
			policyVersion?: string;
			extractor: EvidenceExtractor;
			identityResolver: IdentityResolver;
			contextResolver?: ContextResolver;
			judge?: EvidenceJudge;
			escalation?: {
				identityResolver: IdentityResolver;
				judge: EvidenceJudge;
				modelVersion: string;
				maxAttempts: 0 | 1;
			};
			artifactVerifier?: ArtifactVerifier;
			sourceContext?: {
				allowedVisibilities: string[];
				maxEvents: number;
				maxPayloadBytes: number;
			};
			maxRequiredCheckpointAgeSeconds?: number;
			maxEvidenceExpansions?: number;
			application?: {
				mode: PipelineMode;
				autoApplyClasses: string[];
				authorityPolicies: EvidenceAuthorityPolicy[];
			};
		},
	) {
		this.assessmentPolicyVersion = `${assessmentPolicyBaseVersion}:${contentHash(
			{
				configuredPolicyVersion: options.policyVersion ?? null,
				application: options.application ?? null,
				escalation: options.escalation
					? {
							modelVersion: options.escalation.modelVersion,
							maxAttempts: options.escalation.maxAttempts,
						}
					: null,
				contextSearch: Boolean(options.contextResolver),
				sourceContext: options.sourceContext ?? null,
				maxRequiredCheckpointAgeSeconds:
					options.maxRequiredCheckpointAgeSeconds ?? 900,
				maxEvidenceExpansions: options.maxEvidenceExpansions ?? 1,
			},
		)}`;
		if (
			options.maxEvidenceExpansions !== undefined &&
			options.maxEvidenceExpansions !== 0 &&
			options.maxEvidenceExpansions !== 1
		) {
			throw new Error("Evidence expansion attempts must be zero or one.");
		}
	}

	async run(input: {
		eventIds: string[];
		budgetId: string;
		evaluationClock: string;
		knowledgeCutoff: string | null;
		replayMode?: ReplayMode;
		reopenNoClaim?: boolean;
		historicalEvaluation?: boolean;
	}): Promise<{
		state: "completed" | "no_evidence";
		processedEventIds: string[];
		claimCount: number;
		assessmentCount: number;
		pendingProposalCount: number;
		runId: string | null;
	}> {
		const { store, pipelineVersion, extractor } = this.options;
		const assessmentPolicyVersion = this.assessmentPolicyVersion;
		const historicalEvaluation = input.historicalEvaluation ?? false;

		if (
			historicalEvaluation &&
			(!input.knowledgeCutoff ||
				(input.replayMode ?? "live") === "live" ||
				input.evaluationClock > input.knowledgeCutoff)
		) {
			throw new Error(
				"Historical evaluation requires a cutoff and a non-live replay mode.",
			);
		}

		const workerId = randomUUID();
		const claimed = [] as {
			eventId: string;
			dispositionId: string;
			attempt: number;
			owner: string;
		}[];
		const terminal = [] as {
			eventId: string;
			runId: string | null;
			claimIds: string[];
		}[];
		let duplicates = 0;
		const requestedIds = [...new Set(input.eventIds)];
		const allRequestedEvents = await store.getSourceEvents(requestedIds);

		if (allRequestedEvents.length !== requestedIds.length)
			throw new Error("Episode has missing or revoked source events.");

		const currentIds =
			(input.replayMode ?? "live") === "live" && !input.knowledgeCutoff
				? new Set(await store.currentSourceEventIds(requestedIds))
				: new Set(requestedIds);
		const activeRequestedIds = requestedIds.filter((id) =>
			currentIds.has(id),
		);

		if (activeRequestedIds.length === 0) {
			return {
				state: "no_evidence",
				processedEventIds: [],
				claimCount: 0,
				assessmentCount: 0,
				pendingProposalCount: 0,
				runId: null,
			};
		}

		const requestedEvents = allRequestedEvents.filter((event) =>
			currentIds.has(event.id),
		);

		if (
			input.knowledgeCutoff &&
			requestedEvents.some(
				(event) => event.receivedAt > input.knowledgeCutoff!,
			)
		) {
			throw new Error(
				"Episode includes a source receipt learned after the knowledge cutoff.",
			);
		}

		const originById = new Map(
			requestedEvents.map((event) => [
				event.id,
				event.observationIdentity?.originObservationKey ??
					`unresolved-receipt:${event.id}`,
			]),
		);
		const firstByOrigin = new Set<string>();
		const activeIds: string[] = [];
		const duplicateIds: string[] = [];

		for (const eventId of activeRequestedIds) {
			const origin = originById.get(eventId)!;

			if (firstByOrigin.has(origin)) duplicateIds.push(eventId);
			else {
				firstByOrigin.add(origin);
				activeIds.push(eventId);
			}
		}

		const settleDuplicateReceipts = async () => {
			for (const eventId of duplicateIds) {
				const result = await store.claimObservation({
					eventId,
					pipelineVersion,
					workerId,
					leaseSeconds: 1800,
					now: new Date().toISOString(),
				});

				if (result.kind !== "duplicate" && result.kind !== "terminal") {
					if (result.kind === "claimed")
						await store.failObservationClaims({
							leases: [
								{
									dispositionId: result.disposition.id,
									attempt: result.disposition.attempt,
									owner: workerId,
								},
							],
							runId: null,
							reasonCode: "duplicate_origin_unsettled",
						});
					throw new Error(
						"Duplicate receipt could not be settled after its canonical origin.",
					);
				}
			}
		};

		for (const eventId of activeIds) {
			const result = await store.claimObservation({
				eventId,
				pipelineVersion,
				workerId,
				leaseSeconds: 1800,
				now: new Date().toISOString(),
				reopenNoClaim: input.reopenNoClaim ?? false,
			});

			if (result.kind === "claimed")
				claimed.push({
					eventId,
					dispositionId: result.disposition.id,
					attempt: result.disposition.attempt,
					owner: workerId,
				});
			if (result.kind === "terminal")
				terminal.push({
					eventId,
					runId: result.disposition.runId,
					claimIds: result.disposition.claimIds,
				});
			if (result.kind === "duplicate") duplicates += 1;
			if (result.kind === "busy") {
				await store.failObservationClaims({
					leases: claimed.map((item) => ({
						dispositionId: item.dispositionId,
						attempt: item.attempt,
						owner: item.owner,
					})),
					runId: null,
					reasonCode: "episode_origin_busy",
				});
				throw new Error(
					"Episode has an active observation lease; retry later.",
				);
			}
		}

		let cachedClaimIds: string[] | null = null;

		if (
			claimed.length === 0 &&
			terminal.length > 0 &&
			terminal.length + duplicates === activeIds.length &&
			terminal.every((item) => item.runId)
		) {
			const priorRunId = terminal[0]!.runId!;

			if (terminal.every((item) => item.runId === priorRunId)) {
				const prior = await store.getInterpretationRun(priorRunId);

				if (
					prior?.state === "failed" &&
					prior.eventIds.length === terminal.length &&
					terminal.every((item) =>
						prior.eventIds.includes(item.eventId),
					)
				) {
					cachedClaimIds = [
						...new Set(terminal.flatMap((item) => item.claimIds)),
					];
				}
			}
		}
		if (claimed.length === 0 && cachedClaimIds === null) {
			await settleDuplicateReceipts();
			return {
				state: "no_evidence",
				processedEventIds: [],
				claimCount: 0,
				assessmentCount: 0,
				pendingProposalCount: 0,
				runId: null,
			};
		}

		const eventIds =
			cachedClaimIds === null
				? claimed.map((item) => item.eventId)
				: activeIds;
		let events: SourceEvent[];
		let context: Awaited<ReturnType<typeof buildEvidenceSourceContext>> = {
			events: [],
			omittedEventIds: [],
			candidateSearchTruncated: false,
			cutoff: input.knowledgeCutoff ?? input.evaluationClock,
		};
		let inputHash: string;
		let run: Awaited<ReturnType<LedgerStore["createV2Run"]>>;
		let result: {
			state: "completed" | "no_evidence";
			processedEventIds: string[];
			claimCount: number;
			assessmentCount: number;
			pendingProposalCount: number;
			runId: string | null;
		};

		try {
			events = await store.getSourceEvents(eventIds);
			if (events.length !== eventIds.length)
				throw new Error("Claimed evidence became unavailable.");
			if (this.options.sourceContext)
				context = await buildEvidenceSourceContext(store, events, {
					...this.options.sourceContext,
					cutoff: input.knowledgeCutoff ?? input.evaluationClock,
				});
			inputHash = contentHash({
				eventIds,
				versions: events.map(
					(event) => event.observationIdentity?.sourceVersionKey,
				),
				contextualSources: sourceManifest(context.events),
				contextOmissions: context.omittedEventIds,
				pipelineVersion,
				assessmentPolicyVersion,
				evaluationClock: input.evaluationClock,
				knowledgeCutoff: input.knowledgeCutoff,
				historicalEvaluation,
			});
			run = await store.createV2Run({
				model: extractor.name,
				inputHash,
				eventIds,
				pipelineVersion,
				promptVersion: extractor.name,
				policyVersion: assessmentPolicyVersion,
				configHash: contentHash({
					pipelineVersion,
					assessmentPolicyVersion,
					application: this.options.application ?? null,
					maxRequiredCheckpointAgeSeconds:
						this.options.maxRequiredCheckpointAgeSeconds ?? 900,
				}),
				replayMode:
					cachedClaimIds === null
						? (input.replayMode ?? "live")
						: "cached_reassess",
				evaluationClock: input.evaluationClock,
				knowledgeCutoff: input.knowledgeCutoff,
				budgetId: input.budgetId,
				manifest: {
					extractor: extractor.name,
					sources: sourceManifest([...events, ...context.events]),
					activeEventIds: eventIds,
					contextualEventIds: context.events.map((event) => event.id),
					omittedActiveEventIds: [],
					omittedContextEventIds: context.omittedEventIds,
					contextCandidateSearchTruncated:
						context.candidateSearchTruncated,
					contextCutoff: context.cutoff,
					reusedClaimIds: cachedClaimIds ?? [],
					historicalEvaluation,
				},
			});
		} catch (error) {
			await store.failObservationClaims({
				leases: claimed.map((item) => ({
					dispositionId: item.dispositionId,
					attempt: item.attempt,
					owner: item.owner,
				})),
				runId: null,
				reasonCode: "pre_run_failed",
			});
			throw error;
		}
		try {
			let extractionOmissions: NonNullable<
				ExtractionResult["omissions"]
			> = [];
			const savedClaims =
				cachedClaimIds === null
					? await (async () => {
							const extracted = await extractor.extract({
								events,
								contextEvents: context.events,
								runId: run.id,
								budgetId: input.budgetId,
							});

							extractionOmissions = extracted.omissions ?? [];

							const dispositions = extracted.dispositions.map(
								(item) => ({
									...item,
									dispositionId:
										claimed.find(
											(claim) =>
												claim.eventId === item.eventId,
										)?.dispositionId ?? "",
								}),
							);
							const saved = await store.saveExtraction({
								runId: run.id,
								episodeKey: contentHash(eventIds),
								inputHash,
								claims: extracted.claims,
								dispositions,
								dependencies: [],
								expectedLeases: claimed.map((item) => ({
									dispositionId: item.dispositionId,
									attempt: item.attempt,
									owner: item.owner,
								})),
							});

							return saved.claims;
						})()
					: await store.getClaims(cachedClaimIds);

			if (
				cachedClaimIds !== null &&
				savedClaims.length !== cachedClaimIds.length
			) {
				throw new Error(
					"Cached claims became unavailable before assessment resumed.",
				);
			}

			const { assessmentCount, pendingProposalCount } =
				await this.assessClaims({
					claims: savedClaims,
					events: [...events, ...context.events],
					contextualEventIds: context.events.map((event) => event.id),
					runId: run.id,
					budgetId: input.budgetId,
					evaluationClock: input.evaluationClock,
					knowledgeCutoff: input.knowledgeCutoff,
					historicalEvaluation,
					attributeObservations: Boolean(
						this.options.identityResolver
							.supportsObservationAttribution,
					),
					allowLiveVerification:
						cachedClaimIds === null &&
						(input.replayMode ?? "live") === "live" &&
						input.knowledgeCutoff === null,
				});

			await store.completeInterpretationRun(run.id, {
				claimCount: savedClaims.length,
				assessmentCount,
				pendingProposalCount,
				omissions: extractionOmissions,
			});
			result = {
				state: "completed",
				processedEventIds: eventIds,
				claimCount: savedClaims.length,
				assessmentCount,
				pendingProposalCount,
				runId: run.id,
			};
		} catch (error) {
			await store.failObservationClaims({
				leases: claimed.map((item) => ({
					dispositionId: item.dispositionId,
					attempt: item.attempt,
					owner: item.owner,
				})),
				runId: run.id,
				reasonCode: "extraction_failed",
			});
			await store.failInterpretationRun(
				run.id,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
		await settleDuplicateReceipts();
		return result;
	}

	async runCachedAssessment(input: {
		claimIds: string[];
		budgetId: string;
		evaluationClock: string;
		knowledgeCutoff: string | null;
		historicalEvaluation?: boolean;
	}): Promise<{
		state: "completed";
		processedEventIds: string[];
		claimCount: number;
		assessmentCount: number;
		pendingProposalCount: number;
		runId: string;
	}> {
		const { store, pipelineVersion, extractor } = this.options;
		const assessmentPolicyVersion = this.assessmentPolicyVersion;

		if (
			input.historicalEvaluation &&
			(!input.knowledgeCutoff ||
				input.evaluationClock > input.knowledgeCutoff)
		) {
			throw new Error(
				"Historical cached assessment requires a knowledge cutoff.",
			);
		}

		const claimIds = [...new Set(input.claimIds)].sort();

		if (claimIds.length === 0 || claimIds.length > 100)
			throw new Error("Cached assessment requires 1-100 claim IDs.");

		const claims = (await store.getClaims(claimIds)).sort((left, right) =>
			left.id.localeCompare(right.id),
		);

		if (claims.length !== claimIds.length)
			throw new Error("Cached assessment has missing or revoked claims.");
		if (
			input.historicalEvaluation &&
			claims.some((claim) => claim.createdAt > input.knowledgeCutoff!)
		) {
			throw new Error(
				"Historical cached assessment includes claims created after the cutoff.",
			);
		}

		const eventIds = [
			...new Set(
				claims.flatMap((claim) =>
					claim.body.spans.map((span) => span.eventId),
				),
			),
		].sort();
		const events = await store.getSourceEvents(eventIds);

		if (eventIds.length === 0 || events.length !== eventIds.length) {
			throw new Error(
				"Cached assessment has missing or revoked source events.",
			);
		}
		if (
			(
				await store.currentSourceEventIds(
					eventIds,
					input.knowledgeCutoff ?? undefined,
				)
			).length !== eventIds.length
		) {
			throw new Error(
				"Cached assessment contains a superseded source version.",
			);
		}
		if (
			input.knowledgeCutoff &&
			events.some((event) => event.receivedAt > input.knowledgeCutoff!)
		) {
			throw new Error(
				"Cached assessment includes a source learned after the knowledge cutoff.",
			);
		}

		const context = this.options.sourceContext
			? await buildEvidenceSourceContext(store, events, {
					...this.options.sourceContext,
					cutoff: input.knowledgeCutoff ?? input.evaluationClock,
				})
			: {
					events: [] as SourceEvent[],
					omittedEventIds: [] as string[],
					candidateSearchTruncated: false,
					cutoff: input.knowledgeCutoff ?? input.evaluationClock,
				};
		const inputHash = contentHash({
			contextualSources: sourceManifest(context.events),
			contextOmissions: context.omittedEventIds,
			claimIds,
			claimHashes: claims.map((claim) => claim.contentHash),
			pipelineVersion,
			assessmentPolicyVersion,
			evaluationClock: input.evaluationClock,
			knowledgeCutoff: input.knowledgeCutoff,
			historicalEvaluation: input.historicalEvaluation ?? false,
		});
		const run = await store.createV2Run({
			model: extractor.name,
			inputHash,
			eventIds,
			pipelineVersion,
			promptVersion: extractor.name,
			policyVersion: assessmentPolicyVersion,
			configHash: contentHash({
				pipelineVersion,
				assessmentPolicyVersion,
				application: this.options.application ?? null,
				maxRequiredCheckpointAgeSeconds:
					this.options.maxRequiredCheckpointAgeSeconds ?? 900,
			}),
			replayMode: "cached_reassess",
			evaluationClock: input.evaluationClock,
			knowledgeCutoff: input.knowledgeCutoff,
			budgetId: input.budgetId,
			manifest: {
				reusedClaimIds: claimIds,
				sources: sourceManifest([...events, ...context.events]),
				activeEventIds: eventIds,
				contextualEventIds: context.events.map((event) => event.id),
				omittedActiveEventIds: [],
				omittedContextEventIds: context.omittedEventIds,
				contextCandidateSearchTruncated:
					context.candidateSearchTruncated,
				contextCutoff: context.cutoff,
				historicalEvaluation: input.historicalEvaluation ?? false,
			},
		});

		try {
			const { assessmentCount, pendingProposalCount } =
				await this.assessClaims({
					claims,
					events,
					runId: run.id,
					budgetId: input.budgetId,
					evaluationClock: input.evaluationClock,
					knowledgeCutoff: input.knowledgeCutoff,
					historicalEvaluation: input.historicalEvaluation ?? false,
					attributeObservations: true,
					allowLiveVerification: false,
				});

			await store.completeInterpretationRun(run.id, {
				claimCount: claims.length,
				assessmentCount,
				pendingProposalCount,
				omissions: [],
			});
			return {
				state: "completed",
				processedEventIds: eventIds,
				claimCount: claims.length,
				assessmentCount,
				pendingProposalCount,
				runId: run.id,
			};
		} catch (error) {
			await store.failInterpretationRun(
				run.id,
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	/** One reviewed decision for the target; accepted state still changes only in TeamLedger. */
	private async assessReviewedTarget(input: {
		targetId: string;
		claims: EvidenceClaim[];
		resolutions: WorkResolution[];
		events: SourceEvent[];
		contextualEventIds?: string[];
		runId: string;
		budgetId: string;
		evaluationClock: string;
		knowledgeCutoff: string | null;
		historicalEvaluation: boolean;
	}): Promise<{ assessmentCount: number; pendingProposalCount: number }> {
		const { store, ledger, pipelineVersion } = this.options;
		const revisions = (await store.listTaskRevisions(input.targetId))
			.filter(
				(revision) =>
					!input.knowledgeCutoff ||
					revision.appliedAt <= input.knowledgeCutoff,
			)
			.sort((a, b) => b.version - a.version);
		const task = input.knowledgeCutoff
			? revisions[0]?.current
			: await store.getTask(input.targetId);

		if (!task) return { assessmentCount: 0, pendingProposalCount: 0 };

		const prior = input.historicalEvaluation
			? []
			: await store.listClaimsForTask(task.id, null, 100);
		const priorClaims = prior
			.filter((claim) => claim.body.assertedAt <= input.evaluationClock)
			.sort((a, b) => b.body.assertedAt.localeCompare(a.body.assertedAt))
			.slice(0, 20);
		const all = [
			...new Map(
				[...input.claims, ...priorClaims].map((claim) => [
					claim.id,
					claim,
				]),
			).values(),
		];
		const sourceIds = [
			...new Set(
				all.flatMap((claim) =>
					claim.body.spans.map((span) => span.eventId),
				),
			),
		];
		const [sources, currentIds] = await Promise.all([
			store.getSourceEvents(sourceIds),
			store.currentSourceEventIds(
				sourceIds,
				input.knowledgeCutoff ?? undefined,
			),
		]);
		const available = new Set(
			sources
				.filter(
					(source) =>
						currentIds.includes(source.id) &&
						(!input.knowledgeCutoff ||
							source.receivedAt <= input.knowledgeCutoff),
				)
				.map((source) => source.id),
		);
		const claims = all.filter((claim) =>
			claim.body.spans.every((span) => available.has(span.eventId)),
		);

		if (
			input.claims.some(
				(claim) => !claims.some((item) => item.id === claim.id),
			)
		) {
			throw new Error("Joint assessment source changed before judgment.");
		}

		const contextualIds = new Set(input.contextualEventIds ?? []);
		const judgmentEvents = [
			...new Map(
				[
					...sources.filter((source) => available.has(source.id)),
					...input.events.filter(
						(event) =>
							contextualIds.has(event.id) &&
							sources.some((source) =>
								observationsExplicitlyLinked(source, event),
							),
					),
				].map((event) => [event.id, event]),
			).values(),
		];
		let judgment: TargetEvidenceJudgeResult;

		try {
			judgment = await this.options.judge!.assessTarget!({
				task,
				claims,
				events: judgmentEvents,
				runId: input.runId,
				budgetId: input.budgetId,
				knowledgeCutoff: input.knowledgeCutoff,
			});
		} catch {
			judgment = {
				fields: [],
				reasonCodes: ["model_failure"],
				explanation: "Joint assessment needs review.",
			};
		}

		const relationship = input.resolutions.some(
			(item) => item.relationship === "same_outcome",
		)
			? "same_outcome"
			: "part_of";
		const reasons = [
			...new Set([
				...input.resolutions.flatMap((item) => item.reasons),
				...judgment.reasonCodes,
				"joint_target_assessment",
				"human_review_required",
				...(input.historicalEvaluation
					? ["historical_evaluation"]
					: []),
				...(prior.length === 100
					? ["prior_claim_search_truncated"]
					: []),
			]),
		];
		const seenFields = new Set<string>();
		const workClaimIds = new Set(
			claims
				.filter(
					(claim) =>
						[
							"progress_report",
							"completion_report",
							"artifact_observation",
							"context_statement",
						].includes(claim.body.kind) ||
						(claim.body.kind === "correction" &&
							claim.body.assertedField === "status" &&
							claim.body.assertedValue === "in_progress"),
				)
				.map((claim) => claim.id),
		);
		const fields = judgment.fields.flatMap((field) => {
			const operation = field.operation;
			const inProgress =
				operation.op === "set" &&
				operation.field === "status" &&
				operation.value === "in_progress";
			const progressEvidence = operation.supportingClaimIds.filter((id) =>
				workClaimIds.has(id),
			);
			const partialProgress =
				field.verdict === "partial_scope" &&
				inProgress &&
				progressEvidence.length > 0;

			if (
				(field.verdict !== "supported" && !partialProgress) ||
				operation.op !== "set" ||
				!["status", "result"].includes(operation.field) ||
				(inProgress && !progressEvidence.length) ||
				seenFields.has(operation.field) ||
				!operation.supportingClaimIds.length ||
				operation.supportingClaimIds.some(
					(id) => !claims.some((claim) => claim.id === id),
				)
			) {
				reasons.push("unsupported_field_suggestion_omitted");
				return [];
			}
			seenFields.add(operation.field);
			if (
				relationship === "part_of" &&
				!(
					operation.field === "status" &&
					operation.value === "in_progress"
				)
			)
				return [];
			if (
				operation.value ===
				(operation.field === "status"
					? task.status
					: (task.result ?? "unknown"))
			)
				return [];

			let support = claims.filter((claim) =>
				operation.supportingClaimIds.includes(claim.id),
			);

			if (inProgress) {
				support = support.filter((claim) => workClaimIds.has(claim.id));
				operation.supportingClaimIds = support.map((claim) => claim.id);
			}
			if (operation.field === "status" && operation.value === "done") {
				support = support.filter(
					(claim) => claim.body.kind === "completion_report",
				);
				if (!support.length) {
					reasons.push("terminal_report_required");
					return [];
				}
				operation.supportingClaimIds = support.map((claim) => claim.id);
				if (
					support.some(
						(claim) => !explicitlyAssertsTaskDone(claim.body),
					)
				)
					reasons.push("task_status_inferred_from_bounded_report");
			}

			const effectiveAt = support
				.map((claim) => claim.body.validFrom ?? claim.body.assertedAt)
				.sort()
				.at(-1)!;
			const previous = revisions.find(
				(revision) =>
					!revision.previous ||
					revision.previous[operation.field] !==
						revision.current[operation.field],
			);
			const previousAt =
				previous?.decisionMetadata?.effectiveAtByField[
					operation.field
				] ?? previous?.appliedAt;
			const stale = Boolean(
				previousAt && Date.parse(effectiveAt) < Date.parse(previousAt),
			);

			if (stale) reasons.push("stale_evidence");
			if (partialProgress)
				reasons.push("partial_scope_progress_requires_review");
			return [
				{
					operation,
					verdict: stale
						? ("insufficient" as const)
						: ("supported" as const),
					support: support.flatMap((claim) => claim.body.spans),
					contradictions: [],
					effectiveAt,
					reasonCodes: [
						...(stale ? ["stale_evidence"] : []),
						...(partialProgress
							? ["partial_scope_progress_requires_review"]
							: []),
					],
				},
			];
		});

		if (relationship === "part_of")
			reasons.push("inferred_status_requires_review");

		const terminalSupport = fields.find(
			(field) =>
				field.operation.field === "status" &&
				field.operation.value === "done",
		);
		const completion = terminalSupport
			? claims.find((claim) =>
					terminalSupport.operation.supportingClaimIds.includes(
						claim.id,
					),
				)
			: null;
		const outcome = completion
			? assessTaskOutcomeCriteria({
					task,
					claim: {
						...completion.body,
						spans: terminalSupport!.support,
					},
					events: judgmentEvents,
					evaluationClock: input.evaluationClock,
					defaultCheckpointAgeSeconds:
						this.options.maxRequiredCheckpointAgeSeconds ?? 900,
				})
			: null;
		const assessment = await store.saveAssessment(
			{
				runId: input.runId,
				assessmentKey: contentHash({
					targetId: task.id,
					targetVersion: task.version,
					claimIds: claims.map((claim) => claim.id),
					pipelineVersion,
					policyVersion: this.assessmentPolicyVersion,
					evaluationClock: input.evaluationClock,
					historicalEvaluation: input.historicalEvaluation,
					grouped: true,
				}),
				targetType: "task",
				targetId: task.id,
				targetVersion: String(task.version),
				contractVersion: task.outcomeContract?.version ?? null,
				claimIds: claims.map((claim) => claim.id),
				evidenceFingerprint: contentHash(
					claims.flatMap((claim) => claim.body.spans),
				),
				permissionFingerprint: contentHash(
					claims
						.flatMap((claim) => claim.body.spans)
						.map((span) => span.originObservationKey),
				),
				policyVersion: this.assessmentPolicyVersion,
				modelVersion: this.options.extractor.name,
				relationship,
				disposition: fields.length ? "review_required" : "no_change",
				reasonCodes: [...new Set(reasons)],
				body: {
					schemaVersion: 1,
					kind: "task",
					relationship,
					alternativeTargetIds: [
						...new Set(
							input.resolutions.flatMap(
								(item) => item.alternativeTargetIds,
							),
						),
					],
					fields,
					criteria: outcome?.criteria ?? [],
					coverage: outcome?.coverage ?? {
						complete: false,
						requiredResources: sourceIds,
						gaps: ["human_review_required"],
						checkedAt: input.evaluationClock,
					},
					rawScores: [],
					explanation: judgment.explanation,
				},
			},
			[],
		);
		const supportedFields = fields.filter(
			(field) => field.verdict === "supported",
		);

		if (!supportedFields.length || input.historicalEvaluation)
			return { assessmentCount: 1, pendingProposalCount: 0 };

		const proposal = await ledger.proposeAssessedTaskChange({
			assessmentId: assessment.id,
			operations: supportedFields.map((field) => field.operation),
			rationale: judgment.explanation,
			requestedBy: "evidence-pipeline",
		});

		return {
			assessmentCount: 1,
			pendingProposalCount: proposal.state === "pending" ? 1 : 0,
		};
	}

	private async assessClaims(input: {
		claims: EvidenceClaim[];
		events: SourceEvent[];
		contextualEventIds?: string[];
		runId: string;
		budgetId: string;
		evaluationClock: string;
		knowledgeCutoff: string | null;
		historicalEvaluation: boolean;
		attributeObservations: boolean;
		allowLiveVerification: boolean;
	}): Promise<{
		assessmentCount: number;
		pendingProposalCount: number;
	}> {
		const { store, ledger, pipelineVersion, extractor, identityResolver } =
			this.options;
		const assessmentPolicyVersion = this.assessmentPolicyVersion;
		let assessmentCount = 0;
		let pendingProposalCount = 0;

		const shouldAttribute = (claim: EvidenceClaim) =>
			input.attributeObservations ||
			claim.body.kind === "completion_report" ||
			claim.body.kind === "progress_report" ||
			claim.body.kind === "request";

		const assessableClaims = input.claims.filter(shouldAttribute);
		const batchResolutions = new Map<
			string,
			Awaited<ReturnType<IdentityResolver["resolve"]>>
		>();

		if (identityResolver.resolveMany && assessableClaims.length > 1) {
			for (let start = 0; start < assessableClaims.length; start += 10) {
				const batch = assessableClaims.slice(start, start + 10);
				const resolutions = await identityResolver.resolveMany({
					claims: batch.map((claim) => claim.body),
					events: input.events,
					budgetId: input.budgetId,
					runId: input.runId,
					contextualEventIds: input.contextualEventIds ?? [],
					knowledgeCutoff: input.knowledgeCutoff,
				});

				if (resolutions.length !== batch.length)
					throw new Error(
						"Identity batch did not cover every claim.",
					);
				for (const [index, claim] of batch.entries())
					batchResolutions.set(claim.id, resolutions[index]!);
			}
		}

		const jointlyAssessed = new Set<string>();

		if (
			this.options.application?.mode === "review" &&
			this.options.judge?.assessTarget
		) {
			for (const claim of assessableClaims) {
				if (!batchResolutions.has(claim.id))
					batchResolutions.set(
						claim.id,
						await identityResolver.resolve({
							claim: claim.body,
							events: input.events,
							contextualEventIds: input.contextualEventIds ?? [],
							budgetId: input.budgetId,
							runId: input.runId,
							knowledgeCutoff: input.knowledgeCutoff,
						}),
					);
			}

			const targets = new Map<string, EvidenceClaim[]>();

			for (const claim of assessableClaims) {
				const resolution = batchResolutions.get(claim.id)!;

				if (
					!resolution.targetId ||
					!["same_outcome", "part_of"].includes(
						resolution.relationship,
					)
				)
					continue;

				const group = targets.get(resolution.targetId) ?? [];

				group.push(claim);
				targets.set(resolution.targetId, group);
			}
			for (const [targetId, claims] of targets) {
				const result = await this.assessReviewedTarget({
					...input,
					targetId,
					claims,
					resolutions: claims.map((claim) =>
						batchResolutions.get(claim.id)!,
					),
				});

				assessmentCount += result.assessmentCount;
				pendingProposalCount += result.pendingProposalCount;
				for (const claim of claims) jointlyAssessed.add(claim.id);
			}
		}
		for (const claim of input.claims) {
			if (claim.body.kind === "context_statement") {
				const value = claim.body.assertedValue;
				const atomic =
					Boolean(
						claim.body.assertedField?.trim() &&
						claim.body.subjectRefs.length,
					) &&
					(typeof value === "string"
						? Boolean(value.trim())
						: typeof value === "number"
							? Number.isFinite(value)
							: typeof value === "boolean");
				const sourceEventIds = [
					...new Set(claim.body.spans.map((span) => span.eventId)),
				].sort();
				const source = input.events.find(
					(event) => event.id === sourceEventIds[0],
				);
				const canonicalObject =
					source?.observationIdentity?.canonicalObjectKey;
				const factIdentity =
					atomic && canonicalObject
						? contentHash({
								source: canonicalObject,
								field: claim.body.assertedField,
								subjects: [
									...new Set(claim.body.subjectRefs),
								].sort(),
							})
						: null;
				const canonicalSourceRef = factIdentity
					? `evidence:fact:${factIdentity}`
					: null;
				const acceptedContext = input.knowledgeCutoff
					? (await store.listContextRevisions())
							.filter(
								(revision) =>
									revision.appliedAt <=
									input.knowledgeCutoff!,
							)
							.sort((a, b) => b.version - a.version)
							.filter(
								(revision, index, all) =>
									all.findIndex(
										(item) =>
											item.contextEntryId ===
											revision.contextEntryId,
									) === index,
							)
							.map((revision) => revision.current)
					: await store.listContextEntries();
				const canonicalAccepted =
					acceptedContext.find(
						(entry) => entry.sourceRef === canonicalSourceRef,
					) ?? null;
				const contextMatch =
					atomic && !canonicalAccepted && this.options.contextResolver
						? await this.options.contextResolver.resolveContext({
								claim: claim.body,
								events: input.events,
								runId: input.runId,
								budgetId: input.budgetId,
								knowledgeCutoff: input.knowledgeCutoff,
							})
						: null;
				const matched =
					contextMatch?.relationship === "same_fact"
						? (acceptedContext.find(
								(entry) =>
									entry.id === contextMatch.targetId &&
									entry.kind === "fact",
							) ?? null)
						: null;
				const unavailableMatch =
					contextMatch?.relationship === "same_fact" && !matched;
				const accepted =
					canonicalAccepted?.kind === "fact"
						? canonicalAccepted
						: matched;
				const sourceRef = accepted?.sourceRef ?? canonicalSourceRef;
				const effectiveAt =
					claim.body.validFrom ?? claim.body.assertedAt;
				const stale = Boolean(
					accepted &&
					Date.parse(effectiveAt) <
						Date.parse(
							accepted.effectiveFrom ?? accepted.updatedAt,
						),
				);
				const alreadyCurrent = Boolean(
					accepted &&
					accepted.kind === "fact" &&
					contentHash(accepted.value) === contentHash(value),
				);
				const targetType = accepted
					? ("context" as const)
					: ("context_create" as const);
				const targetVersion = accepted ? contentHash(accepted) : null;
				const assessment = await store.saveAssessment(
					{
						runId: input.runId,
						assessmentKey: contentHash({
							claimId: claim.id,
							targetType,
							targetVersion,
							pipelineVersion,
							assessmentPolicyVersion,
							evaluationClock: input.evaluationClock,
							historicalEvaluation: input.historicalEvaluation,
						}),
						targetType,
						targetId: accepted?.id ?? null,
						targetVersion,
						contractVersion: null,
						claimIds: [claim.id],
						evidenceFingerprint: contentHash(claim.body.spans),
						permissionFingerprint: contentHash(
							claim.body.spans.map(
								(span) => span.originObservationKey,
							),
						),
						policyVersion: assessmentPolicyVersion,
						modelVersion: extractor.name,
						relationship: accepted ? "same_outcome" : "uncertain",
						disposition:
							atomic &&
							!alreadyCurrent &&
							!stale &&
							!unavailableMatch
								? "review_required"
								: "no_change",
						reasonCodes: atomic
							? [
									"atomic_context_requires_review",
									...(accepted
										? ["matched_context_fact"]
										: []),
									...(unavailableMatch
										? ["context_target_unavailable"]
										: []),
									...(input.historicalEvaluation
										? ["historical_evaluation"]
										: []),
									...(stale ? ["stale_evidence"] : []),
									...(alreadyCurrent
										? ["already_current"]
										: []),
								]
							: [
									"atomic_context_identity_unavailable",
									...(input.historicalEvaluation
										? ["historical_evaluation"]
										: []),
								],
						body: {
							schemaVersion: 1,
							kind: "context",
							relationship: accepted
								? "same_outcome"
								: "uncertain",
							alternativeTargetIds: [],
							fields: [],
							criteria: [],
							coverage: {
								complete: false,
								requiredResources: sourceEventIds,
								gaps: stale
									? ["stale_evidence"]
									: ["human_review_required"],
								checkedAt: input.evaluationClock,
							},
							rawScores: [],
							explanation: claim.body.statement,
						},
					},
					[],
				);

				assessmentCount += 1;
				if (
					factIdentity &&
					source &&
					!stale &&
					!alreadyCurrent &&
					!unavailableMatch &&
					!input.historicalEvaluation
				) {
					const versionIdentity = contentHash({
						sourceRef,
						targetVersion,
						claimId: claim.id,
					});
					const factType = contextFactTypes.includes(
						claim.body.assertedField as ContextFactType,
					)
						? (claim.body.assertedField as ContextFactType)
						: "other";
					const proposal = await ledger.proposeContextFact({
						clientEventId: `evidence-context:${versionIdentity}`,
						assessmentId: assessment.id,
						sourceRef: sourceRef!,
						path:
							accepted?.path ?? `/evidence/facts/${factIdentity}`,
						title:
							accepted?.title ??
							claim.body.statement.trim().slice(0, 160),
						links: accepted?.links ?? [],
						factType:
							accepted?.kind === "fact"
								? accepted.factType
								: factType,
						value: value as string | number | boolean,
						sourceUrl: source.sourceUrl,
						rationale: accepted
							? "Source reports a correction to this accepted fact. Review the match and value before approval."
							: "Atomic source claim awaiting review; it is not yet accepted company knowledge.",
						requestedBy: "evidence-pipeline",
						evidenceIds: sourceEventIds,
						effectiveFrom:
							claim.body.validFrom ?? claim.body.assertedAt,
						effectiveTo: claim.body.validTo,
					});

					if (proposal.state === "pending") pendingProposalCount += 1;
				}
			}
			if (!shouldAttribute(claim)) continue;
			if (jointlyAssessed.has(claim.id)) continue;

			let resolved: Awaited<ReturnType<IdentityResolver["resolve"]>> =
				batchResolutions.get(claim.id) ??
				(await identityResolver.resolve({
					claim: claim.body,
					events: input.events,
					runId: input.runId,
					budgetId: input.budgetId,
					contextualEventIds: input.contextualEventIds ?? [],
					knowledgeCutoff: input.knowledgeCutoff,
				}));
			let escalationUsed = false;
			const escalationReasons: string[] = [];

			if (
				this.options.escalation?.maxAttempts === 1 &&
				["uncertain", "part_of"].includes(resolved.relationship)
			) {
				escalationUsed = true;
				try {
					const stronger =
						await this.options.escalation.identityResolver.resolve({
							claim: claim.body,
							events: input.events,
							runId: input.runId,
							budgetId: input.budgetId,
							knowledgeCutoff: input.knowledgeCutoff,
						});

					resolved =
						resolved.relationship === "uncertain" &&
						stronger.relationship !== "uncertain"
							? {
									...stronger,
									reasons: [
										...resolved.reasons,
										"identity_escalated",
										...stronger.reasons,
									],
								}
							: {
									...resolved,
									reasons: [
										...resolved.reasons,
										stronger.relationship ===
										resolved.relationship
											? "identity_escalation_unresolved"
											: "identity_escalation_disagreement",
									],
								};
				} catch {
					resolved = {
						...resolved,
						reasons: [
							...resolved.reasons,
							"escalation_model_failure",
						],
					};
				}
			}
			if (claim.body.kind === "request") {
				const transient =
					resolved.requestIntent === "question_or_coordination" ||
					(resolved.requestIntent === undefined &&
						isTransientCoordinationRequest(claim.body));
				const newWork =
					resolved.requestIntent === "new_work" ||
					(resolved.requestIntent === undefined && !transient);

				if (
					!resolved.targetId &&
					resolved.relationship === "unrelated"
				) {
					const assessment = await store.saveAssessment(
						{
							runId: input.runId,
							assessmentKey: contentHash({
								claimId: claim.id,
								targetType: "task_create",
								pipelineVersion,
								assessmentPolicyVersion,
								evaluationClock: input.evaluationClock,
								historicalEvaluation:
									input.historicalEvaluation,
							}),
							targetType: "task_create",
							targetId: null,
							targetVersion: null,
							contractVersion: null,
							claimIds: [claim.id],
							evidenceFingerprint: contentHash(claim.body.spans),
							permissionFingerprint: contentHash(
								claim.body.spans.map(
									(span) => span.originObservationKey,
								),
							),
							policyVersion: assessmentPolicyVersion,
							modelVersion: escalationUsed
								? `${extractor.name}+${this.options.escalation?.modelVersion ?? "unknown"}`
								: extractor.name,
							relationship: resolved.relationship,
							disposition: transient
								? "no_change"
								: "review_required",
							reasonCodes: [
								...resolved.reasons,
								...(input.historicalEvaluation
									? ["historical_evaluation"]
									: []),
								transient
									? "transient_coordination_not_work"
									: newWork
										? "new_work_requires_review"
										: "request_intent_uncertain",
							],
							body: {
								schemaVersion: 1,
								kind: "task",
								relationship: resolved.relationship,
								alternativeTargetIds:
									resolved.alternativeTargetIds,
								fields: [],
								criteria: [],
								coverage: {
									complete: false,
									requiredResources: [],
									gaps: ["scope_unconfirmed"],
									checkedAt: input.evaluationClock,
								},
								rawScores: [],
								explanation: claim.body.statement,
							},
						},
						[],
					);

					assessmentCount += 1;
					if (!newWork || input.historicalEvaluation) continue;

					const sourceEventIds = [
						...new Set(
							claim.body.spans.map((span) => span.eventId),
						),
					];
					const sourceById = new Map(
						input.events.map((event) => [event.id, event]),
					);
					const stableKey = contentHash({
						objects: claim.body.spans
							.map(
								(span) =>
									sourceById.get(span.eventId)
										?.observationIdentity
										?.canonicalObjectKey ??
									span.originObservationKey,
							)
							.sort(),
						statement: claim.body.statement.trim(),
					});
					const versionKey = contentHash({
						stableKey,
						versions: claim.body.spans
							.map((span) => span.sourceVersionKey)
							.sort(),
					});
					const externalRef = `claim:${stableKey}`;

					if (await store.findTaskByExternalRef(externalRef))
						continue;

					const proposal = await ledger.proposeTaskCreation({
						clientEventId: `evidence-request:${versionKey}`,
						externalRef,
						title: claim.body.statement.trim().slice(0, 160),
						description: claim.body.statement,
						status: "backlog",
						rationale:
							"Source reports a new work request; scope needs review.",
						requestedBy: "evidence-pipeline",
						evidenceIds: sourceEventIds,
						assessmentId: assessment.id,
					});

					if (proposal.state === "pending") pendingProposalCount += 1;
					continue;
				}
			}
			if (!resolved.targetId) {
				if (
					claim.body.kind !== "request" &&
					claim.body.kind !== "completion_report" &&
					claim.body.kind !== "progress_report"
				)
					continue;
				await store.saveAssessment(
					{
						runId: input.runId,
						assessmentKey: contentHash({
							claimId: claim.id,
							targetType: "task_create",
							pipelineVersion,
							assessmentPolicyVersion,
							evaluationClock: input.evaluationClock,
							historicalEvaluation: input.historicalEvaluation,
						}),
						targetType: "task_create",
						targetId: null,
						targetVersion: null,
						contractVersion: null,
						claimIds: [claim.id],
						evidenceFingerprint: contentHash(claim.body.spans),
						permissionFingerprint: contentHash(
							claim.body.spans.map(
								(span) => span.originObservationKey,
							),
						),
						policyVersion: assessmentPolicyVersion,
						modelVersion: escalationUsed
							? `${extractor.name}+${this.options.escalation?.modelVersion ?? "unknown"}`
							: extractor.name,
						relationship: resolved.relationship,
						disposition: "review_required",
						reasonCodes: [
							...resolved.reasons,
							"no_matched_task",
							...(input.historicalEvaluation
								? ["historical_evaluation"]
								: []),
						],
						body: {
							schemaVersion: 1,
							kind: "task",
							relationship: resolved.relationship,
							alternativeTargetIds: resolved.alternativeTargetIds,
							fields: [],
							criteria: [],
							coverage: {
								complete: false,
								requiredResources: [],
								gaps: ["task_identity_unresolved"],
								checkedAt: input.evaluationClock,
							},
							rawScores: [],
							explanation: claim.body.statement,
						},
					},
					[],
				);
				assessmentCount += 1;
				continue;
			}
			if (resolved.relationship === "unrelated") continue;

			const currentTask = await store.getTask(resolved.targetId);
			const task = input.knowledgeCutoff
				? ((await store.listTaskRevisions(resolved.targetId))
						.filter(
							(revision) =>
								revision.appliedAt <= input.knowledgeCutoff!,
						)
						.sort((left, right) => right.version - left.version)[0]
						?.current ?? null)
				: currentTask;

			if (!task) continue;

			const linkedCriterionClaims =
				claim.body.kind === "completion_report" &&
				!input.knowledgeCutoff
					? (
							await store.listClaimsForTask(task.id, null, 100)
						).filter(
							(candidate) =>
								candidate.body.assertedField ===
								"criterion_attestation",
						)
					: [];
			const linkedEventIds = [
				...new Set(
					linkedCriterionClaims.flatMap((item) =>
						item.body.spans.map((span) => span.eventId),
					),
				),
			].filter((id) => !input.events.some((event) => event.id === id));
			const [linkedEvents, currentLinkedIds] = await Promise.all([
				linkedEventIds.length
					? store.getSourceEvents(linkedEventIds)
					: Promise.resolve([]),
				store.currentSourceEventIds(
					linkedEventIds,
					input.knowledgeCutoff ?? undefined,
				),
			]);
			const currentLinked = new Set(currentLinkedIds);
			const criterionEvents: SourceEvent[] = [
				...input.events,
				...linkedEvents.filter((event) => currentLinked.has(event.id)),
			];
			const availableCriterionEvents = new Set(
				criterionEvents.map((event) => event.id),
			);
			const criterionClaims: EvidenceClaim[] = [
				claim,
				...linkedCriterionClaims.filter(
					(item) =>
						item.id !== claim.id &&
						item.body.spans.every((span) =>
							availableCriterionEvents.has(span.eventId),
						),
				),
			];
			const verificationReasons: string[] = [];

			if (linkedCriterionClaims.length === 100)
				verificationReasons.push(
					"criterion_attestation_search_truncated",
				);
			if (
				criterionClaims.length - 1 <
				linkedCriterionClaims.filter((item) => item.id !== claim.id)
					.length
			) {
				verificationReasons.push(
					"criterion_attestation_source_unavailable",
				);
			}
			if (
				input.allowLiveVerification &&
				this.options.artifactVerifier &&
				claim.body.kind === "completion_report" &&
				resolved.relationship === "same_outcome"
			) {
				if (this.options.maxEvidenceExpansions === 0) {
					verificationReasons.push("evidence_expansion_disabled");
				}

				const criteriaToVerify =
					this.options.maxEvidenceExpansions === 0
						? []
						: (task.outcomeContract?.criteria ?? []);

				for (const criterion of criteriaToVerify) {
					if (
						!criterion.required ||
						!["check_passed", "merged", "deployed"].includes(
							criterion.evidenceRule.kind,
						)
					)
						continue;
					try {
						const checked =
							await this.options.artifactVerifier.verify({
								task,
								criterion,
								runId: input.runId,
								budgetId: input.budgetId,
							});

						verificationReasons.push(...checked.reasonCodes);
						if (!checked.sourceEventId) continue;

						const verifiedRun = await this.run({
							eventIds: [checked.sourceEventId],
							budgetId: input.budgetId,
							evaluationClock: new Date().toISOString(),
							knowledgeCutoff: null,
							replayMode: "live",
						});

						if (!verifiedRun.runId) {
							verificationReasons.push(
								"verification_claim_unavailable",
							);
							continue;
						}

						const [storedClaims, sourceEvents] = await Promise.all([
							store.listClaimsByRun(verifiedRun.runId),
							store.getSourceEvents([checked.sourceEventId]),
						]);

						if (
							storedClaims.length === 0 ||
							sourceEvents.length !== 1
						) {
							verificationReasons.push(
								"verification_claim_unavailable",
							);
							continue;
						}
						criterionClaims.push(...storedClaims);
						criterionEvents.push(...sourceEvents);
					} catch {
						// Connector and interpretation failures leave a reviewable gap; the
						// original completion report must still reach its assessment.
						verificationReasons.push("verification_unavailable");
					}
				}
			}

			const assessmentClock =
				input.allowLiveVerification && criterionClaims.length > 1
					? new Date().toISOString()
					: input.evaluationClock;
			const authorizedAttestations = new Map<string, SourceSpan[]>();
			const attestationClaims = criterionClaims.filter(
				(item) => item.body.assertedField === "criterion_attestation",
			);

			if (
				attestationClaims.length > 0 &&
				task.outcomeContract &&
				this.options.application
			) {
				const [members, identities, currentIds] = await Promise.all([
					store.listMembers(),
					store.listMemberIdentities(),
					store.currentSourceEventIds(
						attestationClaims.flatMap((item) =>
							item.body.spans.map((span) => span.eventId),
						),
					),
				]);
				const current = new Set(currentIds);

				for (const candidate of attestationClaims) {
					const source = criterionEvents.find(
						(event) =>
							event.id === candidate.body.spans[0]?.eventId,
					);

					if (
						!source ||
						!current.has(source.id) ||
						source.receivedAt > assessmentClock ||
						source.occurredAt > assessmentClock ||
						candidate.body.spans.length !== 1
					)
						continue;

					const member =
						members.find(
							(item) =>
								item.id === candidate.body.speakerMemberId,
						) ?? null;
					const matches = identities.filter(
						(identity) =>
							identity.status === "active" &&
							identity.memberId === member?.id &&
							identity.provider === source.provider &&
							identity.installationKey === source.installationKey,
					);

					if (matches.length !== 1) continue;
					for (const criterion of task.outcomeContract.criteria) {
						if (candidate.body.assertedAt < criterion.acceptedAt)
							continue;

						const policy =
							this.options.application.authorityPolicies.find(
								(item) =>
									item.id ===
									criterion.evidenceRule.authorityPolicyId,
							);

						if (
							!policy ||
							!authorizedCriterionAttestation({
								claim: candidate.body,
								task,
								criterion,
								source,
								member,
								identity: matches[0]!,
								policy,
							})
						)
							continue;
						authorizedAttestations.set(criterion.id, [
							...(authorizedAttestations.get(criterion.id) ?? []),
							...candidate.body.spans,
						]);
					}
				}
			}

			const assertsTaskDone =
				claim.body.kind === "completion_report" &&
				explicitlyAssertsTaskDone(claim.body);
			// A bounded completion can justify a review proposal when identity says this is the
			// same outcome. It cannot establish an accepted terminal state by itself.
			const reportsBoundedCompletion =
				claim.body.kind === "completion_report" &&
				resolved.relationship === "same_outcome";
			const reportedStatus =
				claim.body.kind !== "request" &&
				claim.body.assertedField === "status" &&
				typeof claim.body.assertedValue === "string" &&
				reportedNonterminalStatuses.has(claim.body.assertedValue)
					? (claim.body.assertedValue as
							| "backlog"
							| "planned"
							| "in_progress"
							| "blocked"
							| "review"
							| "cancelled")
					: null;
			const reportedResult =
				claim.body.assertedField === "result" &&
				typeof claim.body.assertedValue === "string" &&
				reportedResults.has(claim.body.assertedValue)
					? (claim.body.assertedValue as
							"succeeded" | "failed" | "mixed" | "not_applicable")
					: null;
			const partOfProgress =
				resolved.relationship === "part_of" &&
				resolved.suggestedStatus === "in_progress" &&
				Boolean(resolved.statusBasis?.trim()) &&
				claim.body.kind !== "request" &&
				reportedStatus === null &&
				reportedResult === null;
			const inferredStatus =
				claim.body.kind !== "request" &&
				!reportedStatus &&
				!reportedResult &&
				resolved.suggestedStatus &&
				resolved.statusBasis?.trim() &&
				(resolved.relationship === "same_outcome" || partOfProgress)
					? resolved.suggestedStatus
					: null;
			const operation = reportsBoundedCompletion
				? {
						field: "status" as const,
						op: "set" as const,
						value: "done" as const,
						supportingClaimIds: [claim.id],
					}
				: reportedStatus !== null
					? {
							field: "status" as const,
							op: "set" as const,
							value: reportedStatus,
							supportingClaimIds: [claim.id],
						}
					: reportedResult !== null
						? {
								field: "result" as const,
								op: "set" as const,
								value: reportedResult,
								supportingClaimIds: [claim.id],
							}
						: inferredStatus !== null
							? {
									field: "status" as const,
									op: "set" as const,
									value: inferredStatus,
									supportingClaimIds: [claim.id],
								}
							: null;
			const linkedClaims =
				operation && !input.historicalEvaluation
					? await store.listClaimsForTask(task.id, null, 100)
					: [];
			const contradictionSearchTruncated = linkedClaims.length === 100;
			const corroboration = operation
				? corroborationReason(claim, linkedClaims)
				: null;
			const possibleContradictions = operation
				? linkedClaims.filter(
						(other) =>
							other.id !== claim.id &&
							other.body.assertedField === operation.field &&
							other.body.assertedValue !== operation.value &&
							other.body.assertedAt >= claim.body.assertedAt &&
							(other.body.kind === "progress_report" ||
								other.body.kind === "completion_report"),
					)
				: [];
			const contradictionEventIds = [
				...new Set(
					possibleContradictions.flatMap((other) =>
						other.body.spans.map((span) => span.eventId),
					),
				),
			];
			const [loadedContradictions, currentContradictionIds] =
				await Promise.all([
					contradictionEventIds.length > 0
						? store.getSourceEvents(contradictionEventIds)
						: Promise.resolve([]),
					store.currentSourceEventIds(
						contradictionEventIds,
						input.knowledgeCutoff ?? undefined,
					),
				]);
			const currentContradictions = new Set(currentContradictionIds);
			const contradictionEvents = loadedContradictions.filter((event) =>
				currentContradictions.has(event.id),
			);
			const availableContradictionIds = new Set(
				contradictionEvents.map((event) => event.id),
			);
			const contradictoryClaims = possibleContradictions.filter((other) =>
				other.body.spans.every((span) =>
					availableContradictionIds.has(span.eventId),
				),
			);
			const contradictionEvidenceUnavailable =
				contradictoryClaims.length !== possibleContradictions.length;
			const judgmentEvents = [
				...new Map(
					[...criterionEvents, ...contradictionEvents].map(
						(event) => [event.id, event],
					),
				).values(),
			];
			const assessmentClaims = [
				...criterionClaims,
				...contradictoryClaims.filter(
					(other) =>
						!criterionClaims.some(
							(included) => included.id === other.id,
						),
				),
			];
			const actionable = operation !== null;
			const currentValue =
				operation?.field === "status"
					? task.status
					: operation?.field === "result"
						? (task.result ?? "unknown")
						: null;
			const alreadyCurrent =
				operation !== null && operation.value === currentValue;
			const revisions = operation
				? (await store.listTaskRevisions(task.id)).filter(
						(revision) =>
							!input.knowledgeCutoff ||
							revision.appliedAt <= input.knowledgeCutoff,
					)
				: [];
			const latestFieldRevision = operation
				? [...revisions]
						.reverse()
						.find(
							(revision) =>
								revision.previous === null ||
								revision.previous[operation.field] !==
									revision.current[operation.field],
						)
				: null;
			const latestFieldTime =
				operation && latestFieldRevision
					? (latestFieldRevision.decisionMetadata?.effectiveAtByField[
							operation.field
						] ?? latestFieldRevision.appliedAt)
					: null;
			const currentClaimSpanIds =
				operation && !input.historicalEvaluation
					? new Set(
							await store.currentSourceEventIds(
								claim.body.spans.map((span) => span.eventId),
							),
						)
					: null;
			const sourceVersionStale = Boolean(
				currentClaimSpanIds &&
				claim.body.spans.some(
					(span) => !currentClaimSpanIds.has(span.eventId),
				),
			);
			const stale = Boolean(
				sourceVersionStale ||
				(operation &&
					latestFieldTime &&
					Date.parse(claim.body.assertedAt) <
						Date.parse(latestFieldTime) &&
					!alreadyCurrent),
			);
			let authorityPolicy: EvidenceAuthorityPolicy | null = null;
			const retrievalIncomplete = resolved.reasons.some((reason) =>
				[
					"candidate_overflow",
					"semantic_candidate_screened",
					"semantic_retrieval_context_unavailable",
					"semantic_retrieval_disabled",
				].includes(reason),
			);
			const authoritySource =
				claim.body.spans.length === 1
					? input.events.find(
							(event) =>
								event.id === claim.body.spans[0]!.eventId,
						)
					: null;

			if (
				operation?.field === "status" &&
				operation.value !== "done" &&
				!stale &&
				!alreadyCurrent &&
				!retrievalIncomplete &&
				authoritySource &&
				this.options.application?.mode === "apply" &&
				this.options.application.autoApplyClasses.includes(
					"task_nonterminal",
				) &&
				authoritySource.provider === "slack" &&
				JSON.stringify(authoritySource.payload).includes(
					"PANINI_STATUS",
				)
			) {
				const [members, identities] = await Promise.all([
					store.listMembers(),
					store.listMemberIdentities(),
				]);
				const member =
					members.find(
						(candidate) =>
							candidate.id === claim.body.speakerMemberId,
					) ?? null;
				const candidates = identities.filter(
					(identity) =>
						identity.memberId === member?.id &&
						identity.provider === authoritySource.provider &&
						identity.installationKey ===
							authoritySource.installationKey,
				);

				if (candidates.length === 1) {
					authorityPolicy =
						this.options.application.authorityPolicies.find(
							(policy) =>
								authorizedStatusAttestation({
									claim: claim.body,
									task,
									source: authoritySource,
									member,
									identity: candidates[0]!,
									policy,
									clock: assessmentClock,
								}),
						) ?? null;
				}
			}

			let judgeResult: EvidenceJudgeResult | null = null;
			let judgeFailed = false;

			if (operation && !authorityPolicy && this.options.judge) {
				try {
					judgeResult = await this.options.judge.assess({
						task,
						claim: claim.body,
						operation,
						contradictoryClaims: contradictoryClaims.map(
							(item) => item.body,
						),
						events: judgmentEvents,
						runId: input.runId,
						budgetId: input.budgetId,
					});
				} catch {
					judgeFailed = true;
				}
			}
			if (
				operation &&
				!authorityPolicy &&
				this.options.escalation?.maxAttempts === 1 &&
				!escalationUsed &&
				(judgeFailed ||
					judgeResult?.verdict === "uncertain" ||
					judgeResult?.verdict === "partial_scope" ||
					judgeResult?.verdict === "contradicted" ||
					contradictoryClaims.length > 0)
			) {
				escalationUsed = true;
				try {
					const stronger = await this.options.escalation.judge.assess(
						{
							task,
							claim: claim.body,
							operation,
							contradictoryClaims: contradictoryClaims.map(
								(item) => item.body,
							),
							events: judgmentEvents,
							runId: input.runId,
							budgetId: input.budgetId,
						},
					);

					escalationReasons.push("judge_escalated");
					if (
						judgeResult?.verdict === "uncertain" &&
						stronger.verdict !== "uncertain"
					) {
						judgeResult = stronger;
					} else if (
						judgeResult &&
						stronger.verdict !== judgeResult.verdict
					) {
						escalationReasons.push("judge_escalation_disagreement");
					}
				} catch {
					escalationReasons.push("escalation_model_failure");
				}
			}

			const outcomeReview =
				reportsBoundedCompletion ||
				claim.body.assertedField === "criterion_attestation"
					? assessTaskOutcomeCriteria({
							task,
							claim: {
								...claim.body,
								spans: criterionClaims.flatMap(
									(item) => item.body.spans,
								),
							},
							events: criterionEvents,
							evaluationClock: assessmentClock,
							defaultCheckpointAgeSeconds:
								this.options.maxRequiredCheckpointAgeSeconds ??
								900,
							authorizedAttestations,
						})
					: null;
			const assessment = await store.saveAssessment(
				{
					runId: input.runId,
					assessmentKey: contentHash({
						claimId: claim.id,
						targetId: task.id,
						targetVersion: task.version,
						supportingClaimIds: assessmentClaims.map(
							(item) => item.id,
						),
						pipelineVersion,
						assessmentPolicyVersion,
						evaluationClock: assessmentClock,
						historicalEvaluation: input.historicalEvaluation,
					}),
					targetType: "task",
					targetId: task.id,
					targetVersion: String(task.version),
					contractVersion: task.outcomeContract?.version ?? null,
					claimIds: assessmentClaims.map((item) => item.id),
					evidenceFingerprint: contentHash(
						assessmentClaims.flatMap((item) => item.body.spans),
					),
					permissionFingerprint: contentHash(
						assessmentClaims
							.flatMap((item) => item.body.spans)
							.map((span) => span.originObservationKey),
					),
					policyVersion: assessmentPolicyVersion,
					modelVersion: escalationUsed
						? `${extractor.name}+${this.options.escalation?.modelVersion ?? "unknown"}`
						: extractor.name,
					relationship: resolved.relationship,
					disposition:
						!inferredStatus &&
						authorityPolicy &&
						!retrievalIncomplete &&
						contradictoryClaims.length === 0 &&
						!contradictionSearchTruncated &&
						!contradictionEvidenceUnavailable
							? "eligible"
							: "review_required",
					reasonCodes: [
						...resolved.reasons,
						...(claim.body.caveats.includes(
							"commit_message_not_interpreted_as_task_state",
						)
							? ["commit_message_context_only"]
							: []),
						...(corroboration ? [corroboration] : []),
						...(input.historicalEvaluation
							? ["historical_evaluation"]
							: []),
						...(authorityPolicy
							? [
									"authorized_attestation",
									`authority_policy:${authorityPolicy.id}:v${authorityPolicy.version}`,
								]
							: [
									claim.body.kind === "completion_report"
										? "reported_completion_unverified"
										: "reported_progress_unverified",
								]),
						...verificationReasons,
						...(contradictoryClaims.length > 0
							? ["contradictory_evidence"]
							: []),
						...(contradictionSearchTruncated
							? ["contradiction_search_truncated"]
							: []),
						...(contradictionEvidenceUnavailable
							? ["contradiction_evidence_unavailable"]
							: []),
						...(stale ? ["stale_evidence"] : []),
						...(sourceVersionStale
							? ["source_version_superseded"]
							: []),
						...(alreadyCurrent ? ["already_current"] : []),
						...(operation &&
						resolved.relationship !== "same_outcome"
							? ["partial_scope"]
							: []),
						...(inferredStatus
							? ["inferred_status_requires_review"]
							: []),
						...(reportsBoundedCompletion && !assertsTaskDone
							? ["task_status_inferred_from_bounded_report"]
							: []),
						...(claim.body.assertedField === "criterion_attestation"
							? [
									authorizedAttestations.size > 0
										? "criterion_attestation_authorized"
										: "criterion_attestation_unverified",
								]
							: []),
						...(judgeFailed
							? ["model_failure"]
							: judgeResult?.verdict === "partial_scope"
								? ["partial_scope"]
								: judgeResult?.verdict === "contradicted"
									? ["contradicted"]
									: judgeResult?.verdict === "uncertain"
										? ["insufficient_support"]
										: []),
						...(!authorityPolicy &&
						!judgeResult &&
						!judgeFailed &&
						operation
							? ["model_unavailable"]
							: []),
						...(judgeResult?.reasonCodes.map(
							(code) => `judge:${code}`,
						) ?? []),
						...escalationReasons,
						...(!actionable
							? [
									claim.body.kind === "completion_report"
										? "task_done_not_explicitly_asserted"
										: claim.body.assertedField ===
											  "criterion_attestation"
											? "no_task_field_change"
											: "unsupported_field",
								]
							: []),
					],
					body: {
						schemaVersion: 1,
						kind: "task",
						relationship: resolved.relationship,
						alternativeTargetIds: resolved.alternativeTargetIds,
						fields: operation
							? [
									{
										operation,
										verdict:
											judgeResult?.verdict ===
												"contradicted" ||
											contradictoryClaims.length > 0
												? ("contradicted" as const)
												: stale ||
													  alreadyCurrent ||
													  judgeFailed ||
													  (!authorityPolicy &&
															!judgeResult) ||
													  (resolved.relationship !==
															"same_outcome" &&
															!partOfProgress) ||
													  (judgeResult &&
															judgeResult.verdict !==
																"supported") ||
													  contradictoryClaims.length >
															0 ||
													  contradictionSearchTruncated ||
													  contradictionEvidenceUnavailable ||
													  (reportsBoundedCompletion &&
															!assertsTaskDone)
													? ("insufficient" as const)
													: ("supported" as const),
										support: claim.body.spans,
										contradictions:
											contradictoryClaims.flatMap(
												(other) => other.body.spans,
											),
										effectiveAt: claim.body.assertedAt,
										reasonCodes: [
											...(reportsBoundedCompletion &&
											!assertsTaskDone
												? [
														"task_status_inferred_from_bounded_report",
													]
												: []),
											...(stale
												? ["stale_evidence"]
												: []),
											...(sourceVersionStale
												? ["source_version_superseded"]
												: []),
											...(alreadyCurrent
												? ["already_current"]
												: []),
											...(resolved.relationship !==
											"same_outcome"
												? ["partial_scope"]
												: []),
											...(contradictoryClaims.length > 0
												? ["contradictory_evidence"]
												: []),
											...(contradictionSearchTruncated
												? [
														"contradiction_search_truncated",
													]
												: []),
											...(contradictionEvidenceUnavailable
												? [
														"contradiction_evidence_unavailable",
													]
												: []),
											...(judgeFailed
												? ["model_failure"]
												: []),
											...(!authorityPolicy &&
											!judgeResult &&
											!judgeFailed
												? ["model_unavailable"]
												: []),
											...(judgeResult?.reasonCodes.map(
												(code) => `judge:${code}`,
											) ?? []),
											...escalationReasons,
										],
									},
								]
							: [],
						criteria: outcomeReview?.criteria ?? [],
						coverage: {
							...(outcomeReview?.coverage ?? {
								complete: false,
								requiredResources: [],
								gaps: actionable
									? ["reported_status_requires_review"]
									: [
											claim.body.kind ===
											"completion_report"
												? "task_done_not_explicitly_asserted"
												: "unsupported_field",
										],
								checkedAt: assessmentClock,
							}),
							complete:
								Boolean(outcomeReview?.coverage.complete) &&
								contradictoryClaims.length === 0 &&
								!contradictionSearchTruncated &&
								!contradictionEvidenceUnavailable &&
								!verificationReasons.includes(
									"criterion_attestation_search_truncated",
								) &&
								!verificationReasons.includes(
									"criterion_attestation_source_unavailable",
								),
							gaps: [
								...(outcomeReview?.coverage.gaps ??
									(actionable
										? ["reported_status_requires_review"]
										: [
												claim.body.kind ===
												"completion_report"
													? "task_done_not_explicitly_asserted"
													: "unsupported_field",
											])),
								...(contradictoryClaims.length > 0
									? ["contradictory_evidence"]
									: []),
								...(contradictionSearchTruncated
									? ["contradiction_search_truncated"]
									: []),
								...(contradictionEvidenceUnavailable
									? ["contradiction_evidence_unavailable"]
									: []),
								...(verificationReasons.includes(
									"criterion_attestation_search_truncated",
								)
									? ["criterion_attestation_search_truncated"]
									: []),
								...(verificationReasons.includes(
									"criterion_attestation_source_unavailable",
								)
									? [
											"criterion_attestation_source_unavailable",
										]
									: []),
							],
						},
						rawScores: [],
						explanation: [
							claim.body.statement,
							...(inferredStatus
								? [`Status basis: ${resolved.statusBasis}`]
								: []),
							...(judgeResult
								? [`Judge: ${judgeResult.explanation}`]
								: []),
						].join("\n"),
					},
				},
				[],
			);

			assessmentCount += 1;
			if (
				claim.body.assertedField === "criterion_attestation" &&
				resolved.relationship === "same_outcome" &&
				!input.historicalEvaluation &&
				currentTask?.version === task.version
			) {
				await store.enqueueOutboxJob({
					topic: "evidence.task.reassess",
					dedupeKey: `evidence:criterion-attestation:${pipelineVersion}:${input.budgetId}:${claim.id}:${task.id}:${task.version}`,
					payload: {
						pipelineVersion,
						taskId: task.id,
						taskVersion: task.version,
						afterClaimId: null,
					},
				});
			}
			if (
				(resolved.relationship !== "same_outcome" && !partOfProgress) ||
				!operation ||
				alreadyCurrent ||
				input.historicalEvaluation ||
				currentTask?.version !== task.version ||
				(inferredStatus && judgeResult?.verdict !== "supported")
			)
				continue;

			const proposal = await ledger.proposeAssessedTaskChange({
				assessmentId: assessment.id,
				operations: [operation],
				rationale: claim.body.statement,
				requestedBy: "evidence-pipeline",
			});

			if (
				proposal.state === "pending" &&
				!inferredStatus &&
				authorityPolicy &&
				!retrievalIncomplete &&
				contradictoryClaims.length === 0 &&
				!contradictionSearchTruncated &&
				!contradictionEvidenceUnavailable
			) {
				const budget = await store.getInferenceBudget(input.budgetId);

				if (
					budget?.state === "active" &&
					Date.parse(budget.deadline) > Date.now() &&
					budget.spentCalls + budget.reservedCalls <
						budget.maxCalls &&
					budget.spentInputTokens + budget.reservedInputTokens <
						budget.maxInputTokens &&
					budget.spentOutputTokens + budget.reservedOutputTokens <
						budget.maxOutputTokens
				) {
					await ledger.autoApplyAssessedTaskChange(
						proposal.id,
						authorityPolicy,
					);
				} else pendingProposalCount += 1;
			} else if (proposal.state === "pending") pendingProposalCount += 1;
		}
		return { assessmentCount, pendingProposalCount };
	}
}
