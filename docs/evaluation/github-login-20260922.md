# GitHub login: deployed verification

Verified 2026-09-22 at 06:23 UTC.

## Running now

- Existing Panini installation at http://localhost:4141; app, worker and PostgreSQL healthy.
- GitHub sign-in enabled. An owner account already exists (`setupRequired: false`). Existing password accounts must connect GitHub under Settings → GitHub sign-in before using it at login.
- Local canonical URL is localhost. Requests to 127.0.0.1/setup redirect to localhost/setup.
- The reported setup error came from localhost versus configured 127.0.0.1. Safe same-port loopback aliases now pass the origin guard; other origins and cross-site requests remain denied.
- Live invalid-token setup request with Origin localhost returned 401 incorrect installation secret, not the previous 403 workspace-origin error. No account was created by verification.
- Migration 0017 applied after backup to `backups/pre-github-login-20260922.dump`. Existing data retained.

## Tested

- Six GitHub E2E checks passed against disposable PostgreSQL, including Chromium setup, password addition, disconnect/reconnect, logout and repeat login.
- GitHub provider responses were fixtures. Browser report: `.panini/e2e/github-browser-results.json`; test report: `.panini/e2e/github-login-results.json`.
- Existing standard suite: 186 passed, 21 opt-in checks skipped; report `.panini/e2e/suite-results.json`. Existing production security checks also passed in the separate PostgreSQL run.
- Type checking, migration checks and deployment image build passed.
- Disposable `panini-production-e2e` database stopped and removed after verification. Live installation left running.

Repeat the GitHub and production checks with the disposable database from `test/compose.e2e.yaml` running:

```sh
PANINI_GITHUB_BROWSER_TEST=true PANINI_PRODUCTION_TEST_DATABASE_URL=postgres://panini_e2e:panini_e2e_disposable_only@127.0.0.1:55439/panini_e2e APP_CONFIG_PATH=test/fixtures/production-config.yaml LOG_LEVEL=silent pnpm exec vitest run test/github-login.e2e.test.ts test/production.e2e.test.ts --no-file-parallelism --reporter=json --outputFile=.panini/e2e/github-login-results.json
```

## Not yet verified

Real GitHub user consent and return to the live installation require the user's account. No real GitHub consent was submitted during testing. These results do not verify unrelated connector sync health.
