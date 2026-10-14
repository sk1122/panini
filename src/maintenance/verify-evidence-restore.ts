import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";

const root = path.resolve("artifacts/evidence-state");
function checked(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error(`${name} must be JSON under artifacts/evidence-state.`);
  }
  return resolved;
}
const beforePath = checked("PANINI_RESTORE_BEFORE_REPORT");
const restoredPath = checked("PANINI_RESTORE_AFTER_REPORT");
const upgradedPath = checked("PANINI_RESTORE_UPGRADED_REPORT");
const repeatedPath = checked("PANINI_RESTORE_REPEATED_REPORT");
const output = checked("PANINI_ROLLBACK_REPORT");
if (new Set([beforePath, restoredPath, upgradedPath, repeatedPath, output]).size !== 5) {
  throw new Error("Restore input and output reports must differ.");
}
const snapshotSchema = z.strictObject({ schemaVersion: z.literal(1),
  phase: z.enum(["before", "restored"]), generatedAt: z.iso.datetime(),
  database: z.string().regex(/^panini_(?:replay|restore)_[a-z0-9_]+$/),
  organizationIds: z.array(z.uuid()), dumpSha256: z.string().regex(/^[0-9a-f]{64}$/),
  tables: z.record(z.string(), z.strictObject({ rows: z.number().int().nonnegative(),
    hash: z.string().regex(/^[0-9a-f]{64}$/) })),
  tableCount: z.number().int().positive(), fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  schemaFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  privateContentExported: z.literal(false), modelCalls: z.literal(0) });
const before = snapshotSchema.parse(JSON.parse(await readFile(beforePath, "utf8")));
const restored = snapshotSchema.parse(JSON.parse(await readFile(restoredPath, "utf8")));
const upgraded = snapshotSchema.parse(JSON.parse(await readFile(upgradedPath, "utf8")));
const repeated = snapshotSchema.parse(JSON.parse(await readFile(repeatedPath, "utf8")));
if (before.phase !== "before" || restored.phase !== "restored"
  || upgraded.phase !== "restored" || repeated.phase !== "restored"
  || before.database === restored.database || before.dumpSha256 !== restored.dumpSha256
  || upgraded.database !== before.database || repeated.database !== before.database
  || upgraded.dumpSha256 !== before.dumpSha256 || repeated.dumpSha256 !== before.dumpSha256
  || before.generatedAt > upgraded.generatedAt || upgraded.generatedAt > repeated.generatedAt
  || contentHash(before.tables) !== before.fingerprint
  || contentHash(restored.tables) !== restored.fingerprint
  || contentHash(upgraded.tables) !== upgraded.fingerprint
  || contentHash(repeated.tables) !== repeated.fingerprint
  || Object.keys(before.tables).length !== before.tableCount
  || Object.keys(restored.tables).length !== restored.tableCount
  || Object.keys(upgraded.tables).length !== upgraded.tableCount
  || Object.keys(repeated.tables).length !== repeated.tableCount) {
  throw new Error("Restore reports are not a matched pair from one pre-change dump.");
}
const beforeTables = new Set(Object.keys(before.tables));
const restoredTables = new Set(Object.keys(restored.tables));
const missingTables = [...beforeTables].filter((table) => !restoredTables.has(table)).sort();
const extraTables = [...restoredTables].filter((table) => !beforeTables.has(table)).sort();
const changedTables = [...beforeTables].filter((table) =>
  restoredTables.has(table)
    && (before.tables[table]!.hash !== restored.tables[table]!.hash
      || before.tables[table]!.rows !== restored.tables[table]!.rows)).sort();
const organizationIdsMatch = contentHash(before.organizationIds) === contentHash(restored.organizationIds);
const schemaMatches = before.schemaFingerprint === restored.schemaFingerprint;
const migrationChangedSchema = before.schemaFingerprint !== upgraded.schemaFingerprint
  && upgraded.tableCount > before.tableCount;
const repeatedMigrationStable = upgraded.fingerprint === repeated.fingerprint
  && upgraded.schemaFingerprint === repeated.schemaFingerprint
  && upgraded.tableCount === repeated.tableCount
  && contentHash(upgraded.organizationIds) === contentHash(repeated.organizationIds);
const ok = missingTables.length === 0 && extraTables.length === 0
  && changedTables.length === 0 && organizationIdsMatch && schemaMatches
  && before.fingerprint === restored.fingerprint
  && migrationChangedSchema && repeatedMigrationStable;
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  mode: "isolated_pre_change_restore", ok,
  sourceDatabase: before.database, restoredDatabase: restored.database,
  dumpSha256: before.dumpSha256, beforeReport: beforePath, restoredReport: restoredPath,
  beforeFingerprint: before.fingerprint, restoredFingerprint: restored.fingerprint,
  upgradedFingerprint: upgraded.fingerprint, repeatedFingerprint: repeated.fingerprint,
  beforeSchemaFingerprint: before.schemaFingerprint,
  restoredSchemaFingerprint: restored.schemaFingerprint,
  organizationIdsMatch, schemaMatches, migrationChangedSchema, repeatedMigrationStable,
  missingTables, extraTables, changedTables,
  rowsBefore: Object.values(before.tables).reduce((sum, table) => sum + table.rows, 0),
  rowsRestored: Object.values(restored.tables).reduce((sum, table) => sum + table.rows, 0),
  modelCalls: 0,
  limitation: "Compares isolated logical row content against the same dump; does not validate production deployment or down-migrations." };
await mkdir(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, output);
process.stdout.write(`${JSON.stringify({ report: output, ok,
  missingTables: missingTables.length, extraTables: extraTables.length,
  changedTables: changedTables.length })}\n`);
if (!ok) process.exitCode = 1;
