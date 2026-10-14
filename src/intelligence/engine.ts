import { contentHash } from "../domain/content-hash.js";
import { DomainError } from "../domain/errors.js";
import { isInterpretationEligibleSourceEvent } from "../domain/source-event-policy.js";
import type { JsonValue, Member, SourceEvent, Task, TaskProposalChanges } from "../domain/types.js";
import { interpretationOutputSchema } from "./schema.js";
import { preservePrimarySourceDiagram } from "./source-document.js";
import { eventText } from "../reconciliation/evidence-bundle.js";
import type {
  ContextDigest,
  EvidenceDigest,
  EvidenceIntelligenceOptions,
  FindingOutcome,
  IntelligenceRunReport,
  IntelligenceRunRequest,
  InterpretationFinding,
  InterpretationOutput,
  ObservationRouteDecision,
  TaskDigest,
} from "./types.js";

function excerpt(value: string, maximum: number): string {
  if (maximum <= 0) return "";
  return value.length <= maximum ? value : `${value.slice(0, Math.max(0, maximum - 1))}…`;
}

function payloadText(event: SourceEvent): string {
  try {
    if (
      event.eventKind === "source.document.retrieved" &&
      event.payload && typeof event.payload === "object" && !Array.isArray(event.payload) &&
      event.payload.document && typeof event.payload.document === "object" && !Array.isArray(event.payload.document)
    ) {
      return JSON.stringify(event.payload.document);
    }
    return JSON.stringify(event.payload);
  } catch {
    return "[unserializable payload]";
  }
}

function taskDigest(task: Task): TaskDigest {
  return {
    id: task.id,
    title: task.title,
    description: excerpt(task.description, 2_000),
    status: task.status,
    priority: task.priority,
    owner: task.owner,
    project: task.project,
    dueDate: task.dueDate,
    dependencyRefs: task.dependencyRefs,
    version: task.version,
  };
}

function eventDigests(
  events: SourceEvent[],
  maximum: number,
  routes: Map<string, ObservationRouteDecision>,
): EvidenceDigest[] {
  const perEvent = Math.max(1, Math.floor(maximum / events.length));
  return events.map((event) => {
    const payloadExcerpt = excerpt(payloadText(event), perEvent);
    return {
      id: event.id,
      provider: event.provider,
      eventKind: event.eventKind,
      occurredAt: event.occurredAt,
      sourceRef: event.sourceRef,
      sourceUrl: event.sourceUrl,
      payloadExcerpt,
      route: routes.get(event.id)?.route ?? "both",
      routeConfidence: routes.get(event.id)?.confidence ?? 1,
    };
  });
}

function contextDigests(
  entries: Awaited<ReturnType<EvidenceIntelligenceOptions["ledger"]["retrieve"]>>["entries"],
  maximum: number,
): ContextDigest[] {
  const perEntry = Math.max(1, Math.floor(maximum / Math.max(1, entries.length)));
  return entries.map((entry) => {
    return {
      kind: entry.kind,
      path: entry.path,
      title: entry.title,
      contentExcerpt: excerpt(entry.kind === "file" ? entry.body : String(entry.value), perEntry),
      factType: entry.kind === "fact" ? entry.factType : null,
      sourceUrl: entry.sourceUrl,
      updatedAt: entry.updatedAt,
    };
  });
}

function retrievalObjective(events: SourceEvent[]): string {
  return excerpt(events.map((event) => [
    event.provider,
    event.eventKind,
    event.sourceRef,
    payloadText(event),
  ].join(" ")).join("\n"), 12_000);
}

function slackThreadRootRef(event: SourceEvent): string | null {
  if (event.provider !== "slack" || !event.payload || typeof event.payload !== "object"
    || Array.isArray(event.payload)) return null;
  const payload = event.payload as Record<string, unknown>;
  const { teamId, channel, messageTs, threadTs } = payload;
  if (typeof teamId !== "string" || typeof channel !== "string" || typeof messageTs !== "string"
    || typeof threadTs !== "string" || !threadTs || threadTs === messageTs) return null;
  return `slack:${teamId}:${channel}:${threadTs}`;
}

function isAttendanceOnlyRequest(event: SourceEvent): boolean {
  if (event.provider !== "slack" || !event.payload || typeof event.payload !== "object"
    || Array.isArray(event.payload)) return false;
  const text = (event.payload as Record<string, unknown>).text;
  if (typeof text !== "string") return false;
  const message = text.replace(/<@[^>]+>/g, " ").trim();
  return /^(?:please\s+)?(?:join|attend|hop on)\s+(?:(?:the|our|a)\s+)?(?:daily\s+)?(?:standup|stand-up|meeting|call|sync)(?:\s+(?:today|tomorrow|now|at\s+\d{1,2}(?::\d{2})?(?:\s*[ap]m)?))?[.!?]*$/i.test(message);
}

