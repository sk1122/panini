// Home, connect approval, reconcile status and live agent sessions.

function laneFor(status) {
	if (status === "done" || status === "cancelled") return "closed";
	if (status === "blocked" || status === "review") return "checkpoint";
	if (status === "in_progress") return "active";
	return "queued";
}

function canonicalProjectName(task) {
	const projects = state.workGraph ? state.workGraph.projects : [];
	const linked = task.projectId
		? projects.find((project) => project.id === task.projectId)
		: null;

	return linked ? linked.name : task.project;
}

function taskBelongsToProject(task, project) {
	if (task.projectId) return task.projectId === project.id;

	const label = (task.project || "").toLowerCase();

	return [project.name, ...(project.aliases || [])].some(
		(name) => name.toLowerCase() === label,
	);
}

function taskCard(task) {
	const pending = state.board.proposals.filter(
		(proposal) => proposal.taskId === task.id,
	);
	const overlay = pending.length
		? '<div class="pending-overlay"><i class="ph ph-clock-countdown" aria-hidden="true"></i><span>Change under review. Current task remains unchanged.</span></div>'
		: "";
	const source = task.sourceUrl
		? '<a class="source-link" href="' +
			esc(task.sourceUrl) +
			'" target="_blank" rel="noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Source</a>'
		: "<span></span>";
	// Who is working on it right now matters more than anything else on a card.
	const holders = (state.home?.workingNow || []).filter(
		(item) => item.taskId === task.id,
	);
	const claim = holders.length
		? '<div class="task-claim"><span class="session-dot ' +
			esc(holders[0].sessionState) +
			'"></span>' +
			esc(
				holders.map((item) => item.agentName || "An agent").join(", "),
			) +
			(holders.length === 1 ? " is on it" : " are on it") +
			"</div>"
		: "";
	// The column already says "In progress" or "Done"; only show other states.
	const statusChip = ["in_progress", "done"].includes(task.status)
		? ""
		: '<span class="task-status">' +
			esc(task.status.replaceAll("_", " ")) +
			"</span>";
	const metadata = [
		canonicalProjectName(task),
		task.owner ? "Owner: " + task.owner : null,
		task.dueDate ? "Due " + formatDate(task.dueDate, false) : null,
	]
		.filter(Boolean)
		.map((value) => "<span>" + esc(value) + "</span>")
		.join("");

	return (
		'<article class="task-card" data-task="' +
		esc(task.id) +
		'" draggable="true" aria-grabbed="false" tabindex="0">' +
		'<div class="task-cap">' +
		statusChip +
		(task.standing === "observed"
			? '<span class="standing-chip observed" title="Seen in a source, not yet confirmed">observed</span>'
			: "") +
		'<span class="priority ' +
		esc(task.priority) +
		'" title="' +
		esc(task.priority) +
		' priority"></span></div>' +
		"<h4>" +
		esc(task.title) +
		"</h4>" +
		claim +
		overlay +
		'<div class="task-meta">' +
		(metadata || "<span>No owner or project</span>") +
		"</div>" +
		'<div class="task-footer">' +
		source +
		'<button class="icon-action" data-change="' +
		esc(task.id) +
		'" aria-label="Suggest a change"><i class="ph ph-pencil-simple" aria-hidden="true"></i></button></div>' +
		"</article>"
	);
}

const ago = (value) => {
	if (!value) return "never";

	const minutes = Math.round(
		(Date.now() - new Date(value).valueOf()) / 60000,
	);

	if (minutes < 1) return "just now";
	if (minutes < 60) return minutes + " min ago";

	const hours = Math.round(minutes / 60);

	return hours < 48 ? hours + " h ago" : formatDate(value, false);
};

