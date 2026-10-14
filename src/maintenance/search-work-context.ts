import { eventText } from "../reconciliation/evidence-bundle.js";
import { PostgresLedgerStore } from "../store/postgres.js";

if (!process.env.DATABASE_URL || !process.env.CONTENT_ENCRYPTION_KEY || !process.argv[2]) {
  throw new Error("The configured database, encryption key, and a search expression are required.");
}
const store = new PostgresLedgerStore(process.env.DATABASE_URL, process.env.CONTENT_ENCRYPTION_KEY);
const pattern = new RegExp(process.argv[2], "iu");
const matches = (await store.listSourceEvents(2_000)).filter((event) =>
  ["notion", "slack", "github", "agent"].includes(event.provider)
  && pattern.test(eventText(event)));
console.log(JSON.stringify({ count: matches.length, events: matches.slice(0, 35).map((event) => ({
  id: event.id, provider: event.provider, eventKind: event.eventKind,
  occurredAt: event.occurredAt, sourceRef: event.sourceRef, sourceUrl: event.sourceUrl,
  text: eventText(event).replace(/\s+/g, " ").slice(0, 460),
})) }));
