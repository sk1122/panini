// Task board, review proposals, projects, company, people and history.

function renderBoard() {
	const root = byId("board");

	root.classList.remove("loading");
	byId("task-suggestions").innerHTML = "";
	root.innerHTML = lanes
		.map(([key, label]) => {
			const tasks = state.board.tasks.filter(
				(task) => laneFor(task.status) === key,
			);
			const cards =
				tasks.map(taskCard).join("") ||
				'<div class="empty"><strong>Nothing here</strong><span>Drag a card here to change its status.</span></div>';

			return (
				'<section class="lane" data-lane="' +
				key +
				'"><div class="lane-head"><div><span class="lane-dot"></span><h3>' +
				label +
				'</h3></div><span class="count">' +
				tasks.length +
				'</span></div><div class="cards">' +
				cards +
				"</div></section>"
			);
		})
		.join("");
}

function proposalCard(proposal) {
	const labels = {
		task_create: "Create task",
		task_change: "Change task",
		context_update: "Legacy context file",
		context_file_upsert: "Upsert context file",
		context_fact_upsert: "Upsert atomic fact",
	};
	const detail = state.proposalDetails[proposal.id];
	const assessmentId =
		detail && detail.proposal && detail.proposal.assessmentId;
	const assessment = assessmentId
		? state.assessmentDetails[assessmentId]
		: null;
	const title =
		proposal.changes.title ||
		proposal.changes.contextTitle ||
		labels[proposal.kind] ||
		proposal.kind;
	const before = detail && detail.before ? detail.before : null;
	const changes = Object.entries(proposal.changes)
		.map(
			([key, value]) =>
				'<div class="change"><dt>' +
				esc(key.replaceAll(/([A-Z])/g, " $1")) +
				"</dt><dd>" +
				(before && Object.hasOwn(before, key)
					? "<del>" +
						esc(compact(before[key])) +
						'</del><i class="ph ph-arrow-right" aria-hidden="true"></i>'
					: "") +
				"<ins>" +
				esc(compact(value)) +
				"</ins></dd></div>",
		)
		.join("");
	const stale =
		detail && detail.stale
			? '<span class="health-state degraded">Stale base</span>'
			: "";
	const evidence =
		detail && detail.evidence.length
			? '<div class="agent-grants">' +
				detail.evidence
					.map(
						(item) =>
							'<button class="button quiet small" data-proposal-evidence="' +
							esc(item.id) +
							'">' +
							esc(item.provider) +
							": " +
							esc(item.eventKind) +
							"</button>",
					)
					.join("") +
				"</div>"
			: '<p class="muted-copy">No source receipt attached. This may be an authorized manual change.</p>';
	const canApprove =
		!detail ||
		detail.allowedActions.find(
			(item) => item.action === "approve" && item.allowed,
		);
	const canRebase =
		detail &&
		detail.allowedActions.find(
			(item) => item.action === "rebase" && item.allowed,
		);
	const authorityCopy =
		proposal.state === "escalated"
			? proposal.decisionNote ||
				"This proposal needs a person to resolve conflicting evidence."
			: "Review the cited source and current accepted state before deciding.";
	const authority =
		'<div class="authority-explanation"><i class="ph ph-seal-check" aria-hidden="true"></i><div><strong>Human review required</strong><p>' +
		esc(authorityCopy) +
		"</p></div></div>";
	const assessmentLabel =
		proposal.kind === "context_fact_upsert"
			? "Reported context fact"
			: proposal.kind === "context_file_upsert"
				? "Reported context document"
				: proposal.kind === "task_create"
					? "Reported request"
					: proposal.changes.status === "done"
						? "Reported completion"
						: "Reported progress";
	const assessed = assessment
		? '<div class="authority-explanation"><i class="ph ph-list-checks" aria-hidden="true"></i><div><strong>' +
			assessmentLabel +
			"</strong>" +
			"<p>Assessment: " +
			esc(assessment.disposition.replaceAll("_", " ")) +
			". Reasons: " +
			esc(assessment.reasonCodes.join(", ") || "none recorded") +
			".</p>" +
			"<p>Coverage gaps: " +
			esc(assessment.body.coverage.gaps.join(", ") || "none recorded") +
			". Checked " +
			esc(formatDate(assessment.body.coverage.checkedAt)) +
			".</p>" +
			(assessment.body.criteria.length
				? "<p>Criteria: " +
					esc(
						assessment.body.criteria
							.map(
								(item) => item.criterionId + " " + item.verdict,
							)
							.join(", "),
					) +
					".</p>"
				: "") +
			"</div></div>"
		: "";
	const taskActions =
		proposal.kind === "task_change"
			? '<button class="button quiet" data-edit="' +
				esc(proposal.id) +
				'">Edit</button>' +
				(canRebase
					? '<button class="button quiet" data-rebase="' +
						esc(proposal.id) +
						'">Rebase</button>'
					: "")
			: "";
	const actions =
		'<div class="proposal-actions"><button class="button danger" data-reject="' +
		esc(proposal.id) +
		'"><i class="ph ph-x" aria-hidden="true"></i>Reject</button><button class="button quiet" data-supersede="' +
		esc(proposal.id) +
		'">Supersede</button>' +
		taskActions +
		'<button class="button primary" data-approve="' +
		esc(proposal.id) +
		'"' +
		(canApprove ? "" : ' disabled title="Rebase before approval"') +
		'><i class="ph ph-check" aria-hidden="true"></i>Approve</button></div>';

	return (
		'<article class="proposal-card">' +
		'<div class="proposal-cap"><div><span class="proposal-kind">' +
		esc(labels[proposal.kind] || proposal.kind) +
		"</span><h2>" +
		esc(title) +
		"</h2><p>" +
		esc(who(proposal.rationale)) +
		" Requested by " +
		esc(who(proposal.requestedBy)) +
		".</p></div><div>" +
		stale +
		'<span class="count">' +
		esc(formatDate(proposal.createdAt, false)) +
		"</span></div></div>" +
		'<dl class="change-grid">' +
		changes +
		"</dl>" +
		evidence +
		assessed +
		authority +
		actions +
		"</article>"
	);
}

