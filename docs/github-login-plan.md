# GitHub login and local-origin repair

Failure cases, recorded before implementation:

- localhost setup is rejected while the configured origin is 127.0.0.1. Canonical browser navigation must converge on one configured host without accepting unrelated hosts, ports or cross-site writes.
- OAuth login can create an uninvited account, replace a password account by email match, or create a first owner without the installation secret.
- Forged/reused/expired state, missing/wrong browser cookie, revoked link session or another browser completes authorization.
- A restart loses a valid OAuth flow. Tokens/verifiers/invitation secrets appear in logs or plaintext storage.
- A renamed GitHub handle changes identity; disabled members sign in; linking one GitHub ID to two members succeeds.
- GitHub-only accounts accidentally accept password login or cannot set a password; disconnect removes the final login method.
- GitHub provider denial/outage leaves a raw callback error page or leaks authorization codes.
- The repository-connection callback conflicts with login callback handling.

Approach: reuse the configured GitHub App and its exact existing callback, separate login state prefix, PKCE, short-lived encrypted PostgreSQL state bound to an HttpOnly browser cookie. OAuth tokens are used only to fetch `/user` and are not retained. Stable numeric GitHub ID identifies the login. Setup still requires installation secret and user-supplied company/name/email, just like password setup. Joining requires a single-use invitation. Existing accounts explicitly connect GitHub from their authenticated Settings page; there is no email-based automatic linking and no extra email-read permission requirement.

E2E tests use real PostgreSQL and HTTP routes, with only GitHub network responses replaced by a fixture. Real browser authorization requires the user to approve GitHub; never claim that fixture proves external consent succeeded.

References: [GitHub login flow](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app), [stable identity guidance](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/best-practices-for-creating-an-oauth-app), [callback URLs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url).
