// Process E2E regressions: lost selected history, truncated known evidence,
// unavailable-original scope fallback, invented response IDs and blocked review routing.
import { randomUUID } from "node:crypto";
import { contentHash } from "../dist/src/domain/content-hash.js";

export async function runCompleteContextProbes(input) {
	const { store, pool, invoke, create, apply, event, runId } = input;
	const checks = [];

	// Reproduce actual lost-context and complete-evidence failures before any fix.
	for (const mode of ["reference", "large", "legacy", "review"]) {
		let target;

		if (mode !== "legacy") {
			target = (
				await apply(
					await create(
						mode === "large"
							? "Large record fixture"
							: mode === "legacy"
								? "Legacy boundary fixture"
								: mode === "review"
									? "Unsupported scope review fixture"
									: "Selected reference fixture",
						"Perform the fixture trial and capture its output",
					),
				)
			).current;
		}

		if (mode === "legacy") {
			const organization = await store.getOrganization();
			const id = randomUUID();
			const document = {
				externalRef: null,
				priority: "medium",
				owner: null,
				project: null,
				projectId: null,
				dueDate: null,
				dependencyRefs: [],
				sourceUrl: null,
				title: "Legacy boundary fixture",
				description:
					"Run a bounded trial and report its result. Report delivery completes the trial regardless of result.",
				status: "planned",
				result: "unknown",
			};

			await pool.query(
				"INSERT INTO tasks(id,organization_id,document,version,created_at,updated_at) VALUES($1,$2,$3::jsonb,1,$4,$4)",
				[
					id,
					organization.id,
					JSON.stringify(document),
					event.occurredAt,
				],
			);
			target = await store.getTask(id);
		}

		const targetScope = await invoke("define_work_scope", {
			taskId: target.id,
			expectedTaskVersion: target.version,
		});
		const evidenceInput = {
			kind: "execution",
			claimKind: "progress_report",
			claimedCorrectionIds: null,
			name: "Fixture attempt",
			externalRef: null,
			revision: null,
			environment: null,
			result: "unknown",
			statement: "Exporter implementation is partial progress",
			sourcePointer: "/text",
			quote: "Exporter built.",
			taskId: target.id,
			contractVersion: null,
			criterionIds: [],
			relationship: "attempts",
			relatedEntityId: null,
		};

		if (mode === "legacy")
			Object.assign(evidenceInput, {
				result: "failed",
				statement:
					"The bounded trial failed and its report was delivered; no repair was requested",
				quote: "Bounded trial failed and its report was delivered. No repair was requested.",
			});

		let evidence;

		for (let i = 0; i < (mode === "large" ? 101 : 1); i++)
			evidence = await invoke("record_work_evidence", {
				...evidenceInput,
				name: "Fixture attempt " + i,
			});
		if (mode === "review")
			evidence = await invoke("record_work_evidence", {
				...evidenceInput,
				name: "Corrected fixture report",
				claimKind: "correction",
				claimedCorrectionIds: [evidence.id],
				statement: "The earlier report did not establish delivery",
				quote: "Correction: the previous report did not establish delivery.",
			});

		let references = [];

		if (mode === "reference") {
			const payload = {
				text: "The trial in this discussion is the requested fixture trial.",
				selectedIdentityReferenceFixture: true,
			};
			const reference = (
				await store.appendSourceEvent({
					provider: "slack",
					installationKey: "T1",
					providerEventId: randomUUID(),
					eventKind: "message.observed",
					occurredAt: event.occurredAt,
					fetchedAt: event.occurredAt,
					sourceRef: "slack:T1:C_REF:" + randomUUID(),
					sourceUrl: null,
					contentHash: contentHash(payload),
					visibility: "company",
					payloadVersion: "context-fixture",
					payload,
				})
			).event;

			await invoke("read_source", { id: reference.id });
			references = [reference.id];

			const scopedTask = (
				await apply(
					await create(
						"Selected scope reference fixture",
						"Perform the fixture trial and capture its output",
					),
				)
			).current;
			const selectedScope = await invoke("define_work_scope", {
				taskId: scopedTask.id,
				expectedTaskVersion: scopedTask.version,
				referenceSourceEventIds: references,
			});

			if (!selectedScope.sourceEventIds.includes(reference.id))
				throw new Error(
					"Scope definition lost selected reference history",
				);
			checks.push("selected_scope_reference_included");
		}

		if (mode === "reference") {
			for (const forbidden of ["restricted", "revoked"]) {
				const payload = {
					text: "Selected reference must not be disclosed",
					selectedIdentityReferenceFixture: true,
				};
				const denied = (
					await store.appendSourceEvent({
						provider: "slack",
						installationKey: "T1",
						providerEventId: randomUUID(),
						eventKind: "message.observed",
						occurredAt: event.occurredAt,
						fetchedAt: event.occurredAt,
						sourceRef: "slack:T1:C_DENIED:" + randomUUID(),
						sourceUrl: null,
						contentHash: contentHash(payload),
						visibility:
							forbidden === "restricted"
								? "restricted"
								: "company",
						payloadVersion: "context-fixture",
						payload,
					})
				).event;

				if (forbidden === "revoked")
					await store.revokeSourceEvent(denied.id);

				const before = (await store.listModelCalls(runId)).length;
				let refused = false;

				try {
					await invoke("transition_work_state", {
						taskId: target.id,
						expectedTaskVersion: target.version,
						scopeId: targetScope.id,
						status: "in_progress",
						result: "unknown",
						assertionIds: [evidence.id],
						referenceSourceEventIds: [denied.id],
						rationale:
							"Denied reference must be rejected before provider call",
					});
				} catch {
					refused = true;
				}
				if (
					!refused ||
					(await store.listModelCalls(runId)).length !== before
				)
					throw new Error(
						forbidden +
							" selected reference reached provider or was applied",
					);
			}
		}

		const completed = await invoke("transition_work_state", {
			taskId: target.id,
			expectedTaskVersion: target.version,
			scopeId: targetScope.id,
			status: ["legacy", "review"].includes(mode)
				? "done"
				: "in_progress",
			result: mode === "legacy" ? "failed" : "unknown",
			assertionIds: [evidence.id],
			referenceSourceEventIds: references,
			rationale:
				"Use selected identity context and the complete known assertion record",
		});

		if (
			mode === "review" &&
			(completed.state !== "scope_review_required" ||
				!completed.proposalId ||
				(await store.getTask(target.id)).status === "done")
		)
			throw new Error(
				"Unsupported completion did not create a pending scope review",
			);
		if (mode === "review") {
			const proposal = (await store.listProposals()).find(
				(item) => item.id === completed.proposalId,
			);

			if (
				proposal?.state !== "pending" ||
				!proposal.changes.outcomeContract
			)
				throw new Error(
					"Scope review was not a real pending contract proposal",
				);
			await store.decideProposal(proposal.id, {
				state: "rejected",
				decidedBy: "fixture-reviewer",
				decisionNote:
					"Verified pending review; close this disposable fixture",
				auditAction: "fixture",
			});
		}
		if (
			mode !== "review" &&
			(completed.status !==
				(mode === "legacy" ? "done" : "in_progress") ||
				completed.result !==
					(mode === "legacy" ? "failed" : "unknown") ||
				completed.independentlyVerified !== false)
		)
			throw new Error(
				"Reported state transition did not apply with an inferred basis",
			);
		checks.push(
			{
				reference: "selected_reference_context_and_access",
				large: "complete_101_assertion_record",
				legacy: "accepted_boundary_and_constrained_ids",
				review: "unsupported_completion_scope_review",
			}[mode],
		);
	}

	return checks;
}
