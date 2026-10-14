# Projects and Tasks redesign E2E

Date: 2026-09-22

## Target

`http://127.0.0.1:4141/app`, rebuilt with `docker compose up -d --build app` against the existing populated Postgres volume.

## Repeatable checks

1. Run `pnpm typecheck`.
2. Run `pnpm exec vitest run test/ui.test.ts`.
3. Rebuild the local app with `docker compose up -d --build app`.
4. Open `/app` in a browser.
5. Confirm Projects and Tasks are separate primary navigation buttons.
6. On Projects, select `Evidence and narrative pipeline`.
7. Confirm the accepted project focus changes to that project and shows 23 accepted tasks.
8. Open `Refine and validate marketless evidence-question generation prompt`.
9. Confirm the accepted-task detail opens with its revision history and source link.
10. Close the detail and open Tasks from primary navigation.
11. Confirm the Tasks page shows the existing four accepted-status lanes.
12. Check the browser console for errors.

## Observed result

- Projects loaded 7 accepted projects and 59 accepted tasks from the populated workspace.
- Project selection updated the accepted project focus without a reload.
- Task detail opened from the project focus and retained its provenance history.
- Tasks opened as its own page with Queued, In motion, Checkpoint, and Closed lanes.
- At a 691 px browser width, the Projects workspace collapsed to one column and the five primary destinations remained available in the bottom navigation.
- Browser console errors: none.

Result: pass.
