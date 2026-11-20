// The decisions ledger: what agents and people decided, and what the owner has not seen yet.

const decisionView = { filter: "needs", open: null as string | null };

const decisionIcons = {
	Dependency: "package",
	Tests: "test-tube",
	Checks: "shield-slash",
	Database: "database",
	"CI and deploy": "rocket-launch",
	"Reported by agent": "robot",
	"From chat and code review": "chats-circle",
};

function decisionRow(decision) {
	const open = decisionView.open === decision.id;
	const state =
		decision.ownerState === "acknowledged"
			? '<span class="pill done">Acknowledged</span>'
			: decision.ownerState === "overridden"
				? '<span class="pill blocked">Overridden</span>'
				: decision.silent
					? '<span class="pill silent">Silent</span>'
					: "";
	const where = [
		decision.decidedBy +
			(decision.ownerName && decision.ownerName !== decision.decidedBy
				? " for " + decision.ownerName
				: ""),
		decision.repository,
		decision.filePath,
	]
		.filter(Boolean)
		.join(" · ");
	const canAct = decision.silent || decision.ownerMemberId;
	const actions = !canAct
		? ""
		: decision.ownerState === "unseen"
			? '<button class="button quiet small" data-decision-state="overridden" data-decision="' +
				esc(decision.id) +
				'">Override</button><button class="button primary small" data-decision-state="acknowledged" data-decision="' +
				esc(decision.id) +
				'">Acknowledge</button>'
			: '<button class="button quiet small" data-decision-state="unseen" data-decision="' +
				esc(decision.id) +
				'">Reopen</button>';
	const detail = open
		? '<div class="decision-detail"><p>' +
			esc(decision.statement) +
			"</p>" +
			(decision.reason
				? "<dl><dt>Why</dt><dd>" + esc(decision.reason) + "</dd></dl>"
				: "") +
			(decision.alternatives.length
				? "<dl><dt>Not chosen</dt><dd>" +
					decision.alternatives.map(esc).join("<br>") +
					"</dd></dl>"
				: "") +
			(decision.evidence
				? '<pre class="diff">' +
					decision.evidence
						.split("\n")
						.map(
							(line) =>
								'<span class="dl ' +
								(line.startsWith("+")
									? "add"
									: line.startsWith("-")
										? "del"
										: "ctx") +
								'"><b>' +
								esc(line.slice(0, 1)) +
								"</b>" +
								esc(line.slice(2)) +
								"</span>",
						)
						.join("") +
					"</pre>"
				: "") +
			(decision.ownerNote
				? "<dl><dt>Owner's note</dt><dd>" +
					esc(decision.ownerNote) +
					"</dd></dl>"
				: "") +
			"</div>"
		: "";

	return (
		'<article class="decision-row' +
		(open ? " open" : "") +
		'"><div class="decision-line"><button type="button" class="decision-open" data-decision-open="' +
		esc(decision.id) +
		'" aria-expanded="' +
		open +
		'"><i class="ph ph-' +
		(decisionIcons[decision.category] || "scales") +
		' change-icon" aria-hidden="true"></i><span class="agent-name"><strong>' +
		esc(decision.title) +
		"</strong><small>" +
		esc(where) +
		"</small></span>" +
		state +
		'<span class="change-meta">' +
		esc(ago(decision.decidedAt)) +
		'</span></button><div class="agent-actions">' +
		actions +
		"</div></div>" +
		detail +
		"</article>"
	);
}

function renderDecisions() {
	const all = state.decisions?.decisions || [];
	const needs = all.filter(
		(decision) => decision.silent && decision.ownerState === "unseen",
	);
	const shown = {
		needs,
		silent: all.filter((decision) => decision.silent),
		all,
	}[decisionView.filter];
	const filters = [
		["needs", "Decided without you", needs.length],
		["silent", "All silent", null],
		["all", "Everything", null],
	]
		.map(
			([key, label, count]) =>
				'<button type="button" class="seg' +
				(decisionView.filter === key ? " on" : "") +
				'" data-decision-filter="' +
				key +
				'">' +
				label +
				(count ? ' <span class="repeat">' + count + "</span>" : "") +
				"</button>",
		)
		.join("");

	byId("decision-count").hidden = needs.length === 0;
	byId("decision-count").textContent = String(needs.length);
	byId("decisions").innerHTML =
		'<div class="activity-bar"><div class="segmented">' +
		filters +
		'</div><span class="panel-count">' +
		shown.length +
		(shown.length === 1 ? " decision" : " decisions") +
		"</span></div>" +
		(shown.length
			? '<section class="panel">' +
				shown.map(decisionRow).join("") +
				"</section>"
			: '<div class="panel"><div class="panel-empty">' +
				(decisionView.filter === "needs"
					? "Nothing was decided without you."
					: "No decisions recorded yet. They appear when agents change code, report a decision, or when the nightly run finds one in chat.") +
				"</div></div>");
}

byId("decisions").addEventListener("click", async (event) => {
	const target = event.target as AppElement;
	const filter = target.closest<AppElement>("[data-decision-filter]");
	const open = target.closest<AppElement>("[data-decision-open]");
	const act = target.closest<AppElement>("[data-decision-state]");

	if (filter) {
		decisionView.filter = filter.dataset.decisionFilter;
		renderDecisions();
		return;
	}
	if (open) {
		decisionView.open =
			decisionView.open === open.dataset.decisionOpen
				? null
				: open.dataset.decisionOpen;
		renderDecisions();
		return;
	}
	if (!act) return;

	const next = act.dataset.decisionState;
	const note =
		next === "overridden"
			? window.prompt(
					"What should happen instead? The agent's owner sees this note.",
				)
			: null;

	if (next === "overridden" && note === null) return;
	try {
		const saved = await api(
			"/api/decisions/" +
				encodeURIComponent(act.dataset.decision) +
				"/state",
			{
				method: "POST",
				body: JSON.stringify({
					state: next,
					...(note ? { note } : {}),
				}),
			},
		);

		state.decisions.decisions = state.decisions.decisions.map((decision) =>
			decision.id === saved.decision.id
				? { ...decision, ...saved.decision }
				: decision,
		);
		renderDecisions();
		renderHome();
		showToast(
			next === "acknowledged"
				? "Acknowledged"
				: next === "overridden"
					? "Overridden"
					: "Reopened",
		);
	} catch (error) {
		showError(error);
	}
});
