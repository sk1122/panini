CREATE TABLE IF NOT EXISTS schema_migrations (
  name text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS source_events (
  id uuid PRIMARY KEY,
  provider text NOT NULL,
  installation_key text NOT NULL,
  provider_event_id text NOT NULL,
  event_kind text NOT NULL,
  occurred_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  source_ref text NOT NULL,
  source_url text,
  content_hash text NOT NULL,
  visibility text NOT NULL,
  payload_version text NOT NULL,
  payload jsonb NOT NULL,
  UNIQUE (provider, installation_key, provider_event_id)
);

CREATE INDEX IF NOT EXISTS source_events_source_ref_idx ON source_events (source_ref, received_at DESC);

CREATE TABLE IF NOT EXISTS context_documents (
  id uuid PRIMARY KEY,
  source_event_id uuid NOT NULL REFERENCES source_events(id),
  source_ref text NOT NULL UNIQUE,
  key text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  source_url text,
  content_hash text NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY,
  external_ref text UNIQUE,
  document jsonb NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS tasks_updated_at_idx ON tasks (updated_at DESC);

CREATE TABLE IF NOT EXISTS proposals (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('task_create', 'task_change')),
  task_id uuid REFERENCES tasks(id),
  base_version integer,
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected', 'auto_applied')),
  changes jsonb NOT NULL,
  rationale text NOT NULL,
  requested_by text NOT NULL,
  evidence_ids jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  decided_at timestamptz,
  decided_by text,
  decision_note text
);

CREATE INDEX IF NOT EXISTS proposals_state_created_idx ON proposals (state, created_at DESC);

CREATE TABLE IF NOT EXISTS task_revisions (
  id uuid PRIMARY KEY,
  task_id uuid NOT NULL REFERENCES tasks(id),
  version integer NOT NULL,
  proposal_id uuid NOT NULL REFERENCES proposals(id),
  previous jsonb,
  current jsonb NOT NULL,
  applied_at timestamptz NOT NULL,
  applied_by text NOT NULL,
  UNIQUE (task_id, version),
  UNIQUE (proposal_id)
);

