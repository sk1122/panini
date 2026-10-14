import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { contentHash } from "../domain/content-hash.js";

const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.PANINI_RESTORE_EXPECTED_DATABASE;
const phase = process.env.PANINI_RESTORE_PHASE;
const reportPath = process.env.PANINI_RESTORE_SNAPSHOT_REPORT;
const dumpPath = process.env.PANINI_RESTORE_DUMP_PATH;
const maxRows = Number(process.env.PANINI_RESTORE_MAX_ROWS_PER_TABLE ?? "1000000");
if (!databaseUrl || !expectedDatabase || !/^panini_(?:replay|restore)_[a-z0-9_]+$/.test(expectedDatabase)
  || !["before", "restored"].includes(phase ?? "") || !reportPath || !dumpPath
  || !Number.isSafeInteger(maxRows) || maxRows < 1) {
  throw new Error("Restore snapshot requires an isolated database, phase, dump, report, and finite row cap.");
}
const artifactRoot = path.resolve("artifacts/evidence-state");
const artifactBase = path.resolve("artifacts");
const output = path.resolve(reportPath);
const dump = path.resolve(dumpPath);
if (!output.startsWith(`${artifactRoot}${path.sep}`) || !output.endsWith(".json")
  || !(dump.startsWith(`${artifactBase}${path.sep}`) || dump.startsWith("/private/tmp/"))) {
  throw new Error("Restore artifacts must stay under artifacts/evidence-state or private tmp.");
}
const dumpHash = createHash("sha256");
for await (const chunk of createReadStream(dump)) dumpHash.update(chunk);
const dumpSha256 = dumpHash.digest("hex");
const pool = new pg.Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
  const database = (await client.query<{ name: string }>("SELECT current_database() AS name"))
    .rows[0]?.name;
  if (database !== expectedDatabase) throw new Error("Restore snapshot database assertion failed.");
  const tables = (await client.query<{ table_schema: string; table_name: string }>(
    `SELECT table_schema,table_name FROM information_schema.tables
      WHERE table_schema IN ('public','drizzle') AND table_type='BASE TABLE'
      ORDER BY table_schema,table_name`,
  )).rows;
  if (tables.length === 0) throw new Error("Restore snapshot contains no application tables.");
  const results: Record<string, { rows: number; hash: string }> = {};
  for (const table of tables) {
    const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
    const identifier = `${quoted(table.table_schema)}.${quoted(table.table_name)}`;
    const key = `${table.table_schema}.${table.table_name}`;
    const count = Number((await client.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM ${identifier}`)).rows[0]?.count ?? -1);
    if (!Number.isSafeInteger(count) || count < 0 || count > maxRows) {
      throw new Error(`Restore snapshot row cap exceeded in ${key}.`);
    }
    const rows = (await client.query<{ row: unknown }>(
      `SELECT to_jsonb(t) AS row FROM ${identifier} t`)).rows;
    if (rows.length !== count) throw new Error(`Restore snapshot changed while reading ${key}.`);
    results[key] = { rows: count,
      hash: contentHash(rows.map((row) => contentHash(row.row)).sort()) };
  }
  const organizationIds = (await client.query<{ id: string }>(
    "SELECT id FROM public.organizations ORDER BY id")).rows.map((row) => row.id);
  const columns = (await client.query(
    `SELECT table_schema,table_name,column_name,ordinal_position,data_type,udt_name,
        is_nullable,column_default
       FROM information_schema.columns WHERE table_schema IN ('public','drizzle')
       ORDER BY table_schema,table_name,ordinal_position`,
  )).rows;
  const indexes = (await client.query(
    `SELECT schemaname,tablename,indexname,indexdef FROM pg_indexes
       WHERE schemaname IN ('public','drizzle') ORDER BY schemaname,tablename,indexname`,
  )).rows;
  const constraints = (await client.query(
    `SELECT n.nspname AS schema_name,t.relname AS table_name,c.conname AS name,
        pg_get_constraintdef(c.oid) AS definition
       FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid
       JOIN pg_namespace n ON n.oid=t.relnamespace
       WHERE n.nspname IN ('public','drizzle')
       ORDER BY n.nspname,t.relname,c.conname`,
  )).rows;
  await client.query("COMMIT");
  const report = { schemaVersion: 1, phase, generatedAt: new Date().toISOString(),
    database, organizationIds, dumpSha256, tables: results,
    tableCount: tables.length, fingerprint: contentHash(results),
    schemaFingerprint: contentHash({ columns, indexes, constraints }),
    privateContentExported: false, modelCalls: 0 };
  await mkdir(path.dirname(output), { recursive: true });
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, output);
  process.stdout.write(`${JSON.stringify({ report: output, database,
    phase, tables: report.tableCount, fingerprint: report.fingerprint })}\n`);
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  throw error;
} finally { client.release(); await pool.end(); }
