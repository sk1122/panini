ALTER TABLE "work_link_revisions" DROP CONSTRAINT "work_link_revisions_link_id_work_links_id_fk";
--> statement-breakpoint
CREATE UNIQUE INDEX "work_links_organization_id_id_idx" ON "work_links" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "work_link_revisions" ADD CONSTRAINT "work_link_revisions_organization_id_link_id_work_links_organization_id_id_fk" FOREIGN KEY ("organization_id","link_id") REFERENCES "public"."work_links"("organization_id","id") ON DELETE cascade ON UPDATE no action;
