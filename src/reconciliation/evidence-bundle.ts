import type { Project, SourceEvent, Task } from "../domain/types.js";

export interface WorkEvidenceSpan {
  eventId: string;
  provider: string;
  sourceRef: string;
  sourceUrl: string | null;
  visibility: string;
  occurredAt: string;
  fetchedAt: string;
  text: string;
}

export interface WorkCandidate {
  kind: "project" | "task";
  id: string;
  title: string;
  reason: "exact_reference" | "exact_name" | "lexical_overlap" | "explicit_task_id";
}

export interface WorkEvidenceBundle {
  primaryEventId: string;
  spans: WorkEvidenceSpan[];
  candidates: WorkCandidate[];
  references: string[];
  coverage: { scanned: number; limit: number; bounded: boolean; omittedMatches: number };
}

const referencePattern = /\b[A-Z][A-Z0-9]+-\d+\b/g;
const uuidPattern = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function richText(value: unknown): string {
  return Array.isArray(value) ? value.map((item) => object(item)?.plain_text).filter((item): item is string =>
    typeof item === "string").join("") : "";
}

function notionProperty(value: unknown): string {
  const property = object(value);
  if (!property) return "";
  const named = object(property.status)?.name ?? object(property.select)?.name;
  const people = Array.isArray(property.people) ? property.people.map((person) => object(person)?.name)
    .filter((name): name is string => typeof name === "string").join(", ") : "";
  return richText(property.title) || richText(property.rich_text)
    || (typeof named === "string" ? named : "") || people;
}

export function eventText(event: SourceEvent): string {
  const payload = event.payload;
  if (typeof payload === "string") return payload.slice(0, 4_000);
  const data = object(payload);
  if (data) {
    const document = object(data.document);
    if (document) {
      return [document.title, document.markdown].filter((value): value is string =>
        typeof value === "string").join("\n").slice(0, 4_000);
    }
    const page = object(data.page);
    if (page) {
      const properties = object(page.properties);
      const fields = properties ? Object.entries(properties).map(([name, value]) => {
        const text = notionProperty(value);
        return text ? `${name}: ${text}` : "";
      }).filter(Boolean) : [];
      const blocks = Array.isArray(data.blocks) ? data.blocks.map((value) => {
        const block = object(value);
        return block ? richText(object(block[block.type as string])?.rich_text) : "";
      }).filter(Boolean) : [];
      return [...fields, ...blocks].join("\n").slice(0, 4_000);
    }
    const parts = [data.title, data.text, data.body, data.message, data.description,
      data.outcome, data.phase, data.state, data.status, data.conclusion, data.mergedAt,
      ...(Array.isArray(data.verification) ? data.verification : []),
      ...(Array.isArray(data.artifactRefs) ? data.artifactRefs : [])]
      .filter((value): value is string => typeof value === "string");
    return parts.join("\n").slice(0, 4_000);
  }
  return "";
}

function references(text: string): string[] {
  return [...new Set(text.replace(uuidPattern, " ").toUpperCase().match(referencePattern) ?? [])];
}

function exactNameInText(name: string, text: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (normalized.length < 4) return false;
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "iu").test(text);
}

function linkPhrases(event: SourceEvent): string[] {
  const payload = object(event.payload);
  if (!payload) return [];
  const phrases: string[] = [];
  if (event.provider === "github") {
    for (const value of [payload.head, payload.branch]) {
      if (typeof value === "string" && value.length >= 8 && /[/-]/.test(value)
        && !["main", "master"].includes(value.toLowerCase())) phrases.push(value);
    }
  }
  if (event.provider === "notion") {
    const title = object(payload.document)?.title;
    if (typeof title === "string" && title.length >= 12 && title.trim().split(/\s+/).length >= 2) {
      phrases.push(title);
    }
  }
  return phrases;
}

function slackThreadKey(event: SourceEvent): string | null {
  if (event.provider !== "slack") return null;
  const parts = event.sourceRef.split(":");
  if (parts.length < 4) return null;
  const channel = parts[2];
  const messageTs = parts[3];
  let threadTs: string | null = null;
  if (event.sourceUrl) {
    try { threadTs = new URL(event.sourceUrl).searchParams.get("thread_ts"); } catch { /* Keep the message timestamp. */ }
  }
  return channel && (threadTs || messageTs) ? `${channel}:${threadTs || messageTs}` : null;
}

