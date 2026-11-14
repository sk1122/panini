// Agent cards, integrations, devices and task detail.

function renderAgents() {
	const connectable = state.agents.filter(
		(profile) => profile.status === "active",
	);
	const selectedProfile = byId("connect-agent-profile").value;

	// Setup steps live on each agent card; the top-bar menu duplicated them.
	byId("agent-connect-menu").hidden = true;
	byId("connect-agent-profile").innerHTML = connectable
		.map(
			(profile) =>
				'<option value="' +
				esc(profile.id) +
				'">' +
				esc(profile.name) +
				"</option>",
		)
		.join("");
	if (connectable.some((profile) => profile.id === selectedProfile))
		byId("connect-agent-profile").value = selectedProfile;
	byId("connect-harness-options").innerHTML = Object.entries(harnessLabels)
		.map(
			([key, label]) =>
				'<button type="button" data-connect-harness="' +
				key +
				'"><i class="ph ph-' +
				harnessIcons[key] +
				'" aria-hidden="true"></i> ' +
				label +
				"</button>",
		)
		.join("");
	byId("agent-count").textContent = String(
		state.agents.filter((profile) => profile.status === "active").length,
	);

	const members = state.workspace
		? state.workspace.members.filter(
				(member) =>
					member.status === "active" &&
					(isAdmin() ||
						member.id === state.account?.identity?.memberId),
			)
		: [];

	byId("agent-member").innerHTML = members
		.map(
			(member) =>
				'<option value="' +
				esc(member.id) +
				'">' +
				esc(member.displayName) +
				" · " +
				esc(member.role) +
				"</option>",
		)
		.join("");
}

const providerIcons = {
	notion: "notion-logo",
	slack: "slack-logo",
	github: "github-logo",
	agent: "robot",
	manual: "pencil-simple",
};

function renderIntegrations() {
	const installations = state.workspace
		? state.workspace.installations.filter(
				(item) =>
					item.status !== "disabled" && item.status !== "revoked",
			)
		: [];
	const connectorSyncs = state.workspace
		? state.workspace.connectorSyncs || []
		: [];

	byId("integration-count").textContent = String(installations.length);
	byId("integrations").innerHTML =
		installations
			.map((item) => {
				const resources =
					item.config.roots ||
					item.config.channels ||
					item.config.repositories ||
					[];
				const resourceCopy =
					Array.isArray(resources) && resources.length
						? resources.length + " selected"
						: "No resources selected";
				const syncs = connectorSyncs.filter(
					(sync) => sync.installationId === item.id,
				);
				const repair = syncs.length
					? syncs
							.map(
								(sync) =>
									sync.resourceKey +
									": " +
									sync.status +
									(sync.lastError
										? " · " + sync.lastError
										: "") +
									(sync.lastRepairAt
										? " · repaired " +
											formatDate(sync.lastRepairAt)
										: ""),
							)
							.join(" / ")
					: "No durable source checkpoint yet";

				return (
					'<article class="integration-card"><div class="integration-card-head"><div class="integration-title"><i class="ph ph-' +
					esc(providerIcons[item.provider] || "plugs-connected") +
					'" aria-hidden="true"></i><div><h2>' +
					esc(item.displayName) +
					"</h2><span>" +
					esc(item.provider) +
					" / " +
					esc(item.transport) +
					'</span></div></div><span class="health-state ' +
					esc(item.status) +
					'">' +
					esc(item.status) +
					"</span></div>" +
					'<div class="integration-details"><div><small>Allowed scope</small><span>' +
					esc(resourceCopy) +
					"</span></div><div><small>Last success</small><span>" +
					esc(
						item.lastSuccessAt
							? formatDate(item.lastSuccessAt)
							: "Not synced",
					) +
					"</span></div></div>" +
					'<p class="connector-checkpoint">' +
					esc(repair) +
					"</p>" +
					"<p>" +
					esc(
						item.lastError ||
							"Connector content is retained separately from immutable receipt metadata.",
					) +
					"</p>" +
					'<div class="proposal-actions"><button class="button quiet small" data-installation-disable="' +
					esc(item.id) +
					'">Disable</button><button class="button danger small" data-installation-revoke="' +
					esc(item.id) +
					'">Revoke</button></div></article>'
				);
			})
			.join("") ||
		'<div class="empty agent-empty"><strong>No integrations configured</strong><span>Add only the sources and resources Panini is allowed to observe.</span></div>';
}

