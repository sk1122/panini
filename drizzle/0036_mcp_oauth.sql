CREATE TABLE oauth_clients (
 client_id text PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 client_name text NOT NULL,
 redirect_uris text[] NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE oauth_refresh_tokens (
 token_hash text PRIMARY KEY,
 organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
 client_id text NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
 agent_profile_id uuid NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
 expires_at timestamptz NOT NULL,
 used_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX oauth_refresh_tokens_profile_idx ON oauth_refresh_tokens (organization_id,agent_profile_id);
