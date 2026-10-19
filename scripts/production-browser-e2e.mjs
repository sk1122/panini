import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright";

const base = process.env.PANINI_E2E_URL ?? "http://127.0.0.1:4149";
const token = process.env.PANINI_E2E_BOOTSTRAP_TOKEN;

if (!token)
	throw new Error(
		"PANINI_E2E_BOOTSTRAP_TOKEN is required for the disposable installation.",
	);
if (!["localhost", "127.0.0.1"].includes(new URL(base).hostname))
	throw new Error("This fixture only runs against loopback.");

const output = resolve(process.env.PANINI_E2E_OUTPUT ?? ".panini/e2e");

await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
	viewport: { width: 1440, height: 1000 },
});
const page = await context.newPage();
const errors = [];
const checks = [];

page.on("pageerror", (error) => errors.push(error.message));

const password = "Browser test passphrase with 47 stars!";

try {
	await page.goto(`${base}/app/projects`);
	await page.waitForURL("**/setup**");
	await page.getByLabel("Installation secret").fill(token);
	await page
		.getByLabel("Company name", { exact: true })
		.fill("Browser Test Company");
	await page.getByLabel("Your name", { exact: true }).fill("Browser Owner");
	await page
		.getByLabel("Email", { exact: true })
		.fill("browser-owner@example.test");
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page
		.getByRole("button", { name: "Create workspace", exact: true })
		.click();
	await page.waitForURL("**/app/onboarding");
	await page
		.getByRole("heading", { name: "Welcome to Browser Test Company" })
		.waitFor();
	checks.push("First owner creates a company and reaches onboarding.");
	await page.screenshot({
		path: resolve(output, "onboarding-desktop.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page
		.getByRole("button", { name: "Finish setup", exact: true })
		.click();
	await page.waitForURL("**/app/projects");
	await page.getByRole("link", { name: "Tasks", exact: true }).click();
	await page.waitForURL("**/app/tasks");
	await page.reload();
	await page.getByRole("heading", { name: "Tasks", exact: true }).waitFor();
	checks.push("Session survives reload and a direct workspace route.");
	await page.goto(`${base}/app/settings`);
	await page.locator("#profile-name").fill("Updated Browser Owner");
	await page
		.getByRole("button", { name: "Save profile", exact: true })
		.click();
	await page.getByText("Profile saved.", { exact: true }).waitFor();
	await page
		.getByLabel("Company name", { exact: true })
		.fill("Renamed Browser Company");
	await page
		.getByRole("button", { name: "Save company", exact: true })
		.click();
	await page.getByText("Company saved.", { exact: true }).waitFor();
	await page.reload();
	await page.waitForFunction(
		() =>
			document.querySelector("#profile-name")?.value ===
			"Updated Browser Owner",
	);
	assert.equal(
		await page.locator("#profile-name").inputValue(),
		"Updated Browser Owner",
	);
	assert.equal(
		await page.getByLabel("Company name", { exact: true }).inputValue(),
		"Renamed Browser Company",
	);
	checks.push("User and company settings persist after reload.");
	await page.screenshot({
		path: resolve(output, "settings-desktop.png"),
		fullPage: true,
		animations: "disabled",
	});
	await page.goto(`${base}/app/agents`);
	await page
		.getByRole("button", { name: "Create agent", exact: true })
		.click();
	await page.getByLabel("Agent name", { exact: true }).fill("Browser Agent");
	await page
		.getByLabel("Harness", { exact: true })
		.selectOption("generic_mcp");
	await page
		.getByRole("button", { name: "Create and connect", exact: true })
		.click();
	await page
		.getByText("One-time enrollment secret", { exact: true })
		.waitFor();
	checks.push(
		"Agent enrollment displays a one-time secret and connection instructions.",
	);
	await page
		.getByRole("button", { name: "Check connection", exact: true })
		.click();
	await page
		.getByText(
			"No connection yet. Add the server in your client, then try again.",
			{ exact: true },
		)
		.waitFor();

	const agentSecret = await page.locator(".secret-panel code").textContent();
	const mcp = await fetch(`${base}/mcp`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${agentSecret}`,
			accept: "application/json, text/event-stream",
			"content-type": "application/json",
			"mcp-protocol-version": "2025-03-26",
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "tools/list",
			params: {},
		}),
	});

	assert.equal(mcp.status, 200);
	await mcp.text();
	await page
		.getByRole("button", { name: "Check connection", exact: true })
		.click();
	await page
		.locator("#agent-connection-status")
		.filter({ hasText: "Connected. Last authenticated request:" })
		.waitFor();
	checks.push(
		"Connection status remains unconnected until a real authenticated MCP request succeeds.",
	);
	// Never screenshot the secret-bearing enrollment dialog.
	await page.keyboard.press("Escape");
	await page.goto(`${base}/app/settings`);
	await page
		.getByLabel("Invite email", { exact: true })
		.fill("browser-member@example.test");
	await page
		.getByRole("button", { name: "Create invitation", exact: true })
		.click();

	const invite = page.getByLabel("Invitation link", { exact: true });

	await invite.waitFor();

	const inviteUrl = await invite.inputValue();
	const teammate = await browser.newContext({
		viewport: { width: 390, height: 844 },
	});
	const join = await teammate.newPage();

	await join.goto(inviteUrl);
	await join.getByLabel("Your name", { exact: true }).fill("Browser Member");
	await join.getByLabel("Password", { exact: true }).fill(password);
	await join
		.getByRole("button", { name: "Join workspace", exact: true })
		.click();
	await join.waitForURL("**/app/onboarding");
	await join
		.getByRole("button", { name: "Finish setup", exact: true })
		.click();
	await join.waitForURL("**/app/projects");
	await join.screenshot({
		path: resolve(output, "member-mobile.png"),
		fullPage: true,
		animations: "disabled",
	});
	assert.equal(
		await join.evaluate(
			() => document.documentElement.scrollWidth <= window.innerWidth,
		),
		true,
	);
	checks.push(
		"A teammate accepts an invitation and completes onboarding on mobile.",
	);
	await teammate.close();
	await page.getByRole("button", { name: "Sign out", exact: true }).click();
	await page.waitForURL("**/login**");
	await page.goto(`${base}/app/context`);
	await page.waitForURL("**/login**");
	await page
		.getByLabel("Email", { exact: true })
		.fill("browser-owner@example.test");
	await page
		.getByLabel("Password", { exact: true })
		.fill("This is the wrong password");
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page
		.getByRole("alert")
		.filter({ hasText: "Email or password is incorrect." })
		.waitFor();
	await page.getByLabel("Password", { exact: true }).fill(password);
	await page.getByRole("button", { name: "Sign in", exact: true }).click();
	await page.waitForURL("**/app/context");
	checks.push(
		"Logout protects direct URLs; rejected login shows an error; valid login returns to the requested page.",
	);
	assert.deepEqual(errors, []);
	await writeFile(
		resolve(output, "browser-results.json"),
		JSON.stringify(
			{
				passed: true,
				base,
				checks,
				errors,
				timestamp: new Date().toISOString(),
			},
			null,
			2,
		),
	);
	console.log(JSON.stringify({ passed: true, checks, output }, null, 2));
} catch (error) {
	await writeFile(
		resolve(output, "browser-results.json"),
		JSON.stringify(
			{ passed: false, checks, errors, failure: error.message },
			null,
			2,
		),
	);
	throw error;
} finally {
	await browser.close();
}
