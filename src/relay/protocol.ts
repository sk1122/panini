import { sign, verify } from "node:crypto";
import { z } from "zod";

export const workReportSchema = z.object({
  reportId: z.string().min(1).max(500),
  workItemId: z.string().max(200).nullable().default(null),
  phase: z.enum(["started", "checkpoint", "delivered", "verified", "blocked", "failed"]),
  outcome: z.string().min(1).max(2_000),
  artifactRefs: z.array(z.string().max(1_000)).max(100).default([]),
  verification: z.array(z.string().max(1_000)).max(100).default([]),
  occurredAt: z.string().datetime({ offset: true }),
}).strict();

export type WorkReport = z.infer<typeof workReportSchema>;

export const relayEnvelopeSchema = z.object({
  version: z.literal("panini-relay-v1"),
  deviceId: z.string().uuid(),
  idempotencyKey: z.string().min(1).max(500),
  report: workReportSchema,
}).strict().refine((value) => value.idempotencyKey === value.report.reportId, "The relay idempotency key must equal the report ID.");

export interface RelayEnvelope {
  version: "panini-relay-v1";
  deviceId: string;
  idempotencyKey: string;
  report: WorkReport;
}

export function createRelayEnvelope(deviceId: string, report: WorkReport): RelayEnvelope {
  const validated = workReportSchema.parse(report);
  return relayEnvelopeSchema.parse({ version: "panini-relay-v1", deviceId, idempotencyKey: validated.reportId, report: validated });
}

export function serializeRelayEnvelope(envelope: RelayEnvelope): Buffer {
  return Buffer.from(JSON.stringify(envelope), "utf8");
}

export function signRelayEnvelope(rawBody: Buffer, privateKeyPem: string): string {
  return sign(null, rawBody, privateKeyPem).toString("base64");
}

export function verifyRelayEnvelope(rawBody: Buffer, signature: string, publicKeyPem: string): boolean {
  try {
    return verify(null, rawBody, publicKeyPem, Buffer.from(signature, "base64"));
  } catch {
    return false;
  }
}
