# Self-hosting Panini

One company per installation. Requirements: Docker Engine/Desktop with Compose v2, Node 22+, at least 2 GB available RAM, persistent disk, and an operator who can protect keys and restore backups. Personal accounts require PostgreSQL. Source identities imported from Slack/Notion are not login accounts.

## New installation

```sh
node scripts/selfhost.mjs init --url http://127.0.0.1:4141
node scripts/selfhost.mjs doctor
node scripts/selfhost.mjs start
```

Open `/setup`. Read `APP_ADMIN_TOKEN` from the private `.env` file locally, then create the first owner and company. Do not paste that secret into chat or a public ticket. Invite teammates through Settings. Invitations expire after seven days and work once; share the link privately. Email delivery is not built in. Complete the checklist when ready; skipped connectors do not pretend to be connected.

`init` never replaces an existing `.env`. New installs get random database, content-encryption and installation credentials. The starter config has connectors and model calls disabled. Configure the YAML and credential variables deliberately, then rebuild/restart. Config files are baked into the image; changing a local YAML alone does not update an already running container.

## Existing installation upgrade

Back up before changing anything. Preserve the existing `CONTENT_ENCRYPTION_KEY` and `APP_ADMIN_TOKEN`. Add `POSTGRES_PASSWORD` with the **current** PostgreSQL password and `PANINI_PUBLIC_URL` with the intended origin. Earlier development installs used `team_ledger`; setting a new environment value does not change that database password. Rotate legacy database credentials with PostgreSQL administration before public deployment. The installer does not silently rotate them or erase a volume.

Check out a reviewed release, then:

```sh
node scripts/selfhost.mjs update --file /private/backups/panini-before-upgrade.dump
```

This builds first, stops app/worker, backs up, runs migrations, and restarts. Failed backup/migration leaves the services stopped. There is no automatic schema downgrade. Migration `0016` adds accounts and sessions without replacing existing work, evidence, identities or revisions. First-owner setup disables the old shared browser administrator; the installation secret remains an administrator **service credential**, so guard it accordingly.

Re-enroll agents previously owned by the disabled shared administrator under a named account. Existing evidence and accepted work remain; the old shared identity is no longer an authentication path.

## Public HTTPS

Set `.env`:

```dotenv
PANINI_PUBLIC_URL=https://panini.example.com
PANINI_DOMAIN=panini.example.com
ACME_EMAIL=operator@example.com
```

Point DNS at this host, permit ports 80/443, and run `node scripts/selfhost.mjs start --https`. Pass `--https` to subsequent start/update/doctor/stop commands too. Caddy issues and renews certificates. PostgreSQL and the app publish only on loopback; Caddy alone is public. Do not expose 4141 or 55432, or enable proxy trust behind an uncontrolled proxy. Verify certificate issuance and the actual hostname before inviting users. TLS issuance is not covered by local E2E tests.

## Accounts and agents

### Sign in with GitHub

The configured GitHub App also supplies personal sign-in. Its `GITHUB_CALLBACK_URL` must be `${PANINI_PUBLIC_URL}/api/github/oauth/callback` and registered exactly in GitHub. The repository-connection flow keeps using that callback; login has separate state and browser binding. Configure the existing `GITHUB_APP_ID`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `GITHUB_APP_SLUG`, `GITHUB_APP_PRIVATE_KEY_BASE64`, callback and webhook secret as described in the GitHub connector setup. No extra email-read scope is required.

On Setup, fill installation secret, company, your name and account email, then choose **Create workspace with GitHub**; no password is required. Invitation links offer **Join with GitHub**. Existing password accounts must connect GitHub from Settings before using the login button. Panini never automatically merges accounts by email or username. It stores GitHub's stable user ID, not an OAuth access token. The account email is the one supplied during authorized setup or in the invitation, not a claimed verified GitHub email.

GitHub-only accounts can set a password in Settings. Disconnecting GitHub requires a password to avoid lockout. Disabling a member blocks both login methods. An expired/cancelled OAuth attempt must be restarted; reopen the invitation if it was an invitation flow. A flow lasts ten minutes and is single-use, browser-bound, PKCE-protected and encrypted in PostgreSQL.

Browser pages redirect same-port loopback aliases to the configured canonical origin. For the current local GitHub callback use `http://localhost:4141`; public installations still require their exact HTTPS origin. Unrelated origins, ports and cross-site writes remain rejected.

