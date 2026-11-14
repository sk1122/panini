import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/*
 * The web app's browser code lives in src/client/*.ts. `pnpm build` compiles it
 * with tsconfig.client.json into dist/client/app.js, which the app shell inlines
 * with its CSP nonce.
 */
function loadAppScript(): string {
	const candidates = [
		// Running from dist/src/http.
		new URL("../../client/app.js", import.meta.url),
		// Running from src/http (tests and tsx).
		new URL("../../dist/client/app.js", import.meta.url),
	].map((url) => fileURLToPath(url));
	const found = candidates.find((path) => existsSync(path));

	if (!found)
		throw new Error(
			"The web app script is not built. Run `pnpm build` (it compiles src/client).",
		);
	return readFileSync(found, "utf8");
}

export const appScript = loadAppScript();
