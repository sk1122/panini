// Context tree, source documents and evidence.

function renderContextFilters() {
	const selectedProject = byId("context-project-filter").value;
	const selectedTask = byId("context-task-filter").value;
	const projects = state.workGraph ? state.workGraph.projects : [];

	byId("context-project-filter").innerHTML =
		'<option value="">All projects</option>' +
		projects
			.map(
				(project) =>
					'<option value="' +
					esc(project.name) +
					'">' +
					esc(project.name) +
					"</option>",
			)
			.join("");
	byId("context-project-filter").value = projects.some(
		(project) => project.name === selectedProject,
	)
		? selectedProject
		: "";

	const tasks = state.board.tasks.filter(
		(task) =>
			!byId("context-project-filter").value ||
			canonicalProjectName(task) === byId("context-project-filter").value,
	);

	byId("context-task-filter").innerHTML =
		'<option value="">All tasks</option>' +
		tasks
			.map(
				(task) =>
					'<option value="' +
					esc(task.id) +
					'">' +
					esc(task.title) +
					"</option>",
			)
			.join("");
	byId("context-task-filter").value = tasks.some(
		(task) => task.id === selectedTask,
	)
		? selectedTask
		: "";

	const contextProject = byId("context-link-project").value;

	byId("context-link-project").innerHTML =
		'<option value="">Company-wide</option>' +
		projects
			.map(
				(project) =>
					'<option value="' +
					esc(project.name) +
					'">' +
					esc(project.name) +
					"</option>",
			)
			.join("");
	byId("context-link-project").value = projects.some(
		(project) => project.name === contextProject,
	)
		? contextProject
		: "";
}

function filteredNodes(nodes, query) {
	if (!query) return nodes;
	return nodes.flatMap((node) => {
		const children = filteredNodes(node.children || [], query);
		const matches = (node.name + " " + node.path)
			.toLowerCase()
			.includes(query);

		return matches || children.length ? [{ ...node, children }] : [];
	});
}

function treeMarkup(nodes) {
	return nodes
		.map((node) => {
			const folder = node.kind === "folder";
			const glyph = folder
				? "caret-down"
				: node.kind === "fact"
					? "diamond"
					: "file-text";
			const action = folder
				? ' data-folder="' + esc(node.path) + '"'
				: ' data-entry="' + esc(node.entryId) + '"';
			const active =
				node.entryId && node.entryId === state.selectedEntryId
					? " active"
					: "";
			const row =
				'<button class="tree-row' +
				active +
				'" data-kind="' +
				esc(node.kind) +
				'"' +
				action +
				'><i class="ph ph-' +
				glyph +
				' tree-glyph" aria-hidden="true"></i><strong>' +
				esc(node.name) +
				'</strong><small class="' +
				esc(folder ? "" : "memory-state " + node.lifecycleState) +
				'">' +
				(folder
					? String(node.children.length)
					: esc(node.lifecycleState.replaceAll("_", " "))) +
				"</small></button>";

			return (
				'<div class="tree-node">' +
				row +
				(folder
					? '<div class="tree-children">' +
						treeMarkup(node.children) +
						"</div>"
					: "") +
				"</div>"
			);
		})
		.join("");
}

async function loadWorkspaceContext() {
	const profiles = state.agents.filter(
		(profile) =>
			profile.status === "active" &&
			profile.memberId &&
			(!accountsEnabled ||
				profile.memberId === state.account?.identity?.memberId),
	);
	const members = new Set();
	const requests = [];

	for (const profile of profiles) {
		const scopes = members.has(profile.memberId)
			? ["agent"]
			: ["agent", "user"];

		members.add(profile.memberId);
		for (const scope of scopes) requests.push({ profile, scope });
	}
	state.workspaceContext = await Promise.all(
		requests.map(async ({ profile, scope }) => {
			const member =
				state.account?.identity?.memberId === profile.memberId
					? state.account.identity
					: state.people?.people?.find(
							(person) => person.member.id === profile.memberId,
						)?.member;
			const ownerName =
				member?.displayName?.trim().split(/\s+/)[0] || "User";
			const metadata = {
				agentId: profile.id,
				memberId: profile.memberId,
				ownerName,
				scope,
				name: scope === "user" ? "Shared notes" : profile.name,
			};

			try {
				const result = await api(
					"/api/agents/" +
						encodeURIComponent(profile.id) +
						"/files?scope=" +
						scope,
				);

				return { ...result, ...metadata };
			} catch (error) {
				return {
					...metadata,
					files: [],
					error: "Could not load workspace files.",
				};
			}
		}),
	);
	renderContextTree();
}

