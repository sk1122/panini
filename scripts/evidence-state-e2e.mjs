import { randomBytes, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import pg from "pg";
import YAML from "yaml";
import { migrate } from "../dist/src/db/migrate.js";
import { PostgresLedgerStore } from "../dist/src/store/postgres.js";

const root = path.resolve(import.meta.dirname, "..");
const baseUrl = process.env.PANINI_TEST_DATABASE_URL;
const contentKey = process.env.CONTENT_ENCRYPTION_KEY;
if (!baseUrl || !contentKey || !/^panini_e2e(?:_.*)?$/.test(new URL(baseUrl).pathname.slice(1))) {
  throw new Error("Set PANINI_TEST_DATABASE_URL to a disposable panini_e2e database and CONTENT_ENCRYPTION_KEY.");
}
const suffix = randomBytes(5).toString("hex");
const database = `panini_e2e_process_${suffix}`;
const targetUrl = new URL(baseUrl);
targetUrl.pathname = `/${database}`;
const reportDir = path.join(root, "artifacts/evidence-state/verification-20261002");
const reportPath = path.join(reportDir, `process-e2e-${suffix}.json`);
const admin = new pg.Pool({ connectionString: baseUrl });
const startedAt = new Date().toISOString();
const processes = [];
let store;
let stub;
let report;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check, label, timeoutMs = 20_000) {
  const stop = Date.now() + timeoutMs;
  let last;
  while (Date.now() < stop) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { last = error; }
    await delay(100);
  }
  throw new Error(`${label} did not become ready${last ? `: ${last.message}` : ""}`);
}
function start(file, env) {
  const child = spawn(process.execPath, [path.join(root, file)], {
    cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => {
    output = `${output}${chunk.toString()}`.slice(-20_000);
  });
  const entry = { child, get output() { return output; } };
  processes.push(entry);
  return entry;
}
async function stop(entry) {
  if (entry.child.exitCode !== null) return;
  entry.child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => entry.child.once("exit", resolve)),
    delay(5_000).then(() => { entry.child.kill("SIGKILL"); }),
  ]);
}

