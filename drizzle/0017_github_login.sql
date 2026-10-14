CREATE TABLE "github_login_flows" (
	"state_hash" text PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"browser_hash" text NOT NULL,
	"payload" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "member_accounts" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "member_accounts" ADD COLUMN "github_user_id" text;--> statement-breakpoint
ALTER TABLE "member_accounts" ADD COLUMN "github_login" text;--> statement-breakpoint
ALTER TABLE "github_login_flows" ADD CONSTRAINT "github_login_flows_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_login_flows_expiry_idx" ON "github_login_flows" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "member_accounts_github_idx" ON "member_accounts" USING btree ("organization_id","github_user_id");