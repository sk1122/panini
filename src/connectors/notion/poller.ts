import type { AppConfig, NotionSourceConfig } from "../../config.js";
import type { TeamLedger } from "../../domain/team-ledger.js";
import { NotionApiError, NotionClient } from "./client.js";
import { normalizeNotionPage } from "./normalize.js";
import type { NotionPage } from "./types.js";

export interface SyncSourceResult {
  source: string;
  fetched: number;
  ingested: number;
  duplicates: number;
  proposals: number;
  revoked: number;
  error?: string;
}

export interface SyncResult {
  startedAt: string;
  finishedAt: string;
  sources: SyncSourceResult[];
}

export class NotionPoller {
  private timer: NodeJS.Timeout | null = null;
  private activeSync: Promise<SyncResult> | null = null;

  constructor(
    private readonly client: NotionClient,
    private readonly ledger: TeamLedger,
    private readonly config: AppConfig["notion"],
    private readonly log: { info(message: string, fields?: object): void; error(message: string, fields?: object): void },
    private readonly installationId: string | null = null,
  ) {}

  start(): void {
    if (this.timer || !this.config.enabled) return;
    void this.sync().catch((error: unknown) => this.log.error("Initial Notion sync failed.", { error: String(error) }));
    this.timer = setInterval(() => {
      void this.sync().catch((error: unknown) => this.log.error("Scheduled Notion sync failed.", { error: String(error) }));
    }, this.config.pollIntervalSeconds * 1_000);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  sync(): Promise<SyncResult> {
    if (this.activeSync) return this.activeSync;
    this.activeSync = this.performSync().finally(() => {
      this.activeSync = null;
    });
    return this.activeSync;
  }

  private async performSync(): Promise<SyncResult> {
    const startedAt = new Date().toISOString();
    const sources: SyncSourceResult[] = [];
    const claimedPageIds = new Set(
      this.config.sources
        .filter((source) => source.kind === "page" && source.resourceId)
        .map((source) => source.resourceId!),
    );
    const configuredDataSourceIds = new Set(
      this.config.sources
        .filter((source) => source.kind === "data_source" && source.resourceId)
        .map((source) => source.resourceId!),
    );
    const orderedSources = [...this.config.sources].sort((left, right) =>
      Number(left.kind === "workspace") - Number(right.kind === "workspace"));
    for (const source of orderedSources) {
      try {
        sources.push(await this.syncSource(source, claimedPageIds, configuredDataSourceIds));
      } catch (error) {
        const failed = { source: source.key, fetched: 0, ingested: 0, duplicates: 0, proposals: 0, revoked: 0, error: String(error) };
        sources.push(failed);
        this.log.error("Notion source sync failed.", failed);
      }
    }
    const result = { startedAt, finishedAt: new Date().toISOString(), sources };
    if (this.installationId) {
      const failed = sources.filter((source) => source.error);
      const observedEvents = sources.some((source) => source.ingested > 0 || source.duplicates > 0);
      await this.ledger.updateInstallation(this.installationId, {
        status: failed.length === 0 ? "healthy" : "degraded",
        lastSyncAt: result.finishedAt,
        ...(failed.length === 0
          ? { lastSuccessAt: result.finishedAt, lastError: null }
          : { lastError: failed.map((source) => `${source.source}: ${source.error}`).join("\n").slice(0, 4_000) }),
        ...(observedEvents ? { lastEventAt: result.finishedAt } : {}),
      }, "connector:notion");
    }
    this.log.info("Notion sync finished.", result);
    return result;
  }

  private async syncSource(
    source: NotionSourceConfig,
    claimedPageIds: Set<string>,
    configuredDataSourceIds: Set<string>,
  ): Promise<SyncSourceResult> {
    const attemptAt = new Date().toISOString();
    const previous = this.installationId
      ? await this.ledger.updateConnectorSyncState(this.installationId, source.key, {
          status: "running",
          lastAttemptAt: attemptAt,
          lastError: null,
        })
      : null;
    const previousRefs = new Set(
      Array.isArray(previous?.cursor.sourceRefs)
        ? previous.cursor.sourceRefs.filter((value): value is string => typeof value === "string")
        : [],
    );
    let pages: NotionPage[];
    try {
      if (source.kind === "workspace") {
        pages = (await this.client.searchPages()).filter((page) => {
          const parentDataSourceId = page.parent?.data_source_id ?? page.parent?.database_id;
          return !claimedPageIds.has(page.id) &&
            (!parentDataSourceId || !configuredDataSourceIds.has(parentDataSourceId));
        });
      } else if (source.kind === "data_source") {
        pages = await this.client.queryDataSource(source.resourceId!);
      } else {
        pages = [await this.client.retrievePage(source.resourceId!)];
      }
    } catch (error) {
      let revoked = 0;
      const accessLost = error instanceof NotionApiError && (error.status === 403 || error.status === 404);
      if (accessLost) {
        for (const sourceRef of previousRefs) {
          revoked += await this.ledger.revokeEvidenceBySourceRef("notion", "default", sourceRef, "connector:notion-repair");
        }
      }
      if (this.installationId) {
        await this.ledger.updateConnectorSyncState(this.installationId, source.key, {
          status: accessLost ? "revoked" : "degraded",
          lastError: String(error).slice(0, 4_000),
          revokedCount: revoked,
        });
      }
      throw error;
    }
    const result: SyncSourceResult = {
      source: source.key,
      fetched: pages.length,
      ingested: 0,
      duplicates: 0,
      proposals: 0,
      revoked: 0,
    };
    const seenRefs = new Set<string>();
    for (const page of pages) {
      const sourceRef = source.kind === "workspace"
        ? `notion:workspace-page:${page.id}`
        : `notion:page:${page.id}`;
      seenRefs.add(sourceRef);
      claimedPageIds.add(page.id);
      if (page.archived || page.in_trash) {
        result.revoked += await this.ledger.revokeEvidenceBySourceRef(
          "notion",
          "default",
          sourceRef,
          "connector:notion",
        );
        continue;
      }
      const blocks = source.ingestAs === "company_context"
        ? await this.client.retrieveBlockTree(page.id)
        : [];
      if (source.ingestAs === "task_board" && source.properties?.owner) {
        const owners = page.properties[source.properties.owner]?.people ?? [];
        for (const owner of owners) {
          if (!owner.id || !owner.name?.trim()) continue;
          await this.ledger.reconcileMemberIdentity({
            provider: "notion",
            installationKey: "default",
            externalId: owner.id,
            displayName: owner.name.trim(),
            email: owner.person?.email?.trim() || null,
            status: "active",
          }, "connector:notion-members");
        }
      }
      const observation = normalizeNotionPage(source, page, blocks, this.config.apiVersion);
      const previous = await this.ledger.latestEvidenceBySourceRef("notion", "default", sourceRef);
      const ingested = await this.ledger.ingest({ ...observation, event: {
        ...observation.event,
        supersedesEventId: previous && page.last_edited_time > previous.occurredAt ? previous.id : null,
      } });
      if (ingested.duplicate) result.duplicates += 1;
      else result.ingested += 1;
      if (ingested.proposal) result.proposals += 1;
    }
    for (const sourceRef of previousRefs) {
      if (seenRefs.has(sourceRef)) continue;
      result.revoked += await this.ledger.revokeEvidenceBySourceRef(
        "notion",
        "default",
        sourceRef,
        "connector:notion-repair",
      );
    }
    if (this.installationId) {
      const completedAt = new Date().toISOString();
      const latestEditedAt = pages.reduce<string | null>((latest, page) =>
        !latest || page.last_edited_time > latest ? page.last_edited_time : latest, null);
      await this.ledger.updateConnectorSyncState(this.installationId, source.key, {
        status: "healthy",
        cursor: {
          fullScan: true,
          discovery: source.kind === "workspace" ? "workspace_search" : "configured_root",
          resourceId: source.resourceId ?? null,
          sourceRefs: [...seenRefs].sort(),
          latestEditedAt,
          completedAt,
        },
        lastSuccessAt: completedAt,
        lastRepairAt: completedAt,
        lastError: null,
        observedCount: pages.length,
        revokedCount: result.revoked,
      });
    }
    return result;
  }
}
