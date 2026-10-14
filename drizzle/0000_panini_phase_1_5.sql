-- Panini's Drizzle adoption migration.
--
-- This migration is deliberately compatible with both a fresh PostgreSQL
-- database and databases created by the legacy src/db/migrations runner.
-- The fixed bootstrap organization lets a single-company installation adopt
-- its existing rows without losing provenance.

CREATE TABLE IF NOT EXISTS "organizations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "organizations_slug_idx" ON "organizations" (lower("slug"));

INSERT INTO "organizations" ("id", "slug", "name")
VALUES ('00000000-0000-4000-8000-000000000001', 'default', 'Panini workspace')
ON CONFLICT ("id") DO NOTHING;

CREATE TABLE IF NOT EXISTS "members" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"subject" text NOT NULL,
	"display_name" text NOT NULL,
	"email" text,
	"role" text NOT NULL,
	"status" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "members_role_check" CHECK ("role" IN ('owner','admin','reviewer','member')),
	CONSTRAINT "members_status_check" CHECK ("status" IN ('active','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "members_organization_subject_idx" ON "members" ("organization_id", "subject");

INSERT INTO "members" ("id", "organization_id", "subject", "display_name", "role", "status")
VALUES (
	'00000000-0000-4000-8000-000000000002',
	'00000000-0000-4000-8000-000000000001',
	'bootstrap:local-admin',
	'Local administrator',
	'owner',
	'active'
)
ON CONFLICT ("organization_id", "subject") DO NOTHING;

CREATE TABLE IF NOT EXISTS "source_installations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"provider" text NOT NULL,
	"installation_key" text NOT NULL,
	"display_name" text NOT NULL,
	"transport" text NOT NULL,
	"status" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_sync_at" timestamptz,
	"last_success_at" timestamptz,
	"last_event_at" timestamptz,
	"last_error" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "source_installations_provider_check" CHECK ("provider" IN ('notion','slack','github','agent','manual')),
	CONSTRAINT "source_installations_transport_check" CHECK ("transport" IN ('poll','socket_mode','webhook','local')),
	CONSTRAINT "source_installations_status_check" CHECK ("status" IN ('configured','healthy','degraded','revoked','disabled'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "source_installations_organization_provider_key_idx"
	ON "source_installations" ("organization_id", "provider", "installation_key");
CREATE INDEX IF NOT EXISTS "source_installations_status_idx"
	ON "source_installations" ("organization_id", "status", "updated_at");

CREATE TABLE IF NOT EXISTS "source_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"installation_id" uuid REFERENCES "source_installations"("id") ON DELETE set null,
	"provider" text NOT NULL,
	"installation_key" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"event_kind" text NOT NULL,
	"occurred_at" timestamptz NOT NULL,
	"fetched_at" timestamptz NOT NULL,
	"received_at" timestamptz DEFAULT now() NOT NULL,
	"source_ref" text NOT NULL,
	"source_url" text,
	"content_hash" text NOT NULL,
	"visibility" text NOT NULL,
	"payload_version" text NOT NULL,
	"payload" jsonb,
	"content_state" text DEFAULT 'active' NOT NULL,
	"processing_state" text DEFAULT 'received' NOT NULL,
	"processing_note" text,
	"supersedes_event_id" uuid,
	"revoked_at" timestamptz
);
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "installation_id" uuid;
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "content_state" text DEFAULT 'active' NOT NULL;
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "processing_state" text DEFAULT 'received' NOT NULL;
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "processing_note" text;
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "supersedes_event_id" uuid;
ALTER TABLE "source_events" ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz;
ALTER TABLE "source_events" ALTER COLUMN "payload" DROP NOT NULL;
UPDATE "source_events" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "source_events" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "source_events" DROP CONSTRAINT IF EXISTS "source_events_provider_installation_key_provider_event_id_key";
DO $$ BEGIN
	ALTER TABLE "source_events" ADD CONSTRAINT "source_events_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE "source_events" ADD CONSTRAINT "source_events_installation_fk"
		FOREIGN KEY ("installation_id") REFERENCES "source_installations"("id") ON DELETE set null;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE "source_events" ADD CONSTRAINT "source_events_content_state_check"
		CHECK ("content_state" IN ('active','revoked','deleted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE "source_events" ADD CONSTRAINT "source_events_processing_state_check"
		CHECK ("processing_state" IN ('received','processed','ignored','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "source_events_organization_provider_event_idx"
	ON "source_events" ("organization_id", "provider", "installation_key", "provider_event_id");
CREATE INDEX IF NOT EXISTS "source_events_source_ref_idx_v2"
	ON "source_events" ("organization_id", "source_ref", "received_at");
CREATE INDEX IF NOT EXISTS "source_events_installation_idx" ON "source_events" ("installation_id", "received_at");

CREATE TABLE IF NOT EXISTS "source_event_contents" (
	"source_event_id" uuid PRIMARY KEY NOT NULL REFERENCES "source_events"("id") ON DELETE cascade,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text NOT NULL,
	"key_version" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"revoked_at" timestamptz
);

CREATE TABLE IF NOT EXISTS "tasks" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"external_ref" text,
	"document" jsonb NOT NULL,
	"version" integer NOT NULL,
	"created_at" timestamptz NOT NULL,
	"updated_at" timestamptz NOT NULL,
	CONSTRAINT "tasks_version_check" CHECK ("version" > 0)
);
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "tasks" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "tasks" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "tasks" DROP CONSTRAINT IF EXISTS "tasks_external_ref_key";
DO $$ BEGIN
	ALTER TABLE "tasks" ADD CONSTRAINT "tasks_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "tasks_organization_external_ref_idx" ON "tasks" ("organization_id", "external_ref");
CREATE INDEX IF NOT EXISTS "tasks_organization_updated_at_idx" ON "tasks" ("organization_id", "updated_at");

CREATE TABLE IF NOT EXISTS "proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"kind" text NOT NULL,
	"task_id" uuid REFERENCES "tasks"("id") ON DELETE cascade,
	"base_version" integer,
	"state" text NOT NULL,
	"changes" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"requested_by" text NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"decided_at" timestamptz,
	"decided_by" text,
	"decision_note" text
);
ALTER TABLE "proposals" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "proposals" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "proposals" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_kind_check";
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_state_check";
DO $$ BEGIN
	ALTER TABLE "proposals" ADD CONSTRAINT "proposals_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_kind_check"
	CHECK ("kind" IN ('task_create','task_change','context_update','context_file_upsert','context_fact_upsert'));
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_state_check"
	CHECK ("state" IN ('pending','approved','rejected','auto_applied','superseded'));
CREATE INDEX IF NOT EXISTS "proposals_organization_state_created_idx"
	ON "proposals" ("organization_id", "state", "created_at");

CREATE TABLE IF NOT EXISTS "task_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"task_id" uuid NOT NULL REFERENCES "tasks"("id") ON DELETE cascade,
	"version" integer NOT NULL,
	"proposal_id" uuid NOT NULL REFERENCES "proposals"("id") ON DELETE restrict,
	"previous" jsonb,
	"current" jsonb NOT NULL,
	"applied_at" timestamptz NOT NULL,
	"applied_by" text NOT NULL,
	UNIQUE ("task_id", "version"),
	UNIQUE ("proposal_id")
);
ALTER TABLE "task_revisions" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "task_revisions" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "task_revisions" ALTER COLUMN "organization_id" SET NOT NULL;
DO $$ BEGIN
	ALTER TABLE "task_revisions" ADD CONSTRAINT "task_revisions_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS "context_entries" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"kind" text NOT NULL,
	"source_event_id" uuid NOT NULL REFERENCES "source_events"("id") ON DELETE restrict,
	"source_ref" text NOT NULL,
	"path" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"fact_type" text,
	"fact_value" jsonb,
	"source_url" text,
	"content_hash" text NOT NULL,
	"evidence_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL
);
ALTER TABLE "context_entries" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "context_entries" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "context_entries" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "context_entries" DROP CONSTRAINT IF EXISTS "context_entries_source_ref_key";
ALTER TABLE "context_entries" DROP CONSTRAINT IF EXISTS "context_entries_path_key";
DO $$ BEGIN
	ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_kind_check" CHECK ("kind" IN ('file','fact'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE "context_entries" ADD CONSTRAINT "context_entries_shape_check_v2" CHECK (
		("kind" = 'file' AND "body" IS NOT NULL AND "fact_type" IS NULL AND "fact_value" IS NULL)
		OR ("kind" = 'fact' AND "body" IS NULL AND "fact_type" IN
			('identity','decision','policy','constraint','preference','relationship','metric','reference','other')
			AND jsonb_typeof("fact_value") IN ('string','number','boolean'))
	);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS "context_entries_organization_source_ref_idx"
	ON "context_entries" ("organization_id", "source_ref");
CREATE UNIQUE INDEX IF NOT EXISTS "context_entries_organization_path_idx"
	ON "context_entries" ("organization_id", "path");
CREATE INDEX IF NOT EXISTS "context_entries_organization_kind_path_idx"
	ON "context_entries" ("organization_id", "kind", "path");
CREATE INDEX IF NOT EXISTS "context_entries_evidence_ids_idx" ON "context_entries" USING gin ("evidence_ids");

CREATE TABLE IF NOT EXISTS "interpretation_runs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"input_hash" text NOT NULL,
	"model" text NOT NULL,
	"state" text NOT NULL,
	"event_ids" uuid[] NOT NULL,
	"output" jsonb,
	"error" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"completed_at" timestamptz
);
ALTER TABLE "interpretation_runs" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "interpretation_runs" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "interpretation_runs" ALTER COLUMN "organization_id" SET NOT NULL;
DO $$ BEGIN
	ALTER TABLE "interpretation_runs" ADD CONSTRAINT "interpretation_runs_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
	ALTER TABLE "interpretation_runs" ADD CONSTRAINT "interpretation_runs_state_check_v2"
		CHECK ("state" IN ('running','completed','failed'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS "interpretation_runs_organization_state_created_idx"
	ON "interpretation_runs" ("organization_id", "state", "created_at");
CREATE INDEX IF NOT EXISTS "interpretation_runs_event_ids_idx" ON "interpretation_runs" USING gin ("event_ids");

CREATE TABLE IF NOT EXISTS "agent_profiles" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"harness" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"capabilities" text[] NOT NULL,
	"status" text NOT NULL,
	"token_hash" text NOT NULL,
	"token_hint" text NOT NULL,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	"last_used_at" timestamptz
);
ALTER TABLE "agent_profiles" ADD COLUMN IF NOT EXISTS "organization_id" uuid;
UPDATE "agent_profiles" SET "organization_id" = '00000000-0000-4000-8000-000000000001' WHERE "organization_id" IS NULL;
ALTER TABLE "agent_profiles" ALTER COLUMN "organization_id" SET NOT NULL;
ALTER TABLE "agent_profiles" DROP CONSTRAINT IF EXISTS "agent_profiles_harness_check";
ALTER TABLE "agent_profiles" DROP CONSTRAINT IF EXISTS "agent_profiles_status_check";
ALTER TABLE "agent_profiles" DROP CONSTRAINT IF EXISTS "agent_profiles_token_hash_check";
DROP INDEX IF EXISTS "agent_profiles_owner_name_idx";
DO $$ BEGIN
	ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_organization_fk"
		FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE cascade;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_harness_check"
	CHECK ("harness" IN ('codex','claude_code','hermes','pi','generic_mcp'));
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_status_check" CHECK ("status" IN ('active','revoked'));
ALTER TABLE "agent_profiles" ADD CONSTRAINT "agent_profiles_token_hash_check" CHECK ("token_hash" ~ '^[a-f0-9]{64}$');
CREATE UNIQUE INDEX IF NOT EXISTS "agent_profiles_token_hash_idx" ON "agent_profiles" ("token_hash");
CREATE UNIQUE INDEX IF NOT EXISTS "agent_profiles_organization_owner_name_idx"
	ON "agent_profiles" ("organization_id", lower("owner"), lower("name"));
CREATE INDEX IF NOT EXISTS "agent_profiles_organization_status_idx"
	ON "agent_profiles" ("organization_id", "status", "updated_at");

CREATE TABLE IF NOT EXISTS "audit_events" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" text,
	"source_event_id" uuid REFERENCES "source_events"("id") ON DELETE set null,
	"proposal_id" uuid REFERENCES "proposals"("id") ON DELETE set null,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamptz DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "audit_events_organization_occurred_idx"
	ON "audit_events" ("organization_id", "occurred_at");

CREATE TABLE IF NOT EXISTS "outbox_jobs" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
	"topic" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"payload" jsonb NOT NULL,
	"state" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamptz DEFAULT now() NOT NULL,
	"locked_at" timestamptz,
	"completed_at" timestamptz,
	"last_error" text,
	"created_at" timestamptz DEFAULT now() NOT NULL,
	"updated_at" timestamptz DEFAULT now() NOT NULL,
	CONSTRAINT "outbox_jobs_state_check" CHECK ("state" IN ('pending','running','completed','failed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS "outbox_jobs_organization_dedupe_idx"
	ON "outbox_jobs" ("organization_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "outbox_jobs_dispatch_idx"
	ON "outbox_jobs" ("organization_id", "state", "available_at");
