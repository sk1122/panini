import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, afterEach } from "vitest";
import { migrate } from "../../src/db/migrate.js";
import { PostgresLedgerStore } from "../../src/store/postgres.js";

/*
 * Tests run on real PostgreSQL. Each store gets its own company, so a test sees
 * an empty workspace, and every store is closed after its test.
 */

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 21).toString("base64");
const open: PostgresLedgerStore[] = [];
const organizations: string[] = [];
let ready: Promise<pg.Pool> | null = null;

function admin(): Promise<pg.Pool> {
	ready ??= (async () => {
		if (!databaseUrl?.includes("panini_e2e"))
			throw new Error(
				"Set PANINI_TEST_DATABASE_URL to a disposable panini_e2e database.",
			);
		await migrate(databaseUrl);
		return new pg.Pool({ connectionString: databaseUrl, max: 2 });
	})();
	return ready;
}

export async function testStore(companyName = "Test Company") {
	const pool = await admin();
	const id = randomUUID();

	await pool.query(
		"INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
		[id, `test-${id}`, companyName],
	);
	// Like a fresh install before setup: one local administrator who owns the company.
	await pool.query(
		`INSERT INTO members (id,organization_id,subject,display_name,role,status)
     VALUES ($1,$2,'bootstrap:local-admin','Local administrator','owner','active')`,
		[randomUUID(), id],
	);
	organizations.push(id);

	const store = new PostgresLedgerStore(databaseUrl!, key, id, {
		backfillLegacyContent: false,
	});
	const close = store.close.bind(store);
	let closed = false;

	// Some tests close their own store; closing twice must be harmless.
	store.close = async () => {
		if (closed) return;
		closed = true;
		await close();
	};
	open.push(store);
	return store;
}

afterEach(async () => {
	await Promise.all(open.splice(0).map((store) => store.close()));
});

afterAll(async () => {
	if (!ready) return;

	const pool = await ready;

	for (const id of organizations.splice(0)) {
		await pool
			.query(
				"DELETE FROM evidence_dependencies WHERE organization_id=$1",
				[id],
			)
			.catch(() => undefined);
		await pool
			.query("DELETE FROM organizations WHERE id=$1", [id])
			.catch(() => undefined);
	}
	await pool.end();
	ready = null;
});

/** The local administrator seeded for a test store. */
export async function localAdminId(
	store: PostgresLedgerStore,
): Promise<string> {
	const member = (await store.listMembers()).find(
		(item) => item.subject === "bootstrap:local-admin",
	);

	if (!member) throw new Error("Test store has no local administrator.");
	return member.id;
}
