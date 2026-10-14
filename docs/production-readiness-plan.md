# Production readiness implementation

Target: one company per self-hosted Panini installation, backed by PostgreSQL. Existing company evidence and revisions must survive the upgrade. The populated local installation remains stopped during development.

## Deliverables

- First owner and company setup protected by the installation secret; no public signup.
- Personal email/password accounts, persistent revocable sessions, logout, profile settings, password changes and recovery.
- Owner/admin/reviewer/member permissions enforced by the server, invitations and disabled accounts. Imported source identities do not become login accounts automatically.
- Persistent company and onboarding state, a useful empty workspace, reachable agents/integrations/settings, and first-agent connection verification.
- Production configuration validation, locked dependencies, a non-root image, service health/restart behavior, HTTPS proxy configuration, installation/doctor/backup/restore/update scripts.
- Repeatable isolated PostgreSQL + HTTP/browser verification and a release report that distinguishes tested behavior from external deployment checks.

## Failure cases to verify before implementation

1. An unauthenticated visitor reads workspace data, writes data, or bootstraps without the installation secret.
2. Concurrent setup creates multiple first owners or overwrites an existing company; restart reverts a company name.
3. Login accepts a wrong password, leaks account existence, or allows unlimited guessing across server restarts.
4. Session cookies lack required attributes; spoofed forwarding headers weaken security; malformed cookies cause a server error.
5. Logout, password change/reset, or membership disable leaves an old session usable; role changes use stale cookie claims.
6. Cross-origin requests or missing/incorrect CSRF tokens mutate browser state, including logout and account changes.
7. Invites can be reused, accepted after expiry/revocation, forge their role/email, or grant access to an imported identity by matching its name.
8. A member promotes themselves, changes company settings, reads private source content, manages someone else's agent, or grants an agent more access than the member has.
9. An administrator disables/demotes the final owner or uses account recovery to take over another owner.
10. Onboarding claims a connected source/agent without evidence; a refresh loses onboarding or user state; direct routes bypass sign-in.
11. Enrollment endpoints contain localhost on a public deployment; revoked agents or agents owned by disabled members still authenticate.
12. Production starts with memory storage, default/absent secrets, unsafe HTTP origins or missing encryption. Logs disclose passwords, tokens, or invitation links.
13. Setup overwrites existing keys/data; backup omits encrypted-content key guidance; restore targets a nonempty database by accident; migrations cannot run twice.
14. Login, setup, invitation, settings, onboarding, and logout are unusable on narrow screens or cannot be completed with normal form controls.

## Release boundaries

Real DNS/TLS issuance, real email delivery (invitations/recovery are administrator-shared links), and third-party harness/connector credentials require deployment-specific validation. Do not call these verified solely from local fixtures. No paid model or connector execution is needed for this work.
