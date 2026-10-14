import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import type { ContextEntry, Project, SourceEvent, Task } from "../domain/types.js";
import type { EvidenceIntelligence, } from "../intelligence/engine.js";

interface ReconciliationUnit {
  targetType: "task" | "project" | "context";
  targetId: string;
  version: string;
  updatedAt: string;
  evidenceIds: string[];
}

export interface ContinuousReconciliationOptions {
  intervalSeconds: number;
  minimumAgeSeconds: number;
  log: { info(message: string, fields?: object): void; error(message: string, fields?: object): void };
}

/**
 * Rechecks one accepted entity at a time against its cited evidence. A durable
 * audit signature makes the loop converge and prevents repeat model spend until
 * either the accepted version or its evidence changes.
 */
export class ContinuousReconciliationLoop {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly store: LedgerStore,
    private readonly ledger: TeamLedger,
    private readonly intelligence: EvidenceIntelligence,
    private readonly options: ContinuousReconciliationOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runOnce().catch((error) =>
      this.options.log.error("Continuous reconciliation failed.", { error: String(error) })),
    this.options.intervalSeconds * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<{ state: "reconciled" | "idle" | "busy"; targetId?: string; runId?: string | null }> {
    if (this.running) return { state: "busy" };
    this.running = true;
    try {
      const units = await this.units();
      const audits = await this.store.listAuditEvents(10_000);
      const completed = new Set(audits.filter((event) => event.action === "intelligence.reconciliation.completed")
        .flatMap((event) => {
          const value = event.details.signature;
          return typeof value === "string" ? [value] : [];
        }));
      const minimumTime = Date.now() - this.options.minimumAgeSeconds * 1_000;
      for (const unit of units.sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))) {
        if (Date.parse(unit.updatedAt) > minimumTime) continue;
        const events = await this.store.getSourceEvents([...new Set(unit.evidenceIds)]);
        if (events.length === 0) continue;
        const signature = this.signature(unit, events);
        if (completed.has(signature)) continue;
        const selected = [...events].sort((left, right) => right.occurredAt.localeCompare(left.occurredAt)).slice(0, 20);
        const report = await this.intelligence.run({ eventIds: selected.map((event) => event.id) });
        await this.store.appendAuditEvent({
          actor: "system:continuous-reconciliation",
          action: "intelligence.reconciliation.completed",
          targetType: unit.targetType,
          targetId: unit.targetId,
          sourceEventId: selected[0]?.id ?? null,
          proposalId: null,
          details: { signature, acceptedVersion: unit.version, evidenceCount: selected.length,
            interpretationRunId: report.id, outcomeCount: report.outcomes.length },
        });
        this.options.log.info("Accepted state reconciled against cited evidence.", {
          targetType: unit.targetType, targetId: unit.targetId, runId: report.id,
        });
        return { state: "reconciled", targetId: unit.targetId, runId: report.id };
      }
      return { state: "idle" };
    } finally {
      this.running = false;
    }
  }

  private signature(unit: ReconciliationUnit, events: SourceEvent[]): string {
    return contentHash({ policy: "continuous-reconciliation-v1", targetType: unit.targetType,
      targetId: unit.targetId, version: unit.version,
      evidence: events.map((event) => ({ id: event.id, hash: event.contentHash })).sort((left, right) =>
        left.id.localeCompare(right.id)) });
  }

  private async units(): Promise<ReconciliationUnit[]> {
    const [graph, entries, projectProposals] = await Promise.all([
      this.ledger.workGraph(), this.store.listContextEntries(), this.store.listProjectProposals(),
    ]);
    const taskUnits = await Promise.all(graph.tasks.map(async (task: Task): Promise<ReconciliationUnit> => {
      const proposals = await this.store.listTaskProposals(task.id);
      return { targetType: "task", targetId: task.id, version: String(task.version), updatedAt: task.updatedAt,
        evidenceIds: proposals.flatMap((proposal) => proposal.evidenceIds) };
    }));
    const projectUnits = await Promise.all(graph.projects.map(async (project: Project): Promise<ReconciliationUnit> => {
      const revisions = await this.store.listProjectRevisions(project.id);
      const proposalIds = new Set(revisions.map((revision) => revision.proposalId));
      return { targetType: "project", targetId: project.id, version: String(project.version), updatedAt: project.updatedAt,
        evidenceIds: projectProposals.filter((proposal) => proposal.projectId === project.id || proposalIds.has(proposal.id))
          .flatMap((proposal) => proposal.evidenceIds) };
    }));
    const contextUnits = entries.filter((entry: ContextEntry) => entry.lifecycleState === "accepted")
      .map((entry): ReconciliationUnit => ({ targetType: "context", targetId: entry.id,
        version: entry.contentHash, updatedAt: entry.updatedAt, evidenceIds: entry.evidenceIds }));
    return [...taskUnits, ...projectUnits, ...contextUnits].filter((unit) => unit.evidenceIds.length > 0);
  }
}
