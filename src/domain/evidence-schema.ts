import { z } from "zod";

const evidenceRuleSchema = z.strictObject({
  kind: z.enum(["authorized_attestation", "artifact_observed", "check_passed", "merged", "deployed", "manual_review"]),
  authorityPolicyId: z.string().max(200).nullable(),
  artifactRefs: z.array(z.string().min(1).max(1_000)).max(20),
  requiredCheckNames: z.array(z.string().min(1).max(300)).max(20),
  requiredEnvironment: z.string().max(200).nullable(),
  maxMutableAgeSeconds: z.number().int().nonnegative().default(900),
  maxCheckpointAgeSeconds: z.number().int().nonnegative().optional(),
});

const outcomeCriterionDraftSchema = z.strictObject({
  id: z.string().min(1).max(200),
  description: z.string().min(1).max(2_000),
  required: z.boolean(),
  evidenceRule: evidenceRuleSchema,
});

export const outcomeContractDraftSchema = z.strictObject({
  statement: z.string().min(1).max(4_000),
  scope: z.string().min(1).max(4_000),
  exclusions: z.array(z.string().max(2_000)).max(20),
  criteria: z.array(outcomeCriterionDraftSchema).max(20),
}).superRefine((contract, context) => {
  const ids = new Set<string>();
  for (const criterion of contract.criteria) {
    if (ids.has(criterion.id)) context.addIssue({ code: "custom", message: `Duplicate criterion ${criterion.id}` });
    ids.add(criterion.id);
  }
});

export const outcomeContractSchema = z.strictObject({
  version: z.number().int().positive(),
  statement: z.string().min(1).max(4_000),
  scope: z.string().min(1).max(4_000),
  exclusions: z.array(z.string().max(2_000)).max(20),
  criteria: z.array(outcomeCriterionDraftSchema.safeExtend({
    acceptedBy: z.string().min(1),
    acceptedAt: z.iso.datetime(),
  })).max(20),
  provenance: z.strictObject({
    proposalId: z.uuid(),
    evidenceIds: z.array(z.uuid()),
    actor: z.string().min(1),
    acceptedAt: z.iso.datetime(),
  }),
}).superRefine((contract, context) => {
  const ids = new Set<string>();
  for (const criterion of contract.criteria) {
    if (ids.has(criterion.id)) context.addIssue({ code: "custom", message: `Duplicate criterion ${criterion.id}` });
    ids.add(criterion.id);
  }
});

const support = { supportingClaimIds: z.array(z.uuid()) };
const stringSetFields = ["title", "description", "owner", "project", "projectId", "dueDate", "sourceUrl"] as const;
const setString = stringSetFields.map((field) => z.strictObject({ field: z.literal(field), op: z.literal("set"), value: z.string(), ...support }));
const setOperations = [
  ...setString,
  z.strictObject({ field: z.literal("status"), op: z.literal("set"), value: z.enum(["backlog", "planned", "in_progress", "blocked", "review", "done", "cancelled"]), ...support }),
  z.strictObject({ field: z.literal("priority"), op: z.literal("set"), value: z.enum(["low", "medium", "high", "urgent"]), ...support }),
  z.strictObject({ field: z.literal("dependencyRefs"), op: z.literal("set"), value: z.array(z.string()), ...support }),
  z.strictObject({ field: z.literal("outcomeContract"), op: z.literal("set"), value: outcomeContractSchema, ...support }),
  z.strictObject({ field: z.literal("result"), op: z.literal("set"), value: z.enum(["unknown", "succeeded", "failed", "mixed", "not_applicable"]), ...support }),
];
const clearFields = ["owner", "project", "projectId", "dueDate", "sourceUrl", "dependencyRefs"] as const;
const clearOperations = clearFields.map((field) => z.strictObject({ field: z.literal(field), op: z.literal("clear"), ...support }));
export const taskPatchSchema = z.array(z.union([...setOperations, ...clearOperations] as [typeof setOperations[number], ...typeof setOperations[number][]])).superRefine((operations, context) => {
  const fields = new Set<string>();
  for (const [index, operation] of operations.entries()) {
    if (fields.has(operation.field)) context.addIssue({ code: "custom", path: [index, "field"], message: `Duplicate field ${operation.field}` });
    fields.add(operation.field);
  }
});
