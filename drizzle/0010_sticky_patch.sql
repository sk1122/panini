CREATE TABLE "member_identities" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"member_id" uuid,
	"provider" text NOT NULL,
	"installation_key" text NOT NULL,
	"external_id" text NOT NULL,
	"display_name" text,
	"email" text,
	"status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "member_identities_provider_check" CHECK ("member_identities"."provider" IN ('notion','slack','github','agent','manual')),
	CONSTRAINT "member_identities_status_check" CHECK ("member_identities"."status" IN ('active','disabled'))
);
--> statement-breakpoint
ALTER TABLE "member_identities" ADD CONSTRAINT "member_identities_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member_identities" ADD CONSTRAINT "member_identities_member_id_members_id_fk" FOREIGN KEY ("member_id") REFERENCES "public"."members"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "member_identities_provider_external_idx" ON "member_identities" USING btree ("organization_id","provider","installation_key","external_id");--> statement-breakpoint
CREATE INDEX "member_identities_member_idx" ON "member_identities" USING btree ("organization_id","member_id");