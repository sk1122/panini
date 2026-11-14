/*
 * Panini web app. Compiled by tsc (tsconfig.client.json) into dist/client/app.js
 * and inlined into the app shell with the page's CSP nonce.
 */

/** Elements the app reads by id: inputs, dialogs, forms and selects share one shape. */
type AppElement = HTMLElement &
	HTMLInputElement &
	HTMLDialogElement &
	HTMLFormElement &
	HTMLSelectElement;

const state = {
	changes: [],
	home: null,
	reconcile: null,
	agentSummary: null,
	selectedSessionId: null,
	board: null,
	workGraph: null,
	company: null,
	people: null,
	history: null,
	context: null,
	sourceDocuments: [],
	sourceDocumentsAll: [],
	contextMode: "accepted",
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
	csrf: "",
	account: null,
	sessionPromise: null,
	sessionResolve: null,
	sessionReject: null,
};

const byId = (id: string) => document.getElementById(id) as AppElement;

/** A form's fields as strings; the app has no file inputs. */
const formValues = (form: HTMLFormElement): Record<string, string> =>
	Object.fromEntries(
		[...new FormData(form).entries()].map(([key, value]) => [
			key,
			String(value),
		]),
	);

const accountsEnabled = document.body.dataset.authMode === "accounts";

const isAdmin = () =>
	!accountsEnabled ||
	["owner", "admin"].includes(state.account?.identity?.role);

const canReview = () =>
	!accountsEnabled ||
	["owner", "admin", "reviewer"].includes(state.account?.identity?.role);

const esc = (value) =>
	String(value ?? "").replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character],
	);

// "member:<id>" and "agent:<id>:<name>" read as the person's or agent's name.
const who = (value) =>
	String(value ?? "")
		.replace(/agent:[0-9a-f-]{36}:([^;,.]+?)(?=[;,.]|$)/gi, "$1")
		.replace(
			/member:([0-9a-f-]{36})/gi,
			(match, id) =>
				(state.workspace?.members || []).find(
					(member) => member.id === id,
				)?.displayName || "a member",
		);

const compact = (value, maximum = 160) => {
	const text =
		typeof value === "object" ? JSON.stringify(value) : String(value ?? "");

	return text.length > maximum ? text.slice(0, maximum - 1) + "…" : text;
};

const formatDate = (value, includeTime = true) => {
	if (!value) return "Unknown";

	const date = new Date(value);

	if (Number.isNaN(date.valueOf())) return String(value);
	return includeTime
		? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })
		: date.toLocaleDateString([], { dateStyle: "medium" });
};

const localDateTimeValue = (value) => {
	if (!value) return "";

	const date = new Date(value);

	if (Number.isNaN(date.valueOf())) return "";

	const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);

	return local.toISOString().slice(0, 16);
};

async function api(
	path: string,
	options: Omit<RequestInit, "headers"> & {
		headers?: Record<string, string>;
	} = {},
) {
	const headers: Record<string, string> = {
		...(options.body === undefined
			? {}
			: { "content-type": "application/json" }),
		...(options.headers || {}),
	};
	const method = String(options.method || "GET").toUpperCase();

	if (!["GET", "HEAD"].includes(method) && !headers["idempotency-key"])
		headers["idempotency-key"] = crypto.randomUUID();
	if (state.csrf && !["GET", "HEAD"].includes(method))
		headers["x-panini-csrf"] = state.csrf;

	const requestOptions = { ...options, headers };
	const response = await fetch(path, requestOptions);

	if (response.status === 401) {
		if (accountsEnabled) {
			returnToLogin();
			throw new Error("Your session ended. Please sign in again.");
		}
		await establishSession();
		return api(path, requestOptions);
	}

	const body = await response.json().catch(() => ({
		error: "The server returned an unreadable response.",
	}));

	if (!response.ok) throw new Error(body.error || "Request failed.");
	return body;
}

async function performSessionHandshake() {
	let response = await fetch("/api/session", {
		headers: { accept: "application/json" },
	});

	if (response.status === 401) {
		if (accountsEnabled) {
			returnToLogin();
			throw new Error("Please sign in.");
		}
		byId("session-error").hidden = true;
		byId("session-token").value = "";
		byId("session-dialog").showModal();
		return new Promise((resolve, reject) => {
			state.sessionResolve = resolve;
			state.sessionReject = reject;
			queueMicrotask(() => byId("session-token").focus());
		});
	}

	const body = await response
		.json()
		.catch(() => ({ error: "The session response was unreadable." }));

	if (!response.ok)
		throw new Error(body.error || "Administrator sign-in failed.");
	state.csrf = body.csrf || "";
	if (accountsEnabled) {
		state.account = body;
		renderAccount();
	}
}