const workStopWords = new Set(["a", "an", "and", "as", "at", "be", "by", "for", "from", "in", "into",
  "is", "of", "on", "or", "the", "then", "to", "with", "work", "task", "run", "check", "get", "need", "see"]);

function workTerms(value: string): Set<string> {
  return new Set((value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
    .map((term) => term.length > 3 && term.endsWith("s") ? term.slice(0, -1) : term)
    .filter((term) => (term.length >= 3 || /^\d{2,}$/.test(term)) && !workStopWords.has(term)));
}

/** Search hint only; overlap never establishes that two sources describe the same work. */
function lexicalOverlap(title: string, textTerms: Set<string>): number {
  const titleTerms = workTerms(title);
  if (titleTerms.size < 2) return 0;
  const matched = [...titleTerms].filter((term) => textTerms.has(term));
  const coverage = matched.length / titleTerms.size;
  if (matched.length >= 3 && coverage >= 0.45) return coverage;
  // Two distinctive names can find a candidate in a verbose old task title.
  // This is only a hint for Jev, never an accepted identity.
  if (matched.length >= 2 && matched.every((term) => term.length >= 7)
    && coverage >= 0.25) return coverage;
  const acronyms = new Set((title.match(/\b[A-Z][A-Za-z0-9]{1,}\b/g) ?? [])
    .map((term) => term.toLowerCase()));
  return matched.filter((term) => acronyms.has(term)).length >= 2 ? coverage : 0;
}

/** Deterministic discovery only. A candidate is not an accepted link. */
export function buildWorkEvidenceBundle(input: {
  primary: SourceEvent;
  recentEvents: SourceEvent[];
  projects: Project[];
  tasks: Task[];
  scanLimit: number;
  scannedCount: number;
}): WorkEvidenceBundle {
  const primaryText = eventText(input.primary);
  const primaryRefs = references(`${input.primary.sourceRef} ${primaryText}`);
  const primaryPhrases = linkPhrases(input.primary);
  const primaryThread = slackThreadKey(input.primary);
  const primaryTerms = workTerms(primaryText);
  const primaryPayload = object(input.primary.payload);
  const explicitTaskId = input.primary.provider === "agent" && typeof primaryPayload?.workItemId === "string"
    ? primaryPayload.workItemId : null;
  const recent = [input.primary, ...input.recentEvents.filter((event) => event.id !== input.primary.id)];
  const related = recent.filter((event) => {
    if (event.id === input.primary.id) return true;
    const otherText = eventText(event);
    if (primaryRefs.length) {
      const refs = references(`${event.sourceRef} ${otherText}`);
      if (refs.some((reference) => primaryRefs.includes(reference))) return true;
    }
    if (primaryThread && slackThreadKey(event) === primaryThread) {
      const common = [...workTerms(otherText)].filter((term) => primaryTerms.has(term)).length;
      const root = event.sourceRef.endsWith(`:${primaryThread.split(":")[1]}`);
      if (root || common >= 2) return true;
    }
    return linkPhrases(event).some((phrase) => exactNameInText(phrase, primaryText))
      || primaryPhrases.some((phrase) => exactNameInText(phrase, otherText));
  });
  // Discover a few cross-thread candidates from distinctive shared terms.
  // This only expands what the models may inspect; it never establishes that
  // two messages describe the same Task or Project.
  const contextTerms = new Set([...related.filter((event) => event.id === input.primary.id
    || (primaryThread && slackThreadKey(event) === primaryThread))
    .slice(0, 8).flatMap((event) => [...workTerms(eventText(event))])]);
  const relatedRefs = new Set(related.map((event) => event.sourceRef));
  const primaryAnchors = new Set([...primaryTerms].filter((term) => (term.length >= 6 || term.length === 3)
    && !["source", "system", "process", "people", "thing", "should", "add", "all"].includes(term)));
  const crossThread = recent.filter((event) => !relatedRefs.has(event.sourceRef)
    && event.provider === input.primary.provider
    && Math.abs(Date.parse(event.occurredAt) - Date.parse(input.primary.occurredAt)) <= 14 * 24 * 60 * 60_000
    && eventText(event).length >= 80 && eventText(event).length <= 1_500)
    .map((event) => { const terms = workTerms(eventText(event));
      const elapsed = Math.abs(Date.parse(event.occurredAt) - Date.parse(input.primary.occurredAt));
      const matchedAnchors = [...terms].filter((term) => primaryAnchors.has(term));
      return { event,
      overlap: [...terms].filter((term) => contextTerms.has(term)).length,
      primaryOverlap: matchedAnchors.length,
      score: matchedAnchors.reduce((sum, term) => sum + (term.length === 3 ? 3 : 1), 0)
        + (elapsed <= 12 * 60 * 60_000 ? 2 : 0) }; })
    .filter((item) => item.primaryOverlap >= 1 && (item.overlap >= 2 || item.score >= 3))
    .sort((left, right) => (right.score + right.overlap) - (left.score + left.overlap)
      || right.event.occurredAt.localeCompare(left.event.occurredAt));
  const addedRefs = new Set<string>();
  for (const item of crossThread) {
    if (addedRefs.has(item.event.sourceRef)) continue;
    related.push(item.event);
    addedRefs.add(item.event.sourceRef);
    if (addedRefs.size >= 3) break;
  }
  related.sort((left, right) => {
    if (left.id === input.primary.id) return -1;
    if (right.id === input.primary.id) return 1;
    const score = (event: SourceEvent) => {
      const sameThread = primaryThread && slackThreadKey(event) === primaryThread;
      const root = sameThread && event.sourceRef.endsWith(`:${primaryThread.split(":")[1]}`);
      const overlap = [...workTerms(eventText(event))].filter((term) => primaryTerms.has(term)).length;
      return (root ? 100 : 0) + (sameThread ? 20 : 0) + Math.min(overlap, 10);
    };
    return score(right) - score(left) || right.occurredAt.localeCompare(left.occurredAt);
  });
  const spans = related.slice(0, 12).map((event) => ({
    eventId: event.id, provider: event.provider, sourceRef: event.sourceRef,
    sourceUrl: event.sourceUrl, visibility: event.visibility,
    occurredAt: event.occurredAt, fetchedAt: event.fetchedAt, text: eventText(event),
  }));
  const joinedText = spans.map((span) => span.text).join("\n");
  const candidates: WorkCandidate[] = [];
  const lexicalCandidates: Array<{ candidate: WorkCandidate; score: number }> = [];
  const textTerms = workTerms(joinedText);
  for (const task of input.tasks) {
    const taskRefs = references(`${task.externalRef ?? ""} ${task.title}`);
    if (explicitTaskId === task.id) {
      candidates.push({ kind: "task", id: task.id, title: task.title, reason: "explicit_task_id" });
    } else if (taskRefs.some((reference) => primaryRefs.includes(reference))) {
      candidates.push({ kind: "task", id: task.id, title: task.title, reason: "exact_reference" });
    } else if (task.title.trim().length >= 12 && exactNameInText(task.title, joinedText)) {
      candidates.push({ kind: "task", id: task.id, title: task.title, reason: "exact_name" });
    } else {
      const score = lexicalOverlap(task.title, textTerms);
      if (score > 0) lexicalCandidates.push({
        candidate: { kind: "task", id: task.id, title: task.title, reason: "lexical_overlap" }, score,
      });
    }
  }
  for (const project of input.projects) {
    if ([project.name, ...project.aliases].some((name) => exactNameInText(name, joinedText))) {
      candidates.push({ kind: "project", id: project.id, title: project.name, reason: "exact_name" });
    }
  }
  lexicalCandidates.sort((left, right) => right.score - left.score || left.candidate.title.localeCompare(right.candidate.title));
  candidates.push(...lexicalCandidates.slice(0, Math.max(0, 8 - candidates.length)).map((item) => item.candidate));
  return { primaryEventId: input.primary.id, spans, candidates: candidates.slice(0, 8), references: primaryRefs,
    coverage: { scanned: input.scannedCount, limit: input.scanLimit,
      bounded: input.scannedCount === input.scanLimit, omittedMatches: Math.max(0, related.length - spans.length) } };
}