function renderDevices() {
	const profiles = new Map(
		state.agents.map((profile) => [profile.id, profile]),
	);

	byId("devices").innerHTML =
		state.devices
			.map(
				(device) =>
					'<div class="activity-row"><strong>' +
					esc(device.name) +
					"</strong><span>" +
					esc(
						(profiles.get(device.agentProfileId) || {}).name ||
							"Unknown profile",
					) +
					" / " +
					esc(device.privacyMode.replaceAll("_", " ")) +
					" / " +
					esc(device.status) +
					"</span>" +
					(device.status === "active"
						? '<button class="button danger small" data-device-revoke="' +
							esc(device.id) +
							'">Revoke</button>'
						: "<time>" +
							esc(formatDate(device.updatedAt)) +
							"</time>") +
					"</div>",
			)
			.join("") ||
		'<div class="empty"><strong>No relay devices enrolled</strong><span>Enroll a device to queue signed, privacy-filtered reports while offline.</span></div>';
	byId("device-profile").innerHTML = state.agents
		.filter((profile) => profile.status === "active")
		.map(
			(profile) =>
				'<option value="' +
				esc(profile.id) +
				'">' +
				esc(profile.name) +
				" (" +
				esc(profile.owner) +
				")</option>",
		)
		.join("");
}

function renderMappings() {
	byId("repository-mappings").innerHTML =
		state.mappings
			.map(
				(mapping) =>
					'<div class="activity-row"><strong>' +
					esc(mapping.repository) +
					"</strong><span>" +
					esc(mapping.project) +
					" / " +
					mapping.contextPaths.length +
					" context paths</span><time>" +
					esc(formatDate(mapping.updatedAt)) +
					"</time></div>",
			)
			.join("") ||
		'<div class="empty"><strong>No repository mappings</strong><span>Map repositories so agents receive relevant project context.</span></div>';
}

async function openTaskDetail(id) {
	const [detail, workModel, ledger] = await Promise.all([
		api("/api/tasks/" + encodeURIComponent(id)),
		api("/api/work-model?taskId=" + encodeURIComponent(id)),
		api("/api/tasks/" + encodeURIComponent(id) + "/ledger").catch(
			() => null,
		),
	]);

	renderTaskDetail({ ...detail, workModel, ledger });
}

function renderTaskLedger(task, ledger) {
	if (!ledger) return "";

	const claims = ledger.claims
		.map(
			(claim) =>
				'<div class="activity-row"><strong><span class="session-dot active"></span>' +
				esc(claim.agentName || "Agent") +
				" <small>" +
				esc(claim.owner || "") +
				"</small></strong><span>" +
				(claim.inferred ? "inferred from branch · " : "") +
				"since " +
				esc(formatDate(claim.claimedAt)) +
				"</span><time>until " +
				esc(formatDate(claim.expiresAt)) +
				"</time></div>",
		)
		.join("");
	const handoff = ledger.handoffs[0];
	const handoffView = handoff
		? '<dl class="handoff-note"><div><dt>Done</dt><dd>' +
			esc(handoff.done || "-") +
			"</dd></div><div><dt>Not done</dt><dd>" +
			esc(handoff.notDone || "-") +
			"</dd></div><div><dt>Open questions</dt><dd>" +
			esc(handoff.openQuestions || "-") +
			"</dd></div><div><dt>Next step</dt><dd>" +
			esc(handoff.nextStep || "-") +
			"</dd></div>" +
			(handoff.artifacts.length
				? "<div><dt>Artifacts</dt><dd>" +
					handoff.artifacts.map(esc).join("<br>") +
					"</dd></div>"
				: "") +
			'</dl><p class="handoff-meta">By ' +
			esc(
				handoff.author.split(":").slice(2).join(":") || handoff.author,
			) +
			" · " +
			esc(formatDate(handoff.createdAt)) +
			"</p>"
		: '<div class="empty"><span>No handoff note yet.</span></div>';

	return (
		'<div class="section-head compact-head"><div><h2>Who is working on it</h2><p>Agent claims are advisory and expire after two hours without activity.</p></div>' +
		(claims && canReview()
			? '<button class="button quiet small" data-clear-claims="' +
				esc(task.id) +
				'">Clear claims</button>'
			: "") +
		"</div>" +
		'<div class="activity-list">' +
		(claims ||
			'<div class="empty"><span>No agent holds this task.</span></div>') +
		"</div>" +
		'<div class="section-head compact-head"><div><h2>Latest handoff</h2><p>What the last agent or person left for the next one.</p></div></div>' +
		handoffView
	);
}

