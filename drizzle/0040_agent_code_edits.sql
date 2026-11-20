-- Each file edit an agent makes in a session: the code it changed, encrypted.
CREATE TABLE agent_code_edits (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
	agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
	tool_use_id text NOT NULL,
	tool text NOT NULL,
	file_path text NOT NULL,
	lines_added integer NOT NULL,
	lines_removed integer NOT NULL,
	envelope jsonb NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, session_id, tool_use_id)
);
--> statement-breakpoint
CREATE INDEX agent_code_edits_session_idx ON agent_code_edits (organization_id, session_id, created_at);
