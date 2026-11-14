// Forms, dialogs and startup.

async function openGithubConnection(selectionId) {
	const result = await api(
		"/api/github/connect/session/" + encodeURIComponent(selectionId),
	);

	state.githubSelectionId = selectionId;

	const organizations = result.organizations
		.map((org) => esc(org.login))
		.join(", ");
	const installations = result.installations
		.map((installation) => {
			const repositories = installation.repositories
				.map(
					(repository) =>
						'<label><input type="checkbox" data-github-repository-id="' +
						esc(repository.id) +
						'"' +
						(repository.archived ? " disabled" : "") +
						"><span><b>" +
						esc(repository.full_name) +
						"</b><small>" +
						esc(repository.private ? "Private" : "Public") +
						(repository.archived ? " / archived" : "") +
						"</small></span></label>",
				)
				.join("");

			return (
				'<fieldset class="capability-field" data-github-installation="' +
				esc(installation.id) +
				'"><legend><label><input type="radio" name="githubInstallation" value="' +
				esc(installation.id) +
				'"> ' +
				esc(installation.account.login) +
				"</label></legend>" +
				(repositories ||
					"<p>No repositories available to this GitHub user.</p>") +
				"</fieldset>"
			);
		})
		.join("");

	byId("github-connection-content").innerHTML =
		"<p>Signed in to GitHub as <strong>" +
		esc(result.user.login) +
		"</strong>. " +
		(organizations
			? "Organizations: " + organizations + "."
			: "GitHub did not return an organization list.") +
		"</p>" +
		(installations ||
			"<p>No accessible organization installation found. Install the Panini GitHub App, then select Connect GitHub again.</p>") +
		'<p><a href="' +
		esc(result.installationUrl) +
		'" target="_blank" rel="noopener noreferrer">Install or update the GitHub App</a></p>';
	byId("github-dialog").showModal();
}

byId("github-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const selected = byId("github-form").querySelector<AppElement>(
		'input[name="githubInstallation"]:checked',
	);

	if (!selected)
		return showError(new Error("Choose an organization installation."));

	const fieldset = byId("github-form").querySelector<AppElement>(
		'[data-github-installation="' + selected.value + '"]',
	);
	const repositoryIds = [
		...fieldset.querySelectorAll<AppElement>(
			"[data-github-repository-id]:checked",
		),
	].map((input) => Number(input.dataset.githubRepositoryId));

	if (!repositoryIds.length)
		return showError(new Error("Choose at least one repository."));
	try {
		await api("/api/github/connect/complete", {
			method: "POST",
			body: JSON.stringify({
				selectionId: state.githubSelectionId,
				installationId: Number(selected.value),
				repositoryIds,
			}),
		});
		byId("github-dialog").close();
		state.githubSelectionId = null;
		await load();
		navigate("integrations");
	} catch (error) {
		showError(error);
	}
});
byId("new-device").addEventListener("click", () => {
	if (!state.agents.some((profile) => profile.status === "active"))
		return showError(
			new Error(
				"Create an active agent profile before enrolling a device.",
			),
		);
	byId("device-dialog").showModal();
});
byId("new-mapping").addEventListener("click", () =>
	byId("mapping-dialog").showModal(),
);
document
	.querySelectorAll<AppElement>("[data-close]")
	.forEach((button) =>
		button.addEventListener("click", () =>
			byId(button.dataset.close).close(),
		),
	);
byId("context-search").addEventListener("input", () => {
	if (state.contextMode === "sources" && !byId("context-search").value.trim())
		state.sourceDocuments = state.sourceDocumentsAll;
	renderContextTree();
});
byId("context-project-filter").addEventListener("change", renderContextFilters);
byId("context-search-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const objective = byId("context-search").value.trim();

	if (!objective) return renderContextTree();
	if (objective.startsWith("panini://")) return renderContextTree();
	if (state.contextMode === "sources") {
		byId("context-preview").innerHTML =
			'<div class="preview-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Searching source material</h2><p>Matching document titles, paths, headings, and captured text.</p></div>';
		try {
			const response = await api(
				"/api/source-documents?q=" +
					encodeURIComponent(objective) +
					"&limit=100",
			);

			state.sourceDocuments = response.documents;
			state.selectedSourceDocumentId = null;
			renderContext();
			byId("context-preview").innerHTML =
				'<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-archive" aria-hidden="true"></i></span><h2>' +
				esc(response.documents.length) +
				" source " +
				(response.documents.length === 1 ? "match" : "matches") +
				"</h2><p>Matched sections are highlighted in each document outline.</p></div>";
		} catch (error) {
			showError(error);
		}
		return;
	}
	byId("context-preview").innerHTML =
		'<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-magnifying-glass" aria-hidden="true"></i></span><h2>Searching accepted context</h2><p>Checking paths, content, task links, and version manifests.</p></div>';
	try {
		const project = byId("context-project-filter").value;
		const taskId = byId("context-task-filter").value;
		const filters =
			(project ? "&project=" + encodeURIComponent(project) : "") +
			(taskId ? "&taskId=" + encodeURIComponent(taskId) : "");

		renderRetrieval(
			await api(
				"/api/context/search?objective=" +
					encodeURIComponent(objective) +
					"&q=" +
					encodeURIComponent(objective) +
					filters,
			),
		);
	} catch (error) {
		showError(error);
	}
});

