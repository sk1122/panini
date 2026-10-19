import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { TeamLedger } from "../domain/team-ledger.js";
import type { Member } from "../domain/types.js";
import type { AccessScope } from "../domain/access.js";
import {
	AuthError,
	type BrowserSession,
	IdentityService,
	isAdministrator,
	type SessionGrant,
	type GithubLoginIntent,
	SESSION_SECONDS,
} from "../security/identity.js";
import { PayloadCipher } from "../security/payload-cipher.js";
import type { GithubAppClient } from "../connectors/github/app-client.js";
import type { JsonValue } from "../domain/types.js";

export const browserCookie = "panini_session";
export const emailSchema = z
	.string()
	.trim()
	.email()
	.max(254)
	.transform((value) => value.toLowerCase());

const passwordSchema = z
	.string()
	.min(15, "Use at least 15 characters for your password.")
	.max(128);
const nameSchema = z.string().trim().min(1).max(120);
const tokenSchema = z.string().min(32).max(200);
const roles = z.enum(["owner", "admin", "reviewer", "member"]);

export function safeCookie(
	request: FastifyRequest,
	name: string,
): string | null {
	const value = request.headers.cookie
		?.split(";")
		.map((part) => part.trim())
		.find((part) => part.startsWith(`${name}=`));

	if (!value) return null;
	try {
		return decodeURIComponent(value.slice(name.length + 1));
	} catch {
		return null;
	}
}

export function equalSecret(
	left: string | undefined | null,
	right: string,
): boolean {
	if (!left) return false;

	const a = Buffer.from(left);
	const b = Buffer.from(right);

	return a.length === b.length && timingSafeEqual(a, b);
}

export function safeReturnPath(value: unknown): string {
	return typeof value === "string" && /^\/app(?:\/[a-z-]+)?$/.test(value)
		? value
		: "/app/projects";
}

export function isGithubLoginCallback(request: FastifyRequest): boolean {
	return (
		request.url.split("?")[0] === "/api/github/oauth/callback" &&
		new URL(request.url, "http://panini.invalid").searchParams
			.get("state")
			?.startsWith("panini_login_") === true
	);
}

