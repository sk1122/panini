-- PostgreSQL serializes timestamptz to JSON with a numeric offset and up to
-- microsecond precision. Runtime projections expose JavaScript ISO timestamps
-- (UTC Z suffix, millisecond precision), so normalize synthetic backfill
-- revisions to the same representation used by every subsequently-written
-- revision. This makes replay byte-for-byte deterministic after an upgrade.
UPDATE "context_revisions" cr
SET "current" = jsonb_set(
	cr."current",
	'{updatedAt}',
	to_jsonb(to_char(ce."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
FROM "context_entries" ce
WHERE cr."context_entry_id" = ce."id"
	AND cr."applied_by" = 'system:migration';
