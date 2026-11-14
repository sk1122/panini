// Loading data, navigation and view listeners.

async function load() {
	clearError();
	try {
		const [
			board,
			workGraph,
			context,
			sourceDocuments,
			health,
			agents,
			workspace,
			devices,
			mappings,
			company,
			people,
			history,
			projectProposals,
		] = await Promise.all([
			api("/api/board"),
			api("/api/work-graph"),
			api("/api/context"),
			api("/api/source-documents?limit=100"),
			api("/healthz"),
			api("/api/agents"),
			api("/api/workspace"),
			api("/api/devices"),
			api("/api/repository-mappings"),
			api("/api/company"),
			api("/api/people"),
			api("/api/history?view=changes&limit=250"),
			api("/api/project-proposals"),
		]);
		const [home, agentOverview, reconcile, changes] = await Promise.all([
			api("/api/home").catch(() => null),
			api("/api/agents/summary").catch(() => null),
			api("/api/reconcile/runs").catch(() => null),
			api("/api/changes").catch(() => ({ changes: [] })),
		]);

		state.changes = changes.changes;

		state.reconcile = reconcile;
		state.home = home;
		state.agentSummary = agentOverview;
		state.board = board;
		state.workGraph = workGraph;
		state.context = context;
		state.sourceDocuments = sourceDocuments.documents;
		state.sourceDocumentsAll = sourceDocuments.documents;
		state.health = health;
		state.agents = agents.agents;
		state.workspace = workspace;
		state.devices = devices.devices;
		state.mappings = mappings.mappings;
		state.company = company;
		state.people = people;
		await loadWorkspaceContext();
		state.history = history;
		state.projectProposals = projectProposals.proposals;

		const evidenceOperations = isAdmin()
			? await api("/api/evidence/coverage").catch(() => null)
			: null;

		state.evidenceCoverage = evidenceOperations?.coverage ?? null;
		state.evidenceBudget = evidenceOperations?.budget ?? null;
		state.proposalDetails = Object.fromEntries(
			await Promise.all(
				board.proposals.map(async (proposal) => {
					try {
						return [
							proposal.id,
							await api(
								"/api/proposals/" +
									encodeURIComponent(proposal.id),
							),
						];
					} catch {
						return [proposal.id, null];
					}
				}),
			),
		);

		const assessmentIds = [
			...new Set(
				Object.values(state.proposalDetails as Record<string, any>)
					.map(
						(detail) =>
							detail &&
							detail.proposal &&
							detail.proposal.assessmentId,
					)
					.filter(Boolean),
			),
		];

		state.assessmentDetails = Object.fromEntries(
			await Promise.all(
				assessmentIds.map(async (id) => {
					try {
						const response = await api(
							"/api/evidence/assessments/" +
								encodeURIComponent(id),
						);

						return [id, response.assessment];
					} catch {
						return [id, null];
					}
				}),
			),
		);
		renderBoard();
		renderHome();
		renderReconcile();
		renderAgentBoard();
		renderCompany();
		renderPeople();
		renderProjects();
		renderContextFilters();
		renderProposals();
		renderContext();
		renderAgents();
		renderIntegrations();
		renderDevices();
		renderMappings();
		renderHistory();
		renderTimeline();
		renderSummary();
		applyRoleControls();
	} catch (error) {
		showError(error);
	}
}

const pathByView = {
	home: "/app/home",
	connect: "/app/connect",
	company: "/app/company",
	people: "/app/people",
	work: "/app/tasks",
	projects: "/app/projects",
	review: "/app/review",
	context: "/app/context",
	agents: "/app/agents",
	integrations: "/app/integrations",
	history: "/app/history",
	timeline: "/app/timeline",
	settings: "/app/settings",
	onboarding: "/app/onboarding",
};
const viewByPath = Object.fromEntries(
	Object.entries(pathByView).map(([view, path]) => [path, view]),
);

function navigate(
	view: string,
	options: {
		replace?: boolean;
		updateHistory?: boolean;
		scroll?: boolean;
	} = {},
) {
	if (!pathByView[view]) return;
	if (
		accountsEnabled &&
		state.account &&
		view === "integrations" &&
		!isAdmin()
	)
		view = "settings";
	document
		.querySelectorAll<AppElement>(".nav-item, .view")
		.forEach((element) => {
			element.classList.remove("active");
			element.removeAttribute("aria-current");
		});
	byId("nav-more").classList.toggle("current", view === "more");

	const tab = document.querySelector<AppElement>(
		'.nav-item[data-view="' + view + '"]',
	);

	if (tab) {
		tab.classList.add("active");
		tab.setAttribute("aria-current", "page");
	}
	byId("nav-more").open = false;
	byId("workspace-menu").open = false;
	byId("view-" + view).classList.add("active");
	byId("current-view-label").textContent =
		{
			home: "Home",
			context: "Context",
			timeline: "Timeline",
			projects: "Projects",
			work: "Tasks",
			review: "Changes",
			integrations: "Integrations",
		}[view] || view;

	const path = pathByView[view];

	if (options.replace) window.history.replaceState(null, "", path);
	else if (
		options.updateHistory !== false &&
		window.location.pathname !== path
	)
		window.history.pushState(null, "", path);
	if (options.scroll !== false)
		window.scrollTo({ top: 0, behavior: "smooth" });
	if (view === "connect") void loadConnect().catch(showError);
	if (state.account && view === "settings")
		void loadSettings().catch(showError);
	if (state.account && view === "onboarding")
		void loadOnboarding().catch(showError);
}

