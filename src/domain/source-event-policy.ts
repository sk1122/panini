import type { SourceEvent } from "./types.js";

export const acceptedContextReceiptEventKinds = [
  "context.fact.authored",
  "context.file.authored",
  "context.lifecycle.reviewed",
] as const;

const acceptedContextReceiptEventKindSet = new Set<string>(acceptedContextReceiptEventKinds);

export function isInterpretationEligibleSourceEvent(
  event: Pick<SourceEvent, "provider" | "eventKind">,
): boolean {
  return event.provider !== "manual" || !acceptedContextReceiptEventKindSet.has(event.eventKind);
}
