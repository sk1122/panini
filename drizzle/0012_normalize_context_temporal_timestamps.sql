-- PostgreSQL serializes timestamptz values converted directly to JSON with a
-- numeric offset. Runtime projections expose JavaScript ISO timestamps with a
-- UTC Z suffix and millisecond precision. Normalize every temporal field in
-- immutable context revisions so replay remains byte-for-byte deterministic
-- after the temporal-memory upgrade.
UPDATE "context_revisions"
SET "current" = jsonb_set(
	"current",
	'{effectiveFrom}',
	to_jsonb(to_char(("current"->>'effectiveFrom')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
WHERE "current"->>'effectiveFrom' IS NOT NULL;--> statement-breakpoint

UPDATE "context_revisions"
SET "current" = jsonb_set(
	"current",
	'{effectiveTo}',
	to_jsonb(to_char(("current"->>'effectiveTo')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
WHERE "current"->>'effectiveTo' IS NOT NULL;--> statement-breakpoint

UPDATE "context_revisions"
SET "previous" = jsonb_set(
	"previous",
	'{effectiveFrom}',
	to_jsonb(to_char(("previous"->>'effectiveFrom')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
WHERE "previous"->>'effectiveFrom' IS NOT NULL;--> statement-breakpoint

UPDATE "context_revisions"
SET "previous" = jsonb_set(
	"previous",
	'{effectiveTo}',
	to_jsonb(to_char(("previous"->>'effectiveTo')::timestamptz AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
)
WHERE "previous"->>'effectiveTo' IS NOT NULL;
