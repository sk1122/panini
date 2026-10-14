import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { ReplayVerifier } from "../replay/verifier.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const key = process.env.CONTENT_ENCRYPTION_KEY;
const expectedDatabase = process.env.PANINI_REPLAY_DATABASE;
const outputPath = process.env.PANINI_ACCEPTED_REBUILD_REPORT;
if (!databaseUrl || !key || !expectedDatabase || !outputPath
  || !/^panini_replay_[a-z0-9_]+$/.test(expectedDatabase)) {
  throw new Error("Accepted rebuild reporting requires an asserted isolated replay database and report path.");
}
const root = path.resolve("artifacts/evidence-state");
const output = path.resolve(outputPath);
if (!output.startsWith(`${root}${path.sep}`) || !output.endsWith(".json")) {
  throw new Error("Accepted rebuild report must be JSON under artifacts/evidence-state.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, key, undefined,
  { backfillLegacyContent: false });
try {
  const database = (await pool.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Accepted rebuild database assertion failed.");
  const organization = await store.getOrganization();
  const verification = await new ReplayVerifier(store).verify();
  const report = { schemaVersion: 1, mode: "accepted_rebuild", generatedAt: new Date().toISOString(),
    database, organizationId: organization.id, modelCalls: 0,
    applied: false, acceptedStateChanged: false,
    projection: verification,
    gaps: verification.legacyLinkIdsWithoutRevision.length > 0
      ? ["legacy_links_without_revision"] : [],
    stopReason: verification.ok ? "projection_matches_revisions" : "projection_mismatch_or_missing_history" };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(`${JSON.stringify({ report: output, database, organizationId: organization.id,
    stopReason: report.stopReason })}\n`);
  if (!verification.ok) process.exitCode = 1;
} finally {
  await store.close();
  await pool.end();
}
