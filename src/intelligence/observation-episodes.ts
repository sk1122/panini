import type { SourceEvent } from "../domain/types.js";
import type { LedgerStore } from "../domain/store.js";
import type { EmbeddingAdapter } from "../retrieval/embedding-adapter.js";
import { containsCredentialLikeText } from "../retrieval/external-text-policy.js";
import { eventText } from "../reconciliation/evidence-bundle.js";

const issuePattern = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi;
const shaPattern = /\b[0-9a-f]{7,40}\b/gi;
const stopWords = new Set(["about", "after", "again", "also", "been", "before", "being", "build", "from",
  "have", "into", "just", "more", "need", "only", "other", "should", "some", "task", "that", "their",
  "then", "there", "these", "they", "this", "with", "work", "would"]);

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function normalizedTerms(text: string): Set<string> {
  return new Set((text.toLocaleLowerCase("en").match(/[\p{L}\p{N}][\p{L}\p{N}_/-]+/gu) ?? [])
    .map((term) => term.replace(/^[-_/]+|[-_/]+$/g, ""))
    .filter((term) => term.length >= 5 && !stopWords.has(term)));
}

function stringValues(payload: Record<string, unknown> | null, names: string[]): string[] {
  if (!payload) return [];
  return names.flatMap((name) => typeof payload[name] === "string" ? [String(payload[name])] : []);
}

function semanticText(event: SourceEvent): string {
  const payload = record(event.payload);
  if (event.provider === "slack") return stringValues(payload, ["text"]).join("\n");
  if (event.provider === "github") return stringValues(payload, ["title", "message", "body", "text"]).join("\n");
  return eventText(event);
}

function eventAnchors(event: SourceEvent): Set<string> {
  const payload = record(event.payload);
  const text = `${event.sourceRef}\n${eventText(event)}`;
  const anchors = new Set<string>();
  for (const value of text.toUpperCase().match(issuePattern) ?? []) anchors.add(`issue:${value}`);
  for (const value of text.toLowerCase().match(uuidPattern) ?? []) anchors.add(`uuid:${value}`);
  for (const value of stringValues(payload, ["workItemId", "pullId", "headSha", "sha", "branch", "head"])) {
    if (value.trim()) anchors.add(`work:${value.trim().toLowerCase()}`);
  }
  if (event.provider === "slack") {
    const channel = typeof payload?.channel === "string" ? payload.channel : event.sourceRef.split(":")[2];
    const thread = typeof payload?.threadTs === "string" && payload.threadTs
      ? payload.threadTs
      : typeof payload?.thread_ts === "string" && payload.thread_ts
        ? payload.thread_ts
        : typeof payload?.messageTs === "string" ? payload.messageTs : event.sourceRef.split(":")[3];
    if (channel && thread) anchors.add(`slack-thread:${channel}:${thread}`);
  }
  // Commit SHAs often connect a GitHub check, PR, branch, and agent report.
  for (const value of text.toLowerCase().match(shaPattern) ?? []) anchors.add(`sha:${value}`);
  anchors.add(`source:${event.provider}:${event.installationKey}:${event.sourceRef}`);
  return anchors;
}

function intersects(left: Set<string>, right: Set<string>): boolean {
  for (const value of left) if (right.has(value)) return true;
  return false;
}

export function observationsExplicitlyLinked(left: SourceEvent, right: SourceEvent): boolean {
  return left.provider === right.provider && left.installationKey === right.installationKey
    && left.visibility === right.visibility && intersects(eventAnchors(left), eventAnchors(right));
}

function cosine(left: number[], right: number[]): number {
  if (left.length !== right.length || left.length === 0) return -1;
  let dot = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index]! * right[index]!;
    leftSquared += left[index]! ** 2;
    rightSquared += right[index]! ** 2;
  }
  return leftSquared > 0 && rightSquared > 0 ? dot / Math.sqrt(leftSquared * rightSquared) : -1;
}

export interface ObservationEpisode {
  events: SourceEvent[];
  grouping: "explicit" | "semantic" | "single";
}

export interface ObservationEpisodeGrouper {
  group(events: SourceEvent[], maximumEpisodeSize?: number): Promise<ObservationEpisode[]>;
}

export interface PackedObservationEpisode {
  events: SourceEvent[];
  componentEpisodeCount: number;
  oversizedSource: boolean;
}