- Owners manage all accounts. Admins manage reviewers and members, but cannot recover/promote/disable an owner or admin. The last active owner cannot be disabled/demoted.
- Reviewers can review work; members create/propose work. Private source reads are filtered. Accepted shared work is company-visible, not a per-project secrecy boundary.
- Passwords require 15–128 characters and use scrypt. Sessions have an eight-hour lifetime and one-hour idle timeout. Logout, password reset/change and disabling revoke sessions. Requests re-read role/status from PostgreSQL.
- Settings supports profile/password changes, invitations, membership changes and private reset links. Recovery links expire in one hour. No SSO, MFA, automatic email or multi-company tenancy is claimed.
- Agents → Create agent gives one-time enrollment material and harness instructions using the public origin. Store the secret in the harness, then use **Check connection**. A configured profile is not a connected agent; the check requires authenticated use. Imported member identities cannot sign in automatically. Disabling an owner blocks their agents too.

If every owner is locked out, an operator with Docker/database access can run:

```sh
node scripts/selfhost.mjs recover --email owner@example.com
```

It revokes that active account's sessions and prints one private single-use reset link. Do not capture its output in CI logs. Disabled accounts must be re-enabled by another owner; recovery does not bypass disabled status.

## Backup and restore

```sh
node scripts/selfhost.mjs backup --file /private/backups/panini-2026-09-22.dump
```

The dump is mode 0600 and cannot overwrite an existing file. It contains sensitive company information, password hashes and session data: encrypt it before off-host storage. Back up `.env`, custom YAML and the release/commit identifier separately in encrypted storage. **Losing the content-encryption key loses access to encrypted source evidence.** A failed dump can leave an incomplete file; never restore it.

For restore, provision a separate clean installation and restore the original key/config. Start only its PostgreSQL service (`docker compose up -d postgres`), leaving app/worker stopped. Then:

```sh
node scripts/selfhost.mjs restore --file /private/backups/panini-2026-09-22.dump
node scripts/selfhost.mjs start
```

Restore refuses any database containing user tables and refuses running app/worker services. It runs in one transaction. Only restore trusted dumps: PostgreSQL dumps can execute SQL. No command drops the current database. After restoring, verify account access, encrypted evidence and accepted revisions; a successful `pg_restore` alone is insufficient. Treat recovered sessions as sensitive and invalidate them if the backup was exposed. Schedule backups and a restore drill using your host's operating tools; the installer does not silently schedule jobs.

## Operations and limits

`doctor` validates configuration and lists containers; `docker compose logs --tail=100 app worker` shows service errors. App readiness probes PostgreSQL. Worker heartbeat checks the event loop and database every 30 seconds; it does **not** prove external connector success. Docker restart policies restart crashed processes, not unhealthy-but-running containers. Monitor health, disk space, queue failures, connector last-success and backup age externally.

`node scripts/selfhost.mjs stop` stops services without deleting data. No uninstall/delete-volume shortcut is included. Local E2E is not a penetration test or availability guarantee. Public release still needs host firewall, DNS/TLS, real connector/harness checks, recovery access, encrypted off-host backups, alerting and workload capacity testing.

## Repeatable isolated verification

Never point these tests at a production database. The E2E Compose database is tmpfs and disposable.

```sh
docker compose -p panini-production-e2e -f test/compose.e2e.yaml up -d --build --wait
PANINI_E2E_BOOTSTRAP_TOKEN=panini_admin_browser_test_disposable_installation_secret node scripts/production-browser-e2e.mjs
PANINI_PRODUCTION_TEST_DATABASE_URL=postgres://panini_e2e:panini_e2e_disposable_only@127.0.0.1:55439/panini_e2e APP_CONFIG_PATH=test/fixtures/production-config.yaml LOG_LEVEL=silent pnpm exec vitest run test/production.e2e.test.ts
node scripts/selfhost-e2e.mjs
node scripts/install-lifecycle-e2e.mjs
docker compose -p panini-production-e2e -f test/compose.e2e.yaml down
```

Install test dependencies with `pnpm install --frozen-lockfile`, `pnpm exec playwright install chromium` and `pnpm build` first. Browser bootstrap needs a fresh E2E database: use `down` before a new full run. JSON results and secret-free desktop/mobile screenshots are written under `.panini/e2e/`. The restore check starts/removes its own `panini-restore-e2e` database. The lifecycle check uses ports 4150/55438 and removes only its newly created test volume. Temporary backup files remain private for inspection and are not automatically deleted.