function syncContextFormKind() {
	const isFile = byId("context-kind").value === "file";

	byId("context-fact-type").disabled = isFile;
	byId("context-value-field").hidden = isFile;
	byId("context-body-field").hidden = !isFile;
	byId("context-value").required = !isFile;
	byId("context-body").required = isFile;
	byId("context-path").placeholder = isFile
		? "/handbook/operations.md"
		: "/policies/deployment/review-gate";
}

byId("context-kind").addEventListener("change", syncContextFormKind);
syncContextFormKind();

byId("context-tree").addEventListener("click", (event) => {
	const personalButton = (event.target as AppElement).closest<AppElement>(
		"[data-personal-file]",
	);

	if (personalButton)
		return void openWorkspaceContext(personalButton.dataset.personalFile);

	const sourceButton = (event.target as AppElement).closest<AppElement>(
		"[data-source-document]",
	);

	if (sourceButton)
		return openSourceDocument(sourceButton.dataset.sourceDocument);

	const entryButton = (event.target as AppElement).closest<AppElement>(
		"[data-entry]",
	);

	if (entryButton) return void openContextEntry(entryButton.dataset.entry);

	const folderButton = (event.target as AppElement).closest<AppElement>(
		"[data-folder]",
	);

	if (folderButton)
		folderButton
			.closest<AppElement>(".tree-node")
			.classList.toggle("collapsed");
});

byId("context-preview").addEventListener("click", (event) => {
	const correctButton = (event.target as AppElement).closest<AppElement>(
		"[data-context-correct]",
	);

	if (correctButton) {
		const entry = (state.context?.facts || [])
			.concat(state.context?.files || [])
			.find((item) => item.id === correctButton.dataset.contextCorrect);
		const current = entry
			? entry.kind === "file"
				? entry.body
				: String(entry.value)
			: "";
		const correction = window.prompt(
			"What should it say instead? The change goes to Review.",
			current ?? "",
		);

		if (correction === null || !correction.trim()) return;

		const reason = window.prompt("Why is it wrong? (optional)", "") ?? "";

		void api(
			"/api/context/entries/" +
				encodeURIComponent(correctButton.dataset.contextCorrect) +
				"/corrections",
			{ method: "POST", body: JSON.stringify({ correction, reason }) },
		)
			.then(async () => {
				await load();
				window.alert("Correction sent to Review.");
			})
			.catch(showError);
		return;
	}

	const lifecycleButton = (event.target as AppElement).closest<AppElement>(
		"[data-context-lifecycle]",
	);

	if (lifecycleButton) {
		const entry = state.context.facts
			.concat(state.context.files)
			.find(
				(item) => item.id === lifecycleButton.dataset.contextLifecycle,
			);

		if (!entry) return;
		byId("context-lifecycle-id").value = entry.id;
		byId("context-lifecycle-state").value =
			lifecycleButton.dataset.lifecycleState;
		byId("context-lifecycle-reason").value = "";
		byId("context-lifecycle-from").value = localDateTimeValue(
			entry.effectiveFrom,
		);
		byId("context-lifecycle-to").value = localDateTimeValue(
			entry.effectiveTo,
		);
		byId("context-lifecycle-dialog").showModal();
		return;
	}

	const sourceButton = (event.target as AppElement).closest<AppElement>(
		"[data-source-document]",
	);

	if (sourceButton) {
		setContextMode("sources");
		if (
			state.sourceDocuments.some(
				(item) =>
					item.sourceEventId === sourceButton.dataset.sourceDocument,
			)
		)
			return openSourceDocument(sourceButton.dataset.sourceDocument);
		return void openSourceRead(sourceButton.dataset.sourceDocument, null);
	}

	const sectionButton = (event.target as AppElement).closest<AppElement>(
		"[data-source-section]",
	);

	if (sectionButton && state.selectedSourceDocumentId)
		return void openSourceRead(
			state.selectedSourceDocumentId,
			sectionButton.dataset.sourceSection,
		);

	const fullButton = (event.target as AppElement).closest<AppElement>(
		"[data-source-read-full]",
	);

	if (fullButton)
		return void openSourceRead(fullButton.dataset.sourceReadFull, null);

	const outlineButton = (event.target as AppElement).closest<AppElement>(
		"[data-source-outline]",
	);

	if (outlineButton)
		return openSourceDocument(outlineButton.dataset.sourceOutline);

	const entryButton = (event.target as AppElement).closest<AppElement>(
		"[data-retrieval-entry]",
	);

	if (entryButton) void openContextEntry(entryButton.dataset.retrievalEntry);
});

