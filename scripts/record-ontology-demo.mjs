// Records a real local browser session. Labels stay visible because model responses
// come from the process fixture, not live providers. Credentials never enter frames.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export async function recordOntologyDemo({
	browser,
	storageState,
	origin,
	taskId,
	directory,
}) {
	await mkdir(directory, { recursive: true });

	const context = await browser.newContext({
		storageState,
		viewport: { width: 1600, height: 900 },
		recordVideo: { dir: directory, size: { width: 1600, height: 900 } },
	});
	const page = await context.newPage();
	const scenes = [];
	const started = Date.now();

	const scene = async (caption, seconds) => {
		await page.evaluate((text) => {
			document
				.querySelectorAll("[data-demo-caption]")
				.forEach((el) => el.remove());

			const host =
				document.querySelector("dialog[open]") || document.body;

			for (const [position, content] of [
				["top", "PANINI · LOCAL DEMO · SIMULATED MODEL RESPONSES"],
				["bottom", text],
			]) {
				const el = document.createElement("div");

				el.dataset.demoCaption = position;
				el.textContent = content;
				el.style.cssText =
					"position:fixed;z-index:99999;pointer-events:none;left:50%;transform:translateX(-50%);max-width:90vw;padding:12px 24px;border:1px solid #dad8d1;border-radius:8px;background:#fffefa;color:#161a22;font:600 " +
					(position === "top" ? "16" : "24") +
					"px/1.4 system-ui;text-align:center;box-shadow:0 2px 12px #0002;" +
					position +
					":14px";
				host.append(el);
			}
		}, caption);

		const start = (Date.now() - started) / 1000;

		await page.waitForTimeout(seconds * 1000);
		scenes.push({ start, end: (Date.now() - started) / 1000, caption });
	};

	try {
		await page.goto(`${origin}/app/tasks`);
		await page
			.getByRole("heading", { name: "Tasks", exact: true })
			.waitFor();
		await scene("Work needs context, not just a status.", 6);
		await page.locator(`[data-task="${taskId}"]:visible`).first().click();

		const dialog = page.locator("#task-detail-dialog");

		await dialog
			.getByRole("heading", { name: "Requested work", exact: true })
			.waitFor();
		await scene(
			"Keep the original requirements visible as work changes.",
			10,
		);
		await dialog
			.locator(".work-requirements details")
			.first()
			.getByText("Scope evidence", { exact: true })
			.click();
		await scene("Each requirement retains its supporting source text.", 8);
		await dialog
			.getByRole("heading", { name: "Attempts and outputs", exact: true })
			.scrollIntoViewIfNeeded();
		await scene(
			"The exporter was built. Delivery is still unresolved.",
			10,
		);
		await dialog
			.getByRole("button", { name: "Read source", exact: true })
			.first()
			.click();
		await page
			.locator("#evidence-detail-body .evidence-detail-content")
			.waitFor();
		await scene("Read the source before treating a report as proof.", 8);
		await page
			.locator('#evidence-dialog [data-close="evidence-dialog"]')
			.click();
		await page.getByRole("link", { name: "Context", exact: true }).click();
		await page
			.getByRole("heading", { name: "Context", exact: true })
			.waitFor();
		await page.locator("#context-tree [data-entry]").first().click();
		await page
			.locator("#context-preview .knowledge-change")
			.first()
			.waitFor();
		await scene(
			"Keep shared context and its change history in one workspace.",
			8,
		);
		await page.getByRole("link", { name: "Agents", exact: true }).click();
		await page
			.getByRole("heading", { name: "Release demo agent", exact: true })
			.waitFor();
		await scene(
			"An enrolled agent reads the same work through scoped MCP access.",
			8,
		);
		await page.goto(`${origin}/`);
		await scene(
			"Panini is open source. Start at github.com/sk1122/panini",
			7,
		);
		await writeFile(
			path.join(directory, "scenes.json"),
			JSON.stringify(
				{ fixture: true, externalProviderCalls: 0, scenes },
				null,
				4,
			) + "\n",
		);

		const stamp = (seconds) => {
			const ms = Math.round(seconds * 1000);

			return `${String(Math.floor(ms / 3600000)).padStart(2, "0")}:${String(Math.floor(ms / 60000) % 60).padStart(2, "0")}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")},${String(ms % 1000).padStart(3, "0")}`;
		};

		await writeFile(
			path.join(directory, "panini-demo.srt"),
			scenes
				.map(
					(s, i) =>
						`${i + 1}\n${stamp(s.start)} --> ${stamp(s.end)}\n${s.caption}\n`,
				)
				.join("\n"),
		);
	} finally {
		const video = page.video();

		await context.close();
		if (video) await video.saveAs(path.join(directory, "panini-demo.webm"));
	}
}
