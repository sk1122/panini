import { eligibleWorkSignal } from "../reconciliation/work-suggestions.js";
import { eventText } from "../reconciliation/evidence-bundle.js";
import { PostgresLedgerStore } from "../store/postgres.js";

if (!process.env.DATABASE_URL || !process.env.CONTENT_ENCRYPTION_KEY) {
  throw new Error("The configured database and encryption key are required.");
}
const store = new PostgresLedgerStore(process.env.DATABASE_URL, process.env.CONTENT_ENCRYPTION_KEY);
const allowed = new Set((process.env.JEV_WORK_ALLOWED_VISIBILITIES ?? "").split(","));
const seen = new Set((await store.listInterpretationRuns(2_000))
  .filter((run) => run.model === "jev-work-suggestion-v4")
  .flatMap((run) => run.eventIds));
const events = (await store.listSourceEvents(2_000)).filter((event) =>
  allowed.has(event.visibility) && ["notion", "slack", "github", "agent"].includes(event.provider)
  && eligibleWorkSignal(event) && !seen.has(event.id));
const patterns: Record<string, RegExp> = {
  ongoing: /\b(working on|in progress|started|implementing|building|fixing|currently)\b/i,
  blocker: /\b(blocked|stuck|waiting on|failing|fails|doesn.t work|bug)\b/i,
  nextAction: /\b(need to|we should|have to|going to|next step|todo|let.s|please)\b/i,
  question: /\b(how|what|why|whether|can we|should we)\b/i,
};
const summary = Object.fromEntries(Object.entries(patterns).map(([name, pattern]) => {
  const matched = events.filter((event) => pattern.test(eventText(event)));
  return [name, { count: matched.length, examples: matched.sort((left, right) =>
    right.occurredAt.localeCompare(left.occurredAt)).slice(0, 8).map((event) => ({
      provider: event.provider, occurredAt: event.occurredAt,
      text: eventText(event).replace(/\s+/g, " ").slice(0, 220),
    })) }];
}));
console.log(JSON.stringify({ unprocessed: events.length,
  byProvider: Object.fromEntries([...new Set(events.map((event) => event.provider))].map((provider) =>
    [provider, events.filter((event) => event.provider === provider).length])), summary }));
