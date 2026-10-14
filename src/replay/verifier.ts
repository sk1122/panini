import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { LedgerStore } from "../domain/store.js";
import type { ContextEntry, ContextRevision, JsonValue, Task, TaskRevision,
  WorkLink, WorkLinkRevision } from "../domain/types.js";

export interface ProjectionVerification {
  projectionCount: number;
  replayedCount: number;
  projectionHash: string;
  replayedHash: string;
  missingFromProjection: string[];
  unexpectedInProjection: string[];
  contentMismatches: string[];
  ok: boolean;
}

export interface ReplayVerification {
  ok: boolean;
  generatedAt: string;
  tasks: ProjectionVerification;
  context: ProjectionVerification;
  links: ProjectionVerification;
  legacyLinkIdsWithoutRevision: string[];
}

export interface ReplayRebuildResult {
  applied: boolean;
  eligible: boolean;
  reason: string;
  before: ReplayVerification;
  after: ReplayVerification;
}

function canonical(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function projectionHash<T extends { id: string }>(records: T[]): string {
  const ordered = records.toSorted((left, right) => left.id.localeCompare(right.id));
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(ordered)) as JsonValue)).digest("hex");
}

function compareProjection<T extends { id: string }>(projection: T[], replayed: T[]): ProjectionVerification {
  const currentById = new Map(projection.map((record) => [record.id, record]));
  const replayedById = new Map(replayed.map((record) => [record.id, record]));
  const missingFromProjection = [...replayedById.keys()].filter((id) => !currentById.has(id)).sort();
  const unexpectedInProjection = [...currentById.keys()].filter((id) => !replayedById.has(id)).sort();
  const contentMismatches = [...currentById.keys()].filter((id) => {
    const expected = replayedById.get(id);
    return expected !== undefined && canonical(currentById.get(id) as unknown as JsonValue) !== canonical(expected as unknown as JsonValue);
  }).sort();
  const currentHash = projectionHash(projection);
  const replayedHash = projectionHash(replayed);
  return {
    projectionCount: projection.length,
    replayedCount: replayed.length,
    projectionHash: currentHash,
    replayedHash,
    missingFromProjection,
    unexpectedInProjection,
    contentMismatches,
    ok: missingFromProjection.length === 0 && unexpectedInProjection.length === 0 && contentMismatches.length === 0 && currentHash === replayedHash,
  };
}

function latestTaskRevisions(revisions: TaskRevision[]): Task[] {
  const latest = new Map<string, TaskRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.taskId);
    if (!current || revision.version > current.version) latest.set(revision.taskId, revision);
  }
  return [...latest.values()].map((revision) => revision.current);
}

function latestContextRevisions(revisions: ContextRevision[]): ContextEntry[] {
  const latest = new Map<string, ContextRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.contextEntryId);
    if (!current || revision.version > current.version) latest.set(revision.contextEntryId, revision);
  }
  return [...latest.values()].map((revision) => revision.current);
}

function latestWorkLinkRevisions(revisions: WorkLinkRevision[]): WorkLink[] {
  const latest = new Map<string, WorkLinkRevision>();
  for (const revision of revisions) {
    const current = latest.get(revision.linkId);
    if (!current || revision.version > current.version) latest.set(revision.linkId, revision);
  }
  return [...latest.values()].map((revision) => revision.current);
}

export class ReplayVerifier {
  constructor(private readonly store: LedgerStore) {}

  private async snapshot(): Promise<{
    verification: ReplayVerification;
    replayedTasks: Task[];
    replayedContext: ContextEntry[];
  }> {
    const [tasks, context, contextRevisions, links, linkRevisions] = await Promise.all([
      this.store.listTasks(),
      this.store.listContextEntries(),
      this.store.listContextRevisions(),
      this.store.listWorkLinks(),
      this.store.listWorkLinkRevisions(),
    ]);
    const taskRevisions = await this.store.listTaskRevisions();
    const replayedTasks = latestTaskRevisions(taskRevisions);
    const replayedContextCandidates = latestContextRevisions(contextRevisions);
    const evidenceIds = [...new Set(replayedContextCandidates.map((entry) => entry.sourceEventId))];
    const activeEvidence = new Set((await this.store.getSourceEvents(evidenceIds)).map((event) => event.id));
    const replayedContext = replayedContextCandidates.filter((entry) => activeEvidence.has(entry.sourceEventId));
    const taskResult = compareProjection(tasks, replayedTasks);
    const contextResult = compareProjection(context, replayedContext);
    const linkResult = compareProjection(links, latestWorkLinkRevisions(linkRevisions));
    const verification = {
      ok: taskResult.ok && contextResult.ok && linkResult.ok,
      generatedAt: new Date().toISOString(),
      tasks: taskResult,
      context: contextResult,
      links: linkResult,
      legacyLinkIdsWithoutRevision: linkResult.unexpectedInProjection,
    };
    return { verification, replayedTasks, replayedContext };
  }

  async verify(): Promise<ReplayVerification> {
    return (await this.snapshot()).verification;
  }

  async rebuild(input: { apply: boolean; actor: string }): Promise<ReplayRebuildResult> {
    const snapshot = await this.snapshot();
    const before = snapshot.verification;
    const unexpected = [...before.tasks.unexpectedInProjection, ...before.context.unexpectedInProjection,
      ...before.links.unexpectedInProjection];
    const eligible = unexpected.length === 0 && before.links.ok;
    if (!input.apply) {
      return {
        applied: false,
        eligible,
        reason: eligible
          ? before.ok ? "Projection already matches immutable revision history." : "Shadow projection is valid and can be applied."
          : "Current projection contains rows with no immutable revision; rebuild is fail-closed.",
        before,
        after: before,
      };
    }
    if (!eligible) {
      throw new DomainError(
        "Projection rebuild refused because current rows exist without immutable revision history.",
        "CONFLICT",
      );
    }
    await this.store.rebuildCurrentProjections({
      tasks: snapshot.replayedTasks,
      context: snapshot.replayedContext,
      actor: input.actor,
      details: {
        taskCount: snapshot.replayedTasks.length,
        contextCount: snapshot.replayedContext.length,
        previousTaskHash: before.tasks.projectionHash,
        replayedTaskHash: before.tasks.replayedHash,
        previousContextHash: before.context.projectionHash,
        replayedContextHash: before.context.replayedHash,
      },
    });
    const after = await this.verify();
    if (!after.ok) {
      throw new DomainError("Projection rebuild completed but post-apply verification failed.", "CONFLICT");
    }
    return {
      applied: true,
      eligible: true,
      reason: before.ok ? "Verified and re-applied the existing projection." : "Rebuilt the current projection from immutable revisions.",
      before,
      after,
    };
  }
}