function workspaceContextMarkup(query) {
	const folder = (path, name, children) =>
		'<div class="tree-node"><button class="tree-row" data-kind="folder" data-folder="' +
		esc(path) +
		'"><i class="ph ph-caret-down tree-glyph" aria-hidden="true"></i><strong>' +
		esc(name) +
		'</strong></button><div class="tree-children">' +
		children +
		"</div></div>";

	const owners = new Map();

	for (const workspace of state.workspaceContext) {
		const files = workspace.files.filter(
			(file) =>
				!query ||
				(file.uri + " " + workspace.ownerName + " " + workspace.name)
					.toLowerCase()
					.includes(query),
		);

		// Empty personal folders are noise in the company knowledge tree.
		if (!files.length && !workspace.error) continue;

		const root = { folders: new Map(), files: [] };

		for (const file of files) {
			const parts = file.path.split("/");
			let node = root;

			for (const name of parts.slice(0, -1)) {
				if (!node.folders.has(name))
					node.folders.set(name, { folders: new Map(), files: [] });
				node = node.folders.get(name);
			}
			node.files.push({ ...file, name: parts.at(-1) });
		}

		const render = (node, path) =>
			[...node.folders.entries()]
				.map(([name, child]) =>
					folder(
						path + name + "/",
						name,
						render(child, path + name + "/"),
					),
				)
				.join("") +
			node.files
				.map(
					(file) =>
						'<button class="tree-row" data-kind="file" data-personal-file="' +
						esc(file.uri) +
						'"><i class="ph ph-file-text tree-glyph" aria-hidden="true"></i><strong>' +
						esc(file.name) +
						"</strong><small>v" +
						esc(file.version) +
						"</small></button>",
				)
				.join("");

		const content = workspace.error
			? '<p class="muted-copy">' + esc(workspace.error) + "</p>"
			: render(root, workspace.rootUri) ||
				'<p class="muted-copy">No files yet.</p>';

		if (!owners.has(workspace.memberId))
			owners.set(workspace.memberId, {
				name: workspace.ownerName,
				children: "",
			});
		owners.get(workspace.memberId).children += folder(
			workspace.rootUri || workspace.agentId + "/" + workspace.scope,
			workspace.name,
			content,
		);
	}
	return [...owners.entries()]
		.map(([memberId, owner]) =>
			folder("panini://" + memberId + "/", owner.name, owner.children),
		)
		.join("");
}

async function openWorkspaceContext(uri) {
	const workspace = state.workspaceContext.find((item) =>
		item.files.some((file) => file.uri === uri),
	);

	if (!workspace) return;

	const request = ++state.workspaceContextRequest;

	state.selectedEntryId = null;
	state.selectedSourceDocumentId = null;
	byId("context-preview").textContent = "Loading workspace file…";
	try {
		const response = await api(
			"/api/agents/" +
				encodeURIComponent(workspace.agentId) +
				"/files?scope=" +
				workspace.scope +
				"&uri=" +
				encodeURIComponent(uri),
		);

		if (
			request !== state.workspaceContextRequest ||
			state.contextMode !== "accepted"
		)
			return;

		const file = workspace.files.find((item) => item.uri === uri);
		const breadcrumb = [
			workspace.ownerName,
			workspace.name,
			...file.path.split("/"),
		].join(" / ");

		byId("context-preview").innerHTML =
			'<div class="preview-cap"><div><span class="context-path">' +
			esc(breadcrumb) +
			"</span><h2>" +
			esc(file.path.split("/").at(-1)) +
			"</h2><p>" +
			esc(workspace.name) +
			" · Version " +
			esc(response.file.version) +
			'</p></div><span class="kind-pill">Personal working notes</span></div><p class="muted-copy">Not accepted company knowledge.</p><pre class="workspace-file-content">' +
			esc(response.file.content) +
			"</pre>";
	} catch (error) {
		if (
			request !== state.workspaceContextRequest ||
			state.contextMode !== "accepted"
		)
			return;
		byId("context-preview").textContent = "Could not open workspace file.";
		showError(error);
	}
}