function renderHome() {
	const home = state.home;

	if (!home) {
		byId("home-needs").innerHTML =
			'<div class="empty"><strong>Home is unavailable</strong><span>Reload to try again.</span></div>';
		return;
	}

	const needs = home.needs;
	const total = needs.observedCount + needs.proposalCount + needs.noteCount;

	byId("home-count").hidden = total === 0;
	byId("home-count").textContent = String(total);
	byId("home-freshness").textContent =
		total === 0 ? "Nothing waiting" : total + " waiting";
	byId("home-accept-all").hidden = needs.observedCount === 0;

	const observed = needs.observed
		.map(
			(task) =>
				'<div class="activity-row"><strong><span class="standing-chip observed">observed</span> ' +
				esc(task.title) +
				"</strong><span>" +
				esc(
					[task.project, task.status.replaceAll("_", " ")]
						.filter(Boolean)
						.join(" · "),
				) +
				"</span>" +
				'<div class="row-actions"><button class="button quiet small" data-confirm-task="' +
				esc(task.id) +
				'">Accept</button><button class="button quiet small" data-dismiss-task="' +
				esc(task.id) +
				'">Dismiss</button></div></div>',
		)
		.join("");
	const proposals = needs.proposalCount
		? '<div class="activity-row"><strong>' +
			needs.proposalCount +
			(needs.proposalCount === 1 ? " proposal" : " proposals") +
			" to decide</strong><span>" +
			esc(compact(who(needs.proposals[0]?.rationale || ""), 90)) +
			'</span><button class="button quiet small" data-go-view="review">Open review</button></div>'
		: "";
	const notes = needs.notes
		.map(
			(note) =>
				// Show the whole note: you cannot keep or dismiss what you cannot read.
				'<div class="note-row"><p><span class="standing-chip note">note</span> ' +
				esc(note.text) +
				"</p><span>" +
				esc(who(note.author)) +
				" · " +
				esc(ago(note.createdAt)) +
				"</span>" +
				'<div class="row-actions"><button class="button quiet small" data-note-state="promoted" data-note="' +
				esc(note.id) +
				'">Keep</button><button class="button quiet small" data-note-state="dismissed" data-note="' +
				esc(note.id) +
				'">Dismiss</button></div></div>',
		)
		.join("");

	byId("home-needs").innerHTML =
		proposals + observed + notes ||
		'<div class="empty"><strong>Nothing needs you</strong><span>Work spotted in chat, changes to decide and team notes show up here.</span></div>';
	byId("home-working").innerHTML =
		home.workingNow
			.map(
				(item) =>
					'<div class="activity-row"><strong><span class="session-dot ' +
					esc(item.sessionState) +
					'"></span>' +
					esc(item.agentName || "Agent") +
					"</strong><span>" +
					esc(item.taskTitle) +
					(item.inferred ? " · inferred from branch" : "") +
					"</span><time>" +
					esc(item.sessionState) +
					" · " +
					esc(ago(item.lastSeenAt)) +
					"</time></div>",
			)
			.join("") ||
		'<div class="empty"><strong>No agent holds a task</strong><span>Agents appear here when they claim work.</span></div>';
	byId("home-changed").innerHTML =
		home.changed
			.map(
				(item) =>
					'<div class="activity-row"><strong>' +
					esc(item.title) +
					"</strong><span>" +
					esc(item.summary) +
					" · " +
					esc(recordedBy(String(item.actor || ""))) +
					"</span><time>" +
					esc(formatDate(item.occurredAt)) +
					"</time></div>",
			)
			.join("") ||
		'<div class="empty"><strong>No recent changes</strong><span>Accepted updates appear here.</span></div>';
	byId("home-sources").innerHTML = home.sources.length
		? "Sources: " +
			home.sources
				.map(
					(source) =>
						'<span class="health-state ' +
						(source.status === "active" ? "" : "degraded") +
						'">' +
						esc(source.displayName || source.provider) +
						" " +
						esc(source.status) +
						"</span>",
				)
				.join(" ")
		: "No sources connected yet. Agents can still report work and claim tasks.";
}