/** Read-only neighbors: never claim their dispositions or extract their own facts. */
export async function buildEvidenceSourceContext(store: LedgerStore, active: SourceEvent[],
  options: { cutoff: string; allowedVisibilities: string[]; maxEvents: number; maxPayloadBytes: number }) {
  if (!Number.isSafeInteger(options.maxEvents) || options.maxEvents < 1 || options.maxEvents > 100
    || !Number.isSafeInteger(options.maxPayloadBytes) || options.maxPayloadBytes < 1) {
    throw new Error("Invalid source context bounds.");
  }
  const candidates = new Map<string, SourceEvent>();
  const queried = new Set<string>();
  let candidateSearchTruncated = false;
  for (const source of active) {
    if (!options.allowedVisibilities.includes(source.visibility)) continue;
    const key = JSON.stringify([source.provider, source.installationKey, source.visibility]);
    if (queried.has(key)) continue;
    queried.add(key);
    const page = await store.listSourceContextCandidates({ provider: source.provider,
      installationKey: source.installationKey, visibility: source.visibility,
      cutoff: options.cutoff, limit: 501 });
    candidateSearchTruncated ||= page.length === 501;
    for (const event of page.slice(0, 500)) candidates.set(event.id, event);
  }
  const activeIds = new Set(active.map(event => event.id));
  const anchors = active.map(eventAnchors);
  const related = [...candidates.values()].filter(event => !activeIds.has(event.id)
    && anchors.some((set, index) => active[index]!.provider === event.provider
      && active[index]!.installationKey === event.installationKey && intersects(set, eventAnchors(event))));
  const currentIds = new Set(await store.currentSourceEventIds(related.map(event => event.id), options.cutoff));
  const origins = new Set(active.map(event => event.observationIdentity?.originObservationKey ?? event.id));
  const events: SourceEvent[] = [], omittedEventIds: string[] = [];
  let bytes = 0;
  // A thread may span several topics. Keep the active report's neighbors rather
  // than the latest tail, then present the selected sources in time order.
  const activeTimes = active.map(event => Date.parse(event.occurredAt));
  const distance = (event: SourceEvent) => Math.min(...activeTimes.map(time => Math.abs(Date.parse(event.occurredAt) - time)));
  for (const event of related.filter(event => currentIds.has(event.id))
    .sort((a, b) => distance(a) - distance(b) || a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id))) {
    const origin = event.observationIdentity?.originObservationKey ?? event.id;
    if (origins.has(origin)) continue;
    origins.add(origin);
    const size = Buffer.byteLength(JSON.stringify(event.payload), "utf8");
    if (events.length >= options.maxEvents || bytes + size > options.maxPayloadBytes) omittedEventIds.push(event.id);
    else { events.push(event); bytes += size; }
  }
  events.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  return { events, omittedEventIds, candidateSearchTruncated, cutoff: options.cutoff };
}

/** Keep explicit episode boundaries intact while sharing one bounded extraction request. */
export function packIndependentEpisodes(episodes: ObservationEpisode[], maximumEvents = 20,
  maximumPayloadBytes = 30_000): PackedObservationEpisode[] {
  if (!Number.isSafeInteger(maximumEvents) || maximumEvents < 1
    || !Number.isSafeInteger(maximumPayloadBytes) || maximumPayloadBytes < 1) {
    throw new Error("Invalid episode packing bounds.");
  }
  const packed: PackedObservationEpisode[] = [];
  let current: PackedObservationEpisode | null = null;
  let currentBytes = 0;
  for (const episode of episodes) {
    if (episode.events.length > maximumEvents) throw new Error("An episode exceeds its event bound.");
    const bytes = episode.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload), "utf8"), 0);
    if (current && (current.events.length + episode.events.length > maximumEvents
      || currentBytes + bytes > maximumPayloadBytes)) {
      packed.push(current);
      current = null;
      currentBytes = 0;
    }
    if (!current) current = { events: [], componentEpisodeCount: 0, oversizedSource: false };
    current.events.push(...episode.events);
    current.componentEpisodeCount += 1;
    current.oversizedSource ||= bytes > maximumPayloadBytes;
    currentBytes += bytes;
  }
  if (current) packed.push(current);
  return packed;
}

/**
 * Builds bounded work episodes. Explicit references are authoritative grouping
 * clues. Embeddings may join nearby observations into a candidate episode, but
 * the later Jev and LLM stages still decide meaning and entity identity.
 */
export class EmbeddingObservationEpisodeGrouper implements ObservationEpisodeGrouper {
  private readonly vectorCache = new Map<string, number[]>();

