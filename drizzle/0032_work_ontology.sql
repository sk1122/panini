CREATE TABLE work_entities (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 kind text NOT NULL CHECK (kind IN ('execution','artifact')),
 identity_hash text NOT NULL,
 UNIQUE (organization_id,identity_hash)
);
--> statement-breakpoint
CREATE TABLE work_assertions (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id),
 entity_id uuid NOT NULL REFERENCES work_entities(id),
 task_id uuid REFERENCES tasks(id),
 claim_id uuid NOT NULL REFERENCES evidence_claims(id),
 source_event_id uuid NOT NULL REFERENCES source_events(id),
 operation_key text NOT NULL,
 input_hash text NOT NULL,
 body_envelope jsonb,
 UNIQUE (organization_id,operation_key)
);
--> statement-breakpoint
CREATE INDEX work_assertions_source_idx ON work_assertions(organization_id,source_event_id);