async function loadConnect() {
	const card = byId("connect-card");
	const id = new URLSearchParams(window.location.search).get("request");

	if (!id) {
		card.innerHTML =
			'<div class="empty"><strong>No connect request</strong><span>Run <code>npx panini-work connect</code> in your repository.</span></div>';
		return;
	}

	let request;

	try {
		request = await api("/api/connect/requests/" + encodeURIComponent(id));
	} catch {
		card.innerHTML =
			'<div class="empty"><strong>This request expired</strong><span>Run <code>npx panini-work connect</code> again.</span></div>';
		return;
	}
	if (request.state !== "pending") {
		card.innerHTML =
			'<div class="empty"><strong>Request ' +
			esc(request.state) +
			"</strong><span>You can close this tab.</span></div>";
		return;
	}

	const graph =
		state.workGraph || (await api("/api/work-graph").catch(() => null));
	const projects = (graph?.projects || [])
		.map((project) => project.name)
		.filter(Boolean);

	card.innerHTML =
		'<form id="connect-form" class="connect-form">' +
		'<p>Check that this code matches your terminal: <strong class="connect-code">' +
		esc(request.code) +
		"</strong></p>" +
		'<dl class="connect-facts"><div><dt>Agent</dt><dd>' +
		esc(request.harness.replaceAll("_", " ")) +
		"</dd></div><div><dt>Machine</dt><dd>" +
		esc(request.hostname || "Unknown") +
		"</dd></div><div><dt>Repository</dt><dd>" +
		esc(request.repository || "None detected") +
		"</dd></div></dl>" +
		'<label>Name<input name="name" maxlength="120" value="' +
		esc(
			request.harness.replaceAll("_", " ") +
				(request.repository ? " for " + request.repository : ""),
		) +
		'"></label>' +
		(request.repository && projects.length
			? '<label>Project for this repository<select name="project"><option value="">All projects</option>' +
				projects
					.map((name) => "<option>" + esc(name) + "</option>")
					.join("") +
				"</select></label>"
			: "") +
		'<p class="connect-grants">It can read work and context, claim tasks, report work, propose changes and keep private notes. It cannot read raw sources or accept changes by itself.</p>' +
		'<div class="row-actions"><button class="button primary" type="submit">Approve</button><button class="button quiet" type="button" id="connect-deny">Deny</button></div></form>';

	const decide = async (decision) => {
		const form = byId("connect-form");
		const data = formValues(form);
		const result = await api(
			"/api/connect/requests/" + encodeURIComponent(id) + "/decision",
			{
				method: "POST",
				body: JSON.stringify({
					decision,
					...(data.name ? { name: data.name } : {}),
					...(data.project ? { project: data.project } : {}),
				}),
			},
		);

		// OAuth clients get the code (or the denial) on their registered redirect URI.
		if (result.redirectTo) {
			window.location.href = result.redirectTo;
			return;
		}
		card.innerHTML =
			'<div class="empty"><strong>' +
			(decision === "approve"
				? "Approved. Return to your terminal."
				: "Denied.") +
			"</strong><span>You can close this tab.</span></div>";
	};

	byId("connect-form").addEventListener("submit", (event) => {
		event.preventDefault();
		void decide("approve").catch(showError);
	});
	byId("connect-deny").addEventListener(
		"click",
		() => void decide("deny").catch(showError),
	);
}

function renderReconcile() {
	const info = state.reconcile;
	const root = byId("home-reconcile");

	if (!info) {
		root.innerHTML = "";
		return;
	}
	if (!info.enabled) {
		root.innerHTML =
			"Model processing is off, so Slack and notes are not read yet. Agent claims, reports and handoffs work without it.";
		return;
	}

	const last = info.runs[0];
	const summary = last
		? "Last reconcile " +
			esc(last.state) +
			" " +
			esc(ago(last.finishedAt || last.startedAt)) +
			": " +
			last.processed +
			" read, " +
			last.duplicates +
			" already done, " +
			last.skipped +
			" skipped" +
			(last.failed ? ", " + last.failed + " failed" : "") +
			(last.error ? " (" + esc(compact(last.error, 80)) + ")" : "")
		: "No reconcile run yet.";

	root.innerHTML =
		summary +
		" · runs every " +
		esc(info.intervalHours) +
		" h" +
		(isAdmin()
			? ' <button class="button quiet small" id="reconcile-now">Run now</button>'
			: "");
	byId("reconcile-now")?.addEventListener("click", async () => {
		try {
			await api("/api/reconcile/run", { method: "POST", body: "{}" });
			window.alert(
				"Reconcile run queued. The worker picks it up shortly.",
			);
		} catch (error) {
			showError(error);
		}
	});
}

const money = (value) =>
	value === null || value === undefined ? "" : "$" + Number(value).toFixed(2);

function agentStatus(agent) {
	if (agent.status === "working")
		return (
			'<p class="agent-now working"><span class="session-dot active"></span>Working on <strong>' +
			esc(agent.currentTask.title) +
			"</strong></p>"
		);
	if (agent.status === "active")
		return '<p class="agent-now working"><span class="session-dot active"></span>Active now</p>';
	if (agent.status === "never_connected")
		return '<p class="agent-now"><span class="session-dot"></span>Not connected yet</p>';
	return (
		'<p class="agent-now"><span class="session-dot"></span>Idle · last active ' +
		esc(ago(agent.lastActiveAt)) +
		"</p>"
	);
}

