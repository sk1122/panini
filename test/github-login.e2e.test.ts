import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
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
import { GithubAppClient } from "../src/connectors/github/app-client.js";
import { buildHttpServer } from "../src/http/server.js";

const databaseUrl = process.env.PANINI_PRODUCTION_TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin =
	process.env.PANINI_GITHUB_BROWSER_TEST === "true"
		? "http://localhost:4152"
		: "http://localhost:4149";
const encryptionKey = Buffer.alloc(32, 11).toString("base64");
const token = "panini_admin_test_very_long_random_installation_secret";
const password = "My test password is long enough 54!";

type App = Awaited<ReturnType<typeof buildHttpServer>>;

const cookies = (response: { headers: Record<string, unknown> }) => {
	const value = response.headers["set-cookie"];

	return (Array.isArray(value) ? value : [value])
		.filter(Boolean)
		.map((item) => String(item).split(";")[0])
		.join("; ");
};

suite("GitHub login with real PostgreSQL and fixture provider", () => {
	const pool = new pg.Pool({ connectionString: databaseUrl });
	const organizations: string[] = [];
	const cleanup: Array<() => Promise<unknown>> = [];

	beforeAll(async () => {
		await migrate(databaseUrl!);
	}, 30_000);
	afterAll(async () => {
		for (const close of cleanup.reverse()) await close();
		for (const id of organizations)
			await pool.query("DELETE FROM organizations WHERE id=$1", [id]);
		await pool.end();
	});

	async function system(existingId?: string) {
		const id = existingId ?? randomUUID();

		if (!existingId) {
			organizations.push(id);
			await pool.query(
				"INSERT INTO organizations(id,slug,name) VALUES($1,$2,'Test')",
				[id, `test-${id}`],
			);
		}

		const config = await loadConfig();

		Object.assign(config, {
			databaseUrl,
			contentEncryptionKey: encryptionKey,
			adminToken: token,
			publicUrl: origin,
			githubApp: {
				appId: 1,
				clientId: "fixture-client",
				clientSecret: "fixture-secret",
				privateKey: "",
				appSlug: "fixture",
				callbackUrl: `${origin}/api/github/oauth/callback`,
			},
		});
		config.app.intelligence.enabled = false;
		config.app.adjudication.enabled = false;

		const githubAppClient = new GithubAppClient(
			config.githubApp!,
			async (input, init) => {
				const url = String(input);

				if (url.endsWith("/access_token")) {
					const body = JSON.parse(String(init?.body));

					expect(body.code_verifier.length).toBeGreaterThan(40);
					expect(body.redirect_uri).toBe(
						`${origin}/api/github/oauth/callback`,
					);
					return Response.json({ access_token: body.code });
				}
				if (url.endsWith("/user")) {
					const bearer =
						(init?.headers as Record<string, string>)
							.Authorization ?? "";

					return Response.json({
						id: bearer.includes("other") ? 222 : 111,
						login: bearer.includes("renamed")
							? "new-handle"
							: "fixture-user",
						type: "User",
					});
				}
				throw new Error(`Unexpected fixture URL ${url}`);
			},
		);
		const store = new PostgresLedgerStore(databaseUrl!, encryptionKey, id);
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
			githubAppClient,
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
		return { app, id };
	}

	async function begin(
		app: App,
		payload: Record<string, unknown>,
		session?: { cookie: string; csrf: string },
	) {
		const response = await app.inject({
			method: "POST",
			url: session
				? "/api/account/github/start"
				: "/api/auth/github/start",
			headers: {
				origin,
				...(session
					? { cookie: session.cookie, "x-panini-csrf": session.csrf }
					: {}),
			},
			payload,
		});

		expect(response.statusCode).toBe(200);

		const auth = new URL(response.json().authorizationUrl);

		expect(auth.origin).toBe("https://github.com");
		expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
		return {
			state: auth.searchParams.get("state")!,
			cookie: cookies(response) + (session ? `; ${session.cookie}` : ""),
		};
	}

	async function finish(
		app: App,
		flow: { state: string; cookie: string },
		code = "owner",
	) {
		return app.inject({
			url: `/api/github/oauth/callback?state=${flow.state}&code=${code}`,
			headers: { cookie: flow.cookie },
		});
	}

	const setup = {
		purpose: "setup",
		token,
		companyName: "GitHub Company",
		displayName: "GitHub Owner",
		email: "owner@example.test",
	};

	async function me(app: App, cookie: string) {
		const response = await app.inject({
			url: "/api/session",
			headers: { cookie },
		});

		expect(response.statusCode).toBe(200);
		return { ...response.json(), cookie };
	}

	it("fixes the loopback alias mismatch without permitting other origins or ports", async () => {
		const { app } = await system();
		const aliasOrigin = origin.replace("localhost", "127.0.0.1");
		const alias = await app.inject({
			url: "/setup",
			headers: { host: new URL(aliasOrigin).host },
		});

		expect(alias.statusCode).toBe(302);
		expect(alias.headers.location).toBe(`${origin}/setup`);
		for (const allowed of [origin, aliasOrigin]) {
			const reply = await app.inject({
				method: "POST",
				url: "/api/auth/bootstrap",
				headers: { origin: allowed },
				payload: {
					...setup,
					purpose: undefined,
					token: "wrong",
					password,
				},
			});

			expect(reply.statusCode).toBe(401);
			expect(reply.json().error).toBe(
				"The installation secret is incorrect.",
			);
		}
		for (const denied of [
			"https://evil.test",
			"http://localhost:4150",
			"http://localhost.evil.test:4149",
		]) {
			expect(
				(
					await app.inject({
						method: "POST",
						url: "/api/auth/bootstrap",
						headers: { origin: denied },
						payload: {},
					})
				).statusCode,
			).toBe(403);
		}
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/auth/bootstrap",
					headers: { origin, "sec-fetch-site": "cross-site" },
					payload: {},
				})
			).statusCode,
		).toBe(403);
	});

	it("requires the installation secret, persists browser-bound single-use setup across restart, and signs in by stable GitHub ID", async () => {
		const { app, id } = await system();

		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/auth/github/start",
					headers: { origin },
					payload: { ...setup, token: "wrong" },
				})
			).statusCode,
		).toBe(401);

		const flow = await begin(app, setup);
		const stored = await pool.query(
			"SELECT payload FROM github_login_flows WHERE organization_id=$1",
			[id],
		);

		expect(JSON.stringify(stored.rows)).not.toContain("GitHub Company");

		const reopened = await system(id);
		const completed = await finish(reopened.app, flow);

		expect(completed.statusCode).toBe(302);
		expect(completed.headers.location).toBe("/app/onboarding");

		const account = await me(app, cookies(completed));

		expect(account.organization.name).toBe("GitHub Company");
		expect(account.authentication.hasPassword).toBe(false);
		expect(account.authentication.github.login).toBe("fixture-user");
		expect((await finish(app, flow)).headers.location).toContain(
			"githubError=",
		);

		const signin = await finish(
			app,
			await begin(app, { purpose: "login", next: "//evil.test" }),
			"renamed",
		);
		const second = await me(app, cookies(signin));

		expect(second.identity.id).toBe(account.identity.id);
		expect(second.authentication.github.login).toBe("new-handle");

		const headers = {
			origin,
			cookie: account.cookie,
			"x-panini-csrf": account.csrf,
		};

		expect(
			(
				await app.inject({
					method: "DELETE",
					url: "/api/account/github",
					headers,
				})
			).statusCode,
		).toBe(409);
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/account/password",
					headers,
					payload: { currentPassword: "", password },
				})
			).statusCode,
		).toBe(200);
	}, 30_000);

	it("rejects unknown, missing-cookie, expired, denied and reused callbacks without creating accounts", async () => {
		const { app, id } = await system();
		const flow = await begin(app, setup);

		expect(
			(await finish(app, { ...flow, cookie: "" })).headers.location,
		).toContain("githubError=");
		expect(
			(await finish(app, { ...flow, state: "panini_login_unknown" }))
				.headers.location,
		).toContain("githubError=");
		await pool.query(
			"UPDATE github_login_flows SET expires_at=now()-interval '1 second' WHERE organization_id=$1",
			[id],
		);
		expect((await finish(app, flow)).headers.location).toContain(
			"githubError=",
		);

		const denied = await begin(app, setup);

		expect(
			(
				await app.inject({
					url: `/api/github/oauth/callback?state=${denied.state}&error=access_denied`,
					headers: { cookie: denied.cookie },
				})
			).headers.location,
		).toContain("githubError=");
		expect((await finish(app, denied)).headers.location).toContain(
			"githubError=",
		);
		expect(
			(
				await pool.query(
					"SELECT 1 FROM member_accounts WHERE organization_id=$1",
					[id],
				)
			).rowCount,
		).toBe(0);
	});

	it("never auto-links existing password accounts, requires CSRF to link, and rejects a link after logout", async () => {
		const { app } = await system();
		const created = await app.inject({
			method: "POST",
			url: "/api/auth/bootstrap",
			headers: { origin },
			payload: {
				token,
				companyName: "Company",
				displayName: "Owner",
				email: "owner@example.test",
				password,
			},
		});
		const account = await me(app, cookies(created));

		expect(
			(await finish(app, await begin(app, { purpose: "login" }))).headers
				.location,
		).toContain("githubError=not_linked");
		expect(
			(
				await app.inject({
					method: "POST",
					url: "/api/account/github/start",
					headers: { origin, cookie: account.cookie },
					payload: {},
				})
			).statusCode,
		).toBe(403);

		const flow = await begin(app, {}, account);

		await app.inject({
			method: "POST",
			url: "/api/auth/logout",
			headers: {
				origin,
				cookie: account.cookie,
				"x-panini-csrf": account.csrf,
			},
			payload: {},
		});
		expect((await finish(app, flow)).headers.location).toContain(
			"githubError=",
		);

		const login = await app.inject({
			method: "POST",
			url: "/api/auth/login",
			headers: { origin },
			payload: { email: "owner@example.test", password },
		});
		const current = await me(app, cookies(login));

		expect(
			(await finish(app, await begin(app, {}, current))).headers.location,
		).toBe("/app/settings");

		const linked = await me(app, current.cookie);

		expect(linked.authentication.github.id).toBe("111");
	}, 30_000);

	it("requires an invitation to join, keeps its role/email, rejects reuse and disabled GitHub users", async () => {
		const { app } = await system();
		const owner = await me(
			app,
			cookies(await finish(app, await begin(app, setup))),
		);
		const invitation = await app.inject({
			method: "POST",
			url: "/api/invitations",
			headers: {
				origin,
				cookie: owner.cookie,
				"x-panini-csrf": owner.csrf,
			},
			payload: { email: "invite@example.test", role: "member" },
		});
		const inviteToken = new URL(invitation.json().url).hash.slice(1);
		const joined = await finish(
			app,
			await begin(app, {
				purpose: "join",
				token: inviteToken,
				displayName: "Teammate",
			}),
			"other",
		);
		const teammate = await me(app, cookies(joined));

		expect(teammate.identity.email).toBe("invite@example.test");
		expect(teammate.identity.role).toBe("member");

		const reused = await finish(
			app,
			await begin(app, {
				purpose: "join",
				token: inviteToken,
				displayName: "Again",
			}),
			"other",
		);

		expect(reused.headers.location).toContain("githubError=");
		await app.inject({
			method: "PATCH",
			url: `/api/members/${teammate.identity.id}`,
			headers: {
				origin,
				cookie: owner.cookie,
				"x-panini-csrf": owner.csrf,
			},
			payload: { status: "disabled" },
		});
		expect(
			(await finish(app, await begin(app, { purpose: "login" }), "other"))
				.headers.location,
		).toContain("githubError=");
	}, 30_000);

	it.skipIf(process.env.PANINI_GITHUB_BROWSER_TEST !== "true")(
		"completes GitHub setup and repeat sign-in in Chromium with a fixture authorization server",
		async () => {
			const { chromium } = await import("playwright");
			const { app } = await system();

			await app.listen({ host: "127.0.0.1", port: 4152 });

			const browser = await chromium.launch();
			const page = await browser.newPage({
				viewport: { width: 1100, height: 950 },
			});
			const errors: string[] = [];

			page.on("pageerror", (error) => errors.push(error.message));
			await page.route(
				"https://github.com/login/oauth/authorize?*",
				async (route) => {
					const url = new URL(route.request().url());
					const callback = new URL(
						url.searchParams.get("redirect_uri")!,
					);

					callback.searchParams.set(
						"state",
						url.searchParams.get("state")!,
					);
					callback.searchParams.set("code", "owner");
					await route.fulfill({
						status: 302,
						headers: { location: callback.toString() },
						body: "",
					});
				},
			);
			try {
				await page.goto("http://127.0.0.1:4152/setup");
				await page.waitForURL(`${origin}/setup`);
				await mkdir(".panini/e2e", { recursive: true });
				await page.screenshot({
					path: ".panini/e2e/github-setup.png",
					fullPage: true,
					animations: "disabled",
				});
				await page
					.getByLabel("Installation secret", { exact: true })
					.fill(token);
				await page
					.getByLabel("Company name", { exact: true })
					.fill("Browser GitHub Company");
				await page
					.getByLabel("Your name", { exact: true })
					.fill("Browser GitHub Owner");
				await page
					.getByLabel("Email", { exact: true })
					.fill("browser-github@example.test");
				await page
					.getByRole("button", {
						name: "Create workspace with GitHub",
						exact: true,
					})
					.click();
				await page.waitForURL("**/app/onboarding");
				await page
					.getByRole("button", { name: "Finish setup", exact: true })
					.click();
				await page.waitForURL("**/app/projects");
				await page.goto(`${origin}/app/settings`);
				await page
					.getByText("Connected as fixture-user.", { exact: false })
					.waitFor();
				await page
					.getByLabel("New password", { exact: true })
					.fill(password);
				await page
					.getByRole("button", {
						name: "Change password",
						exact: true,
					})
					.click();
				await page
					.getByText(
						"Password changed. Other sessions have been signed out.",
						{ exact: true },
					)
					.waitFor();

				const disconnected = page.waitForResponse(
					(response) =>
						response.url().endsWith("/api/account/github") &&
						response.request().method() === "DELETE",
				);

				await page
					.getByRole("button", {
						name: "Disconnect GitHub",
						exact: true,
					})
					.click();

				const disconnectResponse = await disconnected;

				expect(
					disconnectResponse.status(),
					await disconnectResponse.text(),
				).toBe(200);
				await page
					.getByText(
						"GitHub is not connected to your personal account.",
						{ exact: true },
					)
					.waitFor();
				await page
					.getByRole("button", {
						name: "Connect GitHub",
						exact: true,
					})
					.click();
				await page
					.getByText("Connected as fixture-user.", { exact: false })
					.waitFor();
				await page
					.getByRole("button", { name: "Sign out", exact: true })
					.click();
				await page.waitForURL("**/login**");
				await page.screenshot({
					path: ".panini/e2e/github-login.png",
					fullPage: true,
					animations: "disabled",
				});
				await page
					.getByRole("button", {
						name: "Sign in with GitHub",
						exact: true,
					})
					.click();
				await page.waitForURL("**/app/settings");
				expect(errors).toEqual([]);
				await writeFile(
					".panini/e2e/github-browser-results.json",
					JSON.stringify(
						{
							passed: true,
							provider: "fixture; no real GitHub consent",
							checks: [
								"loopback canonical redirect",
								"GitHub setup without password",
								"set password",
								"disconnect and reconnect GitHub",
								"logout and repeat GitHub sign-in",
							],
							errors,
							timestamp: new Date().toISOString(),
						},
						null,
						2,
					),
				);
			} finally {
				await browser.close();
			}
		},
		60_000,
	);
});
