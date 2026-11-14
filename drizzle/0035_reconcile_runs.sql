CREATE TABLE reconcile_runs (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 trigger text NOT NULL CHECK (trigger IN ('schedule','manual')),
 state text NOT NULL CHECK (state IN ('running','completed','failed')),
 cursor_received_at timestamptz,
 cursor_id uuid,
 processed integer NOT NULL DEFAULT 0,
 duplicates integer NOT NULL DEFAULT 0,
 skipped integer NOT NULL DEFAULT 0,
 failed integer NOT NULL DEFAULT 0,
 error text,
 digest text,
 started_at timestamptz NOT NULL DEFAULT now(),
 finished_at timestamptz
);
--> statement-breakpoint
CREATE INDEX reconcile_runs_started_idx ON reconcile_runs (organization_id,started_at DESC);
--> statement-breakpoint
CREATE UNIQUE INDEX reconcile_runs_one_running_idx ON reconcile_runs (organization_id) WHERE state='running';
