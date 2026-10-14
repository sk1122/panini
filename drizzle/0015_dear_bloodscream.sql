CREATE TABLE "project_proposals" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"project_id" uuid,
	"base_version" integer,
	"changes" jsonb NOT NULL,
	"evidence_ids" jsonb NOT NULL,
	"rationale" text NOT NULL,
	"requested_by" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by" text,
	"decision_note" text,
	CONSTRAINT "project_proposals_kind_check" CHECK ("project_proposals"."kind" IN ('project_create','project_change'))
);
--> statement-breakpoint
CREATE TABLE "project_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"proposal_id" uuid NOT NULL,
	"previous" jsonb,
	"current" jsonb NOT NULL,
	"applied_at" timestamp with time zone NOT NULL,
	"applied_by" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_proposals" ADD CONSTRAINT "project_proposals_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_revisions" ADD CONSTRAINT "project_revisions_proposal_id_project_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."project_proposals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "project_proposals_organization_state_idx" ON "project_proposals" USING btree ("organization_id","state","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_revisions_project_version_idx" ON "project_revisions" USING btree ("project_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "project_revisions_proposal_idx" ON "project_revisions" USING btree ("proposal_id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_version_check" CHECK ("projects"."version" > 0);