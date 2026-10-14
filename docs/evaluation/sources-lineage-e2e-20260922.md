# Sources lineage E2E — 2026-09-22

## Scenario

1. Build and restart the local app.
2. Open `http://127.0.0.1:4141/app` and select **Sources**.
3. Find **Lineage** below the source-record browser.
4. Confirm the combined view contains both `TASK` and `CONTEXT` revisions with recorded timestamps.
5. Select **Tasks** in the lineage filter.
6. Confirm every visible item is a Task revision and the count updates.
7. Open **Setup Repo** from its lineage row.
8. Confirm the accepted Task detail opens with status `done`, owner `Rahul`, its recorded time, revision note, and source link.

## Observed result

Passed against the populated local workspace.

- Combined lineage: latest 20 of 250 accepted Task and Context revisions.
- Task filter: latest 20 of 107 Task revisions; no Context rows remained.
- Opening the `Setup Repo` lineage row loaded the accepted Task and its revision history.
- The complete timeline remains available through **Open full history**.

## Repeatable checks

```bash
pnpm exec vitest run test/ui.test.ts
pnpm run build
docker compose up -d --build app
```

The browser portion is repeatable with the eight steps above against the populated local workspace.
