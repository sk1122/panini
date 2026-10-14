CREATE TABLE "connector_sync_states" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"installation_id" uuid NOT NULL,
	"resource_key" text NOT NULL,
	"status" text DEFAULT 'idle' NOT NULL,
	"cursor" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"last_repair_at" timestamp with time zone,
	"last_error" text,
	"observed_count" integer DEFAULT 0 NOT NULL,
	"revoked_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "connector_sync_states_status_check" CHECK ("connector_sync_states"."status" IN ('idle','running','healthy','degraded','revoked')),
	CONSTRAINT "connector_sync_states_counts_check" CHECK ("connector_sync_states"."observed_count" >= 0 AND "connector_sync_states"."revoked_count" >= 0)
);
--> statement-breakpoint
ALTER TABLE "connector_sync_states" ADD CONSTRAINT "connector_sync_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "connector_sync_states" ADD CONSTRAINT "connector_sync_states_installation_id_source_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."source_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "connector_sync_states_installation_resource_idx" ON "connector_sync_states" USING btree ("installation_id","resource_key");--> statement-breakpoint
CREATE INDEX "connector_sync_states_organization_status_idx" ON "connector_sync_states" USING btree ("organization_id","status","updated_at");