import { runCompleteContextProbes } from "./ontology-complete-context-probes.mjs";
// E2E failures: bypass creation/state, partial work completes broad scope,
// description narrows requirements, stale/forged receipts apply, failed bounded
// trials cannot finish, formal proposals approve themselves, API hides decision basis.
// These probes use the actual actor tools, PostgreSQL, provider HTTP stub and review API.
import { randomUUID } from "node:crypto";
import { contentHash } from "../dist/src/domain/content-hash.js";
import { ObservationAgent } from "../dist/src/intelligence/observation-agent.js";
import { TeamLedger } from "../dist/src/domain/team-ledger.js";
import { ProposalPolicy } from "../dist/src/domain/policy.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "../dist/src/intelligence/model-price.js";

export async function runWorkStateProbes(input) {
	const {
		store,
		pool,
		sourceId,
		runId,
		owner,
		budgetId,
		modelOrigin,
		post,
		initialTaskId,
		origin,
		token,
	} = input;
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy({
			autoApproveNewTasks: false,
			autoApproveContext: false,
			requireReviewForTaskChanges: true,
		}),
	);
	const actor = new ObservationAgent({
		store,
		ledger,
		apiKey: "local-stub-no-egress",
		model: "gpt-6-luna",
		pipelineVersion: "state-fixture",
		allowedVisibilities: ["company"],
		priceBasis: GPT6_LUNA_PRICE_2026_10_01,
		baseUrl: modelOrigin,
		workOntology: true,
	});
	const event = (await store.getSourceEvents([sourceId]))[0];
	const noisePayload = {
		text: "Unrelated retrieved history",
		unrelatedRetrievalFixture: true,
	};
	const noise = (
		await store.appendSourceEvent({
			provider: "slack",
			installationKey: "T1",
			providerEventId: randomUUID(),
			eventKind: "message.observed",
			occurredAt: event.occurredAt,
			fetchedAt: event.occurredAt,
			sourceRef: `fixture:unrelated:${randomUUID()}`,
			sourceUrl: null,
			contentHash: contentHash(noisePayload),
			visibility: "company",
			payloadVersion: "state-fixture",
			payload: noisePayload,
		})
	).event;

	const invoke = (name, args) =>
		actor.tool(
			name,
			args,
			event,
			randomUUID(),
			new Set([sourceId, noise.id]),
			runId,
			budgetId,
			undefined,
			owner,
		);

	const reject = async (action, label) => {
		let rejected = false;

		try {
			await action();
		} catch {
			rejected = true;
		}
		if (!rejected) throw new Error(label);
	};

	const closeRejected = async (proposal) =>
		store.decideProposal(proposal.id, {
			state: "rejected",
			decidedBy: "fixture",
			decisionNote: "Expected rejected bypass",
			auditAction: "fixture",
		});

	const create = async (title, description, status = "planned") =>
		ledger.proposeTaskCreation({
			externalRef: `fixture:${randomUUID()}`,
			clientEventId: randomUUID(),
			title,
			description,
			status,
			result: "unknown",
			rationale: "Fixture request",
			requestedBy: "observation-agent",
			evidenceIds: [sourceId],
		});

	const apply = async (proposal, receiptId) =>
		store.approveAndApplyProposal({
			proposalId: proposal.id,
			state: "auto_applied",
			decidedBy: "observation-agent",
			decisionNote: "Fixture report",
			auditAction: "fixture",
			observationEventId: sourceId,
			observationRunId: runId,
			observationLeaseOwner: owner,
			...(receiptId ? { workStateAssessmentId: receiptId } : {}),
		});

	const terminalCreate = await create(
		"Bypass trial",
		"Perform a trial",
		"done",
	);

	await reject(
		() => apply(terminalCreate),
		"Candidate created terminal work without an assessment",
	);
	await closeRejected(terminalCreate);

	const sourceScopeTask = await apply(
		await create(
			"Source-backed scope fixture",
			"Run the trial and report its output.",
		),
	);
	const sourceScope = await invoke("define_work_scope", {
		taskId: sourceScopeTask.current.id,
		expectedTaskVersion: sourceScopeTask.current.version,
	});

	if (
		sourceScope.requiredSteps.length !== 1 ||
		sourceScope.requiredSteps[0].sourcePointer !== "/text" ||
		sourceScope.requiredSteps[0].sourceEventId !== sourceId ||
		sourceScope.requiredSteps[0].quote !==
			"Run the trial and report its output."
	)
		throw new Error("Source-backed scope lost its exact payload quote");

	const completeContextChecks = await runCompleteContextProbes({
		store,
		pool,
		invoke,
		create,
		apply,
		event,
		runId,
	});

	const expiredCreate = await create(
		"Expired worker trial",
		"Perform a trial",
	);

	await reject(
		() =>
			store.approveAndApplyProposal({
				proposalId: expiredCreate.id,
				state: "auto_applied",
				decidedBy: "observation-agent",
				decisionNote: "Expired fixture",
				auditAction: "fixture",
				observationEventId: sourceId,
				observationRunId: runId,
				observationLeaseOwner: "wrong-owner",
			}),
		"Expired worker created accepted work",
	);
	await closeRejected(expiredCreate);

	const broadCreate = await create(
		"Export and delivery",
		"Build exporter and deliver to receiving service",
	);
	let broad = (await apply(broadCreate)).current;
	const scope = await invoke("define_work_scope", {
		taskId: broad.id,
		expectedTaskVersion: broad.version,
	});
	const partialInput = {
		kind: "execution",
		name: "Exporter attempt",
		externalRef: null,
		revision: null,
		environment: null,
		result: "succeeded",
		statement: "Exporter built; receiving service remains unwired",
		sourcePointer: "/text",
		quote: "Exporter built. Receiving service is not wired.",
		taskId: broad.id,
		contractVersion: null,
		criterionIds: [],
		relationship: "attempts",
		relatedEntityId: null,
	};
	let pointerRejected = false;

	try {
		await invoke("record_work_evidence", {
			...partialInput,
			sourcePointer: "/payload/text",
		});
	} catch (error) {
		pointerRejected = true;
		if (!String(error).includes("relative to"))
			throw new Error(
				"Wrong payload pointer did not explain the pointer root",
			);
	}
	if (!pointerRejected)
		throw new Error("Envelope pointer was accepted as source evidence");

	const partial = await invoke("record_work_evidence", partialInput);

	const transition = (task, status, assertion, scopeId, result = "unknown") =>
		invoke("transition_work_state", {
			taskId: task.id,
			expectedTaskVersion: task.version,
			scopeId,
			status,
			result,
			assertionIds: [assertion.id],
			rationale: "Fixture bounded source report",
		});

	await reject(
		() => transition(broad, "done", partial, scope.id, "succeeded"),
		"Successful component completed missing delivery",
	);
	if ((await store.getTask(broad.id)).version !== broad.version)
		throw new Error("Rejected completion changed accepted task");

	const correction = await invoke("record_work_evidence", {
		kind: "execution",
		claimKind: "correction",
		claimedCorrectionIds: [partial.id],
		name: "Unresolved delivery correction",
		externalRef: null,
		revision: null,
		environment: null,
		result: "unknown",
		statement: "Delivery remains unwired",
		sourcePointer: "/text",
		quote: "Receiving service is not wired.",
		taskId: broad.id,
		contractVersion: null,
		criterionIds: [],
		relationship: "contradicts",
		relatedEntityId: null,
	});

	if (
		correction.correctionStatus !== "claimed_unresolved" ||
		correction.claim.body.supersedesClaimIds.length ||
		correction.claimedCorrectionIds[0] !== partial.id
	)
		throw new Error(
			"Correction text silently replaced prior evidence or granted authority",
		);

	await reject(
		() => transition(broad, "review", partial, scope.id),
		"Omitted stored requirement was accepted",
	);

	const bypass = await store.createProposal({
		clientEventId: randomUUID(),
		kind: "task_change",
		taskId: broad.id,
		baseVersion: broad.version,
		changes: { status: "done" },
		rationale: "Bypass assessment",
		requestedBy: "observation-agent",
		evidenceIds: [sourceId],
	});

	await reject(
		() => apply(bypass),
		"Ordinary state write bypassed work assessment",
	);
	await closeRejected(bypass);
	await transition(broad, "in_progress", partial, scope.id);
	broad = await store.getTask(broad.id);

	const receipts = await store.readWorkStateAssessments(broad.id, [
		"company",
	]);
	const receipt = receipts[0];
	const stale = await store.createProposal({
		clientEventId: randomUUID(),
		kind: "task_change",
		taskId: broad.id,
		baseVersion: broad.version,
		changes: receipt.context.changes,
		rationale: "Stale receipt",
		requestedBy: "observation-agent",
		evidenceIds: [sourceId],
	});

	await reject(
		() => apply(stale, receipt.id),
		"Stale assessment changed accepted state",
	);
	await closeRejected(stale);
	await reject(
		() =>
			store.saveWorkStateAssessment({
				...receipt,
				key: randomUUID(),
				context: { ...receipt.context, task: broad },
				assessment: {
					...receipt.assessment,
					scopeComplete: true,
					requirements: receipt.assessment.requirements.map(
						(step) => ({ ...step, performed: "yes" }),
					),
				},
			}),
		"Forged model assessment was accepted",
	);

	const narrowed = await store.createProposal({
		clientEventId: randomUUID(),
		kind: "task_change",
		taskId: broad.id,
		baseVersion: broad.version,
		changes: { description: "Build exporter" },
		rationale: "Generated progress summary",
		requestedBy: "observation-agent",
		evidenceIds: [sourceId],
	});

	broad = (await apply(narrowed)).current;

	const preserved = await invoke("define_work_scope", {
		taskId: broad.id,
		expectedTaskVersion: broad.version,
	});

	if (
		preserved.id !== scope.id ||
		preserved.boundary.description !==
			"Build exporter and deliver to receiving service"
	)
		throw new Error("Progress description narrowed stored scope");

	const scopeReview = await transition(
		broad,
		"done",
		partial,
		scope.id,
		"succeeded",
	);

	if (
		scopeReview.state !== "scope_review_required" ||
		!scopeReview.proposalId ||
		(await store.getTask(broad.id)).status !== "in_progress"
	)
		throw new Error(
			"Unresolved correction did not create a real scope review proposal",
		);

	const scopeProposal = await store.getProposal(scopeReview.proposalId);

	if (
		scopeProposal.changes.outcomeContract.criteria.length !==
			scope.requiredSteps.length ||
		scopeProposal.changes.outcomeContract.criteria.some(
			(criterion) => criterion.acceptedBy !== "pending:review",
		)
	)
		throw new Error("Scope review narrowed or self-approved requirements");
	await reject(
		() =>
			store.approveAndApplyProposal({
				proposalId: scopeReview.proposalId,
				state: "auto_applied",
				decidedBy: "observation-agent",
				decisionNote: "Self approval",
				auditAction: "fixture",
			}),
		"Model approved its scope review proposal",
	);
	await post(`/api/proposals/${scopeReview.proposalId}/reject`, {
		note: "Fixture keeps original requested delivery; correction remains unresolved.",
	});

	const boundedCreate = await create(
		"Bounded trial",
		"Run one bounded trial and report its result; no repair requested",
	);
	const bounded = (await apply(boundedCreate)).current;
	const boundedScope = await invoke("define_work_scope", {
		taskId: bounded.id,
		expectedTaskVersion: bounded.version,
	});
	const failed = await invoke("record_work_evidence", {
		kind: "execution",
		claimKind: "completion_report",
		name: "Bounded failed trial",
		externalRef: null,
		revision: null,
		environment: null,
		result: "failed",
		statement:
			"Bounded trial failed and report delivered; no repair requested",
		sourcePointer: "/text",
		quote: "Bounded trial failed and its report was delivered. No repair was requested.",
		taskId: bounded.id,
		contractVersion: null,
		criterionIds: [],
		relationship: "attempts",
		relatedEntityId: null,
	});

	await transition(bounded, "done", failed, boundedScope.id, "failed");

	const finished = await store.getTask(bounded.id);

	if (finished.status !== "done" || finished.result !== "failed")
		throw new Error(
			"Bounded failed trial could not complete requested work",
		);

	const formal = await store.getTask(initialTaskId);
	const formalScope = await invoke("define_work_scope", {
		taskId: formal.id,
		expectedTaskVersion: formal.version,
	});
	// Scope approval reopens prior completion. A later report is required.
	const nativeTime = new Date(Date.now()).toISOString();
	const nativeTs = `${Date.now()}.000001`;
	const payload = {
		teamId: "T1",
		channel: "C1",
		user: "U_REPORTER",
		messageTs: nativeTs,
		text: "Receiving-service delivery has now been reviewed; the bounded handoff is complete.",
	};
	const fresh = (
		await store.appendSourceEvent({
			provider: "slack",
			installationKey: "T1",
			providerEventId: randomUUID(),
			eventKind: "message.observed",
			occurredAt: nativeTime,
			fetchedAt: nativeTime,
			sourceRef: `slack:T1:C1:${nativeTs}`,
			sourceUrl: null,
			contentHash: contentHash(payload),
			visibility: "company",
			payloadVersion: "state-fixture",
			payload,
		})
	).event;
	const freshOwner = `formal-fixture-${randomUUID()}`;
	const claimed = await store.claimObservation({
		eventId: fresh.id,
		pipelineVersion: "formal-state-fixture",
		workerId: freshOwner,
		leaseSeconds: 300,
		now: new Date().toISOString(),
	});

	if (claimed.kind !== "claimed")
		throw new Error("Fresh formal report was not claimed");

	const freshRun = await store.createV2Run({
		model: "gpt-6-luna",
		inputHash: contentHash(payload),
		eventIds: [fresh.id],
		pipelineVersion: "formal-state-fixture",
		promptVersion: "observation-agent-ontology-v2",
		policyVersion: "observation-agent-v1",
		configHash: "state-fixture",
		replayMode: "live",
		evaluationClock: nativeTime,
		knowledgeCutoff: null,
		budgetId,
		manifest: {},
	});

	await store.saveObservationAgentCheckpoint({
		runId: freshRun.id,
		dispositionId: claimed.disposition.id,
		owner: freshOwner,
		checkpoint: {
			budgetId,
			transcript: [],
			nextTurn: 0,
			finished: false,
			writes: 0,
			sourceEventIds: [fresh.id],
		},
	});

	const formalInvoke = (name, args) =>
		actor.tool(
			name,
			args,
			fresh,
			randomUUID(),
			new Set([fresh.id]),
			freshRun.id,
			budgetId,
			undefined,
			freshOwner,
		);

	const formalEvidence = await formalInvoke("record_work_evidence", {
		kind: "execution",
		claimKind: "completion_report",
		name: "Reviewed handoff",
		externalRef: null,
		revision: null,
		environment: null,
		result: "succeeded",
		statement: payload.text,
		sourcePointer: "/text",
		quote: payload.text,
		taskId: formal.id,
		contractVersion: formal.outcomeContract.version,
		criterionIds: ["receiving-service"],
		relationship: "supports",
		relatedEntityId: null,
	});
	const review = await formalInvoke("transition_work_state", {
		taskId: formal.id,
		expectedTaskVersion: formal.version,
		scopeId: formalScope.id,
		status: "done",
		result: "succeeded",
		assertionIds: [formalEvidence.id],
		rationale: "Later report is eligible for required human review",
	});

	if (
		review.state !== "review_required" ||
		!review.proposalId ||
		(await store.getTask(formal.id)).status === "done"
	)
		throw new Error(
			"Formal completion did not produce a real pending review proposal",
		);
	await reject(
		() =>
			store.approveAndApplyProposal({
				proposalId: review.proposalId,
				state: "auto_applied",
				decidedBy: "observation-agent",
				decisionNote: "Self approval",
				auditAction: "fixture",
			}),
		"Model approved formal completion itself",
	);

	const authBefore = (
		await pool.query(
			"SELECT authorization_version FROM source_events WHERE id=$1",
			[sourceId],
		)
	).rows[0].authorization_version;

	await pool.query(
		"UPDATE source_events SET authorization_version=authorization_version+1 WHERE id=$1",
		[sourceId],
	);
	await reject(
		() =>
			post(`/api/proposals/${review.proposalId}/approve`, {
				note: "Stale source authorization must fail",
			}),
		"Formal acceptance ignored a changed source authorization",
	);
	await pool.query(
		"UPDATE source_events SET authorization_version=$2 WHERE id=$1",
		[sourceId, authBefore],
	);

	const savedScope = (
		await pool.query("SELECT body_envelope FROM work_scopes WHERE id=$1", [
			formalScope.id,
		])
	).rows[0].body_envelope;

	await pool.query("UPDATE work_scopes SET body_envelope=NULL WHERE id=$1", [
		formalScope.id,
	]);
	await reject(
		() =>
			post(`/api/proposals/${review.proposalId}/approve`, {
				note: "Unavailable scope must fail",
			}),
		"Formal acceptance ignored unavailable original scope",
	);
	await pool.query(
		"UPDATE work_scopes SET body_envelope=$2::jsonb WHERE id=$1",
		[formalScope.id, JSON.stringify(savedScope)],
	);

	await post(`/api/proposals/${review.proposalId}/approve`, {
		note: "Fixture human reviewer accepts the bounded report and records the manual receiving-service review override.",
	});

	const projection = await fetch(
		`${origin}/api/work-model?taskId=${formal.id}`,
		{ headers: { authorization: `Bearer ${token}` } },
	);
	const model = await projection.json();

	if (
		!projection.ok ||
		model.task.status !== "done" ||
		model.scope.id !== formalScope.id ||
		!model.assessments.some(
			(item) =>
				item.id === review.workStateAssessmentId &&
				item.appliedVersion &&
				item.independentlyVerified === false,
		)
	)
		throw new Error(
			"Work API lost assessment, scope, acceptance or verification basis",
		);

	const originalReceipts = (
		await pool.query(
			"SELECT count(*)::int AS n FROM work_state_assessments WHERE body_envelope IS NOT NULL",
		)
	).rows[0].n;

	if (originalReceipts !== 7)
		throw new Error(
			`Unexpected accepted assessment receipt count: ${originalReceipts}`,
		);
	await store.completeObservationAgent({
		runId: freshRun.id,
		dispositionId: claimed.disposition.id,
		owner: freshOwner,
		writes: 1,
	});
	await store.revokeSourceEvent(fresh.id);

	return [
		...completeContextChecks,
		"source_backed_scope_payload_pointer_contract",
		"unrelated_search_sources_excluded_from_scope_and_transition",
		"claimed_correction_preserves_prior_evidence",
		"terminal_create_rejected",
		"expired_worker_create_rejected",
		"ordinary_state_bypass_rejected",
		"partial_success_not_done",
		"stored_requirement_omission_rejected",
		"partial_progress_accepted",
		"stale_receipt_rejected",
		"forged_receipt_rejected",
		"immutable_request_scope",
		"scope_correction_review_proposal",
		"bounded_failed_trial_done",
		"formal_review_proposal",
		"formal_model_self_approval_rejected",
		"formal_human_approval",
		"formal_source_authorization_revalidated",
		"formal_scope_availability_revalidated",
		"work_model_api",
	];
}
