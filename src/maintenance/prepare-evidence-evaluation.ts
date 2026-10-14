import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";

const root = path.resolve("artifacts/evidence-state");
const checked = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error(`${name} must be JSON under artifacts/evidence-state.`);
  }
  return resolved;
};
const goldPath = checked("PANINI_GOLD_MANIFEST");
const output = checked("PANINI_EVALUATION_MANIFEST");
if (goldPath === output) throw new Error("Gold and evaluation manifests must differ.");
const gold = z.strictObject({ schemaVersion: z.literal(1),
  frozenHash: z.string().regex(/^[0-9a-f]{64}$/),
  cases: z.array(z.object({ id: z.string().min(1),
    sourceEventIds: z.array(z.uuid()).min(1), cutoff: z.iso.datetime() }).passthrough()).min(1) })
  .passthrough().parse(JSON.parse(await readFile(goldPath, "utf8")));
if (contentHash(gold.cases) !== gold.frozenHash) {
  throw new Error("Frozen gold case hash changed.");
}
const positive = (name: string) => {
  const value = Number(process.env[name]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a finite positive integer.`);
  return value;
};
const maxUsd = process.env.PANINI_EVALUATION_MAX_USD;
const model = process.env.PANINI_EVALUATION_MODEL;
const embeddingModel = process.env.PANINI_EVALUATION_EMBEDDING_MODEL ?? null;
if (!maxUsd || !/^\d+(?:\.\d{1,8})?$/.test(maxUsd) || Number(maxUsd) <= 0
  || !model || !/^[A-Za-z0-9._:/-]{1,200}$/.test(model)
  || (embeddingModel !== null && embeddingModel !== "voyageai/voyage-4")) {
  throw new Error("A positive USD cap and pinned model are required.");
}
const inputManifest = gold.cases.map((item) => ({ id: item.id,
  sourceEventIds: [...item.sourceEventIds].sort(), cutoff: item.cutoff }))
  .sort((left, right) => left.id.localeCompare(right.id));
const modelBudget = { model, embeddingModel,
  maxCalls: positive("PANINI_EVALUATION_MAX_CALLS"),
  maxInputTokens: positive("PANINI_EVALUATION_MAX_INPUT_TOKENS"),
  maxOutputTokens: positive("PANINI_EVALUATION_MAX_OUTPUT_TOKENS"),
  maxWallSeconds: positive("PANINI_EVALUATION_MAX_WALL_SECONDS"), maxUsd };
const report = { schemaVersion: 1, generatedAt: new Date().toISOString(),
  goldHash: gold.frozenHash, inputManifest, inputFingerprint: contentHash(inputManifest),
  modelBudget, modelBudgetHash: contentHash(modelBudget),
  modes: ["baseline_historical", "baseline_contemporary", "candidate"],
  comparisonRule: "Only baseline_contemporary with identical cutoff, target state, source manifest, model budget, and known costs can support a matched cost comparison.",
  status: "prepared_not_run", paidCalls: 0 };
await mkdir(path.dirname(output), { recursive: true });
const temporary = `${output}.${process.pid}.tmp`;
await writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, output);
process.stdout.write(`${JSON.stringify({ report: output, goldHash: report.goldHash,
  cases: inputManifest.length, inputFingerprint: report.inputFingerprint,
  modelBudgetHash: report.modelBudgetHash, status: report.status })}\n`);