function storyList(story) {
	return (
		'<ol class="agent-story">' +
		story
			.map(
				(line) =>
					'<li class="' +
					esc(line.kind) +
					'"><time>' +
					esc(
						new Date(line.at).toLocaleTimeString([], {
							hour: "numeric",
							minute: "2-digit",
						}),
					) +
					"</time><span>" +
					esc(line.text) +
					"</span></li>",
			)
			.join("") +
		"</ol>"
	);
}

function agentTile(agent) {
	const week = agent.week;
	const facts = [
		week.sessions
			? week.sessions + (week.sessions === 1 ? " session" : " sessions")
			: "",
		week.tasks.length === 1
			? "worked on “" + week.tasks[0] + "”"
			: week.tasks.length
				? "worked on " + week.tasks.length + " tasks"
				: "",
		week.costUsd !== null ? money(week.costUsd) + " in model use" : "",
	].filter(Boolean);
	const blocked = week.blocked.length
		? '<div class="agent-alert"><i class="ph ph-warning" aria-hidden="true"></i><div><strong>' +
			week.blocked.length +
			(week.blocked.length === 1
				? " request was blocked"
				: " requests were blocked") +
			" this week</strong><span>" +
			esc(week.blocked[0].text) +
			'</span></div><button class="button quiet small" data-agent-scope="' +
			esc(agent.id) +
			'">Change access</button></div>'
		: "";
	const last = agent.lastSession;
	const lastView = last
		? '<div class="agent-last"><h3>Last session · ' +
			esc(ago(last.endedAt || last.startedAt)) +
			(last.repository ? " · " + esc(last.repository) : "") +
			(last.costUsd !== null ? " · " + esc(money(last.costUsd)) : "") +
			"</h3>" +
			(last.story.length
				? storyList(last.story)
				: '<p class="agent-quiet">It connected but did nothing yet.</p>') +
			"</div>"
		: agent.status === "never_connected"
			? '<div class="agent-last"><p class="agent-quiet">Run <code>npx panini-work connect</code> where this agent works, or use <button class="text-button" data-agent-setup="' +
				esc(agent.id) +
				'">setup steps</button>.</p></div>'
			: "";
	const earlier = agent.earlierSessions.length
		? '<details class="agent-earlier"><summary>Earlier sessions (' +
			agent.earlierSessions.length +
			")</summary><ul>" +
			agent.earlierSessions
				.map(
					(session) =>
						'<li><button class="text-button" data-session-story="' +
						esc(session.id) +
						'">' +
						esc(formatDate(session.startedAt)) +
						"</button><span>" +
						esc(
							[
								session.tasks.length
									? session.tasks.join(", ")
									: "no task",
								money(session.costUsd),
							]
								.filter(Boolean)
								.join(" · "),
						) +
						'</span><div class="agent-session-story" data-story-for="' +
						esc(session.id) +
						'" hidden></div></li>',
				)
				.join("") +
			"</ul></details>"
		: "";

	return (
		'<article class="agent-tile ' +
		esc(agent.status) +
		'"><header><span class="harness-icon"><i class="ph ph-' +
		esc(harnessIcons[agent.harness] || "robot") +
		'" aria-hidden="true"></i></span><div><h2>' +
		esc(agent.name) +
		"</h2><small>" +
		esc(agent.owner) +
		" · " +
		esc(harnessLabels[agent.harness] || "MCP client") +
		"</small></div></header>" +
		agentStatus(agent) +
		(facts.length
			? '<p class="agent-week">This week: ' +
				esc(facts.join(" · ")) +
				"</p>"
			: "") +
		blocked +
		lastView +
		earlier +
		'<footer><button class="button quiet small" data-agent-scope="' +
		esc(agent.id) +
		'">Access</button><button class="button quiet small" data-agent-files="' +
		esc(agent.id) +
		'">Private notes</button>' +
		(last && last.wroteSomething
			? '<button class="button quiet small" data-rollback-session="' +
				esc(last.id) +
				'">Undo last session</button>'
			: "") +
		'<details class="agent-more"><summary class="button quiet small">More</summary><div><button class="button quiet small" data-agent-setup="' +
		esc(agent.id) +
		'">Setup steps</button><button class="button quiet small" data-agent-rotate="' +
		esc(agent.id) +
		'">New secret</button><button class="button danger small" data-agent-revoke="' +
		esc(agent.id) +
		'">Disconnect</button></div></details></footer></article>'
	);
}