function projectProposalCard(proposal) {
	const changes = Object.entries(proposal.changes)
		.map(
			([key, value]) =>
				'<div class="change"><dt>' +
				esc(key) +
				"</dt><dd><ins>" +
				esc(compact(value)) +
				"</ins></dd></div>",
		)
		.join("");
	const evidence = proposal.evidenceIds
		.map(
			(id) =>
				'<button class="button quiet small" data-project-evidence="' +
				esc(id) +
				'">Source ' +
				esc(id.slice(0, 8)) +
				"</button>",
		)
		.join("");

	return (
		'<article class="proposal-card"><div class="proposal-cap"><div><span class="proposal-kind">' +
		(proposal.kind === "project_create"
			? "Create project"
			: "Change project") +
		"</span><h2>" +
		esc(proposal.changes.name || "Project change") +
		"</h2><p>" +
		esc(who(proposal.rationale)) +
		" Requested by " +
		esc(who(proposal.requestedBy)) +
		'.</p></div><span class="count">' +
		esc(formatDate(proposal.createdAt, false)) +
		"</span></div>" +
		'<dl class="change-grid">' +
		changes +
		'</dl><div class="agent-grants">' +
		evidence +
		"</div>" +
		'<div class="authority-explanation"><i class="ph ph-seal-check" aria-hidden="true"></i><div><strong>Human review required</strong><p>Check the cited source before accepting this project revision.</p></div></div>' +
		'<div class="proposal-actions"><button class="button danger" data-project-reject="' +
		esc(proposal.id) +
		'">Reject</button><button class="button primary" data-project-approve="' +
		esc(proposal.id) +
		'">Approve</button></div></article>'
	);
}

const fieldNames = {
	status: "status",
	owner: "owner",
	title: "title",
	description: "description",
	priority: "priority",
	dueDate: "due date",
	project: "project",
	projectId: "project",
	body: "text",
	value: "value",
	lifecycleState: "state",
};

function changeSummary(change) {
	if (change.kind === "task_create") return "Created task";
	if (String(change.changes.path || "").startsWith("/decisions/"))
		return "Recorded decision";
	if (change.kind !== "task_change")
		return change.fields.includes("body") || change.fields.includes("value")
			? "Updated context"
			: "Changed context";
	if (change.changes.status)
		return "Moved to " + String(change.changes.status).replace("_", " ");

	const fields = [
		...new Set(
			change.fields.map((field) => fieldNames[field]).filter(Boolean),
		),
	];

	return fields.length ? "Changed " + fields.join(", ") : "Changed task";
}

/** Who made a change, in words a person would use. */
function actorName(actor) {
	const value = String(actor || "");

	if (/observation-agent|reconcile|nightly/i.test(value))
		return "Nightly run";
	return who(value);
}

