import { ReplayVerifier } from "./verifier.js";
import { createPaniniCore } from "../runtime/core.js";

const { store } = await createPaniniCore({ runMigrations: false });

try {
	const result = await new ReplayVerifier(store).verify();

	console.log(JSON.stringify(result, null, 2));
	if (!result.ok) process.exitCode = 1;
} finally {
	await store.close();
}
