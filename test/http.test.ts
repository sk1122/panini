import { generateKeyPairSync, randomUUID } from "node:crypto";
import pg from "pg";
import { migrate } from "../src/db/migrate.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import type { LedgerStore } from "../src/domain/store.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evidenceV2Default, type RuntimeConfig } from "../src/config.js";
import { AutonomousAdjudicator } from "../src/adjudication/engine.js";
import { GithubAppClient } from "../src/connectors/github/app-client.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { buildHttpServer } from "../src/http/server.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { MemoryLedgerStore } from "../src/store/memory.js";
import {
	createRelayEnvelope,
	serializeRelayEnvelope,
	signRelayEnvelope,
} from "../src/relay/protocol.js";

const config: RuntimeConfig = {
	jevWorkAllowedVisibilities: [],
	workDraftAllowedVisibilities: [],
	githubApp: null,
	app: {
		company: { name: "Example Company" },
		policy: {
			mode: "manual_review",
			autoApproveNewTasks: true,
			autoApproveContext: true,
			requireReviewForTaskChanges: true,
		},
		notion: {
			enabled: false,
			pollIntervalSeconds: 300,
			apiVersion: "2026-03-11",
			sources: [],
		},
		intelligence: {
			enabled: false,
			mode: "manual",
			intervalSeconds: 900,
			maxEventsPerRun: 50,
			maxEvidenceCharacters: 60_000,
			maxSourceDocumentCharacters: 320_000,
			maxContextCharacters: 30_000,
			minimumConfidence: 0.7,
			completionMinimumConfidence: 0.85,
			completionMinimumEvidenceItems: 2,
			completionEvidenceProviders: ["agent"],
			reconciliationEnabled: true,
			reconciliationIntervalSeconds: 900,
			reconciliationMinimumAgeSeconds: 300,
			sourceProviders: ["agent", "manual"],
			evidenceV2: evidenceV2Default,
		},
		adjudication: {
			enabled: false,
			mode: "manual",
			intervalSeconds: 30,
			maxProposalsPerRun: 20,
			maxEvidenceCharacters: 80_000,
			maxHistoryCharacters: 60_000,
			maxHistoryItems: 30,
			approvalMinimumConfidence: 0.8,
		},
	},
	host: "127.0.0.1",
	port: 4141,
	databaseUrl: null,
	autoMigrate: true,
	adminToken: "test-secret",
	notionToken: null,
	intelligenceApiKey: null,
	intelligenceModel: null,
	intelligenceBaseUrl: "https://api.openai.com/v1",
	adjudicationApiKey: null,
	adjudicationModel: null,
	adjudicationBaseUrl: "https://api.openai.com/v1",
	retrievalProvider: "postgres",
	jevApiKey: null,
	embeddingProvider: "disabled",
	openrouterApiKey: null,
	openrouterEmbeddingModel: "openai/text-embedding-3-small",
};

const LOCAL_MEMBER_ID = "00000000-0000-4000-8000-000000000002";

const openApps: Array<Awaited<ReturnType<typeof buildHttpServer>>> = [];

afterEach(async () => {
	await Promise.all(openApps.splice(0).map((app) => app.close()));
});

async function makeSystem(
	runtimeConfig = config,
	githubAppClient?: GithubAppClient,
	proposalClassifier?: {
		classify(input: {
			proposal: { kind: string };
		}): Promise<Record<string, unknown>>;
	},
	suppliedStore?: LedgerStore,
) {
	const store = suppliedStore ?? new MemoryLedgerStore();
	const ledger = new TeamLedger(
		store,
		new ProposalPolicy(runtimeConfig.app.policy),
	);
	const intelligence = new EvidenceIntelligence({
		store,
		ledger,
		interpreter: null,
		companyName: runtimeConfig.app.company.name,
		config: runtimeConfig.app.intelligence,
		log: { info() {}, error() {} },
	});
	const adjudicator = new AutonomousAdjudicator({
		store,
		ledger,
		provider: null,
		companyName: runtimeConfig.app.company.name,
		config: runtimeConfig.app.adjudication,
		completionPolicy: {
			minimumEvidenceItems: 2,
			evidenceProviders: ["agent"],
		},
		log: { info() {}, error() {} },
	});
	const app = await buildHttpServer({
		ledger,
		config: runtimeConfig,
		intelligence,
		adjudicator,
		jobs: new OutboxQueue(store),
		replay: new ReplayVerifier(store),
		...(githubAppClient ? { githubAppClient } : {}),
		...({ proposalClassifier } as object),
	});

	openApps.push(app);
	return { app, ledger, store };
}

async function makeApp() {
	return (await makeSystem()).app;
}

function parseMcp(body: string) {
	const line = body.split("\n").find((item) => item.startsWith("data: "));

	return JSON.parse(line ? line.slice(6) : body);
}

async function callMcp(
	app: Awaited<ReturnType<typeof buildHttpServer>>,
	token: string | null,
	name: string,
	args: Record<string, unknown> = {},
) {
	const response = await app.inject({
		method: "POST",
		url: "/mcp",
		headers: {
			...(token ? { authorization: `Bearer ${token}` } : {}),
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2025-03-26",
		},
		payload: {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name, arguments: args },
		},
	});

	return {
		response,
		message:
			response.statusCode === 200
				? parseMcp(response.body)
				: response.json(),
	};
}

function sourceDocumentPayload(providerEventId = "architecture-v1") {
	return {
		provider: "notion",
		installationKey: "workspace",
		providerEventId,
		eventKind: "source.document.retrieved",
		occurredAt: "2026-09-16T08:00:00.000Z",
		fetchedAt: "2026-09-16T08:00:01.000Z",
		sourceRef: "notion:architecture",
		sourceUrl: "https://notion.example/architecture",
		visibility: "company",
		payloadVersion: "test",
		payload: {
			document: {
				title: "System architecture",
				suggestedPath: "/architecture/system.md",
				markdown:
					"# Architecture\n\nOverview.\n\n## Trust boundary\n\nSources are evidence, not accepted state.\n\n## Retrieval\n\nRead only the required section.",
			},
		},
	};
}

