// Failure cases: task scope absent from UI, stale assessment shown as accepted,
// inferred evidence presented as verification, broken source access, mobile overflow.
import { recordOntologyDemo } from "./record-ontology-demo.mjs";
import assert from "node:assert/strict";
import path from "node:path";
import { chromium } from "playwright";

export async function verifyOntologyBrowser({
	origin,
	email,
	password,
	taskId,
	output,
	token,
}) {
	const response = await fetch(`${origin}/api/work-model?taskId=${taskId}`, {
		headers: { authorization: `Bearer ${token}` },
	});

	assert.equal(response.status, 200);

	const model = await response.json();

	assert.ok(model.scope?.requiredSteps.length);
	assert.ok(model.evidence.length);

	const browser = await chromium.launch({ headless: true });
	const context = await browser.newContext({
		viewport: { width: 1440, height: 1000 },
	});
	const page = await context.newPage();
	const errors = [];

	page.on("pageerror", (error) => errors.push(error.message));
	try {
		await page.goto(`${origin}/app/tasks`);
		await page.getByLabel("Email", { exact: true }).fill(email);
		await page.getByLabel("Password", { exact: true }).fill(password);
		await page
			.getByRole("button", { name: "Sign in", exact: true })
			.click();
		await page.waitForURL("**/app/**");

		const finish = page.getByRole("button", {
			name: "Finish setup",
			exact: true,
		});

		if (await finish.isVisible()) await finish.click();
		await page.getByRole("link", { name: "Tasks", exact: true }).click();
		await page.waitForURL("**/app/tasks");
		await page.locator(`[data-task="${taskId}"]`).first().click();

		const dialog = page.locator("#task-detail-dialog");

		await dialog
			.getByRole("heading", { name: "Requested work", exact: true })
			.waitFor();
		for (const step of model.scope.requiredSteps)
			await dialog
				.getByText(step.description, { exact: true })
				.first()
				.waitFor();
		await dialog
			.getByText(
				"Inferred scope. A scope change needs verified authority.",
				{ exact: true },
			)
			.waitFor();
		await dialog
			.getByRole("heading", { name: "Attempts and outputs", exact: true })
			.waitFor();
		await dialog
			.getByText(model.evidence[0].entity.name, { exact: true })
			.first()
			.waitFor();
		assert.ok((await dialog.innerText()).includes("Source report"));
		await page.screenshot({
			path: path.join(output, "ontology-task-desktop.png"),
			fullPage: true,
		});
		await page.setViewportSize({ width: 390, height: 844 });
		assert.equal(
			await page.evaluate(
				() => document.documentElement.scrollWidth <= innerWidth,
			),
			true,
		);
		assert.equal(
			await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
			true,
		);
		await page.screenshot({
			path: path.join(output, "ontology-task-mobile.png"),
			fullPage: true,
		});
		await page.setViewportSize({ width: 1440, height: 1000 });
		await dialog
			.getByRole("button", { name: "Read source", exact: true })
			.first()
			.click();
		await page
			.locator("#evidence-detail-body .evidence-detail-content")
			.waitFor();
		assert.deepEqual(errors, []);
		if (process.env.PANINI_RECORD_DEMO === "1") {
			await recordOntologyDemo({
				browser,
				storageState: await context.storageState(),
				origin,
				taskId,
				directory: path.resolve(".panini/release/demo"),
			});
		}

		return [
			"Task shows native inferred scope and linked attempts",
			"Source reports remain distinct from verification",
			"Task source opens in evidence reader",
			"Desktop and mobile task detail fit the viewport",
		];
	} catch (error) {
		await page.screenshot({
			path: path.join(output, "ontology-browser-failure.png"),
			fullPage: true,
		});
		throw error;
	} finally {
		await browser.close();
	}
}
