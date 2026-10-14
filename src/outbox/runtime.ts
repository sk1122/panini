import { randomUUID } from "node:crypto";
import type { LedgerStore } from "../domain/store.js";
import type { JsonValue, NewOutboxJob, OutboxJob } from "../domain/types.js";

export type OutboxHandler = (job: OutboxJob) => Promise<void>;

export interface OutboxLog {
  info(message: string, fields?: object): void;
  error(message: string, fields?: object): void;
}

export interface OutboxDispatcherOptions {
  workerId?: string;
  batchSize: number;
  leaseSeconds: number;
  pollIntervalMs: number;
  maxAttempts: number;
  retryBaseMs: number;
  retryMaximumMs: number;
  handlers: ReadonlyMap<string, OutboxHandler>;
  log: OutboxLog;
}

export interface OutboxRunReport {
  claimed: number;
  completed: number;
  retried: number;
  failed: number;
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class OutboxQueue {
  constructor(private readonly store: LedgerStore) {}

  enqueue(topic: string, dedupeKey: string, payload: JsonValue, availableAt?: string): Promise<OutboxJob> {
    const input: NewOutboxJob = { topic, dedupeKey, payload, ...(availableAt ? { availableAt } : {}) };
    return this.store.enqueueOutboxJob(input);
  }

  list(limit = 100): Promise<OutboxJob[]> {
    return this.store.listOutboxJobs(limit);
  }
}

export class OutboxDispatcher {
  private readonly workerId: string;
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<OutboxRunReport> | null = null;

  constructor(private readonly store: LedgerStore, private readonly options: OutboxDispatcherOptions) {
    this.workerId = options.workerId ?? `worker:${randomUUID()}`;
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.pollIntervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.activeRun;
  }

  runOnce(): Promise<OutboxRunReport> {
    if (this.activeRun) return this.activeRun;
    const run = this.executeRun().finally(() => {
      if (this.activeRun === run) this.activeRun = null;
    });
    this.activeRun = run;
    return run;
  }

  private async tick(): Promise<void> {
    try {
      await this.runOnce();
    } catch (error) {
      this.options.log.error("Outbox dispatch cycle failed.", { error: cleanError(error), workerId: this.workerId });
    }
  }

  private async executeRun(): Promise<OutboxRunReport> {
    const jobs = await this.store.claimOutboxJobs(this.workerId, this.options.batchSize, this.options.leaseSeconds);
    const report: OutboxRunReport = { claimed: jobs.length, completed: 0, retried: 0, failed: 0 };
    for (const job of jobs) {
      const handler = this.options.handlers.get(job.topic);
      try {
        if (!handler) throw new Error(`No outbox handler is registered for topic ${job.topic}.`);
        await handler(job);
        await this.store.completeOutboxJob(job.id, this.workerId);
        report.completed += 1;
        this.options.log.info("Outbox job completed.", { jobId: job.id, topic: job.topic, attempts: job.attempts });
      } catch (error) {
        const message = cleanError(error).slice(0, 4_000);
        const exhausted = job.attempts >= this.options.maxAttempts;
        const retryDelay = Math.min(
          this.options.retryMaximumMs,
          this.options.retryBaseMs * (2 ** Math.max(0, job.attempts - 1)),
        );
        const retryAt = exhausted ? null : new Date(Date.now() + retryDelay).toISOString();
        await this.store.failOutboxJob(job.id, this.workerId, message, retryAt);
        if (exhausted) report.failed += 1;
        else report.retried += 1;
        this.options.log.error(exhausted ? "Outbox job exhausted retries." : "Outbox job scheduled for retry.", {
          jobId: job.id,
          topic: job.topic,
          attempts: job.attempts,
          error: message,
          retryAt,
        });
      }
    }
    return report;
  }
}
