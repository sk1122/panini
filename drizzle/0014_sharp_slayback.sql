CREATE TABLE "agent_workspace_file_revisions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid NOT NULL,
	"agent_profile_id" uuid NOT NULL,
	"path" text NOT NULL,
	"version" integer NOT NULL,
	"byte_size" integer NOT NULL,
	"ciphertext" text,
	"iv" text,
	"auth_tag" text,
	"key_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_workspace_version_check" CHECK ("agent_workspace_file_revisions"."version" > 0 AND "agent_workspace_file_revisions"."byte_size" >= 0)
);
--> statement-breakpoint
ALTER TABLE "agent_workspace_file_revisions" ADD CONSTRAINT "agent_workspace_file_revisions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_file_revisions" ADD CONSTRAINT "agent_workspace_file_revisions_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_workspace_file_revisions" ADD CONSTRAINT "agent_workspace_file_revisions_agent_profile_id_agent_profiles_id_fk" FOREIGN KEY ("agent_profile_id") REFERENCES "public"."agent_profiles"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_profile_path_version_idx" ON "agent_workspace_file_revisions" USING btree ("agent_profile_id","path","version");--> statement-breakpoint
CREATE INDEX "agent_workspace_member_profile_idx" ON "agent_workspace_file_revisions" USING btree ("organization_id","member_id","agent_profile_id","path");