function changeRow(change) {
	const task = String(change.kind).startsWith("task");

	return (
		'<article class="change-row' +
		(change.undone ? " undone" : "") +
		'"' +
		(change.why ? ' title="' + esc(who(change.why)) + '"' : "") +
		'><i class="ph ph-' +
		(change.kind === "task_create"
			? "plus-circle"
			: task
				? "check-square"
				: "book-open-text") +
		' change-icon" aria-hidden="true"></i><p><b>' +
		esc(
			(change.summaries || [changeSummary(change)])
				.map((text, i) => (i ? text.toLowerCase() : text))
				.join(", "),
		) +
		"</b> " +
		esc(cleanTitle(change.title)) +
		(change.repeat
			? ' <span class="repeat">×' + change.repeat + "</span>"
			: "") +
		'</p><span class="change-meta">' +
		esc(actorName(change.by)) +
		" · " +
		esc(
			new Date(change.at).toLocaleTimeString([], {
				hour: "numeric",
				minute: "2-digit",
			}),
		) +
		"</span>" +
		(change.undone
			? '<em class="pill">Undone</em>'
			: '<button class="button quiet small" data-undo-change="' +
				esc(change.proposalId) +
				'">' +
				(change.repeat ? "Undo latest" : "Undo") +
				"</button>") +
		"</article>"
	);
}

const activityView = { filter: "all", limit: 50 };

function activityMarkup() {
	const keep = {
		all: () => true,
		tasks: (change) => String(change.kind).startsWith("task"),
		knowledge: (change) => !String(change.kind).startsWith("task"),
		undone: (change) => change.undone,
	}[activityView.filter];
	const changes = state.changes.filter(keep);
	// One row per thing changed each day, listing what changed and how often.
	const folded = [];
	const index = new Map();

	for (const change of changes) {
		const key =
			new Date(change.at).toDateString() +
			"|" +
			change.title +
			"|" +
			Boolean(change.undone);
		const row = index.get(key);

		if (row) {
			row.repeat = (row.repeat || 1) + 1;
			if (!row.summaries.includes(changeSummary(change)))
				row.summaries.push(changeSummary(change));
		} else {
			const first = { ...change, summaries: [changeSummary(change)] };

			index.set(key, first);
			folded.push(first);
		}
	}

	const shown = folded.slice(0, activityView.limit);
	const days = new Map();

	for (const change of shown) {
		const day = new Date(change.at).toLocaleDateString(undefined, {
			weekday: "long",
			day: "numeric",
			month: "long",
		});

		days.set(day, [...(days.get(day) || []), change]);
	}

	const filters = [
		["all", "All"],
		["tasks", "Tasks"],
		["knowledge", "Knowledge"],
		["undone", "Undone"],
	]
		.map(
			([key, label]) =>
				'<button type="button" class="seg' +
				(activityView.filter === key ? " on" : "") +
				'" data-activity-filter="' +
				key +
				'">' +
				label +
				"</button>",
		)
		.join("");

	return (
		'<div class="activity-bar"><div class="segmented">' +
		filters +
		'</div><span class="panel-count">' +
		changes.length +
		(changes.length === 1 ? " change" : " changes") +
		"</span></div>" +
		([...days]
			.map(
				([day, items]) =>
					'<section class="panel activity-day"><header><h2>' +
					esc(day) +
					' <span class="panel-count">' +
					items.length +
					"</span></h2></header>" +
					items.map(changeRow).join("") +
					"</section>",
			)
			.join("") ||
			'<div class="panel-empty">No changes here yet.</div>') +
		(folded.length > shown.length
			? '<button type="button" class="button quiet activity-more" data-activity-more>Show more</button>'
			: "")
	);
}

