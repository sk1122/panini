import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import pg from "pg";
import { visibleAcceptedTasks } from "../domain/accepted-source-access.js";
import { PayloadCipher, type EncryptedPayload } from "../security/payload-cipher.js";
import { PostgresLedgerStore } from "../store/postgres.js";

const databaseUrl = process.env.DATABASE_URL;
const key = process.env.CONTENT_ENCRYPTION_KEY;
const allowed = (process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(",")
  .map((item) => item.trim()).filter(Boolean);
if (!databaseUrl || !key || allowed.length === 0) throw new Error("Isolated audit configuration is required.");
const databaseName = "panini_replay_20261001";
const output = path.resolve("artifacts/evidence-state/replay-20261001-gpt6/identity-egress-audit.json");
const pool = new pg.Pool({ connectionString: databaseUrl });
const store = new PostgresLedgerStore(databaseUrl, key);
try {
  const actual = (await pool.query<{ current_database: string }>("SELECT current_database()"))
    .rows[0]?.current_database;
  if (actual !== databaseName) throw new Error("Identity audit target is not the isolated replay database.");
  const tasks = await store.listTasks();
  const permitted = new Set((await visibleAcceptedTasks(store, tasks, { kind: "admin" }, allowed))
    .map((task) => task.id));
  const excluded = new Set(tasks.filter((task) => !permitted.has(task.id)).map((task) => task.id));
  const cipher = new PayloadCipher(key);
  const calls = (await pool.query<{ id: string; request_envelope: EncryptedPayload | null;
    created_at: Date }>(
    `SELECT id,request_envelope,created_at FROM model_calls
      WHERE purpose='identity' AND request_envelope IS NOT NULL
      ORDER BY created_at,id`,
  )).rows;
  let scanned = 0;
  let matchedCalls = 0;
  const matchedTaskIds = new Set<string>();
  let latestMatchingCallAt: string | null = null;
  for (const call of calls) {
    if (!call.request_envelope) continue;
    const request = cipher.decrypt(call.request_envelope);
    const body = request && typeof request === "object" && !Array.isArray(request)
      ? request as { input?: unknown } : null;
    if (typeof body?.input !== "string") continue;
    scanned += 1;
    let catalog: { candidates?: { id?: unknown }[] };
    try { catalog = JSON.parse(body.input) as typeof catalog; }
    catch { continue; }
    const found = (catalog.candidates ?? []).flatMap((candidate) =>
      typeof candidate.id === "string" && excluded.has(candidate.id) ? [candidate.id] : []);
    if (found.length === 0) continue;
    matchedCalls += 1;
    latestMatchingCallAt = call.created_at.toISOString();
    for (const id of found) matchedTaskIds.add(id);
  }
  const report = { schemaVersion: 1, generatedAt: new Date().toISOString(), database: actual,
    totalAcceptedTasks: tasks.length, tasksExcludedByCurrentVisibility: excluded.size,
    identityRequestsScanned: scanned, requestsContainingExcludedTaskIds: matchedCalls,
    distinctExcludedTasksInRequests: matchedTaskIds.size, latestMatchingCallAt,
    limitation: "Compares stored candidate task IDs to current source-lineage visibility. It does not reconstruct visibility at each historical call time or prove provider retention." };
  await mkdir(path.dirname(output), { recursive: true });
  const temp = `${output}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(report, null, 2), { mode: 0o600 });
  await rename(temp, output);
  console.log(JSON.stringify({ report: output,
    identityRequestsScanned: scanned, requestsContainingExcludedTaskIds: matchedCalls,
    distinctExcludedTasksInRequests: matchedTaskIds.size }));
} finally { await store.close(); await pool.end(); }