function renderContextTree() {
	const query = byId("context-search").value.trim().toLowerCase();

	if (state.contextMode === "sources") {
		const documents = state.sourceDocuments.filter((document) => {
			if (!query) return true;

			const sectionText = document.sections
				.map(
					(section) =>
						section.headingPath.join(" ") + " " + section.excerpt,
				)
				.join(" ");

			return (
				document.title +
				" " +
				document.suggestedPath +
				" " +
				document.sourceRef +
				" " +
				sectionText
			)
				.toLowerCase()
				.includes(query);
		});
		const providers = new Map();

		documents.forEach((document) =>
			providers.set(document.provider, [
				...(providers.get(document.provider) || []),
				document,
			]),
		);
		byId("context-tree").innerHTML =
			[...providers.entries()]
				.map(
					([provider, items]) =>
						'<div class="source-group"><div class="source-group-title"><i class="ph ph-database" aria-hidden="true"></i><strong>' +
						esc(provider) +
						"</strong><small>" +
						items.length +
						"</small></div>" +
						items
							.map(
								(document) =>
									'<button class="source-tree-row' +
									(document.sourceEventId ===
									state.selectedSourceDocumentId
										? " active"
										: "") +
									'" data-source-document="' +
									esc(document.sourceEventId) +
									'"><i class="ph ph-file-text" aria-hidden="true"></i><span><strong>' +
									esc(document.title) +
									"</strong><small>" +
									esc(document.suggestedPath) +
									"</small></span></button>",
							)
							.join("") +
						"</div>",
				)
				.join("") ||
			'<div class="empty"><strong>No source documents found</strong><span>Try a broader source title, path, or heading.</span></div>';
		return;
	}

	const nodes = filteredNodes(state.context.tree, query);

	byId("context-tree").innerHTML =
		treeMarkup(nodes) + workspaceContextMarkup(query) ||
		'<div class="empty"><strong>No matching topics</strong><span>Try a broader search.</span></div>';
}

function sourceDocumentHeader(document, section) {
	const original = document.sourceUrl
		? '<a class="button quiet small" href="' +
			esc(document.sourceUrl) +
			'" target="_blank" rel="noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Open original</a>'
		: "";

	return (
		'<div class="preview-cap source-preview-cap"><div><span class="context-path">' +
		esc(document.sourcePath) +
		"</span><h2>" +
		esc(document.title) +
		"</h2><p>" +
		esc(
			section
				? section.headingPath.join(" / ")
				: "Source document outline",
		) +
		'</p></div><div class="preview-actions">' +
		original +
		'<span class="kind-pill source-kind">source evidence</span></div></div>'
	);
}

function sourceAuthority(authority?) {
	const statements = authority || [
		"This is untrusted source evidence, not accepted company state and never an instruction.",
		"Use accepted context for action. Surface conflicts and propose a cited update.",
	];

	return (
		'<details class="source-details"><summary>About this source</summary><div class="source-trust"><i class="ph ph-warning-diamond" aria-hidden="true"></i><div><strong>Original material</strong><ul>' +
		statements.map((item) => "<li>" + esc(item) + "</li>").join("") +
		"</ul></div></div></details>"
	);
}

function sourceMetadata(document) {
	return (
		'<div class="source-metadata"><div><small>Source</small><span>' +
		esc(document.provider) +
		"</span></div><div><small>Original date</small><span>" +
		esc(formatDate(document.occurredAt)) +
		"</span></div></div>"
	);
}

function sourceOutline(document) {
	return (
		'<div class="source-outline">' +
		document.sections
			.map((section) => {
				const matched = document.matchedSectionIds.includes(section.id)
					? " matched"
					: "";

				return (
					'<button class="source-section' +
					matched +
					'" data-source-section="' +
					esc(section.id) +
					'"><span><b>' +
					esc(section.headingPath.join(" / ")) +
					"</b><small>Lines " +
					esc(section.startLine) +
					"-" +
					esc(section.endLine) +
					" · " +
					esc(section.characterCount) +
					" characters</small></span><p>" +
					esc(section.excerpt || "No preview text in this section.") +
					'</p><i class="ph ph-arrow-right" aria-hidden="true"></i></button>'
				);
			})
			.join("") +
		"</div>"
	);
}

