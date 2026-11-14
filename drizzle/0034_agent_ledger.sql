CREATE TABLE agent_sessions (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
 member_id uuid NOT NULL,
 client_session_id text NOT NULL,
 harness text,
 repository text,
 branch text,
 objective text,
 state text NOT NULL CHECK (state IN ('active','ended','failed')),
 started_at timestamptz NOT NULL,
 last_seen_at timestamptz NOT NULL,
 ended_at timestamptz,
 cost_usd numeric(14,6),
 input_tokens bigint,
 output_tokens bigint,
 UNIQUE (organization_id,agent_profile_id,client_session_id)
);
--> statement-breakpoint
CREATE INDEX agent_sessions_profile_seen_idx ON agent_sessions (organization_id,agent_profile_id,last_seen_at DESC);
--> statement-breakpoint
CREATE INDEX agent_sessions_seen_idx ON agent_sessions (organization_id,last_seen_at DESC);
--> statement-breakpoint
CREATE TABLE task_claims (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
 agent_profile_id uuid NOT NULL,
 member_id uuid NOT NULL,
 state text NOT NULL CHECK (state IN ('active','released','expired','taken_over')),
 inferred boolean NOT NULL DEFAULT false,
 claimed_at timestamptz NOT NULL,
 expires_at timestamptz NOT NULL,
 released_at timestamptz
);
--> statement-breakpoint
CREATE UNIQUE INDEX task_claims_one_active_idx ON task_claims (organization_id,task_id,session_id) WHERE state='active';
--> statement-breakpoint
CREATE INDEX task_claims_task_idx ON task_claims (organization_id,task_id,claimed_at DESC);
--> statement-breakpoint
CREATE TABLE agent_activity_events (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
 member_id uuid NOT NULL,
 session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
 occurred_at timestamptz NOT NULL,
 tool text NOT NULL,
 action_class text NOT NULL CHECK (action_class IN ('read','search','write','propose','report','claim','session')),
 target_ids text[] NOT NULL DEFAULT '{}',
 result_count integer,
 outcome text NOT NULL CHECK (outcome IN ('ok','denied','error')),
 detail text,
 duration_ms integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX agent_activity_profile_idx ON agent_activity_events (organization_id,agent_profile_id,occurred_at DESC);
--> statement-breakpoint
CREATE INDEX agent_activity_session_idx ON agent_activity_events (organization_id,session_id,occurred_at DESC);
--> statement-breakpoint
CREATE TABLE handoff_notes (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
 session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
 agent_profile_id uuid,
 member_id uuid,
 author text NOT NULL,
 done text NOT NULL,
 not_done text NOT NULL,
 open_questions text NOT NULL,
 next_step text NOT NULL,
 artifacts text[] NOT NULL DEFAULT '{}',
 source_event_id uuid NOT NULL REFERENCES source_events(id),
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX handoff_notes_task_idx ON handoff_notes (organization_id,task_id,created_at DESC);
--> statement-breakpoint
CREATE TABLE team_notes (
 id uuid PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 author text NOT NULL,
 agent_profile_id uuid,
 member_id uuid,
 session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
 project text,
 task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
 text text NOT NULL,
 links text[] NOT NULL DEFAULT '{}',
 visibility text NOT NULL,
 state text NOT NULL CHECK (state IN ('open','promoted','dismissed')),
 source_event_id uuid NOT NULL REFERENCES source_events(id),
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX team_notes_state_idx ON team_notes (organization_id,state,created_at DESC);
