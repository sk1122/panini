import { appScript } from "./ui-script.js";
import { appStyles } from "./ui-styles.js";

function html(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export function renderAppShell(
	companyName: string,
	nonce: string,
	accountsEnabled = false,
): string {
	const safeCompany = html(companyName);
	const safeNonce = html(nonce);

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="light">
  <meta name="theme-color" content="#f5f6f7">
  <title>${safeCompany} | Panini</title>
  <link rel="icon" href="/assets/panini-mark.svg?v=pa" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/phosphor.css" nonce="${safeNonce}">
  <style nonce="${safeNonce}">${appStyles}</style>
</head>
<body data-auth-mode="${accountsEnabled ? "accounts" : "legacy"}">
  <div class="app-shell">
    <aside class="sidebar">
      <a class="brand-lockup" href="/" aria-label="Panini home, named in tribute to the grammarian Pāṇini">
        <span class="brand-mark" lang="sa" aria-hidden="true">प</span>
        <div><strong>Panini</strong><span>The grammar of work.</span></div>
      </a>

      <nav class="side-nav" aria-label="Workspace views">
        <a class="nav-item active" href="/app/projects" data-view="projects"><i class="ph ph-folder-simple" aria-hidden="true"></i><b>Projects</b><em id="project-count" hidden>0</em></a>
        <a class="nav-item" href="/app/tasks" data-view="work"><i class="ph ph-check-square" aria-hidden="true"></i><b>Tasks</b><em id="work-count" hidden>0</em></a>
        <a class="nav-item" href="/app/context" data-view="context"><i class="ph ph-books" aria-hidden="true"></i><b>Context</b><em id="context-count" hidden>0</em></a>
        <a class="nav-item" href="/app/people" data-view="people"><i class="ph ph-users-three" aria-hidden="true"></i><b>People</b><em id="people-count" hidden>0</em></a>
        <a class="nav-item" href="/app/timeline" data-view="timeline"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i><b>Timeline</b></a>
        <div hidden>
          <em id="company-count">0</em><em id="history-count">0</em><details id="nav-more"></details>
          <a class="nav-item" id="review-nav" href="/app/review" data-view="review" hidden><i class="ph ph-warning-circle" aria-hidden="true"></i><b>Review</b><em id="review-count" hidden>0</em></a>
        </div>
      </nav>
      <nav class="side-tools" aria-label="Workspace setup">
        <a class="nav-item" href="/app/agents" data-view="agents"><i class="ph ph-robot" aria-hidden="true"></i><b>Agents</b><em id="agent-count" hidden>0</em></a>
        <a class="nav-item" href="/app/integrations" data-view="integrations" data-admin-only><i class="ph ph-plugs-connected" aria-hidden="true"></i><b>Integrations</b><em id="integration-count" hidden>0</em></a>
        <a class="nav-item" href="/app/settings" data-view="settings" data-account-only><i class="ph ph-gear" aria-hidden="true"></i><b>Settings</b></a>
      </nav>
      <a class="account-summary" href="/app/settings" data-go-view="settings" data-account-only><span class="workspace-avatar" id="user-avatar">U</span><span><strong id="user-name">Your account</strong><small id="user-role"></small></span></a>
    </aside>

    <div class="workspace">
      <header class="topbar">
        <div class="crumb"><strong id="current-view-label">Projects</strong></div>
        <details class="workspace-menu agent-connect-menu" id="agent-connect-menu" hidden><summary class="button quiet small">Connect MCP</summary><div class="workspace-menu-items"><label for="connect-agent-profile">Agent</label><select id="connect-agent-profile" aria-label="Agent to connect"></select><div id="connect-harness-options"></div></div></details>
        <details class="workspace-menu" id="workspace-menu"><summary class="workspace-switcher">
          <span class="workspace-avatar" id="workspace-avatar">${safeCompany.slice(0, 1).toUpperCase()}</span>
          <div><small>Workspace</small><strong id="workspace-name">${safeCompany}</strong></div>
          <i class="ph ph-caret-down workspace-caret" aria-hidden="true"></i>
        </summary><div class="workspace-menu-items">
          <a href="/app/settings" data-go-view="settings" data-account-only>Account and company</a>
          <a href="/app/agents" data-go-view="agents">Agents</a>
          <a href="/app/integrations" data-go-view="integrations" data-admin-only>Integrations</a>
          <a href="/app/onboarding" data-go-view="onboarding" data-account-only>Setup checklist</a>
          <button type="button" data-sign-out data-account-only>Sign out</button>
        </div></details>
      </header>

      <main>
        <div class="alert" id="alert" role="alert"><span id="alert-copy"></span><button aria-label="Dismiss error" id="dismiss-alert"><i class="ph ph-x" aria-hidden="true"></i></button></div>

        <section class="view" id="view-onboarding">
          <div class="onboarding-head"><span class="eyebrow">Your workspace</span><h1 id="onboarding-title">Welcome to Panini</h1><p>Bring your team, their work, and their agents together. You can return to these steps whenever you need.</p></div>
          <div class="onboarding-steps" id="onboarding-steps" aria-live="polite"></div>
          <div class="onboarding-actions"><button class="button primary" id="finish-onboarding">Finish setup</button><button class="button quiet" id="refresh-onboarding">Refresh connection status</button></div>
          <p class="muted-copy">Sources and agents are optional. Your workspace is ready for manual work now.</p>
        </section>

        <section class="view" id="view-settings">
          <div class="page-head"><div><h1>Settings</h1><p>Your account, your company, and the people with access.</p></div><button class="button quiet" type="button" data-sign-out>Sign out</button></div>
          <div class="settings-stack">
            <section class="settings-section"><header><h2>Your profile</h2><p>Your name appears on work and decisions.</p></header><form id="profile-form" class="settings-form">
              <div class="field"><label for="profile-name">Display name</label><input id="profile-name" name="displayName" required maxlength="120" autocomplete="name"></div>
              <div class="field"><label for="profile-email">Email</label><input id="profile-email" type="email" readonly><small>Your invitation determines your account email.</small></div>
              <button class="button primary" type="submit">Save profile</button><p class="settings-status" id="profile-status" role="status"></p>
            </form></section>
            <section class="settings-section" id="github-account-section" hidden><header><h2>GitHub sign-in</h2><p>Connect your GitHub account as a personal sign-in method. Repository access is managed separately.</p></header><div class="settings-form"><p id="github-account-status"></p><button class="button quiet" type="button" id="connect-github-account">Connect GitHub</button><button class="button quiet" type="button" id="disconnect-github-account" hidden>Disconnect GitHub</button></div></section>
            <section class="settings-section"><header><h2>Password</h2><p>Changing it signs out all other sessions.</p></header><form id="password-form" class="settings-form">
              <div class="field"><label for="current-password">Current password</label><input id="current-password" name="currentPassword" type="password" required maxlength="128" autocomplete="current-password"></div>
              <div class="field"><label for="new-password">New password</label><input id="new-password" name="password" type="password" required minlength="15" maxlength="128" autocomplete="new-password"><small>Use at least 15 characters.</small></div>
              <button class="button primary" type="submit">Change password</button><p class="settings-status" id="password-status" role="status"></p>
            </form></section>
            <section class="settings-section" data-admin-only><header><h2>Company</h2><p>One shared workspace for this installation.</p></header><form id="company-form" class="settings-form">
              <div class="field"><label for="settings-company-name">Company name</label><input id="settings-company-name" name="name" required maxlength="120" autocomplete="organization"></div>
              <button class="button primary" type="submit">Save company</button><p class="settings-status" id="company-status" role="status"></p>
            </form></section>
            <section class="settings-section" data-admin-only><header><h2>Invite a teammate</h2><p>Create a private invitation link and share it with the intended person. It expires after seven days.</p></header><form id="invite-form" class="settings-form">
              <div class="field"><label for="invite-email">Invite email</label><input id="invite-email" name="email" type="email" required maxlength="254" autocomplete="off"></div>
              <div class="field"><label for="invite-role">Workspace role</label><select id="invite-role" name="role"><option value="member">Member</option><option value="reviewer">Reviewer</option><option value="admin" data-owner-only>Administrator</option><option value="owner" data-owner-only>Owner</option></select><small>Members work with shared information and their own agents. Reviewers can also accept changes. Administrators manage integrations and team access. Owners manage administrators.</small></div>
              <button class="button primary" type="submit">Create invitation</button><p class="settings-status" id="invite-status" role="status"></p>
              <div class="field" id="invite-result" hidden><label for="invite-link">Invitation link</label><input id="invite-link" readonly autocomplete="off"><button class="button quiet small" type="button" data-copy-invite>Copy link</button></div>
            </form></section>
            <section class="settings-section full-section" data-admin-only><header><h2>Team access</h2><p>Only invited accounts can sign in. People discovered in source documents are shown in People.</p></header><div id="settings-members" class="settings-member-list"></div><p class="settings-status" id="members-status" role="status"></p><div class="field" id="recovery-result" hidden><label for="recovery-link">Password reset link</label><input id="recovery-link" readonly autocomplete="off"><small>Share privately with this person. The link expires in one hour.</small></div></section>
            <section class="settings-section full-section" data-admin-only><header><h2>Invitations</h2><p>Creating a new invitation for an email revokes its previous invitation.</p></header><div id="settings-invitations" class="settings-member-list"></div></section>
          </div>
        </section>

        <section class="view" id="view-company">
          <div class="page-head"><div><h1>Company</h1><p>What is underway and what changed.</p></div><span class="big-count" id="company-freshness">Loading</span></div>
          <div class="company-health" id="company-health" aria-live="polite"></div>
          <div class="company-columns">
            <section><div class="section-head"><div><h2>Projects</h2><p>Work the company is pursuing now.</p></div></div><div class="company-list" id="company-outcomes"></div></section>
            <section><div class="section-head"><div><h2>Blocked work</h2><p>Tasks waiting for a resolution.</p></div></div><div class="company-list" id="company-blockers"></div></section>
          </div>
          <div class="section-head"><div><h2>Recent changes</h2><p>Updates to work and company knowledge.</p></div><button class="button quiet small" type="button" data-go-view="history">See history</button></div>
          <div class="company-list" id="company-recent"></div>
          <details class="coverage-details"><summary>What sources are covered?</summary><div class="coverage-grid" id="company-coverage"></div></details>
        </section>

        <section class="view" id="view-people">
          <div class="page-head"><div><h1>People</h1><p>Who is responsible for work, and what they have contributed.</p></div><span class="big-count" id="people-metric">0 people</span></div>
          <div class="people-grid" id="people"></div>
        </section>

        <section class="view" id="view-work">
          <div class="work-intro">
            <div><span class="eyebrow"><i class="ph ph-square" aria-hidden="true"></i>Accepted work</span><h1>Tasks</h1><p>Current commitments, grouped by accepted status.</p></div>
            <button class="button primary" id="new-task"><i class="ph ph-plus" aria-hidden="true"></i>Create task</button>
          </div>
          <div id="task-suggestions"></div>
          <div class="board-guide"><span><i class="ph ph-arrows-out-cardinal" aria-hidden="true"></i>Drag tasks between columns to update status.</span><span class="sr-only" id="board-status" aria-live="polite"></span></div>
          <div class="board loading" id="board" aria-live="polite">
            <div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div><div class="skeleton"></div>
          </div>
        </section>

        <section class="view active" id="view-projects">
          <header class="projects-hero">
            <div><h1>Projects</h1><p>Durable outcomes and the accepted work connected to them.</p></div>
            <button class="button primary" id="new-project"><i class="ph ph-plus" aria-hidden="true"></i>Create project</button>
          </header>
          <div class="projects-summary"><span><b id="project-metric">0 projects</b></span><i class="ph ph-arrow-right" aria-hidden="true"></i><span><b id="accepted-task-metric">0</b> accepted tasks</span><i class="ph ph-arrow-right" aria-hidden="true"></i><button type="button" data-go-view="review"><b id="decision-metric">0</b> changes need a decision</button></div>
          <div id="project-suggestions"></div>
          <div class="projects-workspace" id="projects">
            <aside class="project-index"><header><h2>Projects</h2><span>Current</span></header><div id="projects-index"></div></aside>
            <section class="project-focus" id="project-focus" aria-live="polite"></section>
            <aside class="project-rail"><section><header><h2>Needs a decision</h2><b id="project-decision-count">0</b></header><div id="project-decisions"></div></section><section><header><h2>Latest accepted change</h2></header><div id="project-history"></div></section></aside>
          </div>
        </section>

        <section class="view" id="view-review">
          <div class="page-head"><div><h1>Review</h1><p>Decide proposed changes after checking their source evidence.</p></div><span class="big-count" id="proposal-metric">0 proposals</span></div>
          <div class="review-layout">
            <div class="proposal-list" id="proposals"></div>
            <aside class="decision-card">
              <div id="evidence-coverage" hidden></div>
              <h2>Why review matters</h2>
              <div class="decision-rule"><i class="ph ph-arrows-left-right" aria-hidden="true"></i><div><strong>Credible conflict</strong><p>Current evidence supports mutually exclusive outcomes.</p></div></div>
              <div class="decision-rule"><i class="ph ph-warning" aria-hidden="true"></i><div><strong>Sensitive ambiguity</strong><p>A consequential change cannot be resolved safely from available history.</p></div></div>
              <div class="decision-rule"><i class="ph ph-seal-check" aria-hidden="true"></i><div><strong>Audited resolution</strong><p>Your decision remains linked to evidence and revision history.</p></div></div>
            </aside>
          </div>
        </section>

        <section class="view" id="view-context">
          <div class="page-head"><div><h1>Context</h1><p>Plans, decisions, policies, and other information the company has recorded.</p></div></div>
          <div class="context-tabs" role="tablist" aria-label="Knowledge views">
            <button class="context-tab active" type="button" role="tab" aria-selected="true" data-context-mode="accepted"><i class="ph ph-seal-check" aria-hidden="true"></i><span><b>Company knowledge</b><small>Current and earlier versions</small></span></button>
            <button class="context-tab" type="button" role="tab" aria-selected="false" data-context-mode="sources"><i class="ph ph-archive" aria-hidden="true"></i><span><b>Original sources</b><small>Documents behind the knowledge</small></span></button>
          </div>
          <div class="section-head context-heading"><div><h2 id="context-library-title">Browse knowledge</h2><p id="context-library-copy">Find what the company knows and see how it changed.</p></div><div class="context-actions"><select class="context-filter" id="context-project-filter" aria-label="Filter by project"><option value="">All projects</option></select><select class="context-filter" id="context-task-filter" aria-label="Filter by task"><option value="">All tasks</option></select><form class="search-field" id="context-search-form"><i class="ph ph-magnifying-glass" aria-hidden="true"></i><input id="context-search" type="search" placeholder="Search company knowledge" aria-label="Search company knowledge"><button type="submit" aria-label="Search knowledge">Search</button></form><button class="button primary" id="new-context"><i class="ph ph-plus" aria-hidden="true"></i>Add entry</button></div></div>
          <div class="context-browser">
            <aside class="tree-panel"><div class="panel-kicker"><span id="tree-label">Topics</span><b id="tree-total">0 entries</b></div><div class="context-tree" id="context-tree" tabindex="0" aria-label="Knowledge topics"></div></aside>
            <article class="preview-panel" id="context-preview" tabindex="0" aria-label="Knowledge preview"><div class="preview-empty"><span class="empty-glyph"><i class="ph ph-books" aria-hidden="true"></i></span><h2>Choose a topic</h2><p>Read its current content and how it changed.</p></div></article>
          </div>
        </section>

        <section class="view" id="view-timeline">
          <div class="page-head timeline-head"><div><h1>Timeline</h1><p>Accepted changes to tasks and company context.</p></div><div class="lineage-controls"><span class="mono" id="timeline-metric">0 changes</span><select id="timeline-filter" aria-label="Filter timeline"><option value="">Tasks and context</option><option value="task_revision">Tasks</option><option value="context_revision">Context</option></select><button class="button quiet small" type="button" data-go-view="history">Open full history</button></div></div>
          <div class="history-timeline timeline-list" id="timeline"></div>
        </section>

        <section class="view" id="view-history">
          <div class="page-head"><div><h1>History</h1><p>How work and company knowledge changed over time.</p></div><span class="big-count" id="history-metric">0 changes</span></div>
          <div class="history-controls"><label for="history-filter">Show</label><select id="history-filter"><option value="">All changes</option><option value="context_revision">Knowledge</option><option value="task_revision">Work</option></select></div>
          <div class="history-timeline" id="history"></div>
        </section>

        <section class="view" id="view-agents">
          <div class="agents-hero">
            <div><h1>Agents</h1><p>Personal, scoped connections for Codex, Claude Code, Hermes, Pi, and other MCP clients.</p></div>
            <button class="button primary" id="new-agent"><i class="ph ph-plus" aria-hidden="true"></i>Create agent</button>
          </div>
          <div class="agent-boundary"><i class="ph ph-shield-check" aria-hidden="true"></i><div><strong>Scoped by profile</strong><span>Secrets appear once. Company changes become proposals or evidence; private notes stay with the agent.</span></div></div>
          <div class="section-head"><div><h2>Workspace profiles</h2><p>Each connection can be traced, rotated, and revoked independently.</p></div><span class="mono" id="agent-metric">0 profiles</span></div>
          <div class="agent-grid" id="agents"></div>
          <div class="section-head"><div><h2>Enrolled devices</h2><p>Relay credentials are independently revocable and expose no transcripts by default.</p></div><button class="button quiet" id="new-device"><i class="ph ph-laptop" aria-hidden="true"></i>Enroll device</button></div>
          <div class="activity-list" id="devices"></div>
          <div class="section-head"><div><h2>Repository mapping</h2><p>Map a repository to its project and approved context paths.</p></div><button class="button quiet" id="new-mapping"><i class="ph ph-git-branch" aria-hidden="true"></i>Add mapping</button></div>
          <div class="activity-list" id="repository-mappings"></div>
        </section>

        <section class="view" id="view-integrations">
          <div class="agents-hero"><div><h1>Integrations</h1><p>Manage where company information comes from.</p></div><div class="top-actions"><button class="button quiet" id="analyze" hidden><i class="ph ph-magic-wand" aria-hidden="true"></i>Analyze evidence</button><button class="button quiet" id="sync"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i>Sync sources</button><button class="button primary" id="connect-github"><i class="ph ph-github-logo" aria-hidden="true"></i>Connect GitHub</button><button class="button quiet" id="new-integration"><i class="ph ph-plus" aria-hidden="true"></i>Add integration</button></div></div>
          <div class="agent-boundary"><i class="ph ph-lock-key" aria-hidden="true"></i><div><strong>Credentials stay outside normal reads</strong><span>Slack captures require a designated reaction. GitHub and Notion are restricted to selected resources.</span></div></div>
          <div class="integration-grid" id="integrations"></div>
        </section>
      </main>
    </div>
  </div>

  <dialog id="session-dialog"><form class="modal session-modal" id="session-form"><div class="modal-cap"><span class="modal-label">Local administrator</span></div><h2>Unlock this workspace</h2><p>Enter the private administrator token created by <code>panini-setup init</code>. It is exchanged for an eight-hour protected session and is never stored in the browser.</p><div class="field"><label for="session-token">Administrator token</label><input id="session-token" name="token" type="password" required autocomplete="current-password" spellcheck="false"></div><p class="form-error" id="session-error" role="alert" hidden></p><div class="modal-actions"><button class="button primary" type="submit"><i class="ph ph-lock-key" aria-hidden="true"></i>Unlock workspace</button></div></form></dialog>

  <dialog id="workspace-files-dialog"><div class="modal"><div class="modal-cap"><span class="modal-label">Personal workspace</span><button type="button" class="icon-button" data-close="workspace-files-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2 id="workspace-files-title">Workspace files</h2><p>Working notes saved by your agents. These are separate from accepted company context.</p><div class="field"><label for="workspace-files-scope">Workspace</label><select id="workspace-files-scope"><option value="agent">Agent : private to this profile</option><option value="user">User : shared across your agents</option></select></div><div id="workspace-files-list"></div><h3 id="workspace-file-title"></h3><pre id="workspace-file-content" class="workspace-file-content"></pre></div></dialog>
  <dialog id="task-dialog"><form class="modal" id="task-form"><div class="modal-cap"><span class="modal-label">Accepted revision</span><button type="button" class="icon-button" data-close="task-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Create a task</h2><p>You will be recorded as the decision maker for this task.</p>
    <div class="field"><label for="title">Title</label><input id="title" name="title" required maxlength="180" autocomplete="off" placeholder="A concrete outcome"></div>
    <div class="field"><label for="description">Description</label><textarea id="description" name="description" placeholder="What should be true when this is done?"></textarea></div>
    <div class="field-pair"><div class="field"><label for="project">Project</label><input id="project" name="project" maxlength="120"></div><div class="field"><label for="owner">Owner</label><input id="owner" name="owner" maxlength="120"></div></div>
    <div class="field"><label for="priority">Priority</label><select id="priority" name="priority"><option value="medium">Medium</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="task-dialog">Cancel</button><button class="button primary" type="submit"><i class="ph ph-plus" aria-hidden="true"></i>Create task</button></div>
  </form></dialog>
  <dialog id="project-dialog"><form class="modal" id="project-form"><div class="modal-cap"><span class="modal-label">Accepted revision</span><button type="button" class="icon-button" data-close="project-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2 id="project-dialog-title">Create a project</h2><p>Describe the outcome this project is pursuing.</p>
    <div class="field"><label for="project-name">Name</label><input id="project-name" name="name" required maxlength="180"></div>
    <div class="field"><label for="project-outcome">Outcome</label><textarea id="project-outcome" name="outcome" required maxlength="5000"></textarea></div>
    <div class="field"><label for="project-owner">Owner, if assigned</label><input id="project-owner" name="owner" maxlength="240"></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="project-dialog">Cancel</button><button class="button primary" id="project-submit" type="submit">Create project</button></div>
  </form></dialog>

  <dialog id="change-dialog"><form class="modal" id="change-form"><div class="modal-cap"><span class="modal-label">Accepted revision</span><button type="button" class="icon-button" data-close="change-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Update task</h2><p>This saves a new revision. Earlier versions remain in history.</p>
    <input type="hidden" id="change-task-id" name="taskId">
    <input type="hidden" id="change-proposal-id" name="proposalId">
    <div class="field-pair"><div class="field"><label for="change-status">Status</label><select id="change-status" name="status"><option value="backlog">Backlog</option><option value="planned">Planned</option><option value="in_progress">In progress</option><option value="blocked">Blocked</option><option value="review">Review</option><option value="done">Done</option><option value="cancelled">Cancelled</option></select></div><div class="field"><label for="change-owner">Owner</label><input id="change-owner" name="owner" maxlength="120"></div></div>
    <div class="field"><label for="change-rationale">Evidence-aware rationale</label><textarea id="change-rationale" name="rationale" required placeholder="What supports this change?"></textarea></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="change-dialog">Cancel</button><button class="button primary" type="submit">Save change</button></div>
  </form></dialog>

  <dialog id="assessment-decision-dialog"><form class="modal" id="assessment-decision-form"><div class="modal-cap"><span class="modal-label">Evidence decision</span><button type="button" class="icon-button" data-close="assessment-decision-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Approve reported change</h2><p>Confirm the source and task scope. Your reason is saved with the accepted revision.</p>
    <input type="hidden" id="assessment-decision-id" name="proposalId">
    <div class="field"><label for="assessment-decision-reason">Reason for approval</label><textarea id="assessment-decision-reason" name="reason" required minlength="3" maxlength="2000" placeholder="What did you verify, and why does it apply to this task?"></textarea></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="assessment-decision-dialog">Cancel</button><button class="button primary" id="assessment-decision-submit" type="submit">Approve change</button></div>
  </form></dialog>

  <dialog id="context-dialog"><form class="modal" id="context-form"><div class="modal-cap"><span class="modal-label">Provenance-backed context</span><button type="button" class="icon-button" data-close="context-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Add context entry</h2><p>Choose one atomic fact or a long-form Markdown file. This authorized action creates its own evidence receipt.</p>
    <div class="field-pair"><div class="field"><label for="context-kind">Entry kind</label><select id="context-kind" name="kind"><option value="fact">Atomic fact</option><option value="file">Long-form file</option></select></div><div class="field"><label for="context-fact-type">Fact type</label><select id="context-fact-type" name="factType"><option value="decision">Decision</option><option value="policy">Policy</option><option value="constraint">Constraint</option><option value="identity">Identity</option><option value="preference">Preference</option><option value="relationship">Relationship</option><option value="metric">Metric</option><option value="reference">Reference</option><option value="other">Other</option></select></div></div>
    <div class="field"><label for="context-path">Context path</label><input id="context-path" name="path" required maxlength="500" placeholder="/policies/deployment/review-gate"></div>
    <div class="field"><label for="context-title">Title</label><input id="context-title" name="title" required maxlength="240" placeholder="Deployment review gate"></div>
    <div class="field"><label for="context-link-project">Project scope</label><select id="context-link-project" name="project"><option value="">Company-wide</option></select><small>Project-scoped entries are returned only inside that Project grant.</small></div>
    <div class="field-pair"><div class="field"><label for="context-effective-from">Effective from</label><input id="context-effective-from" name="effectiveFrom" type="datetime-local"></div><div class="field"><label for="context-effective-to">Effective until</label><input id="context-effective-to" name="effectiveTo" type="datetime-local"></div></div>
    <div class="field" id="context-value-field"><label for="context-value">Fact value</label><textarea id="context-value" name="value" placeholder="One independently changeable claim"></textarea></div>
    <div class="field" id="context-body-field" hidden><label for="context-body">Markdown content</label><textarea id="context-body" name="body" class="large-textarea" placeholder="# Document title"></textarea></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="context-dialog">Cancel</button><button class="button primary" type="submit"><i class="ph ph-plus" aria-hidden="true"></i>Add entry</button></div>
  </form></dialog>

  <dialog id="context-lifecycle-dialog"><form class="modal" id="context-lifecycle-form"><div class="modal-cap"><span class="modal-label">Temporal memory revision</span><button type="button" class="icon-button" data-close="context-lifecycle-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Change memory state</h2><p>This writes a new revision. Prior content, evidence, and the decision remain in History.</p>
    <input type="hidden" id="context-lifecycle-id" name="entryId">
    <div class="field"><label for="context-lifecycle-state">Lifecycle state</label><select id="context-lifecycle-state" name="lifecycleState"><option value="needs_review">Needs review</option><option value="accepted">Accepted</option><option value="superseded">Superseded</option></select></div>
    <div class="field"><label for="context-lifecycle-reason">Reason</label><textarea id="context-lifecycle-reason" name="reason" required minlength="3" maxlength="2000" placeholder="Why should agents stop or resume treating this as current memory?"></textarea></div>
    <div class="field-pair"><div class="field"><label for="context-lifecycle-from">Effective from</label><input id="context-lifecycle-from" name="effectiveFrom" type="datetime-local"></div><div class="field"><label for="context-lifecycle-to">Effective until</label><input id="context-lifecycle-to" name="effectiveTo" type="datetime-local"></div></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="context-lifecycle-dialog">Cancel</button><button class="button primary" type="submit"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i>Write revision</button></div>
  </form></dialog>

  <dialog id="agent-dialog"><form class="modal" id="agent-form"><div class="modal-cap"><span class="modal-label">Personal agent profile</span><button type="button" class="icon-button" data-close="agent-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Create an agent</h2><p>Create one identity for this agent. Use it across multiple harnesses with the same MCP access and private notes.</p>
    <div class="field-pair"><div class="field"><label for="agent-member">Workspace member</label><select id="agent-member" name="memberId" required></select></div><div class="field"><label for="agent-name">Agent name</label><input id="agent-name" name="name" required maxlength="120" autocomplete="off" placeholder="Research scout"></div></div>
    <div class="field"><label for="agent-description">Purpose</label><textarea id="agent-description" name="description" maxlength="1000" placeholder="What this agent is responsible for"></textarea></div>
    <div class="field"><label for="agent-projects">Allowed projects</label><textarea id="agent-projects" name="projects" placeholder="One exact project name per line, or * for all work"></textarea><small>Use * to grant all current and future projects, including unassigned tasks. Leave empty for no task access. Source visibility is granted separately below.</small></div>
    <div class="field-pair"><div class="field"><label for="agent-context-paths">Allowed context paths</label><textarea id="agent-context-paths" name="contextPaths">/</textarea></div><div class="field"><label for="agent-source-visibilities">Allowed source visibility</label><textarea id="agent-source-visibilities" name="sourceVisibilities">company</textarea></div></div>
    <fieldset class="capability-field"><legend>Capability grants</legend><p>Company changes use proposals. Private notes remain with this agent.</p>
      <label><input type="checkbox" name="capability" value="work:read" checked><span><b>Read work</b><small>Search accepted tasks and proposal status.</small></span></label>
      <label><input type="checkbox" name="capability" value="work:propose" checked><span><b>Propose work</b><small>Suggest new tasks and task changes.</small></span></label>
      <label><input type="checkbox" name="capability" value="context:read" checked><span><b>Read context</b><small>Open the context tree, facts, and files.</small></span></label>
      <label><input type="checkbox" name="capability" value="source:read" checked><span><b>Read source material</b><small>Discover and open cited source documents or sections on demand.</small></span></label>
      <label><input type="checkbox" name="capability" value="context:propose" checked><span><b>Propose context</b><small>Suggest evidence-backed facts and files.</small></span></label>
      <label><input type="checkbox" name="capability" value="evidence:report" checked><span><b>Report evidence</b><small>Record privacy-filtered work receipts.</small></span></label>
      <label><input type="checkbox" name="capability" value="workspace:read" checked><span><b>Read own notes</b><small>Open this agent's persistent private files.</small></span></label>
      <label><input type="checkbox" name="capability" value="workspace:write" checked><span><b>Write own notes</b><small>Save versioned private files for this agent.</small></span></label>
    </fieldset>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="agent-dialog">Cancel</button><button class="button primary" type="submit"><i class="ph ph-plug" aria-hidden="true"></i>Create and connect</button></div>
  </form></dialog>

  <dialog id="agent-scope-dialog"><form class="modal" id="agent-scope-form"><div class="modal-cap"><span class="modal-label">Agent access</span><button type="button" class="icon-button" data-close="agent-scope-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Edit access</h2><p>Changes take effect on the agent's next MCP call. Its secret does not change.</p>
    <input type="hidden" name="agentId" id="agent-scope-id">
    <div class="field"><label for="agent-scope-projects">Allowed projects</label><textarea id="agent-scope-projects" name="projects" placeholder="One project per line, or * for all work"></textarea><small>* includes future projects and unassigned tasks.</small></div>
    <div class="field-pair"><div class="field"><label for="agent-scope-paths">Context paths</label><textarea id="agent-scope-paths" name="contextPaths"></textarea></div><div class="field"><label for="agent-scope-visibilities">Source visibility</label><textarea id="agent-scope-visibilities" name="sourceVisibilities"></textarea></div></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="agent-scope-dialog">Cancel</button><button class="button primary" type="submit">Save access</button></div>
  </form></dialog>

  <dialog id="setup-dialog" class="setup-dialog"><div class="modal setup-modal"><div class="modal-cap"><span class="modal-label">Harness setup</span><button type="button" class="icon-button" data-close="setup-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><div id="setup-content"></div><button class="button quiet" id="verify-agent-connection" type="button">Check connection</button><p class="settings-status" id="agent-connection-status" role="status"></p></div></dialog>

  <dialog id="task-detail-dialog" class="setup-dialog"><div class="modal setup-modal"><div class="modal-cap"><span class="modal-label">Accepted task</span><button type="button" class="icon-button" data-close="task-detail-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><div id="task-detail-content"></div></div></dialog>

  <dialog id="evidence-dialog" class="setup-dialog"><div class="modal setup-modal evidence-receipt-modal"><div class="modal-cap"><span class="modal-label">Source receipt</span><button type="button" class="icon-button" data-close="evidence-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><div class="evidence-detail" id="evidence-detail" aria-live="polite"><div class="evidence-detail-empty"><span class="empty-glyph"><i class="ph ph-warning-circle" aria-hidden="true"></i></span><h2>Receipt unavailable</h2><p>Close this window and try again.</p></div><div id="evidence-detail-body"></div></div></div></dialog>

  <dialog id="integration-dialog"><form class="modal" id="integration-form"><div class="modal-cap"><span class="modal-label">Source installation</span><button type="button" class="icon-button" data-close="integration-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Add an integration</h2><p>Only the named resources are eligible for capture. Provider credentials must be supplied through deployment secrets.</p>
    <div class="field-pair"><div class="field"><label for="integration-provider">Provider</label><select id="integration-provider" name="provider"><option value="notion">Notion</option><option value="slack">Slack</option><option value="github">GitHub</option></select></div><div class="field"><label for="integration-key">Installation key</label><input id="integration-key" name="installationKey" required maxlength="240" placeholder="workspace-or-org"></div></div>
    <div class="field"><label for="integration-name">Display name</label><input id="integration-name" name="displayName" required maxlength="240" placeholder="Product workspace"></div>
    <div class="field"><label for="integration-resources">Allowed resources</label><textarea id="integration-resources" name="resources" placeholder="One channel, repository, or Notion root per line"></textarea></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="integration-dialog">Cancel</button><button class="button primary" type="submit">Save integration</button></div>
  </form></dialog>

  <dialog id="github-dialog" class="setup-dialog"><form class="modal setup-modal" id="github-form"><div class="modal-cap"><span class="modal-label">GitHub App connection</span><button type="button" class="icon-button" data-close="github-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Choose an organization and repositories</h2><p>Panini will read only the repositories you select.</p><div id="github-connection-content"></div><div class="modal-actions"><button class="button quiet" type="button" data-close="github-dialog">Cancel</button><button class="button primary" type="submit">Connect selected repositories</button></div></form></dialog>

  <dialog id="device-dialog"><form class="modal" id="device-form"><div class="modal-cap"><span class="modal-label">Signed local relay</span><button type="button" class="icon-button" data-close="device-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Enroll a device</h2><p>Paste the relay's Ed25519 public key. The private key must remain in the device keychain.</p>
    <div class="field"><label for="device-profile">Agent profile</label><select id="device-profile" name="agentProfileId" required></select></div>
    <div class="field"><label for="device-name">Device name</label><input id="device-name" name="name" required maxlength="160" placeholder="Mira's MacBook"></div>
    <div class="field"><label for="device-public-key">Public key</label><textarea id="device-public-key" name="publicKey" required placeholder="-----BEGIN PUBLIC KEY-----"></textarea></div>
    <div class="field"><label for="device-privacy">Privacy mode</label><select id="device-privacy" name="privacyMode"><option value="metadata">Metadata only</option><option value="approved_excerpts">Approved excerpts</option></select></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="device-dialog">Cancel</button><button class="button primary" type="submit">Enroll device</button></div>
  </form></dialog>

  <dialog id="mapping-dialog"><form class="modal" id="mapping-form"><div class="modal-cap"><span class="modal-label">Repository context</span><button type="button" class="icon-button" data-close="mapping-dialog" aria-label="Close"><i class="ph ph-x" aria-hidden="true"></i></button></div><h2>Map a repository</h2><p>This mapping narrows which project and context paths a harness receives.</p>
    <div class="field-pair"><div class="field"><label for="mapping-repository">Repository</label><input id="mapping-repository" name="repository" required placeholder="owner/repository"></div><div class="field"><label for="mapping-project">Project</label><input id="mapping-project" name="project" required></div></div>
    <div class="field"><label for="mapping-paths">Approved context paths</label><textarea id="mapping-paths" name="contextPaths" placeholder="/projects/example\n/policies/deployment"></textarea></div>
    <div class="modal-actions"><button class="button quiet" type="button" data-close="mapping-dialog">Cancel</button><button class="button primary" type="submit">Save mapping</button></div>
  </form></dialog>

  <script nonce="${safeNonce}">${appScript}</script>
</body>
</html>`;
}
