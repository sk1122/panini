export const appScript = String.raw`
const state = {
  board: null,
  workGraph: null,
  company: null,
  people: null,
  history: null,
  context: null,
  sourceDocuments: [],
  sourceDocumentsAll: [],
  contextMode: 'accepted',
  workspaceContext: [],
  workspaceContextRequest: 0,
  agents: [],
  devices: [],
  mappings: [],
  workspace: null,
  proposalDetails: {},
  assessmentDetails: {},
  evidenceCoverage: null,
  evidenceBudget: null,
  projectProposals: [],
  health: null,
  selectedEntryId: null,
  selectedSourceDocumentId: null,
  selectedSourceSectionId: null,
  selectedEvidenceId: null,
  selectedProjectId: null,
  githubSelectionId: null,
  setup: null,
  csrf: '',
  account: null,
  sessionPromise: null,
  sessionResolve: null,
  sessionReject: null
};

const byId = (id) => document.getElementById(id);
const accountsEnabled = document.body.dataset.authMode === 'accounts';
const isAdmin = () => !accountsEnabled || ['owner', 'admin'].includes(state.account?.identity?.role);
const canReview = () => !accountsEnabled || ['owner', 'admin', 'reviewer'].includes(state.account?.identity?.role);
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const compact = (value, maximum = 160) => {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  return text.length > maximum ? text.slice(0, maximum - 1) + '…' : text;
};
const formatDate = (value, includeTime = true) => {
  if (!value) return 'Unknown';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return String(value);
  return includeTime
    ? date.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : date.toLocaleDateString([], { dateStyle: 'medium' });
};
const localDateTimeValue = (value) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
};

async function api(path, options = {}) {
  const headers = { ...(options.body === undefined ? {} : { 'content-type': 'application/json' }), ...(options.headers || {}) };
  const method = String(options.method || 'GET').toUpperCase();
  if (!['GET', 'HEAD'].includes(method) && !headers['idempotency-key']) headers['idempotency-key'] = crypto.randomUUID();
  if (state.csrf && !['GET', 'HEAD'].includes(method)) headers['x-panini-csrf'] = state.csrf;
  const requestOptions = { ...options, headers };
  const response = await fetch(path, requestOptions);
  if (response.status === 401) {
    if (accountsEnabled) { returnToLogin(); throw new Error('Your session ended. Please sign in again.'); }
    await establishSession();
    return api(path, requestOptions);
  }
  const body = await response.json().catch(() => ({ error: 'The server returned an unreadable response.' }));
  if (!response.ok) throw new Error(body.error || 'Request failed.');
  return body;
}

async function performSessionHandshake() {
  let response = await fetch('/api/session', { headers: { accept: 'application/json' } });
  if (response.status === 401) {
    if (accountsEnabled) { returnToLogin(); throw new Error('Please sign in.'); }
    byId('session-error').hidden = true;
    byId('session-token').value = '';
    byId('session-dialog').showModal();
    return new Promise((resolve, reject) => {
      state.sessionResolve = resolve;
      state.sessionReject = reject;
      queueMicrotask(() => byId('session-token').focus());
    });
  }
  const body = await response.json().catch(() => ({ error: 'The session response was unreadable.' }));
  if (!response.ok) throw new Error(body.error || 'Administrator sign-in failed.');
  state.csrf = body.csrf || '';
  if (accountsEnabled) { state.account = body; renderAccount(); }
}

function returnToLogin() {
  document.body.classList.add('session-expired');
  window.location.replace('/login?next=' + encodeURIComponent(window.location.pathname));
}

function renderAccount() {
  document.querySelectorAll('[data-account-only]').forEach((element) => { element.hidden = !accountsEnabled; });
  document.querySelectorAll('[data-admin-only]').forEach((element) => { element.hidden = !isAdmin(); });
  document.querySelectorAll('[data-owner-only]').forEach((element) => { element.hidden = state.account?.identity?.role !== 'owner'; });
  if (!state.account) return;
  const user = state.account.identity;
  const company = state.account.organization;
  byId('user-name').textContent = user.displayName;
  byId('user-role').textContent = user.role;
  byId('user-avatar').textContent = user.displayName.slice(0, 1).toUpperCase();
  byId('workspace-name').textContent = company.name;
  byId('workspace-avatar').textContent = company.name.slice(0, 1).toUpperCase();
  if (!byId('profile-name').dataset.dirty) byId('profile-name').value = user.displayName;
  byId('profile-email').value = user.email;
  if (!byId('settings-company-name').dataset.dirty) byId('settings-company-name').value = company.name;
  document.title = company.name + ' | Panini';
  const methods = state.account.authentication;
  byId('github-account-section').hidden = !methods?.githubEnabled && !methods?.github;
  byId('github-account-status').textContent = methods?.github ? 'Connected as ' + methods.github.login + '.' : 'GitHub is not connected to your personal account.';
  byId('connect-github-account').hidden = Boolean(methods?.github) || !methods?.githubEnabled;
  byId('disconnect-github-account').hidden = !methods?.github;
  byId('disconnect-github-account').disabled = !methods?.hasPassword;
  if (methods?.github && !methods.hasPassword) byId('github-account-status').textContent += ' Set a password before disconnecting GitHub.';
  byId('current-password').required = methods?.hasPassword !== false;
  byId('current-password').closest('.field').hidden = methods?.hasPassword === false;
}

function applyRoleControls() {
  renderAccount();
  for (const id of ['new-context', 'new-mapping', 'sync', 'connect-github', 'new-integration']) {
    byId(id).hidden = id === 'new-context' ? !canReview() : !isAdmin();
  }
  document.querySelectorAll('.task-card[draggable]').forEach((card) => { card.draggable = canReview(); });
  document.querySelectorAll('[data-edit-project], [data-project-edit], [data-task-undo], [data-context-lifecycle]').forEach((button) => { button.hidden = !canReview(); });
}

function establishSession() {
  if (state.sessionPromise) return state.sessionPromise;
  state.sessionPromise = performSessionHandshake().finally(() => { state.sessionPromise = null; });
  return state.sessionPromise;
}

function showError(error) {
  byId('alert-copy').textContent = error instanceof Error ? error.message : String(error);
  byId('alert').classList.add('show');
}

function clearError() {
  byId('alert').classList.remove('show');
}

function settingsStatus(id, message, error = false) {
  const element = byId(id);
  element.textContent = message;
  element.classList.toggle('is-error', error);
}

async function loadSettings() {
  if (!accountsEnabled || !state.account) return;
  renderAccount();
  if (!isAdmin()) return;
  const [accounts, invitations] = await Promise.all([api('/api/members'), api('/api/invitations')]);
  const owner = state.account.identity.role === 'owner';
  byId('settings-members').innerHTML = accounts.members.map((member) => {
    const canManage = owner || !['owner', 'admin'].includes(member.role);
    const options = (owner ? ['member', 'reviewer', 'admin', 'owner'] : ['member', 'reviewer']).map((role) =>
      '<option value="' + role + '"' + (member.role === role ? ' selected' : '') + '>' + role + '</option>').join('');
    return '<div class="settings-member" data-member-row="' + esc(member.id) + '"><div><strong>' + esc(member.displayName) + (member.id === state.account.identity.memberId ? ' (you)' : '') + '</strong><small>' + esc(member.email) + '</small><small>' + esc(member.role) + ' · ' + esc(member.status) + '</small></div>' +
      (canManage ? '<div class="member-controls"><select aria-label="Role for ' + esc(member.displayName) + '" data-member-role>' + options + '</select><select aria-label="Status for ' + esc(member.displayName) + '" data-member-status><option value="active"' + (member.status === 'active' ? ' selected' : '') + '>Active</option><option value="disabled"' + (member.status === 'disabled' ? ' selected' : '') + '>Disabled</option></select><button class="button quiet small" data-member-save="' + esc(member.id) + '">Save access</button>' +
      (member.status === 'active' ? '<button class="button quiet small" data-member-reset="' + esc(member.id) + '">Reset password</button>' : '') + '</div>' : '<span class="muted-copy">Managed by an owner</span>') + '</div>';
  }).join('');
  byId('settings-invitations').innerHTML = invitations.invitations.map((invite) => {
    const active = !invite.consumedAt && !invite.revokedAt && new Date(invite.expiresAt) > new Date();
    const label = invite.consumedAt ? 'Accepted' : invite.revokedAt ? 'Revoked' : active ? 'Pending' : 'Expired';
    return '<div class="settings-member"><div><strong>' + esc(invite.email) + '</strong><small>' + esc(invite.role) + ' · ' + label + ' · Expires ' + esc(formatDate(invite.expiresAt)) + '</small></div>' +
      (active && (owner || !['owner', 'admin'].includes(invite.role)) ? '<button class="button quiet small" data-invite-revoke="' + esc(invite.id) + '">Revoke</button>' : '') + '</div>';
  }).join('') || '<p class="muted-copy">No invitations yet.</p>';
}

async function loadOnboarding() {
  if (!accountsEnabled || !state.account) return;
  const status = await api('/api/onboarding');
  byId('onboarding-title').textContent = 'Welcome to ' + status.organization.name;
  const step = (index, title, description, done, action, target) => '<section class="onboarding-step"><span class="onboarding-number' + (done ? ' complete' : '') + '">' + (done ? '<i class="ph ph-check" aria-hidden="true"></i>' : index) + '</span><div><h2>' + esc(title) + '</h2><p>' + esc(description) + '</p><small>' + (done ? 'Complete' : 'Optional next step') + '</small></div><a class="button quiet" href="' + pathByView[target] + '" data-onboard-view="' + target + '">' + esc(action) + '</a></section>';
  byId('onboarding-steps').innerHTML =
    step(1, 'Your account and company', 'You are signed in as ' + state.account.identity.displayName + '.', status.profileComplete, 'View settings', 'settings') +
    (isAdmin() ? step(2, 'Invite your team', 'Share an invitation with each person who needs access. You choose their role.', status.teamInvited, 'Invite people', 'settings') +
    step(3, 'Connect company sources', status.sourceConnected ? 'A connected source has completed a successful sync.' : 'Choose the information Panini can read from your company tools.', status.sourceConnected, 'Connect sources', 'integrations') : '') +
    step(isAdmin() ? 4 : 2, 'Connect your agent', status.agentConnected ? 'Your agent has made an authenticated connection.' : status.agentCreated ? 'A profile is ready. Connect your client, then refresh to verify it.' : 'Create a personal profile, copy its secret, and connect your client.', status.agentConnected, status.agentCreated ? 'View agents' : 'Set up an agent', 'agents');
}

function bindSettingsForm(formId, statusId, action) {
  byId(formId).addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = event.currentTarget.querySelector('button[type="submit"]');
    button.disabled = true;
    settingsStatus(statusId, 'Saving…');
    try { await action(Object.fromEntries(new FormData(event.currentTarget))); }
    catch (error) { settingsStatus(statusId, error.message || 'Unable to save.', true); }
    finally { button.disabled = false; }
  });
}
for (const id of ['profile-name', 'settings-company-name']) {
  byId(id).addEventListener('input', () => { byId(id).dataset.dirty = 'true'; });
}
bindSettingsForm('profile-form', 'profile-status', async (body) => {
  const result = await api('/api/account', { method: 'PATCH', body: JSON.stringify(body) });
  state.account.identity = { ...state.account.identity, ...result.member };
  delete byId('profile-name').dataset.dirty;
  renderAccount(); settingsStatus('profile-status', 'Profile saved.');
});
bindSettingsForm('company-form', 'company-status', async (body) => {
  const result = await api('/api/workspace/settings', { method: 'PATCH', body: JSON.stringify(body) });
  state.account.organization = result.organization;
  delete byId('settings-company-name').dataset.dirty;
  renderAccount(); settingsStatus('company-status', 'Company saved.');
});
bindSettingsForm('password-form', 'password-status', async (body) => {
  const result = await api('/api/account/password', { method: 'POST', body: JSON.stringify(body) });
  state.account = result; state.csrf = result.csrf; byId('password-form').reset();
  renderAccount();
  settingsStatus('password-status', 'Password changed. Other sessions have been signed out.');
});
byId('connect-github-account').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { const result = await api('/api/account/github/start', { method: 'POST', body: '{}' }); window.location.assign(result.authorizationUrl); }
  catch (error) { showError(error); event.currentTarget.disabled = false; }
});
byId('disconnect-github-account').addEventListener('click', async () => {
  try { const result = await api('/api/account/github', { method: 'DELETE' }); state.account = result; state.csrf = result.csrf; renderAccount(); }
  catch (error) { showError(error); }
});
bindSettingsForm('invite-form', 'invite-status', async (body) => {
  const result = await api('/api/invitations', { method: 'POST', body: JSON.stringify(body) });
  byId('invite-link').value = result.url; byId('invite-result').hidden = false;
  settingsStatus('invite-status', 'Invitation created. Share the link privately.');
  await loadSettings();
});
document.querySelector('[data-copy-invite]').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(byId('invite-link').value); settingsStatus('invite-status', 'Link copied.'); }
  catch { byId('invite-link').select(); settingsStatus('invite-status', 'Select and copy the link.'); }
});
byId('settings-members').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-member-save], [data-member-reset]');
  if (!button) return;
  button.disabled = true;
  try {
    if (button.dataset.memberSave) {
      const row = button.closest('[data-member-row]');
      const body = { role: row.querySelector('[data-member-role]').value, status: row.querySelector('[data-member-status]').value };
      if (body.status === 'disabled' && !confirm('Disable this account? Its sessions and agent access will stop immediately.')) return;
      await api('/api/members/' + button.dataset.memberSave, { method: 'PATCH', body: JSON.stringify(body) });
      settingsStatus('members-status', 'Access updated. Existing sessions were signed out.');
      if (button.dataset.memberSave === state.account.identity.memberId) return returnToLogin();
      await loadSettings();
    } else {
      const result = await api('/api/members/' + button.dataset.memberReset + '/reset-password', { method: 'POST', body: '{}' });
      byId('recovery-link').value = result.url; byId('recovery-result').hidden = false;
      settingsStatus('members-status', 'Reset link created. Share it privately with this person.');
    }
  } catch (error) { settingsStatus('members-status', error.message, true); }
  finally { button.disabled = false; }
});
byId('settings-invitations').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-invite-revoke]');
  if (!button) return;
  button.disabled = true;
  try { await api('/api/invitations/' + button.dataset.inviteRevoke, { method: 'DELETE' }); await loadSettings(); }
  catch (error) { showError(error); }
  finally { button.disabled = false; }
});
byId('onboarding-steps').addEventListener('click', (event) => {
  const link = event.target.closest('[data-onboard-view]');
  if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault(); navigate(link.dataset.onboardView);
});
byId('finish-onboarding').addEventListener('click', async (event) => {
  event.currentTarget.disabled = true;
  try { state.account.onboarding = await api('/api/onboarding/complete', { method: 'POST', body: '{}' }); navigate('projects'); }
  catch (error) { showError(error); }
  finally { byId('finish-onboarding').disabled = false; }
});
byId('refresh-onboarding').addEventListener('click', () => void loadOnboarding().catch(showError));
const accountChannel = accountsEnabled && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('panini-account') : null;
if (accountChannel) accountChannel.onmessage = () => returnToLogin();
document.querySelectorAll('[data-sign-out]').forEach((button) => button.addEventListener('click', async () => {
  button.disabled = true;
  try { await api('/api/auth/logout', { method: 'POST', body: '{}' }); accountChannel?.postMessage('logout'); returnToLogin(); }
  catch (error) { showError(error); button.disabled = false; }
}));
window.addEventListener('focus', () => {
  if (!accountsEnabled || !state.account) return;
  fetch('/api/session').then((response) => { if (response.status === 401) returnToLogin(); }).catch(() => {});
});

const lanes = [
  ['queued', 'Queued'],
  ['active', 'In motion'],
  ['checkpoint', 'Checkpoint'],
  ['closed', 'Closed']
];
const statusForLane = { queued: 'planned', active: 'in_progress', checkpoint: 'review', closed: 'done' };
let draggedTaskId = null;
let boardDragEndedAt = 0;

function laneFor(status) {
  if (status === 'done' || status === 'cancelled') return 'closed';
  if (status === 'blocked' || status === 'review') return 'checkpoint';
  if (status === 'in_progress') return 'active';
  return 'queued';
}

function canonicalProjectName(task) {
  const projects = state.workGraph ? state.workGraph.projects : [];
  const linked = task.projectId ? projects.find((project) => project.id === task.projectId) : null;
  return linked ? linked.name : task.project;
}

function taskBelongsToProject(task, project) {
  if (task.projectId) return task.projectId === project.id;
  const label = (task.project || '').toLowerCase();
  return [project.name, ...(project.aliases || [])].some((name) => name.toLowerCase() === label);
}

function taskCard(task) {
  const pending = state.board.proposals.filter((proposal) => proposal.taskId === task.id);
  const overlay = pending.length
    ? '<div class="pending-overlay"><i class="ph ph-clock-countdown" aria-hidden="true"></i><span>Change under review. Current task remains unchanged.</span></div>'
    : '';
  const source = task.sourceUrl
    ? '<a class="source-link" href="' + esc(task.sourceUrl) + '" target="_blank" rel="noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Source</a>'
    : '<span class="count"><i class="ph ph-pencil-simple" aria-hidden="true"></i>Manual</span>';
  const metadata = [canonicalProjectName(task), task.owner ? 'Owner: ' + task.owner : null, task.dueDate ? 'Due ' + formatDate(task.dueDate, false) : null]
    .filter(Boolean)
    .map((value) => '<span>' + esc(value) + '</span>')
    .join('');
  return '<article class="task-card" data-task="' + esc(task.id) + '" draggable="true" aria-grabbed="false" tabindex="0">' +
    '<div class="task-cap"><span class="task-status">' + esc(task.status.replaceAll('_', ' ')) + '</span><span class="priority ' + esc(task.priority) + '" title="' + esc(task.priority) + ' priority"></span></div>' +
    '<h4>' + esc(task.title) + '</h4>' +
    overlay +
    '<div class="task-meta">' + (metadata || '<span>No owner or project</span>') + '</div>' +
    '<div class="task-footer">' + source + '<button class="icon-action" data-change="' + esc(task.id) + '" aria-label="Suggest a change"><i class="ph ph-pencil-simple" aria-hidden="true"></i></button></div>' +
    '</article>';
}

function renderBoard() {
  const root = byId('board');
  root.classList.remove('loading');
  byId('task-suggestions').innerHTML = '';
  root.innerHTML = lanes.map(([key, label]) => {
    const tasks = state.board.tasks.filter((task) => laneFor(task.status) === key);
    const cards = tasks.map(taskCard).join('') || '<div class="empty"><strong>Clear for now</strong><span>Accepted work will appear here.</span></div>';
    return '<section class="lane" data-lane="' + key + '"><div class="lane-head"><div><span class="lane-dot"></span><h3>' + label + '</h3></div><span class="count">' + tasks.length + '</span></div><div class="cards">' + cards + '</div></section>';
  }).join('');
}

function proposalCard(proposal) {
  const labels = {
    task_create: 'Create task',
    task_change: 'Change task',
    context_update: 'Legacy context file',
    context_file_upsert: 'Upsert context file',
    context_fact_upsert: 'Upsert atomic fact'
  };
  const detail = state.proposalDetails[proposal.id];
  const assessmentId = detail && detail.proposal && detail.proposal.assessmentId;
  const assessment = assessmentId ? state.assessmentDetails[assessmentId] : null;
  const title = proposal.changes.title || proposal.changes.contextTitle || labels[proposal.kind] || proposal.kind;
  const before = detail && detail.before ? detail.before : null;
  const changes = Object.entries(proposal.changes).map(([key, value]) =>
    '<div class="change"><dt>' + esc(key.replaceAll(/([A-Z])/g, ' $1')) + '</dt><dd>' +
      (before && Object.hasOwn(before, key) ? '<del>' + esc(compact(before[key])) + '</del><i class="ph ph-arrow-right" aria-hidden="true"></i>' : '') +
      '<ins>' + esc(compact(value)) + '</ins></dd></div>'
  ).join('');
  const stale = detail && detail.stale ? '<span class="health-state degraded">Stale base</span>' : '';
  const evidence = detail && detail.evidence.length
    ? '<div class="agent-grants">' + detail.evidence.map((item) => '<button class="button quiet small" data-proposal-evidence="' + esc(item.id) + '">' + esc(item.provider) + ': ' + esc(item.eventKind) + '</button>').join('') + '</div>'
    : '<p class="muted-copy">No source receipt attached. This may be an authorized manual change.</p>';
  const canApprove = !detail || detail.allowedActions.find((item) => item.action === 'approve' && item.allowed);
  const canRebase = detail && detail.allowedActions.find((item) => item.action === 'rebase' && item.allowed);
  const authorityCopy = proposal.state === 'escalated'
    ? (proposal.decisionNote || 'This proposal needs a person to resolve conflicting evidence.')
    : 'Review the cited source and current accepted state before deciding.';
  const authority = '<div class="authority-explanation"><i class="ph ph-seal-check" aria-hidden="true"></i><div><strong>Human review required</strong><p>' + esc(authorityCopy) + '</p></div></div>';
  const assessmentLabel = proposal.kind === 'context_fact_upsert' ? 'Reported context fact'
    : proposal.kind === 'context_file_upsert' ? 'Reported context document'
    : proposal.kind === 'task_create' ? 'Reported request'
    : proposal.changes.status === 'done' ? 'Reported completion' : 'Reported progress';
  const assessed = assessment ? '<div class="authority-explanation"><i class="ph ph-list-checks" aria-hidden="true"></i><div><strong>' + assessmentLabel + '</strong>' +
    '<p>Assessment: ' + esc(assessment.disposition.replaceAll('_', ' ')) + '. Reasons: ' + esc(assessment.reasonCodes.join(', ') || 'none recorded') + '.</p>' +
    '<p>Coverage gaps: ' + esc(assessment.body.coverage.gaps.join(', ') || 'none recorded') + '. Checked ' + esc(formatDate(assessment.body.coverage.checkedAt)) + '.</p>' +
    (assessment.body.criteria.length ? '<p>Criteria: ' + esc(assessment.body.criteria.map((item) => item.criterionId + ' ' + item.verdict).join(', ')) + '.</p>' : '') +
    '</div></div>' : '';
  const taskActions = proposal.kind === 'task_change'
    ? '<button class="button quiet" data-edit="' + esc(proposal.id) + '">Edit</button>' + (canRebase ? '<button class="button quiet" data-rebase="' + esc(proposal.id) + '">Rebase</button>' : '')
    : '';
  const actions = '<div class="proposal-actions"><button class="button danger" data-reject="' + esc(proposal.id) + '"><i class="ph ph-x" aria-hidden="true"></i>Reject</button><button class="button quiet" data-supersede="' + esc(proposal.id) + '">Supersede</button>' + taskActions + '<button class="button primary" data-approve="' + esc(proposal.id) + '"' + (canApprove ? '' : ' disabled title="Rebase before approval"') + '><i class="ph ph-check" aria-hidden="true"></i>Approve</button></div>';
  return '<article class="proposal-card">' +
    '<div class="proposal-cap"><div><span class="proposal-kind">' + esc(labels[proposal.kind] || proposal.kind) + '</span><h2>' + esc(title) + '</h2><p>' + esc(proposal.rationale) + ' Requested by ' + esc(proposal.requestedBy) + '.</p></div><div>' + stale + '<span class="count">' + esc(formatDate(proposal.createdAt, false)) + '</span></div></div>' +
    '<dl class="change-grid">' + changes + '</dl>' +
    evidence +
    assessed +
    authority +
    actions +
    '</article>';
}

function projectProposalCard(proposal) {
  const changes = Object.entries(proposal.changes).map(([key, value]) => '<div class="change"><dt>' + esc(key) + '</dt><dd><ins>' + esc(compact(value)) + '</ins></dd></div>').join('');
  const evidence = proposal.evidenceIds.map((id) => '<button class="button quiet small" data-project-evidence="' + esc(id) + '">Source ' + esc(id.slice(0, 8)) + '</button>').join('');
  return '<article class="proposal-card"><div class="proposal-cap"><div><span class="proposal-kind">' + (proposal.kind === 'project_create' ? 'Create project' : 'Change project') + '</span><h2>' + esc(proposal.changes.name || 'Project change') + '</h2><p>' + esc(proposal.rationale) + ' Requested by ' + esc(proposal.requestedBy) + '.</p></div><span class="count">' + esc(formatDate(proposal.createdAt, false)) + '</span></div>' +
    '<dl class="change-grid">' + changes + '</dl><div class="agent-grants">' + evidence + '</div>' +
    '<div class="authority-explanation"><i class="ph ph-seal-check" aria-hidden="true"></i><div><strong>Human review required</strong><p>Check the cited source before accepting this project revision.</p></div></div>' +
    '<div class="proposal-actions"><button class="button danger" data-project-reject="' + esc(proposal.id) + '">Reject</button><button class="button primary" data-project-approve="' + esc(proposal.id) + '">Approve</button></div></article>';
}

function renderProposals() {
  const proposals = state.board.proposals.filter((proposal) => proposal.requestedBy !== 'system:work-suggestion');
  const projectProposals = state.projectProposals.filter((proposal) => ['pending', 'escalated'].includes(proposal.state) && proposal.requestedBy !== 'system:work-suggestion');
  const count = proposals.length + projectProposals.length;
  byId('proposals').innerHTML = projectProposals.map(projectProposalCard).join('') + proposals.map(proposalCard).join('') || '<div class="empty"><strong>No proposals to review</strong><span>New source observations remain available as evidence.</span></div>';
  byId('review-nav').hidden = count === 0;
  byId('review-count').textContent = String(count);
  byId('proposal-metric').textContent = count + (count === 1 ? ' proposal' : ' proposals');
  const coverage = state.evidenceCoverage;
  const panel = byId('evidence-coverage');
  panel.hidden = !coverage;
  if (coverage) {
    const states = coverage.states;
    panel.innerHTML = '<h2>Evidence processing</h2><p>' + esc(coverage.activeObservations) +
      ' active observations · ' + esc(states.processed || 0) + ' processed · ' + esc(states.extracted) + ' extracted · ' +
      esc(states.no_claim) + ' no claim · ' + esc(states.duplicate) + ' duplicate</p>' +
      '<p>' + esc(states.unseen) + ' unseen · ' + esc(states.partial) + ' partial · ' +
      esc(states.unresolved) + ' unresolved · ' + esc(states.failed) + ' failed</p>' +
      (coverage.outputs ? '<p>' + esc(coverage.outputs.savedClaims) + ' saved claims · ' +
        esc(coverage.outputs.savedAssessments) + ' assessments · ' +
        esc(coverage.outputs.pendingAssessedProposals) + ' pending assessed proposals · ' +
        esc(coverage.outputs.acceptedAssessedTaskRevisions) + ' accepted assessed task revisions</p>' : '') +
      '<p>' + esc(coverage.retryBacklog) + ' eligible for retry' +
      (coverage.oldestRetryAt ? ' · oldest ' + esc(formatDate(coverage.oldestRetryAt)) : '') + '</p>' +
      (coverage.evidenceJobs ? '<p>Queue: ' + esc(coverage.evidenceJobs.pending) + ' pending · ' +
        esc(coverage.evidenceJobs.running) + ' running · ' +
        esc(coverage.evidenceJobs.failed) + ' failed' +
        (coverage.evidenceJobs.oldestPendingAt ? ' · oldest ' +
          esc(formatDate(coverage.evidenceJobs.oldestPendingAt)) : '') + '</p>' : '') +
      (state.evidenceBudget ? '<p>Model budget: ' + esc(state.evidenceBudget.state) +
        ' · ' + esc(state.evidenceBudget.spentCalls) + '/' + esc(state.evidenceBudget.maxCalls) +
        ' calls · $' + esc(state.evidenceBudget.spentUsd) + ' estimated' +
        (state.evidenceBudget.maxUsd === null ? ' · no USD cap' :
          ' / $' + esc(state.evidenceBudget.maxUsd) + ' cap') + '</p>' : '');
  }
}

function renderProjects() {
  const graph = state.workGraph;
  const projects = graph ? graph.projects : [];
  const tasks = graph ? graph.tasks : [];
  const taskProposals = state.board.proposals.filter((proposal) => ['pending', 'escalated'].includes(proposal.state) && proposal.requestedBy !== 'system:work-suggestion');
  const projectProposals = state.projectProposals.filter((proposal) => ['pending', 'escalated'].includes(proposal.state) && proposal.requestedBy !== 'system:work-suggestion');
  const decisions = [...projectProposals.map((proposal) => ({ ...proposal, proposalType: 'project' })), ...taskProposals.map((proposal) => ({ ...proposal, proposalType: 'task' }))];
  byId('project-suggestions').innerHTML = '';
  byId('project-metric').textContent = projects.length + (projects.length === 1 ? ' project' : ' projects');
  byId('project-count').textContent = String(projects.length);
  byId('accepted-task-metric').textContent = String(tasks.length);
  byId('decision-metric').textContent = String(decisions.length);
  byId('project-decision-count').textContent = String(decisions.length);

  if (!projects.some((project) => project.id === state.selectedProjectId)) state.selectedProjectId = projects[0]?.id || null;
  const selected = projects.find((project) => project.id === state.selectedProjectId);
  byId('projects-index').innerHTML = projects.map((project) => {
    const projectTasks = tasks.filter((task) => taskBelongsToProject(task, project));
    const active = projectTasks.filter((task) => ['in_progress', 'review'].includes(task.status)).length;
    const blocked = projectTasks.filter((task) => task.status === 'blocked').length;
    return '<button class="project-index-item' + (project.id === state.selectedProjectId ? ' active' : '') + '" data-project="' + esc(project.id) + '"><strong>' + esc(project.name) + '</strong><span>' + esc(project.outcome || 'No accepted outcome recorded.') + '</span><small>' + active + ' active / ' + blocked + ' blocked</small></button>';
  }).join('') || '<div class="empty"><strong>No projects yet</strong><span>Accepted projects will appear here.</span></div>';

  if (selected) {
    const projectTasks = tasks.filter((task) => taskBelongsToProject(task, selected));
    const taskRows = projectTasks.map((task) => '<button class="project-task" data-task="' + esc(task.id) + '"><span><strong>' + esc(task.title) + '</strong><small>' + esc(task.description || 'No description recorded.') + '</small></span><em>' + esc(task.owner || 'Unassigned') + '</em><b class="task-state ' + esc(task.status) + '">' + esc(task.status.replaceAll('_', ' ')) + '</b></button>').join('');
    byId('project-focus').innerHTML = '<header><span class="eyebrow">Accepted project</span><h2>' + esc(selected.name) + '</h2><p>' + esc(selected.outcome || 'No accepted outcome recorded.') + '</p></header>' +
      '<div class="project-facts"><span>' + esc(selected.owner || 'Owner not recorded') + '</span><span>' + projectTasks.length + (projectTasks.length === 1 ? ' task' : ' tasks') + '</span><span>Changed ' + esc(formatDate(selected.updatedAt)) + '</span><button class="button quiet small" data-edit-project="' + esc(selected.id) + '">Edit</button></div>' +
      '<section class="project-current"><h3>Current work</h3><div class="project-tasks">' + (taskRows || '<div class="empty"><span>No accepted tasks.</span></div>') + '</div></section>' +
      '<button class="project-history-link" data-go-view="history">Open project history <i class="ph ph-arrow-right" aria-hidden="true"></i></button>';
  } else {
    byId('project-focus').innerHTML = '<div class="empty project-empty"><strong>No accepted project selected</strong><span>Create a project or approve a project proposal to begin.</span></div>';
  }

  byId('project-decisions').innerHTML = decisions.slice(0, 4).map((proposal) => {
    const title = proposal.changes.name || proposal.changes.title || (proposal.proposalType === 'project' ? 'Project change' : 'Task change');
    return '<button class="project-decision" data-go-view="review"><strong>' + esc(title) + '</strong><span>' + esc(proposal.rationale || 'A proposed change is waiting for review.') + '</span><small>Requested by ' + esc(proposal.requestedBy) + '</small><em>Review <i class="ph ph-arrow-right" aria-hidden="true"></i></em></button>';
  }).join('') || '<div class="empty rail-empty"><strong>No decisions waiting</strong><span>Accepted work is unchanged.</span></div>';

  byId('project-history').innerHTML = state.history.items.slice(0, 3).map((item, index) => '<button class="project-history-item" data-history-subject="' + esc(item.subjectId) + '" data-history-type="' + esc(item.type) + '"><i class="ph ph-' + (index === 1 ? 'square' : 'circle') + '" aria-hidden="true"></i><span><strong>' + esc(item.title) + '</strong><small>' + esc(item.summary) + '</small><em>' + esc(formatDate(item.occurredAt)) + '</em></span></button>').join('') || '<div class="empty rail-empty"><span>No accepted changes yet.</span></div>';
}

function renderCompany() {
  const company = state.company;
  const health = company.memoryHealth;
  byId('company-count').textContent = String(company.outcomes.length);
  byId('company-freshness').textContent = 'Updated ' + formatDate(company.generatedAt);
  const notices = [];
  if (company.sourceCoverage.some(source => source.stale || source.scopes.some(scope => scope.stale))) notices.push('Some source checkpoints are stale; generated time is not source freshness.');
  if (health.coverageIncomplete) notices.push('Some sources are incomplete. This view may miss earlier work.');
  if (health.needsReview) notices.push(health.needsReview + ' knowledge ' + (health.needsReview === 1 ? 'entry needs' : 'entries need') + ' review.');
  byId('company-health').innerHTML = notices.length ? '<div class="company-health-note warning">' + esc(notices.join(' ')) + '</div>' : '';
  byId('company-outcomes').innerHTML = company.outcomes.map((project) => {
    const tasks = state.board.tasks.filter((task) => taskBelongsToProject(task, project));
    return '<button class="company-row" data-project-name="' + esc(project.name) + '"><i class="ph ph-tree-structure" aria-hidden="true"></i><span><strong>' + esc(project.name) + '</strong><small>' + esc(project.outcome || 'No project summary recorded') + '</small></span><em>' + tasks.length + ' tasks</em></button>';
  }).join('') || '<div class="empty"><strong>No projects yet</strong><span>Current projects will appear here.</span></div>';
  const blockers = company.blockers.map((task) => '<button class="company-row danger-row" data-task="' + esc(task.id) + '"><i class="ph ph-warning" aria-hidden="true"></i><span><strong>' + esc(task.title) + '</strong><small>' + esc(canonicalProjectName(task) || 'No Project') + '</small></span><em>blocked</em></button>').join('');
  byId('company-blockers').innerHTML = blockers || '<div class="empty"><strong>No blocked tasks</strong><span>Nothing is marked blocked in current work.</span></div>';
  const recent = state.history.items.slice(0, 5).map((item) => '<button class="company-row" data-history-subject="' + esc(item.subjectId) + '" data-history-type="' + esc(item.type) + '"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i><span><strong>' + esc(item.title) + '</strong><small>' + esc(item.summary) + '</small></span><em>' + esc(formatDate(item.occurredAt, false)) + '</em></button>').join('');
  byId('company-recent').innerHTML = recent || '<div class="empty"><strong>No recorded changes yet</strong><span>Updates to work and knowledge will appear here.</span></div>';
  byId('company-coverage').innerHTML = company.sourceCoverage.map((source) => {
    const unhealthy = source.status !== 'healthy' || source.stale || source.scopes.some((scope) => scope.status !== 'healthy' || scope.stale);
    const scopeDetails = source.scopes.length
      ? source.scopes.map((scope) => scope.resourceKey + ': ' + (scope.stale ? 'stale' : scope.status) + (scope.cursor?.coverage ? ' · ' + scope.cursor.coverage.replaceAll('_', ' ') : '') + (scope.cursor?.checks === 'not_granted' ? ' · checks not granted' : '') + (scope.lastError ? ' · ' + scope.lastError : '')).join(' / ')
      : 'No durable source checkpoint yet';
    return '<article class="coverage-card"><div><i class="ph ph-' + esc(providerIcons[source.provider] || 'database') + '" aria-hidden="true"></i><span><strong>' + esc(source.displayName) + '</strong><small>' + esc(source.provider + ' / ' + source.transport) + '</small></span></div><span class="health-state ' + esc(unhealthy ? 'degraded' : 'healthy') + '">' + esc(source.stale ? 'sync stale' : unhealthy ? 'coverage incomplete' : 'healthy') + '</span><dl><div><dt>Scopes</dt><dd>' + esc(source.scopes.length) + '</dd></div><div><dt>Last success</dt><dd>' + esc(source.lastSuccessAt ? formatDate(source.lastSuccessAt) : 'Not synced') + '</dd></div></dl>' +
      '<p class="connector-checkpoint">' + esc(scopeDetails) + '</p></article>';
  }).join('') || '<div class="empty agent-empty"><strong>No source coverage configured</strong><span>Panini cannot claim complete company history until authorized sources are connected.</span></div>';
}

function renderPeople() {
  const people = state.people.people;
  byId('people-count').textContent = String(people.length);
  byId('people-metric').textContent = people.length + (people.length === 1 ? ' person' : ' people');
  byId('people').innerHTML = people.map((person) => {
    const identityRows = person.identities.map((identity) => '<span>' + esc(identity.provider) + ': ' + esc(identity.displayName || 'Unnamed identity') + '</span>').join('');
    const workRows = person.currentWork.map((task) => '<button data-task="' + esc(task.id) + '"><span>' + esc(task.title) + '</span><small>' + esc(task.status.replaceAll('_', ' ')) + '</small></button>').join('');
    const historical = person.historicalTaskIds.map((id) => state.board.tasks.find((task) => task.id === id)).filter((task) => task && !person.currentWork.some((current) => current.id === task.id));
    const historicalRows = historical.map((task) => '<button data-task="' + esc(task.id) + '"><span>' + esc(task.title) + '</span><small>' + esc(task.status.replaceAll('_', ' ')) + '</small></button>').join('');
    return '<article class="person-card"><header><span class="person-avatar">' + esc(person.member.displayName.slice(0, 1).toUpperCase()) + '</span><div><h2>' + esc(person.member.displayName) + '</h2><p>' + esc(person.member.role) + '</p></div></header><div class="person-section"><small>Current work</small><div class="person-work">' + (workRows || '<span class="muted-copy">No current tasks recorded.</span>') + '</div></div>' + (historicalRows ? '<div class="person-section"><small>Earlier work</small><div class="person-work">' + historicalRows + '</div></div>' : '') + '<details><summary>Linked accounts and agents</summary><div class="agent-grants">' + (identityRows || '<span>No linked account names</span>') + '</div><div class="agent-grants">' + person.agents.map((agent) => '<span>' + esc(agent.name) + '</span>').join('') + '</div></details></article>';
  }).join('') || '<div class="empty agent-empty"><strong>No workspace members</strong><span>Reconciled source identities will appear here.</span></div>';
}

function historyMarkup(items) {
  return items.map((item) => {
    const kind = item.type === 'context_revision' ? 'Context' : 'Task';
    const changes = (item.changes || []).filter((change) => change.label !== 'Document').map((change) => '<li><b>' + esc(change.label) + '</b> ' + esc(changeValue(change.before, change.label)) + ' → ' + esc(changeValue(change.after, change.label)) + '</li>').join('');
    const documentChanged = (item.changes || []).some((change) => change.label === 'Document');
    const open = item.type === 'context_revision'
      ? '<button class="button quiet small" data-history-entry="' + esc(item.subjectId) + '">Open knowledge</button>'
      : '<button class="button quiet small" data-history-task="' + esc(item.subjectId) + '">Open task</button>';
    return '<article class="history-item"><time>' + esc(formatDate(item.occurredAt)) + '</time><i class="ph ph-' + (kind === 'Context' ? 'books' : 'check-square-offset') + '" aria-hidden="true"></i><div><div><span class="history-type">' + kind + '</span><span class="memory-state ' + esc(item.state) + '">' + esc(item.state.replaceAll('_', ' ')) + '</span></div><h2>' + esc(item.title) + '</h2><p>' + esc(item.summary) + '</p>' + (changes ? '<ul class="change-summary">' + changes + '</ul>' : '') + (documentChanged ? '<p>Document text changed. Open it to read the earlier version.</p>' : '') + (item.reason ? '<p class="recorded-note">Recorded note: ' + esc(item.reason) + '</p>' : '') + '<small>Recorded ' + esc(formatDate(item.occurredAt)) + ' · ' + esc(recordedBy(item.actor)) + '</small>' + open + '</div></article>';
  }).join('');
}

function renderHistory() {
  const filter = byId('history-filter').value;
  const items = state.history.items.filter((item) => !filter || item.type === filter);
  byId('history-count').textContent = String(state.history.items.length);
  byId('history-metric').textContent = items.length + (items.length === 1 ? ' change' : ' changes');
  byId('history').innerHTML = historyMarkup(items) || '<div class="empty agent-empty"><strong>No changes yet</strong><span>Updates to tasks and context will appear here.</span></div>';
}

function renderTimeline() {
  const filter = byId('timeline-filter').value;
  const matching = state.history.items.filter((item) => !filter || item.type === filter);
  const visible = matching.slice(0, 20);
  byId('timeline-metric').textContent = matching.length > visible.length
    ? visible.length + ' of ' + matching.length + ' changes'
    : matching.length + (matching.length === 1 ? ' change' : ' changes');
  byId('timeline').innerHTML = historyMarkup(visible) || '<div class="empty agent-empty"><strong>No changes yet</strong><span>Accepted task and context revisions will appear here.</span></div>';
}

function dependencyName(reference) {
  const task = state.board.tasks.find((item) => item.id === reference || item.externalRef === reference);
  return task ? task.title : 'Task not found';
}

function changeValue(value, label) {
  if (value === null || value === undefined || value === '') return 'None recorded';
  if (label === 'Effective from' || label === 'Effective until' || label === 'Due date') return formatDate(value);
  if (label === 'Dependencies' && Array.isArray(value)) return value.length ? compact(value.map(dependencyName).join(', '), 140) : 'None';
  if (Array.isArray(value)) return compact(value.join(', '), 140);
  return compact(typeof value === 'object' ? JSON.stringify(value) : String(value).replaceAll('_', ' '), 140);
}

function recordedBy(actor) {
  if (actor.startsWith('member:')) {
    const member = state.people.people.find((person) => person.member.id === actor.slice(7));
    return member ? member.member.displayName : 'Workspace member';
  }
  if (actor.startsWith('adjudicator:')) return 'Recorded by Panini';
  if (actor.startsWith('connector:')) return 'Imported from a source';
  return actor;
}

function renderContextFilters() {
  const selectedProject = byId('context-project-filter').value;
  const selectedTask = byId('context-task-filter').value;
  const projects = state.workGraph ? state.workGraph.projects : [];
  byId('context-project-filter').innerHTML = '<option value="">All projects</option>' + projects.map((project) => '<option value="' + esc(project.name) + '">' + esc(project.name) + '</option>').join('');
  byId('context-project-filter').value = projects.some((project) => project.name === selectedProject) ? selectedProject : '';
  const tasks = state.board.tasks.filter((task) => !byId('context-project-filter').value || canonicalProjectName(task) === byId('context-project-filter').value);
  byId('context-task-filter').innerHTML = '<option value="">All tasks</option>' + tasks.map((task) => '<option value="' + esc(task.id) + '">' + esc(task.title) + '</option>').join('');
  byId('context-task-filter').value = tasks.some((task) => task.id === selectedTask) ? selectedTask : '';
  const contextProject = byId('context-link-project').value;
  byId('context-link-project').innerHTML = '<option value="">Company-wide</option>' + projects.map((project) => '<option value="' + esc(project.name) + '">' + esc(project.name) + '</option>').join('');
  byId('context-link-project').value = projects.some((project) => project.name === contextProject) ? contextProject : '';
}

function filteredNodes(nodes, query) {
  if (!query) return nodes;
  return nodes.flatMap((node) => {
    const children = filteredNodes(node.children || [], query);
    const matches = (node.name + ' ' + node.path).toLowerCase().includes(query);
    return matches || children.length ? [{ ...node, children }] : [];
  });
}

function treeMarkup(nodes) {
  return nodes.map((node) => {
    const folder = node.kind === 'folder';
    const glyph = folder ? 'caret-down' : node.kind === 'fact' ? 'diamond' : 'file-text';
    const action = folder ? ' data-folder="' + esc(node.path) + '"' : ' data-entry="' + esc(node.entryId) + '"';
    const active = node.entryId && node.entryId === state.selectedEntryId ? ' active' : '';
    const row = '<button class="tree-row' + active + '" data-kind="' + esc(node.kind) + '"' + action + '><i class="ph ph-' + glyph + ' tree-glyph" aria-hidden="true"></i><strong>' + esc(node.name) + '</strong><small class="' + esc(folder ? '' : 'memory-state ' + node.lifecycleState) + '">' + (folder ? String(node.children.length) : esc(node.lifecycleState.replaceAll('_', ' '))) + '</small></button>';
    return '<div class="tree-node">' + row + (folder ? '<div class="tree-children">' + treeMarkup(node.children) + '</div>' : '') + '</div>';
  }).join('');
}

async function loadWorkspaceContext() {
  const profiles = state.agents.filter(profile => profile.status === 'active' && profile.memberId && (!accountsEnabled || profile.memberId === state.account?.identity?.memberId));
  const members = new Set();
  const requests = [];
  for (const profile of profiles) {
    const scopes = members.has(profile.memberId) ? ['agent'] : ['agent', 'user'];
    members.add(profile.memberId);
    for (const scope of scopes) requests.push({ profile, scope });
  }
  state.workspaceContext = await Promise.all(requests.map(async ({ profile, scope }) => {
    const member = state.account?.identity?.memberId === profile.memberId
      ? state.account.identity : state.people?.people?.find(person => person.member.id === profile.memberId)?.member;
    const ownerName = member?.displayName?.trim().split(/\s+/)[0] || 'User';
    const metadata = { agentId: profile.id, memberId: profile.memberId, ownerName, scope, name: scope === 'user' ? 'Shared notes' : profile.name };
    try {
      const result = await api('/api/agents/' + encodeURIComponent(profile.id) + '/files?scope=' + scope);
      return { ...result, ...metadata };
    } catch (error) {
      return { ...metadata, files: [], error: 'Could not load workspace files.' };
    }
  }));
  renderContextTree();
}

function workspaceContextMarkup(query) {
  const folder = (path, name, children) => '<div class="tree-node"><button class="tree-row" data-kind="folder" data-folder="' + esc(path) + '"><i class="ph ph-caret-down tree-glyph" aria-hidden="true"></i><strong>' + esc(name) + '</strong></button><div class="tree-children">' + children + '</div></div>';
  const owners = new Map();
  for (const workspace of state.workspaceContext) {
    const files = workspace.files.filter(file => !query || (file.uri + ' ' + workspace.ownerName + ' ' + workspace.name).toLowerCase().includes(query));
    if (query && !files.length) continue;
    const root = { folders: new Map(), files: [] };
    for (const file of files) {
      const parts = file.path.split('/');
      let node = root;
      for (const name of parts.slice(0, -1)) {
        if (!node.folders.has(name)) node.folders.set(name, { folders: new Map(), files: [] });
        node = node.folders.get(name);
      }
      node.files.push({ ...file, name: parts.at(-1) });
    }
    const render = (node, path) => [...node.folders.entries()].map(([name, child]) => folder(path + name + '/', name, render(child, path + name + '/'))).join('') +
      node.files.map(file => '<button class="tree-row" data-kind="file" data-personal-file="' + esc(file.uri) + '"><i class="ph ph-file-text tree-glyph" aria-hidden="true"></i><strong>' + esc(file.name) + '</strong><small>v' + esc(file.version) + '</small></button>').join('');
    const content = workspace.error ? '<p class="muted-copy">' + esc(workspace.error) + '</p>' : render(root, workspace.rootUri) || '<p class="muted-copy">No files yet.</p>';
    if (!owners.has(workspace.memberId)) owners.set(workspace.memberId, { name: workspace.ownerName, children: '' });
    owners.get(workspace.memberId).children += folder(workspace.rootUri || workspace.agentId + '/' + workspace.scope, workspace.name, content);
  }
  return [...owners.entries()].map(([memberId, owner]) => folder('panini://' + memberId + '/', owner.name, owner.children)).join('');
}

async function openWorkspaceContext(uri) {
  const workspace = state.workspaceContext.find(item => item.files.some(file => file.uri === uri));
  if (!workspace) return;
  const request = ++state.workspaceContextRequest;
  state.selectedEntryId = null;
  state.selectedSourceDocumentId = null;
  byId('context-preview').textContent = 'Loading workspace file…';
  try {
    const response = await api('/api/agents/' + encodeURIComponent(workspace.agentId) + '/files?scope=' + workspace.scope + '&uri=' + encodeURIComponent(uri));
    if (request !== state.workspaceContextRequest || state.contextMode !== 'accepted') return;
    const file = workspace.files.find(item => item.uri === uri);
    const breadcrumb = [workspace.ownerName, workspace.name, ...file.path.split('/')].join(' / ');
    byId('context-preview').innerHTML = '<div class="preview-cap"><div><span class="context-path">' + esc(breadcrumb) + '</span><h2>' + esc(file.path.split('/').at(-1)) + '</h2><p>' + esc(workspace.name) + ' · Version ' + esc(response.file.version) + '</p></div><span class="kind-pill">Personal working notes</span></div><p class="muted-copy">Not accepted company knowledge.</p><pre class="workspace-file-content">' + esc(response.file.content) + '</pre>';
  } catch (error) {
    if (request !== state.workspaceContextRequest || state.contextMode !== 'accepted') return;
    byId('context-preview').textContent = 'Could not open workspace file.';
    showError(error);
  }
}

function renderContextTree() {
  const query = byId('context-search').value.trim().toLowerCase();
  if (state.contextMode === 'sources') {
    const documents = state.sourceDocuments.filter((document) => {
      if (!query) return true;
      const sectionText = document.sections.map((section) => section.headingPath.join(' ') + ' ' + section.excerpt).join(' ');
      return (document.title + ' ' + document.suggestedPath + ' ' + document.sourceRef + ' ' + sectionText).toLowerCase().includes(query);
    });
    const providers = new Map();
    documents.forEach((document) => providers.set(document.provider, [...(providers.get(document.provider) || []), document]));
    byId('context-tree').innerHTML = [...providers.entries()].map(([provider, items]) =>
      '<div class="source-group"><div class="source-group-title"><i class="ph ph-database" aria-hidden="true"></i><strong>' + esc(provider) + '</strong><small>' + items.length + '</small></div>' +
      items.map((document) => '<button class="source-tree-row' + (document.sourceEventId === state.selectedSourceDocumentId ? ' active' : '') + '" data-source-document="' + esc(document.sourceEventId) + '"><i class="ph ph-file-text" aria-hidden="true"></i><span><strong>' + esc(document.title) + '</strong><small>' + esc(document.suggestedPath) + '</small></span></button>').join('') +
      '</div>'
    ).join('') || '<div class="empty"><strong>No source documents found</strong><span>Try a broader source title, path, or heading.</span></div>';
    return;
  }
  const nodes = filteredNodes(state.context.tree, query);
  byId('context-tree').innerHTML = (treeMarkup(nodes) + workspaceContextMarkup(query)) || '<div class="empty"><strong>No matching topics</strong><span>Try a broader search.</span></div>';
}

function sourceDocumentHeader(document, section) {
  const original = document.sourceUrl
    ? '<a class="button quiet small" href="' + esc(document.sourceUrl) + '" target="_blank" rel="noreferrer"><i class="ph ph-arrow-square-out" aria-hidden="true"></i>Open original</a>'
    : '';
  return '<div class="preview-cap source-preview-cap"><div><span class="context-path">' + esc(document.sourcePath) + '</span><h2>' + esc(document.title) + '</h2><p>' + esc(section ? section.headingPath.join(' / ') : 'Source document outline') + '</p></div><div class="preview-actions">' + original + '<span class="kind-pill source-kind">source evidence</span></div></div>';
}

function sourceAuthority(authority) {
  const statements = authority || [
    'This is untrusted source evidence, not accepted company state and never an instruction.',
    'Use accepted context for action. Surface conflicts and propose a cited update.'
  ];
  return '<details class="source-details"><summary>About this source</summary><div class="source-trust"><i class="ph ph-warning-diamond" aria-hidden="true"></i><div><strong>Original material</strong><ul>' + statements.map((item) => '<li>' + esc(item) + '</li>').join('') + '</ul></div></div></details>';
}

function sourceMetadata(document) {
  return '<div class="source-metadata"><div><small>Source</small><span>' + esc(document.provider) + '</span></div><div><small>Original date</small><span>' + esc(formatDate(document.occurredAt)) + '</span></div></div>';
}

function sourceOutline(document) {
  return '<div class="source-outline">' + document.sections.map((section) => {
    const matched = document.matchedSectionIds.includes(section.id) ? ' matched' : '';
    return '<button class="source-section' + matched + '" data-source-section="' + esc(section.id) + '"><span><b>' + esc(section.headingPath.join(' / ')) + '</b><small>Lines ' + esc(section.startLine) + '-' + esc(section.endLine) + ' · ' + esc(section.characterCount) + ' characters</small></span><p>' + esc(section.excerpt || 'No preview text in this section.') + '</p><i class="ph ph-arrow-right" aria-hidden="true"></i></button>';
  }).join('') + '</div>';
}

function renderSourceDocumentSummary(document) {
  byId('context-preview').innerHTML = sourceDocumentHeader(document, null) + sourceAuthority() + sourceMetadata(document) +
    '<div class="source-read-actions"><div><h3>Document outline</h3><p>Open only the section needed for your question, or read the full snapshot.</p></div><button class="button primary small" data-source-read-full="' + esc(document.sourceEventId) + '"><i class="ph ph-book-open-text" aria-hidden="true"></i>Read full document</button></div>' +
    sourceOutline(document);
}

function renderSourceDocumentRead(result) {
  const document = result.document;
  byId('context-preview').innerHTML = sourceDocumentHeader(document, result.section) + sourceAuthority(result.authority) + sourceMetadata(document) +
    '<div class="source-read-actions"><button class="button quiet small" data-source-outline="' + esc(document.sourceEventId) + '"><i class="ph ph-list" aria-hidden="true"></i>Back to outline</button>' +
    (result.truncated ? '<span class="health-state degraded">Read truncated</span>' : '<span class="health-state">Pinned snapshot</span>') + '</div>' +
    '<div class="markdown-body source-markdown">' + (markdown(result.markdown) || '<p>This source section is empty.</p>') + '</div>';
}

function openSourceDocument(sourceEventId) {
  const document = state.sourceDocuments.find((item) => item.sourceEventId === sourceEventId);
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
  byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Opening source snapshot</h2><p>Rechecking access and loading the pinned version.</p></div>';
  try {
    const suffix = sectionId ? '?sectionId=' + encodeURIComponent(sectionId) : '';
    const result = await api('/api/source-documents/' + encodeURIComponent(sourceEventId) + suffix);
    if (state.selectedSourceDocumentId === sourceEventId && state.selectedSourceSectionId === (sectionId || null)) renderSourceDocumentRead(result);
  } catch (error) { showError(error); }
}

function markdown(value) {
  let inCode = false;
  const rendered = [];
  for (const rawLine of String(value || '').split('\n')) {
    const line = esc(rawLine);
    if (rawLine.startsWith(String.fromCharCode(96).repeat(3))) {
      rendered.push(inCode ? '</code></pre>' : '<pre><code>');
      inCode = !inCode;
    } else if (inCode) {
      rendered.push(line + '\n');
    } else if (/^### /.test(rawLine)) {
      rendered.push('<h4>' + line.slice(4) + '</h4>');
    } else if (/^## /.test(rawLine)) {
      rendered.push('<h3>' + line.slice(3) + '</h3>');
    } else if (/^# /.test(rawLine)) {
      rendered.push('<h2>' + line.slice(2) + '</h2>');
    } else if (/^> /.test(rawLine)) {
      rendered.push('<blockquote>' + line.slice(2) + '</blockquote>');
    } else if (/^[-*] /.test(rawLine)) {
      rendered.push('<p>• ' + line.slice(2) + '</p>');
    } else if (line.trim()) {
      rendered.push('<p>' + line + '</p>');
    }
  }
  if (inCode) rendered.push('</code></pre>');
  return rendered.join('');
}

function lineageMarkup(entry) {
  const source = entry.sourceUrl
    ? '<a href="' + esc(entry.sourceUrl) + '" target="_blank" rel="noreferrer">Open original source</a>'
    : '<span>No source URL</span>';
  return '<details class="source-details"><summary>Source and dates</summary><div class="lineage"><div><small>Source reference</small><span title="' + esc(entry.sourceRef) + '">' + esc(entry.sourceRef) + '</span></div><div><small>Recorded</small><span>' + esc(formatDate(entry.updatedAt)) + '</span></div><div><small>Effective from</small><span>' + esc(formatDate(entry.effectiveFrom)) + (entry.effectiveTo ? ' to ' + esc(formatDate(entry.effectiveTo)) : '') + '</span></div><div><small>Original</small>' + source + '</div></div></details>';
}

function renderContextPreview(detail) {
  const entry = detail.entry || detail;
  const revisions = detail.revisions || [];
  const evidence = detail.evidence || [];
  const kind = entry.kind === 'fact' ? 'Statement' : 'Document';
  const content = entry.kind === 'fact'
    ? '<div class="fact-value">' + esc(entry.value) + '</div>'
    : '<div class="markdown-body">' + (markdown(entry.body) || '<p>This file is empty.</p>') + '</div>';
  const revisionRows = revisions.slice().reverse().map((revision) => {
    const old = revision.previous;
    const now = revision.current;
    const details = [];
    if (!old) details.push('First recorded');
    else {
      if (old.kind === 'fact' && now.kind === 'fact' && JSON.stringify(old.value) !== JSON.stringify(now.value)) details.push('Statement: ' + changeValue(old.value) + ' → ' + changeValue(now.value));
      if (old.kind === 'file' && now.kind === 'file' && old.body !== now.body) details.push('Document text updated');
      if (old.lifecycleState !== now.lifecycleState) details.push('Review state: ' + changeValue(old.lifecycleState) + ' → ' + changeValue(now.lifecycleState));
      if (old.effectiveFrom !== now.effectiveFrom || old.effectiveTo !== now.effectiveTo) details.push('Effective dates changed');
      if (!details.length) details.push('Source or links updated');
    }
    const earlier = old && old.kind === 'file' && now.kind === 'file' && old.body !== now.body
      ? '<details><summary>Read earlier version</summary><div class="markdown-body">' + markdown(old.body) + '</div></details>' : '';
    const reason = detail.reasons && detail.reasons[revision.proposalId];
    return '<div class="knowledge-change"><time>' + esc(formatDate(revision.appliedAt)) + '</time><strong>' + esc(details.join(' · ')) + '</strong><small>Recorded by ' + esc(recordedBy(revision.appliedBy)) + '</small>' + (reason ? '<p>Recorded note: ' + esc(reason) + '</p>' : '') + earlier + '</div>';
  }).join('');
  const evidenceRows = evidence.map((item) => '<div class="activity-row"><strong>' + esc(item.provider + ' · ' + item.eventKind) + '</strong><span>' + esc(item.sourceRef) + '</span><time>' + esc(formatDate(item.occurredAt)) + '</time></div>').join('');
  const citedSources = evidence.filter((item) => item.eventKind === 'source.document.retrieved').map((item) => '<button class="cited-source" data-source-document="' + esc(item.id) + '"><i class="ph ph-archive" aria-hidden="true"></i><span><b>' + esc(item.provider) + ' source</b><small>' + esc(item.sourceRef) + '</small></span><i class="ph ph-arrow-right" aria-hidden="true"></i></button>').join('');
  const nextState = entry.lifecycleState === 'accepted' ? 'needs_review' : 'accepted';
  const stateAction = canReview() ? '<button class="button ' + (nextState === 'needs_review' ? 'danger' : 'primary') + ' small" data-context-lifecycle="' + esc(entry.id) + '" data-lifecycle-state="' + esc(nextState) + '"><i class="ph ph-clock-counter-clockwise" aria-hidden="true"></i>' + (nextState === 'needs_review' ? 'Mark needs review' : 'Accept after review') + '</button>' : '';
  const links = entry.links.length ? '<div class="agent-grants">' + entry.links.map((link) => '<span>' + esc(link.type + ': ' + link.targetRef) + '</span>').join('') + '</div>' : '<p class="muted-copy">Company-wide context with no narrower work association.</p>';
  byId('context-preview').innerHTML = '<div class="preview-cap"><div><span class="context-path">' + esc(entry.path) + '</span><h2>' + esc(entry.title) + '</h2><div class="preview-state"><span class="memory-state ' + esc(entry.lifecycleState) + '">' + esc(entry.lifecycleState.replaceAll('_', ' ')) + '</span>' + stateAction + '</div></div><span class="kind-pill">' + esc(kind) + '</span></div>' + content +
    '<div class="section-head compact-head"><div><h2>How this changed</h2></div></div><div class="knowledge-history">' + (revisionRows || '<div class="empty"><span>No earlier versions recorded.</span></div>') + '</div>' +
    '<details class="source-details"><summary>Related work and sources</summary>' + links + (citedSources ? '<div class="cited-sources">' + citedSources + '</div>' : '') + '<div class="activity-list">' + evidenceRows + '</div></details>' + lineageMarkup(entry);
}

async function openContextEntry(entryId) {
  state.workspaceContextRequest++;
  state.selectedEntryId = entryId;
  renderContextTree();
  byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Opening entry</h2><p>Loading accepted content and lineage.</p></div>';
  try {
    const response = await api('/api/context/entries/' + encodeURIComponent(entryId));
    if (state.selectedEntryId === entryId) renderContextPreview(response);
  } catch (error) {
    showError(error);
  }
}

function renderContext() {
  const counts = state.context.counts;
  const total = counts.facts + counts.files;
  byId('context-count').textContent = String(total);
  byId('tree-total').textContent = state.contextMode === 'sources'
    ? state.sourceDocuments.length + (state.sourceDocuments.length === 1 ? ' document' : ' documents')
    : total + (total === 1 ? ' entry' : ' entries') + ' · ' + state.workspaceContext.reduce((count, workspace) => count + workspace.files.length, 0) + ' personal files';
  renderContextTree();
}

function setContextMode(mode) {
  state.workspaceContextRequest++;
  const changed = state.contextMode !== mode;
  state.contextMode = mode;
  if (changed) {
    byId('context-search').value = '';
    state.sourceDocuments = state.sourceDocumentsAll;
  }
  document.querySelectorAll('[data-context-mode]').forEach((button) => {
    const active = button.dataset.contextMode === mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  const accepted = mode === 'accepted';
  byId('context-project-filter').hidden = !accepted;
  byId('context-task-filter').hidden = !accepted;
  byId('new-context').hidden = !accepted;
  byId('tree-label').textContent = accepted ? 'Topics' : 'Sources';
  byId('context-library-title').textContent = accepted ? 'Browse knowledge' : 'Browse original sources';
  byId('context-library-copy').textContent = accepted
    ? 'Find what the company knows and see how it changed.'
    : 'Read the original documents behind company knowledge.';
  byId('context-search').placeholder = accepted ? 'Search company knowledge' : 'Search source titles and headings';
  byId('context-search').setAttribute('aria-label', accepted ? 'Search company knowledge' : 'Search original sources');
  if (accepted) {
    if (state.selectedEntryId) void openContextEntry(state.selectedEntryId);
    else byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-books" aria-hidden="true"></i></span><h2>Choose a topic</h2><p>Read its current content and how it changed.</p></div>';
  } else {
    if (state.selectedSourceDocumentId) openSourceDocument(state.selectedSourceDocumentId);
    else byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-archive" aria-hidden="true"></i></span><h2>Choose a source document</h2><p>Read the document behind this topic.</p></div>';
  }
  renderContext();
}

function renderEvidenceDetail(detail) {
  const event = detail.event;
  const payload = JSON.stringify(event.payload, null, 2);
  const data = event.payload && typeof event.payload === 'object' && !Array.isArray(event.payload) ? event.payload : {};
  const document = data.document && typeof data.document === 'object' ? data.document : {};
  const title = event.provider === 'github' ? (data.title || data.branch || 'GitHub activity')
    : event.provider === 'slack' ? 'Slack message'
    : event.provider === 'notion' ? (document.title || 'Notion document')
    : event.provider === 'agent' ? 'Agent work report' : 'Source record';
  const readable = event.provider === 'github' ? (data.body || data.text || '')
    : event.provider === 'slack' ? (data.text || '')
    : event.provider === 'notion' ? (document.markdown || '')
    : event.provider === 'agent' ? (data.outcome || data.text || '') : '';
  const sourceLink = typeof event.sourceUrl === 'string' && /^https:\/\//i.test(event.sourceUrl)
    ? '<a class="button quiet small" href="' + esc(event.sourceUrl) + '" target="_blank" rel="noreferrer">Open original source</a>' : '';
  byId('evidence-detail').querySelector('.evidence-detail-empty').hidden = true;
  byId('evidence-detail-body').innerHTML = '<div class="evidence-detail-content">' +
    '<span class="provider-badge">' + esc(event.provider) + '</span>' +
    '<h2>' + esc(title) + '</h2>' +
    (readable ? '<p class="evidence-readable">' + esc(String(readable).slice(0, 4000)) + '</p>' : '') +
    sourceLink +
    '<div class="evidence-detail-grid">' +
      '<div><small>Observed</small><span>' + esc(formatDate(event.occurredAt)) + '</span></div>' +
      '<div><small>Received</small><span>' + esc(formatDate(event.receivedAt)) + '</span></div>' +
      '<div><small>Visibility</small><span>' + esc(event.visibility) + '</span></div>' +
      '<div><small>Type</small><span>' + esc(event.eventKind.replaceAll('.', ' ')) + '</span></div>' +
    '</div>' +
    '<details class="source-details"><summary>Technical source details</summary><p>' + esc(event.sourceRef) + '</p><pre class="evidence-payload"><code>' + esc(payload) + '</code></pre></details>' +
  '</div>';
}

async function openEvidence(eventId) {
  state.selectedEvidenceId = eventId;
  byId('evidence-detail').querySelector('.evidence-detail-empty').hidden = true;
  byId('evidence-detail-body').innerHTML = '<div class="evidence-detail-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Loading receipt</h2></div>';
  byId('evidence-dialog').showModal();
  try {
    const detail = await api('/api/evidence/events/' + encodeURIComponent(eventId));
    if (state.selectedEvidenceId === eventId) renderEvidenceDetail(detail);
  } catch (error) {
    if (state.selectedEvidenceId === eventId) {
      byId('evidence-detail-body').innerHTML = '';
      byId('evidence-detail').querySelector('.evidence-detail-empty').hidden = false;
    }
    showError(error);
  }
}

const harnessLabels = { codex: 'Codex', claude_code: 'Claude Code', hermes: 'Hermes Agent', pi: 'Pi', generic_mcp: 'Other MCP' };
const harnessIcons = { codex: 'terminal-window', claude_code: 'brackets-curly', hermes: 'lightning', pi: 'pi', generic_mcp: 'plugs-connected' };
const capabilityLabels = {
  'work:read': 'Read work',
  'work:propose': 'Propose work',
  'context:read': 'Read context',
  'source:read': 'Read sources',
  'context:propose': 'Propose context',
  'evidence:report': 'Report evidence'
};

function agentCard(profile) {
  const grants = profile.capabilities.map((capability) => '<span>' + esc(capabilityLabels[capability] || capability) + '</span>').join('');
  const activity = profile.lastUsedAt ? 'Last used ' + formatDate(profile.lastUsedAt) : 'Not connected yet';
  const scope = profile.dataScope || { projects: [], contextPaths: [], sourceVisibilities: [] };
  const actions = profile.status === 'active'
    ? '<button class="button quiet small" data-agent-scope="' + esc(profile.id) + '">Access</button><button class="button quiet small" data-agent-setup="' + esc(profile.id) + '"><i class="ph ph-wrench" aria-hidden="true"></i>Setup</button><button class="button quiet small" data-agent-rotate="' + esc(profile.id) + '"><i class="ph ph-arrows-clockwise" aria-hidden="true"></i>Rotate</button><button class="button danger small" data-agent-revoke="' + esc(profile.id) + '"><i class="ph ph-lock-key" aria-hidden="true"></i>Revoke</button>'
    : '<button class="button quiet small" data-agent-rotate="' + esc(profile.id) + '"><i class="ph ph-key" aria-hidden="true"></i>New secret</button>';
  return '<article class="agent-card ' + esc(profile.status) + '">' +
    '<div class="agent-card-head"><div class="agent-identity"><span class="harness-icon"><i class="ph ph-robot" aria-hidden="true"></i></span><div><span class="harness-label">Multi-harness MCP</span><h2>' + esc(profile.name) + '</h2></div></div><span class="agent-status">' + esc(profile.status) + '</span></div>' +
    '<p>' + esc(profile.description || 'No purpose recorded.') + '</p>' +
    '<div class="agent-owner"><small>Owned by</small><strong>' + esc(profile.owner) + '</strong><span>Secret ending ' + esc(profile.tokenHint) + '</span></div>' +
    '<div class="agent-grants"><span>' + esc(scope.projects.includes('*') ? 'All work' : scope.projects.length + ' projects') + '</span><span>' + esc(scope.contextPaths.length) + ' context paths</span><span>' + esc(scope.sourceVisibilities.length) + ' visibility grants</span></div>' +
    '<div class="agent-grants">' + grants + '</div>' +
    '<div class="agent-card-foot"><span>' + esc(activity) + '</span><div>' + (profile.status === 'active' ? '<button class="button quiet small" data-agent-files="' + esc(profile.id) + '">Files</button>' : '') + actions + '</div></div>' +
    '</article>';
}

function renderAgents() {
  byId('agents').innerHTML = state.agents.map(agentCard).join('') || '<div class="empty agent-empty"><strong>No agent profiles yet</strong><span>Create an agent, then connect it across your harnesses.</span></div>';
  const connectable = state.agents.filter((profile) => profile.status === 'active');
  const selectedProfile = byId('connect-agent-profile').value;
  byId('agent-connect-menu').hidden = !connectable.length;
  byId('connect-agent-profile').innerHTML = connectable.map((profile) => '<option value="' + esc(profile.id) + '">' + esc(profile.name) + '</option>').join('');
  if (connectable.some((profile) => profile.id === selectedProfile)) byId('connect-agent-profile').value = selectedProfile;
  byId('connect-harness-options').innerHTML = Object.entries(harnessLabels).map(([key, label]) => '<button type="button" data-connect-harness="' + key + '"><i class="ph ph-' + harnessIcons[key] + '" aria-hidden="true"></i> ' + label + '</button>').join('');
  byId('agent-count').textContent = String(state.agents.filter((profile) => profile.status === 'active').length);
  byId('agent-metric').textContent = state.agents.length + (state.agents.length === 1 ? ' profile' : ' profiles');
  const members = state.workspace ? state.workspace.members.filter((member) => member.status === 'active' && (isAdmin() || member.id === state.account?.identity?.memberId)) : [];
  byId('agent-member').innerHTML = members.map((member) => '<option value="' + esc(member.id) + '">' + esc(member.displayName) + ' · ' + esc(member.role) + '</option>').join('');
}

const providerIcons = { notion: 'notion-logo', slack: 'slack-logo', github: 'github-logo', agent: 'robot', manual: 'pencil-simple' };

function renderIntegrations() {
  const installations = state.workspace ? state.workspace.installations.filter((item) => item.status !== 'disabled' && item.status !== 'revoked') : [];
  const connectorSyncs = state.workspace ? (state.workspace.connectorSyncs || []) : [];
  byId('integration-count').textContent = String(installations.length);
  byId('integrations').innerHTML = installations.map((item) => {
    const resources = item.config.roots || item.config.channels || item.config.repositories || [];
    const resourceCopy = Array.isArray(resources) && resources.length ? resources.length + ' selected' : 'No resources selected';
    const syncs = connectorSyncs.filter((sync) => sync.installationId === item.id);
    const repair = syncs.length
      ? syncs.map((sync) => sync.resourceKey + ': ' + sync.status + (sync.lastError ? ' · ' + sync.lastError : '') + (sync.lastRepairAt ? ' · repaired ' + formatDate(sync.lastRepairAt) : '')).join(' / ')
      : 'No durable source checkpoint yet';
    return '<article class="integration-card"><div class="integration-card-head"><div class="integration-title"><i class="ph ph-' + esc(providerIcons[item.provider] || 'plugs-connected') + '" aria-hidden="true"></i><div><h2>' + esc(item.displayName) + '</h2><span>' + esc(item.provider) + ' / ' + esc(item.transport) + '</span></div></div><span class="health-state ' + esc(item.status) + '">' + esc(item.status) + '</span></div>' +
      '<div class="integration-details"><div><small>Allowed scope</small><span>' + esc(resourceCopy) + '</span></div><div><small>Last success</small><span>' + esc(item.lastSuccessAt ? formatDate(item.lastSuccessAt) : 'Not synced') + '</span></div></div>' +
      '<p class="connector-checkpoint">' + esc(repair) + '</p>' +
      '<p>' + esc(item.lastError || 'Connector content is retained separately from immutable receipt metadata.') + '</p>' +
      '<div class="proposal-actions"><button class="button quiet small" data-installation-disable="' + esc(item.id) + '">Disable</button><button class="button danger small" data-installation-revoke="' + esc(item.id) + '">Revoke</button></div></article>';
  }).join('') || '<div class="empty agent-empty"><strong>No integrations configured</strong><span>Add only the sources and resources Panini is allowed to observe.</span></div>';
}

function renderDevices() {
  const profiles = new Map(state.agents.map((profile) => [profile.id, profile]));
  byId('devices').innerHTML = state.devices.map((device) => '<div class="activity-row"><strong>' + esc(device.name) + '</strong><span>' + esc((profiles.get(device.agentProfileId) || {}).name || 'Unknown profile') + ' / ' + esc(device.privacyMode.replaceAll('_', ' ')) + ' / ' + esc(device.status) + '</span>' + (device.status === 'active' ? '<button class="button danger small" data-device-revoke="' + esc(device.id) + '">Revoke</button>' : '<time>' + esc(formatDate(device.updatedAt)) + '</time>') + '</div>').join('') || '<div class="empty"><strong>No relay devices enrolled</strong><span>Enroll a device to queue signed, privacy-filtered reports while offline.</span></div>';
  byId('device-profile').innerHTML = state.agents.filter((profile) => profile.status === 'active').map((profile) => '<option value="' + esc(profile.id) + '">' + esc(profile.name) + ' (' + esc(profile.owner) + ')</option>').join('');
}

function renderMappings() {
  byId('repository-mappings').innerHTML = state.mappings.map((mapping) => '<div class="activity-row"><strong>' + esc(mapping.repository) + '</strong><span>' + esc(mapping.project) + ' / ' + mapping.contextPaths.length + ' context paths</span><time>' + esc(formatDate(mapping.updatedAt)) + '</time></div>').join('') || '<div class="empty"><strong>No repository mappings</strong><span>Map repositories so agents receive relevant project context.</span></div>';
}

function renderTaskDetail(detail) {
  const task = detail.task;
  const revisions = detail.revisions.slice().reverse().map((revision) => {
    const labels = { status: 'Status', owner: 'Owner', project: 'Project', title: 'Title', description: 'Description', dueDate: 'Due date', priority: 'Priority' };
    const changed = revision.previous ? Object.entries(labels).filter(([key]) => JSON.stringify(revision.current[key]) !== JSON.stringify(revision.previous[key])).map(([key, label]) => label + ': ' + changeValue(revision.previous[key]) + ' → ' + changeValue(revision.current[key])) : ['First recorded'];
    const proposal = detail.proposals.find((item) => item.id === revision.proposalId);
    return '<div class="knowledge-change"><time>' + esc(formatDate(revision.appliedAt)) + '</time><strong>' + esc(changed.join(' · ') || 'Other details changed') + '</strong><small>Recorded by ' + esc(recordedBy(revision.appliedBy)) + '</small>' + (proposal?.rationale ? '<p>Recorded note: ' + esc(proposal.rationale) + '</p>' : '') + '</div>';
  }).join('');
  const pending = detail.proposals.filter((proposal) => proposal.state === 'pending').map((proposal) => '<div class="activity-row pending-row"><strong>Pending ' + esc(proposal.kind.replaceAll('_', ' ')) + '</strong><span>' + esc(Object.keys(proposal.changes).join(', ')) + ' · ' + esc(proposal.rationale) + '</span><time>Base v' + esc(proposal.baseVersion || 'new') + '</time></div>').join('');
  const evidence = detail.evidence.map((item) => '<div class="activity-row"><strong>' + esc(item.provider + ' · ' + item.eventKind) + '</strong><span>' + esc(item.sourceRef) + '</span><time>' + esc(formatDate(item.occurredAt)) + '</time></div>').join('');
  const activity = (detail.activityCandidates || []).map((item) => '<div class="activity-row"><strong>' + esc(item.eventKind.replaceAll('_', ' ')) + '</strong><span>' + (item.sourceUrl && item.sourceUrl.startsWith('https://') ? '<a href="' + esc(item.sourceUrl) + '" target="_blank" rel="noreferrer">' + esc(item.sourceRef) + '</a>' : esc(item.sourceRef)) + '</span><time>' + esc(formatDate(item.occurredAt)) + '</time></div>').join('');
  const coverage = detail.activityCoverage || { bounded: false, scanned: 0 };
  const dependencies = task.dependencyRefs.length ? task.dependencyRefs.map(dependencyName).join(', ') : 'None';
  const canUndo = canReview() && detail.allowedActions.find((action) => action.action === 'undo' && action.allowed);
  const contract = task.outcomeContract;
  const contractView = contract
    ? '<p>' + esc(contract.statement) + '</p><p><strong>Scope:</strong> ' + esc(contract.scope) + '</p>' +
      (contract.exclusions.length ? '<p><strong>Exclusions:</strong> ' + esc(contract.exclusions.join('; ')) + '</p>' : '') +
      '<div class="activity-list">' + contract.criteria.map((criterion) =>
        '<div class="activity-row"><strong>' + esc(criterion.description) + '</strong><span>' +
        esc(criterion.required ? 'Required' : 'Optional') + ' · ' + esc(criterion.evidenceRule.kind.replaceAll('_', ' ')) +
        (criterion.evidenceRule.artifactRefs.length ? ' · ' + esc(criterion.evidenceRule.artifactRefs.join(', ')) : '') +
        '</span></div>').join('') + '</div><small>Accepted ' + esc(formatDate(contract.provenance.acceptedAt)) +
      ' by ' + esc(recordedBy(contract.provenance.actor)) + ' · v' + esc(contract.version) + '</small>'
    : '<p class="muted-copy">No accepted outcome contract. Completion reports need human review.</p>';
  const contractDraft = canReview() ? '<details class="source-details"><summary>Propose an outcome contract</summary>' +
    '<form id="outcome-contract-form" class="settings-form" data-task-id="' + esc(task.id) + '" data-task-version="' + esc(task.version) + '">' +
    '<div class="field"><label>Outcome statement</label><textarea name="statement" required maxlength="5000">' + esc(contract?.statement || '') + '</textarea></div>' +
    '<div class="field"><label>Scope</label><textarea name="scope" required maxlength="5000">' + esc(contract?.scope || '') + '</textarea></div>' +
    '<div class="field"><label>Exclusions, one per line</label><textarea name="exclusions">' + esc(contract?.exclusions.join('\n') || '') + '</textarea></div>' +
    '<div class="field"><label>Criteria JSON</label><textarea name="criteria" required rows="8">' + esc(JSON.stringify(contract?.criteria.map((item) => ({ id: item.id, description: item.description, required: item.required, evidenceRule: item.evidenceRule })) || [], null, 2)) + '</textarea><small>Each criterion needs an id, description, required flag, and evidenceRule. For GitHub merge or deployment checks, include the pull URL and exact 40-character SHA in artifactRefs.</small></div>' +
    '<div class="field"><label>Reason for this contract</label><textarea name="rationale" required maxlength="2000"></textarea></div>' +
    '<button class="button primary" type="submit">Send for review</button></form></details>' : '';
  byId('task-detail-content').innerHTML = '<div class="detail-head"><div><h2>' + esc(task.title) + '</h2><p>' + esc(task.description || 'No description recorded.') + '</p></div><span class="detail-state">' + esc(task.status.replaceAll('_', ' ')) + '</span></div>' +
    '<div class="detail-grid"><div><small>Owner</small><span>' + esc(task.owner || 'Unassigned') + '</span></div><div><small>Project</small><span>' + esc(task.project || 'No project') + '</span></div><div><small>Last changed</small><span>' + esc(formatDate(task.updatedAt)) + '</span></div><div><small>Priority</small><span>' + esc(task.priority) + '</span></div><div><small>Dependencies</small><span>' + esc(dependencies) + '</span></div><div><small>Source</small><span>' + (task.sourceUrl ? '<a href="' + esc(task.sourceUrl) + '" target="_blank" rel="noreferrer">Open original</a>' : 'Added in Panini') + '</span></div></div>' +
    '<div class="section-head compact-head"><div><h2>Outcome contract</h2><p>Accepted scope and proof needed for completion.</p></div></div>' + contractView + contractDraft +
    (pending ? '<div class="section-head compact-head"><div><h2>Changes under review</h2><p>The current task has not changed yet.</p></div></div><div class="activity-list">' + pending + '</div>' : '') +
    '<div class="section-head compact-head"><div><h2>Possible linked activity</h2><p>Reference matches are clues. They do not change accepted status.</p></div></div><div class="activity-list">' + (activity || '<div class="empty"><span>No activity with an exact task reference found.</span></div>') + '</div>' + (coverage.bounded ? '<p class="muted-copy">Recent event window reached its limit; older activity may be missing.</p>' : '') +
    '<div class="section-head"><div><h2>How this task changed</h2></div>' + (canUndo ? '<button class="button danger small" data-task-undo="' + esc(task.id) + '">Undo latest</button>' : '') + '</div><div class="knowledge-history">' + revisions + '</div>' +
    '<details class="source-details"><summary>View sources</summary><div class="activity-list">' + (evidence || '<div class="empty"><span>No source receipts recorded.</span></div>') + '</div></details>';
  byId('task-detail-dialog').showModal();
}

function renderRetrieval(result) {
  const entries = result.entries.map((entry) => '<button class="retrieval-result" data-retrieval-entry="' + esc(entry.id) + '"><h3>' + esc(entry.title) + '</h3><p>Updated ' + esc(formatDate(entry.updatedAt)) + '</p></button>').join('');
  const sources = (result.sources || []).map((source) => '<button class="retrieval-result source-result" data-source-document="' + esc(source.sourceEventId) + '"><span class="provider-badge">' + esc(source.provider) + '</span><h3>' + esc(source.title) + '</h3></button>').join('');
  byId('context-preview').innerHTML = '<div class="retrieval-summary"><header><h2>Results for ' + esc(result.objective) + '</h2><p>Recorded knowledge relevant to your search.</p></header>' +
    (entries || '<div class="empty"><strong>No recorded match</strong><span>Try another term or check the original sources.</span></div>') +
    (sources ? '<details class="source-details"><summary>Related original sources</summary><div class="source-result-grid">' + sources + '</div></details>' : '') + '</div>';
}

function showAgentSetup(response, harness) {
  const recipes = response.setups || [response.setup];
  response = { ...response, setup: recipes.find((recipe) => recipe.harness === (harness || response.setup.harness)) || recipes[0] };
  state.setup = response;
  byId('agent-connection-status').textContent = '';
  const setup = response.setup;
  const secret = response.secret
    ? '<div class="secret-panel"><div><small>One-time enrollment secret</small><code>' + esc(response.secret) + '</code></div><button class="button primary" data-copy-secret><i class="ph ph-copy" aria-hidden="true"></i>Copy secret</button><p>Copy this now. Panini stores only its digest and cannot show it again.</p></div>'
    : '<div class="secret-panel unavailable"><div><small>Enrollment secret</small><strong>Hidden after enrollment</strong></div><p>Use your saved secret in every harness. If it is lost, rotate it and update all connected harnesses.</p></div>';
  const harnessBar = '<nav class="setup-harness-bar" aria-label="Harness setup options">' + recipes.map((recipe) => '<button type="button" class="button quiet small" data-setup-harness="' + esc(recipe.harness) + '" aria-pressed="' + String(recipe.harness === setup.harness) + '">' + esc(harnessLabels[recipe.harness] || recipe.harnessLabel) + '</button>').join('') + '</nav>';
  const steps = setup.steps.map((step, index) => '<li><div><strong>' + esc(step.title) + '</strong><p>' + esc(step.copy) + '</p></div><pre><code>' + esc(step.code) + '</code><button class="copy-code" type="button" data-copy-step="' + index + '"><i class="ph ph-copy" aria-hidden="true"></i>Copy</button></pre></li>').join('');
  const notes = setup.notes.map((note) => '<li>' + esc(note) + '</li>').join('');
  byId('setup-content').innerHTML = harnessBar + '<div class="setup-head"><span class="harness-label">' + esc(setup.harnessLabel) + '</span><h2>Connect ' + esc(response.profile.name) + '</h2><p>Owned by ' + esc(response.profile.owner) + '. Use the same identity and secret across multiple harnesses.</p></div>' + secret + '<ol class="setup-steps">' + steps + '</ol><div class="verify-panel"><small>Verify the connection</small><p>' + esc(setup.verificationPrompt) + '</p><button class="button quiet small" type="button" data-copy-prompt><i class="ph ph-copy" aria-hidden="true"></i>Copy prompt</button></div><ul class="setup-notes">' + notes + '</ul>';
  if (!byId('setup-dialog').open) byId('setup-dialog').showModal();
}

function renderSummary() {
  byId('work-count').textContent = String(state.board.tasks.length);
  const intelligenceEnabled = state.health.intelligence !== 'disabled';
  byId('analyze').hidden = !intelligenceEnabled;
}

async function load() {
  clearError();
  try {
    const [board, workGraph, context, sourceDocuments, health, agents, workspace, devices, mappings, company, people, history, projectProposals] = await Promise.all([
      api('/api/board'), api('/api/work-graph'), api('/api/context'), api('/api/source-documents?limit=100'), api('/healthz'),
      api('/api/agents'), api('/api/workspace'), api('/api/devices'), api('/api/repository-mappings'),
      api('/api/company'), api('/api/people'), api('/api/history?view=changes&limit=250'), api('/api/project-proposals')
    ]);
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
    const evidenceOperations = isAdmin() ? await api('/api/evidence/coverage')
      .catch(() => null) : null;
    state.evidenceCoverage = evidenceOperations?.coverage ?? null;
    state.evidenceBudget = evidenceOperations?.budget ?? null;
    state.proposalDetails = Object.fromEntries(await Promise.all(board.proposals.map(async (proposal) => {
      try { return [proposal.id, await api('/api/proposals/' + encodeURIComponent(proposal.id))]; }
      catch { return [proposal.id, null]; }
    })));
    const assessmentIds = [...new Set(Object.values(state.proposalDetails)
      .map((detail) => detail && detail.proposal && detail.proposal.assessmentId).filter(Boolean))];
    state.assessmentDetails = Object.fromEntries(await Promise.all(assessmentIds.map(async (id) => {
      try { const response = await api('/api/evidence/assessments/' + encodeURIComponent(id));
        return [id, response.assessment]; }
      catch { return [id, null]; }
    })));
    renderBoard();
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
  company: '/app/company', people: '/app/people', work: '/app/tasks', projects: '/app/projects',
  review: '/app/review', context: '/app/context', agents: '/app/agents', integrations: '/app/integrations',
  history: '/app/history', timeline: '/app/timeline'
  , settings: '/app/settings', onboarding: '/app/onboarding'
};
const viewByPath = Object.fromEntries(Object.entries(pathByView).map(([view, path]) => [path, view]));

function navigate(view, options = {}) {
  if (!pathByView[view]) return;
  if (accountsEnabled && state.account && view === 'integrations' && !isAdmin()) view = 'settings';
  document.querySelectorAll('.nav-item, .view').forEach((element) => { element.classList.remove('active'); element.removeAttribute('aria-current'); });
  byId('nav-more').classList.toggle('current', view === 'more');
  const tab = document.querySelector('.nav-item[data-view="' + view + '"]');
  if (tab) { tab.classList.add('active'); tab.setAttribute('aria-current', 'page'); }
  byId('nav-more').open = false;
  byId('workspace-menu').open = false;
  byId('view-' + view).classList.add('active');
  byId('current-view-label').textContent = ({ context: 'Context', timeline: 'Timeline', projects: 'Projects', work: 'Tasks', integrations: 'Source settings' })[view] || view;
  const path = pathByView[view];
  if (options.replace) window.history.replaceState(null, '', path);
  else if (options.updateHistory !== false && window.location.pathname !== path) window.history.pushState(null, '', path);
  if (options.scroll !== false) window.scrollTo({ top: 0, behavior: 'smooth' });
  if (state.account && view === 'settings') void loadSettings().catch(showError);
  if (state.account && view === 'onboarding') void loadOnboarding().catch(showError);
}

document.querySelectorAll('.nav-item[data-view], [data-go-view]').forEach((item) => item.addEventListener('click', (event) => {
  if (item.matches('a') && (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey)) return;
  event.preventDefault();
  navigate(item.dataset.view || item.dataset.goView);
}));
window.addEventListener('popstate', () => navigate(viewByPath[window.location.pathname] || 'projects', { updateHistory: false, scroll: false }));
navigate(viewByPath[window.location.pathname] || 'projects', { replace: window.location.pathname === '/app', scroll: false });
byId('task-suggestions').addEventListener('click', (event) => { if (event.target.closest('[data-go-view="review"]')) navigate('review'); });
byId('project-suggestions').addEventListener('click', (event) => { if (event.target.closest('[data-go-view="review"]')) navigate('review'); });
byId('history-filter').addEventListener('change', renderHistory);
byId('timeline-filter').addEventListener('change', renderTimeline);
async function openHistorySubject(type, id) {
  if (type === 'context_revision') { navigate('context'); await openContextEntry(id); }
  else if (type === 'task_revision') {
    try { renderTaskDetail(await api('/api/tasks/' + encodeURIComponent(id))); }
    catch (error) { showError(error); }
  }
}
byId('history').addEventListener('click', (event) => {
  const button = event.target.closest('[data-history-entry], [data-history-task]');
  if (button) void openHistorySubject(button.dataset.historyEntry ? 'context_revision' : 'task_revision', button.dataset.historyEntry || button.dataset.historyTask);
});
byId('timeline').addEventListener('click', (event) => {
  const button = event.target.closest('[data-history-entry], [data-history-task]');
  if (button) void openHistorySubject(button.dataset.historyEntry ? 'context_revision' : 'task_revision', button.dataset.historyEntry || button.dataset.historyTask);
});
byId('company-recent').addEventListener('click', (event) => {
  const button = event.target.closest('[data-history-subject]');
  if (button) void openHistorySubject(button.dataset.historyType, button.dataset.historySubject);
});
document.querySelectorAll('[data-context-mode]').forEach((button) => button.addEventListener('click', () => setContextMode(button.dataset.contextMode)));
byId('session-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const submit = event.currentTarget.querySelector('button[type="submit"]');
  submit.disabled = true;
  byId('session-error').hidden = true;
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ token: byId('session-token').value })
    });
    const body = await response.json().catch(() => ({ error: 'The session response was unreadable.' }));
    if (!response.ok) throw new Error(body.error || 'Administrator sign-in failed.');
    state.csrf = body.csrf || '';
    byId('session-dialog').close();
    state.sessionResolve?.();
    state.sessionResolve = null;
    state.sessionReject = null;
  } catch (error) {
    byId('session-error').textContent = error instanceof Error ? error.message : String(error);
    byId('session-error').hidden = false;
  } finally {
    submit.disabled = false;
  }
});
byId('dismiss-alert').addEventListener('click', clearError);
byId('new-task').addEventListener('click', () => byId('task-dialog').showModal());
byId('new-project').addEventListener('click', () => {
  byId('project-form').reset();
  delete byId('project-form').dataset.projectId;
  byId('project-dialog-title').textContent = 'Create a project';
  byId('project-submit').textContent = 'Create project';
  byId('project-dialog').showModal();
});
byId('new-context').addEventListener('click', () => byId('context-dialog').showModal());
byId('new-agent').addEventListener('click', () => {
  if (state.account) byId('agent-member').value = state.account.identity.memberId;
  byId('agent-dialog').showModal();
});
byId('setup-dialog').addEventListener('close', () => {
  state.setup = null;
  byId('setup-content').replaceChildren();
  byId('agent-connection-status').textContent = '';
});
byId('verify-agent-connection').addEventListener('click', async (event) => {
  if (!state.setup) return;
  const id = state.setup.profile.id;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const response = await api('/api/agents/' + encodeURIComponent(id) + '/setup');
    byId('agent-connection-status').textContent = response.profile.lastUsedAt
      ? 'Connected. Last authenticated request: ' + formatDate(response.profile.lastUsedAt)
      : 'No connection yet. Add the server in your client, then try again.';
  } catch (error) { byId('agent-connection-status').textContent = error.message; }
  finally { button.disabled = false; }
});
byId('new-integration').addEventListener('click', () => byId('integration-dialog').showModal());
byId('connect-github').addEventListener('click', async () => {
  try {
    const result = await api('/api/github/connect/start', { method: 'POST', body: '{}' });
    window.location.assign(result.authorizationUrl);
  } catch (error) { showError(error); }
});

async function openGithubConnection(selectionId) {
  const result = await api('/api/github/connect/session/' + encodeURIComponent(selectionId));
  state.githubSelectionId = selectionId;
  const organizations = result.organizations.map((org) => esc(org.login)).join(', ');
  const installations = result.installations.map((installation) => {
    const repositories = installation.repositories.map((repository) =>
      '<label><input type="checkbox" data-github-repository-id="' + esc(repository.id) + '"' + (repository.archived ? ' disabled' : '') + '><span><b>' + esc(repository.full_name) + '</b><small>' + esc(repository.private ? 'Private' : 'Public') + (repository.archived ? ' / archived' : '') + '</small></span></label>'
    ).join('');
    return '<fieldset class="capability-field" data-github-installation="' + esc(installation.id) + '"><legend><label><input type="radio" name="githubInstallation" value="' + esc(installation.id) + '"> ' + esc(installation.account.login) + '</label></legend>' + (repositories || '<p>No repositories available to this GitHub user.</p>') + '</fieldset>';
  }).join('');
  byId('github-connection-content').innerHTML =
    '<p>Signed in to GitHub as <strong>' + esc(result.user.login) + '</strong>. ' + (organizations ? 'Organizations: ' + organizations + '.' : 'GitHub did not return an organization list.') + '</p>' +
    (installations || '<p>No accessible organization installation found. Install the Panini GitHub App, then select Connect GitHub again.</p>') +
    '<p><a href="' + esc(result.installationUrl) + '" target="_blank" rel="noopener noreferrer">Install or update the GitHub App</a></p>';
  byId('github-dialog').showModal();
}

byId('github-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const selected = byId('github-form').querySelector('input[name="githubInstallation"]:checked');
  if (!selected) return showError(new Error('Choose an organization installation.'));
  const fieldset = byId('github-form').querySelector('[data-github-installation="' + selected.value + '"]');
  const repositoryIds = [...fieldset.querySelectorAll('[data-github-repository-id]:checked')].map((input) => Number(input.dataset.githubRepositoryId));
  if (!repositoryIds.length) return showError(new Error('Choose at least one repository.'));
  try {
    await api('/api/github/connect/complete', { method: 'POST', body: JSON.stringify({
      selectionId: state.githubSelectionId,
      installationId: Number(selected.value), repositoryIds
    }) });
    byId('github-dialog').close();
    state.githubSelectionId = null;
    await load();
    navigate('integrations');
  } catch (error) { showError(error); }
});
byId('new-device').addEventListener('click', () => {
  if (!state.agents.some((profile) => profile.status === 'active')) return showError(new Error('Create an active agent profile before enrolling a device.'));
  byId('device-dialog').showModal();
});
byId('new-mapping').addEventListener('click', () => byId('mapping-dialog').showModal());
document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => byId(button.dataset.close).close()));
byId('context-search').addEventListener('input', () => {
  if (state.contextMode === 'sources' && !byId('context-search').value.trim()) state.sourceDocuments = state.sourceDocumentsAll;
  renderContextTree();
});
byId('context-project-filter').addEventListener('change', renderContextFilters);
byId('context-search-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const objective = byId('context-search').value.trim();
  if (!objective) return renderContextTree();
  if (objective.startsWith('panini://')) return renderContextTree();
  if (state.contextMode === 'sources') {
    byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph loading-icon"><i class="ph ph-circle-notch" aria-hidden="true"></i></span><h2>Searching source material</h2><p>Matching document titles, paths, headings, and captured text.</p></div>';
    try {
      const response = await api('/api/source-documents?q=' + encodeURIComponent(objective) + '&limit=100');
      state.sourceDocuments = response.documents;
      state.selectedSourceDocumentId = null;
      renderContext();
      byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-archive" aria-hidden="true"></i></span><h2>' + esc(response.documents.length) + ' source ' + (response.documents.length === 1 ? 'match' : 'matches') + '</h2><p>Matched sections are highlighted in each document outline.</p></div>';
    } catch (error) { showError(error); }
    return;
  }
  byId('context-preview').innerHTML = '<div class="preview-empty"><span class="empty-glyph"><i class="ph ph-magnifying-glass" aria-hidden="true"></i></span><h2>Searching accepted context</h2><p>Checking paths, content, task links, and version manifests.</p></div>';
  try {
    const project = byId('context-project-filter').value;
    const taskId = byId('context-task-filter').value;
    const filters = (project ? '&project=' + encodeURIComponent(project) : '') + (taskId ? '&taskId=' + encodeURIComponent(taskId) : '');
    renderRetrieval(await api('/api/context/search?objective=' + encodeURIComponent(objective) + '&q=' + encodeURIComponent(objective) + filters));
  } catch (error) { showError(error); }
});

function syncContextFormKind() {
  const isFile = byId('context-kind').value === 'file';
  byId('context-fact-type').disabled = isFile;
  byId('context-value-field').hidden = isFile;
  byId('context-body-field').hidden = !isFile;
  byId('context-value').required = !isFile;
  byId('context-body').required = isFile;
  byId('context-path').placeholder = isFile ? '/handbook/operations.md' : '/policies/deployment/review-gate';
}
byId('context-kind').addEventListener('change', syncContextFormKind);
syncContextFormKind();

byId('context-tree').addEventListener('click', (event) => {
  const personalButton = event.target.closest('[data-personal-file]');
  if (personalButton) return void openWorkspaceContext(personalButton.dataset.personalFile);
  const sourceButton = event.target.closest('[data-source-document]');
  if (sourceButton) return openSourceDocument(sourceButton.dataset.sourceDocument);
  const entryButton = event.target.closest('[data-entry]');
  if (entryButton) return void openContextEntry(entryButton.dataset.entry);
  const folderButton = event.target.closest('[data-folder]');
  if (folderButton) folderButton.closest('.tree-node').classList.toggle('collapsed');
});

byId('context-preview').addEventListener('click', (event) => {
  const lifecycleButton = event.target.closest('[data-context-lifecycle]');
  if (lifecycleButton) {
    const entry = state.context.facts.concat(state.context.files).find((item) => item.id === lifecycleButton.dataset.contextLifecycle);
    if (!entry) return;
    byId('context-lifecycle-id').value = entry.id;
    byId('context-lifecycle-state').value = lifecycleButton.dataset.lifecycleState;
    byId('context-lifecycle-reason').value = '';
    byId('context-lifecycle-from').value = localDateTimeValue(entry.effectiveFrom);
    byId('context-lifecycle-to').value = localDateTimeValue(entry.effectiveTo);
    byId('context-lifecycle-dialog').showModal();
    return;
  }
  const sourceButton = event.target.closest('[data-source-document]');
  if (sourceButton) {
    setContextMode('sources');
    if (state.sourceDocuments.some((item) => item.sourceEventId === sourceButton.dataset.sourceDocument)) return openSourceDocument(sourceButton.dataset.sourceDocument);
    return void openSourceRead(sourceButton.dataset.sourceDocument, null);
  }
  const sectionButton = event.target.closest('[data-source-section]');
  if (sectionButton && state.selectedSourceDocumentId) return void openSourceRead(state.selectedSourceDocumentId, sectionButton.dataset.sourceSection);
  const fullButton = event.target.closest('[data-source-read-full]');
  if (fullButton) return void openSourceRead(fullButton.dataset.sourceReadFull, null);
  const outlineButton = event.target.closest('[data-source-outline]');
  if (outlineButton) return openSourceDocument(outlineButton.dataset.sourceOutline);
  const entryButton = event.target.closest('[data-retrieval-entry]');
  if (entryButton) void openContextEntry(entryButton.dataset.retrievalEntry);
});

byId('agent-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = new FormData(formElement);
  const capabilities = values.getAll('capability');
  if (!capabilities.length) return showError(new Error('Select at least one capability grant.'));
  const lines = (name) => String(values.get(name) || '').split('\n').map((value) => value.trim()).filter(Boolean);
  const payload = {
    memberId: values.get('memberId'),
    name: values.get('name'),
    description: values.get('description'),
    capabilities,
    dataScope: {
      projects: lines('projects'),
      contextPaths: lines('contextPaths'),
      sourceVisibilities: lines('sourceVisibilities')
    }
  };
  try {
    const response = await api('/api/agents', { method: 'POST', body: JSON.stringify(payload) });
    byId('agent-dialog').close();
    formElement.reset();
    await load();
    navigate('agents');
    byId('connect-agent-profile').value = response.profile.id;
    showAgentSetup(response);
  } catch (error) { showError(error); }
});

byId('agent-scope-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const values = new FormData(form);
  const lines = (name) => String(values.get(name) || '').split('\n').map(value => value.trim()).filter(Boolean);
  try {
    await api('/api/agents/' + encodeURIComponent(values.get('agentId')) + '/scope', {
      method: 'PATCH',
      body: JSON.stringify({ projects: lines('projects'), contextPaths: lines('contextPaths'), sourceVisibilities: lines('sourceVisibilities') })
    });
    byId('agent-scope-dialog').close();
    await load();
  } catch (error) { showError(error); }
});

let workspaceFilesAgentId = null;
let workspaceFilesRequest = 0;
async function loadWorkspaceFiles() {
  const request = ++workspaceFilesRequest;
  byId('workspace-file-title').textContent = '';
  byId('workspace-file-content').textContent = '';
  byId('workspace-files-list').textContent = 'Loading files…';
  const response = await api('/api/agents/' + encodeURIComponent(workspaceFilesAgentId) + '/files?scope=' + byId('workspace-files-scope').value);
  if (request !== workspaceFilesRequest) return;
  byId('workspace-files-list').innerHTML = response.files.map(file => '<div class="activity-row"><button class="button quiet small" data-workspace-file="' + esc(file.uri) + '">' + esc(file.path) + '</button><span>Version ' + esc(file.version) + ' · ' + esc(file.byteSize) + ' bytes</span></div>').join('') || '<p>No files saved in this workspace yet.</p>';
}
byId('workspace-files-scope').addEventListener('change', () => loadWorkspaceFiles().catch(showError));
byId('workspace-files-list').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-workspace-file]');
  if (!button) return;
  const request = ++workspaceFilesRequest;
  byId('workspace-file-title').textContent = button.textContent;
  byId('workspace-file-content').textContent = 'Loading…';
  try {
    const response = await api('/api/agents/' + encodeURIComponent(workspaceFilesAgentId) + '/files?scope=' + byId('workspace-files-scope').value + '&uri=' + encodeURIComponent(button.dataset.workspaceFile));
    if (request !== workspaceFilesRequest) return;
    byId('workspace-file-content').textContent = response.file ? response.file.content : 'File no longer exists.';
  } catch (error) { if (request === workspaceFilesRequest) byId('workspace-file-content').textContent = 'Could not load file.'; showError(error); }
});

byId('agents').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const setupId = button.dataset.agentSetup;
  const scopeId = button.dataset.agentScope;
  const rotateId = button.dataset.agentRotate;
  const revokeId = button.dataset.agentRevoke;
  const filesId = button.dataset.agentFiles;
  const id = setupId || scopeId || rotateId || revokeId || filesId;
  if (!id) return;
  if (rotateId && !confirm('Rotate this agent secret? The current secret will stop working immediately.')) return;
  if (revokeId && !confirm('Revoke this agent? Its current secret will stop working immediately.')) return;
  button.disabled = true;
  try {
    if (scopeId) {
      const profile = state.agents.find(item => item.id === scopeId);
      if (!profile) throw new Error('Agent profile is unavailable.');
      byId('agent-scope-id').value = profile.id;
      byId('agent-scope-projects').value = profile.dataScope.projects.join('\n');
      byId('agent-scope-paths').value = profile.dataScope.contextPaths.join('\n');
      byId('agent-scope-visibilities').value = profile.dataScope.sourceVisibilities.join('\n');
      byId('agent-scope-dialog').showModal();
    }
    if (filesId) {
      workspaceFilesAgentId = filesId;
      byId('workspace-files-title').textContent = (state.agents.find(profile => profile.id === filesId)?.name || 'Agent') + ' : workspace files';
      byId('workspace-files-scope').value = 'agent';
      byId('workspace-files-dialog').showModal();
      await loadWorkspaceFiles();
    }
    if (setupId) showAgentSetup(await api('/api/agents/' + encodeURIComponent(id) + '/setup'));
    if (rotateId) {
      const response = await api('/api/agents/' + encodeURIComponent(id) + '/rotate-secret', { method: 'POST', body: '{}' });
      await load();
      showAgentSetup(response);
    }
    if (revokeId) {
      await api('/api/agents/' + encodeURIComponent(id) + '/revoke', { method: 'POST', body: '{}' });
      await load();
    }
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

byId('connect-harness-options').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-connect-harness]');
  const id = byId('connect-agent-profile').value;
  if (!button || !id) return;
  button.disabled = true;
  try {
    const response = await api('/api/agents/' + encodeURIComponent(id) + '/setup');
    byId('agent-connect-menu').open = false;
    showAgentSetup(response, button.dataset.connectHarness);
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

byId('setup-content').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button || !state.setup) return;
  if (button.dataset.setupHarness) {
    showAgentSetup(state.setup, button.dataset.setupHarness);
    byId('setup-content').querySelector('[data-setup-harness="' + button.dataset.setupHarness + '"]').focus();
    return;
  }
  let copy = null;
  if (button.hasAttribute('data-copy-secret')) copy = state.setup.secret;
  if (button.dataset.copyStep !== undefined) copy = state.setup.setup.steps[Number(button.dataset.copyStep)].code;
  if (button.hasAttribute('data-copy-prompt')) copy = state.setup.setup.verificationPrompt;
  if (!copy) return;
  try {
    await navigator.clipboard.writeText(copy);
    const previous = button.innerHTML;
    button.innerHTML = '<i class="ph ph-check" aria-hidden="true"></i>Copied';
    setTimeout(() => { button.innerHTML = previous; }, 1200);
  } catch (error) { showError(new Error('Copy failed. Select the text manually.')); }
});

byId('task-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const values = Object.fromEntries(new FormData(formElement));
    const project = state.workGraph.projects.find((item) => item.name.toLowerCase() === String(values.project || '').trim().toLowerCase());
    await api('/api/tasks', { method: 'POST', body: JSON.stringify({ ...values, projectId: project ? project.id : null }) });
    byId('task-dialog').close();
    formElement.reset();
    await load();
  } catch (error) { showError(error); }
});

byId('project-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  try {
    const values = Object.fromEntries(new FormData(formElement));
    if (formElement.dataset.projectId) {
      const project = state.workGraph.projects.find((item) => item.id === formElement.dataset.projectId);
      if (!project) throw new Error('Project changed. Refresh and try again.');
      await api('/api/projects/' + encodeURIComponent(project.id), { method: 'PATCH', body: JSON.stringify({
        baseVersion: project.version, changes: { name: values.name, outcome: values.outcome, owner: values.owner || null }
      }) });
    } else {
      await api('/api/projects', { method: 'POST', body: JSON.stringify(values) });
    }
    byId('project-dialog').close();
    formElement.reset();
    delete formElement.dataset.projectId;
    await load();
  } catch (error) { showError(error); }
});

byId('context-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  const project = state.workGraph.projects.find((item) => item.name === values.project);
  const temporal = {
    lifecycleState: 'accepted',
    ...(values.effectiveFrom ? { effectiveFrom: new Date(values.effectiveFrom).toISOString() } : {}),
    ...(values.effectiveTo ? { effectiveTo: new Date(values.effectiveTo).toISOString() } : {}),
    links: project ? [{ type: 'project', targetId: project.id, targetRef: project.name }] : []
  };
  const payload = values.kind === 'file'
    ? { kind: 'file', path: values.path, title: values.title, body: values.body, ...temporal }
    : { kind: 'fact', path: values.path, title: values.title, factType: values.factType, value: values.value, ...temporal };
  try {
    const response = await api('/api/context/entries', { method: 'POST', body: JSON.stringify(payload) });
    byId('context-dialog').close();
    formElement.reset();
    syncContextFormKind();
    await load();
    navigate('context');
    await openContextEntry(response.entry.id);
  } catch (error) { showError(error); }
});

byId('context-lifecycle-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  const payload = {
    lifecycleState: values.lifecycleState,
    reason: values.reason,
    ...(values.effectiveFrom ? { effectiveFrom: new Date(values.effectiveFrom).toISOString() } : {}),
    effectiveTo: values.effectiveTo ? new Date(values.effectiveTo).toISOString() : null
  };
  try {
    const response = await api('/api/context/entries/' + encodeURIComponent(values.entryId) + '/lifecycle', { method: 'POST', body: JSON.stringify(payload) });
    byId('context-lifecycle-dialog').close();
    formElement.reset();
    await load();
    navigate('context');
    await openContextEntry(response.entry.id);
  } catch (error) { showError(error); }
});

byId('integration-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  const resources = String(values.resources || '').split('\n').map((value) => value.trim()).filter(Boolean);
  const transport = values.provider === 'slack' ? 'socket_mode' : values.provider === 'github' ? 'webhook' : 'poll';
  const config = values.provider === 'slack' ? { channels: resources, captureReactions: ['panini'] } : values.provider === 'github' ? { repositories: resources } : { roots: resources };
  try {
    await api('/api/installations', { method: 'POST', body: JSON.stringify({ provider: values.provider, installationKey: values.installationKey, displayName: values.displayName, transport, config }) });
    byId('integration-dialog').close(); formElement.reset(); await load(); navigate('integrations');
  } catch (error) { showError(error); }
});

byId('device-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  try {
    await api('/api/devices', { method: 'POST', body: JSON.stringify(values) });
    byId('device-dialog').close(); formElement.reset(); await load(); navigate('agents');
  } catch (error) { showError(error); }
});

byId('mapping-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  const contextPaths = String(values.contextPaths || '').split('\n').map((value) => value.trim()).filter(Boolean);
  try {
    await api('/api/repository-mappings', { method: 'POST', body: JSON.stringify({ repository: values.repository, project: values.project, contextPaths }) });
    byId('mapping-dialog').close(); formElement.reset(); await load(); navigate('agents');
  } catch (error) { showError(error); }
});

byId('board').addEventListener('click', async (event) => {
  if (Date.now() - boardDragEndedAt < 250) return;
  const button = event.target.closest('[data-change]');
  if (button) {
    const task = state.board.tasks.find((item) => item.id === button.dataset.change);
    if (!task) return;
    byId('change-task-id').value = task.id;
    byId('change-proposal-id').value = '';
    byId('change-status').value = task.status;
    byId('change-owner').value = task.owner || '';
    byId('change-dialog').showModal();
    return;
  }
  const card = event.target.closest('[data-task]');
  if (!card) return;
  try { renderTaskDetail(await api('/api/tasks/' + encodeURIComponent(card.dataset.task))); }
  catch (error) { showError(error); }
});

byId('task-detail-content').addEventListener('submit', async (event) => {
  if (event.target.id !== 'outcome-contract-form') return;
  event.preventDefault();
  const form = event.target;
  const values = Object.fromEntries(new FormData(form));
  let criteria;
  try {
    criteria = JSON.parse(String(values.criteria));
    if (!Array.isArray(criteria) || criteria.length === 0) throw new Error('Add at least one criterion.');
  } catch (error) { showError(error); return; }
  const button = form.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/tasks/' + encodeURIComponent(form.dataset.taskId) + '/outcome-contract-proposals', {
      method: 'POST', body: JSON.stringify({ baseRevision: Number(form.dataset.taskVersion),
        contract: { statement: String(values.statement).trim(), scope: String(values.scope).trim(),
          exclusions: String(values.exclusions).split('\n').map((line) => line.trim()).filter(Boolean), criteria },
        rationale: String(values.rationale).trim(), evidenceIds: [] })
    });
    byId('task-detail-dialog').close();
    await load();
    navigate('review');
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

byId('board').addEventListener('dragstart', (event) => {
  const card = event.target.closest('[data-task]');
  if (!card || !event.dataTransfer) return;
  draggedTaskId = card.dataset.task;
  card.classList.add('dragging');
  card.setAttribute('aria-grabbed', 'true');
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', draggedTaskId);
  byId('board-status').textContent = 'Moving ' + (card.querySelector('h4')?.textContent || 'task') + '. Choose a destination column.';
});

byId('board').addEventListener('dragover', (event) => {
  const lane = event.target.closest('[data-lane]');
  if (!lane || !draggedTaskId) return;
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.lane.drag-over').forEach((item) => { if (item !== lane) item.classList.remove('drag-over'); });
  lane.classList.add('drag-over');
});

byId('board').addEventListener('dragleave', (event) => {
  const lane = event.target.closest('[data-lane]');
  if (lane && !lane.contains(event.relatedTarget)) lane.classList.remove('drag-over');
});

byId('board').addEventListener('dragend', () => {
  boardDragEndedAt = Date.now();
  draggedTaskId = null;
  document.querySelectorAll('.task-card.dragging').forEach((card) => { card.classList.remove('dragging'); card.setAttribute('aria-grabbed', 'false'); });
  document.querySelectorAll('.lane.drag-over').forEach((lane) => lane.classList.remove('drag-over'));
});

byId('board').addEventListener('drop', async (event) => {
  const lane = event.target.closest('[data-lane]');
  const taskId = draggedTaskId || event.dataTransfer?.getData('text/plain');
  if (!lane || !taskId) return;
  event.preventDefault();
  lane.classList.remove('drag-over');
  const task = state.board.tasks.find((item) => item.id === taskId);
  const nextStatus = statusForLane[lane.dataset.lane];
  if (!task || !nextStatus) return;
  if (task.status === nextStatus || laneFor(task.status) === lane.dataset.lane) {
    byId('board-status').textContent = task.title + ' is already in ' + lane.querySelector('h3').textContent + '.';
    return;
  }
  const card = byId('board').querySelector('[data-task="' + CSS.escape(task.id) + '"]');
  card?.classList.add('drag-saving');
  lane.classList.add('drop-saving');
  byId('board-status').textContent = 'Saving ' + task.title + '.';
  try {
    const response = await api('/api/tasks/' + encodeURIComponent(task.id) + '/proposals', {
      method: 'POST',
      body: JSON.stringify({
        baseRevision: task.version,
        changes: { status: nextStatus },
        rationale: 'Moved on the task board from ' + task.status.replaceAll('_', ' ') + ' to ' + nextStatus.replaceAll('_', ' ') + '.'
      })
    });
    if (response.proposal?.state === 'pending') {
      await api('/api/proposals/' + encodeURIComponent(response.proposal.id) + '/approve', {
        method: 'POST', body: JSON.stringify({ note: 'Applied from task board drag and drop; revision history retained.' })
      });
    }
    await load();
    navigate('work');
    byId('board-status').textContent = task.title + ' moved to ' + lane.querySelector('h3')?.textContent + '.';
  } catch (error) {
    card?.classList.remove('drag-saving');
    lane.classList.remove('drop-saving');
    byId('board-status').textContent = 'Could not move ' + task.title + '.';
    showError(error);
  }
});

byId('projects').addEventListener('click', async (event) => {
  const go = event.target.closest('[data-go-view]');
  if (go) { navigate(go.dataset.goView); return; }
  const projectButton = event.target.closest('[data-project]');
  if (projectButton) { state.selectedProjectId = projectButton.dataset.project; renderProjects(); return; }
  const history = event.target.closest('[data-history-subject]');
  if (history) { await openHistorySubject(history.dataset.historyType, history.dataset.historySubject); return; }
  const edit = event.target.closest('[data-edit-project]');
  if (edit) {
    const project = state.workGraph.projects.find((item) => item.id === edit.dataset.editProject);
    if (!project) return;
    const form = byId('project-form');
    form.dataset.projectId = project.id;
    byId('project-name').value = project.name;
    byId('project-outcome').value = project.outcome;
    byId('project-owner').value = project.owner || '';
    byId('project-dialog-title').textContent = 'Edit project';
    byId('project-submit').textContent = 'Save project';
    byId('project-dialog').showModal();
    return;
  }
  const task = event.target.closest('[data-task]');
  if (!task) return;
  try { renderTaskDetail(await api('/api/tasks/' + encodeURIComponent(task.dataset.task))); }
  catch (error) { showError(error); }
});

for (const containerId of ['people', 'company-blockers']) {
  byId(containerId).addEventListener('click', async (event) => {
    const task = event.target.closest('[data-task]');
    if (!task) return;
    try { renderTaskDetail(await api('/api/tasks/' + encodeURIComponent(task.dataset.task))); }
    catch (error) { showError(error); }
  });
}

byId('company-outcomes').addEventListener('click', (event) => {
  const project = event.target.closest('[data-project-name]');
  if (project) navigate('projects');
});

byId('change-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const formElement = event.currentTarget;
  const values = Object.fromEntries(new FormData(formElement));
  const task = state.board.tasks.find((item) => item.id === values.taskId);
  const owner = values.owner || null;
  const changes = {};
  if (task && values.status !== task.status) changes.status = values.status;
  if (task && owner !== task.owner) changes.owner = owner;
  if (!Object.keys(changes).length) return showError(new Error('Change the status or owner before submitting.'));
  try {
    const path = values.proposalId
      ? '/api/proposals/' + encodeURIComponent(values.proposalId) + '/edit'
      : '/api/tasks/' + encodeURIComponent(values.taskId) + '/proposals';
    const payload = values.proposalId
      ? { changes, rationale: values.rationale }
      : { baseRevision: task.version, changes, rationale: values.rationale };
    const response = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    if (!values.proposalId && response.proposal && response.proposal.state === 'pending') {
      await api('/api/proposals/' + encodeURIComponent(response.proposal.id) + '/approve', {
        method: 'POST', body: JSON.stringify({ note: 'Applied from the workspace UI; revision history retained.' })
      });
    }
    byId('change-dialog').close();
    formElement.reset();
    await load();
    navigate('work');
  } catch (error) { showError(error); }
});

byId('assessment-decision-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const id = byId('assessment-decision-id').value;
  const note = byId('assessment-decision-reason').value.trim();
  if (!id || note.length < 3) return;
  const submit = byId('assessment-decision-submit');
  submit.disabled = true;
  try {
    await api('/api/proposals/' + encodeURIComponent(id) + '/approve', {
      method: 'POST', body: JSON.stringify({ note })
    });
    byId('assessment-decision-dialog').close();
    byId('assessment-decision-form').reset();
    await load();
  } catch (error) { showError(error); }
  finally { submit.disabled = false; }
});

byId('proposals').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  if (button.dataset.proposalEvidence || button.dataset.projectEvidence) {
    void openEvidence(button.dataset.proposalEvidence || button.dataset.projectEvidence);
    return;
  }
  const projectId = button.dataset.projectApprove || button.dataset.projectReject;
  if (projectId) {
    button.disabled = true;
    try {
      await api('/api/project-proposals/' + encodeURIComponent(projectId) + '/' + (button.dataset.projectApprove ? 'approve' : 'reject'), { method: 'POST', body: JSON.stringify({ note: null }) });
      await load();
    } catch (error) { showError(error); button.disabled = false; }
    return;
  }
  const id = button.dataset.approve || button.dataset.reject || button.dataset.supersede || button.dataset.rebase || button.dataset.edit;
  if (!id) return;
  if (button.dataset.edit) {
    const detail = state.proposalDetails[id];
    if (!detail || !detail.before) return;
    byId('change-task-id').value = detail.before.id;
    byId('change-proposal-id').value = id;
    byId('change-status').value = detail.proposal.changes.status || detail.before.status;
    byId('change-owner').value = detail.proposal.changes.owner === null ? '' : (detail.proposal.changes.owner || detail.before.owner || '');
    byId('change-rationale').value = detail.proposal.rationale;
    byId('change-dialog').showModal();
    return;
  }
  if (button.dataset.approve && state.proposalDetails[id]?.proposal?.assessmentId) {
    byId('assessment-decision-id').value = id;
    byId('assessment-decision-reason').value = '';
    byId('assessment-decision-dialog').showModal();
    return;
  }
  button.disabled = true;
  try {
    const action = button.dataset.approve ? 'approve' : button.dataset.reject ? 'reject' : button.dataset.rebase ? 'rebase' : 'supersede';
    await api('/api/proposals/' + encodeURIComponent(id) + '/' + action, {
      method: 'POST', body: JSON.stringify({ actor: 'board-user' })
    });
    await load();
  } catch (error) { showError(error); button.disabled = false; }
});

byId('integrations').addEventListener('click', async (event) => {
  const button = event.target.closest('button');
  if (!button) return;
  const id = button.dataset.installationDisable || button.dataset.installationRevoke;
  if (!id) return;
  const status = button.dataset.installationRevoke ? 'revoked' : 'disabled';
  if (!confirm((status === 'revoked' ? 'Revoke' : 'Disable') + ' this integration?')) return;
  try { await api('/api/installations/' + encodeURIComponent(id), { method: 'PATCH', body: JSON.stringify({ status }) }); await load(); }
  catch (error) { showError(error); }
});

byId('devices').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-device-revoke]');
  if (!button || !confirm('Revoke this device? Queued reports will no longer be accepted.')) return;
  try { await api('/api/devices/' + encodeURIComponent(button.dataset.deviceRevoke) + '/revoke', { method: 'POST', body: '{}' }); await load(); }
  catch (error) { showError(error); }
});

byId('task-detail-content').addEventListener('click', async (event) => {
  const button = event.target.closest('[data-task-undo]');
  if (!button || !confirm('Create a new revision restoring the prior accepted values?')) return;
  try {
    await api('/api/tasks/' + encodeURIComponent(button.dataset.taskUndo) + '/undo', { method: 'POST', body: JSON.stringify({ actor: 'board-user' }) });
    byId('task-detail-dialog').close(); await load();
  } catch (error) { showError(error); }
});

byId('sync').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.innerHTML = '<i class="ph ph-circle-notch spin" aria-hidden="true"></i>Syncing';
  try {
    await api('/api/notion/sync', { method: 'POST', body: '{}' });
    await load();
  } catch (error) { showError(error); }
  finally { button.disabled = false; button.innerHTML = '<i class="ph ph-arrows-clockwise" aria-hidden="true"></i>Sync sources'; }
});

byId('analyze').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.innerHTML = '<i class="ph ph-circle-notch spin" aria-hidden="true"></i>Analyzing';
  try {
    const report = await api('/api/intelligence/run', { method: 'POST', body: '{}' });
    await load();
    if (report.state === 'completed') navigate('review');
  } catch (error) { showError(error); }
  finally { button.disabled = false; button.innerHTML = '<i class="ph ph-magic-wand" aria-hidden="true"></i>Analyze evidence'; }
});

establishSession().then(async () => {
  await load();
  if (accountsEnabled && state.account) {
    const current = viewByPath[window.location.pathname];
    if (current === 'settings') await loadSettings();
    if (current === 'onboarding') await loadOnboarding();
    if (current === 'integrations' && !isAdmin()) navigate('settings');
  }
  const params = new URLSearchParams(window.location.search);
  if (params.has('githubError')) showError(new Error('GitHub authorization did not complete. Try connecting again.'));
  if (params.has('githubSelection')) {
    navigate('integrations');
    try { await openGithubConnection(params.get('githubSelection')); }
    catch (error) { showError(error); }
  }
  if (params.has('githubError') || params.has('githubSelection')) window.history.replaceState(null, '', window.location.pathname);
}).catch(showError);
`;
