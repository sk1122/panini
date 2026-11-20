-- A session's conversation, held only until decisions are extracted from it.
CREATE TABLE agent_session_transcripts (
	organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
	session_id uuid NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
	envelope jsonb NOT NULL,
	attempts integer NOT NULL DEFAULT 0,
	created_at timestamptz NOT NULL DEFAULT now(),
	PRIMARY KEY (organization_id, session_id)
);
--> statement-breakpoint
ALTER TABLE decisions DROP CONSTRAINT decisions_source_kind_check;
--> statement-breakpoint
ALTER TABLE decisions ADD CONSTRAINT decisions_source_kind_check CHECK (source_kind IN ('code','agent','record','session'));