byId("agent-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = new FormData(formElement);
	const capabilities = values.getAll("capability");

	if (!capabilities.length)
		return showError(new Error("Select at least one capability grant."));

	const lines = (name) =>
		String(values.get(name) || "")
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean);

	const payload = {
		memberId: values.get("memberId"),
		name: values.get("name"),
		description: values.get("description"),
		capabilities,
		dataScope: {
			projects: lines("projects"),
			contextPaths: lines("contextPaths"),
			sourceVisibilities: lines("sourceVisibilities"),
		},
	};

	try {
		const response = await api("/api/agents", {
			method: "POST",
			body: JSON.stringify(payload),
		});

		byId("agent-dialog").close();
		formElement.reset();
		await load();
		navigate("agents");
		byId("connect-agent-profile").value = response.profile.id;
		showAgentSetup(response);
	} catch (error) {
		showError(error);
	}
});

byId("agent-scope-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const form = event.currentTarget as AppElement;
	const values = new FormData(form);

	const lines = (name) =>
		String(values.get(name) || "")
			.split("\n")
			.map((value) => value.trim())
			.filter(Boolean);

	try {
		await api(
			"/api/agents/" +
				encodeURIComponent(String(values.get("agentId"))) +
				"/scope",
			{
				method: "PATCH",
				body: JSON.stringify({
					projects: lines("projects"),
					contextPaths: lines("contextPaths"),
					sourceVisibilities: lines("sourceVisibilities"),
				}),
			},
		);
		byId("agent-scope-dialog").close();
		await load();
	} catch (error) {
		showError(error);
	}
});

let workspaceFilesAgentId = null;
let workspaceFilesRequest = 0;

async function loadWorkspaceFiles() {
	const request = ++workspaceFilesRequest;

	byId("workspace-file-title").textContent = "";
	byId("workspace-file-content").textContent = "";
	byId("workspace-files-list").textContent = "Loading files…";

	const response = await api(
		"/api/agents/" +
			encodeURIComponent(workspaceFilesAgentId) +
			"/files?scope=" +
			byId("workspace-files-scope").value,
	);

	if (request !== workspaceFilesRequest) return;
	byId("workspace-files-list").innerHTML =
		response.files
			.map(
				(file) =>
					'<div class="activity-row"><button class="button quiet small" data-workspace-file="' +
					esc(file.uri) +
					'">' +
					esc(file.path) +
					"</button><span>Version " +
					esc(file.version) +
					" · " +
					esc(file.byteSize) +
					" bytes</span></div>",
			)
			.join("") || "<p>No files saved in this workspace yet.</p>";
}

byId("workspace-files-scope").addEventListener("change", () =>
	loadWorkspaceFiles().catch(showError),
);
byId("workspace-files-list").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-workspace-file]",
	);

	if (!button) return;

	const request = ++workspaceFilesRequest;

	byId("workspace-file-title").textContent = button.textContent;
	byId("workspace-file-content").textContent = "Loading…";
	try {
		const response = await api(
			"/api/agents/" +
				encodeURIComponent(workspaceFilesAgentId) +
				"/files?scope=" +
				byId("workspace-files-scope").value +
				"&uri=" +
				encodeURIComponent(button.dataset.workspaceFile),
		);

		if (request !== workspaceFilesRequest) return;
		byId("workspace-file-content").textContent = response.file
			? response.file.content
			: "File no longer exists.";
	} catch (error) {
		if (request === workspaceFilesRequest)
			byId("workspace-file-content").textContent = "Could not load file.";
		showError(error);
	}
});