function renderProposals() {
	const proposals = state.board.proposals.filter(
		(proposal) => proposal.requestedBy !== "system:work-suggestion",
	);
	const projectProposals = state.projectProposals.filter(
		(proposal) =>
			["pending", "escalated"].includes(proposal.state) &&
			proposal.requestedBy !== "system:work-suggestion",
	);
	const count = proposals.length + projectProposals.length;

	byId("proposals").innerHTML = count
		? '<h2 class="changes-heading">Could not apply</h2>' +
			projectProposals.map(projectProposalCard).join("") +
			proposals.map(proposalCard).join("")
		: "";
	byId("recent-changes").innerHTML = activityMarkup();
	byId("review-count").textContent = String(count);
	byId("review-count").hidden = count === 0;
	byId("proposal-metric").textContent =
		state.changes.length +
		(state.changes.length === 1 ? " change" : " changes");

	const coverage = state.evidenceCoverage;
	const panel = byId("evidence-coverage");

	panel.hidden = !coverage;
	if (coverage) {
		const states = coverage.states;

		panel.innerHTML =
			"<h2>Evidence processing</h2><p>" +
			esc(coverage.activeObservations) +
			" active observations · " +
			esc(states.processed || 0) +
			" processed · " +
			esc(states.extracted) +
			" extracted · " +
			esc(states.no_claim) +
			" no claim · " +
			esc(states.duplicate) +
			" duplicate</p>" +
			"<p>" +
			esc(states.unseen) +
			" unseen · " +
			esc(states.partial) +
			" partial · " +
			esc(states.unresolved) +
			" unresolved · " +
			esc(states.failed) +
			" failed</p>" +
			(coverage.outputs
				? "<p>" +
					esc(coverage.outputs.savedClaims) +
					" saved claims · " +
					esc(coverage.outputs.savedAssessments) +
					" assessments · " +
					esc(coverage.outputs.pendingAssessedProposals) +
					" pending assessed proposals · " +
					esc(coverage.outputs.acceptedAssessedTaskRevisions) +
					" accepted assessed task revisions</p>"
				: "") +
			"<p>" +
			esc(coverage.retryBacklog) +
			" eligible for retry" +
			(coverage.oldestRetryAt
				? " · oldest " + esc(formatDate(coverage.oldestRetryAt))
				: "") +
			"</p>" +
			(coverage.evidenceJobs
				? "<p>Queue: " +
					esc(coverage.evidenceJobs.pending) +
					" pending · " +
					esc(coverage.evidenceJobs.running) +
					" running · " +
					esc(coverage.evidenceJobs.failed) +
					" failed" +
					(coverage.evidenceJobs.oldestPendingAt
						? " · oldest " +
							esc(
								formatDate(
									coverage.evidenceJobs.oldestPendingAt,
								),
							)
						: "") +
					"</p>"
				: "") +
			(state.evidenceBudget
				? "<p>Model budget: " +
					esc(state.evidenceBudget.state) +
					" · " +
					esc(state.evidenceBudget.spentCalls) +
					"/" +
					esc(state.evidenceBudget.maxCalls) +
					" calls · $" +
					esc(state.evidenceBudget.spentUsd) +
					" estimated" +
					(state.evidenceBudget.maxUsd === null
						? " · no USD cap"
						: " / $" + esc(state.evidenceBudget.maxUsd) + " cap") +
					"</p>"
				: "");
	}
}

