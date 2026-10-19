import pg from "pg";
import { PostgresLedgerStore } from "../store/postgres.js";
import { GPT6_LUNA_PRICE_2026_10_01 } from "../intelligence/model-price.js";
import { VOYAGE4_PRICE_2026_10_02 } from "../intelligence/voyage-work-embeddings.js";

const databaseUrl = process.env.DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
const expectedDatabase = process.env.PANINI_EVIDENCE_BUDGET_DATABASE;
const deadline = process.env.PANINI_EVIDENCE_BUDGET_DEADLINE;
const maxUsd = process.env.PANINI_EVIDENCE_BUDGET_MAX_USD;

const positiveInt = (name: string) => {
	const value = Number(process.env[name]);

	if (!Number.isSafeInteger(value) || value < 1)
		throw new Error(`${name} must be a positive integer.`);
	return value;
};

if (
	!databaseUrl ||
	!contentKey ||
	!expectedDatabase ||
	!/^[a-z][a-z0-9_]*$/.test(expectedDatabase) ||
	!deadline ||
	!Number.isFinite(Date.parse(deadline)) ||
	Date.parse(deadline) <= Date.now() ||
	!maxUsd ||
	!/^\d+(?:\.\d{1,8})?$/.test(maxUsd) ||
	Number(maxUsd) <= 0
) {
	throw new Error(
		"An asserted database, content key, future deadline, and positive USD cap are required.",
	);
}

const pool = new pg.Pool({ connectionString: databaseUrl });
let store: PostgresLedgerStore | null = null;

try {
	const actual = (
		await pool.query<{ current_database: string }>(
			"SELECT current_database()",
		)
	).rows[0]?.current_database;

	if (actual !== expectedDatabase)
		throw new Error("Evidence budget database assertion failed.");
	store = new PostgresLedgerStore(databaseUrl, contentKey);

	const organization = await store.getOrganization();
	const budget = await store.createInferenceBudget({
		label:
			process.env.PANINI_EVIDENCE_BUDGET_LABEL ||
			`evidence-v2:${new Date().toISOString()}`,
		maxCalls: positiveInt("PANINI_EVIDENCE_BUDGET_MAX_CALLS"),
		maxInputTokens: positiveInt("PANINI_EVIDENCE_BUDGET_MAX_INPUT_TOKENS"),
		maxOutputTokens: positiveInt(
			"PANINI_EVIDENCE_BUDGET_MAX_OUTPUT_TOKENS",
		),
		maxUsd,
		deadline,
		priceBasis: {
			models: [
				{ ...GPT6_LUNA_PRICE_2026_10_01 },
				{ ...VOYAGE4_PRICE_2026_10_02 },
			],
		},
	});

	process.stdout.write(
		`${JSON.stringify({
			database: actual,
			organizationId: organization.id,
			budgetId: budget.id,
			deadline: budget.deadline,
			maxCalls: budget.maxCalls,
			maxInputTokens: budget.maxInputTokens,
			maxOutputTokens: budget.maxOutputTokens,
			maxUsd: budget.maxUsd,
		})}\n`,
	);
} finally {
	await store?.close();
	await pool.end();
}