byId("agents").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>("button");

	if (!button) return;

	const setupId = button.dataset.agentSetup;
	const scopeId = button.dataset.agentScope;
	const rotateId = button.dataset.agentRotate;
	const revokeId = button.dataset.agentRevoke;
	const filesId = button.dataset.agentFiles;
	const id = setupId || scopeId || rotateId || revokeId || filesId;

	if (!id) return;
	if (
		rotateId &&
		!confirm(
			"Rotate this agent secret? The current secret will stop working immediately.",
		)
	)
		return;
	if (
		revokeId &&
		!confirm(
			"Revoke this agent? Its current secret will stop working immediately.",
		)
	)
		return;
	button.disabled = true;
	try {
		if (scopeId) {
			const profile = state.agents.find((item) => item.id === scopeId);

			if (!profile) throw new Error("Agent profile is unavailable.");
			byId("agent-scope-id").value = profile.id;
			byId("agent-scope-projects").value =
				profile.dataScope.projects.join("\n");
			byId("agent-scope-paths").value =
				profile.dataScope.contextPaths.join("\n");
			byId("agent-scope-visibilities").value =
				profile.dataScope.sourceVisibilities.join("\n");
			byId("agent-scope-dialog").showModal();
		}
		if (filesId) {
			workspaceFilesAgentId = filesId;
			byId("workspace-files-title").textContent =
				(state.agents.find((profile) => profile.id === filesId)?.name ||
					"Agent") + " : workspace files";
			byId("workspace-files-scope").value = "agent";
			byId("workspace-files-dialog").showModal();
			await loadWorkspaceFiles();
		}
		if (setupId)
			showAgentSetup(
				await api("/api/agents/" + encodeURIComponent(id) + "/setup"),
			);
		if (rotateId) {
			const response = await api(
				"/api/agents/" + encodeURIComponent(id) + "/rotate-secret",
				{ method: "POST", body: "{}" },
			);

			await load();
			showAgentSetup(response);
		}
		if (revokeId) {
			await api("/api/agents/" + encodeURIComponent(id) + "/revoke", {
				method: "POST",
				body: "{}",
			});
			await load();
		}
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
	}
});

byId("connect-harness-options").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-connect-harness]",
	);
	const id = byId("connect-agent-profile").value;

	if (!button || !id) return;
	button.disabled = true;
	try {
		const response = await api(
			"/api/agents/" + encodeURIComponent(id) + "/setup",
		);

		byId("agent-connect-menu").open = false;
		showAgentSetup(response, button.dataset.connectHarness);
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
	}
});

byId("setup-content").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>("button");

	if (!button || !state.setup) return;
	if (button.dataset.setupHarness) {
		showAgentSetup(state.setup, button.dataset.setupHarness);
		byId("setup-content")
			.querySelector<AppElement>(
				'[data-setup-harness="' + button.dataset.setupHarness + '"]',
			)
			.focus();
		return;
	}

	let copy = null;

	if (button.hasAttribute("data-copy-secret")) copy = state.setup.secret;
	if (button.dataset.copyStep !== undefined)
		copy = state.setup.setup.steps[Number(button.dataset.copyStep)].code;
	if (button.hasAttribute("data-copy-prompt"))
		copy = state.setup.setup.verificationPrompt;
	if (!copy) return;
	try {
		await navigator.clipboard.writeText(copy);

		const previous = button.innerHTML;

		button.innerHTML =
			'<i class="ph ph-check" aria-hidden="true"></i>Copied';
		setTimeout(() => {
			button.innerHTML = previous;
		}, 1200);
	} catch (error) {
		showError(new Error("Copy failed. Select the text manually."));
	}
});

byId("task-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;

	try {
		const values = formValues(formElement);
		const project = state.workGraph.projects.find(
			(item) =>
				item.name.toLowerCase() ===
				String(values.project || "")
					.trim()
					.toLowerCase(),
		);

		await api("/api/tasks", {
			method: "POST",
			body: JSON.stringify({
				...values,
				projectId: project ? project.id : null,
			}),
		});
		byId("task-dialog").close();
		formElement.reset();
		await load();
	} catch (error) {
		showError(error);
	}
});

byId("project-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;

	try {
		const values = formValues(formElement);

		if (formElement.dataset.projectId) {
			const project = state.workGraph.projects.find(
				(item) => item.id === formElement.dataset.projectId,
			);

			if (!project)
				throw new Error("Project changed. Refresh and try again.");
			await api("/api/projects/" + encodeURIComponent(project.id), {
				method: "PATCH",
				body: JSON.stringify({
					baseVersion: project.version,
					changes: {
						name: values.name,
						outcome: values.outcome,
						owner: values.owner || null,
					},
				}),
			});
		} else {
			await api("/api/projects", {
				method: "POST",
				body: JSON.stringify(values),
			});
		}
		byId("project-dialog").close();
		formElement.reset();
		delete formElement.dataset.projectId;
		await load();
	} catch (error) {
		showError(error);
	}
});

byId("context-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = formValues(formElement);
	const project = state.workGraph.projects.find(
		(item) => item.name === values.project,
	);
	const temporal = {
		lifecycleState: "accepted",
		...(values.effectiveFrom
			? { effectiveFrom: new Date(values.effectiveFrom).toISOString() }
			: {}),
		...(values.effectiveTo
			? { effectiveTo: new Date(values.effectiveTo).toISOString() }
			: {}),
		links: project
			? [
					{
						type: "project",
						targetId: project.id,
						targetRef: project.name,
					},
				]
			: [],
	};
	const payload =
		values.kind === "file"
			? {
					kind: "file",
					path: values.path,
					title: values.title,
					body: values.body,
					...temporal,
				}
			: {
					kind: "fact",
					path: values.path,
					title: values.title,
					factType: values.factType,
					value: values.value,
					...temporal,
				};

	try {
		const response = await api("/api/context/entries", {
			method: "POST",
			body: JSON.stringify(payload),
		});

		byId("context-dialog").close();
		formElement.reset();
		syncContextFormKind();
		await load();
		navigate("context");
		await openContextEntry(response.entry.id);
	} catch (error) {
		showError(error);
	}
});