function relevantProjects(
  projects: Awaited<ReturnType<EvidenceIntelligenceOptions["ledger"]["workGraph"]>>["projects"],
  tasks: Task[],
  query: string,
) {
  const taskProjects = new Set(tasks.flatMap((task) => task.project ? [task.project.toLocaleLowerCase()] : []));
  const terms = new Set(query.toLocaleLowerCase().match(/[\p{L}\p{N}][\p{L}\p{N}._/-]*/gu) ?? []);
  const scored = projects.map((project) => {
    const names = [project.name, ...project.aliases].map((value) => value.toLocaleLowerCase());
    const taskMatch = names.some((name) => taskProjects.has(name));
    const lexical = names.reduce((score, name) => score + [...terms].filter((term) => name.includes(term)).length, 0);
    return { project, score: taskMatch ? 1_000 + lexical : lexical };
  }).sort((left, right) => right.score - left.score || right.project.updatedAt.localeCompare(left.project.updatedAt));
  const matched = scored.filter(({ score }) => score > 0);
  return (matched.length > 0 ? matched : scored).slice(0, 10).map(({ project }) => project);
}

function cleanError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function activeMemberName(owner: string | null, members: Member[]): string | null {
  if (!owner) return null;
  const normalized = owner.trim().toLocaleLowerCase();
  return members.find((member) =>
    member.status === "active" && member.displayName.trim().toLocaleLowerCase() === normalized)?.displayName ?? null;
}

function sourceSelectorMatches(event: SourceEvent, selectors: string[]): boolean {
  return isInterpretationEligibleSourceEvent(event) && selectors.some((selector) => {
    const separator = selector.indexOf(":");
    return separator < 0
      ? event.provider === selector
      : event.provider === selector.slice(0, separator) && event.eventKind === selector.slice(separator + 1);
  });
}

function sourceCoverage(workspace: Awaited<ReturnType<EvidenceIntelligenceOptions["ledger"]["workspace"]>>, asOf: string) {
  const asOfTime = new Date(asOf).getTime();
  if (!Number.isFinite(asOfTime)) throw new DomainError("Coverage cutoff is not a valid timestamp.", "INVALID");
  const activeInstallations = workspace.installations.filter((installation) =>
    installation.status !== "disabled" && installation.status !== "revoked");
  const installationById = new Map(activeInstallations.map((installation) => [installation.id, installation]));
  const requiredSyncs = workspace.connectorSyncs.filter((sync) =>
    sync.resourceKey !== "member-directory" && installationById.has(sync.installationId));
  const stale = (provider: string, lastSuccessAt: string | null) =>
    (provider === "github" || provider === "notion")
    && (!lastSuccessAt || asOfTime - new Date(lastSuccessAt).getTime() > 45 * 60_000);
  const gaps: Array<{ provider: string; resource: string; status: string; reason: string | null }> = requiredSyncs.flatMap((sync) => {
    const provider = installationById.get(sync.installationId)?.provider ?? "unknown";
    const isStale = stale(provider, sync.lastSuccessAt);
    if ((sync.status === "healthy" || sync.status === "idle") && !isStale) return [];
    return [{ provider, resource: sync.resourceKey,
      status: isStale ? "stale" : sync.status,
      reason: sync.lastError ?? (isStale ? "The last successful source checkpoint is older than 45 minutes." : null) }];
  });
  for (const installation of activeInstallations) {
    const installationSyncs = requiredSyncs.filter((sync) => sync.installationId === installation.id);
    const configuredWithHealthyCoverage = installation.status === "configured"
      && installationSyncs.length > 0
      && installationSyncs.every((sync) => sync.status === "healthy" && !stale(installation.provider, sync.lastSuccessAt));
    if (configuredWithHealthyCoverage) continue;
    const isStale = stale(installation.provider, installation.lastSuccessAt);
    if ((installation.status !== "healthy" || isStale)
      && !gaps.some((gap) => gap.provider === installation.provider && gap.resource === installation.installationKey)) {
      gaps.push({ provider: installation.provider, resource: installation.installationKey,
        status: isStale ? "stale" : installation.status,
        reason: installation.lastError ?? (isStale ? "The last successful source poll is older than 45 minutes." : null) });
    }
  }
  return { complete: gaps.length === 0, gaps };
}

export class EvidenceIntelligence {
  private timer: NodeJS.Timeout | null = null;
  private activeRun: Promise<IntelligenceRunReport> | null = null;
  private readonly routeCache = new Map<string, ObservationRouteDecision>();

  constructor(private readonly options: EvidenceIntelligenceOptions) {}

  isConfigured(): boolean {
    return this.options.config.enabled && this.options.interpreter !== null;
  }

  record(input: Parameters<EvidenceIntelligenceOptions["store"]["appendSourceEvent"]>[0]) {
    return this.options.store.appendSourceEvent(input);
  }

  listRuns(limit = 25) {
    return this.options.store.listInterpretationRuns(limit);
  }

