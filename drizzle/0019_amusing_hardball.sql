ALTER TABLE "source_events" ADD COLUMN "canonical_object_key" text;--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "source_version_key" text;--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "semantic_content_hash" text;--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "origin_observation_key" text;--> statement-breakpoint
ALTER TABLE "source_events" ADD COLUMN "authorization_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX "source_events_canonical_version_idx" ON "source_events" USING btree ("organization_id","provider","installation_key","canonical_object_key","source_version_key");--> statement-breakpoint
CREATE INDEX "source_events_origin_idx" ON "source_events" USING btree ("organization_id","origin_observation_key");--> statement-breakpoint
ALTER TABLE "source_events" ADD CONSTRAINT "source_events_authorization_version_check" CHECK ("source_events"."authorization_version" > 0);