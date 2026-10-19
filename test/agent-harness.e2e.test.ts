import { mkdir, writeFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { chromium } from "playwright";
import { loadConfig } from "../src/config.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { MemoryLedgerStore } from "../src/store/memory.js";
import { buildHttpServer } from "../src/http/server.js";
import { EvidenceIntelligence } from "../src/intelligence/engine.js";
import { AutonomousAdjudicator } from "../src/adjudication/engine.js";
import { OutboxQueue } from "../src/outbox/runtime.js";
import { ReplayVerifier } from "../src/replay/verifier.js";

// Failure cases before implementation: creation requires a harness; changing recipes
// creates another identity or loses the one-time secret; reopening reveals a secret;
// legacy profiles cannot use all recipes; narrow screens hide the harness controls.
it.runIf(process.env.PANINI_AGENT_BROWSER_TEST === "true")(
	"creates one agent and switches every harness recipe without changing credentials",
	async () => {
		const config = await loadConfig();

		Object.assign(config, {
			databaseUrl: null,
			adminToken: "agent-browser-test-secret",
			publicUrl: "http://127.0.0.1:4153",
		});

		const store = new MemoryLedgerStore();
		const ledger = new TeamLedger(
			store,
			new ProposalPolicy(config.app.policy),
		);
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
			intelligence,
			adjudicator,
			jobs: new OutboxQueue(store),
			replay: new ReplayVerifier(store),
		});

		await app.listen({ host: "127.0.0.1", port: 4153 });

		const browser = await chromium.launch();
		const page = await browser.newPage({
			viewport: { width: 1200, height: 950 },
		});
		const errors: string[] = [];

		page.on("pageerror", (error) => errors.push(error.message));
		try {
			await page.goto("http://127.0.0.1:4153/app/agents");
			await page.locator("#session-token").fill(config.adminToken!);
			await page.locator("#session-form button[type=submit]").click();
			await page.locator("#new-agent").click();
			expect(
				await page.locator("#agent-form [name=harness]").count(),
			).toBe(0);
			await page.locator("#agent-name").fill("Shared research agent");

			const created = page.waitForResponse(
				(r) =>
					r.url().endsWith("/api/agents") &&
					r.request().method() === "POST",
			);

			await page.locator("#agent-form button[type=submit]").click();

			const response = await created;

			expect(response.status()).toBe(201);
			expect(response.request().postDataJSON()).not.toHaveProperty(
				"harness",
			);

			const enrollment = await response.json();

			expect(enrollment.setups).toHaveLength(5);
			for (const recipe of enrollment.setups) {
				await page
					.locator(`[data-setup-harness="${recipe.harness}"]`)
					.click();
				expect(
					await page.locator("#setup-content").innerText(),
				).toContain(recipe.steps[1].code);
				expect(
					await page.locator(".secret-panel code").textContent(),
				).toBe(enrollment.secret);
				expect(recipe.profileId).toBe(enrollment.profile.id);
				expect(recipe.tokenEnvironmentVariable).toBe(
					enrollment.setup.tokenEnvironmentVariable,
				);
			}
			await mkdir(".panini/e2e", { recursive: true });
			// Never persist a screenshot of the one-time credential.
			await page.locator('[data-close="setup-dialog"]').click();
			await page.locator("[data-agent-setup]").click();
			await page
				.locator('#setup-dialog[open] [data-setup-harness="codex"]')
				.waitFor();
			expect(await page.locator(".secret-panel code").count()).toBe(0);
			expect(await page.locator("[data-setup-harness]").count()).toBe(5);
			await page.screenshot({
				path: ".panini/e2e/agent-harness-desktop.png",
			});
			await page.setViewportSize({ width: 390, height: 844 });
			await page.locator('[data-setup-harness="codex"]').click();
			await page.screenshot({
				path: ".panini/e2e/agent-harness-mobile.png",
			});
			expect(
				await page
					.locator("#setup-dialog")
					.evaluate((el) => el.scrollWidth <= el.clientWidth),
			).toBe(true);
			await page.locator('[data-close="setup-dialog"]').click();
			await page.locator("#agent-connect-menu summary").click();
			expect(await page.locator("[data-connect-harness]").count()).toBe(
				5,
			);
			await page.locator('[data-connect-harness="claude_code"]').click();
			await page
				.locator(
					'#setup-dialog[open] [data-setup-harness="claude_code"][aria-pressed="true"]',
				)
				.waitFor();
			expect(await page.locator(".secret-panel code").count()).toBe(0);
			expect((await ledger.listAgentProfiles()).length).toBe(1);
			expect(errors).toEqual([]);
			await writeFile(
				".panini/e2e/agent-harness-browser.json",
				JSON.stringify(
					{
						passed: true,
						storage: "disposable in-memory",
						harnesses: enrollment.setups.map(
							(s: { harness: string }) => s.harness,
						),
						profiles: 1,
						errors,
					},
					null,
					2,
				),
			);
		} finally {
			await browser.close();
			await app.close();
		}
	},
	60_000,
);
