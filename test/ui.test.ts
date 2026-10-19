import { describe, expect, it } from "vitest";
import { appScript } from "../src/http/ui-script.js";
import { appStyles } from "../src/http/ui-styles.js";
import { renderAppShell } from "../src/http/ui.js";
import { landingScript } from "../src/http/landing-script.js";
import { landingStyles } from "../src/http/landing-styles.js";
import { renderLandingPage } from "../src/http/landing.js";

describe("Panini landing page", () => {
	it("ships an accessible, CSP-compatible public page with original brand artwork", () => {
		expect(() => new Function(landingScript)).not.toThrow();

		const page = renderLandingPage("landing-nonce");

		expect(page).toContain("The grammar");
		expect(page).toContain("panini.work");
		expect(page).toContain('href="/assets/panini-mark.svg?v=pa"');
		expect(page).toContain('href="/app"');
		expect(page).toContain('src="/assets/landing/grammar-machine.webp"');
		expect(page).toContain('src="/assets/landing/work-sorter.webp"');
		expect(page).toContain('src="/assets/landing/shared-structure.webp"');
		expect(page).toContain(
			'href="/assets/phosphor.css" nonce="landing-nonce"',
		);
		expect(page).toContain('aria-label="Toggle navigation"');
		expect(page).toContain('lang="sa" aria-hidden="true">प</span>');
		expect(page).not.toContain("Rule 1.1");
		expect(page).not.toContain("8 × 4");
		expect(page).not.toContain("tribute-register");
		expect(page).not.toMatch(/\sstyle=/i);
		expect(page).not.toMatch(/\son[a-z]+=/i);
		expect(page + landingScript).not.toMatch(/[—–]/);
	});

	it("uses one responsive editorial system and motion with a reduced-motion exit", () => {
		expect(landingStyles).toContain("--blue: #143fc4");
		expect(landingStyles).toMatch(/\.hero\s*\{[^}]*100svh/s);
		expect(landingStyles).toContain("@media (max-width: 620px)");
		expect(landingStyles).toContain(
			"@media (prefers-reduced-motion: reduce)",
		);
		expect(landingScript).toContain("IntersectionObserver");
		expect(landingScript).not.toContain("window.addEventListener('scroll'");
	});
});