  /** Re-evaluates one saved rejected finding without invoking the interpreter. */
  async rejudgeStoredFinding(run: import("./types.js").InterpretationRun, index: number): Promise<FindingOutcome> {
    if (run.state !== "completed" || !run.output || typeof run.output !== "object"
      || Array.isArray(run.output)) throw new DomainError("A completed saved interpretation is required.", "INVALID");
    const output = run.output as Record<string, JsonValue>;
    const interpretation = interpretationOutputSchema.parse(output.interpretation);
    const finding = interpretation.findings[index];
    const prior = Array.isArray(output.outcomes) ? output.outcomes[index] : null;
    if (!finding || !prior || typeof prior !== "object" || Array.isArray(prior)
      || prior.state !== "rejected") throw new DomainError("Only a saved rejected finding can be re-gated.", "INVALID");
    const routes = new Map<string, ObservationRouteDecision>();
    if (!Array.isArray(output.routes)) throw new DomainError("Saved Jev routes are missing.", "INVALID");
    for (const value of output.routes) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const route = value as Record<string, JsonValue>;
      if (typeof route.eventId === "string"
        && (route.route === "task" || route.route === "information" || route.route === "both" || route.route === "neither")
        && typeof route.confidence === "number") {
        routes.set(route.eventId, { eventId: route.eventId, route: route.route, confidence: route.confidence });
      }
    }
    const [events, workspace] = await Promise.all([
      this.options.store.getSourceEvents(run.eventIds), this.options.ledger.workspace(),
    ]);
    return this.applyFinding(index, finding, events, workspace.members, routes,
      sourceCoverage(workspace, this.options.coverageAsOf ?? run.createdAt).complete);
  }

  start(): void {
    if (!this.isConfigured() || this.options.config.mode !== "interval" || this.timer) return;
    this.timer = setInterval(() => {
      void this.run().catch((error) => {
        this.options.log.error("Evidence interpretation interval failed.", { error: cleanError(error) });
      });
    }, this.options.config.intervalSeconds * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  run(request: IntelligenceRunRequest = {}): Promise<IntelligenceRunReport> {
    if (this.activeRun) {
      return request.eventIds?.length
        ? Promise.reject(new DomainError("An interpretation run is already active; targeted refresh will retry.", "CONFLICT"))
        : this.activeRun;
    }
    const active = this.executeRun(request).finally(() => {
      if (this.activeRun === active) this.activeRun = null;
    });
    this.activeRun = active;
    return active;
  }

  private async routeEvents(events: SourceEvent[]): Promise<ObservationRouteDecision[]> {
    if (!this.options.router) {
      return events.map((event) => ({ eventId: event.id, route: "both" as const, confidence: 1 }));
    }
    const missing = events.filter((event) => !this.routeCache.has(event.id));
    if (missing.length > 0) {
      for (const decision of await this.options.router.route(missing)) {
        this.routeCache.set(decision.eventId, decision);
      }
    }
    return events.map((event) => this.routeCache.get(event.id)!);
  }

  private async executeRun(request: IntelligenceRunRequest): Promise<IntelligenceRunReport> {
    const startedAt = new Date().toISOString();
    const interpreter = this.options.interpreter;
    if (!this.options.config.enabled || !interpreter) {
      throw new DomainError("Evidence intelligence is not enabled and configured.", "FORBIDDEN");
    }

    const requestedIds = [...new Set(request.eventIds ?? [])];
    if (requestedIds.length > 20) throw new DomainError("A targeted interpretation run accepts at most 20 evidence IDs.", "INVALID");
    const documentSelectors = this.options.config.sourceProviders.filter((selector) => selector.endsWith(":source.document.retrieved"));
    const explicitlyRequested = requestedIds.length > 0
      ? await this.options.store.getSourceEvents(requestedIds)
      : [];
    if (requestedIds.length > 0 && explicitlyRequested.length !== requestedIds.length) {
      throw new DomainError("One or more targeted evidence IDs are unavailable or revoked.", "NOT_FOUND");
    }
    if (explicitlyRequested.some((event) => !sourceSelectorMatches(event, this.options.config.sourceProviders))) {
      throw new DomainError("Targeted evidence is not enabled for interpretation.", "FORBIDDEN");
    }
    const documentEvents = explicitlyRequested.length > 0
      ? explicitlyRequested.filter((event) => event.eventKind === "source.document.retrieved")
      : documentSelectors.length > 0
        ? await this.options.store.listUninterpretedSourceEvents(documentSelectors, 1, interpreter.name)
        : [];
    let episodeGrouping: "explicit" | "semantic" | "single" | "information_batch" =
      explicitlyRequested.length > 1 ? "explicit" : "single";
    let preselectedRoutes: ObservationRouteDecision[] | null = null;
    let events: SourceEvent[];
    if (explicitlyRequested.length > 0) {
      events = explicitlyRequested;
    } else if (documentEvents.length > 0) {
      events = documentEvents;
    } else {
      const pool = await this.options.store.listUninterpretedSourceEvents(
        this.options.config.sourceProviders,
        Math.min(200, this.options.config.maxEventsPerRun * 4),
        interpreter.name,
      );
      if (this.options.episodeGrouper) {
        const episodes = await this.options.episodeGrouper.group(pool, this.options.config.maxEventsPerRun);
        const lookahead: typeof episodes = [];
        const batchLimit = Math.min(12, this.options.config.maxEventsPerRun);
        let lookaheadSize = 0;
        for (const episode of episodes) {
          if (lookaheadSize > 0 && lookaheadSize + episode.events.length > batchLimit) break;
          lookahead.push(episode);
          lookaheadSize += episode.events.length;
          if (lookaheadSize >= batchLimit) break;
        }
        const lookaheadEvents = lookahead.flatMap((episode) => episode.events);
        const lookaheadRoutes = await this.routeEvents(lookaheadEvents);
        const routeById = new Map(lookaheadRoutes.map((route) => [route.eventId, route]));
        const firstWorkIndex = lookahead.findIndex((episode) => episode.events.some((event) => {
          const route = routeById.get(event.id)?.route;
          return route === "task" || route === "both";
        }));
        const selected = firstWorkIndex === 0 ? lookahead.slice(0, 1)
          : firstWorkIndex < 0 ? lookahead : lookahead.slice(0, firstWorkIndex);
        events = selected.flatMap((episode) => episode.events)
          .sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
            || left.receivedAt.localeCompare(right.receivedAt));
        preselectedRoutes = events.map((event) => routeById.get(event.id)!);
        episodeGrouping = selected.length > 1 ? "information_batch" : selected[0]?.grouping ?? "single";
      } else {
        events = pool.slice(0, this.options.config.maxEventsPerRun);
      }
    }
    if (events.length === 0) {
      return {
        id: null,
        state: "no_evidence",
        model: interpreter.name,
        eventIds: [],
        summary: "No uninterpreted evidence is available.",
        outcomes: [],
        usage: null,
        startedAt,
        finishedAt: new Date().toISOString(),
      };
    }
    const initialEventIds = new Set(events.map((event) => event.id));
    const initialRoutes = preselectedRoutes ?? await this.routeEvents(events);
    events = await this.includeSlackThreadRoots(events, new Map(initialRoutes.map((route) => [route.eventId, route])));
    const retainedIds = new Set(events.map((event) => event.id));
    const threadRoots = events.filter((event) => !initialEventIds.has(event.id));
    const rootRoutes = threadRoots.length > 0 ? await this.routeEvents(threadRoots) : [];
    const routeDecisions = [...initialRoutes.filter((route) => retainedIds.has(route.eventId)), ...rootRoutes];
    const routeById = new Map(routeDecisions.map((decision) => [decision.eventId, decision]));
    const routedEvents = events.filter((event) => routeById.get(event.id)?.route !== "neither");
    // An informational observation can still update an existing Task. Retrieval only
    // proposes candidates; the exact target is judged again before any write.
    const directlyRoutedWork = routedEvents.filter((event) => {
      const route = routeById.get(event.id)?.route;
      return route === "task" || route === "both";
    });
    const workEvents = directlyRoutedWork.length > 0 ? directlyRoutedWork : routedEvents;
    const hasTaskRoute = workEvents.length > 0;
    const hasInformationRoute = routeDecisions.some((decision) => decision.route === "information" || decision.route === "both");

    const objective = retrievalObjective(routedEvents);
    const [pack, workspace, graph] = await Promise.all([
      this.options.ledger.retrieve({
        objective: objective || "Identify relevant company work and durable information.",
        limit: 10,
        characterBudget: this.options.config.maxContextCharacters,
      }),
      this.options.ledger.workspace(),
      this.options.ledger.workGraph(),
    ]);
    const identitiesByMember = new Map<string, typeof workspace.memberIdentities>();
    for (const identity of workspace.memberIdentities) {
      if (!identity.memberId) continue;
      const identities = identitiesByMember.get(identity.memberId) ?? [];
      identities.push(identity);
      identitiesByMember.set(identity.memberId, identities);
    }
    const entityRetrieval = hasTaskRoute && this.options.entityRetriever
      ? await this.options.entityRetriever.retrieve(retrievalObjective(workEvents), graph.tasks, graph.projects)
      : null;
    const candidateTasks = entityRetrieval?.tasks ?? pack.tasks;
    const candidateProjects = entityRetrieval?.projects
      ?? relevantProjects(graph.projects, candidateTasks, objective);
    const input = {
      companyName: this.options.companyName,
      projects: hasTaskRoute ? candidateProjects.map((project) => ({
        id: project.id,
        name: project.name,
        aliases: project.aliases,
        outcome: project.outcome,
        owner: project.owner,
        status: project.status,
        version: project.version,
      })) : [],
      members: workspace.members.map((member) => ({
        subject: member.subject,
        displayName: member.displayName,
        status: member.status,
        identities: (identitiesByMember.get(member.id) ?? []).map((identity) => ({
          provider: identity.provider,
          installationKey: identity.installationKey,
          externalId: identity.externalId,
          displayName: identity.displayName,
          status: identity.status,
        })),
      })),
      tasks: hasTaskRoute ? candidateTasks.map(taskDigest) : [],
      context: hasInformationRoute ? contextDigests(pack.entries, this.options.config.maxContextCharacters) : [],
      events: eventDigests(
        routedEvents,
        documentEvents.length > 0
          ? this.options.config.maxSourceDocumentCharacters
          : this.options.config.maxEvidenceCharacters,
        routeById,
      ),
      retrieval: entityRetrieval ? { ...entityRetrieval.manifest, episodeGrouping } : {
        provider: "legacy" as const, embeddingModel: null, rankingModel: null,
        candidateCount: graph.tasks.length + graph.projects.length,
        shortlistedCount: candidateTasks.length + candidateProjects.length,
        episodeGrouping,
      },
      coverage: sourceCoverage(workspace, this.options.coverageAsOf ?? startedAt),
    };
    const inputHash = contentHash(input);
    const storedRun = await this.options.store.createInterpretationRun({
      inputHash,
      model: interpreter.name,
      eventIds: events.map((event) => event.id),
    });

    try {
      const raw = routedEvents.length > 0
        ? await interpreter.interpret(input)
        : { summary: "Jev classified the observations as neither work nor durable information.", findings: [] };
      const usage = raw.usage ?? null;
      const interpreted = interpretationOutputSchema.parse({ summary: raw.summary, findings: raw.findings });
      const outcomes: FindingOutcome[] = [];
      for (const [index, finding] of interpreted.findings.entries()) {
        outcomes.push(await this.applyFinding(index, finding, events, workspace.members, routeById,
          sourceCoverage(workspace, this.options.coverageAsOf ?? startedAt).complete));
      }
      const finishedAt = new Date().toISOString();
      const report: IntelligenceRunReport = {
        id: storedRun.id,
        state: "completed",
        model: interpreter.name,
        eventIds: events.map((event) => event.id),
        summary: interpreted.summary,
        outcomes,
        usage,
        startedAt,
        finishedAt,
      };
      await this.options.store.completeInterpretationRun(
        storedRun.id,
        JSON.parse(JSON.stringify({ routes: routeDecisions, interpretation: interpreted, outcomes, usage })) as JsonValue,
      );
      if (usage) {
        await this.options.store.appendAuditEvent({
          actor: `intelligence:${interpreter.name}`,
          action: "model.usage",
          targetType: "interpretation_run",
          targetId: storedRun.id,
          sourceEventId: null,
          proposalId: null,
          details: { phase: "interpretation", model: interpreter.name, ...usage },
        });
      }
      this.options.log.info("Evidence interpretation completed.", {
        runId: storedRun.id,
        events: events.length,
        applied: outcomes.filter((outcome) => outcome.state === "applied").length,
      });
      return report;
    } catch (error) {
      const message = cleanError(error);
      await this.options.store.failInterpretationRun(storedRun.id, message);
      this.options.log.error("Evidence interpretation failed.", { runId: storedRun.id, error: message });
      throw error;
    }
  }

  private async includeSlackThreadRoots(
    events: SourceEvent[], routes: Map<string, ObservationRouteDecision>,
  ): Promise<SourceEvent[]> {
    const rootsByEvent = new Map<string, SourceEvent>();
    const selectedIds = new Set(events.map((event) => event.id));
    for (const event of events) {
      const route = routes.get(event.id)?.route;
      if (route !== "task" && route !== "both") continue;
      const sourceRef = slackThreadRootRef(event);
      if (!sourceRef) continue;
      const root = await this.options.store.getLatestSourceEventBySourceRef(
        "slack", event.installationKey, sourceRef,
      );
      if (root && !selectedIds.has(root.id) && root.visibility === event.visibility
        && root.occurredAt <= event.occurredAt) rootsByEvent.set(event.id, root);
    }
    if (rootsByEvent.size === 0) return events;
    const selected = [...events];
    while (selected.length > 0) {
      const roots = [...new Map(selected.flatMap((event) => {
        const root = rootsByEvent.get(event.id);
        return root ? [[root.id, root] as const] : [];
      })).values()].filter((root) => !selected.some((event) => event.id === root.id));
      if (selected.length + roots.length <= this.options.config.maxEventsPerRun) {
        return [...selected, ...roots].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
          || left.receivedAt.localeCompare(right.receivedAt));
      }
      selected.pop();
    }
    return events.slice(0, 1);
  }

  private async applyFinding(
    index: number,
    finding: InterpretationFinding,
    events: SourceEvent[],
    members: Member[],
    routes: Map<string, ObservationRouteDecision>,
    coverageComplete: boolean,
  ): Promise<FindingOutcome> {
    if (finding.kind === "abstain") {
      return { index, kind: finding.kind, state: "abstained", proposalId: null, reason: finding.rationale };
    }

    const eventById = new Map(events.map((event) => [event.id, event]));
    if (finding.evidenceEventIds.length === 0 || finding.evidenceEventIds.some((id) => !eventById.has(id))) {
      return this.rejected(index, finding, "Finding cites unknown evidence.");
    }
    if (finding.confidence < this.options.config.minimumConfidence) {
      return this.rejected(index, finding, "Finding confidence is below the configured threshold.");
    }

    const citedRoutes = finding.evidenceEventIds.map((id) => routes.get(id)?.route ?? "both");
    const workFinding = finding.kind === "project_upsert" || finding.kind === "task_change"
      || finding.kind === "task_create" || finding.kind === "task_duplicate";
    if (workFinding && finding.kind !== "task_change"
      && !citedRoutes.some((route) => route === "task" || route === "both")) {
      if (finding.kind !== "task_create" || !this.options.workClaimJudge) {
        return this.rejected(index, finding, "Jev did not route the cited evidence to work.");
      }
      const cited = finding.evidenceEventIds.map((id) => eventById.get(id)!);
      if (cited.length > 12) return this.rejected(index, finding, "Too many evidence items for work-claim judgment.");
      const judgment = await this.options.workClaimJudge.judge({ primaryEventId: cited[0]!.id,
        spans: cited.map((event) => ({ eventId: event.id, provider: event.provider,
          sourceRef: event.sourceRef, sourceUrl: event.sourceUrl, visibility: event.visibility,
          occurredAt: event.occurredAt, fetchedAt: event.fetchedAt, text: eventText(event) })),
        candidates: [], references: [], coverage: { scanned: cited.length, limit: cited.length,
          bounded: false, omittedMatches: 0 } });
      if (judgment.kind.choice !== "task_action" || judgment.concreteActionProbability < 0.8) {
        return this.rejected(index, finding, "Jev did not confirm an outstanding actionable Task.");
      }
    }
    if (!workFinding && !citedRoutes.some((route) => route === "information" || route === "both")) {
      return this.rejected(index, finding, "Jev did not route the cited evidence to durable information.");
    }

    const actor = `intelligence:${this.options.interpreter?.name ?? "cached-gate-v2"}`;

    const terminalWork = finding.status === "done"
      || finding.projectStatus === "completed" || finding.projectStatus === "archived";
    if (workFinding && terminalWork && !coverageComplete) {
      return this.rejected(index, finding, "Terminal work state is blocked while required connector coverage is incomplete.");
    }
    if (finding.status === "done") {
      const completionEvidence = finding.evidenceEventIds.map((id) => eventById.get(id)!)
        .filter((event) => this.options.config.completionEvidenceProviders.includes(event.provider));
      if (finding.evidenceEventIds.length < this.options.config.completionMinimumEvidenceItems
        || completionEvidence.length === 0
        || finding.confidence < this.options.config.completionMinimumConfidence) {
        return this.rejected(index, finding, "Completion lacks the configured evidence count, provider, or confidence.");
      }
    }

    if (finding.kind === "project_upsert") {
      const project = await this.applyProjectFinding(finding, members, actor);
      if (!project) return this.rejected(index, finding, "Project finding is missing a usable name or outcome.");
      return this.applied(index, finding, project.proposalId);
    }

    if (finding.kind === "task_change") {
      const task = finding.taskId ? await this.options.ledger.getTask(finding.taskId) : null;
      if (task && this.options.workChangeJudge) {
        const evidence = finding.evidenceEventIds.map((id) => eventById.get(id)!);
        const judgment = await this.options.workChangeJudge.judgeTaskChange(task, {
          title: finding.title ?? task.title, description: finding.description ?? task.description,
          status: finding.status ?? task.status, priority: finding.priority ?? task.priority,
          owner: finding.owner, project: finding.project,
        }, evidence);
        if (judgment.relationship !== "same_outcome" || judgment.relationshipProbability < 0.65) {
          return this.rejected(index, finding, "Jev did not confirm the same Task outcome.");
        }
        if (judgment.changeSupportProbability < 0.7) {
          return this.rejected(index, finding, "Jev did not support the proposed Task change.");
        }
        if (finding.status !== task.status && judgment.statusSupportProbability < 0.75) {
          return this.rejected(index, finding, "Jev did not support the proposed Task status.");
        }
        if (finding.status === "done" && judgment.completionSupportProbability < 0.85) {
          return this.rejected(index, finding, "Jev did not verify completion of the whole Task.");
        }
      } else if (task && this.options.workJudge) {
        const evidence = finding.evidenceEventIds.map((id) => eventById.get(id)!);
        if (evidence.length > 10) return this.rejected(index, finding, "Too many evidence items for exact Task judgment.");
        const judgment = await this.options.workJudge.judgeTaskStatus(task, evidence);
        if (judgment.directMatchProbability < 0.8) {
          return this.rejected(index, finding, "Jev did not confirm the exact Task identity.");
        }
        if (finding.status !== task.status && (judgment.status.choice !== finding.status
          || judgment.statusSupportProbability < 0.8
          || (finding.status === "done" && judgment.completionSupportProbability < 0.8))) {
          return this.rejected(index, finding, "Jev did not support the proposed Task status.");
        }
      } else if (!citedRoutes.some((route) => route === "task" || route === "both")) {
        return this.rejected(index, finding, "Jev did not route the cited evidence to work.");
      }
      return this.applyTaskChange(index, finding, members, actor);
    }
    if (finding.kind === "task_duplicate") {
      if (!finding.taskId || !finding.duplicateOfTaskId || finding.taskId === finding.duplicateOfTaskId) {
        return this.rejected(index, finding, "Duplicate reconciliation requires two distinct supplied Task IDs.");
      }
      const result = await this.options.ledger.markTaskDuplicate(
        finding.taskId, finding.duplicateOfTaskId, finding.rationale, actor, finding.evidenceEventIds,
      );
      return this.applied(index, finding, result.proposalId ?? "");
    }
    if (finding.kind === "task_create") {
      if (finding.evidenceEventIds.every((id) => isAttendanceOnlyRequest(eventById.get(id)!))) {
        return this.rejected(index, finding, "A meeting-attendance request is transient coordination, not a durable Task.");
      }
      if (!finding.title?.trim() || !finding.status || !finding.priority) {
        return this.rejected(index, finding, "Task creation is missing required fields.");
      }
      if (!finding.description?.trim()) {
        return this.rejected(index, finding, "Task creation is missing a useful description.");
      }
      const owner = activeMemberName(finding.owner, members);
      if (finding.owner && !owner) {
        return this.rejected(index, finding, "Task owner is not an active organization member.");
      }
      const externalRef = `team-ledger:intelligence:${contentHash({ title: finding.title, evidence: finding.evidenceEventIds })}`;
      if ((await this.options.ledger.workGraph()).tasks.some((task) => task.externalRef === externalRef)) {
        return this.rejected(index, finding, "A task from the same cited evidence is already accepted.");
      }
      const firstEvent = eventById.get(finding.evidenceEventIds[0]!)!;
      const project = await this.resolveTaskProject(finding, members, actor);
      const proposal = await this.options.ledger.proposeTaskCreation({
        externalRef,
        title: finding.title.trim(),
        description: finding.description,
        status: finding.status,
        priority: finding.priority,
        owner,
        project: project?.name ?? null,
        projectId: project?.id ?? null,
        dueDate: finding.dueDate,
        dependencyRefs: finding.dependencyRefs,
        sourceUrl: firstEvent.sourceUrl,
        rationale: finding.rationale,
        requestedBy: actor,
        evidenceIds: finding.evidenceEventIds,
      });
      await this.options.ledger.approveProposal(proposal.id, actor, "Applied directly from the LLM interpretation; revision history retained.");
      return this.applied(index, finding, proposal.id);
    }

    const firstEvent = eventById.get(finding.evidenceEventIds[0]!)!;
    if (!finding.contextPath?.trim() || !finding.contextTitle?.trim()) {
      return this.rejected(index, finding, "Context proposal is missing its path or title.");
    }
    const common = {
      sourceRef: `intelligence:${finding.kind}:${contentHash(finding.contextPath.trim())}`,
      path: finding.contextPath.trim(),
      title: finding.contextTitle.trim(),
      sourceUrl: firstEvent.sourceUrl,
      rationale: finding.rationale,
      requestedBy: actor,
      evidenceIds: finding.evidenceEventIds,
    };
    const proposal = finding.kind === "context_fact_upsert"
      ? finding.contextFactType && finding.contextFactValue !== null
        ? await this.options.ledger.proposeContextFact({
            ...common,
            factType: finding.contextFactType,
            value: finding.contextFactValue,
          })
        : null
      : finding.contextBody?.trim()
        ? await this.options.ledger.proposeContextFile({
            ...common,
            body: preservePrimarySourceDiagram(
              finding.contextBody,
              finding.evidenceEventIds.map((id) => eventById.get(id)!).filter(Boolean),
            ),
          })
        : null;
    if (!proposal) {
      return this.rejected(index, finding, `Context ${finding.kind === "context_fact_upsert" ? "fact" : "file"} is missing required content.`);
    }
    try {
      await this.options.ledger.approveProposal(proposal.id, actor, "Applied directly from the LLM interpretation; revision history retained.");
    } catch (error) {
      if (!(error instanceof DomainError && error.code === "CONFLICT" && error.message.includes("path"))) throw error;
      const reason = "Context path is already owned by a different entry.";
      await this.options.ledger.rejectProposal(proposal.id, actor, reason);
      return this.rejected(index, finding, reason);
    }
    return this.applied(index, finding, proposal.id);
  }

  private async applyTaskChange(
    index: number,
    finding: InterpretationFinding,
    members: Member[],
    actor: string,
  ): Promise<FindingOutcome> {
    if (!finding.taskId) return this.rejected(index, finding, "Task change does not identify a task.");
    const task = await this.options.ledger.getTask(finding.taskId);
    if (!task) return this.rejected(index, finding, "Task change targets an unknown task.");
    if (!finding.title?.trim() || finding.description === null || !finding.status || !finding.priority) {
      return this.rejected(index, finding, "Task change is missing the desired task snapshot.");
    }
    const owner = finding.owner && finding.owner.trim().toLocaleLowerCase() !== task.owner?.trim().toLocaleLowerCase()
      ? activeMemberName(finding.owner, members)
      : finding.owner;
    if (finding.owner && !owner) {
      return this.rejected(index, finding, "Task owner is not an active organization member.");
    }
    const project = await this.resolveTaskProject(finding, members, actor);
    const desired = {
      title: finding.title.trim(),
      description: finding.description,
      status: finding.status,
      priority: finding.priority,
      owner,
      project: project?.name ?? null,
      projectId: project?.id ?? null,
      dueDate: finding.dueDate,
      dependencyRefs: finding.dependencyRefs,
    };
    const changes: TaskProposalChanges = {};
    for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
      if (JSON.stringify(task[key]) !== JSON.stringify(desired[key])) Object.assign(changes, { [key]: desired[key] });
    }
    const incomingEvidence = await this.options.store.getSourceEvents(finding.evidenceEventIds);
    const incomingTime = Math.max(...incomingEvidence.map((event) => new Date(event.occurredAt).getTime()));
    const [revisions, proposals] = await Promise.all([
      this.options.store.listTaskRevisions(task.id), this.options.store.listTaskProposals(task.id),
    ]);
    const proposalById = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    const latestByField = new Map<string, number>();
    for (const revision of revisions) {
      const prior = proposalById.get(revision.proposalId);
      if (!prior?.evidenceIds.length) continue;
      const evidence = await this.options.store.getSourceEvents(prior.evidenceIds);
      const at = Math.max(...evidence.map((event) => new Date(event.occurredAt).getTime()));
      for (const key of Object.keys(changes)) {
        if (JSON.stringify(revision.previous?.[key as keyof Task]) !== JSON.stringify(revision.current[key as keyof Task])) {
          latestByField.set(key, Math.max(latestByField.get(key) ?? -Infinity, at));
        }
      }
    }
    for (const key of Object.keys(changes) as (keyof TaskProposalChanges)[]) {
      if (incomingTime < (latestByField.get(key) ?? -Infinity)) delete changes[key];
    }
    if (Object.keys(changes).length === 0) {
      return { index, kind: finding.kind, state: "abstained", proposalId: null,
        reason: "Task already matches the finding or newer accepted evidence controls the changed fields." };
    }
    const proposal = await this.options.ledger.propose({
      taskId: task.id,
      changes,
      rationale: finding.rationale,
      requestedBy: actor,
      evidenceIds: finding.evidenceEventIds,
    });
    await this.options.ledger.approveProposal(proposal.id, actor, "Applied directly from the LLM interpretation; revision history retained.");
    return this.applied(index, finding, proposal.id);
  }

  private async resolveTaskProject(
    finding: InterpretationFinding,
    members: Member[],
    actor: string,
  ): Promise<{ id: string; name: string } | null> {
    if (!finding.project?.trim()) return null;
    const graph = await this.options.ledger.workGraph();
    const normalized = finding.project.trim().toLocaleLowerCase();
    const existing = graph.projects.find((project) => project.id === finding.projectId)
      ?? graph.projects.find((project) => [project.name, ...project.aliases]
        .some((name) => name.trim().toLocaleLowerCase() === normalized));
    if (existing) return { id: existing.id, name: existing.name };
    if (!finding.projectOutcome?.trim()) return null;
    const owner = activeMemberName(finding.owner, members);
    const proposal = await this.options.ledger.proposeProjectCreation({
      changes: {
        name: finding.project.trim(),
        outcome: finding.projectOutcome.trim(),
        owner,
        status: finding.projectStatus ?? "active",
      },
      rationale: finding.rationale,
      requestedBy: actor,
      evidenceIds: finding.evidenceEventIds,
    });
    const revision = await this.options.ledger.approveProjectProposal(
      proposal.id,
      actor,
      "Applied directly from the LLM interpretation; revision history retained.",
    );
    return { id: revision.current.id, name: revision.current.name };
  }

  private async applyProjectFinding(
    finding: InterpretationFinding,
    members: Member[],
    actor: string,
  ): Promise<{ proposalId: string } | null> {
    const graph = await this.options.ledger.workGraph();
    const name = finding.project?.trim() ?? "";
    const outcome = finding.projectOutcome?.trim() ?? "";
    const normalized = name.toLocaleLowerCase();
    const existing = graph.projects.find((project) => project.id === finding.projectId)
      ?? graph.projects.find((project) => name && [project.name, ...project.aliases]
        .some((candidate) => candidate.trim().toLocaleLowerCase() === normalized));
    const owner = activeMemberName(finding.owner, members);
    if (existing) {
      const changes: import("../domain/types.js").ProjectChanges = {};
      if (name && name !== existing.name) changes.name = name;
      if (outcome && outcome !== existing.outcome) changes.outcome = outcome;
      if (finding.owner !== null && owner !== existing.owner) changes.owner = owner;
      if (finding.projectStatus && finding.projectStatus !== existing.status) changes.status = finding.projectStatus;
      if (Object.keys(changes).length === 0) return { proposalId: "" };
      const proposal = await this.options.ledger.proposeProjectChange(existing.id, {
        baseVersion: existing.version,
        changes,
        rationale: finding.rationale,
        requestedBy: actor,
        evidenceIds: finding.evidenceEventIds,
      });
      await this.options.ledger.approveProjectProposal(
        proposal.id,
        actor,
        "Applied directly from the LLM interpretation; revision history retained.",
      );
      return { proposalId: proposal.id };
    }
    if (!name || !outcome) return null;
    const proposal = await this.options.ledger.proposeProjectCreation({
      changes: { name, outcome, owner, status: finding.projectStatus ?? "active" },
      rationale: finding.rationale,
      requestedBy: actor,
      evidenceIds: finding.evidenceEventIds,
    });
    await this.options.ledger.approveProjectProposal(
      proposal.id,
      actor,
      "Applied directly from the LLM interpretation; revision history retained.",
    );
    return { proposalId: proposal.id };
  }

  private rejected(index: number, finding: InterpretationFinding, reason: string): FindingOutcome {
    return { index, kind: finding.kind, state: "rejected", proposalId: null, reason };
  }

  private applied(index: number, finding: InterpretationFinding, proposalId: string): FindingOutcome {
    return { index, kind: finding.kind, state: "applied", proposalId: proposalId || null, reason: finding.rationale };
  }
}
