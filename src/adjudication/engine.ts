import { contentHash } from "../domain/content-hash.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerStore } from "../domain/store.js";
import type {
  ContextEntry,
  ContextRevision,
  JsonValue,
  Proposal,
  SourceEvent,
  Task,
  TaskRevision,
} from "../domain/types.js";
import type { TeamLedger } from "../domain/team-ledger.js";
import { adjudicationBatchOutputSchema } from "./schema.js";
import type {
  AcceptedRevisionDigest,
  AdjudicationBatchInput,
  AdjudicationCase,
  AdjudicationConfig,
  AdjudicationDecision,
  AdjudicationEvidenceDigest,
  AdjudicationOutcome,
  AdjudicationProvider,
  AdjudicationRunReport,
  CompletionPolicy,
  RelatedProposalDigest,
} from "./types.js";

interface AdjudicationLog {
  info(message: string, fields?: object): void;
  error(message: string, fields?: object): void;
}

export interface AutonomousAdjudicatorOptions {
  store: LedgerStore;
  ledger: TeamLedger;
  provider: AdjudicationProvider | null;
  companyName: string;
  config: AdjudicationConfig;
  completionPolicy: CompletionPolicy;
  log: AdjudicationLog;
}

interface AdjudicationSnapshot {
  proposals: Proposal[];
  proposalById: Map<string, Proposal>;
  tasks: Task[];
  taskById: Map<string, Task>;
  taskRevisions: TaskRevision[];
  contextEntries: ContextEntry[];
  contextRevisions: ContextRevision[];
  evidenceById: Map<string, SourceEvent>;
}