byId("context-lifecycle-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = formValues(formElement);
	const payload = {
		lifecycleState: values.lifecycleState,
		reason: values.reason,
		...(values.effectiveFrom
			? { effectiveFrom: new Date(values.effectiveFrom).toISOString() }
			: {}),
		effectiveTo: values.effectiveTo
			? new Date(values.effectiveTo).toISOString()
			: null,
	};

	try {
		const response = await api(
			"/api/context/entries/" +
				encodeURIComponent(values.entryId) +
				"/lifecycle",
			{ method: "POST", body: JSON.stringify(payload) },
		);

		byId("context-lifecycle-dialog").close();
		formElement.reset();
		await load();
		navigate("context");
		await openContextEntry(response.entry.id);
	} catch (error) {
		showError(error);
	}
});

byId("integration-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = formValues(formElement);
	const resources = String(values.resources || "")
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);
	const transport =
		values.provider === "slack"
			? "socket_mode"
			: values.provider === "github"
				? "webhook"
				: "poll";
	const config =
		values.provider === "slack"
			? { channels: resources, captureReactions: ["panini"] }
			: values.provider === "github"
				? { repositories: resources }
				: { roots: resources };

	try {
		await api("/api/installations", {
			method: "POST",
			body: JSON.stringify({
				provider: values.provider,
				installationKey: values.installationKey,
				displayName: values.displayName,
				transport,
				config,
			}),
		});
		byId("integration-dialog").close();
		formElement.reset();
		await load();
		navigate("integrations");
	} catch (error) {
		showError(error);
	}
});

byId("device-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = formValues(formElement);

	try {
		await api("/api/devices", {
			method: "POST",
			body: JSON.stringify(values),
		});
		byId("device-dialog").close();
		formElement.reset();
		await load();
		navigate("agents");
	} catch (error) {
		showError(error);
	}
});

byId("mapping-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = formValues(formElement);
	const contextPaths = String(values.contextPaths || "")
		.split("\n")
		.map((value) => value.trim())
		.filter(Boolean);

	try {
		await api("/api/repository-mappings", {
			method: "POST",
			body: JSON.stringify({
				repository: values.repository,
				project: values.project,
				contextPaths,
			}),
		});
		byId("mapping-dialog").close();
		formElement.reset();
		await load();
		navigate("agents");
	} catch (error) {
		showError(error);
	}
});

byId("board").addEventListener("click", async (event) => {
	if (Date.now() - boardDragEndedAt < 250) return;

	const button = (event.target as AppElement).closest<AppElement>(
		"[data-change]",
	);

	if (button) {
		const task = state.board.tasks.find(
			(item) => item.id === button.dataset.change,
		);

		if (!task) return;
		byId("change-task-id").value = task.id;
		byId("change-proposal-id").value = "";
		byId("change-status").value = task.status;
		byId("change-owner").value = task.owner || "";
		byId("change-dialog").showModal();
		return;
	}

	const card = (event.target as AppElement).closest<AppElement>(
		"[data-task]",
	);

	if (!card) return;
	try {
		await openTaskDetail(card.dataset.task);
	} catch (error) {
		showError(error);
	}
});

byId("task-detail-content").addEventListener("submit", async (event) => {
	if ((event.target as AppElement).id !== "outcome-contract-form") return;
	event.preventDefault();

	const form = event.target as AppElement;
	const values = formValues(form);
	let criteria;

	try {
		criteria = JSON.parse(String(values.criteria));
		if (!Array.isArray(criteria) || criteria.length === 0)
			throw new Error("Add at least one criterion.");
	} catch (error) {
		showError(error);
		return;
	}

	const button = form.querySelector<AppElement>('button[type="submit"]');

	button.disabled = true;
	try {
		await api(
			"/api/tasks/" +
				encodeURIComponent(form.dataset.taskId) +
				"/outcome-contract-proposals",
			{
				method: "POST",
				body: JSON.stringify({
					baseRevision: Number(form.dataset.taskVersion),
					contract: {
						statement: String(values.statement).trim(),
						scope: String(values.scope).trim(),
						exclusions: String(values.exclusions)
							.split("\n")
							.map((line) => line.trim())
							.filter(Boolean),
						criteria,
					},
					rationale: String(values.rationale).trim(),
					evidenceIds: [],
				}),
			},
		);
		byId("task-detail-dialog").close();
		await load();
		navigate("review");
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
	}
});

