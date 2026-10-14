# Production verification — 22 September 2026

## Outcome

Personal accounts, company setup/settings, user state, invitations/recovery, onboarding and agent enrollment are implemented. The single-company self-host deployment was exercised with real Docker, PostgreSQL, HTTP and Chromium. This is a locally verified release candidate, **not a claim that a public production deployment has been commissioned or independently security-audited**.

The existing `jira-for-agent` installation was not restarted, migrated or modified. Its database, credentials and configuration were preserved. Disposable test services were shut down after verification. No real connector sync or paid model run was performed.

## Verified

| Check | Result | Repeatable artifact |
| --- | --- | --- |
| Existing standard suite | 186 passed; PostgreSQL-only suites run separately | [suite-results.json](../.panini/e2e/suite-results.json) |
| Real PostgreSQL account/security HTTP scenarios | 7 passed | [production-api-results.json](../.panini/e2e/production-api-results.json) |
| Existing real PostgreSQL regression scenarios | 8 passed | [postgres-regression-results.json](../.panini/e2e/postgres-regression-results.json) |
| Chromium desktop/mobile flow | Passed; setup, persistent profile/company, invite, login/logout, agent enrollment and authenticated MCP connection status | [browser-results.json](../.panini/e2e/browser-results.json) |
| Installation, healthy app/worker, CLI recovery and upgrade | Passed using the production Compose file in a separate project | [install-lifecycle-results.json](../.panini/e2e/install-lifecycle-results.json) |
| Backup/restore | Actual dump restored to another empty PostgreSQL instance; accounts preserved; encrypted probe decrypted only with original key; nonempty restore refused | [selfhost-results.json](../.panini/e2e/selfhost-results.json) |
| TypeScript, build, migration metadata | Passed; migrations also rerun successfully | `pnpm typecheck`, `pnpm build`, `pnpm db:check` |
| Production dependency audit | No known advisories reported after updating YAML to 2.8.3 | `pnpm audit --prod` |

Screenshots were inspected: [onboarding desktop](../.panini/e2e/onboarding-desktop.png), [settings desktop](../.panini/e2e/settings-desktop.png), [teammate mobile](../.panini/e2e/member-mobile.png). Enrollment secrets are deliberately excluded from screenshots.

The HTTP scenarios cover first-owner concurrency, persistence, durable login limits, invalid/expired/revoked invitations, reset/password/logout/disable revocation, CSRF/origin checks, malformed/expired sessions, role escalation, final-owner protection, private-source filtering, agent ownership and disabled-owner MCP denial. A regression specifically blocks reviewers from changing private current context through a readable historical revision. Browser testing also caught and fixed background refresh overwriting an unsaved profile field.

The backup probe verifies the application's AES-GCM cipher through the dump/restore path; it is synthetic test evidence, not a replay of the user's production corpus. Chromium sends a real authenticated MCP `tools/list` request; this is not a claim that every external harness has been configured.

## Before public launch

- Configure the real HTTPS origin, DNS and firewall; validate Caddy certificate issuance and renewal. The HTTPS overlay is provided, but public TLS was not exercised locally.
- Preserve the existing content key. Set the **existing** database password in the new Compose variable; rotate any old development password through PostgreSQL administration before public exposure. `init` does not silently replace existing values.
- Back up the real database and keys, review migration `0016`, and rehearse restoration of real evidence on an isolated host before upgrading the existing installation.
- Create the first named owner and re-enroll any agents attached to the old shared administrator. Test the intended harness and real Slack/Notion/GitHub credentials and revocation behavior.
- Arrange encrypted off-host backups, health/queue/connector alerts, disk monitoring, recovery ownership and workload capacity checks. A Docker health check alone does not provide these.
- Decide whether this deployment requires SSO/MFA or automatic email. These are not implemented; invitation/recovery links are currently administrator-shared. One company per installation, not multi-tenant SaaS.
- Production retrieval/decision quality, connector outage coverage and external security testing remain separate release gates. Passing these account/operations tests does not validate model judgments.

Follow [self-hosting.md](self-hosting.md) for install/upgrade/restore commands and the exact isolated verification workflow. Generated JSON and screenshots are local ignored artifacts; rerun the scripts to reproduce them. The test installer leaves mode-0600 temporary dumps for inspection and removes only its own newly created test volumes.
