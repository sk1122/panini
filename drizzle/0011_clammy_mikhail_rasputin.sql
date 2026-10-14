ALTER TABLE "agent_profiles" ADD COLUMN "member_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD COLUMN "data_scope" jsonb DEFAULT '{"projects":[],"contextPaths":["/"],"sourceVisibilities":["company"]}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "context_entries" ADD COLUMN "lifecycle_state" text DEFAULT 'accepted' NOT NULL;--> statement-breakpoint
ALTER TABLE "context_entries" ADD COLUMN "effective_from" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "context_entries" ADD COLUMN "effective_to" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "context_entries" ADD COLUMN "links" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
WITH uniquely_named_members AS (
  SELECT lower(display_name) AS normalized_name, min(id::text)::uuid AS member_id
    FROM members
   GROUP BY lower(display_name)
  HAVING count(*) = 1
)
UPDATE agent_profiles AS profile
   SET member_id = matched.member_id
  FROM uniquely_named_members AS matched
 WHERE profile.member_id IS NULL
   AND lower(profile.owner) = matched.normalized_name;--> statement-breakpoint
UPDATE agent_profiles
   SET status = 'revoked', updated_at = now()
 WHERE status = 'active' AND member_id IS NULL;--> statement-breakpoint
UPDATE context_entries AS entry
   SET effective_from = evidence.occurred_at
  FROM source_events AS evidence
 WHERE evidence.id = entry.source_event_id;--> statement-breakpoint
UPDATE context_revisions AS revision
   SET current = revision.current || jsonb_build_object(
     'lifecycleState', 'accepted',
     'effectiveFrom', to_jsonb(evidence.occurred_at),
     'effectiveTo', NULL,
     'links', '[]'::jsonb
   )
  FROM source_events AS evidence
 WHERE evidence.id = (revision.current->>'sourceEventId')::uuid
   AND NOT (revision.current ? 'lifecycleState');--> statement-breakpoint
UPDATE context_revisions AS revision
   SET previous = revision.previous || jsonb_build_object(
     'lifecycleState', 'accepted',
     'effectiveFrom', to_jsonb(evidence.occurred_at),
     'effectiveTo', NULL,
     'links', '[]'::jsonb
   )
  FROM source_events AS evidence
 WHERE revision.previous IS NOT NULL
   AND evidence.id = (revision.previous->>'sourceEventId')::uuid
   AND NOT (revision.previous ? 'lifecycleState');--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_profiles_member_name_idx" ON "agent_profiles" USING btree ("member_id",lower("name")) WHERE "agent_profiles"."member_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "context_entries_organization_lifecycle_effective_idx" ON "context_entries" USING btree ("organization_id","lifecycle_state","effective_from","effective_to");--> statement-breakpoint
CREATE INDEX "context_entries_links_idx" ON "context_entries" USING gin ("links");--> statement-breakpoint
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_active_member_check" CHECK ("agent_profiles"."status" = 'revoked' OR "agent_profiles"."member_id" IS NOT NULL);--> statement-breakpoint
ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_lifecycle_check" CHECK ("context_entries"."lifecycle_state" IN ('accepted','needs_review','superseded'));--> statement-breakpoint
ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_effective_interval_check" CHECK ("context_entries"."effective_to" IS NULL OR "context_entries"."effective_to" > "context_entries"."effective_from");