interface PreflightDecision {
  action: "reject" | "supersede";
  reason: string;
  temporalBasis: string;
  historicalBasis: string[];
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function excerpt(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function asJson(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

function proposalTargetKey(proposal: Proposal): string {
  if (proposal.kind === "task_change") return `task:${proposal.taskId ?? "missing"}`;
  if (proposal.kind === "task_create") {
    const externalRef = typeof proposal.changes.externalRef === "string" ? proposal.changes.externalRef : null;
    return `task-create:${externalRef ?? contentHash(proposal.changes)}`;
  }
  const changes = proposal.changes as { path?: string; key?: string; sourceRef?: string };
  return `context:${changes.path ?? changes.key ?? changes.sourceRef ?? contentHash(changes)}`;
}

function safeProposalChanges(proposal: Proposal, maximum = 6_000): JsonValue {
  const changes = structuredClone(proposal.changes) as Record<string, unknown>;
  if (typeof changes.body === "string") changes.body = excerpt(changes.body, maximum);
  if (typeof changes.description === "string") changes.description = excerpt(changes.description, Math.min(2_000, maximum));
  return asJson(changes);
}

function safeTarget(target: Task | ContextEntry | null): JsonValue | null {
  if (!target) return null;
  if ("version" in target) return asJson({ ...target, description: excerpt(target.description, 2_000) });
  return asJson(target.kind === "file" ? { ...target, body: excerpt(target.body, 8_000) } : target);
}

function evidenceTime(ids: string[], evidenceById: Map<string, SourceEvent>): string | null {
  const values = ids.flatMap((id) => evidenceById.get(id)?.occurredAt ?? []);
  return values.length > 0 ? values.sort().at(-1)! : null;
}

function evidenceRange(ids: string[], evidenceById: Map<string, SourceEvent>): { earliest: string | null; latest: string | null } {
  const values = ids.flatMap((id) => evidenceById.get(id)?.occurredAt ?? []).sort();
  return { earliest: values[0] ?? null, latest: values.at(-1) ?? null };
}

function bounded<T>(items: T[], maximumItems: number, maximumCharacters: number): T[] {
  const kept: T[] = [];
  let used = 0;
  for (const item of items.slice(0, maximumItems)) {
    const size = JSON.stringify(item).length;
    if (kept.length > 0 && used + size > maximumCharacters) break;
    kept.push(item);
    used += size;
  }
  return kept;
}

function taskFieldChanged(revision: TaskRevision, key: string): boolean {
  if (!revision.previous) return true;
  const before = revision.previous as unknown as Record<string, unknown>;
  const after = revision.current as unknown as Record<string, unknown>;
  return JSON.stringify(before[key]) !== JSON.stringify(after[key]);
}

function currentContextFor(proposal: Proposal, entries: ContextEntry[]): ContextEntry | null {
  if (proposal.kind === "task_create" || proposal.kind === "task_change") return null;
  const changes = proposal.changes as { path?: string; key?: string; sourceRef?: string };
  return entries.find((entry) =>
    (changes.path && entry.path === changes.path) ||
    (changes.key && entry.path === changes.key) ||
    (changes.sourceRef && entry.sourceRef === changes.sourceRef)) ?? null;
}

function proposalMatchesCurrent(proposal: Proposal, target: Task | ContextEntry | null): boolean {
  if (!target) return false;
  const current = target as unknown as Record<string, unknown>;
  return Object.entries(proposal.changes).every(([key, value]) => JSON.stringify(current[key]) === JSON.stringify(value));
}

function proposalsOverlap(left: Proposal, right: Proposal): boolean {
  if (left.kind === "task_change" && right.kind === "task_change") {
    const rightKeys = new Set(Object.keys(right.changes));
    return Object.keys(left.changes).some((key) => rightKeys.has(key));
  }
  return true;
}

export class AutonomousAdjudicator {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<AdjudicationRunReport> | null = null;

  constructor(private readonly options: AutonomousAdjudicatorOptions) {}

  isConfigured(): boolean {
    return this.options.config.enabled && this.options.provider !== null;
  }

  start(): void {
    if (!this.isConfigured() || this.options.config.mode !== "interval" || this.timer) return;
    void this.run().catch((error) => {
      this.options.log.error("Autonomous adjudication startup run failed.", { error: cleanError(error) });
    });
    this.timer = setInterval(() => {
      void this.run().catch((error) => {
        this.options.log.error("Autonomous adjudication interval failed.", { error: cleanError(error) });
      });
    }, this.options.config.intervalSeconds * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  run(): Promise<AdjudicationRunReport> {
    if (this.activeRun) return this.activeRun;
    const active = this.executeRun().finally(() => {
      if (this.activeRun === active) this.activeRun = null;
    });
    this.activeRun = active;
    return active;
  }

  private async executeRun(): Promise<AdjudicationRunReport> {
    const startedAt = new Date().toISOString();
    const provider = this.options.provider;
    if (!this.options.config.enabled || !provider) {
      throw new DomainError("Autonomous adjudication is not enabled and configured.", "FORBIDDEN");
    }
    const snapshot = await this.snapshot();
    const selected = snapshot.proposals
      .filter((proposal) => proposal.state === "pending")
      .slice(0, this.options.config.maxProposalsPerRun);
    if (selected.length === 0) {
      return {
        state: "no_proposals",
        model: provider.name,
        outcomes: [],
        usage: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }

    const outcomes: AdjudicationOutcome[] = [];
    let usage: AdjudicationRunReport["usage"] = null;
    const modelProposals: Proposal[] = [];
    for (const proposal of selected) {
      const preflight = this.preflight(proposal, snapshot);
      if (preflight) {
        outcomes.push(await this.applyDecision(proposal, {
          proposalId: proposal.id,
          action: preflight.action,
          confidence: 1,
          rationale: preflight.reason,
          temporalBasis: preflight.temporalBasis,
          historicalBasis: preflight.historicalBasis,
        }, "deterministic"));
      } else {
        modelProposals.push(proposal);
      }
    }

    const historyCharactersPerCase = Math.max(
      1_000,
      Math.floor(this.options.config.maxHistoryCharacters / Math.max(1, modelProposals.length)),
    );
    const cases = modelProposals.map((proposal) =>
      this.adjudicationCase(proposal, snapshot, historyCharactersPerCase));
    if (cases.length > 0) {
      const input = this.batchInput(cases, snapshot);
      const raw = await provider.adjudicate(input);
      usage = raw.usage ?? null;
      const adjudicated = adjudicationBatchOutputSchema.parse({ decisions: raw.decisions });
      const decisionById = new Map(adjudicated.decisions.map((decision) => [decision.proposalId, decision]));
      const expectedIds = new Set(cases.map((item) => item.proposal.id));
      if (
        decisionById.size !== adjudicated.decisions.length ||
        decisionById.size !== expectedIds.size ||
        [...decisionById].some(([id]) => !expectedIds.has(id))
      ) {
        throw new Error("Adjudication must return exactly one decision for every supplied proposal.");
      }
      if (usage) {
        await this.options.store.appendAuditEvent({
          actor: `adjudicator:${provider.name}`,
          action: "model.usage",
          targetType: "adjudication_run",
          targetId: null,
          sourceEventId: null,
          proposalId: null,
          details: {
            phase: "adjudication",
            model: provider.name,
            proposalIds: cases.map((item) => item.proposal.id),
            ...usage,
          },
        });
      }
      for (const item of cases) {
        const decision = decisionById.get(item.proposal.id);
        if (!decision) throw new Error(`Adjudication omitted proposal ${item.proposal.id}.`);
        outcomes.push(await this.applyDecision(snapshot.proposalById.get(item.proposal.id)!, decision, "model"));
      }
    }

    const report: AdjudicationRunReport = {
      state: "completed",
      model: provider.name,
      outcomes,
      usage,
      startedAt,
      finishedAt: new Date().toISOString(),
    };
    this.options.log.info("Autonomous adjudication completed.", {
      proposals: selected.length,
      approved: outcomes.filter((item) => item.action === "approve").length,
      rejected: outcomes.filter((item) => item.action === "reject").length,
      superseded: outcomes.filter((item) => item.action === "supersede").length,
      escalated: outcomes.filter((item) => item.action === "escalate").length,
    });
    return report;
  }

  private async snapshot(): Promise<AdjudicationSnapshot> {
    const [proposals, tasks, taskRevisions, contextEntries, contextRevisions] = await Promise.all([
      this.options.store.listProposals(),
      this.options.store.listTasks(),
      this.options.store.listTaskRevisions(),
      this.options.store.listContextEntries(),
      this.options.store.listContextRevisions(),
    ]);
    const evidenceIds = [...new Set([
      ...proposals.flatMap((proposal) => proposal.evidenceIds),
      ...contextEntries.flatMap((entry) => entry.evidenceIds),
    ])];
    const evidence = await this.options.store.getSourceEvents(evidenceIds);
    return {
      proposals,
      proposalById: new Map(proposals.map((proposal) => [proposal.id, proposal])),
      tasks,
      taskById: new Map(tasks.map((task) => [task.id, task])),
      taskRevisions,
      contextEntries,
      contextRevisions,
      evidenceById: new Map(evidence.map((event) => [event.id, event])),
    };
  }

  private preflight(proposal: Proposal, snapshot: AdjudicationSnapshot): PreflightDecision | null {
    const activeEvidence = proposal.evidenceIds.flatMap((id) => snapshot.evidenceById.get(id) ?? []);
    if (activeEvidence.length !== proposal.evidenceIds.length) {
      return {
        action: "supersede",
        reason: "One or more cited evidence receipts are no longer active, so this proposal cannot become accepted state.",
        temporalBasis: "The candidate depends on evidence that was revoked or overtaken before adjudication.",
        historicalBasis: ["Revoked evidence remains in lineage but cannot support a current-state mutation."],
      };
    }

    if (proposal.kind === "task_change" && proposal.taskId) {
      const task = snapshot.taskById.get(proposal.taskId);
      if (!task) {
        return {
          action: "reject",
          reason: "The proposal targets a task that no longer exists.",
          temporalBasis: "No current target exists at adjudication time.",
          historicalBasis: [],
        };
      }
      if (proposalMatchesCurrent(proposal, task)) {
        return {
          action: "supersede",
          reason: "Accepted task state already contains every proposed value.",
          temporalBasis: "The proposal no longer changes the current projection.",
          historicalBasis: [`Task ${task.id} is already at version ${task.version} with these values.`],
        };
      }
      if (proposal.changes.status === "done") {
        const providers = new Set(activeEvidence.map((event) => event.provider));
        const delivery = this.options.completionPolicy.evidenceProviders.some((provider) => providers.has(provider));
        if (new Set(activeEvidence.map((event) => event.id)).size < this.options.completionPolicy.minimumEvidenceItems || !delivery) {
          return {
            action: "reject",
            reason: "Completion lacks the configured corroboration and delivery-evidence provider.",
            temporalBasis: "The available receipts do not establish that delivery was complete at the claimed time.",
            historicalBasis: ["A task may be active or asserted complete without satisfying the completion evidence gate."],
          };
        }
      }
      const candidateLatest = evidenceRange(proposal.evidenceIds, snapshot.evidenceById).latest;
      const laterRevisions = snapshot.taskRevisions.filter((revision) =>
        revision.taskId === proposal.taskId && revision.version > (proposal.baseVersion ?? 0));
      const overlapping = laterRevisions.some((revision) =>
        Object.keys(proposal.changes).some((key) => taskFieldChanged(revision, key)));
      const acceptedLatest = evidenceTime(
        laterRevisions.flatMap((revision) => snapshot.proposalById.get(revision.proposalId)?.evidenceIds ?? []),
        snapshot.evidenceById,
      );
      if (overlapping && candidateLatest && acceptedLatest && candidateLatest < acceptedLatest) {
        return {
          action: "supersede",
          reason: "Newer accepted evidence already changed one or more of the same task fields.",
          temporalBasis: `Candidate evidence is latest at ${candidateLatest}; overlapping accepted evidence is latest at ${acceptedLatest}.`,
          historicalBasis: laterRevisions.map((revision) => `Accepted task revision ${revision.version} at ${revision.appliedAt}.`),
        };
      }
    }

    if (proposal.kind === "task_create") {
      const externalRef = typeof proposal.changes.externalRef === "string" ? proposal.changes.externalRef : null;
      if (externalRef && snapshot.tasks.some((task) => task.externalRef === externalRef)) {
        return {
          action: "supersede",
          reason: "A task from this external source reference already exists in accepted state.",
          temporalBasis: "The proposed creation is no longer a new work item.",
          historicalBasis: [`Accepted task source reference: ${externalRef}.`],
        };
      }
    }

    const context = currentContextFor(proposal, snapshot.contextEntries);
    if (context) {
      const proposedSourceRef = (proposal.changes as { sourceRef?: string }).sourceRef;
      if (proposedSourceRef && proposedSourceRef !== context.sourceRef) {
        return {
          action: "reject",
          reason: "The proposed context path belongs to a different accepted source lineage.",
          temporalBasis: "Chronology cannot transfer path ownership between unrelated source references.",
          historicalBasis: [`Accepted path ${context.path} belongs to ${context.sourceRef}.`],
        };
      }
      if (proposalMatchesCurrent(proposal, context)) {
        return {
          action: "supersede",
          reason: "Accepted context already contains the proposed value.",
          temporalBasis: "The proposal no longer changes the current context projection.",
          historicalBasis: [`Accepted context path ${context.path} was updated at ${context.updatedAt}.`],
        };
      }
      const candidateLatest = evidenceRange(proposal.evidenceIds, snapshot.evidenceById).latest;
      const acceptedLatest = evidenceTime(context.evidenceIds, snapshot.evidenceById);
      if (candidateLatest && acceptedLatest && candidateLatest < acceptedLatest) {
        return {
          action: "supersede",
          reason: "The context path is already backed by later active evidence.",
          temporalBasis: `Candidate evidence is latest at ${candidateLatest}; accepted evidence is latest at ${acceptedLatest}.`,
          historicalBasis: [`Accepted context path ${context.path} is newer than this proposal.`],
        };
      }
    }

    const targetKey = proposalTargetKey(proposal);
    const candidateLatest = evidenceRange(proposal.evidenceIds, snapshot.evidenceById).latest;
    const newerRelated = snapshot.proposals.find((candidate) =>
      candidate.id !== proposal.id &&
      candidate.state === "pending" &&
      proposalTargetKey(candidate) === targetKey &&
      proposalsOverlap(candidate, proposal) &&
      candidate.createdAt > proposal.createdAt &&
      (!candidateLatest || (evidenceTime(candidate.evidenceIds, snapshot.evidenceById) ?? candidate.createdAt) >= candidateLatest));
    if (newerRelated) {
      return {
        action: "supersede",
        reason: "A newer open proposal addresses the same target with equally recent or later evidence.",
        temporalBasis: `Proposal ${newerRelated.id} was created later for the same target.`,
        historicalBasis: ["Panini retains this proposal in history and adjudicates the newer account."],
      };
    }
    return null;
  }

  private adjudicationCase(
    proposal: Proposal,
    snapshot: AdjudicationSnapshot,
    maximumHistoryCharacters: number,
  ): AdjudicationCase {
    const targetKey = proposalTargetKey(proposal);
    const current = proposal.taskId
      ? snapshot.taskById.get(proposal.taskId) ?? null
      : currentContextFor(proposal, snapshot.contextEntries);
    const historyBudget = Math.floor(maximumHistoryCharacters / 2);
    let acceptedHistory: AcceptedRevisionDigest[];
    if (proposal.taskId) {
      acceptedHistory = snapshot.taskRevisions
        .filter((revision) => revision.taskId === proposal.taskId)
        .sort((left, right) => right.version - left.version)
        .map((revision) => ({
          version: revision.version,
          proposalId: revision.proposalId,
          appliedAt: revision.appliedAt,
          appliedBy: revision.appliedBy,
          snapshot: safeTarget(revision.current)!,
          evidenceOccurredAt: evidenceTime(snapshot.proposalById.get(revision.proposalId)?.evidenceIds ?? [], snapshot.evidenceById),
        }));
    } else {
      acceptedHistory = snapshot.contextRevisions
        .filter((revision) => proposalTargetKey({
          ...proposal,
          changes: revision.current.kind === "file"
            ? { sourceRef: revision.current.sourceRef, path: revision.current.path, title: revision.current.title, body: revision.current.body, sourceUrl: revision.current.sourceUrl }
            : { sourceRef: revision.current.sourceRef, path: revision.current.path, title: revision.current.title, factType: revision.current.factType, value: revision.current.value, sourceUrl: revision.current.sourceUrl },
        } as Proposal) === targetKey)
        .sort((left, right) => right.version - left.version)
        .map((revision) => ({
          version: revision.version,
          proposalId: revision.proposalId,
          appliedAt: revision.appliedAt,
          appliedBy: revision.appliedBy,
          snapshot: safeTarget(revision.current)!,
          evidenceOccurredAt: evidenceTime(revision.current.evidenceIds, snapshot.evidenceById),
        }));
    }
    acceptedHistory = bounded(acceptedHistory, this.options.config.maxHistoryItems, historyBudget);

    const relatedProposals: RelatedProposalDigest[] = bounded(
      snapshot.proposals
        .filter((candidate) => candidate.id !== proposal.id && proposalTargetKey(candidate) === targetKey)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
        .map((candidate) => ({
          id: candidate.id,
          state: candidate.state,
          kind: candidate.kind,
          changes: safeProposalChanges(candidate),
          rationale: excerpt(candidate.rationale, 2_000),
          requestedBy: candidate.requestedBy,
          createdAt: candidate.createdAt,
          decidedAt: candidate.decidedAt,
          decisionNote: candidate.decisionNote ? excerpt(candidate.decisionNote, 2_000) : null,
          evidenceOccurredAt: evidenceTime(candidate.evidenceIds, snapshot.evidenceById),
        })),
      this.options.config.maxHistoryItems,
      historyBudget,
    );
    const currentEvidenceIds = current && "evidenceIds" in current
      ? current.evidenceIds
      : acceptedHistory[0]
        ? snapshot.proposalById.get(acceptedHistory[0].proposalId)?.evidenceIds ?? []
        : [];
    return {
      proposal: {
        id: proposal.id,
        kind: proposal.kind,
        taskId: proposal.taskId,
        baseVersion: proposal.baseVersion,
        changes: safeProposalChanges(proposal),
        rationale: excerpt(proposal.rationale, 4_000),
        requestedBy: proposal.requestedBy,
        evidenceIds: proposal.evidenceIds,
        createdAt: proposal.createdAt,
      },
      targetKey,
      staleBase: proposal.kind === "task_change" && Boolean(current && "version" in current && current.version !== proposal.baseVersion),
      currentTarget: safeTarget(current),
      acceptedHistory,
      relatedProposals,
      candidateEvidenceOccurredAt: evidenceRange(proposal.evidenceIds, snapshot.evidenceById),
      currentEvidenceOccurredAt: evidenceTime(currentEvidenceIds, snapshot.evidenceById),
    };
  }

  private batchInput(cases: AdjudicationCase[], snapshot: AdjudicationSnapshot): AdjudicationBatchInput {
    const ids = [...new Set(cases.flatMap((item) => [
      ...item.proposal.evidenceIds,
      ...item.relatedProposals.flatMap((related) => snapshot.proposalById.get(related.id)?.evidenceIds ?? []),
    ]))];
    const events = ids.flatMap((id) => snapshot.evidenceById.get(id) ?? []);
    const perEvent = Math.max(1, Math.floor(this.options.config.maxEvidenceCharacters / Math.max(1, events.length)));
    const evidence: AdjudicationEvidenceDigest[] = events.map((event) => ({
      id: event.id,
      provider: event.provider,
      eventKind: event.eventKind,
      occurredAt: event.occurredAt,
      fetchedAt: event.fetchedAt,
      receivedAt: event.receivedAt,
      sourceRef: event.sourceRef,
      sourceUrl: event.sourceUrl,
      payloadExcerpt: excerpt(JSON.stringify(event.payload), perEvent),
    }));
    return {
      companyName: this.options.companyName,
      adjudicatedAt: new Date().toISOString(),
      evidence,
      cases,
    };
  }

  private async applyDecision(
    proposal: Proposal,
    original: AdjudicationDecision,
    source: "deterministic" | "model",
  ): Promise<AdjudicationOutcome> {
    let decision = original;
    if (decision.action === "approve" && decision.confidence < this.options.config.approvalMinimumConfidence) {
      decision = {
        ...decision,
        action: "escalate",
        rationale: `Approval confidence ${decision.confidence.toFixed(2)} is below the configured ${this.options.config.approvalMinimumConfidence.toFixed(2)} threshold. ${decision.rationale}`,
        historicalBasis: [...decision.historicalBasis, "Low-confidence acceptance requires exceptional human review."],
      };
    }
    const providerName = this.options.provider?.name ?? "deterministic";
    const note = excerpt([
      decision.rationale,
      `Temporal basis: ${decision.temporalBasis}`,
      decision.historicalBasis.length > 0 ? `Historical basis: ${decision.historicalBasis.join(" ")}` : "",
    ].filter(Boolean).join(" "), 8_000);
    const result = await this.options.ledger.adjudicateProposal(proposal.id, {
      action: decision.action,
      actor: source === "model" ? `adjudicator:${providerName}` : "adjudicator:deterministic",
      note,
      details: {
        model: providerName,
        decisionSource: source,
        confidence: decision.confidence,
        temporalBasis: decision.temporalBasis,
        historicalBasis: decision.historicalBasis,
      },
    });
    return {
      proposalId: proposal.id,
      action: decision.action,
      state: result.proposal.state,
      confidence: decision.confidence,
      reason: decision.rationale,
      source,
      replacementProposalId: result.replacedProposalId ? result.proposal.id : null,
    };
  }
}