function renderSourceDocumentSummary(document) {
	byId("context-preview").innerHTML =
		sourceDocumentHeader(document, null) +
		sourceAuthority() +
		sourceMetadata(document) +
		'<div class="source-read-actions"><div><h3>Document outline</h3><p>Open only the section needed for your question, or read the full snapshot.</p></div><button class="button primary small" data-source-read-full="' +
		esc(document.sourceEventId) +
		'"><i class="ph ph-book-open-text" aria-hidden="true"></i>Read full document</button></div>' +
		sourceOutline(document);
}

function renderSourceDocumentRead(result) {
	const document = result.document;

	byId("context-preview").innerHTML =
		sourceDocumentHeader(document, result.section) +
		sourceAuthority(result.authority) +
		sourceMetadata(document) +
		'<div class="source-read-actions"><button class="button quiet small" data-source-outline="' +
		esc(document.sourceEventId) +
		'"><i class="ph ph-list" aria-hidden="true"></i>Back to outline</button>' +
		(result.truncated
			? '<span class="health-state degraded">Read truncated</span>'
			: '<span class="health-state">Pinned snapshot</span>') +
		"</div>" +
		'<div class="markdown-body source-markdown">' +
		(markdown(result.markdown) || "<p>This source section is empty.</p>") +
		"</div>";
}

function openSourceDocument(sourceEventId) {
	const document = state.sourceDocuments.find(
		(item) => item.sourceEventId === sourceEventId,
	);

	if (!document) return;
	state.selectedSourceDocumentId = sourceEventId;
	state.selectedSourceSectionId = null;
	renderContextTree();
	renderSourceDocumentSummary(document);
}

async function openSourceRead(sourceEventId, sectionId) {
	state.selectedSourceDocumentId = sourceEventId;
	state.selectedSourceSectionId = sectionId || null;
	renderContextTree();
	byId("context-preview").innerHTML =
		'<div class="preview-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Opening source snapshot</h2><p>Rechecking access and loading the pinned version.</p></div>';
	try {
		const suffix = sectionId
			? "?sectionId=" + encodeURIComponent(sectionId)
			: "";
		const result = await api(
			"/api/source-documents/" +
				encodeURIComponent(sourceEventId) +
				suffix,
		);

		if (
			state.selectedSourceDocumentId === sourceEventId &&
			state.selectedSourceSectionId === (sectionId || null)
		)
			renderSourceDocumentRead(result);
	} catch (error) {
		showError(error);
	}
}

function markdown(value) {
	let inCode = false;
	const rendered = [];

	for (const rawLine of String(value || "").split("\n")) {
		const line = esc(rawLine);

		if (rawLine.startsWith(String.fromCharCode(96).repeat(3))) {
			rendered.push(inCode ? "</code></pre>" : "<pre><code>");
			inCode = !inCode;
		} else if (inCode) {
			rendered.push(line + "\n");
		} else if (/^### /.test(rawLine)) {
			rendered.push("<h4>" + line.slice(4) + "</h4>");
		} else if (/^## /.test(rawLine)) {
			rendered.push("<h3>" + line.slice(3) + "</h3>");
		} else if (/^# /.test(rawLine)) {
			rendered.push("<h2>" + line.slice(2) + "</h2>");
		} else if (/^> /.test(rawLine)) {
			rendered.push("<blockquote>" + line.slice(2) + "</blockquote>");
		} else if (/^[-*] /.test(rawLine)) {
			rendered.push("<p>• " + line.slice(2) + "</p>");
		} else if (line.trim()) {
			rendered.push("<p>" + line + "</p>");
		}
	}
	if (inCode) rendered.push("</code></pre>");
	return rendered.join("");
}