function renderProjects() {
	const graph = state.workGraph;
	const projects = graph ? graph.projects : [];
	const tasks = graph ? graph.tasks : [];
	const taskProposals = state.board.proposals.filter(
		(proposal) =>
			["pending", "escalated"].includes(proposal.state) &&
			proposal.requestedBy !== "system:work-suggestion",
	);
	const projectProposals = state.projectProposals.filter(
		(proposal) =>
			["pending", "escalated"].includes(proposal.state) &&
			proposal.requestedBy !== "system:work-suggestion",
	);
	const decisions = [
		...projectProposals.map((proposal) => ({
			...proposal,
			proposalType: "project",
		})),
		...taskProposals.map((proposal) => ({
			...proposal,
			proposalType: "task",
		})),
	];

	byId("project-suggestions").innerHTML = "";
	byId("project-metric").textContent =
		projects.length + (projects.length === 1 ? " project" : " projects");
	byId("project-count").textContent = String(projects.length);
	byId("accepted-task-metric").textContent = String(tasks.length);
	byId("decision-metric").textContent = String(decisions.length);
	byId("project-decision-count").textContent = String(decisions.length);
	byId("project-decisions-section").hidden = decisions.length === 0;

	if (!projects.some((project) => project.id === state.selectedProjectId))
		state.selectedProjectId = projects[0]?.id || null;

	const selected = projects.find(
		(project) => project.id === state.selectedProjectId,
	);

	byId("projects-index").innerHTML =
		projects
			.map((project) => {
				const projectTasks = tasks.filter((task) =>
					taskBelongsToProject(task, project),
				);

				const count = (statuses: string[]) =>
					projectTasks.filter((task) =>
						statuses.includes(task.status),
					).length;

				// Plain counts that always add up to the project's tasks.
				const summary = [
					[count(["backlog", "planned"]), "to do"],
					[count(["in_progress"]), "in progress"],
					[count(["blocked", "review"]), "blocked or in review"],
					[count(["done"]), "done"],
				]
					.filter(([n]) => n)
					.map(([n, label]) => n + " " + label)
					.join(" · ");

				return (
					'<button class="project-index-item' +
					(project.id === state.selectedProjectId ? " active" : "") +
					'" data-project="' +
					esc(project.id) +
					'"><strong>' +
					esc(project.name) +
					"</strong><span>" +
					esc(project.outcome || "No outcome written yet.") +
					"</span><small>" +
					esc(summary || "No tasks yet") +
					"</small></button>"
				);
			})
			.join("") ||
		'<div class="empty"><strong>No projects yet</strong><span>Create a project to group related tasks.</span></div>';

	if (selected) {
		const projectTasks = tasks.filter((task) =>
			taskBelongsToProject(task, selected),
		);
		const taskRows = projectTasks
			.map(
				(task) =>
					'<button class="project-task" data-task="' +
					esc(task.id) +
					'"><span><strong>' +
					esc(cleanTitle(task.title)) +
					"</strong><small>" +
					esc(task.description || "No description recorded.") +
					"</small></span><em>" +
					esc(task.owner || "Unassigned") +
					'</em><b class="task-state ' +
					esc(task.status) +
					'">' +
					esc(task.status.replaceAll("_", " ")) +
					"</b></button>",
			)
			.join("");

		byId("project-focus").innerHTML =
			"<header><h2>" +
			esc(selected.name) +
			"</h2><p>" +
			esc(selected.outcome || "No accepted outcome recorded.") +
			"</p></header>" +
			'<div class="project-facts"><span>' +
			esc(selected.owner || "Owner not recorded") +
			"</span><span>" +
			projectTasks.length +
			(projectTasks.length === 1 ? " task" : " tasks") +
			"</span><span>Changed " +
			esc(formatDate(selected.updatedAt)) +
			'</span><button class="button quiet small" data-edit-project="' +
			esc(selected.id) +
			'">Edit</button></div>' +
			'<section class="project-current"><h3>Current work</h3><div class="project-tasks">' +
			(taskRows ||
				'<div class="empty"><span>No tasks yet.</span></div>') +
			"</div></section>" +
			'<button class="project-history-link" data-go-view="history">Open project history <i class="ph ph-arrow-right" aria-hidden="true"></i></button>';
	} else {
		byId("project-focus").innerHTML =
			'<div class="empty project-empty"><strong>No accepted project selected</strong><span>Create a project or approve a project proposal to begin.</span></div>';
	}

	byId("project-decisions").innerHTML =
		decisions
			.slice(0, 4)
			.map((proposal) => {
				const title =
					proposal.changes.name ||
					proposal.changes.title ||
					(proposal.proposalType === "project"
						? "Project change"
						: "Task change");

				return (
					'<button class="project-decision" data-go-view="review"><strong>' +
					esc(title) +
					"</strong><span>" +
					esc(
						who(proposal.rationale) ||
							"A proposed change is waiting for review.",
					) +
					"</span><small>Requested by " +
					esc(who(proposal.requestedBy)) +
					'</small><em>Review <i class="ph ph-arrow-right" aria-hidden="true"></i></em></button>'
				);
			})
			.join("") ||
		'<div class="empty rail-empty"><strong>No decisions waiting</strong><span>Accepted work is unchanged.</span></div>';

	byId("project-history").innerHTML =
		state.history.items
			.slice(0, 3)
			.map(
				(item, index) =>
					'<button class="project-history-item" data-history-subject="' +
					esc(item.subjectId) +
					'" data-history-type="' +
					esc(item.type) +
					'"><i class="ph ph-' +
					(index === 1 ? "square" : "circle") +
					'" aria-hidden="true"></i><span><strong>' +
					esc(item.title) +
					"</strong><small>" +
					esc(item.summary) +
					"</small><em>" +
					esc(formatDate(item.occurredAt)) +
					"</em></span></button>",
			)
			.join("") ||
		'<div class="empty rail-empty"><span>No accepted changes yet.</span></div>';
}

