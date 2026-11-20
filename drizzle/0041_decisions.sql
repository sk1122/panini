-- The decisions ledger: what was decided, by whom, for whom, and whether the owner has seen it.
CREATE TABLE decisions (
	id uuid PRIMARY KEY,
	organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	source_kind text NOT NULL CHECK (source_kind IN ('code','agent','record')),
	source_key text NOT NULL,
	title text NOT NULL,
	category text NOT NULL,
	envelope jsonb NOT NULL,
	decided_by text NOT NULL,
	agent_profile_id uuid REFERENCES agent_profiles(id) ON DELETE SET NULL,
	owner_member_id uuid,
	session_id uuid REFERENCES agent_sessions(id) ON DELETE SET NULL,
	context_entry_id uuid,
	repository text,
	file_path text,
	silent boolean NOT NULL,
	owner_state text NOT NULL DEFAULT 'unseen' CHECK (owner_state IN ('unseen','acknowledged','overridden')),
	owner_note text,
	state_changed_by text,
	state_changed_at timestamptz,
	decided_at timestamptz NOT NULL,
	created_at timestamptz NOT NULL DEFAULT now(),
	UNIQUE (organization_id, source_key)
);
--> statement-breakpoint
CREATE INDEX decisions_recent_idx ON decisions (organization_id, decided_at DESC);
--> statement-breakpoint
CREATE INDEX decisions_owner_idx ON decisions (organization_id, owner_member_id, owner_state);