function lineageMarkup(entry) {
	const source = entry.sourceUrl
		? '<a href="' +
			esc(entry.sourceUrl) +
			'" target="_blank" rel="noreferrer">Open original source</a>'
		: "<span>No source URL</span>";

	return (
		'<details class="source-details"><summary>Source and dates</summary><div class="lineage"><div><small>Source reference</small><span title="' +
		esc(entry.sourceRef) +
		'">' +
		esc(entry.sourceRef) +
		"</span></div><div><small>Recorded</small><span>" +
		esc(formatDate(entry.updatedAt)) +
		"</span></div><div><small>Effective from</small><span>" +
		esc(formatDate(entry.effectiveFrom)) +
		(entry.effectiveTo ? " to " + esc(formatDate(entry.effectiveTo)) : "") +
		"</span></div><div><small>Original</small>" +
		source +
		"</div></div></details>"
	);
}

function renderContextPreview(detail) {
	const entry = detail.entry || detail;
	const revisions = detail.revisions || [];
	const evidence = detail.evidence || [];
	const kind = entry.kind === "fact" ? "Statement" : "Document";
	const content =
		entry.kind === "fact"
			? '<div class="fact-value">' + esc(entry.value) + "</div>"
			: '<div class="markdown-body">' +
				(markdown(entry.body) || "<p>This file is empty.</p>") +
				"</div>";
	const revisionRows = revisions
		.slice()
		.reverse()
		.map((revision) => {
			const old = revision.previous;
			const now = revision.current;
			const details = [];

			if (!old) details.push("First recorded");
			else {
				if (
					old.kind === "fact" &&
					now.kind === "fact" &&
					JSON.stringify(old.value) !== JSON.stringify(now.value)
				)
					details.push(
						"Statement: " +
							changeValue(old.value) +
							" → " +
							changeValue(now.value),
					);
				if (
					old.kind === "file" &&
					now.kind === "file" &&
					old.body !== now.body
				)
					details.push("Document text updated");
				if (old.lifecycleState !== now.lifecycleState)
					details.push(
						"Review state: " +
							changeValue(old.lifecycleState) +
							" → " +
							changeValue(now.lifecycleState),
					);
				if (
					old.effectiveFrom !== now.effectiveFrom ||
					old.effectiveTo !== now.effectiveTo
				)
					details.push("Effective dates changed");
				if (!details.length) details.push("Source or links updated");
			}

			const earlier =
				old &&
				old.kind === "file" &&
				now.kind === "file" &&
				old.body !== now.body
					? '<details><summary>Read earlier version</summary><div class="markdown-body">' +
						markdown(old.body) +
						"</div></details>"
					: "";
			const reason =
				detail.reasons && detail.reasons[revision.proposalId];

			return (
				'<div class="knowledge-change"><time>' +
				esc(formatDate(revision.appliedAt)) +
				"</time><strong>" +
				esc(details.join(" · ")) +
				"</strong><small>Recorded by " +
				esc(recordedBy(revision.appliedBy)) +
				"</small>" +
				(reason ? "<p>Recorded note: " + esc(reason) + "</p>" : "") +
				earlier +
				"</div>"
			);
		})
		.join("");
	const evidenceRows = evidence
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
	const citedSources = evidence
		.filter((item) => item.eventKind === "source.document.retrieved")
		.map(
			(item) =>
				'<button class="cited-source" data-source-document="' +
				esc(item.id) +
				'"><i class="ph ph-archive" aria-hidden="true"></i><span><b>' +
				esc(item.provider) +
				" source</b><small>" +
				esc(item.sourceRef) +
				'</small></span><i class="ph ph-arrow-right" aria-hidden="true"></i></button>',
		)
		.join("");
	const nextState =
		entry.lifecycleState === "accepted" ? "needs_review" : "accepted";
	const correctAction =
		'<button class="button quiet small" data-context-correct="' +
		esc(entry.id) +
		'"><i class="ph ph-warning" aria-hidden="true"></i>This is wrong</button>';
	const stateAction = canReview()
		? '<button class="button ' +
			(nextState === "needs_review" ? "danger" : "primary") +
			' small" data-context-lifecycle="' +
			esc(entry.id) +
			'" data-lifecycle-state="' +
			esc(nextState) +
			'"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i>' +
			(nextState === "needs_review"
				? "Mark needs review"
				: "Accept after review") +
			"</button>"
		: "";
	const links = entry.links.length
		? '<div class="agent-grants">' +
			entry.links
				.map(
					(link) =>
						"<span>" +
						esc(link.type + ": " + link.targetRef) +
						"</span>",
				)
				.join("") +
			"</div>"
		: '<p class="muted-copy">Company-wide context with no narrower work association.</p>';

	byId("context-preview").innerHTML =
		'<div class="preview-cap"><div><span class="context-path">' +
		esc(entry.path) +
		"</span><h2>" +
		esc(entry.title) +
		'</h2><div class="preview-state"><span class="memory-state ' +
		esc(entry.lifecycleState) +
		'">' +
		esc(entry.lifecycleState.replaceAll("_", " ")) +
		"</span>" +
		stateAction +
		correctAction +
		'</div></div><span class="kind-pill">' +
		esc(kind) +
		"</span></div>" +
		content +
		'<div class="section-head compact-head"><div><h2>How this changed</h2></div></div><div class="knowledge-history">' +
		(revisionRows ||
			'<div class="empty"><span>No earlier versions recorded.</span></div>') +
		"</div>" +
		'<details class="source-details"><summary>Related work and sources</summary>' +
		links +
		(citedSources
			? '<div class="cited-sources">' + citedSources + "</div>"
			: "") +
		'<div class="activity-list">' +
		evidenceRows +
		"</div></details>" +
		lineageMarkup(entry);
}

