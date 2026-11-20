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

	if (byId("view-integrations").classList.contains("active"))
		void loadConnectSources().catch(() => undefined);
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

function renderTaskDetail(detail) {
	const task = detail.task;
	const ledger = detail.ledger;
	const model = detail.workModel;
	const labels = {
		status: "Status",
		owner: "Owner",
		project: "Project",
		title: "Title",
		description: "Description",
		dueDate: "Due date",
		priority: "Priority",
	};
	const events = [];

	// One timeline: what changed, what agents reported, handoffs and linked activity.
	for (const revision of detail.revisions) {
		const changed = revision.previous
			? Object.entries(labels)
					.filter(
						([key]) =>
							JSON.stringify(revision.current[key]) !==
							JSON.stringify(revision.previous[key]),
					)
					.map(([key, label]) =>
						key === "description"
							? "Description updated"
							: label +
								": " +
								changeValue(revision.previous[key]) +
								" → " +
								changeValue(revision.current[key]),
					)
			: ["Created"];

		events.push({
			at: revision.appliedAt,
			icon: revision.previous ? "pencil-simple" : "plus-circle",
			text: esc(changed.join(" · ") || "Details changed"),
			by: recordedBy(revision.appliedBy),
		});
	}
	for (const item of model?.evidence ?? []) {
		const claim = item.claim.body;
		const sourceId = claim.spans[0]?.eventId;

		events.push({
			at: claim.assertedAt,
			icon: item.entity.kind === "execution" ? "play-circle" : "package",
			text:
				"<strong>" +
				esc(item.entity.name) +
				"</strong> " +
				esc(claim.statement),
			by: "Reported",
			action: sourceId
				? '<button class="button quiet small" data-work-source="' +
					esc(sourceId) +
					'">Source</button>'
				: "",
		});
	}
	for (const handoff of ledger?.handoffs ?? [])
		events.push({
			at: handoff.createdAt,
			icon: "hand-arrow-right",
			text:
				"Handoff" +
				(handoff.nextStep ? ": " + esc(handoff.nextStep) : ""),
			by: handoff.author.split(":").slice(2).join(":") || handoff.author,
		});
	for (const item of detail.activityCandidates || [])
		events.push({
			at: item.occurredAt,
			icon: "link-simple",
			text:
				esc(item.eventKind.replaceAll("_", " ")) +
				" · " +
				(item.sourceUrl && item.sourceUrl.startsWith("https://")
					? '<a href="' +
						esc(item.sourceUrl) +
						'" target="_blank" rel="noreferrer">' +
						esc(item.sourceRef) +
						"</a>"
					: esc(item.sourceRef)),
			by: "Linked activity",
		});
	for (const proposal of detail.proposals.filter(
		(item) => item.state === "pending",
	))
		events.push({
			at: proposal.createdAt,
			icon: "hourglass-medium",
			text: "Waiting: " + esc(Object.keys(proposal.changes).join(", ")),
			by: who(proposal.rationale),
		});
	events.sort((a, b) => String(b.at).localeCompare(String(a.at)));

	const timeline = events
		.map(
			(event) =>
				'<li><span class="tl-icon"><i class="ph ph-' +
				event.icon +
				'" aria-hidden="true"></i></span><div><p>' +
				event.text +
				"</p><small>" +
				esc(event.by) +
				" · " +
				esc(formatDate(event.at)) +
				"</small></div>" +
				(event.action || "") +
				"</li>",
		)
		.join("");

	const claims = (ledger?.claims ?? [])
		.map(
			(claim) =>
				'<span class="live-chip"><i class="ph ph-robot" aria-hidden="true"></i>' +
				esc(claim.agentName || "Agent") +
				"<small>since " +
				esc(formatDate(claim.claimedAt)) +
				"</small></span>",
		)
		.join("");
	const handoff = ledger?.handoffs?.[0];
	const scope = model?.scope;
	const current = model?.assessments
		.slice()
		.reverse()
		.find(
			(item) =>
				item.appliedVersion === model.task.version &&
				item.scopeId === scope?.id,
		);
	const steps = scope
		? scope.requiredSteps
				.map((step) => {
					const performed = current?.assessment.requirements.find(
						(item) => item.id === step.id,
					)?.performed;

					return (
						'<li class="' +
						(performed === "yes" ? "done" : "") +
						'"><i class="ph' +
						(performed === "yes"
							? "-fill ph-check-circle"
							: " ph-circle") +
						'" aria-hidden="true"></i>' +
						esc(step.description) +
						"</li>"
					);
				})
				.join("")
		: "";
	const canUndo =
		canReview() &&
		detail.allowedActions.find(
			(action) => action.action === "undo" && action.allowed,
		);
	const meta = [
		["user", task.owner || "No owner"],
		["folder-simple", task.project || "No project"],
		["flag", task.priority],
		task.dueDate
			? ["calendar-blank", formatDate(task.dueDate, false)]
			: null,
		task.dependencyRefs.length
			? ["git-branch", task.dependencyRefs.map(dependencyName).join(", ")]
			: null,
	]
		.filter(Boolean)
		.map(
			([icon, value]) =>
				'<span><i class="ph ph-' +
				icon +
				'" aria-hidden="true"></i>' +
				esc(value) +
				"</span>",
		)
		.join("");

	byId("task-detail-content").innerHTML =
		'<header class="td-head"><span class="pill ' +
		esc(task.status) +
		'">' +
		esc(statusLabel(task.status)) +
		"</span><h2>" +
		esc(cleanTitle(task.title)) +
		'</h2><div class="td-meta">' +
		meta +
		(task.sourceUrl
			? '<a href="' +
				esc(task.sourceUrl) +
				'" target="_blank" rel="noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Source</a>'
			: "") +
		"</div></header>" +
		(claims
			? '<div class="td-live">' +
				claims +
				(canReview()
					? '<button class="button quiet small" data-clear-claims="' +
						esc(task.id) +
						'">Clear</button>'
					: "") +
				"</div>"
			: "") +
		(task.description
			? '<p class="td-description">' + esc(task.description) + "</p>"
			: "") +
		(handoff
			? '<section class="td-block"><h3>Latest handoff</h3><dl class="td-handoff">' +
				[
					["Done", handoff.done],
					["Not done", handoff.notDone],
					["Next", handoff.nextStep],
				]
					.filter(([, value]) => value)
					.map(
						([label, value]) =>
							"<div><dt>" +
							label +
							"</dt><dd>" +
							esc(value) +
							"</dd></div>",
					)
					.join("") +
				"</dl></section>"
			: "") +
		(steps
			? '<section class="td-block"><h3>Steps</h3><ul class="td-steps">' +
				steps +
				"</ul></section>"
			: "") +
		'<section class="td-block"><header><h3>Timeline</h3>' +
		(canUndo
			? '<button class="button quiet small" data-task-undo="' +
				esc(task.id) +
				'">Undo latest change</button>'
			: "") +
		'</header><ol class="td-timeline">' +
		(timeline || '<li class="tl-empty">Nothing yet.</li>') +
		"</ol></section>";
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

// Connect buttons for Slack, GitHub and Notion. Each install creates its own
// apps; credentials are stored encrypted and never sent back to the page.
/** Reads the repositories chosen on GitHub and starts syncing them. */
async function syncGithubRepositories() {
	const status = byId("github-repos-status");

	if (status) status.textContent = "Reading your repositories from GitHub…";
	try {
		const result = await api("/api/integrations/github/repositories", {
			method: "POST",
			body: "{}",
		});
		const names = result.connected.flatMap((item) => item.repositories);

		if (status)
			status.textContent = names.length
				? "Syncing " + names.join(", ")
				: "No repositories yet. Click Choose on GitHub, pick some, then come back.";
		if (names.length)
			showToast(
				"GitHub connected: " +
					names.length +
					(names.length === 1 ? " repository" : " repositories"),
			);
		await load();
	} catch (error) {
		if (status) status.textContent = "";
		showError(error);
	}
}

async function loadConnectSources() {
	if (!isAdmin()) return;

	const info = await api("/api/integrations/connect");
	const notice = new URLSearchParams(location.search);

	// GitHub returns here after the app is installed; go straight to picking repositories.
	const returned =
		notice.has("installation_id") && info.github.source === "app";
	const githubRepositories = (state.workspace?.installations || [])
		.filter(
			(item) => item.provider === "github" && item.status !== "revoked",
		)
		.flatMap((item) => item.config?.repositories || []);

	if (returned) window.history.replaceState(null, "", location.pathname);

	const head = (icon, title) =>
		'<h2><i class="ph ph-' +
		icon +
		'" aria-hidden="true"></i>' +
		esc(title) +
		"</h2>";

	const fromServer =
		"<p>Set by the server's environment. Change it there.</p>";

	const disconnect = (provider) =>
		'<button class="button quiet small" type="button" data-source-off="' +
		provider +
		'">Disconnect</button>';

	const github = info.github.source
		? head("github-logo", "GitHub") +
			'<p class="source-on">App ready: ' +
			esc(info.github.appSlug || "GitHub app") +
			"</p>" +
			(info.github.source === "environment"
				? fromServer
				: '<p id="github-repos-status">' +
					esc(
						githubRepositories.length
							? "Reading " + githubRepositories.join(", ")
							: "Pick repositories on GitHub; Panini reads the ones you choose there.",
					) +
					"</p>" +
					'<div class="source-actions"><a class="button quiet small" href="' +
					esc(info.github.installUrl) +
					'">Choose on GitHub</a><button class="button primary small" type="button" data-source-repos>Sync repositories</button>' +
					disconnect("github") +
					"</div>")
		: head("github-logo", "GitHub") +
			"<p>One click creates a private Panini app in your GitHub account or organization. GitHub sends its keys straight back to this Panini.</p>" +
			'<form id="github-source-form"><input name="organization" placeholder="GitHub organization (optional)" aria-label="GitHub organization, optional" autocomplete="off"><button class="button primary" type="submit">Create GitHub app</button></form>';
	const slack = info.slack.source
		? head("slack-logo", "Slack") +
			'<p class="source-on">Connected' +
			(info.slack.team ? " to " + esc(info.slack.team) : "") +
			"</p>" +
			(info.slack.source === "environment"
				? fromServer
				: "<p>Reading " +
					info.slack.channels.length +
					' channel(s). Invite the Panini bot to each one.</p><div class="source-actions">' +
					disconnect("slack") +
					"</div>")
		: head("slack-logo", "Slack") +
			'<p>1. Create the app (settings are filled in). 2. Click "Install to Workspace". 3. Under Basic Information, create an app-level token with <code>connections:write</code>. 4. Paste both tokens and the channel IDs here.</p>' +
			'<div class="source-actions"><a class="button primary small" target="_blank" rel="noopener" href="' +
			esc(info.slack.createAppUrl) +
			'">Create Slack app</a></div>' +
			'<form id="slack-source-form"><input name="botToken" type="password" placeholder="Bot token (xoxb-…)" autocomplete="off" required><input name="appToken" type="password" placeholder="App-level token (xapp-…)" autocomplete="off" required><input name="channels" placeholder="Channel IDs, comma separated (C0123…)" autocomplete="off" required><button class="button quiet" type="submit">Check and connect</button></form>';
	const notion = info.notion.source
		? head("notion-logo", "Notion") +
			'<p class="source-on">Connected' +
			(info.notion.workspace ? " to " + esc(info.notion.workspace) : "") +
			"</p>" +
			(info.notion.source === "environment"
				? fromServer
				: '<p>Panini reads the pages you share with the integration.</p><div class="source-actions">' +
					disconnect("notion") +
					"</div>")
		: head("notion-logo", "Notion") +
			"<p>1. Create an internal integration. 2. Share the pages Panini should read with it (••• → Connections). 3. Paste its secret here.</p>" +
			'<div class="source-actions"><a class="button primary small" target="_blank" rel="noopener" href="https://www.notion.so/profile/integrations">Create Notion integration</a></div>' +
			'<form id="notion-source-form"><input name="token" type="password" placeholder="Internal integration secret" autocomplete="off" required><button class="button quiet" type="submit">Check and connect</button></form>';

	byId("connect-sources").innerHTML =
		(notice.get("connected") === "github"
			? '<p class="source-on source-notice">GitHub app created. Now install it on your repositories.</p>'
			: notice.get("error") === "github-expired"
				? '<p class="source-notice">That GitHub link expired. Try again.</p>'
				: "") +
		[
			'<section class="source-card">' + github + "</section>",
			'<section class="source-card">' + slack + "</section>",
			'<section class="source-card">' + notion + "</section>",
		].join("");
	// Back from GitHub's install page: read the repositories picked there.
	if (returned) void syncGithubRepositories();
}

byId("connect-sources").addEventListener("submit", async (event) => {
	event.preventDefault();

	const form = event.target as HTMLFormElement;
	const values = formValues(form);
	const button = form.querySelector<AppElement>("button[type=submit]");

	button.disabled = true;
	try {
		if (form.id === "github-source-form") {
			const start = await api("/api/integrations/github/manifest", {
				method: "POST",
				body: JSON.stringify({
					organization: values.organization || "",
				}),
			});
			// GitHub's manifest flow is a form POST to github.com.
			const post = document.createElement("form");
			const field = document.createElement("input");

			post.method = "post";
			post.action = start.action;
			field.type = "hidden";
			field.name = "manifest";
			field.value = JSON.stringify(start.manifest);
			post.append(field);
			document.body.append(post);
			post.submit();
			return;
		}
		if (form.id === "slack-source-form")
			await api("/api/integrations/slack", {
				method: "PUT",
				body: JSON.stringify({
					botToken: values.botToken,
					appToken: values.appToken,
					channels: String(values.channels)
						.split(/[\s,]+/)
						.map((item) => item.trim().toUpperCase())
						.filter(Boolean),
				}),
			});
		if (form.id === "notion-source-form")
			await api("/api/integrations/notion", {
				method: "PUT",
				body: JSON.stringify({ token: values.token }),
			});
		await loadConnectSources();
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
	}
});
byId("connect-sources").addEventListener("click", async (event) => {
	const target = event.target as AppElement;
	const off = target.closest<AppElement>("[data-source-off]");

	if (target.closest("[data-source-repos]")) void syncGithubRepositories();
	if (!off) return;
	try {
		await api("/api/integrations/" + off.dataset.sourceOff, {
			method: "DELETE",
		});
		await loadConnectSources();
	} catch (error) {
		showError(error);
	}
});