function returnToLogin() {
	document.body.classList.add("session-expired");
	window.location.replace(
		"/login?next=" +
			encodeURIComponent(
				window.location.pathname + window.location.search,
			),
	);
}

function renderAccount() {
	document
		.querySelectorAll<AppElement>("[data-account-only]")
		.forEach((element) => {
			element.hidden = !accountsEnabled;
		});
	document
		.querySelectorAll<AppElement>("[data-admin-only]")
		.forEach((element) => {
			element.hidden = !isAdmin();
		});
	document
		.querySelectorAll<AppElement>("[data-owner-only]")
		.forEach((element) => {
			element.hidden = state.account?.identity?.role !== "owner";
		});
	if (!state.account) return;

	const user = state.account.identity;
	const company = state.account.organization;

	byId("user-name").textContent = user.displayName;
	byId("user-role").textContent = user.role;
	byId("user-avatar").textContent = user.displayName
		.slice(0, 1)
		.toUpperCase();
	byId("workspace-name").textContent = company.name;
	byId("workspace-avatar").textContent = company.name
		.slice(0, 1)
		.toUpperCase();
	if (!byId("profile-name").dataset.dirty)
		byId("profile-name").value = user.displayName;
	byId("profile-email").value = user.email;
	if (!byId("settings-company-name").dataset.dirty)
		byId("settings-company-name").value = company.name;
	document.title = company.name + " | Panini";

	const methods = state.account.authentication;

	byId("github-account-section").hidden =
		!methods?.githubEnabled && !methods?.github;
	byId("github-account-status").textContent = methods?.github
		? "Connected as " + methods.github.login + "."
		: "GitHub is not connected to your personal account.";
	byId("connect-github-account").hidden =
		Boolean(methods?.github) || !methods?.githubEnabled;
	byId("disconnect-github-account").hidden = !methods?.github;
	byId("disconnect-github-account").disabled = !methods?.hasPassword;
	if (methods?.github && !methods.hasPassword)
		byId("github-account-status").textContent +=
			" Set a password before disconnecting GitHub.";
	byId("current-password").required = methods?.hasPassword !== false;
	byId("current-password").closest<AppElement>(".field").hidden =
		methods?.hasPassword === false;
}

function applyRoleControls() {
	renderAccount();
	for (const id of [
		"new-context",
		"new-mapping",
		"sync",
		"connect-github",
		"new-integration",
	]) {
		byId(id).hidden = id === "new-context" ? !canReview() : !isAdmin();
	}
	document
		.querySelectorAll<AppElement>(".task-card[draggable]")
		.forEach((card) => {
			card.draggable = canReview();
		});
	document
		.querySelectorAll<AppElement>(
			"[data-edit-project], [data-project-edit], [data-task-undo], [data-context-lifecycle]",
		)
		.forEach((button) => {
			button.hidden = !canReview();
		});
}

function establishSession() {
	if (state.sessionPromise) return state.sessionPromise;
	state.sessionPromise = performSessionHandshake().finally(() => {
		state.sessionPromise = null;
	});
	return state.sessionPromise;
}

function showError(error) {
	byId("alert-copy").textContent =
		error instanceof Error ? error.message : String(error);
	byId("alert").classList.add("show");
}

function clearError() {
	byId("alert").classList.remove("show");
}

function settingsStatus(id, message, error = false) {
	const element = byId(id);

	element.textContent = message;
	element.classList.toggle("is-error", error);
}

function renderModelSettings(info) {
	const current = info.current;
	const chosen = current?.model || info.models[0].id;

	byId("model-current").innerHTML = info.setByServer
		? "The server sets the model (" +
			esc(info.setByServer.model) +
			"). Change it in the server's environment."
		: current
			? "<strong>On.</strong> " +
				esc(
					info.models.find((m) => m.id === current.model)?.label ||
						current.model,
				) +
				", key ending " +
				esc(current.keyHint) +
				". Set by " +
				esc(who(current.updatedBy)) +
				"."
			: "<strong>Off.</strong> Agents still claim, report and hand off work without it.";
	byId("model-choices").innerHTML =
		"<legend>Model</legend>" +
		info.models
			.map(
				(model) =>
					'<label class="model-choice"><input type="radio" name="model" value="' +
					esc(model.id) +
					'"' +
					(model.id === chosen ? " checked" : "") +
					"><span><strong>" +
					esc(model.label) +
					"</strong> · " +
					esc(model.provider) +
					"<small>" +
					esc(model.note) +
					"</small></span></label>",
			)
			.join("");
	byId("model-off").hidden = !current;
	byId("model-form").hidden = Boolean(info.setByServer);
}

