import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";

const databaseUrl = process.env.DATABASE_URL;
const databaseName = process.env.PANINI_REPLAY_DATABASE;
const organizationId = process.env.PANINI_REPLAY_ORGANIZATION;
const outputPath = process.env.PANINI_CONTRACT_REPORT;
if (!databaseUrl || !databaseName || !/^panini_replay_[a-z0-9_]+$/.test(databaseName)
  || !organizationId || !/^[0-9a-f-]{36}$/i.test(organizationId) || !outputPath) {
  throw new Error("An isolated replay database, organization, and output path are required.");
}
const root = path.resolve("artifacts/evidence-state");
const output = path.resolve(outputPath);
if (!output.startsWith(`${root}${path.sep}`) || !output.endsWith(".json")) {
  throw new Error("Contract report must be JSON under artifacts/evidence-state.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const database = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (database !== databaseName) throw new Error("Contract audit database assertion failed.");
  const rows = (await pool.query<{ id: string; title: string; status: string;
    version: number; contract: unknown; result: string | null }>(
    `SELECT id,document->>'title' AS title,document->>'status' AS status,version,
       document->'outcomeContract' AS contract,document->>'result' AS result
     FROM tasks WHERE organization_id=$1 ORDER BY id`, [organizationId],
  )).rows;
  const unknown = rows.filter((row) => !row.contract || row.contract === "null");
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
    database, organizationId, totalTasks: rows.length, acceptedContracts: rows.length - unknown.length,
    legacyUnknownContracts: unknown.length, proposedContractsAwaitingAcceptance: 0,
    interpretation: "Legacy descriptions are context, not accepted criteria. No contracts were generated or accepted by this audit.",
    tasks: rows.map((row) => ({ taskId: row.id, title: row.title, status: row.status,
      version: row.version, contractState: row.contract ? "accepted" : "unknown",
      result: row.result ?? "unknown" })) };
  await mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temp, output);
  console.log(JSON.stringify({ report: output, totalTasks: report.totalTasks,
    legacyUnknownContracts: report.legacyUnknownContracts }));
} finally { await pool.end(); }
