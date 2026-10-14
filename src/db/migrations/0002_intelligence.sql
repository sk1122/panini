ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_kind_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN ('task_create', 'task_change', 'context_update'));

CREATE TABLE IF NOT EXISTS interpretation_runs (
  id uuid PRIMARY KEY,
  input_hash text NOT NULL,
  model text NOT NULL,
  state text NOT NULL CHECK (state IN ('running', 'completed', 'failed')),
  event_ids uuid[] NOT NULL,
  output jsonb,
  error text,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS interpretation_runs_state_created_idx
  ON interpretation_runs (state, created_at DESC);

CREATE INDEX IF NOT EXISTS interpretation_runs_event_ids_idx
  ON interpretation_runs USING gin (event_ids);