describe("HTTP server", () => {
	it("opens MCP workspace notes through authenticated browser file routes", async () => {
		const { app, ledger } = await makeSystem();
		const agent = await ledger.createAgentProfile({
			memberId: LOCAL_MEMBER_ID,
			name: "Scout UI",
			harness: "codex",
		});
		const saved = await callMcp(app, agent.secret, "agent_file_write", {
			path: "notes/ui.md",
			content: "<script>untrusted note</script>",
			expectedVersion: 0,
		});
		const uri = saved.message.result.structuredContent.file.uri;
		const url = `/api/agents/${agent.profile.id}/files`;

		expect((await app.inject({ method: "GET", url })).statusCode).toBe(401);

		const headers = { authorization: "Bearer test-secret" };
		const listed = await app.inject({ method: "GET", url, headers });

		expect(listed.json().files).toMatchObject([
			{ uri, path: "notes/ui.md", version: 1 },
		]);

		const read = await app.inject({
			method: "GET",
			url: url + "?uri=" + encodeURIComponent(uri),
			headers,
		});

		expect(read.json().file.content).toBe(
			"<script>untrusted note</script>",
		);
		expect(
			(
				await app.inject({
					method: "GET",
					url: url + "?scope=user",
					headers,
				})
			).json().files,
		).toEqual([]);

		const sibling = await ledger.createAgentProfile({
			memberId: LOCAL_MEMBER_ID,
			name: "Sibling UI",
			harness: "codex",
		});
		const denied = await app.inject({
			method: "GET",
			url:
				`/api/agents/${sibling.profile.id}/files?uri=` +
				encodeURIComponent(uri),
			headers,
		});

		expect(denied.statusCode).toBe(403);
	});

	// Failure cases: identity spoofing/secret leakage, cross-user access, sibling-agent
	// private reads, missing grants, stale/concurrent writes, revocation, and plaintext storage.
	it.each([
		"memory",
		...(process.env.PANINI_TEST_DATABASE_URL ? ["postgres"] : []),
	])(
		"exposes identity and isolates agent/user workspaces through MCP (%s)",
		async (backend) => {
			const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;

			if (backend === "postgres") await migrate(databaseUrl!);

			const suppliedStore =
				backend === "postgres"
					? new PostgresLedgerStore(
							databaseUrl!,
							Buffer.alloc(32, 7).toString("base64"),
						)
					: undefined;
			const { app, ledger, store } = await makeSystem(
				config,
				undefined,
				undefined,
				suppliedStore,
			);

			try {
				const member = await ledger.syncMember(
					{
						subject: `workspace-test:${randomUUID()}`,
						displayName: "Workspace Owner",
					},
					"test",
				);
				const other = await ledger.syncMember(
					{
						subject: `workspace-test:${randomUUID()}`,
						displayName: "Other Owner",
					},
					"test",
				);
				const first = await ledger.createAgentProfile({
					memberId: member.id,
					name: "Research",
					harness: "codex",
				});
				const sibling = await ledger.createAgentProfile({
					memberId: member.id,
					name: "Delivery",
					harness: "codex",
				});
				const outsider = await ledger.createAgentProfile({
					memberId: other.id,
					name: "Other",
					harness: "codex",
				});
				const reader = await ledger.createAgentProfile({
					memberId: member.id,
					name: "Read only",
					harness: "codex",
					capabilities: ["workspace:read"],
				});

				const call = async (
					secret: string,
					name: string,
					args: Record<string, unknown> = {},
				) => (await callMcp(app, secret, name, args)).message.result;

				const identity = await call(first.secret, "identity_get");

				expect(identity.structuredContent).toMatchObject({
					user: { id: member.id, displayName: member.displayName },
					agent: { id: first.profile.id, name: "Research" },
					workspaces: {
						agent: `panini://${member.id}/${first.profile.id}/`,
						user: `panini://${member.id}/user/`,
					},
				});
				expect(JSON.stringify(identity)).not.toMatch(
					/tokenHash|tokenHint|tl_agent_/,
				);
				expect(
					await call(null as unknown as string, "identity_get"),
				).toBeUndefined();

				const privateFile = await call(
					first.secret,
					"agent_file_write",
					{
						path: "notes.md",
						content: "private",
						expectedVersion: 0,
					},
				);

				expect(
					(
						await call(sibling.secret, "agent_file_read", {
							uri: privateFile.structuredContent.file.uri,
						})
					).isError,
				).toBe(true);

				const shared = await call(first.secret, "user_file_write", {
					path: "notes.md",
					content: "user shared knowledge",
					expectedVersion: 0,
				});
				const uri = shared.structuredContent.file.uri;

				expect(uri).toBe(`panini://${member.id}/user/notes.md`);
				expect(
					(await call(sibling.secret, "user_file_read", { uri }))
						.structuredContent.file.content,
				).toBe("user shared knowledge");
				expect(
					(await call(outsider.secret, "user_file_read", { uri }))
						.isError,
				).toBe(true);
				expect(
					(await call(outsider.secret, "user_file_list"))
						.structuredContent.files,
				).toEqual([]);
				expect(
					(
						await call(reader.secret, "user_file_write", {
							path: "notes.md",
							content: "denied",
							expectedVersion: 1,
						})
					).isError,
				).toBe(true);
				expect(
					(
						await call(first.secret, "user_file_write", {
							path: "../escape",
							content: "denied",
							expectedVersion: 0,
						})
					).isError,
				).toBe(true);
				expect(
					(
						await call(sibling.secret, "user_file_write", {
							path: "notes.md",
							content: "stale",
							expectedVersion: 0,
						})
					).isError,
				).toBe(true);

				const writes = await Promise.all(
					[first, sibling].map((agent) =>
						call(agent.secret, "user_file_write", {
							path: "notes.md",
							content: "updated",
							expectedVersion: 1,
						}),
					),
				);

				expect(writes.filter((result) => !result.isError)).toHaveLength(
					1,
				);
				expect(
					(await call(sibling.secret, "user_file_list"))
						.structuredContent.files,
				).toMatchObject([{ version: 2 }]);
				await ledger.revokeAgentProfile(first.profile.id);
				expect(
					(await callMcp(app, first.secret, "identity_get")).response
						.statusCode,
				).toBe(401);
				expect(
					(await call(sibling.secret, "user_file_read", { uri }))
						.structuredContent.file.content,
				).toBe("updated");
				if (backend === "postgres") {
					const pool = new pg.Pool({ connectionString: databaseUrl });

					try {
						const rows = await pool.query(
							"SELECT ciphertext FROM agent_workspace_file_revisions WHERE member_id=$1 AND workspace_scope='user'",
							[member.id],
						);

						expect(rows.rows).toHaveLength(2);
						expect(JSON.stringify(rows.rows)).not.toContain(
							"user shared knowledge",
						);
						expect(JSON.stringify(rows.rows)).not.toContain(
							"updated",
						);
					} finally {
						await pool.end();
					}
				}

				const removed = await call(sibling.secret, "user_file_delete", {
					path: "notes.md",
					expectedVersion: 2,
				});

				expect(removed.structuredContent.file.version).toBe(3);
				expect(
					(await call(sibling.secret, "user_file_read", { uri }))
						.structuredContent.file,
				).toBeNull();
				expect(
					(await call(sibling.secret, "user_file_list"))
						.structuredContent.files,
				).toEqual([]);
			} finally {
				await app.close();
				await store.close();
			}
		},
	);

	it("protects API routes when an admin token is configured", async () => {
		const app = await makeApp();
		const response = await app.inject({ method: "GET", url: "/api/board" });

		expect(response.statusCode).toBe(401);
		expect(response.json()).toEqual({
			error: "A valid admin token is required.",
		});
	});

	it("exchanges the local admin token for an HttpOnly session and enforces CSRF on commands", async () => {
		const { app, store } = await makeSystem();
		const denied = await app.inject({
			method: "POST",
			url: "/api/session",
			payload: { token: "wrong" },
		});

		expect(denied.statusCode).toBe(401);

		const login = await app.inject({
			method: "POST",
			url: "/api/session",
			payload: { token: "test-secret" },
		});

		expect(login.statusCode).toBe(200);
		expect(login.json()).toMatchObject({
			authenticated: true,
			mode: "local_admin",
			csrf: expect.any(String),
			identity: {
				memberId: expect.any(String),
				subject: "bootstrap:local-admin",
				role: "owner",
			},
		});
		expect(login.body).not.toContain("test-secret");

		const setCookie = String(login.headers["set-cookie"]);

		expect(setCookie).toContain("HttpOnly");
		expect(setCookie).toContain("SameSite=Lax");

		const cookie = setCookie.split(";")[0]!;

		const board = await app.inject({
			method: "GET",
			url: "/api/board",
			headers: { cookie },
		});

		expect(board.statusCode).toBe(200);

		const rejectedCommand = await app.inject({
			method: "POST",
			url: "/api/tasks",
			headers: { cookie },
			payload: { title: "Missing CSRF" },
		});

		expect(rejectedCommand.statusCode).toBe(403);

		const acceptedCommand = await app.inject({
			method: "POST",
			url: "/api/tasks",
			headers: {
				cookie,
				"x-panini-csrf": login.json().csrf,
				"idempotency-key": "browser-session-command",
			},
			payload: {
				title: "Browser session command",
				actor: "forged:administrator",
			},
		});

		expect(acceptedCommand.statusCode).toBe(201);

		const approval = (await store.listAuditEvents(20)).find(
			(event) => event.action === "proposal.approved",
		);

		expect(approval?.actor).toBe(
			`member:${login.json().identity.memberId}`,
		);
		expect(approval?.actor).not.toBe("forged:administrator");
	});

	it("serves the Panini landing page with a nonce-based content security policy", async () => {
		const app = await makeApp();
		const response = await app.inject({ method: "GET", url: "/" });

		expect(response.statusCode).toBe(200);

		const policy = response.headers["content-security-policy"];

		expect(policy).toContain("script-src 'nonce-");
		expect(policy).not.toContain("unsafe-inline");

		const nonce = response.body.match(/<script nonce="([^"]+)">/)?.[1];

		expect(nonce).toBeTruthy();
		expect(policy).toContain(`nonce-${nonce}`);
		expect(response.body).toContain(
			`href="/assets/phosphor.css" nonce="${nonce}"`,
		);
		expect(response.body).toContain("The grammar");
		expect(response.body).toContain("panini.work");
	});

	it("separates process liveness from workspace readiness and reports the active retrieval fallback", async () => {
		const app = await makeApp();
		const live = await app.inject({ method: "GET", url: "/health/live" });
		const ready = await app.inject({ method: "GET", url: "/health/ready" });

		expect(live.statusCode).toBe(200);
		expect(live.json()).toMatchObject({
			ok: true,
			retrieval: {
				provider: "postgres",
				status: "healthy",
				embeddedOpenViking: "disabled",
			},
			embeddings: {
				provider: "disabled",
				status: "disabled",
				model: null,
			},
		});
		expect(ready.statusCode).toBe(200);
		expect(ready.json()).toMatchObject({
			ready: true,
			organizationId: expect.any(String),
		});
	});

	it("keeps the operational workspace at its own app route", async () => {
		const app = await makeApp();
		const response = await app.inject({ method: "GET", url: "/app" });

		expect(response.statusCode).toBe(200);
		expect(response.body).toContain("Example Company");
		expect(response.body).toContain("Panini");
		expect(response.body).toContain('id="view-work"');
		expect(response.body).not.toContain("sessionStorage");
	});

	it("serves every shareable workspace page directly", async () => {
		const app = await makeApp();

		for (const page of [
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
		]) {
			const response = await app.inject({
				method: "GET",
				url: `/app/${page}`,
			});

			expect(response.statusCode).toBe(200);
			expect(response.body).toContain('class="app-shell"');
		}
	});

	it("creates and returns a task through the authenticated API", async () => {
		const app = await makeApp();
		const headers = {
			authorization: "Bearer test-secret",
			"idempotency-key": "create-test-api-task",
		};
		const created = await app.inject({
			method: "POST",
			url: "/api/tasks",
			headers,
			payload: { title: "Test the API" },
		});

		expect(created.statusCode).toBe(201);
		expect(created.json().task).toMatchObject({
			title: "Test the API",
			version: 1,
			status: "backlog",
		});

		const board = await app.inject({
			method: "GET",
			url: "/api/board",
			headers,
		});

		expect(board.statusCode).toBe(200);
		expect(board.json().tasks).toHaveLength(1);
	});

	it("replays a task command by idempotency key and rejects key reuse with different input", async () => {
		const { app, store } = await makeSystem();
		const request = {
			method: "POST" as const,
			url: "/api/tasks",
			headers: {
				authorization: "Bearer test-secret",
				"idempotency-key": "task-command-42",
			},
			payload: { title: "Idempotent task" },
		};
		const first = await app.inject(request);
		const repeated = await app.inject(request);

		expect(repeated.statusCode).toBe(201);
		expect(repeated.json().task.id).toBe(first.json().task.id);
		expect(await store.listTaskRevisions()).toHaveLength(1);

		const conflicting = await app.inject({
			...request,
			payload: { title: "Different task" },
		});

		expect(conflicting.statusCode).toBe(409);
		expect(conflicting.json().error).toContain("already used");
	});

	it("records raw evidence idempotently without trusting a caller-supplied hash", async () => {
		const app = await makeApp();
		const request = {
			method: "POST" as const,
			url: "/api/evidence/events",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				provider: "github",
				installationKey: "org/repo",
				providerEventId: "push:abc123",
				eventKind: "code.pushed",
				occurredAt: "2026-09-12T09:00:00.000Z",
				sourceRef: "github:org/repo:abc123",
				sourceUrl: "https://github.com/org/repo/commit/abc123",
				payloadVersion: "github-push-v1",
				payload: { sha: "abc123", branch: "main" },
			},
		};
		const created = await app.inject(request);
		const duplicate = await app.inject(request);

		expect(created.statusCode).toBe(201);
		expect(created.json()).toMatchObject({
			inserted: true,
			event: { provider: "github" },
		});
		expect(created.json().event.contentHash).toMatch(/^[a-f0-9]{64}$/);
		expect(duplicate.statusCode).toBe(200);
		expect(duplicate.json()).toMatchObject({
			inserted: false,
			event: { id: created.json().event.id },
		});
	});

	it("serves a lightweight context tree and loads long file bodies by entry ID", async () => {
		const { app } = await makeSystem();
		const headers = {
			authorization: "Bearer test-secret",
			"idempotency-key": "author-policy-fact",
		};
		const created = await app.inject({
			method: "POST",
			url: "/api/context/entries",
			headers,
			payload: {
				kind: "file",
				path: "/company/handbook.md",
				title: "Handbook",
				body: "A deliberately long handbook body.\n",
			},
		});

		expect(created.statusCode).toBe(201);

		const indexResponse = await app.inject({
			method: "GET",
			url: "/api/context",
			headers,
		});

		expect(indexResponse.statusCode).toBe(200);

		const index = indexResponse.json();

		expect(index).toMatchObject({
			counts: { facts: 0, files: 1 },
			files: [{ path: "/company/handbook.md" }],
		});
		expect(index.files[0]).not.toHaveProperty("body");

		const entryResponse = await app.inject({
			method: "GET",
			url: `/api/context/entries/${index.files[0].id}`,
			headers,
		});

		expect(entryResponse.statusCode).toBe(200);
		expect(entryResponse.json().entry).toMatchObject({
			kind: "file",
			body: "A deliberately long handbook body.\n",
		});
	});

	it("authors an atomic fact as an accepted entry with its own evidence receipt", async () => {
		const app = await makeApp();
		const headers = {
			authorization: "Bearer test-secret",
			"idempotency-key": "author-policy-fact",
		};
		const created = await app.inject({
			method: "POST",
			url: "/api/context/entries",
			headers,
			payload: {
				kind: "fact",
				path: "/policies/deployment/review-gate",
				title: "Deployment gate",
				factType: "policy",
				value: "Production deployment requires an approved review.",
			},
		});

		expect(created.statusCode).toBe(201);
		expect(created.json().entry).toMatchObject({
			kind: "fact",
			path: "/policies/deployment/review-gate",
			factType: "policy",
			value: "Production deployment requires an approved review.",
			evidenceIds: [expect.any(String)],
		});

		const index = await app.inject({
			method: "GET",
			url: "/api/context",
			headers,
		});

		expect(index.json()).toMatchObject({
			counts: { facts: 1, files: 0 },
			facts: [{ title: "Deployment gate" }],
		});

		const evidence = await app.inject({
			method: "GET",
			url: "/api/evidence/events",
			headers,
		});

		expect(evidence.json().events[0]).toMatchObject({
			provider: "manual",
			eventKind: "context.fact.authored",
		});
	});

	it("lists receipt metadata without returning source payloads", async () => {
		const app = await makeApp();
		const headers = { authorization: "Bearer test-secret" };

		await app.inject({
			method: "POST",
			url: "/api/evidence/events",
			headers,
			payload: {
				provider: "agent",
				installationKey: "test",
				providerEventId: "private-receipt",
				eventKind: "work.verified",
				occurredAt: "2026-09-15T08:00:00.000Z",
				sourceRef: "agent:test",
				sourceUrl: null,
				payloadVersion: "test",
				payload: { private: "not returned" },
			},
		});

		const response = await app.inject({
			method: "GET",
			url: "/api/evidence/events",
			headers,
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().events[0]).toMatchObject({
			provider: "agent",
			eventKind: "work.verified",
		});
		expect(response.json().events[0]).not.toHaveProperty("payload");
	});

	it("loads one authorized evidence payload on demand and hides revoked content", async () => {
		const app = await makeApp();
		const headers = { authorization: "Bearer test-secret" };
		const created = await app.inject({
			method: "POST",
			url: "/api/evidence/events",
			headers,
			payload: {
				provider: "agent",
				installationKey: "test",
				providerEventId: "inspectable-receipt",
				eventKind: "work.verified",
				occurredAt: "2026-09-15T08:00:00.000Z",
				sourceRef: "agent:inspectable",
				sourceUrl: null,
				payloadVersion: "test",
				payload: {
					summary: "Verified the deployment checklist.",
					checks: ["integration", "rollback"],
				},
			},
		});
		const eventId = created.json().event.id as string;

		const detail = await app.inject({
			method: "GET",
			url: `/api/evidence/events/${eventId}`,
			headers,
		});

		expect(detail.statusCode).toBe(200);
		expect(detail.json().event).toMatchObject({
			id: eventId,
			provider: "agent",
			payload: {
				summary: "Verified the deployment checklist.",
				checks: ["integration", "rollback"],
			},
		});

		expect(
			(
				await app.inject({
					method: "DELETE",
					url: `/api/evidence/events/${eventId}`,
					headers,
				})
			).statusCode,
		).toBe(200);
		expect(
			(
				await app.inject({
					method: "GET",
					url: `/api/evidence/events/${eventId}`,
					headers,
				})
			).statusCode,
		).toBe(404);
	});

	it("serves the original context artwork from the same protected app origin", async () => {
		const app = await makeApp();
		const response = await app.inject({
			method: "GET",
			url: "/assets/context-observatory.png",
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("image/png");
		expect(response.rawPayload.byteLength).toBeGreaterThan(10_000);
	});

	it("serves optimized Panini landing artwork from the same origin", async () => {
		const app = await makeApp();

		for (const name of [
			"grammar-machine.webp",
			"work-sorter.webp",
			"shared-structure.webp",
		]) {
			const response = await app.inject({
				method: "GET",
				url: `/assets/landing/${name}`,
			});

			expect(response.statusCode).toBe(200);
			expect(response.headers["content-type"]).toContain("image/webp");
			expect(response.headers["cache-control"]).toContain("immutable");
			expect(response.rawPayload.byteLength).toBeGreaterThan(100_000);
		}
	});

	it("serves the local Phosphor icon stylesheet and font from the app origin", async () => {
		const app = await makeApp();
		const [stylesheet, font] = await Promise.all([
			app.inject({ method: "GET", url: "/assets/phosphor.css" }),
			app.inject({ method: "GET", url: "/assets/Phosphor.woff2" }),
		]);

		expect(stylesheet.statusCode).toBe(200);
		expect(stylesheet.headers["content-type"]).toContain("text/css");
		expect(stylesheet.body).toContain("@font-face");
		expect(stylesheet.body).toContain('url("./Phosphor.woff2")');
		expect(font.statusCode).toBe(200);
		expect(font.headers["content-type"]).toContain("font/woff2");
		expect(font.rawPayload.byteLength).toBeGreaterThan(10_000);
	});

	it("serves the Panini brand mark from the same origin", async () => {
		const app = await makeApp();
		const response = await app.inject({
			method: "GET",
			url: "/assets/panini-mark.svg",
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("image/svg+xml");
		expect(response.body).toContain("#143fc4");
		expect(response.body).toContain("#e13e24");
		expect(response.body).toContain("प</text>");
	});

	it("serves the reviewed Pi adapter without embedding a credential", async () => {
		const app = await makeApp();
		const response = await app.inject({
			method: "GET",
			url: "/integrations/pi/panini.ts",
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/plain");
		expect(response.body).toContain("pi.registerTool");
		expect(response.body).toContain("PANINI_AGENT_TOKEN");
		expect(response.body).not.toContain("tl_agent_");

		const legacyAlias = await app.inject({
			method: "GET",
			url: "/integrations/pi/team-ledger.ts",
		});

		expect(legacyAlias.statusCode).toBe(200);
		expect(legacyAlias.body).toBe(response.body);
	});

	it("creates multiple member-owned agents and uses their one-time secrets for MCP", async () => {
		const app = await makeApp();
		const admin = { authorization: "Bearer test-secret" };
		const first = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Research",
				harness: "codex",
				capabilities: ["work:read"],
			},
		});
		const second = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Delivery",
				harness: "claude_code",
			},
		});

		expect(first.statusCode).toBe(201);
		expect(second.statusCode).toBe(201);
		expect(first.json().secret).toMatch(/^tl_agent_/);
		expect(first.json().profile).not.toHaveProperty("tokenHash");

		const codexSetup = first
			.json()
			.setup.steps.map((step: { code: string }) => step.code)
			.join("\n");

		expect(codexSetup).toContain("codex mcp add");
		expect(codexSetup).toContain(
			'http_headers = { Authorization = "Bearer ' +
				first.json().secret +
				'" }',
		);

		const unauthorized = await callMcp(app, null, "work_search");

		expect(unauthorized.response.statusCode).toBe(401);

		const authorized = await callMcp(
			app,
			first.json().secret,
			"work_search",
			{ query: "" },
		);

		expect(authorized.response.statusCode).toBe(200);
		expect(authorized.message.result.isError).not.toBe(true);

		const agents = await app.inject({
			method: "GET",
			url: `/api/agents?memberId=${LOCAL_MEMBER_ID}`,
			headers: admin,
		});

		expect(agents.json().agents).toHaveLength(2);
		expect(
			agents
				.json()
				.agents.find(
					(profile: { id: string }) =>
						profile.id === first.json().profile.id,
				).lastUsedAt,
		).toBeTruthy();
	});

	// Failure cases: an empty grant sees no tasks; a named grant misses unassigned
	// and future projects; an explicit all-project grant must include both.
	it("keeps all accepted work visible to an explicitly all-project agent", async () => {
		const { app, ledger } = await makeSystem();
		const alpha = await ledger.createTask(
			{ title: "Alpha release", project: "Alpha" },
			"member:admin",
		);
		const unassigned = await ledger.createTask(
			{ title: "Unassigned incident" },
			"member:admin",
		);
		const limited = await ledger.createAgentProfile({
			memberId: LOCAL_MEMBER_ID,
			name: "Limited coverage",
			harness: "codex",
			dataScope: {
				projects: ["Alpha"],
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			},
		});
		const all = await ledger.createAgentProfile({
			memberId: LOCAL_MEMBER_ID,
			name: "Full coverage",
			harness: "codex",
			dataScope: {
				projects: ["*"],
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			},
		});
		const beta = await ledger.createTask(
			{ title: "Future Beta work", project: "Beta" },
			"member:admin",
		);
		const limitedSearch = await callMcp(app, limited.secret, "work_search");

		expect(
			limitedSearch.message.result.structuredContent.tasks.map(
				(task: { id: string }) => task.id,
			),
		).toEqual([alpha.id]);

		const allSearch = await callMcp(app, all.secret, "work_search");

		expect(
			allSearch.message.result.structuredContent.tasks
				.map((task: { id: string }) => task.id)
				.sort(),
		).toEqual([alpha.id, unassigned.id, beta.id].sort());
	});

	// Failure cases: scope edits must not require rotating the one-time secret,
	// and revocation must not permit an old profile to regain access.
	it("updates an existing agent grant and applies it on its next MCP request", async () => {
		const { app, ledger } = await makeSystem();
		const task = await ledger.createTask(
			{ title: "Newly visible task", project: "New project" },
			"member:admin",
		);
		const agent = await ledger.createAgentProfile({
			memberId: LOCAL_MEMBER_ID,
			name: "Grant edit",
			harness: "codex",
		});
		const before = await callMcp(app, agent.secret, "work_search");

		expect(before.message.result.structuredContent.tasks).toEqual([]);

		const edited = await app.inject({
			method: "PATCH",
			url: `/api/agents/${agent.profile.id}/scope`,
			headers: { authorization: "Bearer test-secret" },
			payload: {
				projects: ["*"],
				contextPaths: ["/"],
				sourceVisibilities: ["company"],
			},
		});

		expect(edited.statusCode).toBe(200);
		expect(edited.json().profile.dataScope.projects).toEqual(["*"]);

		const after = await callMcp(app, agent.secret, "work_search");

		expect(after.message.result.structuredContent.tasks).toEqual([
			expect.objectContaining({ id: task.id }),
		]);
		expect(
			(await ledger.listAuditEvents()).some(
				(event) =>
					event.action === "agent_profile.scope_updated" &&
					event.targetId === agent.profile.id,
			),
		).toBe(true);
	});

	// Failure case: a connector may still say healthy long after its last poll.
	it("marks old polling checkpoints stale in the company coverage view", async () => {
		const { app, ledger } = await makeSystem();
		const installation = await ledger.configureInstallation(
			{
				provider: "github",
				installationKey: "test",
				displayName: "GitHub",
				transport: "poll",
				config: {},
			},
			"member:admin",
		);

		await ledger.updateInstallation(
			installation.id,
			{
				status: "healthy",
				lastSuccessAt: "2020-01-01T00:00:00.000Z",
				lastSyncAt: "2020-01-01T00:00:00.000Z",
			},
			"test",
		);

		const response = await app.inject({
			method: "GET",
			url: "/api/company",
			headers: { authorization: "Bearer test-secret" },
		});

		expect(response.statusCode).toBe(200);
		expect(response.json().sourceCoverage[0].stale).toBe(true);
		expect(response.json().memoryHealth.coverageIncomplete).toBe(true);
		await ledger.updateInstallation(
			installation.id,
			{
				lastSuccessAt: new Date().toISOString(),
				lastSyncAt: new Date().toISOString(),
			},
			"test",
		);
		await ledger.updateConnectorSyncState(
			installation.id,
			"github:repository:42",
			{
				status: "healthy",
				lastSuccessAt: "2020-01-01T00:00:00.000Z",
			},
		);

		const oldScope = await app.inject({
			method: "GET",
			url: "/api/company",
			headers: { authorization: "Bearer test-secret" },
		});

		expect(oldScope.json().sourceCoverage[0].scopes[0].stale).toBe(true);
		expect(oldScope.json().memoryHealth.coverageIncomplete).toBe(true);
	});

	it("keeps retired Notion checkpoints out of active coverage without deleting their history", async () => {
		const { app, ledger } = await makeSystem();
		const old = await ledger.configureInstallation(
			{
				provider: "notion",
				installationKey: "checkpoint-old",
				displayName: "Checkpoint integration",
				transport: "poll",
				config: {},
			},
			"member:admin",
		);

		await ledger.updateConnectorSyncState(old.id, "old-board", {
			status: "degraded",
			lastSuccessAt: "2020-01-01T00:00:00.000Z",
			lastError: "Old checkpoint",
		});

		const current = await ledger.configureInstallation(
			{
				provider: "notion",
				installationKey: "default",
				displayName: "Notion",
				transport: "poll",
				config: {},
			},
			"member:admin",
		);

		await ledger.updateInstallation(
			current.id,
			{
				status: "healthy",
				lastSuccessAt: new Date().toISOString(),
			},
			"test",
		);

		const response = await app.inject({
			method: "PATCH",
			url: `/api/installations/${old.id}`,
			headers: { authorization: "Bearer test-secret" },
			payload: { status: "disabled" },
		});

		expect(response.statusCode).toBe(200);

		const company = await app.inject({
			method: "GET",
			url: "/api/company",
			headers: { authorization: "Bearer test-secret" },
		});

		expect(
			company
				.json()
				.sourceCoverage.map((item: { id: string }) => item.id),
		).toEqual([current.id]);
		expect(company.json().memoryHealth.coverageIncomplete).toBe(false);
		expect(
			(await ledger.workspace()).installations.map((item) => item.id),
		).toContain(old.id);
		expect(
			(await ledger.listAuditEvents()).some(
				(event) =>
					event.action === "installation.disabled" &&
					event.targetId === old.id,
			),
		).toBe(true);
	});

	it("returns an objective-specific cited context pack through MCP context_get", async () => {
		const { app, ledger } = await makeSystem();
		const wanted = await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/policies/source-encryption",
				title: "Source payload encryption",
				factType: "policy",
				value: "Encrypt retained connector payloads at rest.",
			},
			"user:admin",
		);

		await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/preferences/brand-tone",
				title: "Brand tone",
				factType: "preference",
				value: "Use calm, direct language.",
			},
			"user:admin",
		);

		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Context reader",
				harness: "codex",
				capabilities: ["work:read", "context:read"],
			},
		});

		const response = await callMcp(
			app,
			created.json().secret,
			"context_get",
			{
				objective: "Find the source encryption policy",
				query: "connector payload encryption",
				maxItems: 1,
				characterBudget: 8_000,
			},
		);

		expect(response.response.statusCode).toBe(200);
		expect(response.message.result.isError).not.toBe(true);
		expect(response.message.result.structuredContent.pack).toMatchObject({
			objective: "Find the source encryption policy",
			provider: "postgres",
			entries: [{ id: wanted.id, path: wanted.path }],
			citations: [
				{ entryId: wanted.id, contentHash: expect.any(String) },
			],
			manifest: { returnedCount: 1, characterBudget: 8_000 },
		});
	});

	it("lists and reads source documents through the protected admin API", async () => {
		const app = await makeApp();
		const admin = { authorization: "Bearer test-secret" };
		const recorded = await app.inject({
			method: "POST",
			url: "/api/evidence/events",
			headers: admin,
			payload: sourceDocumentPayload(),
		});

		expect(recorded.statusCode).toBe(201);

		const sourceEventId = recorded.json().event.id;

		const listed = await app.inject({
			method: "GET",
			url: "/api/source-documents?q=trust",
			headers: admin,
		});

		expect(listed.statusCode).toBe(200);
		expect(listed.json().documents).toEqual([
			expect.objectContaining({
				sourceEventId,
				matchedSectionIds: expect.arrayContaining([
					"architecture-trust-boundary",
				]),
			}),
		]);

		const read = await app.inject({
			method: "GET",
			url: `/api/source-documents/${sourceEventId}?sectionId=architecture-trust-boundary`,
			headers: admin,
		});

		expect(read.statusCode).toBe(200);
		expect(read.json()).toMatchObject({
			document: { sourceEventId, title: "System architecture" },
			section: { id: "architecture-trust-boundary" },
			truncated: false,
		});
		expect(read.json().markdown).toContain("Sources are evidence");
		expect(read.json().markdown).not.toContain(
			"Read only the required section",
		);
	});

	it("adds source pointers to capable context packs and gates source reads separately", async () => {
		const app = await makeApp();
		const admin = { authorization: "Bearer test-secret" };
		const recorded = await app.inject({
			method: "POST",
			url: "/api/evidence/events",
			headers: admin,
			payload: sourceDocumentPayload("architecture-mcp-v1"),
		});
		const sourceEventId = recorded.json().event.id;
		const capable = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Source reader",
				harness: "codex",
				capabilities: ["work:read", "context:read", "source:read"],
			},
		});
		const acceptedOnly = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Accepted reader",
				harness: "codex",
				capabilities: ["work:read", "context:read"],
			},
		});

		const pack = await callMcp(app, capable.json().secret, "context_get", {
			objective: "Understand the architecture trust boundary",
			query: "architecture trust boundary",
		});

		expect(pack.message.result.structuredContent.pack.sources).toEqual([
			expect.objectContaining({
				sourceEventId,
				matchedSectionIds: expect.arrayContaining([
					"architecture-trust-boundary",
				]),
			}),
		]);

		const denied = await callMcp(
			app,
			acceptedOnly.json().secret,
			"source_read",
			{ sourceEventId },
		);

		expect(denied.message.result.isError).toBe(true);
		expect(denied.message.result.content[0].text).toContain("source:read");

		const read = await callMcp(app, capable.json().secret, "source_read", {
			sourceEventId,
			sectionId: "architecture-trust-boundary",
		});

		expect(read.message.result.isError).not.toBe(true);
		expect(read.message.result.content[0].text).toContain(
			"Source evidence only",
		);
		expect(read.message.result.structuredContent.source.section.id).toBe(
			"architecture-trust-boundary",
		);

		const acceptedPack = await callMcp(
			app,
			acceptedOnly.json().secret,
			"context_get",
			{ objective: "Understand architecture" },
		);

		expect(
			acceptedPack.message.result.structuredContent.pack.sources,
		).toEqual([]);
	});

	it("intersects agent source visibility grants with context search and direct reads", async () => {
		const { app, ledger, store } = await makeSystem();
		const receipt = await store.appendSourceEvent({
			provider: "slack",
			installationKey: "workspace",
			providerEventId: "private-launch-decision",
			eventKind: "message.explicitly_captured",
			occurredAt: "2026-09-16T08:00:00.000Z",
			fetchedAt: "2026-09-16T08:00:01.000Z",
			sourceRef: "slack:T1:C-PRIVATE:1",
			sourceUrl: "https://slack.example/private-launch",
			contentHash: "private-launch-hash",
			visibility: "slack:channel:C-PRIVATE",
			payloadVersion: "test",
			payload: {
				text: "Project Juniper launches after the private review.",
			},
		});
		const proposal = await ledger.proposeContextFact({
			sourceRef: receipt.event.sourceRef,
			path: "/decisions/project-juniper-launch",
			title: "Project Juniper launch gate",
			factType: "decision",
			value: "Launch after the private review.",
			sourceUrl: receipt.event.sourceUrl,
			rationale: "The selected channel recorded the decision.",
			requestedBy: "test:visibility",
			evidenceIds: [receipt.event.id],
		});
		const entry = await ledger.approveProposal(
			proposal.id,
			"member:test",
			"Accepted for the private project.",
		);
		const admin = { authorization: "Bearer test-secret" };
		const companyOnly = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Company-only reader",
				harness: "codex",
				capabilities: ["work:read", "context:read"],
				dataScope: {
					projects: [],
					contextPaths: ["/"],
					sourceVisibilities: ["company"],
				},
			},
		});
		const channelReader = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Private channel reader",
				harness: "codex",
				capabilities: ["work:read", "context:read"],
				dataScope: {
					projects: [],
					contextPaths: ["/decisions"],
					sourceVisibilities: ["company", "slack:channel:C-PRIVATE"],
				},
			},
		});

		const deniedSearch = await callMcp(
			app,
			companyOnly.json().secret,
			"context_search",
			{
				objective: "Find the Juniper launch decision",
				query: "Juniper launch",
			},
		);

		expect(
			deniedSearch.message.result.structuredContent.result.entries,
		).toEqual([]);

		const deniedRead = await callMcp(
			app,
			companyOnly.json().secret,
			"context_read",
			{ entryId: entry.id },
		);

		expect(deniedRead.message.result.isError).toBe(true);

		const allowedSearch = await callMcp(
			app,
			channelReader.json().secret,
			"context_search",
			{
				objective: "Find the Juniper launch decision",
				query: "Juniper launch",
			},
		);

		expect(
			allowedSearch.message.result.structuredContent.result.entries,
		).toEqual([expect.objectContaining({ id: entry.id })]);

		const allowedRead = await callMcp(
			app,
			channelReader.json().secret,
			"context_read",
			{ entryId: entry.id },
		);

		expect(allowedRead.message.result.isError).not.toBe(true);
	});

	it("projects company, people, temporal history, and authorized MCP revision lineage", async () => {
		const { app, ledger } = await makeSystem();
		const task = await ledger.createTask(
			{
				title: "Unblock Alpha deployment",
				project: "Alpha",
				owner: "Local administrator",
				status: "blocked",
			},
			"member:admin",
		);
		const entry = await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/projects/alpha/release-gate",
				title: "Alpha release gate",
				factType: "policy",
				value: "An approved rollback plan is required.",
				links: [
					{ type: "project", targetId: null, targetRef: "Alpha" },
					{
						type: "member",
						targetId: LOCAL_MEMBER_ID,
						targetRef: "Local administrator",
					},
				],
			},
			"member:admin",
		);
		const admin = { authorization: "Bearer test-secret" };

		const company = await app.inject({
			method: "GET",
			url: "/api/company",
			headers: admin,
		});

		expect(company.statusCode).toBe(200);
		expect(company.json()).toMatchObject({
			blockers: [expect.objectContaining({ id: task.id })],
			memoryHealth: { total: 1, currentAccepted: 1, needsReview: 0 },
		});

		const people = await app.inject({
			method: "GET",
			url: "/api/people",
			headers: admin,
		});

		expect(people.statusCode).toBe(200);
		expect(people.json().people).toContainEqual(
			expect.objectContaining({
				member: expect.objectContaining({ id: LOCAL_MEMBER_ID }),
				currentWork: [expect.objectContaining({ id: task.id })],
				contextEntryIds: [entry.id],
			}),
		);

		const revised = await app.inject({
			method: "POST",
			url: `/api/context/entries/${entry.id}/lifecycle`,
			headers: {
				...admin,
				"idempotency-key": "quarantine-alpha-release-gate-http",
			},
			payload: {
				lifecycleState: "needs_review",
				reason: "The rollback requirement must be reverified before agent recall.",
			},
		});

		expect(revised.statusCode).toBe(200);
		expect(revised.json().entry).toMatchObject({
			id: entry.id,
			lifecycleState: "needs_review",
		});

		const history = await app.inject({
			method: "GET",
			url: "/api/history?limit=100",
			headers: admin,
		});

		expect(history.statusCode).toBe(200);
		expect(history.json().items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "task_revision",
					subjectId: task.id,
				}),
				expect.objectContaining({
					type: "context_revision",
					subjectId: entry.id,
					state: "needs_review",
				}),
				expect.objectContaining({ type: "source_observation" }),
				expect.objectContaining({ type: "audit_event" }),
			]),
		);

		const companyChanges = await app.inject({
			method: "GET",
			url: "/api/history?view=changes&limit=100",
			headers: admin,
		});

		expect(companyChanges.statusCode).toBe(200);
		expect(
			companyChanges
				.json()
				.items.every((item: { type: string }) =>
					["task_revision", "context_revision"].includes(item.type),
				),
		).toBe(true);
		expect(companyChanges.json().items).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "context_revision",
					subjectId: entry.id,
					changes: expect.arrayContaining([
						expect.objectContaining({
							label: "Review state",
							before: "accepted",
							after: "needs_review",
						}),
					]),
				}),
			]),
		);

		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Alpha historian",
				harness: "codex",
				capabilities: ["work:read", "context:read"],
				dataScope: {
					projects: ["Alpha"],
					contextPaths: ["/projects/alpha"],
					sourceVisibilities: ["company"],
				},
			},
		});
		const contextHistory = await callMcp(
			app,
			created.json().secret,
			"history_get",
			{ subject: "context", id: entry.id },
		);

		expect(contextHistory.message.result.isError).not.toBe(true);
		expect(
			contextHistory.message.result.structuredContent.history,
		).toMatchObject({
			entry: { id: entry.id, lifecycleState: "needs_review" },
			revisions: [
				expect.objectContaining({ version: 1 }),
				expect.objectContaining({
					version: 2,
					current: expect.objectContaining({
						lifecycleState: "needs_review",
					}),
				}),
			],
		});

		const taskHistory = await callMcp(
			app,
			created.json().secret,
			"history_get",
			{ subject: "task", id: task.id },
		);

		expect(taskHistory.message.result.isError).not.toBe(true);
		expect(
			taskHistory.message.result.structuredContent.history,
		).toMatchObject({
			task: { id: task.id },
			revisions: [expect.objectContaining({ version: 1 })],
		});
	});

	it("intersects agent scope with an explicit repository mapping for context recall", async () => {
		const { app, ledger } = await makeSystem();
		const alphaTask = await ledger.createTask(
			{ title: "Alpha release", project: "Alpha" },
			"member:admin",
		);
		const betaTask = await ledger.createTask(
			{ title: "Beta release", project: "Beta" },
			"member:admin",
		);
		const alpha = await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/projects/alpha/release-gate",
				title: "Release gate",
				factType: "policy",
				value: "Alpha uses the rollback gate.",
				links: [
					{ type: "project", targetId: null, targetRef: "Alpha" },
				],
			},
			"member:admin",
		);
		const beta = await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/projects/beta/release-gate",
				title: "Release gate",
				factType: "policy",
				value: "Beta uses the security gate.",
				links: [{ type: "project", targetId: null, targetRef: "Beta" }],
			},
			"member:admin",
		);

		await ledger.configureRepositoryMapping(
			{
				repository: "acme/alpha",
				project: "Alpha",
				contextPaths: ["/projects/alpha"],
			},
			"member:admin",
		);
		await ledger.configureRepositoryMapping(
			{
				repository: "acme/beta",
				project: "Beta",
				contextPaths: ["/projects/beta"],
			},
			"member:admin",
		);

		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Multi-project reader",
				harness: "codex",
				capabilities: ["work:read", "context:read"],
				dataScope: {
					projects: ["Alpha", "Beta"],
					contextPaths: ["/projects"],
					sourceVisibilities: ["company"],
				},
			},
		});

		const alphaPack = await callMcp(
			app,
			created.json().secret,
			"context_get",
			{
				repository: "ACME/ALPHA",
				objective: "Find the release gate",
				query: "release gate",
			},
		);

		expect(alphaPack.message.result.isError).not.toBe(true);
		expect(alphaPack.message.result.structuredContent.pack.entries).toEqual(
			[expect.objectContaining({ id: alpha.id })],
		);
		expect(alphaPack.message.result.structuredContent.pack.tasks).toEqual([
			expect.objectContaining({ id: alphaTask.id }),
		]);

		const betaSearch = await callMcp(
			app,
			created.json().secret,
			"context_search",
			{
				repository: "acme/beta",
				objective: "Find the release gate",
				query: "release gate",
			},
		);

		expect(betaSearch.message.result.isError).not.toBe(true);
		expect(
			betaSearch.message.result.structuredContent.result.entries,
		).toEqual([expect.objectContaining({ id: beta.id })]);
		expect(
			betaSearch.message.result.structuredContent.result.tasks,
		).toEqual([expect.objectContaining({ id: betaTask.id })]);

		const unmapped = await callMcp(
			app,
			created.json().secret,
			"context_get",
			{
				repository: "acme/unmapped",
				objective: "Find the release gate",
				query: "release gate",
			},
		);

		expect(unmapped.message.result.isError).toBe(true);
		expect(unmapped.message.result.content[0].text).toContain("not mapped");
	});

	it("creates a Hermes profile with a secret-free YAML connection recipe", async () => {
		const app = await makeApp();
		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Hermes operator",
				harness: "hermes",
				capabilities: ["work:read", "context:read"],
			},
		});

		expect(created.statusCode).toBe(201);

		const body = created.json();
		const instructions = body.setup.steps
			.map((step: { code: string }) => step.code)
			.join("\n");

		expect(body.profile).toMatchObject({ harness: "hermes" });
		expect(body.setup).toMatchObject({ harnessLabel: "Hermes Agent" });
		expect(instructions).toContain("mcp_servers:");
		expect(instructions).toContain("hermes mcp test");
		expect(instructions).toContain("Bearer ${PANINI_AGENT_");
		expect(instructions).not.toContain(body.secret);
	});

	it("enforces capability grants inside MCP tools", async () => {
		const app = await makeApp();
		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Read only",
				harness: "generic_mcp",
				capabilities: ["work:read"],
			},
		});
		const denied = await callMcp(
			app,
			created.json().secret,
			"task_create_proposal",
			{
				clientEventId: "read-only-task-proposal",
				title: "Should not be proposed",
				rationale: "The profile is read only.",
			},
		);

		expect(denied.response.statusCode).toBe(200);
		expect(denied.message.result.isError).toBe(true);
		expect(denied.message.result.content[0].text).toContain("work:propose");
	});

	it("enforces project, context-path, and evidence scopes across every MCP work boundary", async () => {
		const { app, ledger, store } = await makeSystem();
		const alpha = await ledger.createTask(
			{ title: "Alpha delivery", project: "Alpha" },
			"member:admin",
		);
		const beta = await ledger.createTask(
			{ title: "Beta delivery", project: "Beta" },
			"member:admin",
		);
		const betaProposal = await ledger.propose({
			taskId: beta.id,
			baseRevision: beta.version,
			changes: { status: "in_progress" },
			rationale: "Start the Beta delivery.",
			requestedBy: "member:admin",
		});
		const evidence = await store.appendSourceEvent({
			provider: "manual",
			installationKey: "admin",
			providerEventId: "alpha-decision-evidence",
			eventKind: "context.fact.authored",
			occurredAt: "2026-09-17T08:00:00.000Z",
			fetchedAt: "2026-09-17T08:00:00.000Z",
			sourceRef: "manual:alpha-decision",
			sourceUrl: null,
			contentHash: "alpha-decision-hash",
			visibility: "company",
			payloadVersion: "test",
			payload: { text: "Alpha uses the approved release gate." },
		});
		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Alpha operator",
				harness: "codex",
				capabilities: [
					"work:read",
					"work:propose",
					"context:read",
					"context:propose",
					"evidence:report",
				],
				dataScope: {
					projects: ["Alpha"],
					contextPaths: ["/projects/alpha"],
					sourceVisibilities: ["company"],
				},
			},
		});
		const secret = created.json().secret;

		const search = await callMcp(app, secret, "work_search", {
			query: "delivery",
		});

		expect(search.message.result.structuredContent.tasks).toEqual([
			expect.objectContaining({ id: alpha.id, project: "Alpha" }),
		]);

		const deniedChange = await callMcp(app, secret, "proposal_create", {
			clientEventId: "alpha-agent-beta-change",
			taskId: beta.id,
			baseRevision: beta.version,
			changes: { status: "review" },
			rationale: "Attempt a cross-project update.",
		});

		expect(deniedChange.message.result.isError).toBe(true);

		const deniedMove = await callMcp(app, secret, "proposal_create", {
			clientEventId: "alpha-agent-cross-project-move",
			taskId: alpha.id,
			baseRevision: alpha.version,
			changes: { project: "Beta" },
			rationale: "Attempt to move work outside the grant.",
		});

		expect(deniedMove.message.result.isError).toBe(true);

		const deniedCreate = await callMcp(
			app,
			secret,
			"task_create_proposal",
			{
				clientEventId: "alpha-agent-beta-create",
				title: "Hidden Beta task",
				project: "Beta",
				rationale: "Attempt a cross-project creation.",
			},
		);

		expect(deniedCreate.message.result.isError).toBe(true);

		const deniedContext = await callMcp(
			app,
			secret,
			"context_proposal_create",
			{
				kind: "fact",
				clientEventId: "alpha-agent-beta-context",
				path: "/projects/beta/release-gate",
				title: "Beta release gate",
				factType: "policy",
				value: "Use the hidden gate.",
				rationale: "Attempt a cross-path proposal.",
				evidenceIds: [evidence.event.id],
			},
		);

		expect(deniedContext.message.result.isError).toBe(true);

		const deniedStatus = await callMcp(app, secret, "proposal_status", {
			proposalId: betaProposal.id,
		});

		expect(deniedStatus.message.result.isError).toBe(true);

		const deniedReport = await callMcp(app, secret, "work_report", {
			reportId: "alpha-agent-beta-report",
			workItemId: beta.id,
			phase: "verified",
			outcome: "Attempted a report outside the project grant.",
			occurredAt: "2026-09-17T09:00:00.000Z",
		});

		expect(deniedReport.message.result.isError).toBe(true);

		const allowedCreate = await callMcp(
			app,
			secret,
			"task_create_proposal",
			{
				clientEventId: "alpha-agent-alpha-create",
				title: "Alpha follow-up",
				project: "Alpha",
				rationale: "Create follow-up work within the grant.",
			},
		);

		expect(allowedCreate.message.result.isError).not.toBe(true);

		const allowedContext = await callMcp(
			app,
			secret,
			"context_proposal_create",
			{
				kind: "fact",
				clientEventId: "alpha-agent-alpha-context",
				path: "/projects/alpha/release-gate",
				title: "Alpha release gate",
				factType: "policy",
				value: "Use the approved gate.",
				rationale: "Record the project policy within the grant.",
				evidenceIds: [evidence.event.id],
			},
		);

		expect(allowedContext.message.result.isError).not.toBe(true);

		const allowedReport = await callMcp(app, secret, "work_report", {
			reportId: "alpha-agent-alpha-report",
			workItemId: alpha.id,
			phase: "verified",
			outcome: "Alpha verification completed.",
			occurredAt: "2026-09-17T09:00:00.000Z",
		});

		expect(allowedReport.message.result.isError).not.toBe(true);
	});

	it("classifies agent task and context proposals before leaving them pending", async () => {
		const classifier = {
			classify: vi.fn(async (input: { proposal: { kind: string } }) =>
				input.proposal.kind === "context_fact_upsert"
					? {
							decision: "invalid",
							confidence: 0.94,
							fitProbability: 0.06,
							model: "jev:test",
							reason: "The claim is misplaced or unsupported.",
						}
					: {
							decision: "fits",
							confidence: 0.91,
							fitProbability: 0.91,
							model: "jev:test",
							reason: "The task fits the accepted work structure.",
						},
			),
		};
		const { app, ledger, store } = await makeSystem(
			config,
			undefined,
			classifier,
		);

		await ledger.createTask(
			{ title: "Ship Alpha", project: "Alpha" },
			"user:admin",
		);
		await ledger.createContextEntry(
			{
				kind: "fact",
				path: "/projects/alpha/goal",
				title: "Alpha goal",
				factType: "reference",
				value: "Ship Alpha safely.",
			},
			"user:admin",
		);

		const evidence = (
			await store.appendSourceEvent({
				...sourceDocumentPayload("proposal-fit"),
				contentHash:
					"0000000000000000000000000000000000000000000000000000000000000000",
			})
		).event;
		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Proposal classifier",
				harness: "codex",
				capabilities: [
					"work:read",
					"work:propose",
					"context:read",
					"context:propose",
					"source:read",
				],
				dataScope: {
					projects: ["Alpha"],
					contextPaths: ["/projects/alpha"],
					sourceVisibilities: ["company"],
				},
			},
		});
		const secret = created.json().secret;

		const task = await callMcp(app, secret, "task_create_proposal", {
			clientEventId: "fit-task",
			title: "Verify Alpha release",
			project: "Alpha",
			rationale: "A concrete follow-up to the accepted Alpha goal.",
			evidenceIds: [evidence.id],
		});

		expect(task.message.result.structuredContent).toMatchObject({
			classification: { decision: "fits", model: "jev:test" },
			proposal: { state: "pending" },
		});

		const context = await callMcp(app, secret, "context_proposal_create", {
			kind: "fact",
			clientEventId: "invalid-context",
			path: "/projects/alpha/random",
			title: "Unrelated claim",
			factType: "other",
			value: "This does not belong here.",
			rationale: "Try to add unrelated context.",
			evidenceIds: [evidence.id],
		});

		expect(context.message.result.structuredContent).toMatchObject({
			classification: { decision: "invalid", model: "jev:test" },
			proposal: { state: "rejected", decidedBy: "classifier:jev:test" },
		});
		expect(classifier.classify).toHaveBeenCalledTimes(2);
		expect(classifier.classify.mock.calls[0]![0]).toMatchObject({
			tasks: [expect.objectContaining({ title: "Ship Alpha" })],
			context: {
				facts: [
					expect.objectContaining({ path: "/projects/alpha/goal" }),
				],
			},
			evidence: [expect.objectContaining({ id: evidence.id })],
		});
	});

	it("leaves a proposal pending when the Jev classifier is unavailable", async () => {
		const classifier = {
			classify: vi.fn(async () => {
				throw new Error("Jev unavailable");
			}),
		};
		const { app, store } = await makeSystem(config, undefined, classifier);
		const created = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: { authorization: "Bearer test-secret" },
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Fail closed",
				harness: "codex",
				capabilities: ["work:read", "work:propose"],
				dataScope: {
					projects: ["Alpha"],
					contextPaths: ["/"],
					sourceVisibilities: ["company"],
				},
			},
		});
		const result = await callMcp(
			app,
			created.json().secret,
			"task_create_proposal",
			{
				clientEventId: "classifier-outage",
				title: "Preserve proposal",
				project: "Alpha",
				rationale: "Do not accept unchecked work.",
			},
		);

		expect(result.message.result.isError).toBe(true);
		expect(await store.listProposals("pending")).toEqual([
			expect.objectContaining({
				kind: "task_create",
				changes: expect.objectContaining({
					title: "Preserve proposal",
				}),
			}),
		]);
	});

	it("accepts a signed offline relay report exactly once and denies a revoked device", async () => {
		const app = await makeApp();
		const admin = { authorization: "Bearer test-secret" };
		const profileResponse = await app.inject({
			method: "POST",
			url: "/api/agents",
			headers: admin,
			payload: {
				memberId: LOCAL_MEMBER_ID,
				name: "Laptop relay",
				harness: "codex",
			},
		});
		const { privateKey, publicKey } = generateKeyPairSync("ed25519");
		const privatePem = privateKey
			.export({ type: "pkcs8", format: "pem" })
			.toString();
		const publicPem = publicKey
			.export({ type: "spki", format: "pem" })
			.toString();
		const deviceResponse = await app.inject({
			method: "POST",
			url: "/api/devices",
			headers: admin,
			payload: {
				agentProfileId: profileResponse.json().profile.id,
				name: "Mira laptop",
				publicKey: publicPem,
				privacyMode: "metadata",
			},
		});

		expect(deviceResponse.statusCode).toBe(201);

		const device = deviceResponse.json().device;
		const raw = serializeRelayEnvelope(
			createRelayEnvelope(device.id, {
				reportId: "offline-report-1",
				workItemId: null,
				phase: "verified",
				outcome: "Unit tests passed.",
				artifactRefs: ["git:abc"],
				verification: ["pnpm test"],
				occurredAt: "2026-09-16T12:00:00.000Z",
			}),
		);
		const signature = signRelayEnvelope(raw, privatePem);
		const request = {
			method: "POST" as const,
			url: "/api/relay/work-reports",
			headers: {
				"content-type": "application/json",
				"x-panini-signature": signature,
			},
			payload: raw,
		};

		expect((await app.inject(request)).statusCode).toBe(201);
		expect((await app.inject(request)).statusCode).toBe(200);

		await app.inject({
			method: "POST",
			url: `/api/devices/${device.id}/revoke`,
			headers: admin,
			payload: {},
		});
		expect((await app.inject(request)).statusCode).toBe(401);
	});

	it("binds GitHub App OAuth to the admin session and checks selected repository access", async () => {
		const { privateKey } = generateKeyPairSync("rsa", {
			modulusLength: 2048,
		});
		const credentials = {
			appId: 7,
			clientId: "client",
			clientSecret: "secret",
			appSlug: "panini",
			privateKey: privateKey
				.export({ type: "pkcs8", format: "pem" })
				.toString(),
			callbackUrl: "https://panini.example/api/github/oauth/callback",
		};
		const repository = {
			id: 42,
			name: "pilot",
			full_name: "acme/pilot",
			private: true,
			html_url: "https://github.com/acme/pilot",
			default_branch: "main",
			archived: false,
		};
		const organization = { id: 9, login: "acme", type: "Organization" };
		const githubClient = new GithubAppClient(credentials, (async (url) => {
			const path = new URL(String(url)).pathname;
			const payload =
				path === "/login/oauth/access_token"
					? { access_token: "user-token" }
					: path === "/user"
						? { id: 5, login: "admin", type: "User" }
						: path === "/user/memberships/orgs"
							? [{ organization, state: "active" }]
							: path === "/user/installations"
								? {
										installations: [
											{
												id: 12,
												account: organization,
												permissions: {
													contents: "read",
												},
												repository_selection:
													"selected",
												suspended_at: null,
											},
										],
									}
								: path ===
											"/user/installations/12/repositories" ||
									  path === "/installation/repositories"
									? { repositories: [repository] }
									: path ===
										  "/app/installations/12/access_tokens"
										? { token: "installation-token" }
										: null;

			if (!payload) throw new Error(`Unexpected GitHub path ${path}`);
			return new Response(JSON.stringify(payload), { status: 200 });
		}) as typeof fetch);
		const runtimeConfig: RuntimeConfig = {
			...config,
			githubApp: credentials,
		};
		const { app, store } = await makeSystem(runtimeConfig, githubClient);
		const login = await app.inject({
			method: "POST",
			url: "/api/session",
			payload: { token: "test-secret" },
		});
		const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
		const csrf = login.json().csrf as string;

		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/github/connect/start",
				})
			).statusCode,
		).toBe(401);

		const started = await app.inject({
			method: "POST",
			url: "/api/github/connect/start",
			headers: { cookie, "x-panini-csrf": csrf },
		});

		expect(started.statusCode).toBe(200);

		const state = new URL(started.json().authorizationUrl).searchParams.get(
			"state",
		);
		const callback = await app.inject({
			method: "GET",
			url: `/api/github/oauth/callback?state=${state}&code=code`,
			headers: { cookie },
		});

		expect(callback.statusCode).toBe(302);

		const location = String(callback.headers.location);
		const selectionId = new URL(
			location,
			"https://panini.example",
		).searchParams.get("githubSelection");

		expect(selectionId).toBeTruthy();

		const session = await app.inject({
			method: "GET",
			url: `/api/github/connect/session/${selectionId}`,
			headers: { cookie },
		});

		expect(session.json().installations[0].repositories).toEqual([
			repository,
		]);

		const denied = await app.inject({
			method: "POST",
			url: "/api/github/connect/complete",
			headers: { cookie, "x-panini-csrf": csrf },
			payload: { selectionId, installationId: 12, repositoryIds: [99] },
		});

		expect(denied.statusCode).toBe(403);
		expect(await store.listSourceInstallations()).toEqual([]);

		const completed = await app.inject({
			method: "POST",
			url: "/api/github/connect/complete",
			headers: { cookie, "x-panini-csrf": csrf },
			payload: { selectionId, installationId: 12, repositoryIds: [42] },
		});

		expect(completed.statusCode).toBe(202);
		expect(
			(await store.listSourceInstallations())[0]?.config.repositoryIds,
		).toEqual([42]);
	});

	it("keeps hosted work drafting gated without explicit external-processing scope", async () => {
		const app = await makeApp();
		const response = await app.inject({
			method: "POST",
			url: "/api/reconciliation/shadow/draft",
			headers: { authorization: "Bearer test-secret" },
			payload: {},
		});

		expect(response.statusCode).toBe(409);
	});

	it("records a human-authored project edit as a cited revision", async () => {
		const app = await makeApp();
		const headers = { authorization: "Bearer test-secret" };
		const created = await app.inject({
			method: "POST",
			url: "/api/projects",
			headers,
			payload: { name: "Pilot", outcome: "Ship a pilot.", owner: null },
		});

		expect(created.statusCode).toBe(201);

		const projectId = created.json().project.id as string;
		const changed = await app.inject({
			method: "PATCH",
			url: `/api/projects/${projectId}`,
			headers,
			payload: {
				baseVersion: 1,
				changes: {
					name: "Pilot release",
					outcome: "Verify and ship the pilot.",
					owner: "Mira",
				},
			},
		});

		expect(changed.statusCode).toBe(200);
		expect(changed.json().project).toMatchObject({
			version: 2,
			name: "Pilot release",
			outcome: "Verify and ship the pilot.",
			owner: "Mira",
			aliases: ["Pilot"],
		});

		const detail = await app.inject({
			method: "GET",
			url: `/api/projects/${projectId}`,
			headers,
		});

		expect(detail.json().revisions).toHaveLength(2);
		expect(detail.json().proposals).toHaveLength(2);

		const stale = await app.inject({
			method: "PATCH",
			url: `/api/projects/${projectId}`,
			headers,
			payload: { baseVersion: 1, changes: { outcome: "Stale change." } },
		});

		expect(stale.statusCode).toBe(409);
	});
});
