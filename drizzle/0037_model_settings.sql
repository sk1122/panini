CREATE TABLE model_settings (
 organization_id uuid PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE,
 model text NOT NULL,
 api_key_envelope jsonb NOT NULL,
 key_hint text NOT NULL,
 budget_id uuid,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now()
);
