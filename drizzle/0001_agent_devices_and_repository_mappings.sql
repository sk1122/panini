CREATE TABLE "agent_devices" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"name" text NOT NULL,
	"public_key" text NOT NULL,
	"status" text NOT NULL,
	"privacy_mode" text NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_devices_status_check" CHECK ("agent_devices"."status" IN ('active','revoked')),
	CONSTRAINT "agent_devices_privacy_mode_check" CHECK ("agent_devices"."privacy_mode" IN ('metadata','approved_excerpts'))
);
--> statement-breakpoint
CREATE TABLE "repository_mappings" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"repository" text NOT NULL,
	"project" text NOT NULL,
	"context_paths" text[] DEFAULT '{}'::text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_devices" ADD CONSTRAINT "agent_devices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_devices" ADD CONSTRAINT "agent_devices_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_mappings" ADD CONSTRAINT "repository_mappings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_devices_organization_profile_name_idx" ON "agent_devices" USING btree ("organization_id","agent_profile_id",lower("name"));--> statement-breakpoint
CREATE INDEX "agent_devices_organization_status_idx" ON "agent_devices" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_mappings_organization_repository_idx" ON "repository_mappings" USING btree ("organization_id",lower("repository"));