async function loadModelSettings() {
	renderModelSettings(await api("/api/settings/model"));
}

async function loadSettings() {
	if (!accountsEnabled || !state.account) return;
	renderAccount();
	if (!isAdmin()) return;
	void loadModelSettings().catch(showError);

	const [accounts, invitations] = await Promise.all([
		api("/api/members"),
		api("/api/invitations"),
	]);
	const owner = state.account.identity.role === "owner";

	byId("settings-members").innerHTML = accounts.members
		.map((member) => {
			const canManage =
				owner || !["owner", "admin"].includes(member.role);
			const options = (
				owner
					? ["member", "reviewer", "admin", "owner"]
					: ["member", "reviewer"]
			)
				.map(
					(role) =>
						'<option value="' +
						role +
						'"' +
						(member.role === role ? " selected" : "") +
						">" +
						role +
						"</option>",
				)
				.join("");

			return (
				'<div class="settings-member" data-member-row="' +
				esc(member.id) +
				'"><div><strong>' +
				esc(member.displayName) +
				(member.id === state.account.identity.memberId
					? " (you)"
					: "") +
				"</strong><small>" +
				esc(member.email) +
				"</small><small>" +
				esc(member.role) +
				" · " +
				esc(member.status) +
				"</small></div>" +
				(canManage
					? '<div class="member-controls"><select aria-label="Role for ' +
						esc(member.displayName) +
						'" data-member-role>' +
						options +
						'</select><select aria-label="Status for ' +
						esc(member.displayName) +
						'" data-member-status><option value="active"' +
						(member.status === "active" ? " selected" : "") +
						'>Active</option><option value="disabled"' +
						(member.status === "disabled" ? " selected" : "") +
						'>Disabled</option></select><button class="button quiet small" data-member-save="' +
						esc(member.id) +
						'">Save access</button>' +
						(member.status === "active"
							? '<button class="button quiet small" data-member-reset="' +
								esc(member.id) +
								'">Reset password</button>'
							: "") +
						"</div>"
					: '<span class="muted-copy">Managed by an owner</span>') +
				"</div>"
			);
		})
		.join("");
	byId("settings-invitations").innerHTML =
		invitations.invitations
			.map((invite) => {
				const active =
					!invite.consumedAt &&
					!invite.revokedAt &&
					new Date(invite.expiresAt) > new Date();
				const label = invite.consumedAt
					? "Accepted"
					: invite.revokedAt
						? "Revoked"
						: active
							? "Pending"
							: "Expired";

				return (
					'<div class="settings-member"><div><strong>' +
					esc(invite.email) +
					"</strong><small>" +
					esc(invite.role) +
					" · " +
					label +
					" · Expires " +
					esc(formatDate(invite.expiresAt)) +
					"</small></div>" +
					(active &&
					(owner || !["owner", "admin"].includes(invite.role))
						? '<button class="button quiet small" data-invite-revoke="' +
							esc(invite.id) +
							'">Revoke</button>'
						: "") +
					"</div>"
				);
			})
			.join("") || '<p class="muted-copy">No invitations yet.</p>';
}

