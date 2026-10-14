# Codex package

Install `panini/` into the user's Codex skills directory, then add the enrolled profile as a Streamable HTTP MCP server:

```sh
cp -R integrations/codex/panini "$CODEX_HOME/skills/panini"
codex mcp add panini --url "$PANINI_URL/mcp" --bearer-token-env-var PANINI_AGENT_TOKEN
codex mcp list
```

Keep `PANINI_AGENT_TOKEN` in the user's secret manager or shell environment. Do not commit it. Codex reads through MCP and writes only evidence or proposals; it does not receive direct accepted-state mutation tools.
