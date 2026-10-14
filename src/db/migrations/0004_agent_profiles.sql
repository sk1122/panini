CREATE TABLE IF NOT EXISTS agent_profiles (
  id uuid PRIMARY KEY,
  owner text NOT NULL,
  name text NOT NULL,
  harness text NOT NULL CHECK (harness IN ('codex', 'claude_code', 'pi', 'generic_mcp')),
  description text NOT NULL DEFAULT '',
  capabilities text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'revoked')),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  token_hint text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  last_used_at timestamptz,
  CONSTRAINT agent_profiles_capabilities_check CHECK (
    cardinality(capabilities) > 0
    AND capabilities <@ ARRAY[
      'work:read', 'work:propose', 'context:read', 'context:propose', 'evidence:report'
    ]::text[]
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_profiles_owner_name_idx
  ON agent_profiles (lower(owner), lower(name));
CREATE INDEX IF NOT EXISTS agent_profiles_status_idx ON agent_profiles (status, updated_at DESC);
