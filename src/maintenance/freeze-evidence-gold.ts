import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";

const root = path.resolve("artifacts/evidence-state");
function artifactPath(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const resolved = path.resolve(value);
  if (!resolved.startsWith(`${root}${path.sep}`) || !resolved.endsWith(".json")) {
    throw new Error(`${name} must be JSON under artifacts/evidence-state.`);
  }
  return resolved;
}

const packetPath = artifactPath("PANINI_GOLD_REVIEW_PACKET");
const labelsPath = artifactPath("PANINI_GOLD_REVIEW_LABELS");
const outputPath = artifactPath("PANINI_GOLD_MANIFEST");
if (new Set([packetPath, labelsPath, outputPath]).size !== 3) {
  throw new Error("Packet, labels, and frozen manifest must be distinct files.");
}

const source = z.object({ id: z.uuid(), receivedAt: z.iso.datetime() }).passthrough();
const packetCase = z.object({ id: z.string().min(1), reviewClusterId: z.string().min(1),
  sourceReceipts: z.array(source).min(1) }).passthrough();
const packetSchema = z.object({ schemaVersion: z.literal(1),
  cases: z.array(packetCase).min(1) }).passthrough();
const transition = z.strictObject({ field: z.enum(["status", "result", "owner", "project", "priority", "task_create", "context_create"]),
  value: z.string() });
const labelSchema = z.strictObject({ id: z.string().min(1), clusterId: z.string().min(1),
  sourceEventIds: z.array(z.uuid()).min(1), suggestedCutoff: z.iso.datetime(),
  cutoff: z.iso.datetime().nullable(), split: z.enum(["development", "holdout"]).nullable(),
  targetTaskId: z.uuid().nullable(), reviewer: z.string().trim().min(1).nullable(),
  rationale: z.string().trim().min(1).nullable(),
  adjudication: z.enum(["confirmed", "unresolved"]).nullable(),
  ambiguityStatus: z.enum(["clear", "ambiguous"]).nullable(),
  expectedRelationship: z.enum(["same_outcome", "part_of", "related", "unrelated", "uncertain"]).nullable(),
  expectedClaim: z.string().trim().min(1).nullable(),
  expectedScope: z.string().trim().min(1).nullable(),
  expectedTransition: transition.nullable(),
  supportingSourceEventIds: z.array(z.uuid()) });
const labelsSchema = z.strictObject({ schemaVersion: z.literal(1),
  packetCasesHash: z.string().regex(/^[0-9a-f]{64}$/), instruction: z.string(),
  cases: z.array(labelSchema).min(1) });

const packet = packetSchema.parse(JSON.parse(await readFile(packetPath, "utf8")));
const labels = labelsSchema.parse(JSON.parse(await readFile(labelsPath, "utf8")));
const packetHash = contentHash(packet.cases);
if (labels.packetCasesHash !== packetHash || labels.cases.length !== packet.cases.length) {
  throw new Error("Reviewer labels do not match the source review packet.");
}
const packetById = new Map(packet.cases.map((item) => [item.id, item]));
const seen = new Set<string>();
const frozenAt = new Date().toISOString();
const cases = labels.cases.map((label) => {
  const original = packetById.get(label.id);
  if (!original || seen.has(label.id) || original.reviewClusterId !== label.clusterId) {
    throw new Error(`Label ${label.id} is missing, duplicated, or moved across clusters.`);
  }
  seen.add(label.id);
  const originalIds = original.sourceReceipts.map((item) => item.id).sort();
  if (contentHash([...label.sourceEventIds].sort()) !== contentHash(originalIds)
    || new Set(originalIds).size !== originalIds.length) {
    throw new Error(`Label ${label.id} changed its packet receipts.`);
  }
  if (!label.cutoff || !label.split || !label.reviewer || !label.rationale
    || !label.adjudication || !label.ambiguityStatus) {
    throw new Error(`Label ${label.id} is not fully reviewed.`);
  }
  if (label.cutoff > frozenAt) throw new Error(`Label ${label.id} has a future cutoff.`);
  const available = original.sourceReceipts.filter((item) => item.receivedAt <= label.cutoff!);
  const availableIds = new Set(available.map((item) => item.id));
  if (availableIds.size === 0 || label.supportingSourceEventIds.some((id) => !availableIds.has(id))
    || new Set(label.supportingSourceEventIds).size !== label.supportingSourceEventIds.length) {
    throw new Error(`Label ${label.id} cites unavailable or duplicate support.`);
  }
  if (label.adjudication === "confirmed" && !label.expectedRelationship) {
    throw new Error(`Confirmed label ${label.id} needs a relationship.`);
  }
  if (label.adjudication === "confirmed" && label.expectedTransition
    && (!label.expectedClaim || !label.expectedScope || label.supportingSourceEventIds.length === 0)) {
    throw new Error(`Confirmed transition ${label.id} needs claim, scope, and supporting receipts.`);
  }
  return { id: label.id, split: label.split, clusterId: label.clusterId,
    taskId: label.targetTaskId, sourceEventIds: available.map((item) => item.id),
    cutoff: label.cutoff,
    expectedRelationship: label.expectedRelationship ?? "uncertain",
    expectedTransition: label.adjudication === "confirmed" ? label.expectedTransition : null,
    expectedClaim: label.adjudication === "confirmed" ? label.expectedClaim : null,
    expectedScope: label.adjudication === "confirmed" ? label.expectedScope : null,
    supportingSourceEventIds: label.adjudication === "confirmed"
      ? label.supportingSourceEventIds : [],
    adjudication: label.adjudication, reviewer: label.reviewer,
    rationale: label.rationale, ambiguityStatus: label.ambiguityStatus };
});
if (seen.size !== packet.cases.length) throw new Error("Some review cases have no label.");
const splitsByCluster = new Map<string, Set<string>>();
const splitsBySource = new Map<string, Set<string>>();
for (const item of cases) {
  const cluster = splitsByCluster.get(item.clusterId) ?? new Set<string>();
  cluster.add(item.split); splitsByCluster.set(item.clusterId, cluster);
  for (const id of item.sourceEventIds) {
    const sourceSplits = splitsBySource.get(id) ?? new Set<string>();
    sourceSplits.add(item.split); splitsBySource.set(id, sourceSplits);
  }
}
if ([...splitsByCluster.values(), ...splitsBySource.values()].some((value) => value.size > 1)) {
  throw new Error("A task/thread cluster or source receipt crosses the split.");
}
const development = cases.filter((item) => item.split === "development");
const holdout = cases.filter((item) => item.split === "holdout");
if (!development.length || !holdout.some((item) => item.adjudication === "confirmed"
  && item.ambiguityStatus === "clear")
  || development.some((item) => holdout.some((other) => item.cutoff >= other.cutoff))) {
  throw new Error("A clear reviewed holdout must follow the development cases in knowledge time.");
}
const manifest = { schemaVersion: 1, packetCasesHash: packetHash,
  frozenAt, frozenHash: contentHash(cases), cases };
await writeFile(outputPath, JSON.stringify(manifest, null, 2), { flag: "wx", mode: 0o600 });
console.log(JSON.stringify({ manifest: outputPath, cases: cases.length,
  development: development.length, holdout: holdout.length, frozenHash: manifest.frozenHash }));
