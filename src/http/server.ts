import { supportedModels } from "../intelligence/model-settings.js";
import {
	createHash,
	createHmac,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { toNodeHandler } from "@modelcontextprotocol/node";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { evidencePipelineMode, type RuntimeConfig } from "../config.js";
import {
	GithubWebhookAdapter,
	verifyGithubSignature,
} from "../connectors/github/webhook.js";
import {
	GithubAppClient,
	type GithubAccount,
} from "../connectors/github/app-client.js";
import { buildAgentSetup, buildAgentSetups } from "../domain/agent-setup.js";
import { DomainError } from "../domain/errors.js";
import { outcomeContractDraftSchema } from "../domain/evidence-schema.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import { contentHash } from "../domain/content-hash.js";
import {
	agentCapabilities,
	agentHarnesses,
	contextFactTypes,
	contextLifecycleStates,
	contextLinkTypes,
	sourceProviders,
	taskStatuses,
	type JsonValue,
	type NewSourceInstallation,
	type ProposalChanges,
	type ProjectChanges,
	type SourceEventInput,
	type SourceInstallationUpdate,
} from "../domain/types.js";
import type { OutboxQueue } from "../outbox/runtime.js";
import type { ReplayVerifier } from "../replay/verifier.js";
import { createTeamLedgerMcp } from "../mcp/server.js";
import { usageFromLogs } from "../telemetry/otlp.js";
import {
	ACCESS_TOKEN_TTL_SECONDS,
	AccessTokenSigner,
	validRedirectUri,
	verifyPkce,
} from "../security/oauth.js";
import { runWithMcpPrincipal, type McpPrincipal } from "../mcp/principal.js";
import { relayEnvelopeSchema, verifyRelayEnvelope } from "../relay/protocol.js";
import { renderLandingPage } from "./landing.js";
import { renderAppShell } from "./ui.js";
import {
	AuthError,
	IdentityService,
	isAdministrator,
} from "../security/identity.js";
import {
	installIdentityRoutes,
	isGithubLoginCallback,
	safeCookie,
	safeReturnPath,
} from "./identity-routes.js";
import { renderAuthPage } from "./identity-ui.js";
import type { AccessScope } from "../domain/access.js";

function withoutUndefined(value: object): ProposalChanges {
	return Object.fromEntries(
		Object.entries(value).filter(([, item]) => item !== undefined),
	) as ProposalChanges;
}

const nullableString = z.preprocess(
	(value) => (value === "" ? null : value),
	z.string().max(240).nullable().optional(),
);

const createTaskSchema = z.object({
	title: z.string().trim().min(1).max(180),
	description: z.string().max(10_000).default(""),
	status: z.enum(taskStatuses).default("backlog"),
	priority: z.enum(["low", "medium", "high", "urgent"]).default("medium"),
	owner: nullableString,
	project: nullableString,
	projectId: z.string().uuid().nullable().optional(),
	dueDate: nullableString,
	dependencyRefs: z.array(z.string()).default([]),
});

const changesSchema = z
	.object({
		title: z.string().trim().min(1).max(180).optional(),
		description: z.string().max(10_000).optional(),
		status: z.enum(taskStatuses).optional(),
		priority: z.enum(["low", "medium", "high", "urgent"]).optional(),
		owner: z.string().max(240).nullable().optional(),
		project: z.string().max(240).nullable().optional(),
		projectId: z.string().uuid().nullable().optional(),
		dueDate: z.string().max(100).nullable().optional(),
		dependencyRefs: z.array(z.string().max(300)).optional(),
	})
	.refine(
		(changes) => Object.keys(changes).length > 0,
		"At least one change is required.",
	);

const contextLinkSchema = z
	.object({
		type: z.enum(contextLinkTypes),
		targetId: z.string().uuid().nullable().default(null),
		targetRef: z.string().trim().min(1).max(500),
	})
	.strict();

const contextTemporalShape = {
	lifecycleState: z.enum(contextLifecycleStates).default("accepted"),
	effectiveFrom: z.string().datetime({ offset: true }).optional(),
	effectiveTo: z.string().datetime({ offset: true }).nullable().optional(),
	links: z.array(contextLinkSchema).max(100).default([]),
};

const createContextEntrySchema = z.discriminatedUnion("kind", [
	z
		.object({
			kind: z.literal("file"),
			path: z.string().trim().min(1).max(500),
			title: z.string().trim().min(1).max(240),
			body: z.string().min(1).max(500_000),
			...contextTemporalShape,
		})
		.strict(),
	z
		.object({
			kind: z.literal("fact"),
			path: z.string().trim().min(1).max(500),
			title: z.string().trim().min(1).max(240),
			factType: z.enum(contextFactTypes),
			value: z.union([
				z.string().trim().min(1).max(10_000),
				z.number(),
				z.boolean(),
			]),
			...contextTemporalShape,
		})
		.strict(),
]);

const proposalSchema = z.object({
	baseRevision: z.number().int().positive(),
	changes: changesSchema,
	rationale: z.string().trim().min(3).max(2_000),
	evidenceIds: z.array(z.string().uuid()).default([]),
});

const outcomeContractProposalSchema = z.strictObject({
	baseRevision: z.number().int().positive(),
	contract: outcomeContractDraftSchema,
	rationale: z.string().trim().min(3).max(2_000),
	evidenceIds: z.array(z.uuid()).default([]),
});

const projectChangesSchema = z
	.object({
		name: z.string().trim().min(1).max(180).optional(),
		aliases: z.array(z.string().trim().min(1).max(180)).max(30).optional(),
		outcome: z.string().trim().min(1).max(5_000).optional(),
		owner: nullableString,
		status: z
			.enum(["active", "paused", "completed", "archived"])
			.optional(),
		sourceUrl: z.string().url().max(4_000).nullable().optional(),
	})
	.strict()
	.refine(
		(changes) =>
			Object.values(changes).some((value) => value !== undefined),
		"At least one project change is required.",
	);

const projectProposalSchema = z
	.object({
		projectId: z.string().uuid().nullable().default(null),
		baseVersion: z.number().int().positive().nullable().default(null),
		changes: projectChangesSchema,
		rationale: z.string().trim().min(3).max(2_000),
		evidenceIds: z.array(z.string().uuid()).min(1).max(100),
	})
	.strict();

const evidenceEventSchema = z
	.object({
		provider: z.string().trim().min(1).max(80),
		installationKey: z.string().trim().min(1).max(200).default("default"),
		providerEventId: z.string().trim().min(1).max(500),
		eventKind: z.string().trim().min(1).max(160),
		occurredAt: z.string().datetime({ offset: true }),
		fetchedAt: z.string().datetime({ offset: true }).optional(),
		sourceRef: z.string().trim().min(1).max(1_000),
		sourceUrl: z.string().url().max(4_000).nullable().default(null),
		visibility: z.string().trim().min(1).max(100).default("company"),
		payloadVersion: z.string().trim().min(1).max(100).default("1"),
		payload: z.json(),
	})
	.strict();

const agentDataScopeSchema = z
	.object({
		projects: z
			.array(z.string().trim().min(1).max(240))
			.max(100)
			.default([]),
		contextPaths: z
			.array(z.string().trim().min(1).max(500))
			.min(1)
			.max(100)
			.default(["/"]),
		sourceVisibilities: z
			.array(z.string().trim().min(1).max(240))
			.min(1)
			.max(100)
			.default(["company"]),
	})
	.strict();

const createAgentProfileSchema = z
	.object({
		memberId: z.string().uuid(),
		name: z.string().trim().min(1).max(120),
		harness: z.enum(agentHarnesses).default("generic_mcp"),
		description: z.string().trim().max(1_000).default(""),
		capabilities: z
			.array(z.enum(agentCapabilities))
			.min(1)
			.max(agentCapabilities.length)
			.default([...agentCapabilities]),
		dataScope: agentDataScopeSchema.default({
			projects: [],
			contextPaths: ["/"],
			sourceVisibilities: ["company"],
		}),
	})
	.strict();

const sourceInstallationSchema = z
	.object({
		provider: z.enum(sourceProviders),
		installationKey: z.string().trim().min(1).max(240),
		displayName: z.string().trim().min(1).max(240),
		transport: z.enum(["poll", "socket_mode", "webhook", "local"]),
		status: z
			.enum(["configured", "healthy", "degraded", "revoked", "disabled"])
			.optional(),
		config: z.record(z.string(), z.json()).default({}),
	})
	.strict();

const sourceInstallationUpdateSchema = z
	.object({
		status: z
			.enum(["configured", "healthy", "degraded", "revoked", "disabled"])
			.optional(),
		config: z.record(z.string(), z.json()).optional(),
		lastSyncAt: z.string().datetime({ offset: true }).nullable().optional(),
		lastSuccessAt: z
			.string()
			.datetime({ offset: true })
			.nullable()
			.optional(),
		lastEventAt: z
			.string()
			.datetime({ offset: true })
			.nullable()
			.optional(),
		lastError: z.string().max(4_000).nullable().optional(),
	})
	.strict();

const connectStartSchema = z.object({
	harness: z.enum(agentHarnesses).default("generic_mcp"),
	repository: z
		.string()
		.trim()
		.regex(/^[^/\s]+\/[^/\s]+$/)
		.optional(),
	hostname: z.string().trim().min(1).max(120).optional(),
});

const deviceEnrollmentSchema = z
	.object({
		agentProfileId: z.string().uuid(),
		name: z.string().trim().min(1).max(160),
		publicKey: z.string().trim().min(32).max(8_000),
		privacyMode: z
			.enum(["metadata", "approved_excerpts"])
			.default("metadata"),
	})
	.strict();

const repositoryMappingSchema = z
	.object({
		repository: z
			.string()
			.trim()
			.regex(/^[^/\s]+\/[^/\s]+$/),
		project: z.string().trim().min(1).max(240),
		contextPaths: z
			.array(z.string().trim().startsWith("/").max(500))
			.max(100)
			.default([]),
	})
	.strict();

function bearerToken(request: FastifyRequest): string | null {
	const authorization = request.headers.authorization;

	if (!authorization?.startsWith("Bearer ")) return null;
	return authorization.slice(7);
}

function headerText(
	value: string | string[] | undefined,
	max: number,
): string | null {
	const text = (Array.isArray(value) ? value[0] : value)?.trim();

	return text && !/[\u0000-\u001f]/.test(text) ? text.slice(0, max) : null;
}

function tokensMatch(provided: string | null, expected: string): boolean {
	if (!provided) return false;

	const left = Buffer.from(provided);
	const right = Buffer.from(expected);

	return left.length === right.length && timingSafeEqual(left, right);
}

interface AdminSession {
	csrf: string;
	expiresAt: number;
	organizationId: string;
	memberId: string;
	subject: string;
	role: "owner" | "admin";
}

const adminSessionCookie = "panini_admin_session";

function cookieValue(request: FastifyRequest, name: string): string | null {
	return safeCookie(request, name);
}

function signAdminSession(session: AdminSession, adminToken: string): string {
	const payload = Buffer.from(JSON.stringify(session), "utf8").toString(
		"base64url",
	);
	const signature = createHmac("sha256", adminToken)
		.update(payload)
		.digest("base64url");

	return `${payload}.${signature}`;
}

function readAdminSession(
	request: FastifyRequest,
	adminToken: string,
): AdminSession | null {
	const value = cookieValue(request, adminSessionCookie);

	if (!value) return null;

	const [payload, signature] = value.split(".");

	if (!payload || !signature) return null;

	const expected = createHmac("sha256", adminToken)
		.update(payload)
		.digest("base64url");

	if (!tokensMatch(signature, expected)) return null;
	try {
		const session = JSON.parse(
			Buffer.from(payload, "base64url").toString("utf8"),
		) as AdminSession;

		if (
			!session.csrf ||
			!Number.isFinite(session.expiresAt) ||
			session.expiresAt <= Date.now() ||
			!session.organizationId ||
			!session.memberId ||
			!session.subject ||
			!["owner", "admin"].includes(session.role)
		)
			return null;
		return session;
	} catch {
		return null;
	}
}

export interface HttpServerOptions {
	ledger: TeamLedger;
	config: RuntimeConfig;
	jobs: OutboxQueue;
	replay: ReplayVerifier;
	githubAppClient?: GithubAppClient;
	identity?: IdentityService;
}

export async function buildHttpServer(options: HttpServerOptions) {
	const evidenceV2Enabled =
		evidencePipelineMode(options.config.app) !== "legacy";
	const app = Fastify({
		logger: {
			level: process.env.LOG_LEVEL ?? "info",
			redact: [
				"req.headers.authorization",
				"req.headers.cookie",
				"req.headers.x-panini-csrf",
				"res.headers.set-cookie",
			],
			serializers: {
				req: (request) => ({
					method: request.method,
					url: request.url.split("?")[0] ?? "/",
					remoteAddress: request.ip,
				}),
			},
		},
		// Only enable behind an operator-controlled proxy; the direct port stays on loopback.
		trustProxy: options.config.trustProxy ?? false,
		bodyLimit: 1_000_000,
		requestTimeout: 30_000,
		connectionTimeout: 15_000,
	});

	// OAuth token requests are form-encoded.
	app.addContentTypeParser(
		"application/x-www-form-urlencoded",
		{ parseAs: "string" },
		(_request, body, done) =>
			done(null, Object.fromEntries(new URLSearchParams(String(body)))),
	);
	app.removeContentTypeParser("application/json");
	app.addContentTypeParser(
		"application/json",
		{ parseAs: "buffer" },
		(request, body, done) => {
			const rawBody = Buffer.isBuffer(body) ? body : Buffer.from(body);

			(request as FastifyRequest & { rawBody?: Buffer }).rawBody =
				rawBody;
			try {
				done(null, JSON.parse(rawBody.toString("utf8")) as unknown);
			} catch (error) {
				done(error as Error, undefined);
			}
		},
	);

	const mcp = createTeamLedgerMcp(
		options.ledger,
		options.config.app.company.name,
	);
	const mcpNodeHandler = toNodeHandler(mcp, {
		onerror: (error) => app.log.error(error),
	});
	const setupHost =
		options.config.host === "0.0.0.0" || options.config.host === "::"
			? "127.0.0.1"
			: options.config.host;
	const setupBaseUrl =
		options.config.publicUrl ??
		`http://${setupHost}:${options.config.port}`;
	const githubApp = options.config.githubApp
		? (options.githubAppClient ??
			new GithubAppClient(
				options.config.githubApp,
				options.ledger.externalProviderFetch(
					"github",
					"github_account_api",
				),
			))
		: null;
	const identity = options.identity
		? installIdentityRoutes(app, {
				identity: options.identity,
				ledger: options.ledger,
				publicUrl: setupBaseUrl,
				adminToken: options.config.adminToken!,
				...(githubApp ? { github: githubApp } : {}),
				...(options.config.contentEncryptionKey
					? { encryptionKey: options.config.contentEncryptionKey }
					: {}),
			})
		: null;

	const recorder = {
		record: (input: SourceEventInput) => options.ledger.recordSource(input),
	};

	const access = (request: FastifyRequest): AccessScope =>
		identity?.access(request) ?? { kind: "admin" };

	const githubConfig = options.config.app.github;

	if (
		githubApp &&
		new URL(githubApp.credentials.callbackUrl).pathname !==
			"/api/github/oauth/callback"
	) {
		throw new Error(
			"GITHUB_CALLBACK_URL must end with /api/github/oauth/callback.",
		);
	}

	const githubFlows = new Map<
		string,
		{ verifier: string; actor: string; expiresAt: number }
	>();
	const githubSelections = new Map<
		string,
		{ token: string; user: GithubAccount; actor: string; expiresAt: number }
	>();
	const github =
		githubConfig?.enabled && options.config.githubWebhookSecret
			? new GithubWebhookAdapter(
					{
						secret: options.config.githubWebhookSecret,
						installationKey: githubConfig.installationKey,
						repositories: githubConfig.repositories,
					},
					recorder,
					options.ledger,
				)
			: null;
	const requestActors = new WeakMap<FastifyRequest, string>();

	async function activeLocalAdmin(memberId?: string) {
		const workspace = await options.ledger.workspace();
		const member = workspace.members.find(
			(candidate) =>
				candidate.status === "active" &&
				(candidate.role === "owner" || candidate.role === "admin") &&
				(!memberId || candidate.id === memberId),
		);

		return member
			? { organizationId: workspace.organization.id, member }
			: null;
	}

	function requestActor(request: FastifyRequest): string {
		if (identity) return `member:${identity.member(request).id}`;

		const actor = requestActors.get(request);

		if (!actor)
			throw new DomainError(
				"The authenticated member identity is unavailable.",
				"FORBIDDEN",
			);
		return actor;
	}

	function idempotencyKey(request: FastifyRequest): string {
		const header = request.headers["idempotency-key"];
		const value = (Array.isArray(header) ? header[0] : header)?.trim();

		if (!value || value.length > 200) {
			throw new DomainError(
				"A valid Idempotency-Key header is required for this command.",
				"INVALID",
			);
		}
		return value;
	}

	function sendHtml(reply: FastifyReply, body: string, nonce: string) {
		return reply
			.header(
				"content-security-policy",
				`default-src 'self'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'`,
			)
			.header("x-content-type-options", "nosniff")
			.header("referrer-policy", "strict-origin-when-cross-origin")
			.header(
				"permissions-policy",
				"camera=(), microphone=(), geolocation=()",
			)
			.header("cache-control", "no-store")
			.type("text/html; charset=utf-8")
			.send(body);
	}

	app.addHook("onRequest", async (request, reply) => {
		if (identity) return;
		if (request.url.startsWith("/mcp")) return;
		if (request.url.startsWith("/api/session")) return;
		if (
			request.url.startsWith("/api/webhooks/github") ||
			request.url.startsWith("/api/relay/work-reports") ||
			request.url.startsWith("/api/agent/hooks") ||
			request.url.startsWith("/api/agent/otlp/") ||
			request.url.startsWith("/api/connect/start") ||
			request.url.startsWith("/api/connect/poll")
		)
			return;
		if (!request.url.startsWith("/api/")) return;
		if (!options.config.adminToken) {
			requestActors.set(request, "bootstrap:open-mode");
			return;
		}

		const bearerAuthenticated = tokensMatch(
			bearerToken(request),
			options.config.adminToken,
		);
		const session = readAdminSession(request, options.config.adminToken);

		if (!bearerAuthenticated && !session) {
			return reply
				.code(401)
				.header("www-authenticate", "Bearer")
				.send({ error: "A valid admin token is required." });
		}

		const principal = await activeLocalAdmin(
			bearerAuthenticated ? undefined : session?.memberId,
		);

		if (
			!principal ||
			(session && session.organizationId !== principal.organizationId)
		) {
			return reply.code(403).send({
				error: "The local administrator membership is no longer active.",
			});
		}
		requestActors.set(request, `member:${principal.member.id}`);
		if (
			!bearerAuthenticated &&
			session &&
			!["GET", "HEAD", "OPTIONS"].includes(request.method)
		) {
			const csrf = request.headers["x-panini-csrf"];
			const provided = Array.isArray(csrf) ? csrf[0] : csrf;

			if (!tokensMatch(provided ?? null, session.csrf)) {
				return reply.code(403).send({
					error: "A valid CSRF token is required for this browser command.",
				});
			}
		}
	});

	app.get("/", async (_request, reply) => {
		const nonce = randomBytes(18).toString("base64");

		return sendHtml(reply, renderLandingPage(nonce), nonce);
	});

	app.get("/app", async (_request, reply) => {
		const nonce = randomBytes(18).toString("base64");
		const companyName = options.identity
			? (await options.identity.organization()).name
			: options.config.app.company.name;

		return sendHtml(
			reply,
			renderAppShell(companyName, nonce, Boolean(identity)),
			nonce,
		);
	});

	app.get<{ Params: { page: string } }>(
		"/app/:page",
		async (request, reply) => {
			z.enum([
				"home",
				"connect",
				"projects",
				"tasks",
				"context",
				"people",
				"timeline",
				"review",
				"agents",
				"integrations",
				"history",
				"company",
				"settings",
				"onboarding",
			]).parse(request.params.page);

			const nonce = randomBytes(18).toString("base64");
			const companyName = options.identity
				? (await options.identity.organization()).name
				: options.config.app.company.name;

			return sendHtml(
				reply,
				renderAppShell(companyName, nonce, Boolean(identity)),
				nonce,
			);
		},
	);

	for (const page of ["login", "setup", "join", "reset-password"] as const) {
		app.get(`/${page}`, async (request, reply) => {
			if (!options.identity) return reply.redirect("/app");

			const setupRequired = !(await options.identity.isConfigured());

			if (page === "setup" && !setupRequired)
				return reply.redirect("/login");
			if (page === "login" && setupRequired)
				return reply.redirect("/setup");

			const query = request.query as { next?: string };
			const nonce = randomBytes(18).toString("base64");

			reply.header("referrer-policy", "no-referrer");
			return sendHtml(
				reply,
				renderAuthPage(
					page,
					nonce,
					safeReturnPath(query.next),
					identity?.githubEnabled ?? false,
				),
				nonce,
			);
		});
	}

	app.get("/assets/context-observatory.png", async (_request, reply) => {
		const image = await readFile(
			resolve(process.cwd(), "public/context-observatory.png"),
		);

		return reply
			.header("cache-control", "public, max-age=86400")
			.type("image/png")
			.send(image);
	});

	app.get("/assets/panini-mark.svg", async (_request, reply) => {
		const image = await readFile(
			resolve(process.cwd(), "public/panini-mark.svg"),
			"utf8",
		);

		return reply
			.header("cache-control", "public, max-age=604800")
			.type("image/svg+xml; charset=utf-8")
			.send(image);
	});

	app.get<{ Params: { name: string } }>(
		"/assets/landing/:name",
		async (request, reply) => {
			const name = z
				.enum([
					"grammar-machine.webp",
					"work-sorter.webp",
					"shared-structure.webp",
				])
				.parse(request.params.name);
			const image = await readFile(
				resolve(process.cwd(), "public", "landing", name),
			);

			return reply
				.header("cache-control", "public, max-age=31536000, immutable")
				.type("image/webp")
				.send(image);
		},
	);

	app.get("/assets/phosphor.css", async (_request, reply) => {
		const stylesheet = await readFile(
			resolve(
				process.cwd(),
				"node_modules/@phosphor-icons/web/src/regular/style.css",
			),
			"utf8",
		);

		return reply
			.header("cache-control", "public, max-age=604800")
			.type("text/css; charset=utf-8")
			.send(stylesheet);
	});

	app.get("/assets/Phosphor.woff2", async (_request, reply) => {
		const font = await readFile(
			resolve(
				process.cwd(),
				"node_modules/@phosphor-icons/web/src/regular/Phosphor.woff2",
			),
		);

		return reply
			.header("cache-control", "public, max-age=31536000, immutable")
			.type("font/woff2")
			.send(font);
	});

	const servePiAdapter = async (reply: FastifyReply) => {
		const extension = await readFile(
			resolve(process.cwd(), "integrations/pi-panini.ts"),
			"utf8",
		);

		return reply
			.header("cache-control", "no-store")
			.type("text/plain; charset=utf-8")
			.send(extension);
	};

	app.get("/integrations/pi/panini.ts", async (_request, reply) =>
		servePiAdapter(reply),
	);
	app.get("/integrations/pi/team-ledger.ts", async (_request, reply) =>
		servePiAdapter(reply),
	);

	const health = () => ({
		ok: true,
		service: "panini",
		storage: options.config.databaseUrl ? "postgres" : "memory",
		notion: options.config.app.notion.enabled ? "worker" : "disabled",
		intelligence: options.config.app.intelligence.enabled
			? "observation-agent"
			: "disabled",
		retrieval: {
			provider:
				options.config.retrievalProvider === "jev" &&
				options.config.embeddingProvider === "openrouter"
					? "embedding_jev"
					: options.config.retrievalProvider,
			status:
				options.config.retrievalProvider === "jev"
					? "configured"
					: "healthy",
			embeddedOpenViking: "disabled",
			reason: "License approval and retrieval evaluation gates are still required.",
		},
		embeddings: {
			provider: options.config.embeddingProvider,
			status:
				options.config.embeddingProvider === "openrouter"
					? "configured"
					: "disabled",
			model:
				options.config.embeddingProvider === "openrouter"
					? options.config.openrouterEmbeddingModel
					: null,
		},
		timestamp: new Date().toISOString(),
	});

	app.get("/healthz", async () => health());
	app.get("/health/live", async () => health());
	app.get("/health/ready", async (_request, reply) => {
		try {
			const workspace = await options.ledger.workspace();

			return {
				...health(),
				ready: true,
				organizationId: workspace.organization.id,
			};
		} catch (error) {
			app.log.error(error);
			return reply
				.code(503)
				.send({ ...health(), ok: false, ready: false });
		}
	});

	if (!identity) {
		app.get("/api/session", async (request, reply) => {
			if (!options.config.adminToken)
				return { authenticated: true, mode: "open", csrf: null };

			const session = readAdminSession(
				request,
				options.config.adminToken,
			);

			if (!session) return reply.code(401).send({ authenticated: false });

			const principal = await activeLocalAdmin(session.memberId);

			if (
				!principal ||
				principal.organizationId !== session.organizationId
			)
				return reply.code(403).send({ authenticated: false });
			return {
				authenticated: true,
				mode: "local_admin",
				csrf: session.csrf,
				expiresAt: new Date(session.expiresAt).toISOString(),
				identity: {
					organizationId: session.organizationId,
					memberId: session.memberId,
					subject: session.subject,
					role: session.role,
				},
			};
		});

		app.post("/api/session", async (request, reply) => {
			if (!options.config.adminToken)
				return { authenticated: true, mode: "open", csrf: null };

			const body = z
				.object({ token: z.string().min(1).max(10_000) })
				.parse(request.body);

			if (!tokensMatch(body.token, options.config.adminToken)) {
				return reply.code(401).send({
					authenticated: false,
					error: "The administrator token is invalid.",
				});
			}

			const principal = await activeLocalAdmin();

			if (!principal)
				return reply.code(503).send({
					authenticated: false,
					error: "No active local administrator membership exists.",
				});

			const session: AdminSession = {
				csrf: randomBytes(24).toString("base64url"),
				expiresAt: Date.now() + 8 * 60 * 60 * 1_000,
				organizationId: principal.organizationId,
				memberId: principal.member.id,
				subject: principal.member.subject,
				role: principal.member.role as "owner" | "admin",
			};
			const forwardedProto = request.headers["x-forwarded-proto"];
			const secure =
				(Array.isArray(forwardedProto)
					? forwardedProto[0]
					: forwardedProto) === "https";

			reply.header(
				"set-cookie",
				`${adminSessionCookie}=${encodeURIComponent(signAdminSession(session, options.config.adminToken))}; Path=/; HttpOnly; SameSite=Lax; Max-Age=28800${secure ? "; Secure" : ""}`,
			);
			return {
				authenticated: true,
				mode: "local_admin",
				csrf: session.csrf,
				expiresAt: new Date(session.expiresAt).toISOString(),
				identity: {
					organizationId: session.organizationId,
					memberId: session.memberId,
					subject: session.subject,
					role: session.role,
				},
			};
		});

		app.delete("/api/session", async (_request, reply) => {
			reply.header(
				"set-cookie",
				`${adminSessionCookie}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
			);
			return { authenticated: false };
		});
	}

	app.get("/api/board", async (request) =>
		options.ledger.board(access(request)),
	);
	app.get("/api/work-graph", async (request) =>
		options.ledger.workGraph(access(request)),
	);
	app.get("/api/workspace", async (request) => {
		const workspace = await options.ledger.workspace();

		if (!identity || isAdministrator(identity.member(request)))
			return workspace;
		return {
			...workspace,
			memberIdentities: [],
			installations: [],
			connectorSyncs: [],
		};
	});

	app.post("/api/github/connect/start", async (request, reply) => {
		if (!githubApp)
			return reply.code(409).send({
				error: "A GitHub App must be configured before connecting.",
			});

		const state = randomBytes(24).toString("base64url");
		const verifier = randomBytes(48).toString("base64url");

		githubFlows.set(state, {
			verifier,
			actor: requestActor(request),
			expiresAt: Date.now() + 10 * 60_000,
		});
		return {
			authorizationUrl: githubApp.authorizationUrl(state, verifier),
		};
	});

	app.get<{ Querystring: { state?: string; code?: string; error?: string } }>(
		"/api/github/oauth/callback",
		async (request, reply) => {
			if (identity && isGithubLoginCallback(request))
				return identity.githubCallback(request, reply);
			if (!githubApp)
				return reply
					.code(409)
					.send({ error: "The GitHub App is not configured." });

			const state = request.query.state ?? "";
			const flow = githubFlows.get(state);

			githubFlows.delete(state);
			if (
				request.query.error ||
				!request.query.code ||
				!flow ||
				flow.expiresAt <= Date.now() ||
				flow.actor !== requestActor(request)
			) {
				return reply.redirect("/app?githubError=authorization_failed");
			}
			try {
				const token = await githubApp.exchangeCode(
					request.query.code,
					flow.verifier,
				);
				const user = await githubApp.user(token);
				const selectionId = randomBytes(24).toString("base64url");

				githubSelections.set(selectionId, {
					token,
					user,
					actor: flow.actor,
					expiresAt: Date.now() + 15 * 60_000,
				});
				return reply.redirect(`/app?githubSelection=${selectionId}`);
			} catch (error) {
				app.log.error({ error }, "GitHub OAuth callback failed.");
				return reply.redirect("/app?githubError=authorization_failed");
			}
		},
	);

	app.get<{ Params: { selectionId: string } }>(
		"/api/github/connect/session/:selectionId",
		async (request, reply) => {
			if (!githubApp)
				return reply
					.code(409)
					.send({ error: "The GitHub App is not configured." });

			const selection = githubSelections.get(request.params.selectionId);

			if (
				!selection ||
				selection.expiresAt <= Date.now() ||
				selection.actor !== requestActor(request)
			) {
				return reply.code(403).send({
					error: "GitHub connection session expired. Start the connection again.",
				});
			}

			const [memberships, installations] = await Promise.all([
				githubApp
					.organizationMemberships(selection.token)
					.catch(() => []),
				githubApp.userInstallations(selection.token),
			]);
			const available = installations.filter(
				(installation) =>
					installation.account.type === "Organization" &&
					!installation.suspended_at,
			);
			const withRepositories = await Promise.all(
				available.map(async (installation) => ({
					id: installation.id,
					account: installation.account,
					permissions: installation.permissions,
					repositories: await githubApp.userInstallationRepositories(
						selection.token,
						installation.id,
					),
				})),
			);

			return {
				user: { id: selection.user.id, login: selection.user.login },
				organizations: memberships.map((org) => ({
					id: org.id,
					login: org.login,
				})),
				installations: withRepositories,
				installationUrl: githubApp.installationUrl(),
			};
		},
	);

	app.post("/api/github/connect/complete", async (request, reply) => {
		if (!githubApp)
			return reply
				.code(409)
				.send({ error: "The GitHub App is not configured." });

		const body = z
			.object({
				selectionId: z.string().min(20).max(100),
				installationId: z.number().int().positive(),
				repositoryIds: z
					.array(z.number().int().positive())
					.min(1)
					.max(100),
			})
			.strict()
			.parse(request.body);
		const selection = githubSelections.get(body.selectionId);

		if (
			!selection ||
			selection.expiresAt <= Date.now() ||
			selection.actor !== requestActor(request)
		) {
			return reply.code(403).send({
				error: "GitHub connection session expired. Start the connection again.",
			});
		}

		const installations = await githubApp.userInstallations(
			selection.token,
		);
		const installation = installations.find(
			(item) =>
				item.id === body.installationId &&
				item.account.type === "Organization" &&
				!item.suspended_at,
		);

		if (!installation)
			return reply.code(403).send({
				error: "This GitHub organization installation is unavailable.",
			});

		const userRepositories = await githubApp.userInstallationRepositories(
			selection.token,
			installation.id,
		);
		const selectedIds = [...new Set(body.repositoryIds)];
		const selected = userRepositories.filter(
			(repository) =>
				selectedIds.includes(repository.id) && !repository.archived,
		);

		if (selected.length !== selectedIds.length) {
			return reply.code(403).send({
				error: "One or more selected repositories are unavailable.",
			});
		}

		const installationToken = await githubApp.installationToken(
			installation.id,
			selectedIds,
		);
		const installationRepositories =
			await githubApp.installationRepositories(installationToken);

		if (
			selected.some(
				(repository) =>
					!installationRepositories.some(
						(available) => available.id === repository.id,
					),
			)
		) {
			return reply.code(403).send({
				error: "GitHub did not grant the selected repositories to the installation token.",
			});
		}

		const connected = await options.ledger.configureInstallation(
			{
				provider: "github",
				installationKey: String(installation.id),
				displayName: `GitHub: ${installation.account.login}`,
				transport: "webhook",
				status: "configured",
				config: {
					installationId: installation.id,
					accountId: installation.account.id,
					accountLogin: installation.account.login,
					repositoryIds: selectedIds,
					repositories: selected.map(
						(repository) => repository.full_name,
					),
					permissions: installation.permissions,
					connectedByGithubUserId: selection.user.id,
				},
			},
			requestActor(request),
		);

		githubSelections.delete(body.selectionId);

		const job = await options.jobs.enqueue(
			"connector.github.sync_requested",
			`github-sync:${connected.id}:${Date.now()}`,
			{
				installationId: connected.id,
				requestedBy: requestActor(request),
			},
		);

		return reply
			.code(202)
			.send({ installation: connected, state: "queued", jobId: job.id });
	});
	app.get("/api/company", async (request) =>
		options.ledger.companyProjection(access(request)),
	);
	app.get("/api/people", async (request) =>
		options.ledger.peopleProjection(access(request)),
	);
	app.get("/api/history", async (request) => {
		const query = z
			.object({
				limit: z.coerce.number().int().min(1).max(1_000).default(250),
				view: z.enum(["all", "changes"]).default("all"),
			})
			.parse(request.query);

		return options.ledger.historyProjection(
			query.limit,
			query.view,
			access(request),
		);
	});
	app.get("/api/audit", async (request) => {
		const query = z
			.object({
				limit: z.coerce.number().int().min(1).max(500).default(100),
			})
			.parse(request.query);

		return { events: await options.ledger.listAuditEvents(query.limit) };
	});
	app.get("/api/operations/replay/verify", async () =>
		options.replay.verify(),
	);
	app.post("/api/installations", async (request, reply) => {
		const parsed = sourceInstallationSchema.parse(request.body);
		const input = Object.fromEntries(
			Object.entries(parsed).filter(([, value]) => value !== undefined),
		) as unknown as NewSourceInstallation;
		const installation = await options.ledger.configureInstallation(
			input,
			requestActor(request),
		);

		return reply.code(201).send({ installation });
	});
	app.patch<{ Params: { installationId: string } }>(
		"/api/installations/:installationId",
		async (request) => ({
			installation: await options.ledger.updateInstallation(
				request.params.installationId,
				Object.fromEntries(
					Object.entries(
						sourceInstallationUpdateSchema.parse(request.body),
					).filter(([, value]) => value !== undefined),
				) as SourceInstallationUpdate,
				requestActor(request),
			),
		}),
	);
	app.get("/api/agents", async (request) => {
		const query = z
			.object({ memberId: z.string().uuid().optional() })
			.parse(request.query);
		const memberId =
			identity && !isAdministrator(identity.member(request))
				? identity.member(request).id
				: query.memberId;

		return { agents: await options.ledger.listAgentProfiles(memberId) };
	});
	app.get("/api/agents/overview", async (request) => {
		const query = z
			.object({ since: z.iso.datetime().optional() })
			.parse(request.query);

		return options.ledger.agentOverview(access(request), {
			...(query.since ? { since: query.since } : {}),
		});
	});
	app.get("/api/agents/summary", async (request) =>
		options.ledger.agentSummaries(access(request)),
	);
	app.get<{ Params: { sessionId: string } }>(
		"/api/agents/sessions/:sessionId/story",
		async (request) =>
			options.ledger.sessionStory(
				request.params.sessionId,
				access(request),
			),
	);
	app.get("/api/agents/activity", async (request) => {
		const query = z
			.object({
				sessionId: z.uuid().optional(),
				agentProfileId: z.uuid().optional(),
				limit: z.coerce.number().int().min(1).max(500).optional(),
			})
			.parse(request.query);

		return {
			events: await options.ledger.agentActivity(access(request), {
				...(query.sessionId ? { sessionId: query.sessionId } : {}),
				...(query.agentProfileId
					? { agentProfileId: query.agentProfileId }
					: {}),
				...(query.limit ? { limit: query.limit } : {}),
			}),
		};
	});
	app.post<{ Params: { sessionId: string } }>(
		"/api/agents/sessions/:sessionId/rollback",
		async (request) =>
			options.ledger.rollbackSession(
				request.params.sessionId,
				access(request),
				requestActor(request),
			),
	);

	// The nightly run needs a model: from server settings, or chosen in the app.
	const serverModel =
		options.config.app.intelligence.enabled &&
		Boolean(options.config.intelligenceApiKey);

	const reconcileEnabled = async () =>
		serverModel || Boolean(await options.ledger.modelSettingsView());

	const requireAdmin = (request: FastifyRequest) => {
		if (identity && !isAdministrator(identity.member(request)))
			throw new DomainError(
				"Only an owner or admin can change the model.",
				"FORBIDDEN",
			);
	};

	app.get("/api/settings/model", async (request) => {
		requireAdmin(request);
		return {
			models: supportedModels,
			setByServer: serverModel
				? { model: options.config.intelligenceModel }
				: null,
			current: await options.ledger.modelSettingsView(),
		};
	});
	app.put("/api/settings/model", async (request) => {
		requireAdmin(request);

		const body = z
			.object({ model: z.string(), apiKey: z.string().max(500) })
			.parse(request.body);

		return {
			current: await options.ledger.saveModelSettings(
				body.model,
				body.apiKey,
				requestActor(request),
			),
		};
	});
	app.delete("/api/settings/model", async (request) => {
		requireAdmin(request);
		await options.ledger.removeModelSettings(requestActor(request));
		return { current: null };
	});

	app.get("/api/reconcile/runs", async () => ({
		enabled: await reconcileEnabled(),
		runs: (await options.ledger.listReconcileRuns(10)).map(
			({ digest: _digest, ...run }) => run,
		),
		mode:
			process.env.PANINI_RECONCILE_MODE === "live" ? "live" : "scheduled",
		intervalHours: Number(
			process.env.PANINI_RECONCILE_INTERVAL_HOURS ?? 24,
		),
	}));
	app.post("/api/reconcile/run", async (request, reply) => {
		if (!(await reconcileEnabled()))
			return reply.code(409).send({
				error: "Choose a model and add its API key in Settings to turn on the nightly run.",
			});
		if (identity && !isAdministrator(identity.member(request)))
			throw new DomainError(
				"Only an owner or admin can start a reconcile run.",
				"FORBIDDEN",
			);

		const job = await options.jobs.enqueue(
			"reconcile.run",
			`reconcile:manual:${idempotencyKey(request)}`,
			{ trigger: "manual", requestedBy: requestActor(request) },
		);

		return reply.code(202).send({ state: "queued", jobId: job.id });
	});
	app.get("/api/digest", async (request) => {
		const query = z
			.object({ since: z.iso.datetime().optional() })
			.parse(request.query);

		return options.ledger.digest(access(request), {
			...(query.since ? { since: query.since } : {}),
		});
	});
	app.get("/api/home", async (request) =>
		options.ledger.homeProjection(access(request)),
	);
	app.get("/api/notes", async (request) => {
		const query = z
			.object({
				state: z.enum(["open", "promoted", "dismissed"]).optional(),
			})
			.parse(request.query);

		return {
			notes: await options.ledger.visibleNotes(access(request), {
				...(query.state ? { state: query.state } : {}),
			}),
		};
	});
	app.post<{ Params: { noteId: string } }>(
		"/api/notes/:noteId/state",
		async (request) => {
			const body = z
				.object({ state: z.enum(["promoted", "dismissed", "open"]) })
				.parse(request.body);
			const visible = await options.ledger.visibleNotes(access(request), {
				limit: 500,
			});

			if (!visible.some((note) => note.id === request.params.noteId))
				throw new DomainError("Note not found.", "NOT_FOUND");
			return {
				note: await options.ledger.setNoteState(
					request.params.noteId,
					body.state,
					requestActor(request),
				),
			};
		},
	);
	app.post("/api/tasks/confirm", async (request) => {
		const body = z
			.object({
				taskIds: z.array(z.uuid()).min(1).max(100),
				decision: z.enum(["accept", "dismiss"]).default("accept"),
			})
			.parse(request.body);

		return {
			tasks: await options.ledger.confirmObservedTasks(
				body.taskIds,
				body.decision,
				access(request),
				requestActor(request),
			),
		};
	});
	app.post<{ Params: { taskId: string } }>(
		"/api/tasks/:taskId/claims/clear",
		async (request) => {
			const task = await options.ledger.getTaskForAccess(
				request.params.taskId,
				access(request),
			);

			if (!task) throw new DomainError("Task not found.", "NOT_FOUND");
			return {
				cleared: await options.ledger.clearTaskClaims(
					task.id,
					requestActor(request),
				),
			};
		},
	);
	app.get<{ Params: { taskId: string } }>(
		"/api/tasks/:taskId/ledger",
		async (request) => {
			const task = await options.ledger.getTaskForAccess(
				request.params.taskId,
				access(request),
			);

			if (!task) throw new DomainError("Task not found.", "NOT_FOUND");
			return {
				claims: await options.ledger.activeClaimsForTasks([task.id]),
				handoffs: await options.ledger.agents.listHandoffs(task.id, 10),
			};
		},
	);
	app.get("/api/devices", async (request) => {
		const query = z
			.object({ agentProfileId: z.string().uuid().optional() })
			.parse(request.query);
		const devices = await options.ledger.listDevices(query.agentProfileId);

		if (!identity || isAdministrator(identity.member(request)))
			return { devices };

		const ownProfiles = new Set(
			(
				await options.ledger.listAgentProfiles(
					identity.member(request).id,
				)
			).map((profile) => profile.id),
		);

		return {
			devices: devices.filter((device) =>
				ownProfiles.has(device.agentProfileId),
			),
		};
	});
	app.post("/api/devices", async (request, reply) => {
		const device = await options.ledger.enrollDevice(
			deviceEnrollmentSchema.parse(request.body),
			requestActor(request),
		);

		return reply.code(201).send({ device });
	});
	app.post<{ Params: { deviceId: string } }>(
		"/api/devices/:deviceId/revoke",
		async (request) => ({
			device: await options.ledger.revokeDevice(
				request.params.deviceId,
				requestActor(request),
			),
		}),
	);
	app.get("/api/repository-mappings", async () => ({
		mappings: await options.ledger.listRepositoryMappings(),
	}));
	app.post("/api/repository-mappings", async (request, reply) => {
		const mapping = await options.ledger.configureRepositoryMapping(
			repositoryMappingSchema.parse(request.body),
			requestActor(request),
		);

		return reply.code(201).send({ mapping });
	});
	app.post("/api/agents", async (request, reply) => {
		const enrollment = await options.ledger.createAgentProfile(
			createAgentProfileSchema.parse(request.body),
			requestActor(request),
		);

		return reply.code(201).send({
			profile: enrollment.profile,
			secret: enrollment.secret,
			setup: buildAgentSetup(
				enrollment.profile,
				setupBaseUrl,
				enrollment.secret,
			),
			setups: buildAgentSetups(
				enrollment.profile,
				setupBaseUrl,
				enrollment.secret,
			),
		});
	});
	app.patch<{ Params: { agentId: string } }>(
		"/api/agents/:agentId/scope",
		async (request) => ({
			profile: await options.ledger.updateAgentDataScope(
				request.params.agentId,
				agentDataScopeSchema.parse(request.body),
				requestActor(request),
			),
		}),
	);
	app.get<{ Params: { agentId: string } }>(
		"/api/agents/:agentId/setup",
		async (request) => {
			const profile = await options.ledger.getAgentProfile(
				request.params.agentId,
			);

			if (!profile)
				throw new DomainError(
					`Agent profile ${request.params.agentId} does not exist.`,
					"NOT_FOUND",
				);
			return {
				profile,
				setup: buildAgentSetup(profile, setupBaseUrl),
				setups: buildAgentSetups(profile, setupBaseUrl),
			};
		},
	);
	app.get<{ Params: { agentId: string } }>(
		"/api/agents/:agentId/files",
		async (request, reply) => {
			const query = z
				.object({
					scope: z.enum(["agent", "user"]).default("agent"),
					uri: z.string().max(1100).optional(),
				})
				.parse(request.query);
			const profile = await options.ledger.getAgentProfile(
				request.params.agentId,
			);

			if (!profile?.memberId || profile.status !== "active")
				throw new DomainError(
					"Active agent profile not found.",
					"NOT_FOUND",
				);
			if (identity && identity.member(request).id !== profile.memberId) {
				throw new DomainError(
					"Personal workspace files belong to another user.",
					"FORBIDDEN",
				);
			}

			const fileAccess: AccessScope = {
				kind: "agent",
				organizationId: (await options.ledger.workspace()).organization
					.id,
				memberId: profile.memberId,
				agentProfileId: profile.id,
				dataScope: profile.dataScope,
			};

			reply.header("cache-control", "no-store");
			if (query.uri)
				return {
					file: await options.ledger.readAgentWorkspaceFile(
						fileAccess,
						query.uri,
						query.scope,
					),
				};
			return {
				rootUri: options.ledger.agentWorkspaceRoot(
					fileAccess,
					query.scope,
				),
				files: await options.ledger.listAgentWorkspaceFiles(
					fileAccess,
					"",
					query.scope,
				),
			};
		},
	);
	app.post<{ Params: { agentId: string } }>(
		"/api/agents/:agentId/rotate-secret",
		async (request) => {
			const enrollment = await options.ledger.rotateAgentSecret(
				request.params.agentId,
				requestActor(request),
			);

			return {
				profile: enrollment.profile,
				secret: enrollment.secret,
				setup: buildAgentSetup(
					enrollment.profile,
					setupBaseUrl,
					enrollment.secret,
				),
				setups: buildAgentSetups(
					enrollment.profile,
					setupBaseUrl,
					enrollment.secret,
				),
			};
		},
	);
	app.post<{ Params: { agentId: string } }>(
		"/api/agents/:agentId/revoke",
		async (request) => ({
			profile: await options.ledger.revokeAgentProfile(
				request.params.agentId,
				requestActor(request),
			),
		}),
	);
	app.get("/api/context", async (request) =>
		options.ledger.contextIndex(access(request)),
	);
	app.get("/api/source-documents", async (request) => {
		const query = z
			.object({
				q: z.string().max(2_000).default(""),
				limit: z.coerce.number().int().min(1).max(500).default(100),
				at: z.iso.datetime().optional(),
			})
			.parse(request.query);

		return {
			documents: await options.ledger.listSourceDocuments({
				query: query.q,
				limit: query.limit,
				...(query.at ? { at: query.at } : {}),
				access: access(request),
			}),
		};
	});
	app.get<{ Params: { sourceEventId: string } }>(
		"/api/source-documents/:sourceEventId",
		async (request) => {
			const query = z
				.object({
					sectionId: z.string().trim().min(1).max(160).optional(),
					characterBudget: z.coerce
						.number()
						.int()
						.min(1_000)
						.max(200_000)
						.default(40_000),
					at: z.iso.datetime().optional(),
				})
				.parse(request.query);

			return options.ledger.readSourceDocument({
				access: access(request),
				sourceEventId: z
					.string()
					.uuid()
					.parse(request.params.sourceEventId),
				...(query.sectionId ? { sectionId: query.sectionId } : {}),
				...(query.at ? { at: query.at } : {}),
				characterBudget: query.characterBudget,
			});
		},
	);
	app.get("/api/context/search", async (request) => {
		const query = z
			.object({
				objective: z.string().trim().min(1).max(2_000),
				q: z.string().max(2_000).default(""),
				project: z.string().trim().min(1).max(240).optional(),
				taskId: z.string().uuid().optional(),
				limit: z.coerce.number().int().min(1).max(100).default(20),
				characterBudget: z.coerce
					.number()
					.int()
					.min(8_000)
					.max(200_000)
					.default(30_000),
			})
			.parse(request.query);

		return options.ledger.retrieve({
			access: access(request),
			objective: query.objective,
			query: query.q,
			...(query.project ? { project: query.project } : {}),
			...(query.taskId ? { taskId: query.taskId } : {}),
			limit: query.limit,
			characterBudget: query.characterBudget,
			includeSources: true,
		});
	});
	app.get<{ Params: { entryId: string } }>(
		"/api/context/entries/:entryId",
		async (request) => {
			return access(request).kind === "admin"
				? options.ledger.contextDetail(request.params.entryId)
				: options.ledger.contextHistoryForAccess(
						request.params.entryId,
						access(request),
					);
		},
	);
	app.post("/api/context/entries", async (request, reply) => {
		const input = createContextEntrySchema.parse(request.body);
		const { effectiveFrom, effectiveTo, ...required } = input;
		const entry = await options.ledger.createContextEntry(
			{
				...required,
				...(effectiveFrom ? { effectiveFrom } : {}),
				...(effectiveTo !== undefined ? { effectiveTo } : {}),
				clientEventId: idempotencyKey(request),
			},
			requestActor(request),
			access(request),
		);

		return reply.code(201).send({ entry });
	});
	app.post<{ Params: { entryId: string } }>(
		"/api/context/entries/:entryId/corrections",
		async (request, reply) => {
			const body = z
				.object({
					correction: z.string().trim().min(1).max(20_000),
					reason: z.string().trim().max(2_000).default(""),
				})
				.parse(request.body);
			const proposal = await options.ledger.proposeContextCorrection({
				entryId: request.params.entryId,
				correction: body.correction,
				reason: body.reason,
				actor: requestActor(request),
				access: access(request),
				clientEventId: idempotencyKey(request),
			});

			// A member's correction applies at once; it can be undone.
			if (proposal.state === "pending")
				await options.ledger.approveProposal(
					proposal.id,
					requestActor(request),
					"Corrected in Panini.",
				);

			return reply.code(201).send({
				proposal:
					(await options.ledger.getProposal(proposal.id)) ?? proposal,
			});
		},
	);
	app.post<{ Params: { entryId: string } }>(
		"/api/context/entries/:entryId/lifecycle",
		async (request) => {
			const input = z
				.object({
					lifecycleState: z.enum(contextLifecycleStates),
					reason: z.string().trim().min(3).max(2_000),
					effectiveFrom: z
						.string()
						.datetime({ offset: true })
						.optional(),
					effectiveTo: z
						.string()
						.datetime({ offset: true })
						.nullable()
						.optional(),
					links: z.array(contextLinkSchema).max(100).optional(),
				})
				.strict()
				.parse(request.body);
			const { effectiveFrom, effectiveTo, links, ...required } = input;

			return {
				entry: await options.ledger.reviseContextLifecycle(
					request.params.entryId,
					{
						...required,
						...(effectiveFrom ? { effectiveFrom } : {}),
						...(effectiveTo !== undefined ? { effectiveTo } : {}),
						...(links ? { links } : {}),
						clientEventId: idempotencyKey(request),
					},
					requestActor(request),
					access(request),
				),
			};
		},
	);
	app.get("/api/proposals", async (request) => ({
		proposals: await options.ledger.visibleProposals(
			await options.ledger.listProposals(),
			access(request),
		),
	}));
	app.get<{ Params: { assessmentId: string } }>(
		"/api/evidence/assessments/:assessmentId",
		async (request) => ({
			assessment: await options.ledger.evidenceAssessmentForAccess(
				request.params.assessmentId,
				access(request),
			),
		}),
	);

	app.get("/api/evidence/coverage", async (request, reply) => {
		if (access(request).kind !== "admin") {
			return reply
				.code(403)
				.send({ error: "An administrator is required." });
		}

		const budgetId = process.env.PANINI_EVIDENCE_V2_BUDGET_ID;

		return {
			coverage: await options.ledger.evidenceCoverage(
				process.env.PANINI_EVIDENCE_V2_VERSION ??
					options.config.app.intelligence.evidenceV2.pipelineVersion,
			),
			budget:
				budgetId && z.uuid().safeParse(budgetId).success
					? await options.ledger.evidenceBudget(budgetId)
					: null,
		};
	});

	app.get("/api/evidence/events", async (request) => {
		const query = z
			.object({
				limit: z.coerce.number().int().min(1).max(500).default(100),
			})
			.parse(request.query);
		const events = (
			await options.ledger.listEvidenceForAccess(
				query.limit,
				access(request),
			)
		).map(({ payload: _payload, ...event }) => event);

		return { events };
	});
	app.get<{ Params: { eventId: string } }>(
		"/api/evidence/events/:eventId",
		async (request) => {
			return options.ledger.evidenceDetail(
				request.params.eventId,
				access(request),
				process.env.PANINI_EVIDENCE_V2_VERSION ??
					options.config.app.intelligence.evidenceV2.pipelineVersion,
			);
		},
	);
	app.delete<{ Params: { eventId: string } }>(
		"/api/evidence/events/:eventId",
		async (request, reply) => {
			const revoked = await options.ledger.revokeEvidence(
				request.params.eventId,
				requestActor(request),
			);

			return reply.code(revoked ? 200 : 404).send(
				revoked
					? { revoked: true }
					: {
							error: "Evidence content was not found or was already revoked.",
						},
			);
		},
	);
	app.post<{ Params: { eventId: string } }>(
		"/api/evidence/events/:eventId/reopen",
		async (request, reply) => {
			if (!evidenceV2Enabled)
				return reply
					.code(409)
					.send({ error: "Evidence v2 is not enabled." });
			if (access(request).kind !== "admin")
				return reply
					.code(403)
					.send({ error: "An administrator is required." });

			const budgetId = process.env.PANINI_EVIDENCE_V2_BUDGET_ID;

			if (!budgetId || !z.uuid().safeParse(budgetId).success) {
				return reply.code(409).send({
					error: "An evidence budget is required to reopen extraction.",
				});
			}

			const { reason } = z
				.strictObject({ reason: z.string().trim().min(3).max(500) })
				.parse(request.body);
			const pipelineVersion =
				process.env.PANINI_EVIDENCE_V2_VERSION ??
				options.config.app.intelligence.evidenceV2.pipelineVersion;
			const job = await options.ledger.reopenNoClaimEvidence({
				eventId: request.params.eventId,
				pipelineVersion,
				dispatchEpoch: `${pipelineVersion}:${budgetId}`,
				actor: requestActor(request),
				reason,
			});

			return reply.code(202).send({ jobId: job.id, state: job.state });
		},
	);

	app.post("/api/evidence/events", async (request, reply) => {
		const body = evidenceEventSchema.parse(request.body);
		const result = await options.ledger.recordSource({
			...body,
			fetchedAt: body.fetchedAt ?? new Date().toISOString(),
			payload: body.payload as JsonValue,
			contentHash: contentHash({
				provider: body.provider,
				providerEventId: body.providerEventId,
				eventKind: body.eventKind,
				payload: body.payload,
			}),
		});

		return reply.code(result.inserted ? 201 : 200).send(result);
	});

	app.post("/api/webhooks/github", async (request, reply) => {
		if (!github && !githubApp)
			return reply.code(409).send({
				error: "The GitHub webhook adapter is not enabled and configured.",
			});

		const rawBody = (request as FastifyRequest & { rawBody?: Buffer })
			.rawBody;

		if (!rawBody)
			return reply
				.code(400)
				.send({ error: "The raw GitHub webhook body is unavailable." });
		try {
			let adapter = github;

			if (githubApp) {
				const signatureHeader = request.headers["x-hub-signature-256"];
				const signature = Array.isArray(signatureHeader)
					? signatureHeader[0]
					: signatureHeader;

				if (
					!options.config.githubWebhookSecret ||
					!verifyGithubSignature(
						options.config.githubWebhookSecret,
						rawBody,
						signature,
					)
				) {
					return reply.code(401).send({
						error: "GitHub webhook signature is invalid.",
					});
				}

				const payload = JSON.parse(rawBody.toString("utf8")) as {
					installation?: { id?: number };
				};
				const installationId = payload.installation?.id;
				const installation = (
					await options.ledger.workspace()
				).installations.find(
					(item) =>
						item.provider === "github" &&
						item.installationKey === String(installationId) &&
						item.status !== "revoked" &&
						item.status !== "disabled",
				);

				if (!installation)
					return reply.code(202).send({
						outcome: "ignored",
						reason: "GitHub installation is not connected.",
					});

				const repositories = installation.config.repositories;

				adapter = new GithubWebhookAdapter(
					{
						secret: options.config.githubWebhookSecret,
						installationKey: installation.installationKey,
						repositories: Array.isArray(repositories)
							? repositories.filter(
									(name): name is string =>
										typeof name === "string",
								)
							: [],
					},
					recorder,
					options.ledger,
				);
			}

			const result = await adapter!.handle(request.headers, rawBody);

			return reply
				.code(result.outcome === "ignored" ? 202 : 200)
				.send(result);
		} catch (error) {
			if (error instanceof Error && error.message.includes("signature")) {
				return reply.code(401).send({ error: error.message });
			}
			throw error;
		}
	});

	/*
	 * `panini connect`: the CLI opens a short-lived request, a signed-in member
	 * approves it in the browser, and the CLI collects the new secret once.
	 */
	const connectRequests = new Map<
		string,
		{
			code: string;
			pollHash: string;
			harness: z.infer<typeof connectStartSchema>["harness"];
			repository: string | null;
			hostname: string | null;
			createdAt: number;
			state: "pending" | "approved" | "denied";
			secret: string | null;
			profileId: string | null;
			profileName: string | null;
			/** Set when the request came from an MCP OAuth authorize call. */
			oauth?: {
				clientId: string;
				redirectUri: string;
				codeChallenge: string;
				state: string | null;
			};
		}
	>();
	const connectTtlMs = 10 * 60_000;
	const oauthResource = `${setupBaseUrl}/mcp`;
	const oauthSigner =
		options.ledger.oauth && options.config.contentEncryptionKey
			? new AccessTokenSigner(options.config.contentEncryptionKey)
			: null;
	const oauthCodes = new Map<
		string,
		{
			clientId: string;
			redirectUri: string;
			codeChallenge: string;
			agentProfileId: string;
			expiresAt: number;
		}
	>();

	const redirectWith = (
		uri: string,
		params: Record<string, string | null>,
	) => {
		const url = new URL(uri);

		for (const [key, value] of Object.entries(params))
			if (value !== null) url.searchParams.set(key, value);
		return url.toString();
	};

	const liveConnect = (id: string) => {
		const item = connectRequests.get(id);

		if (item && Date.now() - item.createdAt > connectTtlMs) {
			connectRequests.delete(id);
			return null;
		}
		return item ?? null;
	};

	app.post("/api/connect/start", async (request, reply) => {
		const body = connectStartSchema.parse(request.body);

		for (const [id] of connectRequests) liveConnect(id);
		if (connectRequests.size >= 100)
			return reply
				.code(429)
				.send({ error: "Too many pending connect requests." });

		const id = randomUUID();
		const pollToken = randomBytes(24).toString("base64url");
		const code = randomBytes(3).toString("hex").toUpperCase();

		connectRequests.set(id, {
			code,
			pollHash: createHash("sha256").update(pollToken).digest("hex"),
			harness: body.harness,
			repository: body.repository ?? null,
			hostname: body.hostname ?? null,
			createdAt: Date.now(),
			state: "pending",
			secret: null,
			profileId: null,
			profileName: null,
		});
		return reply.code(201).send({
			requestId: id,
			pollToken,
			code,
			approveUrl: `${setupBaseUrl}/app/connect?request=${id}`,
			expiresInSeconds: connectTtlMs / 1000,
		});
	});
	app.post("/api/connect/poll", async (request) => {
		const body = z
			.object({
				requestId: z.uuid(),
				pollToken: z.string().min(10).max(200),
			})
			.parse(request.body);
		const item = liveConnect(body.requestId);

		if (
			!item ||
			!tokensMatch(
				createHash("sha256").update(body.pollToken).digest("hex"),
				item.pollHash,
			)
		)
			return { state: "expired" };
		if (item.state !== "approved") return { state: item.state };

		const secret = item.secret;

		// The secret leaves the server exactly once.
		connectRequests.delete(body.requestId);
		return {
			state: "approved",
			secret,
			profileId: item.profileId,
			profileName: item.profileName,
			mcpUrl: `${setupBaseUrl}/mcp`,
		};
	});
	app.get<{ Params: { requestId: string } }>(
		"/api/connect/requests/:requestId",
		async (request) => {
			const item = liveConnect(request.params.requestId);

			if (!item)
				throw new DomainError("Connect request expired.", "NOT_FOUND");
			return {
				code: item.code,
				harness: item.harness,
				repository: item.repository,
				hostname: item.hostname,
				state: item.state,
			};
		},
	);
	app.post<{ Params: { requestId: string } }>(
		"/api/connect/requests/:requestId/decision",
		async (request) => {
			const item = liveConnect(request.params.requestId);

			if (!item || item.state !== "pending")
				throw new DomainError("Connect request expired.", "NOT_FOUND");

			const body = z
				.object({
					decision: z.enum(["approve", "deny"]),
					name: z.string().trim().min(1).max(120).optional(),
					project: z.string().trim().min(1).max(240).optional(),
				})
				.parse(request.body);

			if (body.decision === "deny") {
				item.state = "denied";
				return {
					state: item.state,
					...(item.oauth
						? {
								redirectTo: redirectWith(
									item.oauth.redirectUri,
									{
										error: "access_denied",
										state: item.oauth.state,
									},
								),
							}
						: {}),
				};
			}

			const actor = requestActor(request);
			const memberId = identity
				? identity.member(request).id
				: (await activeLocalAdmin())?.member.id;

			if (!memberId)
				throw new DomainError(
					"No member can own this agent.",
					"FORBIDDEN",
				);

			const mapping = item.repository
				? (await options.ledger.listRepositoryMappings()).find(
						(candidate) =>
							candidate.repository.toLowerCase() ===
							item.repository!.toLowerCase(),
					)
				: undefined;

			if (item.repository && !mapping && body.project)
				await options.ledger.configureRepositoryMapping(
					{
						repository: item.repository,
						project: body.project,
						contextPaths: [],
					},
					actor,
				);

			const name =
				body.name ??
				`${item.harness.replaceAll("_", " ")} on ${item.hostname ?? "this machine"}`;
			const projects = [mapping?.project ?? body.project ?? "*"];
			// Reconnecting an existing agent of yours gives it a new secret instead of failing.
			const existing = (
				await options.ledger.listAgentProfiles(memberId)
			).find(
				(profile) =>
					profile.status === "active" &&
					profile.name.toLocaleLowerCase("en") ===
						name.toLocaleLowerCase("en"),
			);

			if (existing)
				await options.ledger.updateAgentDataScope(
					existing.id,
					{ ...existing.dataScope, projects },
					actor,
				);

			const enrollment = existing
				? await options.ledger.rotateAgentSecret(existing.id, actor)
				: await options.ledger.createAgentProfile(
						{
							memberId,
							name,
							harness: item.harness,
							description: item.repository
								? `Connected from ${item.repository} with panini connect.`
								: "Connected with panini connect.",
							// Spec 7.3: every grant except reading raw sources.
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
								projects,
								contextPaths: ["/"],
								sourceVisibilities: ["company"],
							},
						},
						actor,
					);

			item.state = "approved";
			item.profileId = enrollment.profile.id;
			item.profileName = enrollment.profile.name;
			if (item.oauth) {
				// OAuth clients never see the enrollment secret; they get a code.
				const code = `pac_${randomBytes(24).toString("base64url")}`;

				oauthCodes.set(code, {
					clientId: item.oauth.clientId,
					redirectUri: item.oauth.redirectUri,
					codeChallenge: item.oauth.codeChallenge,
					agentProfileId: enrollment.profile.id,
					expiresAt: Date.now() + 60_000,
				});
				connectRequests.delete(request.params.requestId);
				return {
					state: item.state,
					profile: enrollment.profile,
					redirectTo: redirectWith(item.oauth.redirectUri, {
						code,
						state: item.oauth.state,
					}),
				};
			}
			item.secret = enrollment.secret;
			return { state: item.state, profile: enrollment.profile };
		},
	);

	// MCP OAuth 2.1 (spec 7.2): metadata, client registration, authorize, token.
	if (oauthSigner) {
		const protectedResource = {
			resource: oauthResource,
			authorization_servers: [setupBaseUrl],
			bearer_methods_supported: ["header"],
			scopes_supported: ["mcp"],
		};

		app.get(
			"/.well-known/oauth-protected-resource",
			async () => protectedResource,
		);
		app.get(
			"/.well-known/oauth-protected-resource/mcp",
			async () => protectedResource,
		);
		app.get("/.well-known/oauth-authorization-server", async () => ({
			issuer: setupBaseUrl,
			authorization_endpoint: `${setupBaseUrl}/oauth/authorize`,
			token_endpoint: `${setupBaseUrl}/oauth/token`,
			registration_endpoint: `${setupBaseUrl}/oauth/register`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code", "refresh_token"],
			code_challenge_methods_supported: ["S256"],
			token_endpoint_auth_methods_supported: ["none"],
			scopes_supported: ["mcp"],
		}));
		app.post("/oauth/register", async (request, reply) => {
			const body = z
				.object({
					client_name: z
						.string()
						.trim()
						.min(1)
						.max(120)
						.default("MCP client"),
					redirect_uris: z.array(z.string().max(500)).min(1).max(10),
				})
				.parse(request.body);

			if (!body.redirect_uris.every(validRedirectUri))
				return reply.code(400).send({
					error: "invalid_redirect_uri",
					error_description:
						"Redirect URIs must use https, or http on a loopback address.",
				});

			const client = await options.ledger.oauth!.registerClient({
				clientName: body.client_name,
				redirectUris: body.redirect_uris,
			});

			return reply.code(201).send({
				client_id: client.clientId,
				client_name: client.clientName,
				redirect_uris: client.redirectUris,
				token_endpoint_auth_method: "none",
				grant_types: ["authorization_code", "refresh_token"],
				response_types: ["code"],
			});
		});
		app.get("/oauth/authorize", async (request, reply) => {
			const query = z
				.object({
					response_type: z.literal("code"),
					client_id: z.string().min(1).max(200),
					redirect_uri: z.string().max(500),
					code_challenge: z.string().min(43).max(128),
					code_challenge_method: z.literal("S256"),
					state: z.string().max(500).optional(),
					resource: z.string().max(500).optional(),
					scope: z.string().max(200).optional(),
				})
				.safeParse(request.query);

			if (!query.success)
				return reply.code(400).send({
					error: "invalid_request",
					error_description:
						"Authorization needs response_type=code, a client, a redirect URI and an S256 PKCE challenge.",
				});

			const client = await options.ledger.oauth!.getClient(
				query.data.client_id,
			);

			// Never redirect to an unregistered URI.
			if (
				!client ||
				!client.redirectUris.includes(query.data.redirect_uri)
			)
				return reply.code(400).send({
					error: "invalid_client",
					error_description:
						"Unknown client or unregistered redirect URI.",
				});
			if (query.data.resource && query.data.resource !== oauthResource)
				return reply.redirect(
					redirectWith(query.data.redirect_uri, {
						error: "invalid_target",
						state: query.data.state ?? null,
					}),
				);
			for (const [id] of connectRequests) liveConnect(id);

			const id = randomUUID();

			connectRequests.set(id, {
				code: randomBytes(3).toString("hex").toUpperCase(),
				pollHash: "",
				harness: "generic_mcp",
				repository: null,
				hostname: client.clientName.slice(0, 120),
				createdAt: Date.now(),
				state: "pending",
				secret: null,
				profileId: null,
				profileName: null,
				oauth: {
					clientId: client.clientId,
					redirectUri: query.data.redirect_uri,
					codeChallenge: query.data.code_challenge,
					state: query.data.state ?? null,
				},
			});
			return reply.redirect(`/app/connect?request=${id}`);
		});
		app.post("/oauth/token", async (request, reply) => {
			const body = (request.body ?? {}) as Record<
				string,
				string | undefined
			>;

			const fail = (error: string, description: string, status = 400) =>
				reply
					.code(status)
					.header("cache-control", "no-store")
					.send({ error, error_description: description });

			let agentProfileId: string | null = null;
			const clientId = body.client_id ?? "";

			if (body.resource && body.resource !== oauthResource)
				return fail(
					"invalid_target",
					"Tokens are issued only for this /mcp resource.",
				);
			if (body.grant_type === "authorization_code") {
				const code = oauthCodes.get(body.code ?? "");

				// Codes are single use.
				oauthCodes.delete(body.code ?? "");
				if (
					!code ||
					code.expiresAt < Date.now() ||
					code.clientId !== clientId ||
					code.redirectUri !== body.redirect_uri ||
					!verifyPkce(body.code_verifier ?? "", code.codeChallenge)
				)
					return fail(
						"invalid_grant",
						"The code is invalid, expired, or does not match.",
					);
				agentProfileId = code.agentProfileId;
			} else if (body.grant_type === "refresh_token") {
				agentProfileId =
					await options.ledger.oauth!.consumeRefreshToken(
						body.refresh_token ?? "",
						clientId,
					);
				if (!agentProfileId)
					return fail(
						"invalid_grant",
						"The refresh token is invalid or already used.",
					);
			} else
				return fail(
					"unsupported_grant_type",
					"Use authorization_code or refresh_token.",
				);
			if (
				!(await options.ledger.authenticateAgentProfile(agentProfileId))
			)
				return fail("invalid_grant", "The agent profile is revoked.");
			return reply.header("cache-control", "no-store").send({
				access_token: oauthSigner.issue({
					agentProfileId,
					audience: oauthResource,
				}),
				token_type: "Bearer",
				expires_in: ACCESS_TOKEN_TTL_SECONDS,
				refresh_token: await options.ledger.oauth!.issueRefreshToken(
					clientId,
					agentProfileId,
				),
				scope: "mcp",
			});
		});
	}

	// OTLP/HTTP JSON logs from an agent's own telemetry: token use and cost per session.
	app.post("/api/agent/otlp/v1/logs", async (request, reply) => {
		const token = bearerToken(request);
		const authenticated = token
			? await options.ledger.authenticateAgentSecret(token)
			: null;

		if (!authenticated)
			return reply.code(401).header("www-authenticate", "Bearer").send({
				error: "A valid agent enrollment secret is required.",
			});

		const scope = {
			kind: "agent" as const,
			organizationId: authenticated.member.organizationId,
			memberId: authenticated.member.id,
			agentProfileId: authenticated.profile.id,
			dataScope: authenticated.profile.dataScope,
		};
		const usage = usageFromLogs(request.body);

		for (const item of usage) {
			const session = await options.ledger.resolveAgentSession(scope, {
				clientSessionId: item.sessionId,
				harness: authenticated.profile.harness,
			});

			await options.ledger.agents.addSessionUsage(session.id, {
				...(item.costUsd !== null ? { costUsd: item.costUsd } : {}),
				...(item.inputTokens !== null
					? { inputTokens: item.inputTokens }
					: {}),
				...(item.outputTokens !== null
					? { outputTokens: item.outputTokens }
					: {}),
			});
		}
		return reply.send({ partialSuccess: {}, accepted: usage.length });
	});

	// Harness lifecycle hooks: authenticated by the agent's own secret, never blocking the agent.
	app.post("/api/agent/hooks", async (request, reply) => {
		const token = bearerToken(request);
		const authenticated = token
			? await options.ledger.authenticateAgentSecret(token)
			: null;

		if (!authenticated)
			return reply.code(401).header("www-authenticate", "Bearer").send({
				error: "A valid agent enrollment secret is required.",
			});

		const body = z
			.object({
				event: z.enum([
					"session_start",
					"session_end",
					"session_failed",
					"heartbeat",
				]),
				clientSessionId: z.string().trim().min(1).max(200),
				harness: z.string().trim().max(60).optional(),
				repository: z.string().trim().max(200).optional(),
				branch: z.string().trim().max(200).optional(),
				objective: z.string().trim().max(300).optional(),
			})
			.parse(request.body);
		const scope = {
			kind: "agent" as const,
			organizationId: authenticated.member.organizationId,
			memberId: authenticated.member.id,
			agentProfileId: authenticated.profile.id,
			dataScope: authenticated.profile.dataScope,
		};

		// An end event for a session Panini never saw starts nothing.
		if (
			(body.event === "session_end" || body.event === "session_failed") &&
			!(
				await options.ledger.agents.listSessions({
					agentProfileIds: [authenticated.profile.id],
					limit: 200,
				})
			).some((item) => item.clientSessionId === body.clientSessionId)
		)
			return reply.send({
				session: null,
				inferredClaim: null,
				brief: null,
			});

		let session = await options.ledger.resolveAgentSession(scope, {
			clientSessionId: body.clientSessionId,
			harness: body.harness ?? authenticated.profile.harness,
			repository: body.repository ?? null,
			branch: body.branch ?? null,
			objective: body.objective ?? null,
		});
		let inferredClaim = null;

		if (body.event === "session_end" || body.event === "session_failed") {
			session =
				(await options.ledger.agents.endSession(
					session.id,
					body.event === "session_end" ? "ended" : "failed",
				)) ?? session;
		} else if (body.event === "session_start") {
			inferredClaim = await options.ledger
				.inferClaimFromBranch(scope, session)
				.catch(() => null);
		}
		await options.ledger.agents.recordActivity({
			agentProfileId: authenticated.profile.id,
			memberId: authenticated.member.id,
			sessionId: session.id,
			tool: `hook:${body.event}`,
			actionClass: "session",
			targetIds: inferredClaim ? [inferredClaim.taskId] : [],
			resultCount: null,
			outcome: "ok",
			detail: null,
			durationMs: 0,
		});

		const brief =
			body.event === "session_start"
				? await options.ledger.sessionStartBrief(scope, session)
				: null;

		return reply.send({
			session: { id: session.id, state: session.state },
			inferredClaim,
			brief,
		});
	});

	app.post("/api/relay/work-reports", async (request, reply) => {
		const rawBody = (request as FastifyRequest & { rawBody?: Buffer })
			.rawBody;

		if (!rawBody)
			return reply
				.code(400)
				.send({ error: "The raw relay envelope is unavailable." });

		const envelope = relayEnvelopeSchema.parse(request.body);
		const signatureValue = request.headers["x-panini-signature"];
		const signature = Array.isArray(signatureValue)
			? signatureValue[0]
			: signatureValue;
		const device = await options.ledger.getDevice(envelope.deviceId);

		if (
			!device ||
			device.status !== "active" ||
			!signature ||
			!verifyRelayEnvelope(rawBody, signature, device.publicKey)
		) {
			return reply.code(401).send({
				error: "The relay device signature is invalid or the device is revoked.",
			});
		}

		const profile = await options.ledger.getAgentProfile(
			device.agentProfileId,
		);

		if (!profile || profile.status !== "active" || !profile.memberId)
			return reply.code(401).send({
				error: "The relay device's agent profile is revoked.",
			});

		const deviceAccess = {
			kind: "agent" as const,
			organizationId: device.organizationId,
			memberId: profile.memberId,
			agentProfileId: profile.id,
			dataScope: profile.dataScope,
		};
		const reportTask = envelope.report.workItemId
			? await options.ledger.getTaskForAccess(
					envelope.report.workItemId,
					deviceAccess,
				)
			: null;

		if (envelope.report.workItemId && !reportTask)
			return reply.code(403).send({
				error: "The relay device's agent profile cannot see this task.",
			});

		const payload = {
			deviceId: device.id,
			agentProfileId: device.agentProfileId,
			privacyMode: device.privacyMode,
			workItemId: envelope.report.workItemId,
			phase: envelope.report.phase,
			outcome: envelope.report.outcome,
			artifactRefs: envelope.report.artifactRefs,
			verification: envelope.report.verification,
		};
		const result = await options.ledger.recordSource({
			provider: "agent",
			installationKey: device.id,
			providerEventId: envelope.report.reportId,
			eventKind: `work.${envelope.report.phase}`,
			occurredAt: envelope.report.occurredAt,
			fetchedAt: new Date().toISOString(),
			sourceRef: envelope.report.workItemId
				? `panini:task:${envelope.report.workItemId}`
				: `agent-report:${envelope.report.reportId}`,
			sourceUrl: null,
			contentHash: contentHash(payload),
			visibility: reportTask
				? await options.ledger.taskEvidenceVisibility(reportTask)
				: "company",
			payloadVersion: "relay-work-report-v1",
			payload,
		});

		await options.ledger.touchDevice(device.id);
		return reply
			.code(result.inserted ? 201 : 200)
			.send({ inserted: result.inserted, evidenceId: result.event.id });
	});

	app.post("/api/tasks", async (request, reply) => {
		const body = createTaskSchema.parse(request.body);
		const task = await options.ledger.createTask(
			{
				...body,
				owner: body.owner ?? null,
				project: body.project ?? null,
				projectId: body.projectId ?? null,
				dueDate: body.dueDate ?? null,
				clientEventId: idempotencyKey(request),
			},
			requestActor(request),
		);

		return reply.code(201).send({ task });
	});

	app.post("/api/projects", async (request, reply) => {
		const body = z
			.object({
				name: z.string().trim().min(1).max(180),
				outcome: z.string().trim().min(1).max(5_000),
				owner: nullableString,
				aliases: z
					.array(z.string().trim().min(1).max(180))
					.max(30)
					.default([]),
			})
			.strict()
			.parse(request.body);
		const project = await options.ledger.createProject(
			{ ...body, owner: body.owner ?? null },
			requestActor(request),
		);

		return reply.code(201).send({ project });
	});

	app.get<{ Params: { projectId: string } }>(
		"/api/projects/:projectId",
		async (request) =>
			options.ledger.projectDetail(
				request.params.projectId,
				access(request),
			),
	);
	app.patch<{ Params: { projectId: string } }>(
		"/api/projects/:projectId",
		async (request) => {
			const body = z
				.object({
					baseVersion: z.number().int().positive(),
					changes: projectChangesSchema,
				})
				.strict()
				.parse(request.body);

			return {
				project: await options.ledger.reviseProject(
					request.params.projectId,
					body.baseVersion,
					withoutUndefined(body.changes) as ProjectChanges,
					requestActor(request),
				),
			};
		},
	);
	app.get("/api/project-proposals", async (request) => ({
		proposals: await options.ledger.listProjectProposals(access(request)),
	}));
	app.post("/api/project-proposals", async (request, reply) => {
		const body = projectProposalSchema.parse(request.body);
		const input = {
			changes: withoutUndefined(body.changes) as ProjectChanges,
			rationale: body.rationale,
			requestedBy: requestActor(request),
			evidenceIds: body.evidenceIds,
		};
		const proposal = body.projectId
			? await options.ledger.proposeProjectChange(body.projectId, {
					...input,
					baseVersion: body.baseVersion ?? 0,
				})
			: await options.ledger.proposeProjectCreation(input);

		return reply.code(201).send({ proposal });
	});
	app.post<{ Params: { proposalId: string } }>(
		"/api/project-proposals/:proposalId/approve",
		async (request) => {
			const body = z
				.object({
					note: z.string().max(2_000).nullable().default(null),
				})
				.parse(request.body);

			return {
				revision: await options.ledger.approveProjectProposal(
					request.params.proposalId,
					requestActor(request),
					body.note,
				),
			};
		},
	);
	app.post<{ Params: { proposalId: string } }>(
		"/api/project-proposals/:proposalId/reject",
		async (request) => {
			const body = z
				.object({
					note: z.string().max(2_000).nullable().default(null),
				})
				.parse(request.body);

			return {
				proposal: await options.ledger.rejectProjectProposal(
					request.params.proposalId,
					requestActor(request),
					body.note,
				),
			};
		},
	);

	app.post<{ Params: { taskId: string } }>(
		"/api/tasks/:taskId/outcome-contract-proposals",
		async (request, reply) => {
			const body = outcomeContractProposalSchema.parse(request.body);
			const proposal =
				await options.ledger.proposeOutcomeContractForAccess(
					{
						clientEventId: idempotencyKey(request),
						taskId: request.params.taskId,
						baseRevision: body.baseRevision,
						contract: body.contract,
						rationale: body.rationale,
						requestedBy: requestActor(request),
						evidenceIds: body.evidenceIds,
					},
					access(request),
				);

			return reply.code(201).send({ proposal });
		},
	);

	app.post<{ Params: { taskId: string } }>(
		"/api/tasks/:taskId/proposals",
		async (request, reply) => {
			const body = proposalSchema.parse(request.body);
			const proposal = await options.ledger.proposeForAccess(
				{
					clientEventId: idempotencyKey(request),
					taskId: request.params.taskId,
					baseRevision: body.baseRevision,
					changes: withoutUndefined(body.changes),
					rationale: body.rationale,
					evidenceIds: body.evidenceIds,
					requestedBy: requestActor(request),
				},
				access(request),
			);

			return reply.code(201).send({ proposal });
		},
	);

	app.get("/api/work-model", async (request) => {
		const query = z.object({ taskId: z.uuid() }).parse(request.query);

		return options.ledger.workModelForAccess(query.taskId, access(request));
	});

	app.get("/api/work-evidence", async (request) => {
		const query = z
			.object({
				taskId: z.uuid().optional(),
				entityId: z.uuid().optional(),
				limit: z.coerce.number().int().min(1).max(100).optional(),
			})
			.parse(request.query);

		return options.ledger.workEvidenceForAccess(access(request), {
			...(query.taskId ? { taskId: query.taskId } : {}),
			...(query.entityId ? { entityId: query.entityId } : {}),
			...(query.limit ? { limit: query.limit } : {}),
		});
	});

	app.get<{ Params: { taskId: string } }>(
		"/api/tasks/:taskId",
		async (request) =>
			options.ledger.taskHistoryForAccess(
				request.params.taskId,
				access(request),
			),
	);
	app.post<{ Params: { taskId: string } }>(
		"/api/tasks/:taskId/undo",
		async (request) => {
			const body = z
				.object({
					note: z.string().max(2_000).nullable().default(null),
				})
				.parse(request.body);

			return {
				task: await options.ledger.undoTask(
					request.params.taskId,
					requestActor(request),
					body.note,
					idempotencyKey(request),
				),
			};
		},
	);

	app.get("/api/changes", async (request) => ({
		changes: await options.ledger.recentChanges(access(request)),
	}));
	app.post<{ Params: { proposalId: string } }>(
		"/api/changes/:proposalId/undo",
		async (request) =>
			options.ledger.undoProposal(
				request.params.proposalId,
				requestActor(request),
				access(request),
			),
	);

	app.get<{ Params: { proposalId: string } }>(
		"/api/proposals/:proposalId",
		async (request) =>
			options.ledger.proposalDetailForAccess(
				request.params.proposalId,
				access(request),
			),
	);

	app.post<{ Params: { proposalId: string } }>(
		"/api/proposals/:proposalId/approve",
		async (request) => {
			idempotencyKey(request);

			const body = z
				.object({
					note: z.string().max(2_000).nullable().default(null),
				})
				.parse(request.body);

			return {
				applied: await options.ledger.approveProposal(
					request.params.proposalId,
					requestActor(request),
					body.note,
				),
			};
		},
	);

	app.post<{ Params: { proposalId: string } }>(
		"/api/proposals/:proposalId/reject",
		async (request) => {
			idempotencyKey(request);

			const body = z
				.object({
					note: z.string().max(2_000).nullable().default(null),
				})
				.parse(request.body);

			return {
				proposal: await options.ledger.rejectProposal(
					request.params.proposalId,
					requestActor(request),
					body.note,
				),
			};
		},
	);

	app.post<{ Params: { proposalId: string } }>(
		"/api/proposals/:proposalId/supersede",
		async (request) => {
			idempotencyKey(request);

			const body = z
				.object({
					note: z.string().max(2_000).nullable().default(null),
				})
				.parse(request.body);

			return {
				proposal: await options.ledger.supersedeProposal(
					request.params.proposalId,
					requestActor(request),
					body.note,
				),
			};
		},
	);
	app.post<{ Params: { proposalId: string } }>(
		"/api/proposals/:proposalId/rebase",
		async (request) => {
			z.object({}).parse(request.body);
			return {
				proposal: await options.ledger.rebaseProposal(
					request.params.proposalId,
					requestActor(request),
					idempotencyKey(request),
				),
			};
		},
	);
	app.post<{ Params: { proposalId: string } }>(
		"/api/proposals/:proposalId/edit",
		async (request) => {
			const body = z
				.object({
					changes: z.record(z.string(), z.json()),
					rationale: z.string().trim().min(3).max(2_000),
				})
				.parse(request.body);

			return {
				proposal: await options.ledger.editProposal(
					request.params.proposalId,
					body.changes as ProposalChanges,
					body.rationale,
					requestActor(request),
					idempotencyKey(request),
				),
			};
		},
	);

	app.post("/api/notion/sync", async (_request, reply) => {
		if (!options.config.app.notion.enabled)
			return reply
				.code(409)
				.send({ error: "Notion is not enabled and configured." });

		const request = _request;
		const idempotencyKey = String(
			request.headers["idempotency-key"] ??
				randomBytes(16).toString("hex"),
		);
		const job = await options.jobs.enqueue(
			"connector.notion.sync_requested",
			`notion-sync:${idempotencyKey}`,
			{ requestedBy: requestActor(request) },
		);

		return reply.code(202).send({ state: "queued", jobId: job.id });
	});

	app.all("/mcp", async (request, reply) => {
		const token = bearerToken(request);
		let principal: McpPrincipal | null = null;

		if (
			options.config.adminToken &&
			tokensMatch(token, options.config.adminToken)
		) {
			principal = { kind: "admin" };
		} else if (token) {
			const oauthProfileId = oauthSigner?.verify(token, oauthResource);
			const authenticated = oauthProfileId
				? await options.ledger.authenticateAgentProfile(oauthProfileId)
				: await options.ledger.authenticateAgentSecret(token);

			if (authenticated)
				principal = {
					kind: "agent",
					...authenticated,
					sessionHint: {
						clientSessionId: headerText(
							request.headers["x-panini-session-id"],
							200,
						),
						harness: headerText(
							request.headers["x-panini-harness"],
							60,
						),
						repository: headerText(
							request.headers["x-panini-repository"],
							200,
						),
						branch: headerText(
							request.headers["x-panini-branch"],
							200,
						),
					},
				};
		}
		if (!principal) {
			return reply
				.code(401)
				.header(
					"www-authenticate",
					oauthSigner
						? `Bearer resource_metadata="${setupBaseUrl}/.well-known/oauth-protected-resource"`
						: "Bearer",
				)
				.send({
					error: "A valid agent enrollment secret or access token is required.",
				});
		}
		reply.hijack();
		await runWithMcpPrincipal(principal, () =>
			mcpNodeHandler(
				request.raw as unknown as Parameters<typeof mcpNodeHandler>[0],
				reply.raw,
				request.body,
			),
		);
	});

	app.setErrorHandler((error, _request, reply) => {
		if (error instanceof AuthError) {
			if (error.status === 429) reply.header("retry-after", "900");
			return reply.code(error.status).send({ error: error.message });
		}
		if (error instanceof ZodError) {
			return reply.code(400).send({
				error: error.issues.map((issue) => issue.message).join(" "),
			});
		}
		if (error instanceof DomainError) {
			const status =
				error.code === "NOT_FOUND"
					? 404
					: error.code === "CONFLICT"
						? 409
						: error.code === "FORBIDDEN"
							? 403
							: 400;

			return reply
				.code(status)
				.send({ error: error.message, code: error.code });
		}
		app.log.error(error);
		return reply
			.code(500)
			.send({ error: "An unexpected server error occurred." });
	});

	app.addHook("onClose", async () => {
		await mcp.close();
	});
	return app;
}