function renderCompany() {
	const company = state.company;
	const health = company.memoryHealth;

	byId("company-count").textContent = String(company.outcomes.length);
	byId("company-freshness").textContent =
		"Updated " + formatDate(company.generatedAt);

	const notices = [];

	if (
		company.sourceCoverage.some(
			(source) =>
				source.stale || source.scopes.some((scope) => scope.stale),
		)
	)
		notices.push(
			"Some source checkpoints are stale; generated time is not source freshness.",
		);
	if (health.coverageIncomplete)
		notices.push(
			"Some sources are incomplete. This view may miss earlier work.",
		);
	if (health.needsReview)
		notices.push(
			health.needsReview +
				" knowledge " +
				(health.needsReview === 1 ? "entry needs" : "entries need") +
				" review.",
		);
	byId("company-health").innerHTML = notices.length
		? '<div class="company-health-note warning">' +
			esc(notices.join(" ")) +
			"</div>"
		: "";
	byId("company-outcomes").innerHTML =
		company.outcomes
			.map((project) => {
				const tasks = state.board.tasks.filter((task) =>
					taskBelongsToProject(task, project),
				);

				return (
					'<button class="company-row" data-project-name="' +
					esc(project.name) +
					'"><i class="ph ph-tree-structure" aria-hidden="true"></i><span><strong>' +
					esc(project.name) +
					"</strong><small>" +
					esc(project.outcome || "No project summary recorded") +
					"</small></span><em>" +
					tasks.length +
					" tasks</em></button>"
				);
			})
			.join("") ||
		'<div class="empty"><strong>No projects yet</strong><span>Current projects will appear here.</span></div>';

	const blockers = company.blockers
		.map(
			(task) =>
				'<button class="company-row danger-row" data-task="' +
				esc(task.id) +
				'"><i class="ph ph-warning" aria-hidden="true"></i><span><strong>' +
				esc(cleanTitle(task.title)) +
				"</strong><small>" +
				esc(canonicalProjectName(task) || "No Project") +
				"</small></span><em>blocked</em></button>",
		)
		.join("");

	byId("company-blockers").innerHTML =
		blockers ||
		'<div class="empty"><strong>No blocked tasks</strong><span>Nothing is marked blocked in current work.</span></div>';

	const recent = state.history.items
		.slice(0, 5)
		.map(
			(item) =>
				'<button class="company-row" data-history-subject="' +
				esc(item.subjectId) +
				'" data-history-type="' +
				esc(item.type) +
				'"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i><span><strong>' +
				esc(item.title) +
				"</strong><small>" +
				esc(item.summary) +
				"</small></span><em>" +
				esc(formatDate(item.occurredAt, false)) +
				"</em></button>",
		)
		.join("");

	byId("company-recent").innerHTML =
		recent ||
		'<div class="empty"><strong>No recorded changes yet</strong><span>Updates to work and knowledge will appear here.</span></div>';
	byId("company-coverage").innerHTML =
		company.sourceCoverage
			.map((source) => {
				const unhealthy =
					source.status !== "healthy" ||
					source.stale ||
					source.scopes.some(
						(scope) => scope.status !== "healthy" || scope.stale,
					);
				const scopeDetails = source.scopes.length
					? source.scopes
							.map(
								(scope) =>
									scope.resourceKey +
									": " +
									(scope.stale ? "stale" : scope.status) +
									(scope.cursor?.coverage
										? " · " +
											scope.cursor.coverage.replaceAll(
												"_",
												" ",
											)
										: "") +
									(scope.cursor?.checks === "not_granted"
										? " · checks not granted"
										: "") +
									(scope.lastError
										? " · " + scope.lastError
										: ""),
							)
							.join(" / ")
					: "No durable source checkpoint yet";

				return (
					'<article class="coverage-card"><div><i class="ph ph-' +
					esc(providerIcons[source.provider] || "database") +
					'" aria-hidden="true"></i><span><strong>' +
					esc(source.displayName) +
					"</strong><small>" +
					esc(source.provider + " / " + source.transport) +
					'</small></span></div><span class="health-state ' +
					esc(unhealthy ? "degraded" : "healthy") +
					'">' +
					esc(
						source.stale
							? "sync stale"
							: unhealthy
								? "coverage incomplete"
								: "healthy",
					) +
					"</span><dl><div><dt>Scopes</dt><dd>" +
					esc(source.scopes.length) +
					"</dd></div><div><dt>Last success</dt><dd>" +
					esc(
						source.lastSuccessAt
							? formatDate(source.lastSuccessAt)
							: "Not synced",
					) +
					"</dd></div></dl>" +
					'<p class="connector-checkpoint">' +
					esc(scopeDetails) +
					"</p></article>"
				);
			})
			.join("") ||
		'<div class="empty agent-empty"><strong>No source coverage configured</strong><span>Panini cannot claim complete company history until authorized sources are connected.</span></div>';
}