function renderWorkModel(model) {
	if (!model) return "";

	const scope = model.scope;
	const current = model.assessments
		.slice()
		.reverse()
		.find(
			(item) =>
				item.appliedVersion === model.task.version &&
				item.scopeId === scope?.id,
		);
	const labels = {
		yes: "Reported performed",
		no: "Not performed",
		uncertain: "Not established",
		conflicting: "Conflicting reports",
	};
	const requirements = scope
		? '<ol class="work-requirements">' +
			scope.requiredSteps
				.map((step) => {
					const assessment = current?.assessment.requirements.find(
						(item) => item.id === step.id,
					);

					return (
						"<li><strong>" +
						esc(step.description) +
						"</strong><small>" +
						esc(
							assessment
								? labels[assessment.performed]
								: "Not assessed for the current task version",
						) +
						"</small><details><summary>Scope evidence</summary><blockquote>" +
						esc(step.quote) +
						"</blockquote></details></li>"
					);
				})
				.join("") +
			'</ol><p class="muted-copy">Inferred scope. A scope change needs verified authority.</p>'
		: '<p class="muted-copy">No inferred scope has been recorded for this task.</p>';
	const evidence = model.evidence
		.map((item) => {
			const claim = item.claim.body;
			const sourceId = claim.spans[0]?.eventId;
			const reference =
				item.entity.externalRef &&
				/^https?:\/\//i.test(item.entity.externalRef)
					? '<a href="' +
						esc(item.entity.externalRef) +
						'" target="_blank" rel="noreferrer">Open artifact</a>'
					: "";

			return (
				'<article class="work-evidence"><header><strong>' +
				esc(item.entity.name) +
				"</strong><span>" +
				esc(item.entity.kind === "execution" ? "Attempt" : "Artifact") +
				"</span></header><p>" +
				esc(claim.statement) +
				"</p><small>Source report · " +
				esc(claim.assertedValue?.result || "unknown") +
				" · " +
				esc(formatDate(claim.assertedAt)) +
				"</small><small>Task link: " +
				esc(item.relationship) +
				" · inferred by model</small>" +
				(item.entity.revision
					? "<small>Revision: " +
						esc(item.entity.revision) +
						"</small>"
					: "") +
				(item.entity.environment
					? "<small>Environment: " +
						esc(item.entity.environment) +
						"</small>"
					: "") +
				'<div class="agent-grants">' +
				(sourceId
					? '<button class="button quiet small" data-work-source="' +
						esc(sourceId) +
						'">Read source</button>'
					: "") +
				reference +
				"</div></article>"
			);
		})
		.join("");

	return (
		'<section class="work-model" aria-label="Work model"><div class="section-head compact-head"><div><h2>Requested work</h2><p>Original requirements and the latest accepted assessment.</p></div></div>' +
		requirements +
		'<div class="section-head compact-head"><div><h2>Attempts and outputs</h2><p>Reports and inferred links are not independent verification.</p></div></div>' +
		(evidence ||
			'<p class="muted-copy">No linked attempts or artifacts recorded.</p>') +
		(model.evidence.length === 100
			? '<p class="muted-copy">Showing up to 100 records. More evidence may exist.</p>'
			: "") +
		"</section>"
	);
}