byId("board").addEventListener("dragstart", (event) => {
	const card = (event.target as AppElement).closest<AppElement>(
		"[data-task]",
	);

	if (!card || !event.dataTransfer) return;
	draggedTaskId = card.dataset.task;
	card.classList.add("dragging");
	card.setAttribute("aria-grabbed", "true");
	event.dataTransfer.effectAllowed = "move";
	event.dataTransfer.setData("text/plain", draggedTaskId);
	byId("board-status").textContent =
		"Moving " +
		(card.querySelector<AppElement>("h4")?.textContent || "task") +
		". Choose a destination column.";
});

byId("board").addEventListener("dragover", (event) => {
	const lane = (event.target as AppElement).closest<AppElement>(
		"[data-lane]",
	);

	if (!lane || !draggedTaskId) return;
	event.preventDefault();
	if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
	document.querySelectorAll<AppElement>(".lane.drag-over").forEach((item) => {
		if (item !== lane) item.classList.remove("drag-over");
	});
	lane.classList.add("drag-over");
});

byId("board").addEventListener("dragleave", (event) => {
	const lane = (event.target as AppElement).closest<AppElement>(
		"[data-lane]",
	);

	if (lane && !lane.contains(event.relatedTarget as Node))
		lane.classList.remove("drag-over");
});

byId("board").addEventListener("dragend", () => {
	boardDragEndedAt = Date.now();
	draggedTaskId = null;
	document
		.querySelectorAll<AppElement>(".task-card.dragging")
		.forEach((card) => {
			card.classList.remove("dragging");
			card.setAttribute("aria-grabbed", "false");
		});
	document
		.querySelectorAll<AppElement>(".lane.drag-over")
		.forEach((lane) => lane.classList.remove("drag-over"));
});

byId("board").addEventListener("drop", async (event) => {
	const lane = (event.target as AppElement).closest<AppElement>(
		"[data-lane]",
	);
	const taskId = draggedTaskId || event.dataTransfer?.getData("text/plain");

	if (!lane || !taskId) return;
	event.preventDefault();
	lane.classList.remove("drag-over");

	const task = state.board.tasks.find((item) => item.id === taskId);
	const nextStatus = statusForLane[lane.dataset.lane];

	if (!task || !nextStatus) return;
	if (
		task.status === nextStatus ||
		laneFor(task.status) === lane.dataset.lane
	) {
		byId("board-status").textContent =
			task.title +
			" is already in " +
			lane.querySelector<AppElement>("h3").textContent +
			".";
		return;
	}

	const card = byId("board").querySelector<AppElement>(
		'[data-task="' + CSS.escape(task.id) + '"]',
	);

	card?.classList.add("drag-saving");
	lane.classList.add("drop-saving");
	byId("board-status").textContent = "Saving " + task.title + ".";
	try {
		const response = await api(
			"/api/tasks/" + encodeURIComponent(task.id) + "/proposals",
			{
				method: "POST",
				body: JSON.stringify({
					baseRevision: task.version,
					changes: { status: nextStatus },
					rationale:
						"Moved on the task board from " +
						task.status.replaceAll("_", " ") +
						" to " +
						nextStatus.replaceAll("_", " ") +
						".",
				}),
			},
		);

		if (response.proposal?.state === "pending") {
			await api(
				"/api/proposals/" +
					encodeURIComponent(response.proposal.id) +
					"/approve",
				{
					method: "POST",
					body: JSON.stringify({
						note: "Applied from task board drag and drop; revision history retained.",
					}),
				},
			);
		}
		await load();
		navigate("work");
		byId("board-status").textContent =
			task.title +
			" moved to " +
			lane.querySelector<AppElement>("h3")?.textContent +
			".";
	} catch (error) {
		card?.classList.remove("drag-saving");
		lane.classList.remove("drop-saving");
		byId("board-status").textContent = "Could not move " + task.title + ".";
		showError(error);
	}
});

byId("projects").addEventListener("click", async (event) => {
	const go = (event.target as AppElement).closest<AppElement>(
		"[data-go-view]",
	);

	if (go) {
		navigate(go.dataset.goView);
		return;
	}

	const projectButton = (event.target as AppElement).closest<AppElement>(
		"[data-project]",
	);

	if (projectButton) {
		state.selectedProjectId = projectButton.dataset.project;
		renderProjects();
		return;
	}

	const history = (event.target as AppElement).closest<AppElement>(
		"[data-history-subject]",
	);

	if (history) {
		await openHistorySubject(
			history.dataset.historyType,
			history.dataset.historySubject,
		);
		return;
	}

	const edit = (event.target as AppElement).closest<AppElement>(
		"[data-edit-project]",
	);

	if (edit) {
		const project = state.workGraph.projects.find(
			(item) => item.id === edit.dataset.editProject,
		);

		if (!project) return;

		const form = byId("project-form");

		form.dataset.projectId = project.id;
		byId("project-name").value = project.name;
		byId("project-outcome").value = project.outcome;
		byId("project-owner").value = project.owner || "";
		byId("project-dialog-title").textContent = "Edit project";
		byId("project-submit").textContent = "Save project";
		byId("project-dialog").showModal();
		return;
	}

	const task = (event.target as AppElement).closest<AppElement>(
		"[data-task]",
	);

	if (!task) return;
	try {
		await openTaskDetail(task.dataset.task);
	} catch (error) {
		showError(error);
	}
});

