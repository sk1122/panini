ALTER TABLE agent_profiles
  DROP CONSTRAINT IF EXISTS agent_profiles_harness_check;

ALTER TABLE agent_profiles
  ADD CONSTRAINT agent_profiles_harness_check
  CHECK (harness IN ('codex', 'claude_code', 'hermes', 'pi', 'generic_mcp'));