async function openContextEntry(entryId) {
	state.workspaceContextRequest++;
	state.selectedEntryId = entryId;
	renderContextTree();
	byId("context-preview").innerHTML =
		'<div class="preview-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Opening entry</h2><p>Loading accepted content and lineage.</p></div>';
	try {
		const response = await api(
			"/api/context/entries/" + encodeURIComponent(entryId),
		);

		if (state.selectedEntryId === entryId) renderContextPreview(response);
	} catch (error) {
		showError(error);
	}
}

function renderContext() {
	const counts = state.context.counts;
	const total = counts.facts + counts.files;

	byId("context-count").textContent = String(total);
	byId("tree-total").textContent =
		state.contextMode === "sources"
			? state.sourceDocuments.length +
				(state.sourceDocuments.length === 1
					? " document"
					: " documents")
			: total +
				(total === 1 ? " entry" : " entries") +
				" · " +
				state.workspaceContext.reduce(
					(count, workspace) => count + workspace.files.length,
					0,
				) +
				" personal files";
	renderContextTree();
}

function setContextMode(mode) {
	state.workspaceContextRequest++;

	const changed = state.contextMode !== mode;

	state.contextMode = mode;
	if (changed) {
		byId("context-search").value = "";
		state.sourceDocuments = state.sourceDocumentsAll;
	}
	document
		.querySelectorAll<AppElement>("[data-context-mode]")
		.forEach((button) => {
			const active = button.dataset.contextMode === mode;

			button.classList.toggle("active", active);
			button.setAttribute("aria-selected", String(active));
		});

	const accepted = mode === "accepted";

	byId("context-project-filter").hidden = !accepted;
	byId("context-task-filter").hidden = !accepted;
	byId("new-context").hidden = !accepted;
	byId("tree-label").textContent = accepted ? "Topics" : "Sources";
	byId("context-library-title").textContent = accepted
		? "Browse knowledge"
		: "Browse original sources";
	byId("context-library-copy").textContent = accepted
		? "Find what the company knows and see how it changed."
		: "Read the original documents behind company knowledge.";
	byId("context-search").placeholder = accepted
		? "Search company knowledge"
		: "Search source titles and headings";
	byId("context-search").setAttribute(
		"aria-label",
		accepted ? "Search company knowledge" : "Search original sources",
	);
	if (accepted) {
		if (state.selectedEntryId) void openContextEntry(state.selectedEntryId);
		else
			byId("context-preview").innerHTML =
				'<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-books" aria-hidden="true"></i></span><h2>Choose a topic</h2><p>Read its current content and how it changed.</p></div>';
	} else {
		if (state.selectedSourceDocumentId)
			openSourceDocument(state.selectedSourceDocumentId);
		else
			byId("context-preview").innerHTML =
				'<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-archive" aria-hidden="true"></i></span><h2>Choose a source document</h2><p>Read the document behind this topic.</p></div>';
	}
	renderContext();
}