for (const containerId of ["people", "company-blockers"]) {
	byId(containerId).addEventListener("click", async (event) => {
		const go = (event.target as AppElement).closest<AppElement>(
			"[data-go-view]",
		);

		if (go) return navigate(go.dataset.goView);

		const task = (event.target as AppElement).closest<AppElement>(
			"[data-task]",
		);

		if (!task) return;
		try {
			await openTaskDetail(task.dataset.task);
		} catch (error) {
			showError(error);
		}
	});
}

byId("company-outcomes").addEventListener("click", (event) => {
	const project = (event.target as AppElement).closest<AppElement>(
		"[data-project-name]",
	);

	if (project) navigate("projects");
});

byId("change-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const formElement = event.currentTarget as AppElement;
	const values = formValues(formElement);
	const task = state.board.tasks.find((item) => item.id === values.taskId);
	const owner = values.owner || null;
	const changes: { status?: string; owner?: string | null } = {};

	if (task && values.status !== task.status) changes.status = values.status;
	if (task && owner !== task.owner) changes.owner = owner;
	if (!Object.keys(changes).length)
		return showError(
			new Error("Change the status or owner before submitting."),
		);
	try {
		const path = values.proposalId
			? "/api/proposals/" +
				encodeURIComponent(values.proposalId) +
				"/edit"
			: "/api/tasks/" + encodeURIComponent(values.taskId) + "/proposals";
		const payload = values.proposalId
			? { changes, rationale: values.rationale }
			: {
					baseRevision: task.version,
					changes,
					rationale: values.rationale,
				};
		const response = await api(path, {
			method: "POST",
			body: JSON.stringify(payload),
		});

		if (
			!values.proposalId &&
			response.proposal &&
			response.proposal.state === "pending"
		) {
			await api(
				"/api/proposals/" +
					encodeURIComponent(response.proposal.id) +
					"/approve",
				{
					method: "POST",
					body: JSON.stringify({
						note: "Applied from the workspace UI; revision history retained.",
					}),
				},
			);
		}
		byId("change-dialog").close();
		formElement.reset();
		await load();
		navigate("work");
	} catch (error) {
		showError(error);
	}
});

byId("assessment-decision-form").addEventListener("submit", async (event) => {
	event.preventDefault();

	const id = byId("assessment-decision-id").value;
	const note = byId("assessment-decision-reason").value.trim();

	if (!id || note.length < 3) return;

	const submit = byId("assessment-decision-submit");

	submit.disabled = true;
	try {
		await api("/api/proposals/" + encodeURIComponent(id) + "/approve", {
			method: "POST",
			body: JSON.stringify({ note }),
		});
		byId("assessment-decision-dialog").close();
		byId("assessment-decision-form").reset();
		await load();
	} catch (error) {
		showError(error);
	} finally {
		submit.disabled = false;
	}
});

byId("recent-changes").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-undo-change]",
	);

	if (!button) return;
	button.disabled = true;
	try {
		const result = await api(
			"/api/changes/" +
				encodeURIComponent(button.dataset.undoChange) +
				"/undo",
			{ method: "POST", body: "{}" },
		);

		if (!result.undone) showError(new Error(result.reason));
		await load();
	} catch (error) {
		showError(error);
		button.disabled = false;
	}
});

