CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"owner" text,
	"status" text DEFAULT 'active' NOT NULL,
	"source_ref" text NOT NULL,
	"source_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "projects_status_check" CHECK ("projects"."status" IN ('active','paused','completed','archived'))
);
--> statement-breakpoint
CREATE TABLE "work_links" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"target_task_id" uuid,
	"target_ref" text NOT NULL,
	"link_type" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_links_type_check" CHECK ("work_links"."link_type" IN ('depends_on','blocks','relates_to','duplicates')),
	CONSTRAINT "work_links_not_self_check" CHECK ("work_links"."target_task_id" IS NULL OR "work_links"."target_task_id" <> "work_links"."task_id")
);
--> statement-breakpoint
CREATE TABLE "workstreams" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"name" text NOT NULL,
	"outcome" text DEFAULT '' NOT NULL,
	"owner" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workstreams_status_check" CHECK ("workstreams"."status" IN ('active','paused','completed','archived'))
);
--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_links" ADD CONSTRAINT "work_links_target_task_id_tasks_id_fk" FOREIGN KEY ("target_task_id") REFERENCES "public"."tasks"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "workstreams" ADD CONSTRAINT "workstreams_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_name_idx" ON "projects" USING btree ("organization_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "projects_organization_slug_idx" ON "projects" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "work_links_task_target_type_idx" ON "work_links" USING btree ("task_id","target_ref","link_type");--> statement-breakpoint
CREATE INDEX "work_links_organization_target_idx" ON "work_links" USING btree ("organization_id","target_task_id","link_type");--> statement-breakpoint
CREATE UNIQUE INDEX "workstreams_project_name_idx" ON "workstreams" USING btree ("project_id",lower("name"));--> statement-breakpoint
CREATE INDEX "workstreams_organization_status_idx" ON "workstreams" USING btree ("organization_id","status","updated_at");--> statement-breakpoint
INSERT INTO "projects" ("id", "organization_id", "name", "slug", "outcome", "owner", "status", "source_ref", "source_url")
SELECT
	(
		substr(md5(tasks.organization_id::text || ':project:' || lower(trim(tasks.document->>'project'))),1,8) || '-' ||
		substr(md5(tasks.organization_id::text || ':project:' || lower(trim(tasks.document->>'project'))),9,4) || '-' ||
		substr(md5(tasks.organization_id::text || ':project:' || lower(trim(tasks.document->>'project'))),13,4) || '-' ||
		substr(md5(tasks.organization_id::text || ':project:' || lower(trim(tasks.document->>'project'))),17,4) || '-' ||
		substr(md5(tasks.organization_id::text || ':project:' || lower(trim(tasks.document->>'project'))),21,12)
	)::uuid,
	tasks.organization_id,
	trim(tasks.document->>'project'),
	left(trim(both '-' from regexp_replace(lower(trim(tasks.document->>'project')), '[^a-z0-9]+', '-', 'g')), 80) || '-' || left(md5(lower(trim(tasks.document->>'project'))), 8),
	'', NULL, 'active',
	'derived:accepted-task-project:' || left(md5(lower(trim(tasks.document->>'project'))), 24),
	NULL
FROM tasks
WHERE nullif(trim(tasks.document->>'project'), '') IS NOT NULL
GROUP BY tasks.organization_id, trim(tasks.document->>'project')
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "workstreams" ("id", "organization_id", "project_id", "name", "outcome", "owner", "status")
SELECT
	(
		substr(md5(projects.id::text || ':general'),1,8) || '-' ||
		substr(md5(projects.id::text || ':general'),9,4) || '-' ||
		substr(md5(projects.id::text || ':general'),13,4) || '-' ||
		substr(md5(projects.id::text || ':general'),17,4) || '-' ||
		substr(md5(projects.id::text || ':general'),21,12)
	)::uuid,
	projects.organization_id, projects.id, 'General', '', NULL, 'active'
FROM projects
ON CONFLICT DO NOTHING;--> statement-breakpoint
INSERT INTO "work_links" ("id", "organization_id", "task_id", "target_task_id", "target_ref", "link_type")
SELECT
	(
		substr(md5(tasks.id::text || ':depends_on:' || dependency.ref),1,8) || '-' ||
		substr(md5(tasks.id::text || ':depends_on:' || dependency.ref),9,4) || '-' ||
		substr(md5(tasks.id::text || ':depends_on:' || dependency.ref),13,4) || '-' ||
		substr(md5(tasks.id::text || ':depends_on:' || dependency.ref),17,4) || '-' ||
		substr(md5(tasks.id::text || ':depends_on:' || dependency.ref),21,12)
	)::uuid,
	tasks.organization_id, tasks.id, target.id, dependency.ref, 'depends_on'
FROM tasks
CROSS JOIN LATERAL jsonb_array_elements_text(coalesce(tasks.document->'dependencyRefs', '[]'::jsonb)) AS dependency(ref)
LEFT JOIN tasks AS target
	ON target.organization_id=tasks.organization_id AND target.external_ref=dependency.ref
WHERE target.id IS NULL OR target.id<>tasks.id
ON CONFLICT DO NOTHING;