function renderEvidenceDetail(detail) {
	const event = detail.event;
	const payload = JSON.stringify(event.payload, null, 2);
	const data =
		event.payload &&
		typeof event.payload === "object" &&
		!Array.isArray(event.payload)
			? event.payload
			: {};
	const document =
		data.document && typeof data.document === "object" ? data.document : {};
	const title =
		event.provider === "github"
			? data.title || data.branch || "GitHub activity"
			: event.provider === "slack"
				? "Slack message"
				: event.provider === "notion"
					? document.title || "Notion document"
					: event.provider === "agent"
						? "Agent work report"
						: "Source record";
	const readable =
		event.provider === "github"
			? data.body || data.text || ""
			: event.provider === "slack"
				? data.text || ""
				: event.provider === "notion"
					? document.markdown || ""
					: event.provider === "agent"
						? data.outcome || data.text || ""
						: "";
	const sourceLink =
		typeof event.sourceUrl === "string" &&
		/^https:\/\//i.test(event.sourceUrl)
			? '<a class="button quiet small" href="' +
				esc(event.sourceUrl) +
				'" target="_blank" rel="noreferrer">Open original source</a>'
			: "";

	byId("evidence-detail").querySelector<AppElement>(
		".evidence-detail-empty",
	).hidden = true;
	byId("evidence-detail-body").innerHTML =
		'<div class="evidence-detail-content">' +
		'<span class="provider-badge">' +
		esc(event.provider) +
		"</span>" +
		"<h2>" +
		esc(title) +
		"</h2>" +
		(readable
			? '<p class="evidence-readable">' +
				esc(String(readable).slice(0, 4000)) +
				"</p>"
			: "") +
		sourceLink +
		'<div class="evidence-detail-grid">' +
		"<div><small>Observed</small><span>" +
		esc(formatDate(event.occurredAt)) +
		"</span></div>" +
		"<div><small>Received</small><span>" +
		esc(formatDate(event.receivedAt)) +
		"</span></div>" +
		"<div><small>Visibility</small><span>" +
		esc(event.visibility) +
		"</span></div>" +
		"<div><small>Type</small><span>" +
		esc(event.eventKind.replaceAll(".", " ")) +
		"</span></div>" +
		"</div>" +
		'<details class="source-details"><summary>Technical source details</summary><p>' +
		esc(event.sourceRef) +
		'</p><pre class="evidence-payload"><code>' +
		esc(payload) +
		"</code></pre></details>" +
		"</div>";
}

async function openEvidence(eventId) {
	state.selectedEvidenceId = eventId;
	byId("evidence-detail").querySelector<AppElement>(
		".evidence-detail-empty",
	).hidden = true;
	byId("evidence-detail-body").innerHTML =
		'<div class="evidence-detail-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Loading receipt</h2></div>';
	byId("evidence-dialog").showModal();
	try {
		const detail = await api(
			"/api/evidence/events/" + encodeURIComponent(eventId),
		);

		if (state.selectedEvidenceId === eventId) renderEvidenceDetail(detail);
	} catch (error) {
		if (state.selectedEvidenceId === eventId) {
			byId("evidence-detail-body").innerHTML = "";
			byId("evidence-detail").querySelector<AppElement>(
				".evidence-detail-empty",
			).hidden = false;
		}
		showError(error);
	}
}

const harnessLabels = {
	codex: "Codex",
	claude_code: "Claude Code",
	hermes: "Hermes Agent",
	pi: "Pi",
	generic_mcp: "Other MCP",
};
const harnessIcons = {
	codex: "terminal-window",
	claude_code: "brackets-curly",
	hermes: "lightning",
	pi: "pi",
	generic_mcp: "plugs-connected",
};
const capabilityLabels = {
	"work:read": "Read work",
	"work:propose": "Propose work",
	"context:read": "Read context",
	"source:read": "Read sources",
	"context:propose": "Propose context",
	"evidence:report": "Report evidence",
};