function renderAgentBoard() {
	const root = byId("agents");
	const agents = state.agentSummary?.agents || [];
	const current = agents.filter((agent) => agent.status !== "disconnected");
	const gone = agents.filter((agent) => agent.status === "disconnected");

	root.innerHTML =
		(current.map(agentTile).join("") ||
			'<div class="empty agent-empty"><strong>No agents connected yet</strong><span>Run <code>npx panini-work connect</code> in a repository, or press Connect an agent.</span></div>') +
		(gone.length
			? '<details class="agents-gone"><summary>Disconnected agents (' +
				gone.length +
				")</summary>" +
				gone
					.map(
						(agent) =>
							'<div class="activity-row"><strong>' +
							esc(agent.name) +
							"</strong><span>" +
							esc(agent.owner) +
							'</span><button class="button quiet small" data-agent-rotate="' +
							esc(agent.id) +
							'">Reconnect</button></div>',
					)
					.join("") +
				"</details>"
			: "");
}

byId("agents").addEventListener("click", async (event) => {
	const target = event.target as AppElement;
	const story = target.closest<AppElement>("[data-session-story]");
	const rollback = target.closest<AppElement>("[data-rollback-session]");

	try {
		if (story) {
			const box = byId("agents").querySelector<AppElement>(
				'[data-story-for="' + story.dataset.sessionStory + '"]',
			);

			if (!box.hidden) {
				box.hidden = true;
				return;
			}

			const result = await api(
				"/api/agents/sessions/" +
					encodeURIComponent(story.dataset.sessionStory) +
					"/story",
			);

			box.innerHTML = result.story.length
				? storyList(result.story)
				: '<p class="agent-quiet">Nothing recorded.</p>';
			box.hidden = false;
		}
		if (rollback) {
			if (
				!window.confirm(
					"Undo what this session wrote? Its open proposals are rejected, its notes dismissed and its claims released. Accepted changes stay in history.",
				)
			)
				return;

			const result = await api(
				"/api/agents/sessions/" +
					encodeURIComponent(rollback.dataset.rollbackSession) +
					"/rollback",
				{ method: "POST", body: "{}" },
			);

			window.alert(
				"Undone: " +
					result.rejectedProposals +
					" proposals rejected, " +
					result.dismissedNotes +
					" notes dismissed, " +
					result.releasedClaims +
					" claims released.",
			);
			await load();
		}
	} catch (error) {
		showError(error);
	}
});
byId("connect-agent-open").addEventListener("click", () =>
	byId("connect-agent-dialog").showModal(),
);
byId("connect-command-copy").addEventListener("click", async () => {
	await navigator.clipboard.writeText("npx panini-work connect");
	byId("connect-command-copy").textContent = "Copied";
});
byId("connect-manual").addEventListener("click", () => {
	byId("connect-agent-dialog").close();
	byId("new-agent").click();
});
byId("home-needs").addEventListener("click", async (event) => {
	const confirm = (event.target as AppElement).closest<AppElement>(
		"[data-confirm-task], [data-dismiss-task]",
	);
	const note = (event.target as AppElement).closest<AppElement>(
		"[data-note]",
	);

	if (
		(event.target as AppElement).closest<AppElement>(
			'[data-go-view="review"]',
		)
	) {
		navigate("review");
		return;
	}
	try {
		if (confirm) {
			const id =
				confirm.dataset.confirmTask || confirm.dataset.dismissTask;

			await api("/api/tasks/confirm", {
				method: "POST",
				body: JSON.stringify({
					taskIds: [id],
					decision: confirm.dataset.confirmTask
						? "accept"
						: "dismiss",
				}),
			});
			await load();
		} else if (note) {
			await api(
				"/api/notes/" +
					encodeURIComponent(note.dataset.note) +
					"/state",
				{
					method: "POST",
					body: JSON.stringify({ state: note.dataset.noteState }),
				},
			);
			await load();
		}
	} catch (error) {
		showError(error);
	}
});
byId("home-accept-all").addEventListener("click", async () => {
	try {
		const ids = state.home.needs.observed.map((task) => task.id);

		if (ids.length)
			await api("/api/tasks/confirm", {
				method: "POST",
				body: JSON.stringify({ taskIds: ids, decision: "accept" }),
			});
		await load();
	} catch (error) {
		showError(error);
	}
});