try {
  await admin.query(`CREATE DATABASE ${database}`);
  await migrate(targetUrl.toString());
  store = new PostgresLedgerStore(targetUrl.toString(), contentKey, undefined,
    { backfillLegacyContent: false });
  const organization = await store.getOrganization();
  const budget = await store.createInferenceBudget({ label: `process-e2e-${suffix}`,
    maxCalls: 8, maxInputTokens: 100_000, maxOutputTokens: 20_000,
    maxUsd: "1.00000000", deadline: new Date(Date.now() + 120_000).toISOString(),
    priceBasis: null });
  const config = YAML.parse(await readFile(path.join(root, "config/panini.example.yaml"), "utf8"));
  config.intelligence.enabled = false;
  config.intelligence.evidenceV2 = { mode: "review", pipelineVersion: `process-${suffix}`,
    policyVersion: "process-e2e-v1", maxEvidenceExpansions: 0,
    maxEscalations: 0, workEmbeddingsEnabled: false };
  const configPath = path.join(reportDir, `process-config-${suffix}.yaml`);
  await mkdir(reportDir, { recursive: true, mode: 0o700 });
  await writeFile(configPath, YAML.stringify(config), { mode: 0o600 });
  let calls = 0;
  stub = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls += 1;
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const input = JSON.parse(body.input);
    const ids = [...new Set(input.map((item) => item.eventId))];
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ id: `process-stub-${calls}`, model: "gpt-6-luna",
      status: "completed", output_text: JSON.stringify({ claims: [],
        dispositions: ids.map((eventId) => ({ eventId, state: "no_claim",
          claimOrdinals: [], reasonCode: null })) }),
      usage: { input_tokens: 100, output_tokens: 10,
        input_tokens_details: { cached_tokens: 0 } } }));
  });
  await new Promise((resolve) => stub.listen(0, "127.0.0.1", resolve));
  const modelPort = stub.address().port;
  const port = 43000 + Number.parseInt(suffix.slice(0, 3), 16) % 1000;
  const token = randomBytes(32).toString("hex");
  const env = { ...process.env, DATABASE_URL: targetUrl.toString(),
    CONTENT_ENCRYPTION_KEY: contentKey, APP_CONFIG_PATH: configPath,
    APP_ADMIN_TOKEN: token, AUTO_MIGRATE: "false", HOST: "127.0.0.1", PORT: String(port),
    INTELLIGENCE_MODEL: "gpt-6-luna", INTELLIGENCE_API_KEY: "local-stub-no-egress",
    INTELLIGENCE_BASE_URL: `http://127.0.0.1:${modelPort}`,
    JEV_WORK_ALLOWED_VISIBILITIES: "company",
    PANINI_EVIDENCE_V2_BUDGET_ID: budget.id,
    PANINI_EVIDENCE_V2_VERSION: `process-${suffix}`,
    OUTBOX_POLL_INTERVAL_MS: "100", LOG_LEVEL: "error" };
  const server = start("dist/src/main.js", env);
  const origin = `http://127.0.0.1:${port}`;
  await until(async () => {
    if (server.child.exitCode !== null) throw new Error(`server exited: ${server.output}`);
    const response = await fetch(`${origin}/health/ready`);
    return response.ok;
  }, "server");
  const bootstrap = await fetch(`${origin}/api/auth/bootstrap`, {
    method: "POST", headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ token, companyName: "Example Company", displayName: "Process Reviewer",
      email: `process-${suffix}@example.test`, password: `Test password ${randomUUID()}!` }),
  });
  if (!bootstrap.ok) throw new Error(`bootstrap returned ${bootstrap.status}`);
  const worker = start("dist/src/worker.js", env);
  await delay(250);
  if (worker.child.exitCode !== null) throw new Error(`worker exited: ${worker.output}`);
  const eventId = randomUUID();
  const now = new Date().toISOString();
  const posted = await fetch(`${origin}/api/evidence/events`, {
    method: "POST", headers: { "content-type": "application/json",
      authorization: `Bearer ${token}`, origin },
    body: JSON.stringify({ provider: "slack", installationKey: "T1",
      providerEventId: eventId, eventKind: "message.observed", occurredAt: now,
      fetchedAt: now, sourceRef: `slack:T1:C1:${eventId}`, sourceUrl: null,
      visibility: "company", payloadVersion: "test-v1",
      payload: { teamId: "T1", channel: "C1", messageTs: eventId,
        text: "This is a local process E2E no-action fixture." } }),
  });
  if (posted.status !== 201) throw new Error(`source ingestion returned ${posted.status}`);
  const recorded = await posted.json();
  const sourceId = recorded.event?.id;
  if (!sourceId) throw new Error("ingestion did not return a durable source ID");
  const pool = new pg.Pool({ connectionString: targetUrl.toString() });
  try {
    await until(async () => {
      if (worker.child.exitCode !== null) throw new Error(`worker exited: ${worker.output}`);
      const row = (await pool.query(`SELECT state FROM observation_dispositions
        WHERE source_event_id=$1 AND pipeline_version=$2 ORDER BY attempt DESC LIMIT 1`,
      [sourceId, `process-${suffix}`])).rows[0];
      return row?.state === "no_claim";
    }, "durable no-claim disposition", 30_000);
    const beforeRestart = calls;
    const savedCalls = Number((await pool.query(`SELECT count(*)::text AS count FROM model_calls
      WHERE organization_id=$1 AND purpose='extract'`, [organization.id])).rows[0]?.count);
    if (beforeRestart !== 1 || savedCalls !== 1) throw new Error("unexpected model call count");
    await stop(worker);
    const restarted = start("dist/src/worker.js", env);
    await delay(1_000);
    if (restarted.child.exitCode !== null) throw new Error(`restarted worker exited: ${restarted.output}`);
    const afterRestart = calls;
    const acceptedRevisions = Number((await pool.query(`SELECT count(*)::text AS count
      FROM task_revisions WHERE organization_id=$1`, [organization.id])).rows[0]?.count);
    if (afterRestart !== beforeRestart || acceptedRevisions !== 0) {
      throw new Error("restart repeated extraction or changed accepted state");
    }
    report = { schemaVersion: 1, mode: "separate_server_worker_process_e2e",
      startedAt, finishedAt: new Date().toISOString(), database,
      organizationId: organization.id, sourceEventId: sourceId,
      serverReady: true, workerRestarted: true,
      disposition: "no_claim", modelCalls: savedCalls,
      modelCallsAfterRestart: afterRestart, acceptedTaskRevisions: acceptedRevisions,
      externalModelCalls: 0, modelStubCalls: calls, ok: true };
    await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  } finally { await pool.end(); }
  process.stdout.write(`${JSON.stringify({ report: reportPath, database,
    disposition: report.disposition, modelStubCalls: calls, ok: true })}\n`);
} finally {
  await Promise.all(processes.map(stop));
  await new Promise((resolve) => stub ? stub.close(resolve) : resolve());
  await store?.close();
  await admin.end();
}
