CREATE TABLE "work_link_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"link_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"previous" jsonb,
	"current" jsonb NOT NULL,
	"changed_at" timestamp with time zone NOT NULL,
	"changed_by" text NOT NULL,
	"proposal_id" uuid
);
--> statement-breakpoint
ALTER TABLE "work_link_revisions" ADD CONSTRAINT "work_link_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_link_revisions" ADD CONSTRAINT "work_link_revisions_link_id_work_links_id_fk" FOREIGN KEY ("link_id") REFERENCES "public"."work_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_link_revisions" ADD CONSTRAINT "work_link_revisions_proposal_id_proposals_id_fk" FOREIGN KEY ("proposal_id") REFERENCES "public"."proposals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "work_link_revisions_link_version_idx" ON "work_link_revisions" USING btree ("link_id","version");--> statement-breakpoint
CREATE INDEX "work_link_revisions_organization_changed_idx" ON "work_link_revisions" USING btree ("organization_id","changed_at");