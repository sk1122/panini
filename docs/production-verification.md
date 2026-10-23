# Verification

The default flow uses the work ontology, `gpt-6-luna` with medium reasoning, and Voyage-4 work embeddings. All commands below use disposable fixtures. They establish runtime and permission behavior, not live model accuracy or company coverage.

## Build and formatting

```sh
pnpm install --frozen-lockfile
pnpm exec playwright install chromium
pnpm typecheck
pnpm build
pnpm format:check
```

Code uses tabs with width 4 and blank lines around variable groups and between functions.

## Complete database-backed suite

Use a separate disposable PostgreSQL 17 installation with database `panini_e2e`. Do not use a production database. The test account must be able to create fixture databases.

```sh
docker compose -p panini-production-e2e -f test/compose.e2e.yaml up -d --wait postgres
export PANINI_TEST_DATABASE_URL=postgres://panini_e2e:panini_e2e_disposable_only@127.0.0.1:55439/panini_e2e
export PANINI_PRODUCTION_TEST_DATABASE_URL="$PANINI_TEST_DATABASE_URL"
DATABASE_URL="$PANINI_TEST_DATABASE_URL" node dist/src/db/migrate.js
mkdir -p .panini/verification
APP_CONFIG_PATH=test/fixtures/production-config.yaml \
PANINI_AGENT_BROWSER_TEST=true \
PANINI_EVIDENCE_BROWSER_TEST=true \
PANINI_GITHUB_BROWSER_TEST=true \
pnpm exec vitest run --dir test --no-file-parallelism --testTimeout=60000 --reporter=json --outputFile=.panini/verification/tests.json
```

The latest complete local run passed 299 tests with zero failures and zero skips. It includes PostgreSQL storage, HTTP and MCP access, history, projection rebuild, connector fixtures, agent enrollment, and GitHub login with a local authorization fixture. No real GitHub OAuth account or live provider integration is implied by the fixture result.

The repository workflow repeats these checks on Linux. A local pass is not proof that a remote CI job passed; inspect the workflow result for the exact commit.

## Server, worker, and ontology UI

With the same disposable database available:

```sh
CONTENT_ENCRYPTION_KEY=CwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCwsLCws= \
PANINI_TEST_ONTOLOGY=1 PANINI_TEST_BROWSER=1 \
node scripts/observation-agent-e2e.mjs
```

This starts separate server and worker processes, posts a fictional source observation, validates native scope and evidence rules, and checks that restart does not repeat accepted writes. It also opens the real browser UI, checks requested work and linked attempts, opens the original source, and checks mobile width. All model and embedding calls use local stubs. JSON receipts and screenshots are written under `artifacts/observation-agent/`; fixture databases remain available for inspection.

The unflagged process fixture checks legacy compatibility. It does not change the product default.

## Clean installation in the browser

Run against a new E2E stack, not one where owner setup was already completed:

```sh
docker compose -p panini-production-e2e -f test/compose.e2e.yaml down
docker compose -p panini-production-e2e -f test/compose.e2e.yaml up -d --build --wait
PANINI_E2E_BOOTSTRAP_TOKEN=panini_admin_browser_test_disposable_installation_secret node scripts/production-browser-e2e.mjs
docker compose -p panini-production-e2e -f test/compose.e2e.yaml down
```

This checks owner setup, reload, settings, agent enrollment, actual authenticated MCP use, invitation acceptance on mobile, logout, and login errors. It saves a JSON report and screenshots under `.panini/e2e/` without capturing enrollment secrets.

## Package and recovery

`node scripts/package-cli-e2e.mjs` builds and extracts the release archive, checks that private files are excluded, initializes its CLI, and validates Compose configuration. `scripts/selfhost-e2e.mjs` and `scripts/install-lifecycle-e2e.mjs` exercise backup/restore and installation lifecycle; follow their fixture requirements before running them.

## Demo recording

Add `PANINI_RECORD_DEMO=1` to the ontology browser process command. It enrolls a fictional demo agent, verifies a real scoped MCP context request, and records the app using local model stubs. Video, captions, and the MCP proof are saved under `.panini/release/demo/`. The recording labels simulated model responses in every scene. No live source credentials or private company records are used.

## Limits

These checks do not establish semantic accuracy on unseen company messages, a complete company model, public TLS, live connector permissions, or hosted-service availability. Historical manual lifecycle receipts written before the distinct-receipt fix are not rewritten automatically. Retained private source data and previous experiments are not required to run these fixtures.