function renderPeople() {
	// The placeholder administrator from before setup is not a person.
	const people = state.people.people.filter(
		(person) => person.member.subject !== "bootstrap:local-admin",
	);

	const agentsOf = (memberId) =>
		(state.agentSummary?.agents || []).filter(
			(agent) =>
				agent.status !== "disconnected" &&
				state.agents.some(
					(profile) =>
						profile.id === agent.id &&
						profile.memberId === memberId,
				),
		);

	people.sort(
		(a, b) =>
			b.currentWork.length +
				agentsOf(b.member.id).length -
				(a.currentWork.length + agentsOf(a.member.id).length) ||
			a.member.displayName.localeCompare(b.member.displayName),
	);
	byId("people-count").textContent = String(people.length);
	byId("people-metric").textContent =
		people.length + (people.length === 1 ? " person" : " people");
	byId("people").innerHTML =
		people
			.map((person) => {
				const identityRows = person.identities
					.map(
						(identity) =>
							"<span>" +
							esc(identity.provider) +
							": " +
							esc(identity.displayName || "Unnamed identity") +
							"</span>",
					)
					.join("");
				const workRows = person.currentWork
					.map(
						(task) =>
							'<button data-task="' +
							esc(task.id) +
							'"><span>' +
							esc(cleanTitle(task.title)) +
							"</span><small>" +
							esc(task.status.replaceAll("_", " ")) +
							"</small></button>",
					)
					.join("");
				const historical = person.historicalTaskIds
					.map((id) =>
						state.board.tasks.find((task) => task.id === id),
					)
					.filter(
						(task) =>
							task &&
							!person.currentWork.some(
								(current) => current.id === task.id,
							),
					);
				const historicalRows = historical
					.map(
						(task) =>
							'<button data-task="' +
							esc(task.id) +
							'"><span>' +
							esc(cleanTitle(task.title)) +
							"</span><small>" +
							esc(task.status.replaceAll("_", " ")) +
							"</small></button>",
					)
					.join("");

				const agents = agentsOf(person.member.id);
				const live = agents.filter(
					(agent) => agent.status === "working",
				);
				const counts = [
					person.currentWork.length
						? person.currentWork.length + " open"
						: "",
					agents.length
						? agents.length +
							(agents.length === 1 ? " agent" : " agents")
						: "",
				]
					.filter(Boolean)
					.join(" · ");
				const agentRows = agents
					.map(
						(agent) =>
							'<button data-go-view="agents"><span>' +
							esc(agent.name) +
							"</span><small>" +
							esc(
								agent.status === "working"
									? "on " + agent.currentTask.title
									: agent.status === "never_connected"
										? "not connected yet"
										: "last active " +
											ago(agent.lastActiveAt),
							) +
							"</small></button>",
					)
					.join("");

				return (
					'<article class="person-row"><button type="button" class="person-open" data-person-expand aria-expanded="false"><span class="person-avatar">' +
					esc(person.member.displayName.slice(0, 1).toUpperCase()) +
					'</span><span class="agent-name"><strong>' +
					esc(person.member.displayName) +
					"</strong><small>" +
					esc(person.member.role) +
					"</small></span>" +
					(live.length
						? '<span class="agent-state live"><span class="dot"></span>' +
							esc(
								live[0].name +
									" on " +
									live[0].currentTask.title,
							) +
							"</span>"
						: person.currentWork.length
							? '<span class="agent-state">' +
								esc(person.currentWork[0].title) +
								"</span>"
							: '<span class="agent-state muted">Nothing open</span>') +
					'<span class="agent-week-short">' +
					esc(counts) +
					'</span><i class="ph ph-caret-down person-caret" aria-hidden="true"></i></button>' +
					'<div class="agent-detail person-detail" hidden>' +
					(workRows
						? '<h3>Open work</h3><div class="person-work">' +
							workRows +
							"</div>"
						: "") +
					(historicalRows
						? '<h3>Earlier work</h3><div class="person-work">' +
							historicalRows +
							"</div>"
						: "") +
					(agentRows
						? '<h3>Agents</h3><div class="person-work">' +
							agentRows +
							"</div>"
						: "") +
					(identityRows
						? '<h3>Accounts</h3><div class="person-accounts">' +
							identityRows +
							"</div>"
						: "") +
					"</div></article>"
				);
			})
			.join("") ||
		'<div class="empty agent-empty"><strong>No people yet</strong><span>Invite your team from Settings.</span></div>';
}

byId("people").addEventListener("click", (event) => {
	const target = event.target as AppElement;
	const open = target.closest<AppElement>("[data-person-expand]");
	const task = target.closest<AppElement>("[data-task]");

	if (task) {
		void openTaskDetail(task.dataset.task).catch(showError);
		return;
	}
	if (!open) return;

	const detail = open
		.closest("article")
		.querySelector<AppElement>(".person-detail");

	detail.hidden = !detail.hidden;
	open.setAttribute("aria-expanded", String(!detail.hidden));
});