document
	.querySelectorAll<AppElement>(".nav-item[data-view], [data-go-view]")
	.forEach((item) =>
		item.addEventListener("click", (event) => {
			if (
				item.matches("a") &&
				(event.button !== 0 ||
					event.metaKey ||
					event.ctrlKey ||
					event.shiftKey ||
					event.altKey)
			)
				return;
			event.preventDefault();
			navigate(item.dataset.view || item.dataset.goView);
		}),
	);
window.addEventListener("popstate", () =>
	navigate(viewByPath[window.location.pathname] || "home", {
		updateHistory: false,
		scroll: false,
	}),
);
navigate(viewByPath[window.location.pathname] || "home", {
	replace: window.location.pathname === "/app",
	scroll: false,
});
byId("task-suggestions").addEventListener("click", (event) => {
	if (
		(event.target as AppElement).closest<AppElement>(
			'[data-go-view="review"]',
		)
	)
		navigate("review");
});
byId("project-suggestions").addEventListener("click", (event) => {
	if (
		(event.target as AppElement).closest<AppElement>(
			'[data-go-view="review"]',
		)
	)
		navigate("review");
});
byId("task-detail-content").addEventListener("click", async (event) => {
	const clear = (event.target as AppElement).closest<AppElement>(
		"[data-clear-claims]",
	);

	if (!clear) return;
	try {
		await api(
			"/api/tasks/" +
				encodeURIComponent(clear.dataset.clearClaims) +
				"/claims/clear",
			{ method: "POST", body: "{}" },
		);
		await openTaskDetail(clear.dataset.clearClaims);
	} catch (error) {
		showError(error);
	}
});
byId("task-detail-content").addEventListener("click", (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-work-source]",
	);

	if (!button) return;
	byId("task-detail-dialog").close();
	void openEvidence(button.dataset.workSource);
});

byId("history-filter").addEventListener("change", renderHistory);
byId("timeline-filter").addEventListener("change", renderTimeline);

async function openHistorySubject(type, id) {
	if (type === "context_revision") {
		navigate("context");
		await openContextEntry(id);
	} else if (type === "task_revision") {
		try {
			await openTaskDetail(id);
		} catch (error) {
			showError(error);
		}
	}
}

byId("history").addEventListener("click", (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-history-entry], [data-history-task]",
	);

	if (button)
		void openHistorySubject(
			button.dataset.historyEntry ? "context_revision" : "task_revision",
			button.dataset.historyEntry || button.dataset.historyTask,
		);
});
byId("timeline").addEventListener("click", (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-history-entry], [data-history-task]",
	);

	if (button)
		void openHistorySubject(
			button.dataset.historyEntry ? "context_revision" : "task_revision",
			button.dataset.historyEntry || button.dataset.historyTask,
		);
});
byId("company-recent").addEventListener("click", (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-history-subject]",
	);

	if (button)
		void openHistorySubject(
			button.dataset.historyType,
			button.dataset.historySubject,
		);
});
document
	.querySelectorAll<AppElement>("[data-context-mode]")
	.forEach((button) =>
		button.addEventListener("click", () =>
			setContextMode(button.dataset.contextMode),
		),
	);
byId("session-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const submit = (
		event.currentTarget as AppElement
	).querySelector<AppElement>('button[type="submit"]');

	submit.disabled = true;
	byId("session-error").hidden = true;
	try {
		const response = await fetch("/api/session", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
			},
			body: JSON.stringify({ token: byId("session-token").value }),
		});
		const body = await response
			.json()
			.catch(() => ({ error: "The session response was unreadable." }));

		if (!response.ok)
			throw new Error(body.error || "Administrator sign-in failed.");
		state.csrf = body.csrf || "";
		byId("session-dialog").close();
		state.sessionResolve?.();
		state.sessionResolve = null;
		state.sessionReject = null;
	} catch (error) {
		byId("session-error").textContent =
			error instanceof Error ? error.message : String(error);
		byId("session-error").hidden = false;
	} finally {
		submit.disabled = false;
	}
});
byId("dismiss-alert").addEventListener("click", clearError);
byId("new-task").addEventListener("click", () =>
	byId("task-dialog").showModal(),
);
byId("new-project").addEventListener("click", () => {
	byId("project-form").reset();
	delete byId("project-form").dataset.projectId;
	byId("project-dialog-title").textContent = "Create a project";
	byId("project-submit").textContent = "Create project";
	byId("project-dialog").showModal();
});
byId("new-context").addEventListener("click", () =>
	byId("context-dialog").showModal(),
);
byId("new-agent").addEventListener("click", () => {
	if (state.account)
		byId("agent-member").value = state.account.identity.memberId;
	byId("agent-dialog").showModal();
});
byId("setup-dialog").addEventListener("close", () => {
	state.setup = null;
	byId("setup-content").replaceChildren();
	byId("agent-connection-status").textContent = "";
});
byId("verify-agent-connection").addEventListener("click", async (event) => {
	if (!state.setup) return;

	const id = state.setup.profile.id;
	const button = event.currentTarget as AppElement;

	button.disabled = true;
	try {
		const response = await api(
			"/api/agents/" + encodeURIComponent(id) + "/setup",
		);

		byId("agent-connection-status").textContent = response.profile
			.lastUsedAt
			? "Connected. Last authenticated request: " +
				formatDate(response.profile.lastUsedAt)
			: "No connection yet. Add the server in your client, then try again.";
	} catch (error) {
		byId("agent-connection-status").textContent = error.message;
	} finally {
		button.disabled = false;
	}
});
byId("new-integration").addEventListener("click", () =>
	byId("integration-dialog").showModal(),
);
byId("connect-github").addEventListener("click", async () => {
	try {
		const result = await api("/api/github/connect/start", {
			method: "POST",
			body: "{}",
		});

		window.location.assign(result.authorizationUrl);
	} catch (error) {
		showError(error);
	}
});
