import pg from "pg";
import { PostgresLedgerStore } from "../store/postgres.js";
import { containsCredentialLikeText } from "../retrieval/external-text-policy.js";
import { EmbeddingObservationEpisodeGrouper, packIndependentEpisodes } from "../intelligence/observation-episodes.js";

const url = process.env.DATABASE_URL;
const key = process.env.CONTENT_ENCRYPTION_KEY;
const expected = process.env.PANINI_REPLAY_DATABASE;
if (!url || !key || !expected || !/^panini_replay_[a-z0-9_]+$/.test(expected)) {
  throw new Error("Explicit isolated replay database and content key are required.");
}
const pool = new pg.Pool({ connectionString: url });
const database = (await pool.query<{ current_database: string }>("SELECT current_database()"))
  .rows[0]?.current_database;
await pool.end();
if (database !== expected) throw new Error("Replay database assertion failed.");
const store = new PostgresLedgerStore(url, key);
try {
  const events = await store.listSourceEvents(10_000);
  const allowed = new Set((process.env.PANINI_ALLOWED_VISIBILITIES ?? "").split(",").map((s) => s.trim()).filter(Boolean));
  const byProvider: Record<string, { count: number; bytes: number; credentialScreened: number;
    oversize: number; missingIdentity: number; maxBytes: number }> = {};
  let totalBytes = 0;
  let allowedEventCount = 0;
  let allowedBytes = 0;
  const approvedEvents = events.filter((event) => allowed.has(event.visibility));
  const episodes = await new EmbeddingObservationEpisodeGrouper(null, []).group(approvedEvents, 20);
  const packs = packIndependentEpisodes(episodes, 20, 30_000);
  for (const event of events) {
    const bucket = byProvider[event.provider] ?? { count: 0, bytes: 0, credentialScreened: 0,
      oversize: 0, missingIdentity: 0, maxBytes: 0 };
    const text = JSON.stringify(event.payload);
    const bytes = Buffer.byteLength(text, "utf8");
    bucket.count += 1;
    bucket.bytes += bytes;
    bucket.maxBytes = Math.max(bucket.maxBytes, bytes);
    bucket.credentialScreened += Number(containsCredentialLikeText(text));
    bucket.oversize += Number(bytes > 80_000);
    bucket.missingIdentity += Number(!event.observationIdentity);
    totalBytes += bytes;
    if (allowed.has(event.visibility)) { allowedEventCount += 1; allowedBytes += bytes; }
    byProvider[event.provider] = bucket;
  }
  console.log(JSON.stringify({ database, organizationId: (await store.getOrganization()).id,
    eventCount: events.length, totalBytes, allowedEventCount, allowedBytes,
    episodeCount: episodes.length, packedCallCount: packs.length,
    firstPacks: packs.slice(0, 5).map((pack) => ({ events: pack.events.length,
      providers: [...new Set(pack.events.map((event) => event.provider))],
      bytes: pack.events.reduce((sum, event) => sum + Buffer.byteLength(JSON.stringify(event.payload), "utf8"), 0) })),
    maxEpisodeSize: Math.max(0, ...episodes.map((episode) => episode.events.length)),
    byProvider }));
} finally { await store.close(); }
