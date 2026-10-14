# Multi-harness agent setup

## Implemented

- Agent creation no longer asks for a harness. The API accepts omission and retains the legacy field for existing clients and profiles.
- Creation, setup and secret rotation return all five setup recipes for the same profile, endpoint and credential.
- Registered active agents appear in the top-bar Connect MCP menu. Choose an agent and Codex, Claude Code, Hermes Agent, Pi or Other MCP.
- The connection dialog also has a harness option bar. Switching recipes preserves the one-time secret while the dialog is open. Closing it clears the secret; reopening uses the saved credential or requires rotation if lost.
- Agent cards no longer label an identity as belonging to one harness.

## Verification

Chromium E2E passed with a disposable in-memory store and real HTTP routes: creation without a harness, all five recipes, one identity/credential, secret hidden after reopening, top-bar selection, and mobile overflow checks. No real harness client was launched.

Artifacts: `.panini/e2e/agent-harness-browser.json`, `agent-harness-desktop.png`, and `agent-harness-mobile.png`. Screenshots exclude credentials.

Repeat:

```sh
PANINI_AGENT_BROWSER_TEST=true APP_CONFIG_PATH=test/fixtures/production-config.yaml LOG_LEVEL=silent pnpm exec vitest run test/agent-harness.e2e.test.ts
```

Type checking passed. Full-suite verification is not clean: an initial run had a failing identity_get test in concurrently edited MCP work; a subsequent run encountered a parse error in src/mcp/server.ts while that file was being edited. This change does not modify that file. Latest suite artifact: `.panini/e2e/agent-harness-suite.json`.

## Deployment

Not deployed. The existing service on 4141 was left unchanged to avoid deploying unrelated, actively changing MCP code. Rerun the full suite once that work settles, then deploy using the normal backed-up self-host update.
