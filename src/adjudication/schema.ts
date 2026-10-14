import { z } from "zod";

export const adjudicationDecisionSchema = z.object({
  proposalId: z.string().uuid(),
  action: z.enum(["approve", "reject", "supersede", "escalate"]),
  confidence: z.number().min(0).max(1),
  rationale: z.string().trim().min(1).max(4_000),
  temporalBasis: z.string().trim().min(1).max(2_000),
  historicalBasis: z.array(z.string().trim().min(1).max(2_000)).max(20),
}).strict();

export const adjudicationBatchOutputSchema = z.object({
  decisions: z.array(adjudicationDecisionSchema),
}).strict();

export const adjudicationJsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          proposalId: { type: "string" },
          action: { type: "string", enum: ["approve", "reject", "supersede", "escalate"] },
          confidence: { type: "number", minimum: 0, maximum: 1 },
          rationale: { type: "string" },
          temporalBasis: { type: "string" },
          historicalBasis: { type: "array", items: { type: "string" } },
        },
        required: ["proposalId", "action", "confidence", "rationale", "temporalBasis", "historicalBasis"],
      },
    },
  },
  required: ["decisions"],
} as const;

export function adjudicationJsonSchemaFor(proposalIds: string[]) {
  const ids = [...new Set(proposalIds)];
  if (ids.length === 0 || ids.length !== proposalIds.length) {
    throw new Error("Adjudication schema requires one or more unique proposal IDs.");
  }
  return {
    ...adjudicationJsonSchema,
    properties: {
      ...adjudicationJsonSchema.properties,
      decisions: {
        ...adjudicationJsonSchema.properties.decisions,
        minItems: ids.length,
        maxItems: ids.length,
        items: {
          ...adjudicationJsonSchema.properties.decisions.items,
          properties: {
            ...adjudicationJsonSchema.properties.decisions.items.properties,
            proposalId: { type: "string", enum: ids },
          },
        },
      },
    },
  } as const;
}
