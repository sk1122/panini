CREATE TABLE "evidence_assessments" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"assessment_key" text NOT NULL,
	"target_type" text NOT NULL,
	"target_id" uuid,
	"target_version" text,
	"contract_version" integer,
	"claim_ids" uuid[] NOT NULL,
	"evidence_fingerprint" text NOT NULL,
	"permission_fingerprint" text NOT NULL,
	"policy_version" text NOT NULL,
	"model_version" text NOT NULL,
	"relationship" text NOT NULL,
	"disposition" text NOT NULL,
	"reason_codes" text[] DEFAULT '{}'::text[] NOT NULL,
	"body_envelope" jsonb,
	"content_state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_assessments_target_type_check" CHECK ("evidence_assessments"."target_type" IN ('task','project','context','task_create','project_create','context_create')),
	CONSTRAINT "evidence_assessments_contract_version_check" CHECK ("evidence_assessments"."contract_version" IS NULL OR "evidence_assessments"."contract_version" > 0),
	CONSTRAINT "evidence_assessments_target_check" CHECK ((("evidence_assessments"."target_type" IN ('task_create','project_create','context_create') AND "evidence_assessments"."target_id" IS NULL AND "evidence_assessments"."target_version" IS NULL) OR ("evidence_assessments"."target_type" IN ('task','project','context') AND "evidence_assessments"."target_id" IS NOT NULL AND "evidence_assessments"."target_version" IS NOT NULL))),
	CONSTRAINT "evidence_assessments_claims_check" CHECK (cardinality("evidence_assessments"."claim_ids") > 0),
	CONSTRAINT "evidence_assessments_relationship_check" CHECK ("evidence_assessments"."relationship" IN ('same_outcome','part_of','related','unrelated','uncertain')),
	CONSTRAINT "evidence_assessments_disposition_check" CHECK ("evidence_assessments"."disposition" IN ('eligible','review_required','rejected','no_change')),
	CONSTRAINT "evidence_assessments_state_check" CHECK ("evidence_assessments"."content_state" IN ('active','revoked','deleted')),
	CONSTRAINT "evidence_assessments_body_check" CHECK ("evidence_assessments"."content_state" <> 'active' OR "evidence_assessments"."body_envelope" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evidence_claims" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"extraction_run_id" uuid NOT NULL,
	"episode_key" text NOT NULL,
	"ordinal" integer NOT NULL,
	"schema_version" integer DEFAULT 1 NOT NULL,
	"kind" text NOT NULL,
	"input_hash" text NOT NULL,
	"content_hash" text NOT NULL,
	"body_envelope" jsonb,
	"content_state" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_claims_ordinal_check" CHECK ("evidence_claims"."ordinal" >= 0),
	CONSTRAINT "evidence_claims_schema_check" CHECK ("evidence_claims"."schema_version" = 1),
	CONSTRAINT "evidence_claims_kind_check" CHECK ("evidence_claims"."kind" IN ('request','progress_report','completion_report','artifact_observation','correction','cancellation','context_statement')),
	CONSTRAINT "evidence_claims_state_check" CHECK ("evidence_claims"."content_state" IN ('active','revoked','deleted')),
	CONSTRAINT "evidence_claims_body_check" CHECK ("evidence_claims"."content_state" <> 'active' OR "evidence_claims"."body_envelope" IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "evidence_dependencies" (
	"organization_id" uuid NOT NULL,
	"dependent_type" text NOT NULL,
	"dependent_id" uuid NOT NULL,
	"field_key" text DEFAULT '$' NOT NULL,
	"source_event_id" uuid NOT NULL,
	"origin_observation_key" text NOT NULL,
	"source_version_key" text NOT NULL,
	"source_authorization_version" integer NOT NULL,
	"relationship" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "evidence_dependencies_organization_id_dependent_type_dependent_id_field_key_source_event_id_relationship_pk" PRIMARY KEY("organization_id","dependent_type","dependent_id","field_key","source_event_id","relationship"),
	CONSTRAINT "evidence_dependencies_dependent_type_check" CHECK ("evidence_dependencies"."dependent_type" IN ('claim','assessment','task_revision','project_revision','context_revision','interpretation_run','model_call')),
	CONSTRAINT "evidence_dependencies_auth_check" CHECK ("evidence_dependencies"."source_authorization_version" > 0),
	CONSTRAINT "evidence_dependencies_relationship_check" CHECK ("evidence_dependencies"."relationship" IN ('supports','contradicts','context'))
);
--> statement-breakpoint
CREATE TABLE "inference_budgets" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"label" text NOT NULL,
	"state" text NOT NULL,
	"max_calls" bigint NOT NULL,
	"max_input_tokens" bigint NOT NULL,
	"max_output_tokens" bigint NOT NULL,
	"max_usd" numeric(18, 8),
	"deadline" timestamp with time zone NOT NULL,
	"reserved_calls" bigint DEFAULT 0 NOT NULL,
	"reserved_input_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_output_tokens" bigint DEFAULT 0 NOT NULL,
	"reserved_usd" numeric(18, 8) DEFAULT '0' NOT NULL,
	"spent_calls" bigint DEFAULT 0 NOT NULL,
	"spent_input_tokens" bigint DEFAULT 0 NOT NULL,
	"spent_output_tokens" bigint DEFAULT 0 NOT NULL,
	"spent_usd" numeric(18, 8) DEFAULT '0' NOT NULL,
	"price_basis" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inference_budgets_state_check" CHECK ("inference_budgets"."state" IN ('active','exhausted','suspended','closed')),
	CONSTRAINT "inference_budgets_max_check" CHECK ("inference_budgets"."max_calls">0 AND "inference_budgets"."max_input_tokens">0 AND "inference_budgets"."max_output_tokens">0 AND ("inference_budgets"."max_usd" IS NULL OR "inference_budgets"."max_usd">0)),
	CONSTRAINT "inference_budgets_reserved_check" CHECK ("inference_budgets"."reserved_calls">=0 AND "inference_budgets"."reserved_input_tokens">=0 AND "inference_budgets"."reserved_output_tokens">=0 AND "inference_budgets"."reserved_usd">=0),
	CONSTRAINT "inference_budgets_spent_check" CHECK ("inference_budgets"."spent_calls">=0 AND "inference_budgets"."spent_input_tokens">=0 AND "inference_budgets"."spent_output_tokens">=0 AND "inference_budgets"."spent_usd">=0)
);
--> statement-breakpoint
CREATE TABLE "model_calls" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"budget_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"logical_call_key" text NOT NULL,
	"attempt" integer NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"resolved_model_version" text,
	"state" text NOT NULL,
	"request_hash" text NOT NULL,
	"request_envelope" jsonb,
	"response_envelope" jsonb,
	"cache_key" text,
	"cached_from_call_id" uuid,
	"reserved_input_tokens" bigint NOT NULL,
	"reserved_output_tokens" bigint NOT NULL,
	"reserved_usd" numeric(18, 8) DEFAULT '0' NOT NULL,
	"input_tokens" bigint,
	"cached_input_tokens" bigint,
	"output_tokens" bigint,
	"embedding_items" integer,
	"cost_usd" numeric(18, 8),
	"cost_basis" text NOT NULL,
	"price_basis" jsonb,
	"provider_request_id" text,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "model_calls_purpose_check" CHECK ("model_calls"."purpose" IN ('route','embed','rank','extract','identity','assess','verify','summarize','artifact_fetch')),
	CONSTRAINT "model_calls_state_check" CHECK ("model_calls"."state" IN ('reserved','dispatched','succeeded','failed','unknown','cancelled','cache_hit')),
	CONSTRAINT "model_calls_cost_basis_check" CHECK ("model_calls"."cost_basis" IN ('provider','estimated','known_zero','unknown')),
	CONSTRAINT "model_calls_attempt_check" CHECK ("model_calls"."attempt">0),
	CONSTRAINT "model_calls_nonnegative_check" CHECK ("model_calls"."reserved_input_tokens">=0 AND "model_calls"."reserved_output_tokens">=0 AND "model_calls"."reserved_usd">=0 AND ("model_calls"."input_tokens" IS NULL OR "model_calls"."input_tokens">=0) AND ("model_calls"."output_tokens" IS NULL OR "model_calls"."output_tokens">=0) AND ("model_calls"."cached_input_tokens" IS NULL OR "model_calls"."cached_input_tokens">=0) AND ("model_calls"."cost_usd" IS NULL OR "model_calls"."cost_usd">=0))
);
--> statement-breakpoint
CREATE TABLE "observation_dispositions" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"source_event_id" uuid NOT NULL,
	"canonical_event_id" uuid,
	"origin_observation_key" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"attempt" integer NOT NULL,
	"run_id" uuid,
	"state" text NOT NULL,
	"claim_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"reason_code" text,
	"retryable" boolean DEFAULT false NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "observation_dispositions_state_check" CHECK ("observation_dispositions"."state" IN ('pending','processing','extracted','partial','no_claim','duplicate','unresolved','failed')),
	CONSTRAINT "observation_dispositions_attempt_check" CHECK ("observation_dispositions"."attempt" > 0),
	CONSTRAINT "observation_dispositions_processing_check" CHECK ("observation_dispositions"."state" <> 'processing' OR ("observation_dispositions"."lease_owner" IS NOT NULL AND "observation_dispositions"."lease_until" IS NOT NULL)),
	CONSTRAINT "observation_dispositions_duplicate_check" CHECK ("observation_dispositions"."state" <> 'duplicate' OR "observation_dispositions"."canonical_event_id" IS NOT NULL),
	CONSTRAINT "observation_dispositions_no_claim_check" CHECK ("observation_dispositions"."state" <> 'no_claim' OR "observation_dispositions"."reason_code" IS NOT NULL),
	CONSTRAINT "observation_dispositions_claims_check" CHECK ("observation_dispositions"."state" NOT IN ('extracted','partial') OR cardinality("observation_dispositions"."claim_ids") > 0)
);
--> statement-breakpoint
CREATE TABLE "work_entity_embeddings" (
	"organization_id" uuid NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" uuid NOT NULL,
	"model" text NOT NULL,
	"model_version" text NOT NULL,
	"input_hash" text NOT NULL,
	"permission_fingerprint" text NOT NULL,
	"vector_dimension" integer NOT NULL,
	"vectors_envelope" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "work_entity_embeddings_organization_id_entity_type_entity_id_model_model_version_input_hash_permission_fingerprint_pk" PRIMARY KEY("organization_id","entity_type","entity_id","model","model_version","input_hash","permission_fingerprint"),
	CONSTRAINT "work_entity_embeddings_type_check" CHECK ("work_entity_embeddings"."entity_type" IN ('task','project')),
	CONSTRAINT "work_entity_embeddings_dimension_check" CHECK ("work_entity_embeddings"."vector_dimension">0)
);
--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "schema_version" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "pipeline_version" text;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "prompt_version" text;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "policy_version" text;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "config_hash" text;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "replay_mode" text;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "evaluation_clock" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "knowledge_cutoff" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "manifest_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "output_envelope" jsonb;--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD COLUMN "content_state" text DEFAULT 'active' NOT NULL;--> statement-breakpoint
-- Composite organization-scoped foreign keys below require these indexes first.
CREATE UNIQUE INDEX "interpretation_runs_org_id_uq" ON "interpretation_runs" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "source_events_org_id_uq" ON "source_events" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "inference_budgets_org_id_uq" ON "inference_budgets" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "model_calls_org_id_uq" ON "model_calls" USING btree ("organization_id","id");--> statement-breakpoint
ALTER TABLE "evidence_assessments" ADD CONSTRAINT "evidence_assessments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_assessments" ADD CONSTRAINT "evidence_assessments_organization_id_run_id_interpretation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."interpretation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_claims" ADD CONSTRAINT "evidence_claims_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_claims" ADD CONSTRAINT "evidence_claims_organization_id_extraction_run_id_interpretation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","extraction_run_id") REFERENCES "public"."interpretation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_dependencies" ADD CONSTRAINT "evidence_dependencies_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "evidence_dependencies" ADD CONSTRAINT "evidence_dependencies_organization_id_source_event_id_source_events_organization_id_id_fk" FOREIGN KEY ("organization_id","source_event_id") REFERENCES "public"."source_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inference_budgets" ADD CONSTRAINT "inference_budgets_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_organization_id_budget_id_inference_budgets_organization_id_id_fk" FOREIGN KEY ("organization_id","budget_id") REFERENCES "public"."inference_budgets"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_organization_id_run_id_interpretation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."interpretation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "model_calls" ADD CONSTRAINT "model_calls_organization_id_cached_from_call_id_model_calls_organization_id_id_fk" FOREIGN KEY ("organization_id","cached_from_call_id") REFERENCES "public"."model_calls"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_dispositions" ADD CONSTRAINT "observation_dispositions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_dispositions" ADD CONSTRAINT "observation_dispositions_organization_id_source_event_id_source_events_organization_id_id_fk" FOREIGN KEY ("organization_id","source_event_id") REFERENCES "public"."source_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_dispositions" ADD CONSTRAINT "observation_dispositions_organization_id_canonical_event_id_source_events_organization_id_id_fk" FOREIGN KEY ("organization_id","canonical_event_id") REFERENCES "public"."source_events"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "observation_dispositions" ADD CONSTRAINT "observation_dispositions_organization_id_run_id_interpretation_runs_organization_id_id_fk" FOREIGN KEY ("organization_id","run_id") REFERENCES "public"."interpretation_runs"("organization_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "work_entity_embeddings" ADD CONSTRAINT "work_entity_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_assessments_org_id_uq" ON "evidence_assessments" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_assessments_key_uq" ON "evidence_assessments" USING btree ("organization_id","assessment_key");--> statement-breakpoint
CREATE INDEX "evidence_assessments_target_idx" ON "evidence_assessments" USING btree ("organization_id","target_type","target_id","created_at","id");--> statement-breakpoint
CREATE INDEX "evidence_assessments_claims_idx" ON "evidence_assessments" USING gin ("claim_ids");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_claims_org_id_uq" ON "evidence_claims" USING btree ("organization_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "evidence_claims_run_ordinal_uq" ON "evidence_claims" USING btree ("organization_id","extraction_run_id","ordinal");--> statement-breakpoint
CREATE INDEX "evidence_claims_episode_idx" ON "evidence_claims" USING btree ("organization_id","episode_key","created_at","id");--> statement-breakpoint
CREATE INDEX "evidence_dependencies_reverse_idx" ON "evidence_dependencies" USING btree ("organization_id","source_event_id","dependent_type","dependent_id");--> statement-breakpoint
CREATE INDEX "evidence_dependencies_origin_idx" ON "evidence_dependencies" USING btree ("organization_id","origin_observation_key");--> statement-breakpoint
CREATE UNIQUE INDEX "model_calls_logical_attempt_uq" ON "model_calls" USING btree ("organization_id","logical_call_key","attempt");--> statement-breakpoint
CREATE INDEX "model_calls_run_idx" ON "model_calls" USING btree ("organization_id","run_id","purpose","created_at");--> statement-breakpoint
CREATE INDEX "model_calls_cache_idx" ON "model_calls" USING btree ("organization_id","cache_key","finished_at") WHERE "model_calls"."state"='succeeded';--> statement-breakpoint
CREATE UNIQUE INDEX "observation_dispositions_attempt_uq" ON "observation_dispositions" USING btree ("organization_id","source_event_id","pipeline_version","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "observation_dispositions_active_origin_uq" ON "observation_dispositions" USING btree ("organization_id","origin_observation_key","pipeline_version") WHERE "observation_dispositions"."state" IN ('pending','processing');--> statement-breakpoint
CREATE INDEX "observation_dispositions_retry_idx" ON "observation_dispositions" USING btree ("organization_id","state","next_attempt_at","id");--> statement-breakpoint
CREATE INDEX "observation_dispositions_source_latest_idx" ON "observation_dispositions" USING btree ("organization_id","source_event_id","pipeline_version","attempt");--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD CONSTRAINT "interpretation_runs_schema_version_check" CHECK ("interpretation_runs"."schema_version" IN (1,2));--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD CONSTRAINT "interpretation_runs_replay_mode_check" CHECK ("interpretation_runs"."replay_mode" IS NULL OR "interpretation_runs"."replay_mode" IN ('live','accepted_rebuild','cached_reassess','source_reinterpret'));--> statement-breakpoint
ALTER TABLE "interpretation_runs" ADD CONSTRAINT "interpretation_runs_content_state_check" CHECK ("interpretation_runs"."content_state" IN ('active','revoked','deleted'));