function renderTaskDetail(detail) {
	const task = detail.task;
	const revisions = detail.revisions
		.slice()
		.reverse()
		.map((revision) => {
			const labels = {
				status: "Status",
				owner: "Owner",
				project: "Project",
				title: "Title",
				description: "Description",
				dueDate: "Due date",
				priority: "Priority",
			};
			const changed = revision.previous
				? Object.entries(labels)
						.filter(
							([key]) =>
								JSON.stringify(revision.current[key]) !==
								JSON.stringify(revision.previous[key]),
						)
						.map(
							([key, label]) =>
								label +
								": " +
								changeValue(revision.previous[key]) +
								" → " +
								changeValue(revision.current[key]),
						)
				: ["First recorded"];
			const proposal = detail.proposals.find(
				(item) => item.id === revision.proposalId,
			);

			return (
				'<div class="knowledge-change"><time>' +
				esc(formatDate(revision.appliedAt)) +
				"</time><strong>" +
				esc(changed.join(" · ") || "Other details changed") +
				"</strong><small>Recorded by " +
				esc(recordedBy(revision.appliedBy)) +
				"</small>" +
				(proposal?.rationale
					? "<p>Recorded note: " +
						esc(who(proposal.rationale)) +
						"</p>"
					: "") +
				"</div>"
			);
		})
		.join("");
	const pending = detail.proposals
		.filter((proposal) => proposal.state === "pending")
		.map(
			(proposal) =>
				'<div class="activity-row pending-row"><strong>Pending ' +
				esc(proposal.kind.replaceAll("_", " ")) +
				"</strong><span>" +
				esc(Object.keys(proposal.changes).join(", ")) +
				" · " +
				esc(proposal.rationale) +
				"</span><time>Base v" +
				esc(proposal.baseVersion || "new") +
				"</time></div>",
		)
		.join("");
	const evidence = detail.evidence
		.map(
			(item) =>
				'<div class="activity-row"><strong>' +
				esc(item.provider + " · " + item.eventKind) +
				"</strong><span>" +
				esc(item.sourceRef) +
				"</span><time>" +
				esc(formatDate(item.occurredAt)) +
				"</time></div>",
		)
		.join("");
	const activity = (detail.activityCandidates || [])
		.map(
			(item) =>
				'<div class="activity-row"><strong>' +
				esc(item.eventKind.replaceAll("_", " ")) +
				"</strong><span>" +
				(item.sourceUrl && item.sourceUrl.startsWith("https://")
					? '<a href="' +
						esc(item.sourceUrl) +
						'" target="_blank" rel="noreferrer">' +
						esc(item.sourceRef) +
						"</a>"
					: esc(item.sourceRef)) +
				"</span><time>" +
				esc(formatDate(item.occurredAt)) +
				"</time></div>",
		)
		.join("");
	const coverage = detail.activityCoverage || { bounded: false, scanned: 0 };
	const dependencies = task.dependencyRefs.length
		? task.dependencyRefs.map(dependencyName).join(", ")
		: "None";
	const canUndo =
		canReview() &&
		detail.allowedActions.find(
			(action) => action.action === "undo" && action.allowed,
		);
	const contract = task.outcomeContract;
	const contractView = contract
		? "<p>" +
			esc(contract.statement) +
			"</p><p><strong>Scope:</strong> " +
			esc(contract.scope) +
			"</p>" +
			(contract.exclusions.length
				? "<p><strong>Exclusions:</strong> " +
					esc(contract.exclusions.join("; ")) +
					"</p>"
				: "") +
			'<div class="activity-list">' +
			contract.criteria
				.map(
					(criterion) =>
						'<div class="activity-row"><strong>' +
						esc(criterion.description) +
						"</strong><span>" +
						esc(criterion.required ? "Required" : "Optional") +
						" · " +
						esc(criterion.evidenceRule.kind.replaceAll("_", " ")) +
						(criterion.evidenceRule.artifactRefs.length
							? " · " +
								esc(
									criterion.evidenceRule.artifactRefs.join(
										", ",
									),
								)
							: "") +
						"</span></div>",
				)
				.join("") +
			"</div><small>Accepted " +
			esc(formatDate(contract.provenance.acceptedAt)) +
			" by " +
			esc(recordedBy(contract.provenance.actor)) +
			" · v" +
			esc(contract.version) +
			"</small>"
		: '<p class="muted-copy">No reviewer-approved outcome contract. Inferred scope and evidence checks still apply.</p>';
	const contractDraft = canReview()
		? '<details class="source-details"><summary>Propose an outcome contract</summary>' +
			'<form id="outcome-contract-form" class="settings-form" data-task-id="' +
			esc(task.id) +
			'" data-task-version="' +
			esc(task.version) +
			'">' +
			'<div class="field"><label>Outcome statement</label><textarea name="statement" required maxlength="5000">' +
			esc(contract?.statement || "") +
			"</textarea></div>" +
			'<div class="field"><label>Scope</label><textarea name="scope" required maxlength="5000">' +
			esc(contract?.scope || "") +
			"</textarea></div>" +
			'<div class="field"><label>Exclusions, one per line</label><textarea name="exclusions">' +
			esc(contract?.exclusions.join("\n") || "") +
			"</textarea></div>" +
			'<div class="field"><label>Criteria JSON</label><textarea name="criteria" required rows="8">' +
			esc(
				JSON.stringify(
					contract?.criteria.map((item) => ({
						id: item.id,
						description: item.description,
						required: item.required,
						evidenceRule: item.evidenceRule,
					})) || [],
					null,
					2,
				),
			) +
			"</textarea><small>Each criterion needs an id, description, required flag, and evidenceRule. For GitHub merge or deployment checks, include the pull URL and exact 40-character SHA in artifactRefs.</small></div>" +
			'<div class="field"><label>Reason for this contract</label><textarea name="rationale" required maxlength="2000"></textarea></div>' +
			'<button class="button primary" type="submit">Send for review</button></form></details>'
		: "";

	byId("task-detail-content").innerHTML =
		'<div class="detail-head"><div><h2>' +
		esc(task.title) +
		"</h2><p>" +
		esc(
			task.description && task.description.length <= 400
				? task.description
				: "Requirements and evidence are shown below.",
		) +
		'</p></div><span class="detail-state">' +
		esc(task.status.replaceAll("_", " ")) +
		"</span></div>" +
		'<div class="detail-grid"><div><small>Result</small><span>' +
		esc(task.result || "unknown") +
		"</span></div><div><small>Owner</small><span>" +
		esc(task.owner || "Unassigned") +
		"</span></div><div><small>Project</small><span>" +
		esc(task.project || "No project") +
		"</span></div><div><small>Last changed</small><span>" +
		esc(formatDate(task.updatedAt)) +
		"</span></div><div><small>Priority</small><span>" +
		esc(task.priority) +
		"</span></div><div><small>Dependencies</small><span>" +
		esc(dependencies) +
		"</span></div><div><small>Source</small><span>" +
		(task.sourceUrl
			? '<a href="' +
				esc(task.sourceUrl) +
				'" target="_blank" rel="noreferrer">Open original</a>'
			: "Added in Panini") +
		"</span></div></div>" +
		(task.description && task.description.length > 400
			? '<details class="source-details"><summary>Full task description</summary><p class="task-description">' +
				esc(task.description) +
				"</p></details>"
			: "") +
		renderTaskLedger(task, detail.ledger) +
		renderWorkModel(detail.workModel) +
		'<div class="section-head compact-head"><div><h2>Outcome contract</h2><p>Accepted scope and proof needed for completion.</p></div></div>' +
		contractView +
		contractDraft +
		(pending
			? '<div class="section-head compact-head"><div><h2>Changes under review</h2><p>The current task has not changed yet.</p></div></div><div class="activity-list">' +
				pending +
				"</div>"
			: "") +
		'<div class="section-head compact-head"><div><h2>Possible linked activity</h2><p>Reference matches are clues. They do not change accepted status.</p></div></div><div class="activity-list">' +
		(activity ||
			'<div class="empty"><span>No activity with an exact task reference found.</span></div>') +
		"</div>" +
		(coverage.bounded
			? '<p class="muted-copy">Recent event window reached its limit; older activity may be missing.</p>'
			: "") +
		'<div class="section-head"><div><h2>How this task changed</h2></div>' +
		(canUndo
			? '<button class="button danger small" data-task-undo="' +
				esc(task.id) +
				'">Undo latest</button>'
			: "") +
		'</div><div class="knowledge-history">' +
		revisions +
		"</div>" +
		'<details class="source-details"><summary>View sources</summary><div class="activity-list">' +
		(evidence ||
			'<div class="empty"><span>No source receipts recorded.</span></div>') +
		"</div></details>";
	byId("task-detail-dialog").showModal();
}

