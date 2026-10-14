CREATE TABLE "context_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"context_entry_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"proposal_id" uuid NOT NULL,
	"previous" jsonb,
	"current" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"applied_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_revisions" ADD CONSTRAINT "context_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_revisions" ADD CONSTRAINT "context_revisions_context_entry_id_context_entries_id_fk" FOREIGN KEY ("context_entry_id") REFERENCES "public"."context_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_revisions" ADD CONSTRAINT "context_revisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_revisions_entry_version_idx" ON "context_revisions" USING btree ("context_entry_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "context_revisions_proposal_idx" ON "context_revisions" USING btree ("proposal_id");
--> statement-breakpoint
-- Adopt context projections written by the pre-revision implementation. Each
-- synthetic proposal preserves the accepted value and its evidence lineage so
-- replay remains complete after an in-place upgrade.
INSERT INTO "proposals" (
	"id", "organization_id", "kind", "task_id", "base_version", "state", "changes", "rationale",
	"requested_by", "evidence_ids", "created_at", "decided_at", "decided_by", "decision_note"
)
SELECT
	(
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 1, 8) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 9, 4) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 13, 4) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 17, 4) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 21, 12)
	)::uuid,
	ce."organization_id",
	CASE WHEN ce."kind" = 'file' THEN 'context_file_upsert' ELSE 'context_fact_upsert' END,
	NULL,
	NULL,
	'auto_applied',
	CASE WHEN ce."kind" = 'file' THEN jsonb_build_object(
		'sourceRef', ce."source_ref", 'path', ce."path", 'title', ce."title", 'body', ce."body", 'sourceUrl', ce."source_url"
	) ELSE jsonb_build_object(
		'sourceRef', ce."source_ref", 'path', ce."path", 'title', ce."title", 'factType', ce."fact_type",
		'value', ce."fact_value", 'sourceUrl', ce."source_url"
	) END,
	'Backfilled accepted context during the context-revision migration.',
	'system:migration',
	to_jsonb(ce."evidence_ids"),
	ce."updated_at",
	ce."updated_at",
	'system:migration',
	'Adopted the existing accepted context projection.'
FROM "context_entries" ce
WHERE NOT EXISTS (
	SELECT 1 FROM "context_revisions" cr WHERE cr."context_entry_id" = ce."id"
)
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "context_revisions" (
	"id", "organization_id", "context_entry_id", "version", "proposal_id", "previous", "current", "applied_at", "applied_by"
)
SELECT
	(
		substr(md5('panini-context-backfill-revision:' || ce."id"::text), 1, 8) || '-' ||
		substr(md5('panini-context-backfill-revision:' || ce."id"::text), 9, 4) || '-' ||
		substr(md5('panini-context-backfill-revision:' || ce."id"::text), 13, 4) || '-' ||
		substr(md5('panini-context-backfill-revision:' || ce."id"::text), 17, 4) || '-' ||
		substr(md5('panini-context-backfill-revision:' || ce."id"::text), 21, 12)
	)::uuid,
	ce."organization_id",
	ce."id",
	1,
	(
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 1, 8) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 9, 4) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 13, 4) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 17, 4) || '-' ||
		substr(md5('panini-context-backfill-proposal:' || ce."id"::text), 21, 12)
	)::uuid,
	NULL,
	CASE WHEN ce."kind" = 'file' THEN jsonb_build_object(
		'id', ce."id", 'kind', ce."kind", 'sourceEventId', ce."source_event_id", 'sourceRef', ce."source_ref",
		'path', ce."path", 'title', ce."title", 'body', ce."body", 'sourceUrl', ce."source_url",
		'contentHash', ce."content_hash", 'evidenceIds', to_jsonb(ce."evidence_ids"), 'updatedAt', to_jsonb(ce."updated_at")
	) ELSE jsonb_build_object(
		'id', ce."id", 'kind', ce."kind", 'sourceEventId', ce."source_event_id", 'sourceRef', ce."source_ref",
		'path', ce."path", 'title', ce."title", 'factType', ce."fact_type", 'value', ce."fact_value",
		'sourceUrl', ce."source_url", 'contentHash', ce."content_hash", 'evidenceIds', to_jsonb(ce."evidence_ids"),
		'updatedAt', to_jsonb(ce."updated_at")
	) END,
	ce."updated_at",
	'system:migration'
FROM "context_entries" ce
WHERE NOT EXISTS (
	SELECT 1 FROM "context_revisions" cr WHERE cr."context_entry_id" = ce."id"
);
