import { z } from "zod";
import { contextFactTypes, taskStatuses } from "../domain/types.js";

const projectStatuses = ["active", "paused", "completed", "archived"] as const;

const findingSchema = z.object({
  kind: z.enum(["project_upsert", "task_change", "task_create", "task_duplicate", "context_file_upsert", "context_fact_upsert", "abstain"]),
  taskId: z.string().nullable(),
  duplicateOfTaskId: z.string().nullable().default(null),
  title: z.string().max(180).nullable(),
  description: z.string().max(10_000).nullable(),
  status: z.enum(taskStatuses).nullable(),
  priority: z.enum(["low", "medium", "high", "urgent"]).nullable(),
  owner: z.string().max(240).nullable(),
  project: z.string().max(240).nullable(),
  projectId: z.string().nullable().default(null),
  projectOutcome: z.string().max(2_000).nullable().default(null),
  projectStatus: z.enum(projectStatuses).nullable().default(null),
  dueDate: z.string().max(100).nullable(),
  dependencyRefs: z.array(z.string().max(300)).max(100),
  contextPath: z.string().max(500).nullable(),
  contextTitle: z.string().max(240).nullable(),
  contextBody: z.string().max(40_000).nullable(),
  contextFactType: z.enum(contextFactTypes).nullable(),
  contextFactValue: z.union([z.string().max(10_000), z.number(), z.boolean()]).nullable(),
  rationale: z.string().min(3).max(2_000),
  confidence: z.number().min(0).max(1),
  evidenceEventIds: z.array(z.string().uuid()).max(100),
  caveats: z.array(z.string().max(500)).max(20),
}).strict();

export const interpretationOutputSchema = z.object({
  summary: z.string().max(4_000),
  findings: z.array(findingSchema).max(100),
}).strict();

export const interpretationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          kind: { type: "string", enum: ["project_upsert", "task_change", "task_create", "task_duplicate", "context_file_upsert", "context_fact_upsert", "abstain"] },
          taskId: { type: ["string", "null"] },
          duplicateOfTaskId: { type: ["string", "null"] },
          title: { type: ["string", "null"] },
          description: { type: ["string", "null"] },
          status: { type: ["string", "null"], enum: [...taskStatuses, null] },
          priority: { type: ["string", "null"], enum: ["low", "medium", "high", "urgent", null] },
          owner: { type: ["string", "null"] },
          project: { type: ["string", "null"] },
          projectId: { type: ["string", "null"] },
          projectOutcome: { type: ["string", "null"] },
          projectStatus: { type: ["string", "null"], enum: [...projectStatuses, null] },
          dueDate: { type: ["string", "null"] },
          dependencyRefs: { type: "array", items: { type: "string" } },
          contextPath: { type: ["string", "null"] },
          contextTitle: { type: ["string", "null"] },
          contextBody: { type: ["string", "null"] },
          contextFactType: { type: ["string", "null"], enum: [...contextFactTypes, null] },
          contextFactValue: { type: ["string", "number", "boolean", "null"] },
          rationale: { type: "string" },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          evidenceEventIds: { type: "array", items: { type: "string" } },
          caveats: { type: "array", items: { type: "string" } },
        },
        required: [
          "kind", "taskId", "duplicateOfTaskId", "title", "description", "status", "priority", "owner", "project", "projectId", "projectOutcome", "projectStatus", "dueDate",
          "dependencyRefs", "contextPath", "contextTitle", "contextBody", "contextFactType", "contextFactValue", "rationale", "confidence",
          "evidenceEventIds", "caveats",
        ],
      },
    },
  },
  required: ["summary", "findings"],
} as const;

export function interpretationJsonSchemaFor(constraints: {
  evidenceEventIds: string[];
  taskIds: string[];
  projectIds?: string[];
  activeMemberNames: string[];
}) {
  const evidenceEventIds = [...new Set(constraints.evidenceEventIds)];
  const taskIds = [...new Set(constraints.taskIds)];
  const projectIds = [...new Set(constraints.projectIds ?? [])];
  const activeMemberNames = [...new Set(constraints.activeMemberNames)];
  return {
    ...interpretationJsonSchema,
    properties: {
      ...interpretationJsonSchema.properties,
      findings: {
        ...interpretationJsonSchema.properties.findings,
        items: {
          ...interpretationJsonSchema.properties.findings.items,
          properties: {
            ...interpretationJsonSchema.properties.findings.items.properties,
            taskId: { type: ["string", "null"], enum: [...taskIds, null] },
            duplicateOfTaskId: { type: ["string", "null"], enum: [...taskIds, null] },
            projectId: { type: ["string", "null"], enum: [...projectIds, null] },
            owner: { type: ["string", "null"], enum: [...activeMemberNames, null] },
            evidenceEventIds: {
              type: "array",
              items: evidenceEventIds.length > 0
                ? { type: "string", enum: evidenceEventIds }
                : { type: "string" },
              maxItems: Math.min(100, evidenceEventIds.length),
            },
          },
        },
      },
    },
  } as const;
}