async function loadOnboarding() {
	if (!accountsEnabled || !state.account) return;

	const status = await api("/api/onboarding");
	const model = isAdmin()
		? await api("/api/settings/model").catch(() => null)
		: null;
	const modelOn = Boolean(model?.current || model?.setByServer);

	byId("onboarding-title").textContent =
		"Welcome to " + status.organization.name;

	const step = (index, title, description, done, action, target) =>
		'<section class="onboarding-step"><span class="onboarding-number' +
		(done ? " complete" : "") +
		'">' +
		(done ? '<i class="ph ph-check" aria-hidden="true"></i>' : index) +
		"</span><div><h2>" +
		esc(title) +
		"</h2><p>" +
		esc(description) +
		"</p><small>" +
		(done ? "Complete" : "Optional next step") +
		'</small></div><a class="button quiet" href="' +
		pathByView[target] +
		'" data-onboard-view="' +
		target +
		'">' +
		esc(action) +
		"</a></section>";

	byId("onboarding-steps").innerHTML =
		step(
			1,
			"Your account and company",
			"You are signed in as " + state.account.identity.displayName + ".",
			status.profileComplete,
			"View settings",
			"settings",
		) +
		(isAdmin()
			? step(
					2,
					"Invite your team",
					"Share an invitation with each person who needs access. You choose their role.",
					status.teamInvited,
					"Invite people",
					"settings",
				) +
				step(
					3,
					"Connect company sources",
					status.sourceConnected
						? "A connected source has completed a successful sync."
						: "Choose the information Panini can read from your company tools.",
					status.sourceConnected,
					"Connect sources",
					"integrations",
				) +
				step(
					4,
					"Choose the nightly run model",
					modelOn
						? "The nightly run is on. Panini reads new chat each night and updates tasks and context."
						: "Pick a model and paste your own API key. Without it, agents still work; chat is not read.",
					modelOn,
					modelOn ? "View model" : "Choose model",
					"settings",
				)
			: "") +
		step(
			isAdmin() ? 5 : 2,
			"Connect your agent",
			status.agentConnected
				? "Your agent has made an authenticated connection."
				: status.agentCreated
					? "A profile is ready. Connect your client, then refresh to verify it."
					: "Create a personal profile, copy its secret, and connect your client.",
			status.agentConnected,
			status.agentCreated ? "View agents" : "Set up an agent",
			"agents",
		);
}

function bindSettingsForm(formId, statusId, action) {
	byId(formId).addEventListener("submit", async (event) => {
		event.preventDefault();

		const button = (
			event.currentTarget as AppElement
		).querySelector<AppElement>('button[type="submit"]');

		button.disabled = true;
		settingsStatus(statusId, "Saving…");
		try {
			await action(formValues(event.currentTarget as AppElement));
		} catch (error) {
			settingsStatus(statusId, error.message || "Unable to save.", true);
		} finally {
			button.disabled = false;
		}
	});
}

for (const id of ["profile-name", "settings-company-name"]) {
	byId(id).addEventListener("input", () => {
		byId(id).dataset.dirty = "true";
	});
}
bindSettingsForm("profile-form", "profile-status", async (body) => {
	const result = await api("/api/account", {
		method: "PATCH",
		body: JSON.stringify(body),
	});

	state.account.identity = { ...state.account.identity, ...result.member };
	delete byId("profile-name").dataset.dirty;
	renderAccount();
	settingsStatus("profile-status", "Profile saved.");
});
bindSettingsForm("model-form", "model-status", async (body) => {
	settingsStatus("model-status", "Checking the key with the provider…");
	await api("/api/settings/model", {
		method: "PUT",
		body: JSON.stringify({ model: body.model, apiKey: body.apiKey }),
	});
	(byId("model-key") as HTMLInputElement).value = "";
	await loadModelSettings();
	settingsStatus("model-status", "Saved. The nightly run is on.");
});
byId("model-off").addEventListener("click", async () => {
	try {
		await api("/api/settings/model", { method: "DELETE" });
		await loadModelSettings();
		settingsStatus("model-status", "Turned off. The key was deleted.");
	} catch (error) {
		settingsStatus(
			"model-status",
			error.message || "Unable to turn off.",
			true,
		);
	}
});
bindSettingsForm("company-form", "company-status", async (body) => {
	const result = await api("/api/workspace/settings", {
		method: "PATCH",
		body: JSON.stringify(body),
	});

	state.account.organization = result.organization;
	delete byId("settings-company-name").dataset.dirty;
	renderAccount();
	settingsStatus("company-status", "Company saved.");
});
bindSettingsForm("password-form", "password-status", async (body) => {
	const result = await api("/api/account/password", {
		method: "POST",
		body: JSON.stringify(body),
	});

	state.account = result;
	state.csrf = result.csrf;
	byId("password-form").reset();
	renderAccount();
	settingsStatus(
		"password-status",
		"Password changed. Other sessions have been signed out.",
	);
});
byId("connect-github-account").addEventListener("click", async (event) => {
	(event.currentTarget as AppElement).disabled = true;
	try {
		const result = await api("/api/account/github/start", {
			method: "POST",
			body: "{}",
		});

		window.location.assign(result.authorizationUrl);
	} catch (error) {
		showError(error);
		(event.currentTarget as AppElement).disabled = false;
	}
});
byId("disconnect-github-account").addEventListener("click", async () => {
	try {
		const result = await api("/api/account/github", { method: "DELETE" });

		state.account = result;
		state.csrf = result.csrf;
		renderAccount();
	} catch (error) {
		showError(error);
	}
});
bindSettingsForm("invite-form", "invite-status", async (body) => {
	const result = await api("/api/invitations", {
		method: "POST",
		body: JSON.stringify(body),
	});

	byId("invite-link").value = result.url;
	byId("invite-result").hidden = false;
	settingsStatus(
		"invite-status",
		"Invitation created. Share the link privately.",
	);
	await loadSettings();
});
document
	.querySelector<AppElement>("[data-copy-invite]")
	.addEventListener("click", async () => {
		try {
			await navigator.clipboard.writeText(byId("invite-link").value);
			settingsStatus("invite-status", "Link copied.");
		} catch {
			byId("invite-link").select();
			settingsStatus("invite-status", "Select and copy the link.");
		}
	});