describe("app shell", () => {
	// Failure cases: missing Company knowledge folder, lost URI/folder hierarchy, cross-owner
	// listing, duplicated user workspace, unsafe note HTML, and late preview replies.
	it("browses named user and agent folders on the Context page", async () => {
		expect(renderAppShell("Example", "nonce")).not.toContain(
			'data-context-mode="workspaces"',
		);

		const nodes: Record<string, any> = {
			"context-tree": {},
			"tree-total": {},
			"context-preview": {},
			"context-search": { value: "" },
		};
		const uri = "panini://owner/scout/notes/hello.md";
		const calls: string[] = [];
		const state = {
			contextMode: "accepted",
			context: { tree: [] },
			account: {
				identity: { memberId: "owner", displayName: "Satyam Kulkarni" },
			},
			agents: [
				{
					id: "scout",
					name: "Scout",
					memberId: "owner",
					status: "active",
				},
				{
					id: "sibling",
					name: "Sibling",
					memberId: "owner",
					status: "active",
				},
				{ id: "other", memberId: "another", status: "active" },
			],
			workspaceContext: [],
			workspaceContextRequest: 0,
		};

		const api = async (url: string) => {
			calls.push(url);
			if (url.includes("&uri="))
				return {
					file: {
						uri,
						content: "<script>unsafe</script>",
						version: 1,
					},
				};
			return {
				rootUri: url.includes("scope=user")
					? "panini://owner/user/"
					: "panini://owner/" +
						(url.includes("scout") ? "scout" : "sibling") +
						"/",
				files:
					url.includes("scout") && url.includes("scope=agent")
						? [{ uri, path: "notes/hello.md", version: 1 }]
						: [],
			};
		};

		const code = appScript.slice(
			appScript.indexOf("async function loadWorkspaceContext()"),
			appScript.indexOf("function sourceDocumentHeader("),
		);
		const browser = new Function(
			"state",
			"byId",
			"api",
			"accountsEnabled",
			"esc",
			"showError",
			"filteredNodes",
			"treeMarkup",
			code +
				"; return { loadWorkspaceContext, openWorkspaceContext, renderContextTree };",
		)(
			state,
			(id: string) => nodes[id],
			api,
			true,
			(value: unknown) =>
				String(value).replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
			(error: Error) => {
				throw error;
			},
			(nodes: unknown) => nodes,
			() => "",
		);

		await browser.loadWorkspaceContext();
		expect(calls.some((url) => url.includes("/other/"))).toBe(false);
		expect(calls.filter((url) => url.includes("scope=user"))).toHaveLength(
			1,
		);
		expect(nodes["context-tree"].innerHTML).toContain(
			"panini://owner/scout/",
		);
		expect(nodes["context-tree"].innerHTML).toContain("notes");

		const visibleTree = nodes["context-tree"].innerHTML.replace(
			/<[^>]*>/g,
			" ",
		);

		expect(visibleTree).toMatch(/Satyam\s+Scout\s+notes\s+hello.md/);
		expect(visibleTree).not.toContain("Personal workspaces");
		expect(visibleTree).not.toContain("panini://");
		expect(nodes["context-tree"].innerHTML).toContain(uri);
		await browser.openWorkspaceContext(uri);
		expect(nodes["context-preview"].innerHTML).toContain(
			"&lt;script&gt;unsafe&lt;/script&gt;",
		);
		expect(nodes["context-preview"].innerHTML).not.toContain("<script>");
		expect(nodes["context-preview"].innerHTML).toContain(
			"Satyam / Scout / notes / hello.md",
		);
		expect(nodes["context-preview"].innerHTML).not.toContain("panini://");
		nodes["context-search"].value = "missing";
		browser.renderContextTree();
		expect(nodes["context-tree"].innerHTML).not.toContain(
			'data-personal-file="' + uri,
		);
	});

	it("ships browser-valid JavaScript and CSP-compatible markup", () => {
		expect(() => new Function(appScript)).not.toThrow();

		const shell = renderAppShell("Example <Company>", "test-nonce");

		expect(shell).toContain("Example &lt;Company&gt;");
		expect(shell).toContain("Panini");
		expect(shell).toContain(
			'class="brand-mark" lang="sa" aria-hidden="true">प</span>',
		);
		expect(shell).toContain('data-view="projects"');
		expect(shell).toContain('data-view="work"');
		expect(shell).toContain('data-view="context"');
		expect(shell).toContain('data-view="people"');
		expect(shell).toContain('data-view="timeline"');
		expect(shell).toContain('href="/app/projects"');
		expect(shell).toContain('href="/app/tasks"');
		expect(shell).toContain('href="/app/context"');
		expect(shell).toContain('href="/app/people"');
		expect(shell).toContain('href="/app/timeline"');
		expect(shell).toContain("<b>Timeline</b>");
		expect(shell).toContain("<h1>Timeline</h1>");
		expect(shell).not.toContain(">Lineage<");
		expect(shell).not.toContain('id="connection-title"');
		expect(shell).not.toContain('id="connection-detail"');
		expect(shell).not.toContain('class="pulse-dot"');

		const sidebar = shell.slice(
			shell.indexOf('<aside class="sidebar">'),
			shell.indexOf("</aside>"),
		);
		const topbar = shell.slice(
			shell.indexOf('<header class="topbar">'),
			shell.indexOf("</header>"),
		);

		expect(sidebar).not.toContain('class="workspace-switcher"');
		expect(topbar).toContain('class="workspace-switcher"');
		expect(shell).not.toContain('id="freshness"');
		expect(appScript).toContain("window.addEventListener('popstate'");
		expect(appScript).toContain("window.history.pushState");
		expect(shell).toContain('id="nav-more"');
		expect(shell).toContain('id="projects-index"');
		expect(shell).toContain('id="project-focus"');
		expect(shell).toContain('id="project-decisions"');
		expect(shell).toContain('id="project-history"');
		expect(shell).toContain('id="board-status"');
		expect(shell).not.toContain('class="work-tabs"');
		expect(shell).not.toContain('data-go-view="workstreams"');
		expect(shell).not.toContain('src="/assets/context-observatory.png"');
		expect(shell).toContain('id="context-tree"');
		expect(shell).toContain('data-context-mode="accepted"');
		expect(shell).toContain('data-context-mode="sources"');
		expect(shell).toContain('value="source:read" checked');
		expect(shell).toContain("Original sources");
		expect(shell).not.toContain('class="evidence-browser"');
		expect(shell).not.toContain('id="audit-events"');
		expect(shell).toContain('id="evidence-dialog"');
		expect(shell).toContain('id="evidence-detail"');
		expect(shell).toContain('id="evidence-detail-body"');
		expect(shell).toContain('id="timeline-filter"');
		expect(shell).toContain('id="timeline"');
		expect(shell).toContain(
			"Accepted changes to tasks and company context.",
		);
		expect(shell).toContain('id="view-agents"');
		expect(shell).toContain('id="agent-form"');
		expect(shell).toContain('id="setup-dialog"');
		expect(shell).toContain(
			'href="/assets/phosphor.css" nonce="test-nonce"',
		);
		expect(shell).toContain('class="ph ph-check-square"');
		expect(shell).not.toMatch(/\sstyle=/i);
		expect(shell).not.toMatch(/\son[a-z]+=/i);
		expect(shell + appScript).not.toMatch(/[—–]/);

		const missingTargets = [...appScript.matchAll(/byId\('([^']+)'\)/g)]
			.map((match) => match[1])
			.filter((id) => !shell.includes(`id="${id}"`));

		expect(missingTargets).toEqual([]);
	});

	it("contains work and project content at desktop and narrow widths", () => {
		expect(appStyles).toMatch(/--task-card-min:\s*168px/);
		expect(appStyles).toMatch(
			/\.board\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s,
		);
		expect(appStyles).toMatch(/\.lane\s*\{[^}]*min-width:\s*0/s);
		expect(appStyles).toMatch(
			/\.task-card\s*\{[^}]*min-width:\s*0[^}]*min-height:\s*var\(--task-card-min\)[^}]*display:\s*grid[^}]*grid-template-rows:\s*auto\s+1fr\s+auto\s+auto/s,
		);
		expect(appStyles).toMatch(/\.task-footer\s*\{[^}]*margin-top:\s*auto/s);
		expect(appStyles).toContain(".task-card.dragging");
		expect(appStyles).toContain(".lane.drag-over");
		expect(appStyles).toMatch(
			/\.projects-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(230px,\s*\.78fr\)\s+minmax\(360px,\s*1\.55fr\)\s+minmax\(260px,\s*\.95fr\)/s,
		);
		expect(appStyles).toMatch(
			/\.project-index-item\s*\{[^}]*min-width:\s*0/s,
		);
		expect(appStyles).toMatch(
			/\.project-index,\s*\.project-focus,\s*\.project-rail\s*\{[^}]*min-width:\s*0/s,
		);
		expect(appStyles).toMatch(
			/\.project-task span\s*\{[^}]*min-width:\s*0[^}]*overflow-wrap:\s*anywhere[^}]*white-space:\s*normal/s,
		);
		expect(appStyles).toContain("[hidden] { display: none !important; }");
		expect(appScript).toContain("addEventListener('dragstart'");
		expect(appScript).toContain("addEventListener('drop'");
		expect(appScript).toContain("Moved on the task board from");
		expect(appStyles).toContain("@media (max-width: 1180px)");
		expect(appStyles).toContain(".context-tabs");
		expect(appStyles).toContain(".source-trust");
	});

	it("gives the context tree and preview independent IDE-style scrolling", () => {
		const shell = renderAppShell("Example Company", "test-nonce");

		expect(shell).toContain(
			'id="context-tree" tabindex="0" aria-label="Knowledge topics"',
		);
		expect(shell).toContain(
			'id="context-preview" tabindex="0" aria-label="Knowledge preview"',
		);
		expect(appStyles).toMatch(
			/\.context-browser\s*\{[^}]*height:\s*clamp\(535px,\s*72dvh,\s*820px\)[^}]*overflow:\s*hidden/s,
		);
		expect(appStyles).toMatch(
			/\.tree-panel\s*\{[^}]*grid-template-rows:\s*auto\s+minmax\(0,\s*1fr\)[^}]*overflow:\s*hidden/s,
		);
		expect(appStyles).toMatch(
			/\.context-tree\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s,
		);
		expect(appStyles).toMatch(
			/\.preview-panel\s*\{[^}]*overflow-y:\s*auto[^}]*overscroll-behavior:\s*contain/s,
		);
		expect(appStyles).toMatch(
			/@media \(max-width:\s*620px\)[\s\S]*\.context-browser\s*\{[^}]*height:\s*auto[^}]*display:\s*block/s,
		);
	});
});