function renderRetrieval(result) {
	const entries = result.entries
		.map(
			(entry) =>
				'<button class="retrieval-result" data-retrieval-entry="' +
				esc(entry.id) +
				'"><h3>' +
				esc(entry.title) +
				"</h3><p>Updated " +
				esc(formatDate(entry.updatedAt)) +
				"</p></button>",
		)
		.join("");
	const sources = (result.sources || [])
		.map(
			(source) =>
				'<button class="retrieval-result source-result" data-source-document="' +
				esc(source.sourceEventId) +
				'"><span class="provider-badge">' +
				esc(source.provider) +
				"</span><h3>" +
				esc(source.title) +
				"</h3></button>",
		)
		.join("");

	byId("context-preview").innerHTML =
		'<div class="retrieval-summary"><header><h2>Results for ' +
		esc(result.objective) +
		"</h2><p>Recorded knowledge relevant to your search.</p></header>" +
		(entries ||
			'<div class="empty"><strong>No recorded match</strong><span>Try another term or check the original sources.</span></div>') +
		(sources
			? '<details class="source-details"><summary>Related original sources</summary><div class="source-result-grid">' +
				sources +
				"</div></details>"
			: "") +
		"</div>";
}

function showAgentSetup(response, harness?) {
	const recipes = response.setups || [response.setup];

	response = {
		...response,
		setup:
			recipes.find(
				(recipe) =>
					recipe.harness === (harness || response.setup.harness),
			) || recipes[0],
	};
	state.setup = response;
	byId("agent-connection-status").textContent = "";

	const setup = response.setup;
	const secret = response.secret
		? '<div class="secret-panel"><div><small>One-time enrollment secret</small><code>' +
			esc(response.secret) +
			'</code></div><button class="button primary" data-copy-secret><i class="ph ph-copy" aria-hidden="true"></i>Copy secret</button><p>Copy this now. Panini stores only its digest and cannot show it again.</p></div>'
		: '<div class="secret-panel unavailable"><div><small>Enrollment secret</small><strong>Hidden after enrollment</strong></div><p>Use your saved secret in every harness. If it is lost, rotate it and update all connected harnesses.</p></div>';
	const harnessBar =
		'<nav class="setup-harness-bar" aria-label="Harness setup options">' +
		recipes
			.map(
				(recipe) =>
					'<button type="button" class="button quiet small" data-setup-harness="' +
					esc(recipe.harness) +
					'" aria-pressed="' +
					String(recipe.harness === setup.harness) +
					'">' +
					esc(harnessLabels[recipe.harness] || recipe.harnessLabel) +
					"</button>",
			)
			.join("") +
		"</nav>";
	const steps = setup.steps
		.map(
			(step, index) =>
				"<li><div><strong>" +
				esc(step.title) +
				"</strong><p>" +
				esc(step.copy) +
				"</p></div><pre><code>" +
				esc(step.code) +
				'</code><button class="copy-code" type="button" data-copy-step="' +
				index +
				'"><i class="ph ph-copy" aria-hidden="true"></i>Copy</button></pre></li>',
		)
		.join("");
	const notes = setup.notes
		.map((note) => "<li>" + esc(note) + "</li>")
		.join("");

	byId("setup-content").innerHTML =
		harnessBar +
		'<div class="setup-head"><span class="harness-label">' +
		esc(setup.harnessLabel) +
		"</span><h2>Connect " +
		esc(response.profile.name) +
		"</h2><p>Owned by " +
		esc(response.profile.owner) +
		". Use the same identity and secret across multiple harnesses.</p></div>" +
		secret +
		'<ol class="setup-steps">' +
		steps +
		'</ol><div class="verify-panel"><small>Verify the connection</small><p>' +
		esc(setup.verificationPrompt) +
		'</p><button class="button quiet small" type="button" data-copy-prompt><i class="ph ph-copy" aria-hidden="true"></i>Copy prompt</button></div><ul class="setup-notes">' +
		notes +
		"</ul>";
	if (!byId("setup-dialog").open) byId("setup-dialog").showModal();
}

function renderSummary() {
	byId("work-count").textContent = String(state.board.tasks.length);

	const intelligenceEnabled = state.health.intelligence !== "disabled";

	byId("analyze").hidden = !intelligenceEnabled;
}
