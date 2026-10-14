# Shareable workspace pages verification

Verified on 2026-09-22 against the rebuilt local Compose app at `http://127.0.0.1:4141`.

## Repeatable checks

```sh
pnpm exec vitest run test/ui.test.ts test/http.test.ts --reporter=dot
pnpm typecheck
docker compose up -d --build app
```

The targeted suite passed 37 tests. It requests every supported `/app/:page` route and checks the shared app shell response.

## Live browser result

- Opening `/app/projects` directly rendered Projects.
- Clicking Tasks changed the address to `/app/tasks` and rendered Tasks without a reload.
- Opening `/app/context` directly rendered Context with Context selected.
- The workspace control rendered at the top right on both desktop and narrow layouts.
- The former updated-time label was absent.

Supported direct routes: `projects`, `tasks`, `context`, `people`, `timeline`, `review`, `agents`, `integrations`, `history`, and `company`.
