import pg from "pg";
import { PayloadCipher, type EncryptedPayload } from "../security/payload-cipher.js";
import { observationIdentity } from "../intelligence/observation-identity.js";
import type { JsonValue, SourceEventInput } from "../domain/types.js";

interface Row extends pg.QueryResultRow {
  id: string;
  organization_id: string;
  provider: string;
  installation_key: string;
  provider_event_id: string;
  event_kind: string;
  occurred_at: Date;
  fetched_at: Date;
  source_ref: string;
  source_url: string | null;
  content_hash: string;
  visibility: string;
  payload_version: string;
  ciphertext: string | null;
  iv: string | null;
  auth_tag: string | null;
  key_version: string | null;
}

const databaseUrl = process.env.DATABASE_URL;
const expectedDatabase = process.env.PANINI_BACKFILL_DATABASE;
const key = process.env.CONTENT_ENCRYPTION_KEY;
if (!databaseUrl || !expectedDatabase || !/^panini_(replay|e2e)_/.test(expectedDatabase) || !key) {
  throw new Error("An isolated DATABASE_URL, PANINI_BACKFILL_DATABASE, and CONTENT_ENCRYPTION_KEY are required.");
}
const pool = new pg.Pool({ connectionString: databaseUrl });
const cipher = new PayloadCipher(key);
const report = { database: expectedDatabase, scanned: 0, resolved: 0, unresolved: 0, unavailable: 0 };
try {
  const database = await pool.query<{ current_database: string }>("SELECT current_database()");
  if (database.rows[0]?.current_database !== expectedDatabase) throw new Error("Target database identity mismatch.");
  let cursor = "00000000-0000-0000-0000-000000000000";
  while (true) {
    const page = await pool.query<Row>(
      `SELECT se.*,sec.ciphertext,sec.iv,sec.auth_tag,sec.key_version
         FROM source_events se LEFT JOIN source_event_contents sec ON sec.source_event_id=se.id
        WHERE se.id>$1 AND se.canonical_object_key IS NULL ORDER BY se.id LIMIT 100`,
      [cursor],
    );
    if (page.rows.length === 0) break;
    for (const row of page.rows) {
      cursor = row.id;
      report.scanned += 1;
      if (!row.ciphertext || !row.iv || !row.auth_tag || !row.key_version) {
        report.unavailable += 1;
        continue;
      }
      let payload: JsonValue;
      try {
        payload = cipher.decrypt({ ciphertext: row.ciphertext, iv: row.iv,
          authTag: row.auth_tag, keyVersion: row.key_version } satisfies EncryptedPayload);
      } catch {
        report.unavailable += 1;
        continue;
      }
      const source: SourceEventInput = {
        provider: row.provider, installationKey: row.installation_key,
        providerEventId: row.provider_event_id, eventKind: row.event_kind,
        occurredAt: row.occurred_at.toISOString(), fetchedAt: row.fetched_at.toISOString(),
        sourceRef: row.source_ref, sourceUrl: row.source_url, contentHash: row.content_hash,
        visibility: row.visibility, payloadVersion: row.payload_version, payload,
      };
      const identity = observationIdentity(source);
      if (!identity) {
        report.unresolved += 1;
        continue;
      }
      await pool.query(
        `UPDATE source_events SET canonical_object_key=$3,source_version_key=$4,
           semantic_content_hash=$5,origin_observation_key=$6
         WHERE organization_id=$1 AND id=$2 AND canonical_object_key IS NULL`,
        [row.organization_id, row.id, identity.canonicalObjectKey, identity.sourceVersionKey,
          identity.semanticContentHash, identity.originObservationKey],
      );
      report.resolved += 1;
    }
  }
  process.stdout.write(`${JSON.stringify(report)}\n`);
} finally {
  await pool.end();
}
