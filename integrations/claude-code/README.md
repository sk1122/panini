# Claude Code plugin package

This directory is a Claude Code plugin containing:

- the Panini Streamable HTTP MCP connection;
- a Panini skill;
- metadata-only lifecycle hooks that enqueue through `panini-relay`.

Set `PANINI_URL` and `PANINI_AGENT_TOKEN` from the enrolled Panini profile. Initialize and enroll the local relay separately, then install this directory through Claude Code's plugin workflow. The hook never uploads prompts, transcripts, assistant messages, tool input/output, or arbitrary files.