  constructor(
    private readonly adapter: EmbeddingAdapter | null,
    private readonly allowedVisibilities: string[],
  ) {}

  async group(events: SourceEvent[], maximumEpisodeSize = 20): Promise<ObservationEpisode[]> {
    if (events.length === 0) return [];
    const ordered = [...events].sort((left, right) => left.occurredAt.localeCompare(right.occurredAt)
      || left.receivedAt.localeCompare(right.receivedAt));
    const parent = ordered.map((_, index) => index);
    const mode = ordered.map<ObservationEpisode["grouping"]>(() => "single");
    const find = (index: number): number => {
      while (parent[index] !== index) {
        parent[index] = parent[parent[index]!]!;
        index = parent[index]!;
      }
      return index;
    };
    const join = (left: number, right: number, grouping: ObservationEpisode["grouping"]): void => {
      const leftRoot = find(left);
      const rightRoot = find(right);
      if (leftRoot === rightRoot) return;
      parent[rightRoot] = leftRoot;
      mode[leftRoot] = grouping === "explicit" || mode[leftRoot] === "explicit" || mode[rightRoot] === "explicit"
        ? "explicit" : "semantic";
    };
    const anchors = ordered.map(eventAnchors);
    const terms = ordered.map((event) => normalizedTerms(semanticText(event)));
    for (let left = 0; left < ordered.length; left += 1) {
      for (let right = left + 1; right < ordered.length; right += 1) {
        if (intersects(anchors[left]!, anchors[right]!)) join(left, right, "explicit");
      }
    }

    let vectors: number[][] | null = null;
    const embeddable = this.adapter && ordered.every((event) => this.allowedVisibilities.includes(event.visibility))
      && ordered.every((event) => !containsCredentialLikeText(semanticText(event)));
    if (embeddable) {
      try {
        const texts = ordered.map((event) => [event.provider, event.eventKind, semanticText(event)]
          .join("\n").slice(0, 12_000));
        const keys = ordered.map((event) => `${event.id}:${event.contentHash}`);
        const missing = keys.map((key, index) => ({ key, text: texts[index]! }))
          .filter(({ key }) => !this.vectorCache.has(key));
        for (let offset = 0; offset < missing.length; offset += 16) {
          const batch = missing.slice(offset, offset + 16);
          const embedded = this.adapter!.embedDocuments
            ? await this.adapter!.embedDocuments(batch.map(({ text }) => text))
            : await this.adapter!.embed(batch.map(({ text }) => text));
          if (embedded.length !== batch.length) throw new Error("Observation embedding count is incomplete.");
          batch.forEach(({ key }, index) => this.vectorCache.set(key, embedded[index]!));
        }
        const cached = keys.map((key) => this.vectorCache.get(key));
        vectors = cached.every((vector): vector is number[] => Boolean(vector)) ? cached : null;
      } catch {
        vectors = null;
      }
    }
    if (vectors?.length === ordered.length) {
      for (let left = 0; left < ordered.length; left += 1) {
        for (let right = left + 1; right < ordered.length; right += 1) {
          if (find(left) === find(right)) continue;
          if (ordered[left]!.eventKind === "source.document.retrieved"
            || ordered[right]!.eventKind === "source.document.retrieved") continue;
          const elapsed = Math.abs(Date.parse(ordered[left]!.occurredAt) - Date.parse(ordered[right]!.occurredAt));
          if (elapsed > 7 * 24 * 60 * 60_000) continue;
          const sharedTerms = [...terms[left]!].filter((term) => terms[right]!.has(term));
          const hasBridge = sharedTerms.some((term) => term.length >= 7);
          if (hasBridge && cosine(vectors[left]!, vectors[right]!) >= 0.84) join(left, right, "semantic");
        }
      }
    }

    const grouped = new Map<number, SourceEvent[]>();
    for (let index = 0; index < ordered.length; index += 1) {
      const root = find(index);
      const group = grouped.get(root) ?? [];
      group.push(ordered[index]!);
      grouped.set(root, group);
    }
    return [...grouped.entries()].flatMap(([root, episode]) => {
      const chunks: ObservationEpisode[] = [];
      for (let offset = 0; offset < episode.length; offset += maximumEpisodeSize) {
        chunks.push({ events: episode.slice(offset, offset + maximumEpisodeSize),
          grouping: episode.length === 1 ? "single" : mode[find(root)] ?? "explicit" });
      }
      return chunks;
    }).sort((left, right) => left.events[0]!.occurredAt.localeCompare(right.events[0]!.occurredAt));
  }
}
