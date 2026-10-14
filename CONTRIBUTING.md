# Contributing

Thank you for helping improve Panini.

Before opening a pull request:

1. Keep provider-specific behavior behind a connector boundary.
2. Preserve the evidence to proposal to revision flow. Connectors and agents must not update task rows directly.
3. Add tests for retries, duplicate delivery, stale proposals, and permission failures when relevant.
4. Run `pnpm typecheck`, `pnpm test`, and `pnpm build`.
5. Avoid fixtures that name or reveal a real company. Use clearly fictional, generic examples.

Bug reports should include the storage mode, connector type, sanitized configuration shape, expected behavior, and observed behavior. Never include access tokens or private source content.

