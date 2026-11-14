import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { migrate } from "../db/migrate.js";
import { ProposalPolicy } from "../domain/policy.js";
import { TeamLedger } from "../domain/team-ledger.js";
import { seedDemoCompany } from "../demo/seed.js";
import { IdentityService } from "../security/identity.js";
import {
	DEFAULT_ORGANIZATION_ID,
	PostgresLedgerStore,
} from "../store/postgres.js";

interface QuickstartState {
	contentEncryptionKey: string;
	adminToken: string;
	databasePassword: string;
	databasePort: number;
	appPort: number;
	ownerEmail: string;
	ownerPassword: string;
}

const packageRoot = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);

function flag(name: string): string | null {
	const index = process.argv.indexOf(name);

	return index === -1 ? null : (process.argv[index + 1] ?? null);
}

async function loadState(file: string): Promise<{
	state: QuickstartState;
	created: boolean;
}> {
	if (existsSync(file))
		return {
			state: JSON.parse(await readFile(file, "utf8")) as QuickstartState,
			created: false,
		};

	const state: QuickstartState = {
		contentEncryptionKey: randomBytes(32).toString("base64"),
		adminToken: `panini_admin_${randomBytes(24).toString("base64url")}`,
		databasePassword: randomBytes(18).toString("base64url"),
		databasePort: Number(flag("--db-port") ?? 54329),
		appPort: Number(flag("--port") ?? 4141),
		ownerEmail: "you@panini.local",
		ownerPassword: randomBytes(12).toString("base64url"),
	};

	await writeFile(file, JSON.stringify(state, null, 2), { mode: 0o600 });
	await chmod(file, 0o600);
	return { state, created: true };
}

/** Start a private PostgreSQL under the quickstart folder and make sure the database exists. */
async function startEmbedded(home: string, state: QuickstartState) {
	const { default: EmbeddedPostgres } =
		await import("embedded-postgres").catch(() => {
			throw new Error(
				"The quickstart needs the optional embedded-postgres package. Use --database-url, or `panini selfhost` for Docker.",
			);
		});
	const databaseDir = join(home, "postgres");
	const database = new EmbeddedPostgres({
		databaseDir,
		port: state.databasePort,
		user: "panini",
		password: state.databasePassword,
		persistent: true,
		onLog: () => undefined,
		onError: (error: unknown) => {
			if (process.env.PANINI_DEBUG) console.error(error);
		},
	});

	if (!existsSync(join(databaseDir, "PG_VERSION")))
		await database.initialise();
	await database.start();

	const admin = new pg.Client({
		connectionString: `postgres://panini:${encodeURIComponent(state.databasePassword)}@127.0.0.1:${state.databasePort}/postgres`,
	});

	await admin.connect();
	if (
		!(await admin.query("SELECT 1 FROM pg_database WHERE datname='panini'"))
			.rowCount
	)
		await admin.query("CREATE DATABASE panini");
	await admin.end();
	return database;
}

async function main() {
	const home = resolve(
		flag("--directory") ?? join(process.cwd(), ".panini", "quickstart"),
	);

	await mkdir(home, { recursive: true, mode: 0o700 });

	const { state, created } = await loadState(join(home, "state.json"));
	const external = flag("--database-url");
	const database = external ? null : await startEmbedded(home, state);
	const databaseUrl =
		external ??
		`postgres://panini:${encodeURIComponent(state.databasePassword)}@127.0.0.1:${state.databasePort}/panini`;

	await migrate(databaseUrl);

	const identity = new IdentityService(databaseUrl, DEFAULT_ORGANIZATION_ID);
	let seededTasks = 0;

	try {
		if (!(await identity.isConfigured())) {
			const grant = await identity.bootstrap({
				email: state.ownerEmail,
				displayName: "You",
				password: state.ownerPassword,
				companyName: process.argv.includes("--empty")
					? "My Company"
					: "Demo Company",
			});

			if (!process.argv.includes("--empty")) {
				const store = new PostgresLedgerStore(
					databaseUrl,
					state.contentEncryptionKey,
				);

				try {
					const ledger = new TeamLedger(
						store,
						new ProposalPolicy({
							mode: "manual_review",
							autoApproveNewTasks: false,
							autoApproveContext: false,
							requireReviewForTaskChanges: true,
						}),
					);

					seededTasks = (
						await seedDemoCompany(ledger, grant.session.member)
					).tasks;
				} finally {
					await store.close();
				}
			}
		}
	} finally {
		await identity.close();
	}

	const url = `http://127.0.0.1:${state.appPort}`;
	const server = spawn(
		process.execPath,
		[join(packageRoot, "dist", "src", "main.js")],
		{
			stdio: ["ignore", "ignore", "inherit"],
			env: {
				...process.env,
				NODE_ENV: "production",
				HOST: "127.0.0.1",
				PORT: String(state.appPort),
				PANINI_PUBLIC_URL: url,
				DATABASE_URL: databaseUrl,
				CONTENT_ENCRYPTION_KEY: state.contentEncryptionKey,
				APP_ADMIN_TOKEN: state.adminToken,
				APP_CONFIG_PATH: join(
					packageRoot,
					"config",
					"panini.selfhost.yaml",
				),
				AUTO_MIGRATE: "false",
				LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
			},
		},
	);

	console.log(`\nPanini is running at ${url}/app/home`);
	if (created) {
		console.log(
			`Sign in as ${state.ownerEmail} with password ${state.ownerPassword}`,
		);
		console.log(
			`(also saved in ${join(home, "state.json")}; change it in Settings)`,
		);
	} else console.log(`Sign-in details are in ${join(home, "state.json")}`);
	if (seededTasks)
		console.log(
			`Loaded a demo company with ${seededTasks} tasks and two agents.`,
		);
	console.log(`Connect an agent: npx panini-work connect --url ${url}`);
	console.log("Stop with Ctrl+C. Your data stays in", home);

	const stop = async () => {
		server.kill("SIGTERM");
		await database?.stop().catch(() => undefined);
		process.exit(0);
	};

	process.once("SIGINT", () => void stop());
	process.once("SIGTERM", () => void stop());
	server.once("exit", async (code) => {
		await database?.stop().catch(() => undefined);
		process.exit(code ?? 0);
	});
}

await main();
