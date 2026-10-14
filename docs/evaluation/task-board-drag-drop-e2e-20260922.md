# Task board drag-and-drop E2E

Date: 2026-09-22

## Isolation

The test ran on a temporary in-memory Panini server at `127.0.0.1:4142`. It did not read or change the populated Postgres workspace on port 4141. The server was stopped after verification, so its test task was discarded.

## Steps

1. Start Panini without `DATABASE_URL` on port 4142.
2. Open `/app` and navigate to Tasks.
3. Create `Drag E2E task` in the default Backlog state.
4. Drag the card from Queued to In motion.
5. Wait for the saved board reload.
6. Open the moved task and inspect its revision history.
7. Check the browser console.

## Result

- The destination lane highlighted during the drag.
- The board announced `Drag E2E task moved to In motion.`
- The task reloaded under In motion with status `in_progress`.
- Task history recorded `Status: backlog -> in progress`.
- The saved rationale was `Moved on the task board from backlog to in progress.`
- The change went through proposal creation and approval endpoints.
- Browser console errors: none.

Result: pass.
