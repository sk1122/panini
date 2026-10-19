CREATE TABLE work_scopes (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 task_id uuid NOT NULL REFERENCES tasks(id),
 source_event_ids uuid[] NOT NULL,
 body_envelope jsonb,
 UNIQUE (organization_id,task_id)
);
--> statement-breakpoint
CREATE TABLE work_state_assessments (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 task_id uuid NOT NULL REFERENCES tasks(id),
 scope_id uuid NOT NULL REFERENCES work_scopes(id),
 run_id uuid NOT NULL REFERENCES interpretation_runs(id),
 model_call_id uuid NOT NULL REFERENCES model_calls(id),
 operation_key text NOT NULL,
 source_event_ids uuid[] NOT NULL,
 body_envelope jsonb,
 UNIQUE (organization_id,operation_key)
);
