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
		esc(cleanTitle(task.title)) +
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

const statusMark = {
	in_progress:
		'<i class="ph-fill ph-circle-half st ip" aria-hidden="true"></i>',
	review: '<i class="ph-fill ph-circle-half st ip" aria-hidden="true"></i>',
	blocked:
		'<i class="ph-fill ph-warning-circle st warn" aria-hidden="true"></i>',
	done: '<i class="ph-fill ph-check-circle st done" aria-hidden="true"></i>',
};

const statusLabel = (status) =>
	String(status || "")
		.replaceAll("_", " ")
		.replace(/^./, (c) => c.toUpperCase());

function renderHome() {
	const home = state.home;

	if (!home) {
		byId("home-needs").innerHTML =
			'<div class="empty"><strong>Home is unavailable</strong><span>Reload to try again.</span></div>';
		return;
	}

	const needs = home.needs;
	const total =
		needs.observedCount +
		needs.proposalCount +
		needs.noteCount +
		(state.decisions?.needsYou ? 1 : 0);
	const tasks = state.board?.tasks ?? [];
	const now = Date.now();
	const day = 86_400_000;

	const age = (task) => now - new Date(task.updatedAt).valueOf();

	const doneThisWeek = tasks.filter(
		(task) => task.status === "done" && age(task) < 7 * day,
	).length;
	const stuck = tasks.filter(
		(task) => task.status === "in_progress" && age(task) > 14 * day,
	).length;
	const me = state.account?.identity?.displayName;
	const mine = tasks
		.filter((task) => me && task.owner === me && task.status !== "done")
		.slice(0, 6);

	byId("home-count").hidden = total === 0;
	byId("home-count").textContent = String(total);
	byId("home-date").textContent = new Date().toLocaleDateString(undefined, {
		weekday: "long",
		day: "numeric",
		month: "long",
	});
	byId("home-accept-all").hidden = needs.observedCount === 0;
	byId("home-needs-count").textContent = total ? String(total) : "";
	byId("home-mine-count").textContent = mine.length
		? String(mine.length)
		: "";
	byId("home-working-count").textContent = home.workingNow.length
		? String(home.workingNow.length)
		: "";

	const stat = (icon, label, value, extra = "", view = "") =>
		'<button type="button" class="stat ' +
		extra +
		'"' +
		(view ? ' data-go-view="' + view + '"' : "") +
		'><span><i class="ph ph-' +
		icon +
		'" aria-hidden="true"></i>' +
		label +
		"</span><strong>" +
		value +
		"</strong></button>";

	byId("home-stats").innerHTML =
		stat("hand", "Needs you", total) +
		stat(
			"lightning",
			"Agents working",
			home.workingNow.length,
			"",
			"agents",
		) +
		stat("check-circle", "Done this week", doneThisWeek, "", "work") +
		stat(
			"hourglass",
			"Stuck over 2 weeks",
			stuck,
			stuck ? "warn" : "",
			"work",
		);

	const row = (mark, title, sub, side) =>
		'<div class="panel-row">' +
		mark +
		'<div class="panel-main"><strong>' +
		title +
		"</strong>" +
		(sub ? "<span>" + sub + "</span>" : "") +
		"</div>" +
		(side || "") +
		"</div>";

	const needMark = (icon) =>
		'<i class="ph-fill ph-' + icon + ' st need" aria-hidden="true"></i>';

	const observed = needs.observed
		.map((task) =>
			row(
				needMark("eye"),
				esc(cleanTitle(task.title)),
				"Spotted in chat" +
					(task.project ? " · " + esc(task.project) : ""),
				'<div class="row-actions"><button class="button quiet small" data-dismiss-task="' +
					esc(task.id) +
					'">Dismiss</button><button class="button primary small" data-confirm-task="' +
					esc(task.id) +
					'">Accept</button></div>',
			),
		)
		.join("");
	const proposals = needs.proposalCount
		? row(
				needMark("git-pull-request"),
				needs.proposalCount +
					(needs.proposalCount === 1
						? " change to decide"
						: " changes to decide"),
				esc(compact(who(needs.proposals[0]?.rationale || ""), 90)),
				'<button class="button primary small" data-go-view="review">Open</button>',
			)
		: "";
	const notes = needs.notes
		.map((note) =>
			// Show the whole note: you cannot keep or dismiss what you cannot read.
			row(
				needMark("note"),
				esc(note.text),
				esc(who(note.author)) + " · " + esc(ago(note.createdAt)),
				'<div class="row-actions"><button class="button quiet small" data-note-state="dismissed" data-note="' +
					esc(note.id) +
					'">Dismiss</button><button class="button primary small" data-note-state="promoted" data-note="' +
					esc(note.id) +
					'">Keep</button></div>',
			),
		)
		.join("");

	const silent = state.decisions?.needsYou || 0;
	const decided = silent
		? row(
				needMark("scales"),
				silent +
					(silent === 1
						? " decision was made without you"
						: " decisions were made without you"),
				"By your agents, in code they changed",
				'<button class="button primary small" data-go-view="decisions">Review</button>',
			)
		: "";

	byId("home-needs").innerHTML =
		decided + proposals + observed + notes ||
		'<div class="panel-empty">Nothing needs you.</div>';
	byId("home-mine").innerHTML =
		mine
			.map((task) =>
				row(
					statusMark[task.status] ||
						'<i class="ph ph-circle-dashed st" aria-hidden="true"></i>',
					'<button type="button" class="link-button" data-task="' +
						esc(task.id) +
						'">' +
						esc(cleanTitle(task.title)) +
						"</button>",
					task.project ? esc(task.project) : "",
					'<span class="pill ' +
						esc(task.status) +
						'">' +
						esc(statusLabel(task.status)) +
						"</span>",
				),
			)
			.join("") ||
		'<div class="panel-empty">No open tasks are yours.</div>';
	byId("home-working").innerHTML =
		home.workingNow
			.map((item) =>
				row(
					'<span class="agent-chip ' +
						esc(item.sessionState) +
						'"><i class="ph ph-robot" aria-hidden="true"></i></span>',
					esc(cleanTitle(item.taskTitle)),
					esc(item.agentName || "Agent") +
						(item.inferred ? " · from its branch" : ""),
					'<time class="panel-side">' +
						esc(ago(item.lastSeenAt)) +
						"</time>",
				),
			)
			.join("") ||
		'<div class="panel-empty">No agent is working on a task.</div>';
	byId("home-changed").innerHTML = "";
	byId("home-sources").innerHTML = home.sources.length
		? home.sources
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
		: "";
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
		'<p class="connect-grants">It can read work and context, claim tasks, report work, change tasks and context, and keep private notes. Its changes apply at once and can be undone. It cannot read raw sources.</p>' +
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
			"The nightly run is off, so Slack and notes are not read yet. Agent claims, reports and handoffs work without it." +
			(isAdmin()
				? ' <a href="/app/settings#model-section" data-go-view="settings">Choose a model and add your API key</a>.'
				: " An admin can turn it on in Settings.");
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
			esc(cleanTitle(agent.currentTask.title)) +
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

/** Line diff of two snippets (longest common subsequence), as GitHub-style rows. */
function lineDiff(before, after) {
	const a = before === null ? [] : String(before).split("\n");
	const b = String(after).split("\n");

	if (a.length * b.length > 250_000)
		return [
			...a.map((line) => ["-", line]),
			...b.map((line) => ["+", line]),
		];

	const table = Array.from({ length: a.length + 1 }, () =>
		new Array(b.length + 1).fill(0),
	);

	for (let i = a.length - 1; i >= 0; i--)
		for (let j = b.length - 1; j >= 0; j--)
			table[i][j] =
				a[i] === b[j]
					? table[i + 1][j + 1] + 1
					: Math.max(table[i + 1][j], table[i][j + 1]);

	const rows = [];
	let i = 0;
	let j = 0;

	while (i < a.length || j < b.length) {
		if (i < a.length && j < b.length && a[i] === b[j]) {
			rows.push([" ", a[i]]);
			i += 1;
			j += 1;
		} else if (
			i < a.length &&
			(j === b.length || table[i + 1][j] >= table[i][j + 1])
		) {
			// Removed lines come before added ones, as on GitHub.
			rows.push(["-", a[i]]);
			i += 1;
		} else {
			rows.push(["+", b[j]]);
			j += 1;
		}
	}
	return rows;
}

function codeEditsMarkup(result) {
	const edits = result.edits || [];

	if (!edits.length)
		return '<p class="agent-quiet">No code edits recorded for this session.</p>';

	const files = new Map();

	for (const edit of edits)
		files.set(edit.filePath, [...(files.get(edit.filePath) || []), edit]);

	const added = edits.reduce((sum, edit) => sum + edit.linesAdded, 0);
	const removed = edits.reduce((sum, edit) => sum + edit.linesRemoved, 0);

	return (
		'<section class="code-changes"><h3>Code changed <span class="panel-count">' +
		files.size +
		(files.size === 1 ? " file" : " files") +
		'</span> <span class="diff-add">+' +
		added +
		'</span> <span class="diff-del">−' +
		removed +
		"</span>" +
		(result.session?.repository
			? ' <span class="panel-count">' +
				esc(result.session.repository) +
				(result.session.branch
					? " · " + esc(result.session.branch)
					: "") +
				"</span>"
			: "") +
		"</h3>" +
		[...files]
			.map(
				([path, fileEdits]) =>
					'<details class="diff-file"><summary><i class="ph ph-file-code" aria-hidden="true"></i><code>' +
					esc(path) +
					'</code><span class="diff-add">+' +
					fileEdits.reduce((sum, edit) => sum + edit.linesAdded, 0) +
					'</span><span class="diff-del">−' +
					fileEdits.reduce(
						(sum, edit) => sum + edit.linesRemoved,
						0,
					) +
					"</span></summary>" +
					fileEdits
						.map(
							(edit) =>
								'<div class="diff-hunk"><div class="diff-meta">' +
								esc(
									edit.tool === "Write"
										? "Wrote the file"
										: "Edited",
								) +
								" · " +
								esc(
									new Date(edit.createdAt).toLocaleTimeString(
										[],
										{
											hour: "numeric",
											minute: "2-digit",
										},
									),
								) +
								(edit.truncated ? " · cut to fit" : "") +
								'</div><pre class="diff">' +
								lineDiff(edit.before, edit.after)
									.map(
										([sign, line]) =>
											'<span class="dl ' +
											(sign === "+"
												? "add"
												: sign === "-"
													? "del"
													: "ctx") +
											'"><b>' +
											sign +
											"</b>" +
											esc(line) +
											"</span>",
									)
									.join("") +
								"</pre></div>",
						)
						.join("") +
					"</details>",
			)
			.join("") +
		"</section>"
	);
}

async function loadSessionEdits(sessionId, box) {
	box.innerHTML = '<p class="agent-quiet">Loading code changes…</p>';
	try {
		box.innerHTML = codeEditsMarkup(
			await api(
				"/api/agents/sessions/" +
					encodeURIComponent(sessionId) +
					"/edits",
			),
		);
	} catch (error) {
		box.innerHTML = "";
		showError(error);
	}
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
			'<div class="session-edits" data-edits-for="' +
			esc(last.id) +
			'"></div></div>'
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

	const now =
		agent.status === "working"
			? '<span class="agent-state live"><span class="dot"></span>' +
				esc(cleanTitle(agent.currentTask.title)) +
				"</span>"
			: agent.status === "active"
				? '<span class="agent-state live"><span class="dot"></span>Active now</span>'
				: agent.status === "never_connected"
					? '<span class="agent-state"><span class="dot"></span>Not connected yet</span>'
					: '<span class="agent-state"><span class="dot"></span>Idle · ' +
						esc(ago(agent.lastActiveAt)) +
						"</span>";
	const weekShort = [
		week.sessions
			? week.sessions + (week.sessions === 1 ? " session" : " sessions")
			: "",
		week.costUsd !== null ? money(week.costUsd) : "",
	]
		.filter(Boolean)
		.join(" · ");

	return (
		'<article class="agent-row ' +
		esc(agent.status) +
		'"><div class="agent-line"><button type="button" class="agent-open" data-agent-expand aria-expanded="false"><span class="harness-icon"><i class="ph ph-' +
		esc(harnessIcons[agent.harness] || "robot") +
		'" aria-hidden="true"></i></span><span class="agent-name"><strong>' +
		esc(agent.name) +
		"</strong><small>" +
		esc(agent.owner) +
		" · " +
		esc(harnessLabels[agent.harness] || "MCP client") +
		"</small></span>" +
		now +
		'<span class="agent-week-short">' +
		esc(weekShort || "No sessions this week") +
		"</span>" +
		(week.blocked.length
			? '<span class="agent-flag" title="Blocked requests this week"><i class="ph ph-warning" aria-hidden="true"></i>' +
				week.blocked.length +
				"</span>"
			: '<span class="agent-flag-empty"></span>') +
		'</button><div class="agent-actions"><button class="button quiet small" data-agent-scope="' +
		esc(agent.id) +
		'">Access</button><details class="menu"><summary class="button quiet small icon-only" aria-label="More actions"><i class="ph ph-dots-three" aria-hidden="true"></i></summary><div class="menu-list"><button type="button" data-agent-files="' +
		esc(agent.id) +
		'"><i class="ph ph-notebook" aria-hidden="true"></i>Private notes</button><button type="button" data-agent-setup="' +
		esc(agent.id) +
		'"><i class="ph ph-plug" aria-hidden="true"></i>Setup steps</button><button type="button" data-agent-rotate="' +
		esc(agent.id) +
		'"><i class="ph ph-key" aria-hidden="true"></i>New secret</button>' +
		(last && last.wroteSomething
			? '<button type="button" data-rollback-session="' +
				esc(last.id) +
				'"><i class="ph ph-arrow-counter-clockwise" aria-hidden="true"></i>Undo last session</button>'
			: "") +
		'<button type="button" class="danger" data-agent-revoke="' +
		esc(agent.id) +
		'"><i class="ph ph-power" aria-hidden="true"></i>Disconnect</button></div></details></div></div>' +
		'<div class="agent-detail" hidden>' +
		(facts.length
			? '<p class="agent-week">This week: ' +
				esc(facts.join(" · ")) +
				"</p>"
			: "") +
		blocked +
		lastView +
		earlier +
		"</div></article>"
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

// Menus close after a choice or a click elsewhere.
document.addEventListener("click", (event) => {
	const target = event.target as AppElement;

	for (const menu of document.querySelectorAll<HTMLDetailsElement>(
		"details.menu[open]",
	))
		if (!menu.contains(target) || target.closest(".menu-list button"))
			menu.open = false;
});
byId("agents").addEventListener("click", (event) => {
	const open = (event.target as AppElement).closest<AppElement>(
		"[data-agent-expand]",
	);

	if (!open) return;

	const detail = open
		.closest("article")
		.querySelector<AppElement>(".agent-detail");

	detail.hidden = !detail.hidden;
	open.setAttribute("aria-expanded", String(!detail.hidden));

	const edits = detail.querySelector<AppElement>("[data-edits-for]");

	if (!detail.hidden && edits && !edits.dataset.loaded) {
		edits.dataset.loaded = "true";
		void loadSessionEdits(edits.dataset.editsFor, edits);
	}
});
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

			box.innerHTML =
				(result.story.length
					? storyList(result.story)
					: '<p class="agent-quiet">Nothing recorded.</p>') +
				'<div class="session-edits"></div>';
			box.hidden = false;
			void loadSessionEdits(
				story.dataset.sessionStory,
				box.querySelector<AppElement>(".session-edits"),
			);
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
// Apps that take only a URL: create an agent with the usual grants and show its URL.
byId("connect-app-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const form = event.currentTarget as HTMLFormElement;
	const values = formValues(form);
	const memberId = state.account?.identity?.id;

	if (!memberId) {
		byId("connect-agent-dialog").close();
		byId("new-agent").click();
		return;
	}
	try {
		const response = await api("/api/agents", {
			method: "POST",
			body: JSON.stringify({
				memberId,
				name: values.name,
				harness: values.harness,
				description: "Added from the Agents page.",
				capabilities: [
					"work:read",
					"work:propose",
					"context:read",
					"context:propose",
					"evidence:report",
					"workspace:read",
					"workspace:write",
				],
				dataScope: {
					projects: ["*"],
					contextPaths: ["/"],
					sourceVisibilities: ["company"],
				},
			}),
		});

		byId("connect-agent-dialog").close();
		await load();
		navigate("agents");
		showAgentSetup(response, values.harness);
	} catch (error) {
		showError(error);
	}
});
byId("connect-manual").addEventListener("click", () => {
	byId("connect-agent-dialog").close();
	byId("new-agent").click();
});
byId("home-mine").addEventListener("click", (event) => {
	const task = (event.target as AppElement).closest<AppElement>(
		"[data-task]",
	);

	if (task) void openTaskDetail(task.dataset.task).catch(showError);
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
	if (
		(event.target as AppElement).closest<AppElement>(
			'[data-go-view="decisions"]',
		)
	) {
		navigate("decisions");
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
			// Answer at once: hide the note, save, then refresh only Home.
			const row = note.closest<AppElement>(".panel-row");

			row?.querySelectorAll("button").forEach((button) => {
				button.disabled = true;
			});
			row?.classList.add("is-saving");

			const saved = await api(
				"/api/notes/" +
					encodeURIComponent(note.dataset.note) +
					"/state",
				{
					method: "POST",
					body: JSON.stringify({ state: note.dataset.noteState }),
				},
			);
			const entryId = saved.note?.contextEntryId;

			row?.remove();
			if (entryId)
				showToast("Added to Knowledge", "Open", async () => {
					state.context = await api("/api/context");
					renderContext();
					navigate("context");
					await openContextEntry(entryId);
				});
			else showToast("Dismissed");
			state.home = await api("/api/home");
			renderHome();
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
