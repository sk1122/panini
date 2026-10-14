import { z } from "zod";
import { contentHash } from "../domain/content-hash.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerStore } from "../domain/store.js";
import type { OutboxJob } from "../domain/types.js";

const cursorSchema = z.strictObject({ receivedAt: z.iso.datetime(), id: z.uuid() });
const sweepPayloadSchema = z.strictObject({
  pipelineVersion: z.string().min(1),
  dispatchEpoch: z.string().min(1),
  sweepDate: z.iso.date().optional(),
  cursor: cursorSchema.nullable(),
});

/** Pages source receipts into durable, deduplicated jobs without invoking a model. */
export class EvidenceDiscoverySweep {
  constructor(private readonly store: LedgerStore, private readonly pipelineVersion: string,
    private readonly pageSize = 100, private readonly dispatchEpoch = pipelineVersion,
    private readonly noClaimSamplePercent = 10) {
    if (!pipelineVersion.trim() || !dispatchEpoch.trim()
      || !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100
      || !Number.isSafeInteger(noClaimSamplePercent) || noClaimSamplePercent < 0
      || noClaimSamplePercent > 100) {
      throw new DomainError("Invalid evidence discovery configuration.", "INVALID");
    }
  }

  async schedule(day: string): Promise<OutboxJob> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) {
      throw new DomainError("An ISO calendar day is required for discovery scheduling.", "INVALID");
    }
    return this.store.enqueueOutboxJob({ topic: "evidence.discovery.sweep",
      dedupeKey: `evidence:sweep:${this.dispatchEpoch}:day:${day}`,
      payload: { pipelineVersion: this.pipelineVersion, dispatchEpoch: this.dispatchEpoch,
        sweepDate: day,
        cursor: null } });
  }

  async handle(job: OutboxJob): Promise<{ queuedReceipts: number; hasMore: boolean }> {
    if (job.topic !== "evidence.discovery.sweep") throw new DomainError("Wrong discovery job topic.", "INVALID");
    const payload = sweepPayloadSchema.parse(job.payload);
    const sweepDate = payload.sweepDate ?? job.createdAt.slice(0, 10);
    if (payload.pipelineVersion !== this.pipelineVersion || payload.dispatchEpoch !== this.dispatchEpoch) {
      throw new DomainError("Discovery job pipeline version changed.", "CONFLICT");
    }
    const page = await this.store.listSourceEventsAfter(payload.cursor, this.pageSize + 1);
    const selected = page.slice(0, this.pageSize);
    let queuedReceipts = 0;
    for (const event of selected) {
      const previous = await this.store.getLatestObservationDisposition(event.id, this.pipelineVersion);
      const noClaimSample = previous?.state === "no_claim" && previous.attempt === 1
        && Number.parseInt(contentHash({ eventId: event.id, sweepDate }).slice(0, 4), 16)
          < Math.ceil(this.noClaimSamplePercent * 65_536 / 100);
      if (previous && !noClaimSample && (!previous.retryable || previous.attempt >= 3
        || !["failed", "partial", "unresolved"].includes(previous.state))) continue;
      await this.store.enqueueOutboxJob({ topic: "evidence.source.ready",
        dedupeKey: `evidence:source:${this.dispatchEpoch}:${sweepDate}:${event.id}`,
        payload: { pipelineVersion: this.pipelineVersion, eventId: event.id,
          dispatchEpoch: this.dispatchEpoch,
          sourceVersionKey: event.observationIdentity?.sourceVersionKey ?? null,
          reason: noClaimSample ? "no_claim_sample"
            : previous ? "retry_incomplete" : "discovery_sweep" } });
      queuedReceipts += 1;
    }
    if (page.length > this.pageSize) {
      const last = selected.at(-1)!;
      await this.store.enqueueOutboxJob({ topic: "evidence.discovery.sweep",
        dedupeKey: `evidence:sweep:${this.dispatchEpoch}:${sweepDate}:after:${last.receivedAt}:${last.id}`,
        payload: { pipelineVersion: this.pipelineVersion,
          dispatchEpoch: this.dispatchEpoch,
          sweepDate,
          cursor: { receivedAt: last.receivedAt, id: last.id } } });
    }
    return { queuedReceipts, hasMore: page.length > this.pageSize };
  }
}
