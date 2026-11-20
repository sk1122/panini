CREATE TABLE connector_credentials (
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 provider text NOT NULL CHECK (provider IN ('github','slack','notion')),
 envelope jsonb NOT NULL,
 updated_by text NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organization_id, provider)
);