byId("settings-members").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-member-save], [data-member-reset]",
	);

	if (!button) return;
	button.disabled = true;
	try {
		if (button.dataset.memberSave) {
			const row = button.closest<AppElement>("[data-member-row]");
			const body = {
				role: row.querySelector<AppElement>("[data-member-role]").value,
				status: row.querySelector<AppElement>("[data-member-status]")
					.value,
			};

			if (
				body.status === "disabled" &&
				!confirm(
					"Disable this account? Its sessions and agent access will stop immediately.",
				)
			)
				return;
			await api("/api/members/" + button.dataset.memberSave, {
				method: "PATCH",
				body: JSON.stringify(body),
			});
			settingsStatus(
				"members-status",
				"Access updated. Existing sessions were signed out.",
			);
			if (button.dataset.memberSave === state.account.identity.memberId)
				return returnToLogin();
			await loadSettings();
		} else {
			const result = await api(
				"/api/members/" +
					button.dataset.memberReset +
					"/reset-password",
				{ method: "POST", body: "{}" },
			);

			byId("recovery-link").value = result.url;
			byId("recovery-result").hidden = false;
			settingsStatus(
				"members-status",
				"Reset link created. Share it privately with this person.",
			);
		}
	} catch (error) {
		settingsStatus("members-status", error.message, true);
	} finally {
		button.disabled = false;
	}
});
byId("settings-invitations").addEventListener("click", async (event) => {
	const button = (event.target as AppElement).closest<AppElement>(
		"[data-invite-revoke]",
	);

	if (!button) return;
	button.disabled = true;
	try {
		await api("/api/invitations/" + button.dataset.inviteRevoke, {
			method: "DELETE",
		});
		await loadSettings();
	} catch (error) {
		showError(error);
	} finally {
		button.disabled = false;
	}
});
byId("onboarding-steps").addEventListener("click", (event) => {
	const link = (event.target as AppElement).closest<AppElement>(
		"[data-onboard-view]",
	);

	if (
		!link ||
		event.metaKey ||
		event.ctrlKey ||
		event.shiftKey ||
		event.altKey
	)
		return;
	event.preventDefault();
	navigate(link.dataset.onboardView);
});
byId("finish-onboarding").addEventListener("click", async (event) => {
	(event.currentTarget as AppElement).disabled = true;
	try {
		state.account.onboarding = await api("/api/onboarding/complete", {
			method: "POST",
			body: "{}",
		});
		navigate("home");
	} catch (error) {
		showError(error);
	} finally {
		byId("finish-onboarding").disabled = false;
	}
});
byId("refresh-onboarding").addEventListener(
	"click",
	() => void loadOnboarding().catch(showError),
);

const accountChannel =
	accountsEnabled && typeof BroadcastChannel !== "undefined"
		? new BroadcastChannel("panini-account")
		: null;

if (accountChannel) accountChannel.onmessage = () => returnToLogin();
document.querySelectorAll<AppElement>("[data-sign-out]").forEach((button) =>
	button.addEventListener("click", async () => {
		button.disabled = true;
		try {
			await api("/api/auth/logout", { method: "POST", body: "{}" });
			accountChannel?.postMessage("logout");
			returnToLogin();
		} catch (error) {
			showError(error);
			button.disabled = false;
		}
	}),
);
window.addEventListener("focus", () => {
	if (!accountsEnabled || !state.account) return;
	fetch("/api/session")
		.then((response) => {
			if (response.status === 401) returnToLogin();
		})
		.catch(() => {});
});

const lanes = [
	["queued", "To do"],
	["active", "In progress"],
	["checkpoint", "Blocked or in review"],
	["closed", "Done"],
];
const statusForLane = {
	queued: "planned",
	active: "in_progress",
	checkpoint: "review",
	closed: "done",
};
let draggedTaskId = null;
let boardDragEndedAt = 0;
