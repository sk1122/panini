ALTER TABLE "context_entries" ADD COLUMN "derivation_metadata" jsonb DEFAULT '{"schemaVersion":1,"claimIds":[],"summaryKind":"legacy","freshness":"unknown","generatedBy":null}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "context_revisions" ADD COLUMN "decision_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD COLUMN "lease_token" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD COLUMN "lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD COLUMN "assessment_id" uuid;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD COLUMN "application_key" text;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD COLUMN "decision_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD COLUMN "decision_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "assessment_id" uuid;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "application_key" text;--> statement-breakpoint
ALTER TABLE "proposals" ADD COLUMN "decision_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "task_revisions" ADD COLUMN "decision_metadata" jsonb;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_organization_id_assessment_id_evidence_assessments_organization_id_id_fk" FOREIGN KEY ("organization_id","assessment_id") REFERENCES "public"."evidence_assessments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_organization_id_assessment_id_evidence_assessments_organization_id_id_fk" FOREIGN KEY ("organization_id","assessment_id") REFERENCES "public"."evidence_assessments"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_proposals_application_key_uq" ON "project_proposals" USING btree ("organization_id","application_key") WHERE "project_proposals"."application_key" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "proposals_application_key_uq" ON "proposals" USING btree ("organization_id","application_key") WHERE "proposals"."application_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE "outbox_jobs" ADD CONSTRAINT "outbox_jobs_lease_token_check" CHECK ("outbox_jobs"."lease_token" >= 0);