byId("proposals").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>("button");

	if (!button) return;
	if (button.dataset.proposalEvidence || button.dataset.projectEvidence) {
		void openEvidence(
			button.dataset.proposalEvidence || button.dataset.projectEvidence,
		);
		return;
	}

	const projectId =
		button.dataset.projectApprove || button.dataset.projectReject;

	if (projectId) {
		button.disabled = true;
		try {
			await api(
				"/api/project-proposals/" +
					encodeURIComponent(projectId) +
					"/" +
					(button.dataset.projectApprove ? "approve" : "reject"),
				{ method: "POST", body: JSON.stringify({ note: null }) },
			);
			await load();
		} catch (error) {
			showError(error);
			button.disabled = false;
		}
		return;
	}

	const id =
		button.dataset.approve ||
		button.dataset.reject ||
		button.dataset.supersede ||
		button.dataset.rebase ||
		button.dataset.edit;

	if (!id) return;
	if (button.dataset.edit) {
		const detail = state.proposalDetails[id];

		if (!detail || !detail.before) return;
		byId("change-task-id").value = detail.before.id;
		byId("change-proposal-id").value = id;
		byId("change-status").value =
			detail.proposal.changes.status || detail.before.status;
		byId("change-owner").value =
			detail.proposal.changes.owner === null
				? ""
				: detail.proposal.changes.owner || detail.before.owner || "";
		byId("change-rationale").value = detail.proposal.rationale;
		byId("change-dialog").showModal();
		return;
	}
	if (
		button.dataset.approve &&
		state.proposalDetails[id]?.proposal?.assessmentId
	) {
		byId("assessment-decision-id").value = id;
		byId("assessment-decision-reason").value = "";
		byId("assessment-decision-dialog").showModal();
		return;
	}
	button.disabled = true;
	try {
		const action = button.dataset.approve
			? "approve"
			: button.dataset.reject
				? "reject"
				: button.dataset.rebase
					? "rebase"
					: "supersede";

		await api("/api/proposals/" + encodeURIComponent(id) + "/" + action, {
			method: "POST",
			body: JSON.stringify({ actor: "board-user" }),
		});
		await load();
	} catch (error) {
		showError(error);
		button.disabled = false;
	}
});

byId("integrations").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>("button");

	if (!button) return;

	const id =
		button.dataset.installationDisable || button.dataset.installationRevoke;

	if (!id) return;

	const status = button.dataset.installationRevoke ? "revoked" : "disabled";

	if (
		!confirm(
			(status === "revoked" ? "Revoke" : "Disable") +
				" this integration?",
		)
	)
		return;
	try {
		await api("/api/installations/" + encodeURIComponent(id), {
			method: "PATCH",
			body: JSON.stringify({ status }),
		});
		await load();
	} catch (error) {
		showError(error);
	}
});

byId("devices").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-device-revoke]",
	);

	if (
		!button ||
		!confirm(
			"Revoke this device? Queued reports will no longer be accepted.",
		)
	)
		return;
	try {
		await api(
			"/api/devices/" +
				encodeURIComponent(button.dataset.deviceRevoke) +
				"/revoke",
			{ method: "POST", body: "{}" },
		);
		await load();
	} catch (error) {
		showError(error);
	}
});

byId("task-detail-content").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-task-undo]",
	);

	if (
		!button ||
		!confirm("Create a new revision restoring the prior accepted values?")
	)
		return;
	try {
		await api(
			"/api/tasks/" +
				encodeURIComponent(button.dataset.taskUndo) +
				"/undo",
			{ method: "POST", body: JSON.stringify({ actor: "board-user" }) },
		);
		byId("task-detail-dialog").close();
		await load();
	} catch (error) {
		showError(error);
	}
});

byId("sync").addEventListener("click", async (event) => {
	const button = event.currentTarget as AppElement;

	button.disabled = true;
	button.innerHTML =
		'<i class="ph ph-circle-notch spin" aria-hidden="true"></i>Syncing';
	try {
		await api("/api/notion/sync", { method: "POST", body: "{}" });
		await load();
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
		button.innerHTML =
			'<i class="ph ph-arrows-clockwise" aria-hidden="true"></i>Sync sources';
	}
});

byId("analyze").addEventListener("click", async (event) => {
	const button = event.currentTarget as AppElement;

	button.disabled = true;
	button.innerHTML =
		'<i class="ph ph-circle-notch spin" aria-hidden="true"></i>Analyzing';
	try {
		const report = await api("/api/intelligence/run", {
			method: "POST",
			body: "{}",
		});

		await load();
		if (report.state === "completed") navigate("review");
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
		button.innerHTML =
			'<i class="ph ph-magic-wand" aria-hidden="true"></i>Analyze evidence';
	}
});

establishSession()
	.then(async () => {
		await load();
		if (accountsEnabled && state.account) {
			const current = viewByPath[window.location.pathname];

			if (current === "settings") await loadSettings();
			if (current === "onboarding") await loadOnboarding();
			if (current === "integrations" && !isAdmin()) navigate("settings");
		}

		const params = new URLSearchParams(window.location.search);

		if (params.has("githubError"))
			showError(
				new Error(
					"GitHub authorization did not complete. Try connecting again.",
				),
			);
		if (params.has("githubSelection")) {
			navigate("integrations");
			try {
				await openGithubConnection(params.get("githubSelection"));
			} catch (error) {
				showError(error);
			}
		}
		if (params.has("githubError") || params.has("githubSelection"))
			window.history.replaceState(null, "", window.location.pathname);
	})
	.catch(showError);