export function installIdentityRoutes(
	app: FastifyInstance,
	options: {
		identity: IdentityService;
		ledger: TeamLedger;
		publicUrl: string;
		adminToken: string;
		github?: GithubAppClient;
		encryptionKey?: string;
	},
) {
	const { identity, ledger } = options;
	const origin = new URL(options.publicUrl).origin;
	const secure = new URL(origin).protocol === "https:";
	const sessions = new WeakMap<FastifyRequest, BrowserSession>();
	const serviceMembers = new WeakMap<FastifyRequest, Member>();
	const publicRoutes = new Set([
		"/api/auth/status",
		"/api/auth/bootstrap",
		"/api/auth/login",
		"/api/auth/invitations/accept",
		"/api/auth/reset-password",
		"/api/auth/github/start",
	]);
	const anonymousApi = new Set([
		"/api/webhooks/github",
		"/api/relay/work-reports",
	]);
	const address = new URL(origin);
	const loopback = new Set(["localhost", "127.0.0.1", "[::1]"]);
	const allowedOrigins = new Set([origin]);

	if (loopback.has(address.hostname)) {
		for (const host of loopback) {
			const alias = new URL(origin);

			alias.hostname = host;
			allowedOrigins.add(alias.origin);
		}
	}

	const githubEnabled = Boolean(
		options.github &&
		options.encryptionKey &&
		new URL(options.github.credentials.callbackUrl).origin === origin,
	);
	const cipher = options.encryptionKey
		? new PayloadCipher(options.encryptionKey)
		: null;
	const githubCookie = "panini_github_flow";

	type GithubFlow = {
		intent: GithubLoginIntent;
		verifier: string;
		next: string;
	};

	function member(request: FastifyRequest): Member {
		const value =
			sessions.get(request)?.member ?? serviceMembers.get(request);

		if (!value) throw new AuthError("Please sign in.", 401);
		return value;
	}

	function session(request: FastifyRequest): BrowserSession {
		const value = sessions.get(request);

		if (!value) throw new AuthError("A browser session is required.", 401);
		return value;
	}

	function administrator(request: FastifyRequest): Member {
		const value = member(request);

		if (!isAdministrator(value))
			throw new AuthError("Only an administrator can do this.", 403);
		return value;
	}

	function access(request: FastifyRequest): AccessScope {
		const current = member(request);

		return isAdministrator(current)
			? { kind: "admin" }
			: {
					kind: "member",
					organizationId: current.organizationId,
					memberId: current.id,
				};
	}

	async function payload(value: BrowserSession) {
		const [organization, onboarding, authentication] = await Promise.all([
			identity.organization(),
			identity.onboarding(value.member.id),
			identity.authenticationMethods(value.member.id),
		]);

		return {
			authenticated: true,
			mode: "account",
			csrf: value.csrf,
			expiresAt: value.expiresAt,
			identity: { ...value.member, memberId: value.member.id },
			organization,
			onboarding,
			authentication: { ...authentication, githubEnabled },
		};
	}

	async function signedIn(reply: FastifyReply, grant: SessionGrant) {
		reply.header(
			"set-cookie",
			`${browserCookie}=${grant.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_SECONDS}${secure ? "; Secure" : ""}`,
		);
		return payload(grant.session);
	}

	app.addHook("onRequest", async (request, reply) => {
		const path = request.url.split("?")[0]!;

		if (
			path.startsWith("/api/") ||
			path.startsWith("/app") ||
			["/login", "/setup", "/join", "/reset-password"].includes(path)
		) {
			reply.header("cache-control", "no-store");
		}
		if (secure)
			reply.header("strict-transport-security", "max-age=31536000");

		// Keep browser cookies/OAuth callbacks on a single host. Accept same-port loopback
		// aliases for already-open local forms, never arbitrary Origin/Host values.
		const browserPage =
			path.startsWith("/app") ||
			["/login", "/setup", "/join", "/reset-password"].includes(path);
		const requestOrigin = `${address.protocol}//${request.headers.host}`;

		if (
			browserPage &&
			["GET", "HEAD"].includes(request.method) &&
			allowedOrigins.has(requestOrigin) &&
			requestOrigin !== origin
		) {
			return reply.redirect(`${origin}${request.url}`);
		}
		if (isGithubLoginCallback(request)) {
			reply.header("cache-control", "no-store");
			reply.header("referrer-policy", "no-referrer");
			return;
		}
		if (anonymousApi.has(path) || path === "/mcp") return;

		const isApi = path.startsWith("/api/");
		const isApp = path === "/app" || path.startsWith("/app/");

		if (!isApi && !isApp) return;
		if (isApi && !["GET", "HEAD", "OPTIONS"].includes(request.method)) {
			if (
				(request.headers.origin &&
					!allowedOrigins.has(request.headers.origin)) ||
				request.headers["sec-fetch-site"] === "cross-site"
			) {
				throw new AuthError(
					"This request must come from the Panini workspace.",
					403,
				);
			}
		}
		if (publicRoutes.has(path)) {
			if (request.method !== "GET")
				await identity.limit("auth-ip", request.ip, 60);
			return;
		}

		const authenticated = await identity.authenticate(
			safeCookie(request, browserCookie),
		);

		if (authenticated) sessions.set(request, authenticated);
		// The installation credential is a service credential, never a personal browser login.
		if (
			!authenticated &&
			isApi &&
			equalSecret(
				request.headers.authorization,
				`Bearer ${options.adminToken}`,
			)
		) {
			const owner = (await identity.listAccounts()).find(
				(account) =>
					account.role === "owner" && account.status === "active",
			);

			if (owner) serviceMembers.set(request, owner);
		}
		if (!authenticated && !serviceMembers.has(request)) {
			if (isApp) {
				const target = (await identity.isConfigured())
					? "/login"
					: "/setup";

				return reply.redirect(
					`${target}?next=${encodeURIComponent(safeReturnPath(path))}`,
				);
			}
			throw new AuthError("Please sign in.", 401);
		}
		if (
			authenticated &&
			isApi &&
			!["GET", "HEAD", "OPTIONS"].includes(request.method)
		) {
			const csrf = request.headers["x-panini-csrf"];

			if (
				typeof csrf !== "string" ||
				!equalSecret(csrf, authenticated.csrf)
			)
				throw new AuthError("Refresh the page and try again.", 403);
		}
	});

	app.addHook("preHandler", async (request) => {
		const path = request.url.split("?")[0]!;

		if (
			!path.startsWith("/api/") ||
			publicRoutes.has(path) ||
			anonymousApi.has(path) ||
			isGithubLoginCallback(request)
		)
			return;

		const current = member(request);

		if (isAdministrator(current)) return;

		const read = request.method === "GET" || request.method === "HEAD";
		const readPaths =
			/^\/api\/(session|account|onboarding|board|work-graph|workspace|company|people|history|context(?:\/.*)?|source-documents(?:\/.*)?|evidence\/(?:assessments\/[^/]+|events(?:\/[^/]+)?)|tasks\/[^/]+|projects\/[^/]+|proposals(?:\/[^/]+)?|project-proposals|agents(?:\/[^/]+\/setup)?|devices|repository-mappings)$/;
		const ownPaths =
			/^\/api\/(auth\/logout|session|account(?:\/password|\/github(?:\/start)?)?|onboarding\/complete|agents(?:\/[^/]+\/(rotate-secret|revoke|scope))?|devices(?:\/[^/]+\/revoke)?)$/;
		const taskPaths =
			/^\/api\/(tasks|projects|tasks\/[^/]+\/(?:proposals|outcome-contract-proposals)|project-proposals)$/;
		const reviewPaths =
			/^\/api\/(context\/entries(?:\/[^/]+\/lifecycle)?|proposals\/[^/]+\/(approve|reject|supersede|rebase|edit)|project-proposals\/[^/]+\/(approve|reject)|tasks\/[^/]+\/undo|projects\/[^/]+)$/;

		if (
			!(read
				? readPaths.test(path)
				: ownPaths.test(path) ||
					taskPaths.test(path) ||
					(current.role === "reviewer" && reviewPaths.test(path)))
		) {
			throw new AuthError("Your role does not allow this action.", 403);
		}

		const body = request.body as Record<string, unknown> | undefined;
		const agentId = /^\/api\/agents\/([^/]+)\//.exec(path)?.[1];

		if (agentId) {
			const profile = await ledger.getAgentProfile(agentId);

			if (!profile || profile.memberId !== current.id)
				throw new AuthError(
					"This agent belongs to another member.",
					403,
				);
		}
		if (
			(path === "/api/agents" && request.method === "POST") ||
			(/^\/api\/agents\/[^/]+\/scope$/.test(path) &&
				request.method === "PATCH")
		) {
			if (path === "/api/agents" && body?.memberId !== current.id)
				throw new AuthError(
					"You can only create your own agents.",
					403,
				);

			const scope = (path === "/api/agents" ? body?.dataScope : body) as
				{ sourceVisibilities?: unknown } | undefined;

			if (
				scope?.sourceVisibilities &&
				(!Array.isArray(scope.sourceVisibilities) ||
					scope.sourceVisibilities.some(
						(value) =>
							value !== "company" &&
							value !== `member:${current.id}`,
					))
			) {
				throw new AuthError(
					"An agent cannot receive visibility beyond your own access.",
					403,
				);
			}
		}
		if (path === "/api/devices" && request.method === "POST") {
			const profile =
				typeof body?.agentProfileId === "string"
					? await ledger.getAgentProfile(body.agentProfileId)
					: null;

			if (!profile || profile.memberId !== current.id)
				throw new AuthError(
					"You can only enroll devices for your own agents.",
					403,
				);
		}

		const deviceId = /^\/api\/devices\/([^/]+)\/revoke$/.exec(path)?.[1];

		if (deviceId) {
			const ownProfiles = new Set(
				(await ledger.listAgentProfiles(current.id)).map(
					(profile) => profile.id,
				),
			);
			const device = (await ledger.listDevices()).find(
				(item) => item.id === deviceId,
			);

			if (!device || !ownProfiles.has(device.agentProfileId))
				throw new AuthError(
					"This device belongs to another member.",
					403,
				);
		}

		const proposalId = /^\/api\/proposals\/([^/]+)/.exec(path)?.[1];

		if (proposalId)
			await ledger.getProposalForAccess(proposalId, access(request));

		const projectProposalId = /^\/api\/project-proposals\/([^/]+)/.exec(
			path,
		)?.[1];

		if (
			projectProposalId &&
			!(await ledger.listProjectProposals(access(request))).some(
				(proposal) => proposal.id === projectProposalId,
			)
		) {
			throw new AuthError(
				"This proposal is unavailable to your account.",
				403,
			);
		}

		const contextId = /^\/api\/context\/entries\/([^/]+)\/lifecycle$/.exec(
			path,
		)?.[1];

		if (contextId)
			await ledger.contextHistoryForAccess(contextId, access(request));
		if (!read && Array.isArray(body?.evidenceIds)) {
			for (const id of body.evidenceIds) {
				if (
					typeof id !== "string" ||
					!(await ledger.getSourceEventForAccess(id, access(request)))
				)
					throw new AuthError(
						"A source is unavailable to your account.",
						403,
					);
			}
		}
	});

	app.get("/api/auth/status", async () => ({
		setupRequired: !(await identity.isConfigured()),
		login: "password",
		githubEnabled,
		publicUrl: origin,
	}));
	app.post("/api/auth/bootstrap", async (request, reply) => {
		const body = z
			.object({
				token: z.string().min(1).max(500),
				companyName: z.string().trim().min(1).max(120),
				displayName: nameSchema,
				email: emailSchema,
				password: passwordSchema,
			})
			.strict()
			.parse(request.body);

		if (!equalSecret(body.token, options.adminToken))
			throw new AuthError("The installation secret is incorrect.", 401);
		return signedIn(reply, await identity.bootstrap(body));
	});
	app.post("/api/auth/login", async (request, reply) => {
		const body = z
			.object({
				email: emailSchema,
				password: z.string().min(1).max(128),
			})
			.strict()
			.parse(request.body);

		return signedIn(reply, await identity.login(body.email, body.password));
	});
	app.post("/api/auth/invitations/accept", async (request, reply) => {
		const body = z
			.object({
				token: tokenSchema,
				displayName: nameSchema,
				password: passwordSchema,
			})
			.strict()
			.parse(request.body);

		return signedIn(
			reply,
			await identity.acceptInvitation(
				body.token,
				body.displayName,
				body.password,
			),
		);
	});
	app.post("/api/auth/reset-password", async (request) => {
		const body = z
			.object({ token: tokenSchema, password: passwordSchema })
			.strict()
			.parse(request.body);

		await identity.resetPassword(body.token, body.password);
		return { ok: true };
	});
	app.get("/api/session", async (request) => payload(session(request)));
	app.get("/api/account", async (request) => payload(session(request)));

	async function logout(request: FastifyRequest, reply: FastifyReply) {
		await identity.logout(session(request));
		reply.header(
			"set-cookie",
			`${browserCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`,
		);
		return { authenticated: false };
	}

	app.post("/api/auth/logout", logout);
	app.delete("/api/session", logout);
	app.patch("/api/account", async (request) => {
		const body = z
			.object({ displayName: nameSchema })
			.strict()
			.parse(request.body);

		return {
			member: await identity.updateProfile(
				member(request).id,
				body.displayName,
			),
		};
	});
	app.post("/api/account/password", async (request, reply) => {
		const body = z
			.object({
				currentPassword: z.string().max(128).default(""),
				password: passwordSchema,
			})
			.strict()
			.parse(request.body);

		return signedIn(
			reply,
			await identity.changePassword(
				session(request),
				body.currentPassword,
				body.password,
			),
		);
	});
	app.patch("/api/workspace/settings", async (request) => {
		const body = z
			.object({ name: z.string().trim().min(1).max(120) })
			.strict()
			.parse(request.body);

		return {
			organization: await identity.updateCompany(
				administrator(request),
				body.name,
			),
		};
	});
	app.get("/api/onboarding", async (request) => {
		const current = member(request);
		const [onboarding, workspace, profiles] = await Promise.all([
			identity.onboarding(current.id),
			ledger.workspace(),
			ledger.listAgentProfiles(current.id),
		]);
		const teamInvited =
			isAdministrator(current) &&
			((await identity.listAccounts()).length > 1 ||
				(await identity.listInvitations()).some(
					(invite) =>
						!invite.revokedAt &&
						!invite.consumedAt &&
						Date.parse(invite.expiresAt) > Date.now(),
				));

		return {
			...onboarding,
			organization: workspace.organization,
			profileComplete: Boolean(current.displayName && current.email),
			teamInvited,
			sourceConnected: workspace.installations.some(
				(item) =>
					item.status === "healthy" && Boolean(item.lastSuccessAt),
			),
			agentCreated: profiles.some(
				(profile) => profile.status === "active",
			),
			agentConnected: profiles.some(
				(profile) =>
					profile.status === "active" && Boolean(profile.lastUsedAt),
			),
		};
	});
	app.post("/api/onboarding/complete", async (request) => {
		z.object({}).strict().parse(request.body);
		return identity.completeOnboarding(member(request).id);
	});
	app.get("/api/members", async (request) => {
		administrator(request);
		return { members: await identity.listAccounts() };
	});
	app.patch<{ Params: { memberId: string } }>(
		"/api/members/:memberId",
		async (request) => {
			const body = z
				.object({
					role: roles.optional(),
					status: z.enum(["active", "disabled"]).optional(),
				})
				.strict()
				.refine((value) => Object.keys(value).length > 0)
				.parse(request.body);

			return {
				member: await identity.changeMembership(
					administrator(request),
					z.string().uuid().parse(request.params.memberId),
					{
						...(body.role ? { role: body.role } : {}),
						...(body.status ? { status: body.status } : {}),
					},
				),
			};
		},
	);
	app.get("/api/invitations", async (request) => {
		administrator(request);
		return { invitations: await identity.listInvitations() };
	});
	app.post("/api/invitations", async (request, reply) => {
		const body = z
			.object({ email: emailSchema, role: roles.default("member") })
			.strict()
			.parse(request.body);
		const grant = await identity.invite(
			administrator(request),
			body.email,
			body.role,
		);

		return reply.code(201).send({
			invitation: grant.invitation,
			url: `${origin}/join#${grant.token}`,
		});
	});
	app.delete<{ Params: { id: string } }>(
		"/api/invitations/:id",
		async (request) => {
			await identity.revokeInvitation(
				administrator(request),
				z.string().uuid().parse(request.params.id),
			);
			return { revoked: true };
		},
	);
	app.post<{ Params: { memberId: string } }>(
		"/api/members/:memberId/reset-password",
		async (request, reply) => {
			const grant = await identity.issueReset(
				administrator(request),
				z.string().uuid().parse(request.params.memberId),
			);

			return reply.code(201).send({
				expiresAt: grant.invitation.expiresAt,
				url: `${origin}/reset-password#${grant.token}`,
			});
		},
	);

	async function startGithub(
		request: FastifyRequest,
		reply: FastifyReply,
		intent: GithubLoginIntent,
		next: string,
	) {
		if (!githubEnabled || !options.github || !cipher)
			throw new AuthError(
				"GitHub sign-in needs a configured GitHub App with its callback on the workspace's public origin.",
				503,
			);
		if (request.headers.origin !== origin)
			throw new AuthError(
				`Open ${origin} and try GitHub sign-in again.`,
				409,
			);
		await identity.limit("github-start", request.ip, 30);

		const state = `panini_login_${randomBytes(32).toString("base64url")}`;
		const browser = randomBytes(32).toString("base64url");
		const verifier = randomBytes(48).toString("base64url");
		const flow: GithubFlow = { intent, verifier, next };

		await identity.saveGithubFlow(
			state,
			browser,
			JSON.stringify(cipher.encrypt(flow as unknown as JsonValue)),
		);
		reply.header(
			"set-cookie",
			`${githubCookie}=${browser}; Path=/; HttpOnly; SameSite=Lax; Max-Age=600${secure ? "; Secure" : ""}`,
		);
		return {
			authorizationUrl: options.github.authorizationUrl(state, verifier),
		};
	}

	app.post("/api/auth/github/start", async (request, reply) => {
		const body = z
			.discriminatedUnion("purpose", [
				z
					.object({
						purpose: z.literal("login"),
						next: z.string().max(300).optional(),
					})
					.strict(),
				z
					.object({
						purpose: z.literal("setup"),
						token: z.string().min(1).max(500),
						companyName: nameSchema,
						displayName: nameSchema,
						email: emailSchema,
					})
					.strict(),
				z
					.object({
						purpose: z.literal("join"),
						token: tokenSchema,
						displayName: nameSchema,
					})
					.strict(),
			])
			.parse(request.body);

		if (body.purpose === "setup") {
			if (!equalSecret(body.token, options.adminToken))
				throw new AuthError(
					"The installation secret is incorrect.",
					401,
				);
			if (await identity.isConfigured())
				throw new AuthError(
					"This installation already has an owner. Sign in instead.",
					409,
				);

			const { token: _secret, ...intent } = body;

			return startGithub(request, reply, intent, "/app/onboarding");
		}
		return startGithub(
			request,
			reply,
			body,
			body.purpose === "login"
				? safeReturnPath(body.next)
				: "/app/onboarding",
		);
	});
	app.post("/api/account/github/start", async (request, reply) => {
		z.object({}).strict().parse(request.body);

		const current = session(request);

		return startGithub(
			request,
			reply,
			{
				purpose: "link",
				memberId: current.member.id,
				sessionHash: current.hash,
			},
			"/app/settings",
		);
	});
	app.delete("/api/account/github", async (request, reply) =>
		signedIn(reply, await identity.disconnectGithub(session(request))),
	);

	async function githubCallback(
		request: FastifyRequest,
		reply: FastifyReply,
	) {
		let flow: GithubFlow | undefined;

		try {
			if (!githubEnabled || !options.github || !cipher)
				throw new AuthError("GitHub unavailable.", 503);

			const query = z
				.object({
					state: z.string().max(200),
					code: z.string().max(1000).optional(),
					error: z.string().max(200).optional(),
				})
				.parse(request.query);
			const browser = safeCookie(request, githubCookie);

			if (!browser) throw new AuthError("Missing browser binding.", 400);

			const encrypted = await identity.consumeGithubFlow(
				query.state,
				browser,
			);

			flow = cipher.decrypt(
				JSON.parse(encrypted),
			) as unknown as GithubFlow;
			if (query.error || !query.code)
				throw new AuthError("GitHub authorization was cancelled.", 400);
			if (flow.intent.purpose === "link") {
				const current = await identity.authenticate(
					safeCookie(request, browserCookie),
				);

				if (!current || current.hash !== flow.intent.sessionHash)
					throw new AuthError("Sign in again.", 401);
			}

			const accessToken = await options.github.exchangeCode(
				query.code,
				flow.verifier,
			);
			const githubUser = z
				.object({
					id: z.number().int().positive().safe(),
					login: z.string().min(1).max(100),
					type: z.literal("User"),
				})
				.parse(await options.github.user(accessToken));
			const grant = await identity.completeGithubLogin(flow.intent, {
				id: String(githubUser.id),
				login: githubUser.login,
			});

			if (!grant) return reply.redirect("/app/settings");

			const account = await signedIn(reply, grant);

			return reply.redirect(
				account.onboarding.completedAt
					? safeReturnPath(flow.next)
					: "/app/onboarding",
			);
		} catch (error) {
			const reason =
				error instanceof AuthError && error.message === "not_linked"
					? "not_linked"
					: "failed";
			const target =
				flow?.intent.purpose === "link"
					? "/app/settings"
					: (await identity.isConfigured())
						? "/login"
						: "/setup";

			return reply.redirect(`${target}?githubError=${reason}`);
		}
	}

	return { member, access, session, githubEnabled, githubCallback };
}
