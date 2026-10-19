import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { migrate } from "../src/db/migrate.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { AutonomousAdjudicator } from "../src/adjudication/engine.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";
import { IdentityService } from "../src/security/identity.js";
import { buildHttpServer } from "../src/http/server.js";

const databaseUrl = process.env.PANINI_PRODUCTION_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = "https://panini.example.test";
const bootstrapToken = "panini_admin_test_very_long_random_installation_secret";
const password = "Correct horse battery staple 49!";
const nextPassword = "A different long passphrase 77!";
const encryptionKey = Buffer.alloc(32, 11).toString("base64");

type App = Awaited<ReturnType<typeof buildHttpServer>>;
type Login = { cookie: string; csrf: string; memberId: string };

suite(
	"production identity and onboarding over HTTP with real PostgreSQL",
	() => {
		const pool = new pg.Pool({ connectionString: databaseUrl });
		const organizations: string[] = [];
		const cleanup: Array<() => Promise<unknown>> = [];

		beforeAll(async () => {
			await migrate(databaseUrl!);
			await migrate(databaseUrl!);
		}, 30_000);
		afterAll(async () => {
			for (const close of cleanup.reverse()) await close();
			for (const id of organizations) {
				await pool.query(
					"DELETE FROM evidence_dependencies WHERE organization_id=$1",
					[id],
				);
				await pool.query("DELETE FROM organizations WHERE id=$1", [id]);
			}
			await pool.end();
		});

		async function system(existingId?: string) {
			const id = existingId ?? randomUUID();

			if (!existingId) {
				organizations.push(id);
				await pool.query(
					"INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Before onboarding')",
					[id, `test-${id}`],
				);
			}

			const config = await loadConfig();

			Object.assign(config, {
				databaseUrl,
				contentEncryptionKey: encryptionKey,
				adminToken: bootstrapToken,
				publicUrl: origin,
			});
			config.app.intelligence.enabled = false;
			config.app.adjudication.enabled = false;

			const store = new PostgresLedgerStore(
				databaseUrl!,
				encryptionKey,
				id,
			);
			const ledger = new TeamLedger(
				store,
				new ProposalPolicy(config.app.policy),
			);
			const identity = new IdentityService(databaseUrl!, id);
			const log = { info() {}, error() {} };
			const intelligence = new EvidenceIntelligence({
				store,
				ledger,
				interpreter: null,
				companyName: "Test",
				config: config.app.intelligence,
				log,
			});
			const adjudicator = new AutonomousAdjudicator({
				store,
				ledger,
				provider: null,
				companyName: "Test",
				config: config.app.adjudication,
				completionPolicy: {
					minimumEvidenceItems: 2,
					evidenceProviders: ["agent"],
				},
				log,
			});
			const app = await buildHttpServer({
				config,
				ledger,
				identity,
				intelligence,
				adjudicator,
				jobs: new OutboxQueue(store),
				replay: new ReplayVerifier(store),
			});

			cleanup.push(
				() => store.close(),
				() => identity.close(),
				() => app.close(),
			);
			return { id, app, store, ledger, identity };
		}

		function headers(login: Login) {
			return {
				cookie: login.cookie,
				"x-panini-csrf": login.csrf,
				origin,
			};
		}

		function session(response: Awaited<ReturnType<App["inject"]>>): Login {
			expect(response.statusCode).toBe(200);

			const setCookie = String(response.headers["set-cookie"]);

			expect(setCookie).toContain("HttpOnly");
			expect(setCookie).toContain("SameSite=Lax");
			expect(setCookie).toContain("Secure");
			expect(response.headers["cache-control"]).toContain("no-store");
			return {
				cookie: setCookie.split(";")[0]!,
				csrf: response.json().csrf,
				memberId: response.json().identity.memberId,
			};
		}

		async function bootstrap(app: App, email = "owner@example.test") {
			return session(
				await app.inject({
					method: "POST",
					url: "/api/auth/bootstrap",
					headers: { origin },
					payload: {
						token: bootstrapToken,
						companyName: "Our Company",
						displayName: "Owner",
						email,
						password,
					},
				}),
			);
		}

		async function invite(
			app: App,
			owner: Login,
			role = "member",
			email = `member-${randomUUID()}@example.test`,
		) {
			const response = await app.inject({
				method: "POST",
				url: "/api/invitations",
				headers: headers(owner),
				payload: { email, role },
			});

			expect(response.statusCode).toBe(201);

			const token = new URL(response.json().url).hash.slice(1);

			expect(token.length).toBeGreaterThan(30);
			return { token, email, id: response.json().invitation.id };
		}

		async function accept(app: App, invitation: { token: string }) {
			return session(
				await app.inject({
					method: "POST",
					url: "/api/auth/invitations/accept",
					headers: { origin },
					payload: {
						token: invitation.token,
						displayName: "Teammate",
						password,
					},
				}),
			);
		}

		it("protects bootstrap, serializes first-owner creation, and persists company and user onboarding after restart", async () => {
			const { app, id } = await system();

			expect(
				(await app.inject("/api/auth/status")).json().setupRequired,
			).toBe(true);
			expect(
				(await app.inject("/app/context")).headers.location,
			).toContain("/setup");
			expect((await app.inject("/api/board")).statusCode).toBe(401);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/bootstrap",
						headers: { origin },
						payload: {
							token: "wrong",
							companyName: "Attacker",
							displayName: "Attacker",
							email: "attacker@example.test",
							password,
						},
					})
				).statusCode,
			).toBe(401);

			const attempts = await Promise.all(
				["first", "second"].map((name) =>
					app.inject({
						method: "POST",
						url: "/api/auth/bootstrap",
						headers: { origin },
						payload: {
							token: bootstrapToken,
							companyName: "Our Company",
							displayName: name,
							email: `${name}@example.test`,
							password,
						},
					}),
				),
			);

			expect(attempts.map((r) => r.statusCode).sort()).toEqual([
				200, 409,
			]);

			const owner = session(attempts.find((r) => r.statusCode === 200)!);

			expect(
				(await app.inject("/api/auth/status")).json().setupRequired,
			).toBe(false);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/app/context",
						headers: { cookie: owner.cookie },
					})
				).statusCode,
			).toBe(200);

			const changed = await app.inject({
				method: "PATCH",
				url: "/api/workspace/settings",
				headers: headers(owner),
				payload: { name: "Renamed Company" },
			});

			expect(changed.statusCode).toBe(200);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: "/api/account",
						headers: headers(owner),
						payload: { displayName: "Updated owner" },
					})
				).statusCode,
			).toBe(200);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/onboarding/complete",
						headers: headers(owner),
						payload: {},
					})
				).statusCode,
			).toBe(200);

			const reopened = await system(id);
			const me = await reopened.app.inject({
				method: "GET",
				url: "/api/session",
				headers: { cookie: owner.cookie },
			});

			expect(me.json().identity.displayName).toBe("Updated owner");
			expect(me.json().onboarding.completedAt).toBeTruthy();
			expect(me.json().organization.name).toBe("Renamed Company");
		}, 30_000);

		it("invalidates sessions on logout, password change, reset, and member disable", async () => {
			const { app, store } = await system();
			let owner = await bootstrap(app);
			const invitation = await invite(app, owner);
			const member = await accept(app, invitation);

			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/invitations/accept",
						headers: { origin },
						payload: {
							token: invitation.token,
							displayName: "Again",
							password,
						},
					})
				).statusCode,
			).toBe(400);

			const logout = await app.inject({
				method: "POST",
				url: "/api/auth/logout",
				headers: headers(member),
				payload: {},
			});

			expect(logout.statusCode).toBe(200);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/board",
						headers: { cookie: member.cookie },
					})
				).statusCode,
			).toBe(401);

			const member2 = session(
				await app.inject({
					method: "POST",
					url: "/api/auth/login",
					headers: { origin },
					payload: { email: invitation.email, password },
				}),
			);
			const reset = await app.inject({
				method: "POST",
				url: `/api/members/${member2.memberId}/reset-password`,
				headers: headers(owner),
				payload: {},
			});

			expect(reset.statusCode).toBe(201);

			const resetToken = new URL(reset.json().url).hash.slice(1);

			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/reset-password",
						headers: { origin },
						payload: { token: resetToken, password: nextPassword },
					})
				).statusCode,
			).toBe(200);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/reset-password",
						headers: { origin },
						payload: { token: resetToken, password },
					})
				).statusCode,
			).toBe(400);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/board",
						headers: { cookie: member2.cookie },
					})
				).statusCode,
			).toBe(401);

			const member3 = session(
				await app.inject({
					method: "POST",
					url: "/api/auth/login",
					headers: { origin },
					payload: {
						email: invitation.email,
						password: nextPassword,
					},
				}),
			);

			expect(
				(
					await app.inject({
						method: "PATCH",
						url: `/api/members/${member3.memberId}`,
						headers: headers(owner),
						payload: { status: "disabled" },
					})
				).statusCode,
			).toBe(200);
			await store.reconcileMemberIdentity({
				provider: "slack",
				installationKey: "test",
				externalId: "member-from-slack",
				displayName: "Teammate",
				email: invitation.email,
				status: "active",
			});
			expect((await store.getMember(member3.memberId))?.status).toBe(
				"disabled",
			);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/board",
						headers: { cookie: member3.cookie },
					})
				).statusCode,
			).toBe(401);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/login",
						headers: { origin },
						payload: {
							email: invitation.email,
							password: nextPassword,
						},
					})
				).statusCode,
			).toBe(401);

			const oldOwner = owner;

			owner = session(
				await app.inject({
					method: "POST",
					url: "/api/account/password",
					headers: headers(owner),
					payload: {
						currentPassword: password,
						password: nextPassword,
					},
				}),
			);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/board",
						headers: { cookie: oldOwner.cookie },
					})
				).statusCode,
			).toBe(401);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/board",
						headers: { cookie: owner.cookie },
					})
				).statusCode,
			).toBe(200);
		}, 30_000);

		it("enforces permissions, final-owner protection, private-source filtering, and agent ownership", async () => {
			const { app, store, ledger } = await system();
			const owner = await bootstrap(app);
			const member = await accept(app, await invite(app, owner));

			expect(
				(
					await app.inject({
						method: "PATCH",
						url: `/api/members/${member.memberId}`,
						headers: headers(member),
						payload: { role: "owner" },
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: "/api/workspace/settings",
						headers: headers(member),
						payload: { name: "Hijacked" },
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/invitations",
						headers: headers(member),
						payload: { email: "other@example.test", role: "owner" },
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: `/api/members/${owner.memberId}`,
						headers: headers(owner),
						payload: { status: "disabled" },
					})
				).statusCode,
			).toBe(409);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: `/api/members/${owner.memberId}`,
						headers: headers(owner),
						payload: { role: "member" },
					})
				).statusCode,
			).toBe(409);

			const privateEvent = await store.appendSourceEvent({
				provider: "manual",
				installationKey: "test",
				providerEventId: randomUUID(),
				eventKind: "source.document.retrieved",
				occurredAt: new Date().toISOString(),
				fetchedAt: new Date().toISOString(),
				sourceRef: `private:${randomUUID()}`,
				sourceUrl: null,
				visibility: "private:leadership",
				contentHash: "private-test",
				payloadVersion: "1",
				payload: {
					document: {
						title: "PRIVATE SALARY PLAN",
						markdown: "PRIVATE SALARY PLAN",
						suggestedPath: "/private/salary.md",
					},
				},
			});
			const eventId = privateEvent.event.id;
			const publicTaskResponse = await app.inject({
				method: "POST",
				url: "/api/tasks",
				headers: { ...headers(owner), "idempotency-key": randomUUID() },
				payload: { title: "Public work" },
			});

			expect(publicTaskResponse.statusCode).toBe(201);

			const publicTask = publicTaskResponse.json().task;
			const memberContractProposal = await app.inject({
				method: "POST",
				url: `/api/tasks/${publicTask.id}/outcome-contract-proposals`,
				headers: {
					...headers(member),
					"idempotency-key": randomUUID(),
				},
				payload: {
					baseRevision: publicTask.version,
					rationale: "Clarify work completion",
					contract: {
						statement: "Public work is complete",
						scope: "Public work",
						exclusions: [],
						criteria: [
							{
								id: "review",
								description: "Review accepted result",
								required: true,
								evidenceRule: {
									kind: "manual_review",
									authorityPolicyId: null,
									artifactRefs: [],
									requiredCheckNames: [],
									requiredEnvironment: null,
									maxMutableAgeSeconds: 900,
								},
							},
						],
					},
				},
			});

			expect(memberContractProposal.statusCode).toBe(201);

			const privateEvidenceProposal = await app.inject({
				method: "POST",
				url: `/api/tasks/${publicTask.id}/proposals`,
				headers: {
					...headers(member),
					"idempotency-key": randomUUID(),
				},
				payload: {
					baseRevision: publicTask.version,
					changes: { status: "done" },
					rationale: "Claim from private evidence",
					evidenceIds: [eventId],
				},
			});

			expect(privateEvidenceProposal.statusCode).toBe(403);

			const hiddenProposal = await ledger.proposeTaskCreation({
				externalRef: `private:${randomUUID()}`,
				title: "PRIVATE SALARY TASK",
				rationale: "Private source initiated work",
				requestedBy: "user:e2e",
				evidenceIds: [eventId],
			});
			const hiddenTask = await ledger.approveProposal(
				hiddenProposal.id,
				"user:e2e",
				"Reviewed private work",
			);

			if (!("version" in hiddenTask))
				throw new Error("Expected private task");

			const privateTargetProposal = await app.inject({
				method: "POST",
				url: `/api/tasks/${hiddenTask.id}/proposals`,
				headers: {
					...headers(member),
					"idempotency-key": randomUUID(),
				},
				payload: {
					baseRevision: hiddenTask.version,
					changes: { status: "done" },
					rationale: "Cannot modify hidden work",
					evidenceIds: [],
				},
			});

			expect(privateTargetProposal.statusCode).toBe(403);

			const privateTargetContract = await app.inject({
				method: "POST",
				url: `/api/tasks/${hiddenTask.id}/outcome-contract-proposals`,
				headers: {
					...headers(member),
					"idempotency-key": randomUUID(),
				},
				payload: {
					baseRevision: hiddenTask.version,
					rationale: "Cannot see this task",
					contract: {
						statement: "Hidden work complete",
						scope: "Private work",
						exclusions: [],
						criteria: [
							{
								id: "review",
								description: "Review private work",
								required: true,
								evidenceRule: {
									kind: "manual_review",
									authorityPolicyId: null,
									artifactRefs: [],
									requiredCheckNames: [],
									requiredEnvironment: null,
									maxMutableAgeSeconds: 900,
								},
							},
						],
					},
				},
			});

			expect(privateTargetContract.statusCode).toBe(403);

			const privateRead = await app.inject({
				method: "GET",
				url: `/api/source-documents/${eventId}`,
				headers: { cookie: member.cookie },
			});

			expect([403, 404]).toContain(privateRead.statusCode);

			const sourceList = await app.inject({
				method: "GET",
				url: "/api/source-documents",
				headers: { cookie: member.cookie },
			});

			expect(sourceList.body).not.toContain("PRIVATE SALARY PLAN");

			const otherProfile = await app.inject({
				method: "POST",
				url: "/api/agents",
				headers: headers(member),
				payload: {
					memberId: owner.memberId,
					name: "Impersonation",
					harness: "generic_mcp",
				},
			});

			expect(otherProfile.statusCode).toBe(403);

			const elevated = await app.inject({
				method: "POST",
				url: "/api/agents",
				headers: headers(member),
				payload: {
					memberId: member.memberId,
					name: "Overreach",
					harness: "generic_mcp",
					dataScope: {
						projects: [],
						contextPaths: ["/"],
						sourceVisibilities: ["private:leadership"],
					},
				},
			});

			expect(elevated.statusCode).toBe(403);

			const enrollment = await app.inject({
				method: "POST",
				url: "/api/agents",
				headers: headers(member),
				payload: {
					memberId: member.memberId,
					name: "My agent",
					harness: "generic_mcp",
				},
			});

			expect(enrollment.statusCode).toBe(201);
			expect(enrollment.json().setup.endpoint).toBe(`${origin}/mcp`);

			const secret = enrollment.json().secret;
			const profileId = enrollment.json().profile.id;
			const mcpRequest = {
				method: "POST" as const,
				url: "/mcp",
				headers: {
					authorization: `Bearer ${secret}`,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-protocol-version": "2025-03-26",
				},
				payload: {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/list",
					params: {},
				},
			};

			expect((await app.inject(mcpRequest)).statusCode).toBe(200);

			const memberAgain = await accept(app, await invite(app, owner));

			expect(
				(
					await app.inject({
						method: "POST",
						url: `/api/agents/${profileId}/rotate-secret`,
						headers: headers(memberAgain),
						payload: {},
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: `/api/members/${member.memberId}`,
						headers: headers(owner),
						payload: { status: "disabled" },
					})
				).statusCode,
			).toBe(200);
			expect((await app.inject(mcpRequest)).statusCode).toBe(401);
		}, 30_000);

		it("does not let a reviewer mutate private current context using a readable historical revision", async () => {
			const { app, store } = await system();
			const owner = await bootstrap(app);
			const invited = await app.inject({
				method: "POST",
				url: "/api/invitations",
				headers: headers(owner),
				payload: { email: "reviewer@example.test", role: "reviewer" },
			});
			const reviewer = await accept(app, {
				token: new URL(invited.json().url).hash.slice(1),
			});
			const created = await app.inject({
				method: "POST",
				url: "/api/context/entries",
				headers: { ...headers(owner), "idempotency-key": randomUUID() },
				payload: {
					kind: "file",
					path: "/policy.md",
					title: "Policy",
					body: "Previously public policy",
				},
			});

			expect(created.statusCode).toBe(201);

			const entry = created.json().entry;
			const privateEvent = await store.appendSourceEvent({
				provider: "manual",
				installationKey: "test",
				providerEventId: randomUUID(),
				eventKind: "source.document.retrieved",
				occurredAt: new Date().toISOString(),
				fetchedAt: new Date().toISOString(),
				sourceRef: `private:${randomUUID()}`,
				sourceUrl: null,
				visibility: "private:leadership",
				contentHash: "private-current-context",
				payloadVersion: "1",
				payload: { text: "CURRENT PRIVATE POLICY" },
			});

			await store.upsertContextEntry({
				...entry,
				body: "CURRENT PRIVATE POLICY",
				sourceEventId: privateEvent.event.id,
				evidenceIds: [privateEvent.event.id],
			});

			const response = await app.inject({
				method: "POST",
				url: `/api/context/entries/${entry.id}/lifecycle`,
				headers: {
					...headers(reviewer),
					"idempotency-key": randomUUID(),
				},
				payload: {
					lifecycleState: "needs_review",
					reason: "Cannot mutate current private content",
				},
			});

			expect(response.statusCode).toBe(403);
			expect(response.body).not.toContain("CURRENT PRIVATE POLICY");

			const overwrite = await app.inject({
				method: "POST",
				url: "/api/context/entries",
				headers: {
					...headers(reviewer),
					"idempotency-key": randomUUID(),
				},
				payload: {
					kind: "file",
					path: "/policy.md",
					title: "Overwrite",
					body: "Should not overwrite private current state",
				},
			});

			expect(overwrite.statusCode).toBe(403);
		}, 30_000);

		it("rejects cross-origin writes and bad CSRF, expires sessions, and handles malformed cookies", async () => {
			const { app, id } = await system();
			const owner = await bootstrap(app);

			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/login",
						headers: { origin: "https://evil.test" },
						payload: { email: "owner@example.test", password },
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/logout",
						headers: { cookie: owner.cookie, origin },
						payload: {},
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: "/api/account",
						headers: {
							...headers(owner),
							"x-panini-csrf": "wrong",
						},
						payload: { displayName: "Wrong" },
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: "/api/account",
						headers: {
							...headers(owner),
							origin: "https://evil.test",
						},
						payload: { displayName: "Wrong" },
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/session",
						headers: { cookie: "panini_session=%ZZ" },
					})
				).statusCode,
			).toBe(401);
			await pool.query(
				"UPDATE web_sessions SET expires_at=now()-interval '1 second' WHERE organization_id=$1",
				[id],
			);
			expect(
				(
					await app.inject({
						method: "GET",
						url: "/api/board",
						headers: { cookie: owner.cookie },
					})
				).statusCode,
			).toBe(401);
		}, 15_000);

		it("rejects expired/revoked invitations and blocks role forgery and administrator owner takeover", async () => {
			const { app, id } = await system();
			const owner = await bootstrap(app);
			const revoked = await invite(app, owner);

			expect(
				(
					await app.inject({
						method: "DELETE",
						url: `/api/invitations/${revoked.id}`,
						headers: headers(owner),
					})
				).statusCode,
			).toBe(200);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/invitations/accept",
						headers: { origin },
						payload: {
							token: revoked.token,
							displayName: "No",
							password,
						},
					})
				).statusCode,
			).toBe(400);

			const expired = await invite(app, owner);

			await pool.query(
				"UPDATE account_tokens SET expires_at=now()-interval '1 second' WHERE organization_id=$1 AND id=$2",
				[id, expired.id],
			);
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/invitations/accept",
						headers: { origin },
						payload: {
							token: expired.token,
							displayName: "No",
							password,
						},
					})
				).statusCode,
			).toBe(400);

			const safe = await invite(app, owner);

			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/invitations/accept",
						headers: { origin },
						payload: {
							token: safe.token,
							displayName: "No",
							password,
							role: "owner",
						},
					})
				).statusCode,
			).toBe(400);

			const admin = await accept(app, await invite(app, owner, "admin"));

			expect(
				(
					await app.inject({
						method: "POST",
						url: `/api/members/${owner.memberId}/reset-password`,
						headers: headers(admin),
						payload: {},
					})
				).statusCode,
			).toBe(403);
			expect(
				(
					await app.inject({
						method: "PATCH",
						url: `/api/members/${owner.memberId}`,
						headers: headers(admin),
						payload: { status: "disabled" },
					})
				).statusCode,
			).toBe(403);
		}, 30_000);

		it("limits password guessing in PostgreSQL and never exposes password hashes in account reads", async () => {
			const { app, id } = await system();
			const owner = await bootstrap(app);
			const wrong = await app.inject({
				method: "POST",
				url: "/api/auth/login",
				headers: { origin },
				payload: {
					email: "owner@example.test",
					password: "a very wrong password",
				},
			});
			const unknown = await app.inject({
				method: "POST",
				url: "/api/auth/login",
				headers: { origin },
				payload: {
					email: "unknown@example.test",
					password: "a very wrong password",
				},
			});

			expect(wrong.statusCode).toBe(401);
			expect(unknown.json()).toEqual(wrong.json());

			let lastStatus = 0;

			for (let i = 0; i < 12; i++) {
				lastStatus = (
					await app.inject({
						method: "POST",
						url: "/api/auth/login",
						headers: { origin },
						payload: {
							email: "owner@example.test",
							password: "a very wrong password",
						},
					})
				).statusCode;
				if (lastStatus === 429) break;
			}
			expect(lastStatus).toBe(429);

			const reopened = await system(id);

			expect(
				(
					await reopened.app.inject({
						method: "POST",
						url: "/api/auth/login",
						headers: { origin },
						payload: { email: "owner@example.test", password },
					})
				).statusCode,
			).toBe(429);

			const memberList = await app.inject({
				method: "GET",
				url: "/api/members",
				headers: { cookie: owner.cookie },
			});

			expect(memberList.statusCode).toBe(200);
			expect(memberList.body).not.toContain("scrypt");
			expect(memberList.body).not.toContain(password);
		}, 30_000);

		it("lets a reviewer propose an outcome contract without inventing acceptance metadata", async () => {
			const { app, store } = await system();
			const owner = await bootstrap(app);
			const created = await app.inject({
				method: "POST",
				url: "/api/tasks",
				headers: { ...headers(owner), "idempotency-key": randomUUID() },
				payload: {
					title: "Verify import repair",
					description: "Repair the whole import flow",
					status: "in_progress",
				},
			});

			expect(created.statusCode).toBe(201);

			const task = created.json().task;
			const proposalKey = randomUUID();
			const proposalPayload = {
				baseRevision: task.version,
				rationale: "Set explicit completion criteria",
				contract: {
					statement: "Import repair works end to end",
					scope: "Receipt through task state",
					exclusions: [],
					criteria: [
						{
							id: "e2e",
							description: "An import E2E passes",
							required: true,
							evidenceRule: {
								kind: "manual_review",
								authorityPolicyId: null,
								artifactRefs: [],
								requiredCheckNames: [],
								requiredEnvironment: null,
								maxMutableAgeSeconds: 900,
							},
						},
					],
				},
			};
			const proposed = await app.inject({
				method: "POST",
				url: `/api/tasks/${task.id}/outcome-contract-proposals`,
				headers: { ...headers(owner), "idempotency-key": proposalKey },
				payload: proposalPayload,
			});

			expect(proposed.statusCode).toBe(201);
			expect(proposed.json().proposal.state).toBe("pending");

			const approved = await app.inject({
				method: "POST",
				url: `/api/proposals/${proposed.json().proposal.id}/approve`,
				headers: { ...headers(owner), "idempotency-key": randomUUID() },
				payload: { note: "Reviewed the whole outcome" },
			});

			expect(approved.statusCode).toBe(200);

			const contract = (await store.getTask(task.id))?.outcomeContract;

			expect(contract).toMatchObject({
				version: 1,
				statement: "Import repair works end to end",
				provenance: {
					proposalId: proposed.json().proposal.id,
					actor: expect.stringContaining(owner.memberId),
					acceptedAt: expect.any(String),
				},
				criteria: [
					{
						id: "e2e",
						acceptedBy: expect.stringContaining(owner.memberId),
						acceptedAt: expect.any(String),
					},
				],
			});

			const retried = await app.inject({
				method: "POST",
				url: `/api/tasks/${task.id}/outcome-contract-proposals`,
				headers: { ...headers(owner), "idempotency-key": proposalKey },
				payload: proposalPayload,
			});

			expect(retried.statusCode).toBe(201);
			expect(retried.json().proposal.id).toBe(
				proposed.json().proposal.id,
			);
		}, 30_000);

		it("lets an authorized agent propose an outcome contract through MCP", async () => {
			const { app, store, ledger } = await system();
			const owner = await bootstrap(app);
			const created = await app.inject({
				method: "POST",
				url: "/api/tasks",
				headers: { ...headers(owner), "idempotency-key": randomUUID() },
				payload: { title: "Fix imports" },
			});

			expect(created.statusCode).toBe(201);

			const task = created.json().task;
			const enrolled = await app.inject({
				method: "POST",
				url: "/api/agents",
				headers: headers(owner),
				payload: {
					memberId: owner.memberId,
					name: "Outcome reviewer",
					harness: "generic_mcp",
					capabilities: ["work:read", "work:propose"],
					dataScope: {
						projects: ["*"],
						contextPaths: ["/"],
						sourceVisibilities: ["company"],
					},
				},
			});

			expect(enrolled.statusCode).toBe(201);

			const response = await app.inject({
				method: "POST",
				url: "/mcp",
				headers: {
					authorization: `Bearer ${enrolled.json().secret}`,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-protocol-version": "2025-03-26",
				},
				payload: {
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: {
						name: "outcome_contract_proposal_create",
						arguments: {
							clientEventId: randomUUID(),
							taskId: task.id,
							baseRevision: task.version,
							rationale: "Define completion before review",
							contract: {
								statement: "Imports succeed",
								scope: "All supported files",
								exclusions: [],
								criteria: [
									{
										id: "check",
										description: "Import check passes",
										required: true,
										evidenceRule: {
											kind: "manual_review",
											authorityPolicyId: null,
											artifactRefs: [],
											requiredCheckNames: [],
											requiredEnvironment: null,
											maxMutableAgeSeconds: 900,
										},
									},
								],
							},
							evidenceIds: [],
						},
					},
				},
			});

			expect(response.statusCode).toBe(200);

			const message = JSON.parse(
				response.body
					.split("\n")
					.find((line) => line.startsWith("data: "))
					?.slice(6) ?? response.body,
			);

			expect(
				message.result?.structuredContent,
				JSON.stringify(message),
			).toBeDefined();
			expect(message.result.structuredContent.proposal).toMatchObject({
				state: "pending",
				taskId: task.id,
				changes: { outcomeContract: { statement: "Imports succeed" } },
			});
			expect((await store.getTask(task.id))?.outcomeContract).toBeFalsy();

			const privateSource = (
				await store.appendSourceEvent({
					provider: "manual",
					installationKey: "test",
					providerEventId: randomUUID(),
					eventKind: "message.observed",
					occurredAt: new Date().toISOString(),
					fetchedAt: new Date().toISOString(),
					sourceRef: `private:${randomUUID()}`,
					sourceUrl: null,
					contentHash: randomUUID(),
					visibility: "private:leadership",
					payloadVersion: "1",
					payload: { text: "PRIVATE STRATEGY TASK" },
				})
			).event;
			const privateProposal = await ledger.proposeTaskCreation({
				externalRef: `private:${randomUUID()}`,
				title: "PRIVATE STRATEGY TASK",
				rationale: "Private source initiated work",
				requestedBy: "user:e2e",
				evidenceIds: [privateSource.id],
			});

			await ledger.approveProposal(
				privateProposal.id,
				"user:e2e",
				"Reviewed private source",
			);

			const searchResponse = await app.inject({
				method: "POST",
				url: "/mcp",
				headers: {
					authorization: `Bearer ${enrolled.json().secret}`,
					accept: "application/json, text/event-stream",
					"content-type": "application/json",
					"mcp-protocol-version": "2025-03-26",
				},
				payload: {
					jsonrpc: "2.0",
					id: 2,
					method: "tools/call",
					params: {
						name: "work_search",
						arguments: { query: "PRIVATE STRATEGY TASK" },
					},
				},
			});
			const search = JSON.parse(
				searchResponse.body
					.split("\n")
					.find((line) => line.startsWith("data: "))
					?.slice(6) ?? searchResponse.body,
			);

			expect(search.result.structuredContent.tasks).toEqual([]);
		}, 30_000);
	},
);
