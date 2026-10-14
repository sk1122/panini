import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EmbeddingObservationEpisodeGrouper,
  packIndependentEpisodes } from "../src/intelligence/observation-episodes.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const key = Buffer.alloc(32, 29).toString("base64");

describe("Bounded durable replay episode packing", () => {
  let store: PostgresLedgerStore;
  let pool: pg.Pool;
  beforeAll(async () => {
    if (!databaseUrl || !databaseUrl.includes("panini_e2e")) throw new Error("Isolated panini_e2e database required");
    store = new PostgresLedgerStore(databaseUrl, key);
    pool = new pg.Pool({ connectionString: databaseUrl });
    expect((await pool.query<{ current_database: string }>("SELECT current_database()"))
      .rows[0]?.current_database).toBe("panini_e2e");
  });
  afterAll(async () => { await store?.close(); await pool?.end(); });

  it("preserves every event and explicit group while packing small independent groups", async () => {
    const marker = randomUUID();
    const events = [];
    for (let index = 0; index < 27; index += 1) {
      const ts = randomUUID();
      const event = (await store.appendSourceEvent({ provider: "slack", installationKey: "T1",
        providerEventId: ts, eventKind: "message.observed",
        occurredAt: `2026-10-01T01:${String(index).padStart(2, "0")}:00.000Z`,
        fetchedAt: `2026-10-01T01:${String(index).padStart(2, "0")}:01.000Z`,
        sourceRef: `slack:T1:C1:${ts}`, sourceUrl: null, contentHash: ts,
        visibility: "slack:channel:C1", payloadVersion: "test-v1",
        payload: { teamId: "T1", channel: "C1", messageTs: ts,
          threadTs: index < 3 ? marker : ts, text: `Independent work item ${index}.` },
      })).event;
      events.push(event);
    }
    const grouped = await new EmbeddingObservationEpisodeGrouper(null, []).group(events, 20);
    const packed = packIndependentEpisodes(grouped, 20, 30_000);
    expect(packed.length).toBeLessThan(grouped.length);
    expect(packed.every((batch) => batch.events.length <= 20)).toBe(true);
    expect(packed.flatMap((batch) => batch.events.map((event) => event.id)).toSorted())
      .toEqual(events.map((event) => event.id).toSorted());
    const threadIds = new Set(events.slice(0, 3).map((event) => event.id));
    expect(packed.some((batch) => [...threadIds].every((id) => batch.events.some((event) => event.id === id))))
      .toBe(true);
  });
});
