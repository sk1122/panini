# Current flow verification

The selected flow is the work ontology with gpt-6-luna, medium reasoning, and Voyage-4 work embeddings. A local check does not establish live provider accuracy or production deployment.

## Static checks

Run `pnpm typecheck` and `pnpm build`. The production build starts with an empty `dist` directory and compiles runtime source only. Tests remain available for type checking and execution; they are not copied into the runtime build.

Run `pnpm format:check` to check tabs, spacing, and blank lines.

## Process check

Run `node scripts/observation-agent-e2e.mjs` with `PANINI_TEST_DATABASE_URL` and `CONTENT_ENCRYPTION_KEY`. The database name must identify a disposable `panini_e2e` database. The script creates a separate fixture database.

This check starts separate server and worker processes, posts one source observation, and verifies accepted task/context data through the API. It checks original source time, the production model and medium effort, one final completion check, and no repeated writes after worker restart. Provider requests go to local stubs. The JSON receipt is saved under `artifacts/observation-agent/`.

Stop all fixture processes and remove the fixture database after saving its receipt. Never run fixture cleanup against source or completed replay databases.

Run the same command with `PANINI_TEST_ONTOLOGY=1` to verify the default ontology, including native scope and state checks. This fixture leaves the worker ontology override unset. The unflagged fixture checks legacy compatibility.

## Installation checks

`scripts/package-cli-e2e.mjs` checks the packaged installer and release files. `scripts/selfhost-e2e.mjs` and `scripts/install-lifecycle-e2e.mjs` check installation behavior. They use disposable environments. Inspect their requirements before running Docker lifecycle operations.

`scripts/production-browser-e2e.mjs` checks the browser interface against a configured test environment.

## Limits

The completed full replay remains unscored for semantic accuracy. The saved medium gold results do not establish accuracy across the full company corpus. No new live provider run is required for file cleanup.

## Repository check on 2026-10-20

Type checking, the production build, formatting, and separate-process checks passed. The ontology process check left `PANINI_WORK_ONTOLOGY` unset, verified the default route, and saved `agent-process-e2e-fe7107c30b.json` locally. No paid model calls were made.

The broad Vitest suite is not green: seven assertions failed in context retrieval, HTTP repository-scoped recall, classifier configuration, temporal context, and a test requiring a database. Several PostgreSQL suites also require an explicitly configured disposable database. These results do not establish full-suite correctness. They are separate from the passing process E2E check. Private diagnostic receipts remain local.