function historyMarkup(items) {
	return items
		.map((item) => {
			const kind = item.type === "context_revision" ? "Context" : "Task";
			// Bookkeeping fields (review state, effective dates) say nothing to a reader.
			const changes = (item.changes || [])
				.filter(
					(change) =>
						![
							"Document",
							"Review state",
							"Effective from",
							"Effective until",
						].includes(change.label),
				)
				.map(
					(change) =>
						"<li><b>" +
						esc(change.label) +
						"</b> " +
						esc(changeValue(change.before, change.label)) +
						" → " +
						esc(changeValue(change.after, change.label)) +
						"</li>",
				)
				.join("");
			const documentChanged = (item.changes || []).some(
				(change) => change.label === "Document",
			);
			const open =
				item.type === "context_revision"
					? '<button class="button quiet small" data-history-entry="' +
						esc(item.subjectId) +
						'">Open knowledge</button>'
					: '<button class="button quiet small" data-history-task="' +
						esc(item.subjectId) +
						'">Open task</button>';

			return (
				'<article class="history-item"><time>' +
				esc(formatDate(item.occurredAt)) +
				'</time><i class="ph ph-' +
				(kind === "Context" ? "books" : "check-square-offset") +
				'" aria-hidden="true"></i><div><span class="history-type">' +
				kind +
				"</span><h2>" +
				esc(item.title) +
				"</h2><p>" +
				esc(item.summary) +
				(documentChanged ? " · text changed" : "") +
				"</p>" +
				(item.reason
					? '<p class="recorded-note">' +
						esc(who(item.reason)) +
						"</p>"
					: "") +
				(changes
					? '<details class="change-details"><summary>What changed</summary><ul class="change-summary">' +
						changes +
						"</ul></details>"
					: "") +
				"<small>Recorded " +
				esc(formatDate(item.occurredAt)) +
				" · " +
				esc(recordedBy(item.actor)) +
				"</small>" +
				open +
				"</div></article>"
			);
		})
		.join("");
}

function renderHistory() {
	const filter = byId("history-filter").value;
	const items = state.history.items.filter(
		(item) => !filter || item.type === filter,
	);

	byId("history-count").textContent = String(state.history.items.length);
	byId("history-metric").textContent =
		items.length + (items.length === 1 ? " change" : " changes");
	byId("history").innerHTML =
		historyMarkup(items) ||
		'<div class="empty agent-empty"><strong>No changes yet</strong><span>Updates to tasks and context will appear here.</span></div>';
}

function renderTimeline() {
	const filter = byId("timeline-filter").value;
	const matching = state.history.items.filter(
		(item) => !filter || item.type === filter,
	);
	const visible = matching.slice(0, 20);

	byId("timeline-metric").textContent =
		matching.length > visible.length
			? visible.length + " of " + matching.length + " changes"
			: matching.length +
				(matching.length === 1 ? " change" : " changes");
	byId("timeline").innerHTML =
		historyMarkup(visible) ||
		'<div class="empty agent-empty"><strong>No changes yet</strong><span>Accepted task and context revisions will appear here.</span></div>';
}

function dependencyName(reference) {
	const task = state.board.tasks.find(
		(item) => item.id === reference || item.externalRef === reference,
	);

	return task ? task.title : "Task not found";
}

function changeValue(value, label?) {
	if (value === null || value === undefined || value === "")
		return "None recorded";
	if (
		label === "Effective from" ||
		label === "Effective until" ||
		label === "Due date"
	)
		return formatDate(value);
	if (label === "Dependencies" && Array.isArray(value))
		return value.length
			? compact(value.map(dependencyName).join(", "), 140)
			: "None";
	if (Array.isArray(value)) return compact(value.join(", "), 140);
	return compact(
		typeof value === "object"
			? JSON.stringify(value)
			: String(value).replaceAll("_", " "),
		140,
	);
}

function recordedBy(actor) {
	if (actor.startsWith("member:")) {
		const member = state.people.people.find(
			(person) => person.member.id === actor.slice(7),
		);

		return member ? member.member.displayName : "Workspace member";
	}
	if (actor.startsWith("agent:")) return who(actor);
	if (actor === "rule:task_claim") return "Panini, when an agent claimed it";
	if (actor === "observation-agent") return "Panini, from chat";
	if (actor.startsWith("adjudicator:")) return "Recorded by Panini";
	if (actor.startsWith("connector:")) return "Imported from a source";
	return actor;
}
