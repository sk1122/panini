export const appStyles = String.raw`
.workspace-file-content { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 50vh; overflow: auto; font: 13px/1.6 ui-monospace, monospace; }
:root {
  color-scheme: light;
  --canvas: #f8f6f0;
  --sidebar: #f3f0e8;
  --surface: #fffefa;
  --surface-muted: #f7f4ed;
  --surface-subtle: #efede6;
  --ink: #111520;
  --muted: #626773;
  --faint: #858995;
  --line: #dfdbd1;
  --line-strong: #c9c4b9;
  --accent: #2454df;
  --accent-strong: #1646d8;
  --accent-soft: #e9edff;
  --positive: #477461;
  --positive-soft: #eaf3ef;
  --warning: #8c673c;
  --warning-soft: #f7f0e6;
  --danger: #9b4e59;
  --danger-soft: #f8edef;
  --shadow: 0 16px 42px rgba(43, 57, 70, .10);
  --shadow-small: 0 5px 16px rgba(43, 57, 70, .07);
  --radius-panel: 16px;
  --radius-card: 12px;
  --radius-control: 9px;
  --task-card-min: 168px;
  --sans: ui-sans-serif, system-ui, sans-serif;
  --mono: ui-monospace, monospace;
  --display: var(--sans);
  --body: var(--sans);
}

* { box-sizing: border-box; }
[hidden] { display: none !important; }
.sr-only { width: 1px; height: 1px; position: absolute; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; clip-path: inset(50%); }
html { background: var(--canvas); }
body {
  margin: 0;
  min-width: 320px;
  color: var(--ink);
  background: var(--canvas);
  font: 14px/1.5 var(--body);
  -webkit-font-smoothing: antialiased;
}
button, input, select, textarea { color: inherit; font: inherit; }
button { white-space: nowrap; }
a { color: inherit; }
.ph { display: inline-block; flex: none; font-size: 1em; vertical-align: -.08em; }
.spin { animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

.app-shell { min-height: 100dvh; display: grid; grid-template-columns: 228px minmax(0, 1fr); }
.sidebar {
  min-height: 100dvh;
  height: 100dvh;
  display: flex;
  flex-direction: column;
  position: sticky;
  top: 0;
  z-index: 20;
  padding: 18px 12px 15px;
  border-right: 1px solid var(--line);
  background: var(--sidebar);
}
.brand-lockup { display: flex; align-items: center; gap: 10px; padding: 0 7px 16px; text-decoration: none; }
.brand-lockup > div { display: grid; line-height: 1.15; }
.brand-lockup strong { font: 700 14px/1.2 var(--display); letter-spacing: -.02em; }
.brand-lockup span:not(.brand-mark) { margin-top: 3px; color: var(--muted); font-size: 10px; }
.brand-mark {
  width: 32px;
  height: 32px;
  display: grid;
  place-items: center;
  border-radius: 10px;
  color: #f8fbfd;
  background: var(--accent-strong);
  box-shadow: 0 4px 12px rgba(61,95,126,.16), inset 0 1px rgba(255,255,255,.18), inset 0 -3px #e13e24;
  font: 700 21px/1 var(--display);
  padding-top: 2px;
}

.workspace-switcher {
  min-height: 46px;
  display: grid;
  grid-template-columns: 30px minmax(0,1fr) 16px;
  gap: 9px;
  align-items: center;
  width: min(280px, 42vw);
  padding: 7px 8px;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: rgba(255,255,255,.58);
}
.workspace-avatar { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: var(--accent-soft); font-size: 11px; font-weight: 800; }
.workspace-switcher > div { min-width: 0; display: grid; }
.workspace-switcher small { color: var(--faint); font-size: 8px; line-height: 1.1; text-transform: uppercase; letter-spacing: .07em; }
.workspace-switcher strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; }
.workspace-caret { color: var(--faint); font-size: 13px; }
.workspace-menu { position: relative; }
.workspace-menu > summary { list-style: none; cursor: pointer; }
.workspace-menu > summary::-webkit-details-marker { display: none; }
.workspace-menu > summary:focus-visible { outline: 3px solid var(--accent-soft); outline-offset: 2px; }
.workspace-menu-items { position: absolute; right: 0; top: calc(100% + 7px); width: 245px; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--shadow-small); }
.workspace-menu-items a, .workspace-menu-items button { display: block; width: 100%; border: 0; background: transparent; text-align: left; text-decoration: none; border-radius: 6px; padding: 10px; cursor: pointer; font-size: 12px; }
.workspace-menu-items a:hover, .workspace-menu-items button:hover { background: var(--surface-subtle); }
.side-tools { display: grid; gap: 3px; margin-top: 20px; border-top: 1px solid var(--line); padding-top: 14px; }
.account-summary { display: flex; gap: 9px; align-items: center; margin-top: auto; padding: 14px 6px 0; text-decoration: none; }
.account-summary > span:last-child { min-width: 0; display: grid; }
.account-summary strong { font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.account-summary small { font-size: 10px; color: var(--muted); text-transform: capitalize; }
.session-expired .app-shell { visibility: hidden; }

.side-nav { display: grid; gap: 3px; }
.nav-item {
  width: 100%;
  min-height: 39px;
  display: grid;
  grid-template-columns: 21px 1fr auto;
  gap: 8px;
  align-items: center;
  padding: 7px 9px;
  border: 1px solid transparent;
  border-radius: var(--radius-control);
  color: var(--muted);
  background: transparent;
  cursor: pointer;
  text-align: left;
  text-decoration: none;
  transition: color .14s ease, background .14s ease, border-color .14s ease, transform .14s ease;
}
.nav-item:hover { color: var(--ink); background: rgba(255,255,255,.58); }
.nav-item:active { transform: translateY(1px); }
.nav-item.active { color: var(--ink); border-color: var(--line); background: var(--surface); box-shadow: 0 1px 2px rgba(43,57,70,.04); }
.nav-item > .ph { color: var(--faint); font-size: 17px; }
.nav-item.active > .ph { color: var(--accent-strong); }
.nav-item b { font-size: 12px; font-weight: 650; }
.nav-item em { min-width: 20px; padding: 2px 5px; border-radius: 7px; color: var(--faint); background: var(--surface-subtle); font: 600 9px/1.35 var(--mono); text-align: center; font-style: normal; }
.nav-item.active em { color: var(--accent-strong); background: var(--accent-soft); }
.nav-more { position: relative; }
.nav-more > summary { list-style: none; }
.nav-more > summary::-webkit-details-marker { display: none; }
.nav-more > summary:focus-visible { outline: 3px solid rgba(82,116,147,.25); outline-offset: 2px; }
.nav-more.current > summary { color: var(--ink); border-color: var(--line); background: var(--surface); }
.more-menu { display: grid; gap: 3px; margin: 3px 0 0 14px; padding-left: 8px; border-left: 1px solid var(--line-strong); }
.work-tabs { display: flex; gap: 5px; width: fit-content; max-width: 100%; margin: 0 0 19px; padding: 4px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface); }
.work-tabs button { min-width: 0; padding: 7px 12px; border: 0; border-radius: 7px; color: var(--muted); background: transparent; cursor: pointer; font-size: 11px; font-weight: 650; }
.work-tabs button.active { color: var(--accent-strong); background: var(--accent-soft); }
.work-tabs button:focus-visible { outline: 3px solid rgba(82,116,147,.25); }
.coverage-details { margin-top: 27px; }
.coverage-details > summary { width: fit-content; padding: 7px 0; color: var(--muted); cursor: pointer; font-size: 11px; font-weight: 650; }
.coverage-details .coverage-grid { margin-top: 12px; }
.company-health:empty { display: none; }
.company-health { display: block; margin-bottom: 20px; }
.company-health-note { padding: 10px 13px; border: 1px solid var(--line); border-radius: var(--radius-control); color: var(--muted); background: var(--surface); font-size: 11px; }
.company-health-note.warning { color: var(--warning); background: var(--warning-soft); border-color: #e8d9c5; }

.workspace { min-width: 0; }
.topbar {
  height: 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 18px;
  padding: 0 32px;
  position: sticky;
  top: 0;
  z-index: 15;
  border-bottom: 1px solid var(--line);
  background: rgba(255,255,255,.92);
  backdrop-filter: blur(16px);
}
.crumb { min-width: 0; display: flex; align-items: center; gap: 8px; font-size: 11px; }
.crumb span { max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.crumb b { color: var(--line-strong); font-weight: 400; }
.crumb strong { font-weight: 650; text-transform: capitalize; }
.top-actions { display: flex; align-items: center; gap: 7px; }

main { max-width: 1760px; margin: 0 auto; padding: 27px 32px 64px; }
.view { display: none; }
.view.active { display: block; animation: view-in .18s ease both; }
.settings-stack { max-width: 1100px; }
.settings-section { display: grid; grid-template-columns: minmax(180px,.7fr) minmax(0,1.5fr); gap: 40px; padding: 27px 0; border-top: 1px solid var(--line); }
.settings-section h2 { margin: 0 0 7px; font-size: 15px; }
.settings-section header p { margin: 0; color: var(--muted); font-size: 12px; max-width: 260px; }
.settings-form { max-width: 560px; min-width: 0; }
.settings-form .field { margin-bottom: 14px; }
.settings-form .field input { min-height: 40px; }
.settings-form small { line-height: 1.6; }
.settings-status { min-height: 17px; color: var(--positive); font-size: 12px; margin: 12px 0 0; }
.settings-status.is-error { color: var(--danger); }
.full-section { display: block; }
.full-section header { margin-bottom: 18px; }
.full-section header p { max-width: 650px; }
.settings-member { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 15px 0; border-top: 1px solid var(--line); }
.settings-member > div:first-child { min-width: 0; display: grid; gap: 3px; }
.settings-member strong { font-size: 12px; overflow-wrap: anywhere; }
.settings-member small { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; }
.member-controls { display: flex; flex-wrap: wrap; gap: 7px; }
.member-controls select { max-width: 150px; padding: 6px; border: 1px solid var(--line); border-radius: 7px; background: var(--surface); font-size: 11px; }
.onboarding-head { max-width: 660px; margin: 15px 0 30px; }
.onboarding-head h1 { font-size: 32px; letter-spacing: -.03em; margin: 10px 0; }
.onboarding-head p { font-size: 13px; color: var(--muted); }
.onboarding-steps { max-width: 950px; border-top: 1px solid var(--line); }
.onboarding-step { display: grid; grid-template-columns: 38px minmax(0,1fr) auto; align-items: center; gap: 18px; padding: 24px 0; border-bottom: 1px solid var(--line); }
.onboarding-number { display: grid; place-items: center; width: 35px; height: 35px; border-radius: 50%; border: 1px solid var(--line-strong); color: var(--muted); font: 500 12px var(--mono); }
.onboarding-number.complete { background: var(--positive-soft); color: var(--positive); border-color: transparent; }
.onboarding-step h2 { font-size: 14px; margin: 0 0 5px; }
.onboarding-step p { font-size: 12px; color: var(--muted); margin: 0 0 5px; }
.onboarding-step small { font-size: 10px; color: var(--faint); }
.onboarding-step a { text-decoration: none; }
.onboarding-actions { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 25px; }
@keyframes view-in { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: none; } }

.button {
  min-height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  padding: 7px 11px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-control);
  color: var(--ink);
  background: var(--surface);
  box-shadow: 0 1px 2px rgba(43,57,70,.04);
  cursor: pointer;
  font-size: 11px;
  font-weight: 650;
  transition: transform .14s ease, border-color .14s ease, background .14s ease, box-shadow .14s ease;
}
.button .ph { font-size: 14px; }
.button:hover { border-color: #aeb6bf; background: var(--surface-muted); }
.button:active { transform: translateY(1px); }
.button.primary { border-color: var(--accent-strong); color: #f8fbfd; background: var(--accent-strong); box-shadow: 0 3px 9px rgba(61,95,126,.15); }
.button.primary:hover { border-color: #304f6c; background: #304f6c; }
.button.quiet { border-color: var(--line); background: transparent; box-shadow: none; }
.button.danger { border-color: #e8cfd3; color: var(--danger); background: var(--danger-soft); box-shadow: none; }
.button.small { min-height: 29px; padding: 5px 8px; font-size: 9px; }
.button:disabled { opacity: .55; cursor: wait; }
.button:focus-visible, .nav-item:focus-visible, .tree-row:focus-visible, input:focus-visible, select:focus-visible, textarea:focus-visible, .icon-button:focus-visible, .icon-action:focus-visible, .copy-code:focus-visible {
  outline: 3px solid rgba(82,116,147,.25);
  outline-offset: 2px;
}

.work-intro, .page-head, .agents-hero {
  min-height: 58px;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 24px;
  margin-bottom: 20px;
}
.work-intro h1, .page-head h1, .agents-hero h1 { margin: 0 0 3px; font: 700 28px/1.15 var(--display); letter-spacing: -.035em; }
.work-intro p, .page-head p, .agents-hero p { max-width: 640px; margin: 0; color: var(--muted); font-size: 12px; }
.big-count { flex: none; padding-bottom: 3px; color: var(--muted); font: 600 10px/1 var(--mono); }

.pulse-strip {
  display: grid;
  grid-template-columns: repeat(3, minmax(150px, .8fr)) minmax(270px, 1.35fr);
  overflow: hidden;
  border: 1px solid var(--line);
  border-radius: var(--radius-card);
  background: var(--surface);
}
.pulse-strip > div { min-height: 78px; display: grid; grid-template-columns: auto 1fr; grid-template-rows: 1fr 1fr; column-gap: 12px; align-items: end; padding: 14px 17px; border-right: 1px solid var(--line); }
.pulse-strip > div strong { grid-row: 1 / 3; align-self: center; min-width: 34px; font: 700 27px/1 var(--display); letter-spacing: -.04em; }
.pulse-strip > div span { align-self: end; color: var(--ink); font-size: 11px; font-weight: 650; }
.pulse-strip > div small { align-self: start; color: var(--faint); font-size: 9px; }
.pulse-strip > p { min-height: 78px; display: flex; align-items: center; gap: 12px; margin: 0; padding: 14px 17px; color: var(--muted); }
.pulse-strip > p > .ph { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 10px; color: var(--accent-strong); background: var(--accent-soft); font-size: 18px; }
.pulse-strip > p span { display: grid; gap: 3px; }
.pulse-strip > p b { font-size: 10px; }
.pulse-strip > p small { color: var(--muted); font-size: 9px; }

.section-head { min-height: 35px; display: flex; align-items: flex-end; justify-content: space-between; gap: 20px; margin: 25px 2px 10px; }
.section-head h2 { margin: 0; font: 700 14px/1.25 var(--display); letter-spacing: -.015em; }
.section-head p { margin: 3px 0 0; color: var(--muted); font-size: 10px; }
.mono, .count { color: var(--faint); font: 500 9px/1.3 var(--mono); }
.count { display: inline-flex; align-items: center; gap: 5px; }

.board { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; padding: 1px 1px 13px; }
.board-guide { min-height: 25px; display: flex; align-items: center; justify-content: flex-end; margin: -9px 2px 8px; color: var(--faint); font: 500 8px/1.3 var(--mono); }
.board-guide > span { display: inline-flex; align-items: center; gap: 6px; }.board-guide .ph { font-size: 12px; }
.work-suggestion-bar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 0 0 16px; padding: 14px 16px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface-subtle); }
.work-suggestion-bar span { display: grid; gap: 3px; min-width: 0; }
.work-suggestion-bar small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.evidence-readable { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 360px; overflow: auto; }
.lane { min-width: 0; min-height: 420px; padding: 10px; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--surface-muted); transition: border-color 120ms cubic-bezier(.2,0,0,1), background 120ms cubic-bezier(.2,0,0,1), box-shadow 120ms cubic-bezier(.2,0,0,1); }
.lane.drag-over { border-color: var(--accent); background: var(--accent-soft); box-shadow: inset 0 0 0 1px var(--accent); }
.lane.drop-saving { cursor: progress; }
.lane-head { min-height: 35px; display: flex; align-items: center; justify-content: space-between; padding: 1px 4px 10px; }
.lane-head > div { display: flex; align-items: center; gap: 7px; }
.lane-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
.lane[data-lane="active"] .lane-dot { background: var(--accent); }
.lane[data-lane="checkpoint"] .lane-dot { background: var(--warning); }
.lane[data-lane="closed"] .lane-dot { background: var(--positive); }
.lane-head h3 { margin: 0; font-size: 10px; font-weight: 700; letter-spacing: .045em; text-transform: uppercase; }
.cards { display: grid; gap: 8px; }
.task-card { min-width: 0; min-height: var(--task-card-min); display: grid; grid-template-rows: auto 1fr auto auto; padding: 14px; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); box-shadow: 0 1px 2px rgba(43,57,70,.03); transition: transform .14s ease, box-shadow .14s ease, border-color .14s ease; }
.task-card:hover { transform: translateY(-1px); border-color: var(--line-strong); box-shadow: var(--shadow-small); }
.task-card[draggable="true"] { cursor: grab; }.task-card[draggable="true"]:active { cursor: grabbing; }
.task-card.dragging { opacity: .48; transform: scale(.985) rotate(.2deg); border-color: var(--accent); box-shadow: var(--shadow-small); }
.task-card.drag-saving { opacity: .62; pointer-events: none; }
.task-cap { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.task-status { color: var(--faint); font: 650 9px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }
.priority { width: 7px; height: 7px; border-radius: 50%; background: var(--line-strong); }
.priority.high { background: var(--warning); }.priority.urgent { background: var(--danger); }
.task-card h4 { min-width: 0; margin: 10px 0 13px; overflow-wrap: anywhere; font: 680 14px/1.35 var(--display); letter-spacing: -.012em; }
.pending-overlay { display: flex; align-items: flex-start; gap: 5px; margin: -5px 0 10px; padding: 7px 8px; border: 1px solid #ead9bd; border-radius: 8px; color: #765b31; background: var(--warning-soft); font-size: 8px; line-height: 1.35; }
.pending-overlay .ph { flex: none; margin-top: 1px; font-size: 11px; }
.task-meta { display: flex; flex-wrap: wrap; gap: 5px 10px; color: var(--muted); font-size: 10px; }
.task-meta span { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.task-footer { min-height: 31px; display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; margin-top: auto; padding-top: 10px; border-top: 1px solid var(--line); }
.task-footer > div { display: flex; align-items: center; gap: 6px; }
.source-link { display: inline-flex; align-items: center; gap: 5px; color: var(--accent-strong); font-size: 9px; font-weight: 650; text-decoration: none; }
.source-link:hover { text-decoration: underline; }
.icon-action { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface); cursor: pointer; }
.icon-action:hover { color: var(--accent-strong); border-color: var(--line-strong); background: var(--accent-soft); }

.empty { padding: 30px 20px; border: 1px dashed var(--line-strong); border-radius: var(--radius-card); color: var(--muted); text-align: center; background: rgba(255,255,255,.45); }
.empty strong { display: block; margin-bottom: 4px; color: var(--ink); font-size: 12px; }
.empty span { font-size: 10px; }
.lane .empty { padding: 24px 12px; }
.skeleton { min-height: var(--task-card-min); border: 1px solid var(--line); border-radius: var(--radius-card); background: linear-gradient(100deg, var(--surface-subtle) 20%, var(--surface) 40%, var(--surface-subtle) 60%); background-size: 200% 100%; animation: shimmer 1.3s ease-in-out infinite; }
@keyframes shimmer { to { background-position-x: -200%; } }

.review-layout { display: grid; grid-template-columns: minmax(0, 1.65fr) 300px; gap: 18px; }
.proposal-list { display: grid; align-content: start; gap: 10px; }
.proposal-card { padding: 18px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.proposal-cap { display: flex; align-items: flex-start; justify-content: space-between; gap: 15px; }
.proposal-kind, .harness-label, .modal-label { color: var(--accent-strong); font: 700 8px/1 var(--mono); text-transform: uppercase; letter-spacing: .08em; }
.proposal-card h2 { margin: 6px 0 4px; font: 700 16px/1.25 var(--display); letter-spacing: -.02em; }
.proposal-card p { margin: 0; color: var(--muted); font-size: 10px; }
.change-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(145px, 1fr)); gap: 6px; margin: 15px 0; }
.change { margin: 0; padding: 9px 10px; border-radius: 8px; background: var(--surface-muted); }
.change dt { color: var(--faint); font: 600 8px/1.2 var(--mono); text-transform: uppercase; }
.change dd { display: flex; flex-wrap: wrap; align-items: center; gap: 5px; margin: 5px 0 0; overflow-wrap: anywhere; font-size: 10px; font-weight: 650; }
.change dd del { color: var(--faint); font-weight: 500; }.change dd ins { color: var(--ink); text-decoration: none; }.change dd .ph { color: var(--faint); font-size: 10px; }
.authority-explanation { display: grid; grid-template-columns: 28px 1fr; gap: 9px; align-items: center; margin: 13px 0; padding: 10px 11px; border: 1px solid #d9e2ea; border-radius: 9px; background: var(--accent-soft); }
.authority-explanation > .ph { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: rgba(255,255,255,.68); font-size: 14px; }.authority-explanation strong { font-size: 9px; }.authority-explanation p { margin: 2px 0 0; color: var(--muted); font-size: 8px; }
.proposal-actions { display: flex; justify-content: flex-end; gap: 7px; padding-top: 13px; border-top: 1px solid var(--line); }
.decision-card { align-self: start; position: sticky; top: 82px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface-muted); }
.decision-card > h2 { margin: 0 0 14px; font: 700 13px/1.2 var(--display); }
.decision-rule { display: grid; grid-template-columns: 30px 1fr; gap: 10px; padding: 11px 0; border-top: 1px solid var(--line); }
.decision-rule > .ph { width: 30px; height: 30px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: var(--accent-soft); font-size: 15px; }
.decision-rule strong { font-size: 10px; }
.decision-rule p { margin: 2px 0 0; color: var(--muted); font-size: 9px; line-height: 1.45; }

.context-hero { min-height: 155px; position: relative; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: #8aa9bd; }
.context-hero img { width: 100%; height: 100%; position: absolute; inset: 0; object-fit: cover; object-position: center 47%; filter: saturate(.72) contrast(.96) brightness(.92); }
.context-hero:after { content: ""; position: absolute; inset: 0; background: linear-gradient(90deg, rgba(30,43,54,.64), rgba(30,43,54,.13) 62%, rgba(30,43,54,.18)); pointer-events: none; }
.context-hero-copy { max-width: 560px; position: absolute; left: 25px; bottom: 22px; z-index: 2; color: #f7f9fa; text-shadow: 0 1px 5px rgba(20,30,38,.3); }
.context-hero-copy h1 { margin: 0 0 3px; font: 700 29px/1.08 var(--display); letter-spacing: -.035em; }
.context-hero-copy p { margin: 0; color: rgba(247,249,250,.83); font-size: 11px; }
.hero-index { display: flex; position: absolute; right: 15px; top: 15px; z-index: 3; overflow: hidden; border: 1px solid rgba(255,255,255,.3); border-radius: 9px; color: #f7f9fa; background: rgba(34,48,61,.52); backdrop-filter: blur(10px); }
.hero-index span { padding: 8px 10px; border-right: 1px solid rgba(255,255,255,.2); font: 500 8px/1 var(--mono); }
.hero-index span:last-child { border: 0; }.hero-index b { margin-right: 2px; font-size: 10px; }
.context-tabs { width: fit-content; display: grid; grid-template-columns: 1fr 1fr; gap: 4px; margin: 14px 0 0; padding: 4px; border: 1px solid var(--line); border-radius: 11px; background: var(--surface-muted); }
.context-tab { min-width: 210px; display: grid; grid-template-columns: 29px 1fr; gap: 8px; align-items: center; padding: 8px 10px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); background: transparent; text-align: left; cursor: pointer; }
.context-tab > .ph { width: 29px; height: 29px; display: grid; place-items: center; border-radius: 8px; color: var(--faint); background: rgba(255,255,255,.58); font-size: 15px; }
.context-tab span { display: grid; gap: 2px; }.context-tab b { color: inherit; font-size: 9px; }.context-tab small { color: var(--faint); font-size: 8px; }
.context-tab.active { border-color: var(--line); color: var(--ink); background: var(--surface); box-shadow: 0 1px 3px rgba(43,57,70,.05); }.context-tab.active > .ph { color: var(--accent-strong); background: var(--accent-soft); }
.context-tab:focus-visible, .source-tree-row:focus-visible, .source-section:focus-visible, .cited-source:focus-visible, .retrieval-result:focus-visible { outline: 3px solid rgba(82,116,147,.25); outline-offset: 2px; }
.context-heading { align-items: center; }
.context-actions { display: flex; align-items: center; gap: 7px; }
.context-filter { max-width: 145px; height: 34px; padding: 0 9px; border: 1px solid var(--line); border-radius: var(--radius-control); color: var(--ink); background: var(--surface); font-size: 9px; }
.search-field { width: min(260px, 100%); height: 34px; display: flex; align-items: center; gap: 7px; padding: 0 10px; border: 1px solid var(--line); border-radius: var(--radius-control); background: var(--surface); }
.search-field .ph { color: var(--faint); font-size: 14px; }
.search-field input { width: 100%; border: 0; outline: 0; background: transparent; font-size: 10px; }
.search-field button { padding: 3px 5px; border: 0; border-radius: 6px; color: var(--accent-strong); background: var(--accent-soft); cursor: pointer; font-size: 8px; font-weight: 700; }
.context-browser { height: clamp(535px, 72dvh, 820px); min-height: 0; display: grid; grid-template-columns: 278px minmax(0, 1fr); overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--surface); }
.tree-panel { min-height: 0; display: grid; grid-template-rows: auto minmax(0, 1fr); overflow: hidden; padding: 12px 8px 12px 12px; border-right: 1px solid var(--line); background: var(--surface-muted); }
.panel-kicker { display: flex; justify-content: space-between; align-items: center; padding: 4px 6px 11px; color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }
.panel-kicker b { font-weight: 500; text-transform: none; letter-spacing: 0; }
.context-tree { min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding-right: 4px; scrollbar-gutter: stable; }
.context-tree, .tree-children { display: grid; align-content: start; gap: 2px; }
.context-tree, .preview-panel { scrollbar-width: thin; scrollbar-color: var(--line-strong) transparent; }
.context-tree::-webkit-scrollbar, .preview-panel::-webkit-scrollbar { width: 10px; }
.context-tree::-webkit-scrollbar-thumb, .preview-panel::-webkit-scrollbar-thumb { border: 3px solid transparent; border-radius: 999px; background: var(--line-strong); background-clip: padding-box; }
.context-tree::-webkit-scrollbar-track, .preview-panel::-webkit-scrollbar-track { background: transparent; }
.context-tree:focus-visible, .preview-panel:focus-visible { outline: 3px solid rgba(82,116,147,.25); outline-offset: -3px; }
.tree-node > .tree-children { padding-left: 13px; }
.tree-node.collapsed > .tree-children { display: none; }
.tree-node.collapsed > .tree-row .tree-glyph { transform: rotate(-90deg); }
.tree-row { width: 100%; min-height: 32px; display: grid; grid-template-columns: 17px minmax(0,1fr) auto; align-items: center; gap: 6px; padding: 5px 7px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); background: transparent; text-align: left; cursor: pointer; }
.tree-row:hover { color: var(--ink); background: var(--surface); }
.tree-row.active { color: var(--ink); border-color: var(--line); background: var(--surface); box-shadow: 0 1px 2px rgba(43,57,70,.04); }
.tree-glyph { color: var(--faint); font-size: 13px; transition: transform .14s ease; }
.tree-row[data-kind="fact"] .tree-glyph { color: var(--accent); font-size: 10px; }
.tree-row[data-kind="file"] .tree-glyph { color: var(--accent-strong); }
.tree-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; font-weight: 600; }
.tree-row small { color: var(--faint); font: 500 8px/1 var(--mono); text-transform: uppercase; }
.source-group { display: grid; gap: 3px; margin-bottom: 12px; }.source-group:last-child { margin-bottom: 0; }
.source-group-title { display: grid; grid-template-columns: 16px 1fr auto; gap: 6px; align-items: center; padding: 5px 7px; color: var(--faint); }.source-group-title .ph { font-size: 12px; }.source-group-title strong { font: 700 8px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }.source-group-title small { font: 500 8px/1 var(--mono); }
.source-tree-row { width: 100%; min-width: 0; display: grid; grid-template-columns: 18px minmax(0,1fr); gap: 7px; align-items: start; padding: 8px; border: 1px solid transparent; border-radius: 8px; color: var(--muted); background: transparent; text-align: left; cursor: pointer; }.source-tree-row > .ph { margin-top: 1px; color: var(--accent-strong); font-size: 13px; }.source-tree-row > span { min-width: 0; display: grid; gap: 3px; }.source-tree-row strong, .source-tree-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.source-tree-row strong { color: inherit; font-size: 9px; }.source-tree-row small { color: var(--faint); font: 500 7px/1.3 var(--mono); }.source-tree-row:hover, .source-tree-row.active { border-color: var(--line); color: var(--ink); background: var(--surface); }
.preview-panel { min-width: 0; min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: clamp(24px, 3.5vw, 48px); background: var(--surface); scrollbar-gutter: stable; }
.preview-empty { min-height: 100%; display: grid; place-content: center; justify-items: center; text-align: center; }
.empty-glyph { width: 42px; height: 42px; display: grid; place-items: center; margin-bottom: 13px; border-radius: 12px; color: var(--accent-strong); background: var(--accent-soft); font-size: 19px; }
.loading-icon .ph { animation: spin .8s linear infinite; }
.preview-empty h2 { margin: 0 0 4px; font: 700 15px/1.2 var(--display); }
.preview-empty p { max-width: 330px; margin: 0; color: var(--muted); font-size: 10px; }
.preview-cap { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; padding-bottom: 16px; border-bottom: 1px solid var(--line); }
.preview-cap h2 { margin: 5px 0 4px; font: 700 clamp(21px, 2.5vw, 30px)/1.08 var(--display); letter-spacing: -.03em; }
.context-path { color: var(--accent-strong); font: 550 9px/1.3 var(--mono); overflow-wrap: anywhere; }
.kind-pill { flex: none; padding: 5px 8px; border: 1px solid var(--line); border-radius: 8px; color: var(--muted); background: var(--surface-muted); font: 650 8px/1 var(--mono); text-transform: uppercase; }
.fact-value { margin: 27px 0; padding: 19px 21px; border-left: 3px solid var(--accent); border-radius: 0 10px 10px 0; background: var(--accent-soft); font: 650 clamp(17px, 2vw, 24px)/1.28 var(--display); letter-spacing: -.02em; overflow-wrap: anywhere; }
.markdown-body { max-width: 820px; padding-top: 21px; color: #35404b; }
.markdown-body h2, .markdown-body h3, .markdown-body h4 { margin: 1.25em 0 .4em; font-family: var(--display); letter-spacing: -.02em; }
.markdown-body h2 { font-size: 23px; }.markdown-body h3 { font-size: 18px; }.markdown-body h4 { font-size: 15px; }
.markdown-body p, .markdown-body li, .markdown-body blockquote { font-size: 12px; line-height: 1.68; }
.markdown-body blockquote { margin: 15px 0; padding: 3px 0 3px 15px; border-left: 3px solid var(--accent); color: var(--muted); }
.markdown-body code { font-family: var(--mono); font-size: .9em; }
.markdown-body pre { overflow: auto; padding: 13px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-muted); }
.lineage { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 11px; margin-top: 30px; padding-top: 15px; border-top: 1px solid var(--line); }
.lineage div { min-width: 0; display: grid; gap: 4px; }
.lineage small { color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }
.lineage span, .lineage a { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }.lineage a { color: var(--accent-strong); }
.source-preview-cap p { margin: 0; color: var(--muted); font-size: 9px; }.preview-actions { display: flex; align-items: center; justify-content: flex-end; gap: 7px; flex-wrap: wrap; }.kind-pill.source-kind { border-color: #ead9bd; color: #765b31; background: var(--warning-soft); }
.source-trust { display: grid; grid-template-columns: 34px 1fr; gap: 11px; align-items: start; margin: 18px 0; padding: 13px 14px; border: 1px solid #ead9bd; border-radius: 10px; color: #634c30; background: var(--warning-soft); }.source-trust > .ph { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; background: rgba(255,255,255,.7); font-size: 17px; }.source-trust strong { font-size: 10px; }.source-trust ul { margin: 4px 0 0; padding-left: 15px; }.source-trust li { margin: 3px 0; font-size: 9px; line-height: 1.45; }
.source-metadata { display: grid; grid-template-columns: repeat(4, minmax(0,1fr)); gap: 7px; margin: 16px 0 23px; }.source-metadata div { min-width: 0; display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: var(--surface-muted); }.source-metadata small { color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; }.source-metadata span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.source-read-actions { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin: 21px 0 10px; }.source-read-actions h3 { margin: 0 0 3px; font: 700 14px/1.2 var(--display); }.source-read-actions p { margin: 0; color: var(--muted); font-size: 9px; }
.source-outline { display: grid; gap: 5px; }.source-section { min-width: 0; display: grid; grid-template-columns: minmax(0,1fr) minmax(180px,.8fr) 17px; gap: 13px; align-items: center; padding: 11px 12px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface); text-align: left; cursor: pointer; }.source-section:hover { border-color: var(--accent); background: var(--accent-soft); }.source-section.matched { border-left: 3px solid var(--accent); }.source-section > span { min-width: 0; display: grid; gap: 3px; }.source-section b { overflow-wrap: anywhere; font-size: 9px; }.source-section small { color: var(--faint); font: 500 7px/1.3 var(--mono); }.source-section p { min-width: 0; margin: 0; color: var(--muted); overflow-wrap: anywhere; font-size: 8px; line-height: 1.45; }.source-section > .ph { color: var(--faint); font-size: 12px; }
.source-markdown { max-width: none; padding-top: 8px; }.cited-sources, .source-result-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px,1fr)); gap: 7px; }.cited-source { min-width: 0; display: grid; grid-template-columns: 28px minmax(0,1fr) 14px; gap: 9px; align-items: center; padding: 10px; border: 1px solid var(--line); border-radius: 9px; color: var(--ink); background: var(--surface-muted); text-align: left; cursor: pointer; }.cited-source:hover { border-color: var(--accent); background: var(--accent-soft); }.cited-source > .ph:first-child { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: var(--accent-soft); }.cited-source span { min-width: 0; display: grid; gap: 3px; }.cited-source b, .cited-source small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }.cited-source b { font-size: 9px; }.cited-source small { color: var(--faint); font: 500 7px/1.3 var(--mono); }

.provider-badge { display: inline-block; padding: 4px 6px; border-radius: 6px; color: var(--accent-strong); background: var(--accent-soft); font: 700 8px/1 var(--mono); text-transform: uppercase; }
.reference-cell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-family: var(--mono); }
.receipt-hash { color: var(--accent-strong); font: 550 8px/1 var(--mono); }
.evidence-detail { min-width: 0; min-height: 330px; position: sticky; top: 76px; overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--surface); }
.evidence-detail-empty { min-height: 328px; display: grid; place-content: center; justify-items: center; padding: 25px; text-align: center; }
.evidence-detail-empty[hidden] { display: none; }
.evidence-detail-empty h2 { margin: 0 0 4px; font: 700 15px/1.2 var(--display); }.evidence-detail-empty p { margin: 0; color: var(--muted); font-size: 9px; }
.evidence-detail-content { min-width: 0; padding: 19px; }.evidence-detail-content h2 { margin: 5px 0 4px; overflow-wrap: anywhere; font: 700 18px/1.2 var(--display); }.evidence-detail-content > p { margin: 0 0 15px; color: var(--muted); font-size: 9px; overflow-wrap: anywhere; }
.evidence-detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; margin: 14px 0; }.evidence-detail-grid div { min-width: 0; display: grid; gap: 3px; padding: 9px; border-radius: 8px; background: var(--surface-muted); }.evidence-detail-grid small { color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; }.evidence-detail-grid span { overflow-wrap: anywhere; font-size: 9px; }
.evidence-payload { max-height: 430px; overflow: auto; margin: 10px 0 0; padding: 13px; border: 1px solid var(--line); border-radius: 9px; background: #253746; color: #edf2f5; }.evidence-payload code { font: 500 9px/1.55 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }
.evidence-receipt-modal .evidence-detail { min-height: 0; position: static; border: 0; border-radius: 0; }

.agent-boundary { display: grid; grid-template-columns: 34px 1fr; gap: 10px; align-items: center; margin-bottom: 24px; padding: 12px 14px; border: 1px solid #d9e2ea; border-radius: var(--radius-card); background: var(--accent-soft); }
.agent-boundary > .ph { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; color: var(--accent-strong); background: rgba(255,255,255,.65); font-size: 17px; }
.agent-boundary > div { display: grid; gap: 2px; }.agent-boundary strong { font-size: 10px; }.agent-boundary span { color: var(--muted); font-size: 9px; }
.agent-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 12px; }
.agent-card { min-height: 265px; display: grid; grid-template-rows: auto 1fr auto auto; gap: 14px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.agent-card.revoked { opacity: .7; background: var(--surface-muted); }
.agent-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 14px; }
.agent-identity { min-width: 0; display: grid; grid-template-columns: 38px minmax(0,1fr); gap: 10px; align-items: center; }
.harness-icon { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: var(--accent-strong); background: var(--accent-soft); font-size: 19px; }
.agent-card-head h2 { margin: 5px 0 0; overflow: hidden; text-overflow: ellipsis; font: 700 17px/1.15 var(--display); letter-spacing: -.02em; }
.agent-status { padding: 5px 7px; border: 1px solid #d2e3dc; border-radius: 7px; color: var(--positive); background: var(--positive-soft); font: 700 8px/1 var(--mono); text-transform: uppercase; }
.agent-card.revoked .agent-status { border-color: #ead4d7; color: var(--danger); background: var(--danger-soft); }
.agent-card > p { margin: 0; color: var(--muted); font-size: 10px; }
.agent-owner { display: grid; grid-template-columns: 1fr auto; gap: 3px 12px; padding: 10px 11px; border-radius: 9px; background: var(--surface-muted); }
.agent-owner small { grid-column: 1 / -1; color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; }.agent-owner strong { font-size: 10px; }.agent-owner span { color: var(--faint); font: 500 8px/1.5 var(--mono); }
.agent-grants { display: flex; flex-wrap: wrap; gap: 5px; }
.agent-grants span { padding: 4px 7px; border-radius: 7px; color: var(--muted); background: var(--surface-subtle); font-size: 8px; font-weight: 650; }
.agent-card-foot { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; padding-top: 12px; border-top: 1px solid var(--line); }
.agent-card-foot > span { color: var(--faint); font: 500 8px/1.35 var(--mono); }.agent-card-foot > div { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 5px; }
.agent-empty { grid-column: 1 / -1; }

.integration-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 12px; }
.integration-card { min-height: 190px; display: grid; align-content: start; gap: 13px; padding: 18px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.integration-card-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
.integration-title { display: grid; grid-template-columns: 35px minmax(0,1fr); align-items: center; gap: 10px; }
.integration-title > .ph { width: 35px; height: 35px; display: grid; place-items: center; border-radius: 9px; color: var(--accent-strong); background: var(--accent-soft); font-size: 17px; }
.integration-title h2 { margin: 0; font: 700 15px/1.25 var(--display); }.integration-title span { color: var(--faint); font: 500 8px/1.4 var(--mono); }
.health-state { padding: 5px 7px; border-radius: 7px; color: var(--positive); background: var(--positive-soft); font: 700 8px/1 var(--mono); text-transform: uppercase; }
.health-state.degraded, .health-state.revoked { color: var(--danger); background: var(--danger-soft); }
.integration-details { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.integration-details div { display: grid; gap: 3px; padding: 10px; border-radius: 8px; background: var(--surface-muted); }.integration-details small { color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; }.integration-details span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }
.integration-card p { margin: 0; color: var(--muted); font-size: 9px; }
.eyebrow { display: inline-flex; align-items: center; gap: 9px; color: #30394d; font: 650 9px/1.2 var(--mono); letter-spacing: .07em; text-transform: uppercase; }
.eyebrow > .ph { color: #df4a32; font-size: 9px; }
.projects-hero { min-height: 78px; display: flex; align-items: flex-end; justify-content: space-between; gap: 30px; padding: 6px 12px 20px; }
.projects-hero h1 { margin: 0 0 4px; font: 700 28px/1.15 var(--display); letter-spacing: -.035em; }
.projects-hero p { max-width: 640px; margin: 0; color: var(--muted); font-size: 12px; }
.projects-summary { min-height: 53px; display: flex; align-items: center; gap: 24px; padding: 0 12px 15px; border-bottom: 1px solid var(--line); color: var(--muted); font: 500 11px/1.2 var(--mono); }
.projects-summary b { margin-right: 4px; color: var(--ink); font-size: 15px; }
.projects-summary > .ph { color: var(--faint); font-size: 17px; }
.projects-summary button { padding: 0; border: 0; color: #db321f; background: transparent; cursor: pointer; font: inherit; }
.projects-summary button b { color: #db321f; }
.projects-workspace { min-width: 0; display: grid; grid-template-columns: minmax(230px, .78fr) minmax(360px, 1.55fr) minmax(260px, .95fr); min-height: 610px; }
.project-index, .project-focus, .project-rail { min-width: 0; }
.project-index { padding: 18px 12px 30px 0; border-right: 1px solid var(--line); }
.project-index > header, .project-rail section > header { min-height: 38px; display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 0 12px 10px; }
.project-index h2, .project-rail h2 { margin: 0; font: 650 18px/1.1 var(--display); }
.project-index header span, .project-rail header b { color: var(--muted); font: 500 9px/1 var(--mono); }
#projects-index { display: grid; }
.project-index-item { width: 100%; min-width: 0; display: grid; gap: 4px; position: relative; padding: 15px 14px 14px 18px; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); background: transparent; text-align: left; cursor: pointer; }
.project-index-item:before { content: ""; width: 3px; position: absolute; inset: 0 auto 0 0; background: transparent; }
.project-index-item:hover { background: rgba(255,255,255,.45); }
.project-index-item.active { background: var(--accent-soft); }
.project-index-item.active:before { background: var(--accent-strong); }
.project-index-item strong { overflow-wrap: anywhere; font: 650 11px/1.3 var(--display); }
.project-index-item span { display: -webkit-box; overflow: hidden; color: var(--muted); font-size: 9px; line-height: 1.45; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.project-index-item small { margin-top: 4px; color: var(--faint); font: 500 8px/1.2 var(--mono); }
.project-focus { padding: 32px 26px 36px; border-right: 1px solid var(--line); }
.project-focus > header h2 { margin: 10px 0 10px; overflow-wrap: anywhere; font: 700 clamp(24px, 2.5vw, 34px)/1.08 var(--display); letter-spacing: -.03em; }
.project-focus > header p { max-width: 680px; margin: 0; color: var(--muted); font-size: 11px; line-height: 1.55; }
.project-facts { display: flex; flex-wrap: wrap; align-items: center; gap: 0; margin-top: 19px; padding: 12px 0; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.project-facts > span { padding: 0 16px; border-right: 1px solid var(--line-strong); color: var(--muted); font-size: 9px; }
.project-facts > span:first-child { padding-left: 0; }.project-facts .button { margin-left: auto; }
.project-current { margin-top: 23px; }.project-current h3 { margin: 0 0 10px; font: 650 16px/1.2 var(--display); }
.project-tasks { display: grid; border-top: 1px solid var(--line); }
.project-task { min-width: 0; display: grid; grid-template-columns: minmax(0, 1fr) minmax(66px, auto) minmax(70px, auto); align-items: center; gap: 12px; padding: 12px 3px; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); background: transparent; text-align: left; cursor: pointer; }
.project-task:hover { background: rgba(255,255,255,.52); }.project-task span { min-width: 0; display: grid; gap: 3px; overflow-wrap: anywhere; white-space: normal; font-size: 9px; }.project-task span strong { font: 600 10px/1.35 var(--display); }.project-task span small { color: var(--muted); font-size: 8px; }.project-task > em { overflow: hidden; color: var(--faint); font: 500 8px/1 var(--mono); text-overflow: ellipsis; white-space: nowrap; font-style: normal; }
.task-state { justify-self: end; color: var(--accent-strong); font: 600 8px/1 var(--mono); text-transform: capitalize; }.task-state.blocked { color: #d62f1d; }.task-state.done, .task-state.cancelled { color: var(--positive); }
.project-history-link { display: flex; align-items: center; gap: 12px; margin-top: 17px; padding: 7px 0; border: 0; color: var(--accent-strong); background: transparent; cursor: pointer; font-size: 10px; }
.project-rail { padding: 18px 0 34px 20px; }.project-rail > section + section { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--line); }
#project-decisions, #project-history { display: grid; }
.project-decision { min-width: 0; display: grid; grid-template-columns: 1fr auto; gap: 4px 10px; position: relative; padding: 13px 22px 13px 12px; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); background: transparent; text-align: left; cursor: pointer; }
.project-decision strong, .project-decision span, .project-decision small { grid-column: 1; overflow-wrap: anywhere; }.project-decision strong { font: 650 10px/1.3 var(--display); }.project-decision span { color: var(--muted); font-size: 8px; line-height: 1.5; }.project-decision small { color: var(--faint); font: 500 7px/1.3 var(--mono); text-transform: uppercase; }.project-decision em { grid-column: 2; grid-row: 1; color: var(--accent-strong); font-size: 8px; font-style: normal; }
.project-history-item { min-width: 0; display: grid; grid-template-columns: 17px minmax(0,1fr); gap: 9px; padding: 10px 12px; border: 0; color: var(--ink); background: transparent; text-align: left; cursor: pointer; }.project-history-item > .ph { margin-top: 3px; color: var(--accent-strong); font-size: 9px; }.project-history-item:nth-child(2) > .ph { color: #df4a32; }.project-history-item > span { min-width: 0; display: grid; gap: 3px; }.project-history-item strong { overflow-wrap: anywhere; font-size: 9px; }.project-history-item small { color: var(--muted); font-size: 8px; line-height: 1.4; }.project-history-item em { color: var(--faint); font: 500 7px/1.2 var(--mono); font-style: normal; }
.rail-empty { margin: 4px 12px; }.project-empty { min-height: 350px; display: grid; place-content: center; text-align: center; }
.context-memory-boundary { margin: 14px 0 0; }
.session-modal { width: min(440px, calc(100vw - 32px)); }.session-modal code { color: var(--accent-strong); font: 600 9px/1.4 var(--mono); }.form-error { margin: 0; padding: 9px 10px; border-radius: 8px; color: #8f2c21; background: #fff0ed; font-size: 9px; }

.activity-list { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.activity-row { min-height: 52px; display: grid; grid-template-columns: minmax(130px, .8fr) minmax(180px, 1.5fr) auto; gap: 13px; align-items: center; padding: 10px 13px; border-bottom: 1px solid var(--line); }
.activity-row:last-child { border-bottom: 0; }.activity-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }.activity-row span { color: var(--muted); font-size: 9px; }.activity-row time { color: var(--faint); font: 500 8px/1.3 var(--mono); white-space: nowrap; }
.activity-row .button { justify-self: end; }

.detail-head { display: flex; justify-content: space-between; gap: 18px; margin: 6px 0 19px; }.detail-head h2 { margin: 0 0 5px; }.detail-head p { margin: 0; color: var(--muted); font-size: 10px; }.detail-state { height: fit-content; padding: 6px 8px; border-radius: 7px; background: var(--accent-soft); color: var(--accent-strong); font: 700 8px/1 var(--mono); text-transform: uppercase; }
.detail-grid { display: grid; grid-template-columns: repeat(3, minmax(0,1fr)); gap: 8px; margin-bottom: 19px; }.detail-grid div { min-width: 0; display: grid; gap: 4px; padding: 10px; border-radius: 8px; background: var(--surface-muted); }.detail-grid small { color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; }.detail-grid span { overflow-wrap: anywhere; font-size: 9px; }
.timeline { display: grid; gap: 0; margin: 10px 0 0; }.timeline-row { display: grid; grid-template-columns: 58px 1fr auto; gap: 10px; padding: 10px 0; border-bottom: 1px solid var(--line); }.timeline-row:last-child { border: 0; }.timeline-row b { font: 600 9px/1.4 var(--mono); }.timeline-row span { font-size: 9px; }.timeline-row time { color: var(--faint); font: 500 8px/1.4 var(--mono); }
.compact-head { margin-top: 22px; }.pending-row { background: var(--warning-soft); }
.retrieval-summary { display: grid; gap: 13px; }.retrieval-summary > header { padding-bottom: 12px; border-bottom: 1px solid var(--line); }.retrieval-summary h2 { margin: 0 0 4px; }.retrieval-summary p { margin: 0; color: var(--muted); font-size: 10px; }.retrieval-result { padding: 12px; border: 1px solid transparent; border-radius: 9px; color: var(--ink); background: var(--surface-muted); text-align: left; cursor: pointer; }.retrieval-result:hover { border-color: var(--accent); background: var(--accent-soft); }.retrieval-result h3 { margin: 0 0 4px; font-size: 12px; }.retrieval-result p { margin: 0; color: var(--muted); font-size: 9px; }.source-result .provider-badge { margin-bottom: 7px; }.retrieval-manifest { color: var(--faint); font: 500 8px/1.5 var(--mono); }
.catalog-section { border: 1px solid var(--line); border-radius: 9px; padding: 8px; }.catalog-section summary { cursor: pointer; font-size: 11px; }.catalog-section .retrieval-result { display: grid; width: 100%; margin-top: 6px; padding: 8px; }.catalog-section .retrieval-result span { color: var(--muted); font-size: 9px; }

.alert { display: none; align-items: center; justify-content: space-between; gap: 13px; margin-bottom: 17px; padding: 10px 12px; border: 1px solid #e5cbd0; border-radius: var(--radius-control); color: var(--danger); background: var(--danger-soft); font-size: 10px; }
.alert.show { display: flex; }
.alert button, .icon-button { width: 28px; height: 28px; display: grid; place-items: center; padding: 0; border: 0; border-radius: 8px; color: inherit; background: transparent; cursor: pointer; font-size: 16px; }
.alert button:hover, .icon-button:hover { background: rgba(28,35,43,.06); }

dialog { width: min(540px, calc(100vw - 28px)); max-height: calc(100dvh - 28px); padding: 0; border: 1px solid var(--line-strong); border-radius: var(--radius-panel); color: var(--ink); background: var(--surface); box-shadow: 0 28px 80px rgba(35,45,55,.22); }
dialog::backdrop { background: rgba(37,45,54,.48); backdrop-filter: blur(4px); }
.modal { padding: 23px; }
.modal-cap { display: flex; align-items: center; justify-content: space-between; }
.modal h2 { margin: 5px 0 4px; font: 700 24px/1.1 var(--display); letter-spacing: -.035em; }
.modal > p { margin: 0 0 18px; color: var(--muted); font-size: 10px; }
.field { display: grid; gap: 6px; margin: 12px 0; }.field-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field label { font-size: 9px; font-weight: 700; }
.field input, .field select, .field textarea { width: 100%; padding: 9px 10px; border: 1px solid var(--line-strong); border-radius: 8px; background: var(--surface-muted); font-size: 11px; }
.field input::placeholder, .field textarea::placeholder { color: #7a8490; }
.field textarea { min-height: 86px; resize: vertical; }.field textarea.large-textarea { min-height: 205px; font-family: var(--mono); font-size: 10px; }.field[hidden] { display: none; }
.modal-actions { display: flex; justify-content: flex-end; gap: 7px; margin-top: 18px; padding-top: 15px; border-top: 1px solid var(--line); }
.capability-field { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 17px 0 0; padding: 0; border: 0; }
.capability-field legend { width: 100%; margin-bottom: 3px; font-size: 9px; font-weight: 700; }.capability-field > p { grid-column: 1 / -1; margin: -3px 0 4px; color: var(--muted); font-size: 9px; }
.capability-field label { min-height: 59px; display: grid; grid-template-columns: 17px 1fr; gap: 7px; align-items: start; padding: 9px; border: 1px solid var(--line); border-radius: 9px; background: var(--surface-muted); cursor: pointer; }
.capability-field input { margin: 3px 0 0; accent-color: var(--accent-strong); }.capability-field span { display: grid; gap: 2px; }.capability-field b { font-size: 9px; }.capability-field small { color: var(--muted); font-size: 8px; line-height: 1.4; }

.setup-dialog { width: min(820px, calc(100vw - 28px)); }.setup-modal { max-height: calc(100dvh - 30px); overflow: auto; }.setup-head h2 { margin-top: 7px; }.setup-head p { margin: 0 0 18px; color: var(--muted); font-size: 10px; }
.setup-harness-bar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 20px; padding-bottom: 14px; border-bottom: 1px solid var(--line); }
.setup-harness-bar [aria-pressed="true"] { background: var(--accent-soft); color: var(--accent-strong); border-color: var(--accent-strong); }
.agent-connect-menu { margin-left: auto; }
.agent-connect-menu .workspace-menu-items { min-width: 200px; }
.agent-connect-menu select { width: 100%; margin: 6px 0; }
.secret-panel { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 9px 13px; align-items: center; margin: 17px 0 23px; padding: 14px; border: 1px solid #dccdb7; border-radius: var(--radius-card); background: var(--warning-soft); }
.secret-panel > div { min-width: 0; display: grid; gap: 6px; }.secret-panel small { color: var(--warning); font: 700 8px/1 var(--mono); text-transform: uppercase; letter-spacing: .06em; }.secret-panel code { overflow: auto; padding: 9px; border: 1px solid #e2d6c4; border-radius: 8px; background: rgba(255,255,255,.72); font: 600 10px/1.4 var(--mono); white-space: nowrap; }.secret-panel > p { grid-column: 1 / -1; margin: 0; color: #6f5435; font-size: 9px; }.secret-panel.unavailable { border-color: var(--line); background: var(--surface-muted); }.secret-panel.unavailable strong { font-size: 11px; }
.setup-steps { display: grid; gap: 18px; margin: 0; padding: 0; list-style: none; counter-reset: setup-step; }.setup-steps > li { display: grid; grid-template-columns: 24px minmax(0,1fr); gap: 7px 11px; counter-increment: setup-step; }.setup-steps > li:before { content: counter(setup-step); width: 24px; height: 24px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: var(--accent-soft); font: 700 8px/1 var(--mono); }.setup-steps > li > div { align-self: center; }.setup-steps strong { font-size: 11px; }.setup-steps p { margin: 2px 0 0; color: var(--muted); font-size: 9px; }
.setup-steps pre { grid-column: 2; min-width: 0; position: relative; overflow: auto; margin: 0; padding: 14px 67px 14px 14px; border: 1px solid #243646; border-radius: 10px; color: #edf2f5; background: #253746; }.setup-steps code { font: 500 9px/1.62 var(--mono); white-space: pre-wrap; overflow-wrap: anywhere; }.copy-code { position: absolute; right: 7px; top: 7px; display: inline-flex; align-items: center; gap: 4px; padding: 5px 7px; border: 1px solid rgba(255,255,255,.22); border-radius: 7px; color: #edf2f5; background: rgba(255,255,255,.07); cursor: pointer; font-size: 8px; }
.verify-panel { display: grid; grid-template-columns: 1fr auto; gap: 6px 13px; align-items: center; margin-top: 22px; padding: 13px; border: 1px solid #d9e2ea; border-radius: var(--radius-card); background: var(--accent-soft); }.verify-panel small { grid-column: 1 / -1; color: var(--accent-strong); font: 700 8px/1 var(--mono); text-transform: uppercase; }.verify-panel p { margin: 0; font-size: 10px; }.setup-notes { margin: 16px 0 0; padding: 0 0 0 17px; color: var(--muted); }.setup-notes li { margin: 5px 0; font-size: 9px; }

.side-nav { min-height: 0; overflow-y: auto; scrollbar-width: thin; }
.memory-health-cell { min-width: 0; min-height: 112px; display: grid; grid-template-columns: 34px minmax(0,1fr); gap: 11px; align-items: start; padding: 17px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.memory-health-cell.primary { color: #edf4f8; border-color: #3d5f7e; background: #3d5f7e; }.memory-health-cell > .ph { width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; color: var(--accent-strong); background: var(--accent-soft); font-size: 17px; }.memory-health-cell.primary > .ph { color: #edf4f8; background: rgba(255,255,255,.13); }
.memory-health-cell div { min-width: 0; display: grid; }.memory-health-cell strong { overflow-wrap: anywhere; font: 700 22px/1.05 var(--display); }.memory-health-cell span { margin-top: 5px; font-size: 10px; font-weight: 700; }.memory-health-cell small { margin-top: 5px; color: var(--muted); font-size: 8px; }.memory-health-cell.primary small { color: #cbd9e3; }
.company-columns { display: grid; grid-template-columns: minmax(0,1.1fr) minmax(0,.9fr); gap: 18px; }.company-columns > section { min-width: 0; }
.company-list { overflow: hidden; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.company-row { width: 100%; min-width: 0; min-height: 62px; display: grid; grid-template-columns: 28px minmax(0,1fr) auto; gap: 10px; align-items: center; padding: 11px 13px; border: 0; border-bottom: 1px solid var(--line); color: var(--ink); background: transparent; text-align: left; }
button.company-row { cursor: pointer; }.company-row:last-child { border-bottom: 0; }.company-row:hover { background: var(--surface-muted); }.company-row > .ph { width: 28px; height: 28px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: var(--accent-soft); }.company-row.danger-row > .ph { color: var(--danger); background: var(--danger-soft); }
.company-row > span { min-width: 0; display: grid; }.company-row strong { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 10px; }.company-row small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 8px; }.company-row em { color: var(--faint); font: 600 8px/1.3 var(--mono); font-style: normal; }
.coverage-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px,1fr)); gap: 10px; }
.coverage-card { min-width: 0; display: grid; gap: 13px; padding: 15px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }.coverage-card > div:first-child { display: grid; grid-template-columns: 32px minmax(0,1fr); gap: 9px; align-items: center; }.coverage-card > div:first-child > .ph { width: 32px; height: 32px; display: grid; place-items: center; border-radius: 8px; color: var(--accent-strong); background: var(--accent-soft); font-size: 16px; }.coverage-card > div span { min-width: 0; display: grid; }.coverage-card strong { font-size: 10px; }.coverage-card small { color: var(--faint); font-size: 8px; }.coverage-card > .health-state { justify-self: start; }.coverage-card dl { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; margin: 0; }.coverage-card dl div { display: grid; gap: 3px; padding: 8px; border-radius: 8px; background: var(--surface-muted); }.coverage-card dt { color: var(--faint); font: 650 8px/1 var(--mono); }.coverage-card dd { min-width: 0; overflow: hidden; text-overflow: ellipsis; margin: 0; font-size: 8px; white-space: nowrap; }

.people-grid, .workstream-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 360px), 1fr)); gap: 12px; }
.person-card, .workstream-card { min-width: 0; display: grid; align-content: start; gap: 14px; padding: 17px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }
.person-card > header { display: grid; grid-template-columns: 38px minmax(0,1fr); gap: 10px; align-items: center; }.person-avatar { width: 38px; height: 38px; display: grid; place-items: center; border-radius: 10px; color: var(--accent-strong); background: var(--accent-soft); font: 750 14px/1 var(--display); }.person-card h2, .workstream-card h2 { margin: 0; font: 700 15px/1.25 var(--display); }.person-card header p { margin: 2px 0 0; color: var(--muted); font-size: 8px; }.person-section { display: grid; gap: 7px; }.person-section > small { color: var(--faint); font: 650 8px/1 var(--mono); text-transform: uppercase; }.person-work { display: grid; gap: 5px; }.person-work button { min-width: 0; display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 9px; padding: 8px 9px; border: 1px solid var(--line); border-radius: 8px; color: var(--ink); background: var(--surface-muted); text-align: left; cursor: pointer; }.person-work button:hover { border-color: var(--accent); background: var(--accent-soft); }.person-work button span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 9px; }.person-work button small { color: var(--faint); font: 600 8px/1 var(--mono); }.person-card footer { display: flex; flex-wrap: wrap; gap: 7px 12px; padding-top: 11px; border-top: 1px solid var(--line); color: var(--muted); font-size: 8px; }
.workstream-card > header { display: flex; align-items: flex-start; justify-content: space-between; gap: 10px; }.workstream-card header > div { min-width: 0; }.workstream-card header div > span { color: var(--faint); font: 600 8px/1.3 var(--mono); }.workstream-card > p { min-height: 29px; margin: 0; color: var(--muted); font-size: 9px; }.workstream-facts { display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 6px; }.workstream-facts span { min-width: 0; display: grid; gap: 3px; padding: 8px; border-radius: 8px; background: var(--surface-muted); color: var(--faint); font-size: 8px; }.workstream-facts b { overflow: hidden; text-overflow: ellipsis; color: var(--ink); font-size: 10px; white-space: nowrap; }

.history-controls { display: flex; align-items: center; gap: 9px; margin-bottom: 14px; }.history-controls label { font-size: 9px; font-weight: 700; }.history-controls select { padding: 8px 28px 8px 9px; border: 1px solid var(--line-strong); border-radius: var(--radius-control); background: var(--surface); font-size: 9px; }
.lineage-controls { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 8px; }.lineage-controls select { min-height: 29px; padding: 5px 28px 5px 8px; border: 1px solid var(--line-strong); border-radius: var(--radius-control); background: var(--surface); font-size: 9px; }.timeline-list { padding: 15px 16px 0; border: 1px solid var(--line); border-radius: var(--radius-panel); background: var(--surface-muted); }
.history-timeline { display: grid; }.history-item { min-width: 0; display: grid; grid-template-columns: 128px 32px minmax(0,1fr); gap: 13px; position: relative; padding: 0 0 20px; }.history-item:not(:last-child):before { content: ""; width: 1px; position: absolute; left: 143px; top: 32px; bottom: 0; background: var(--line-strong); }.history-item > time { padding-top: 8px; color: var(--faint); font: 500 8px/1.4 var(--mono); text-align: right; }.history-item > .ph { width: 32px; height: 32px; display: grid; place-items: center; z-index: 1; border: 1px solid var(--line); border-radius: 9px; color: var(--accent-strong); background: var(--surface); font-size: 15px; }.history-item > div { min-width: 0; padding: 11px 13px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); }.history-item > div > div { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }.history-item h2 { margin: 7px 0 3px; font-size: 11px; }.history-item p { margin: 0; color: var(--muted); font-size: 9px; }.history-item small { display: block; margin-top: 7px; color: var(--faint); font: 500 8px/1.4 var(--mono); }.history-type { color: var(--accent-strong); font: 700 8px/1 var(--mono); text-transform: uppercase; }
.history-item .button { margin-top: 10px; }.history-item .recorded-note { margin-top: 8px; }
.change-summary { display: grid; gap: 4px; margin: 9px 0 0; padding: 0; list-style: none; color: var(--muted); font-size: 10px; overflow-wrap: anywhere; }.change-summary b { color: var(--ink); }
.knowledge-history { display: grid; gap: 10px; }.knowledge-change { display: grid; gap: 5px; padding: 12px 0; border-top: 1px solid var(--line); overflow-wrap: anywhere; }.knowledge-change time, .knowledge-change small { color: var(--faint); font-size: 9px; }.knowledge-change strong { font-size: 11px; }.knowledge-change p { margin: 0; color: var(--muted); font-size: 10px; }
.source-details, .person-card details { margin-top: 15px; padding-top: 10px; border-top: 1px solid var(--line); }.source-details > summary, .person-card details > summary, .knowledge-change details > summary { width: fit-content; color: var(--accent-strong); cursor: pointer; font-size: 10px; font-weight: 650; }.source-details > div, .person-card details > div { margin-top: 10px; }.knowledge-change details { margin-top: 5px; }.knowledge-change details .markdown-body { max-height: 260px; overflow-y: auto; margin-top: 9px; padding: 10px; border: 1px solid var(--line); border-radius: 8px; }
.memory-state { display: inline-flex; width: fit-content; padding: 4px 6px; border-radius: 7px; color: var(--positive); background: var(--positive-soft); font: 700 8px/1 var(--mono); text-transform: uppercase; }.memory-state.needs_review, .memory-state.escalated { color: var(--warning); background: var(--warning-soft); }.memory-state.superseded, .memory-state.rejected { color: var(--faint); background: var(--surface-subtle); }.memory-state.observed, .memory-state.recorded { color: var(--accent-strong); background: var(--accent-soft); }.tree-row .memory-state { justify-self: end; }
.preview-state { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; margin-top: 8px; }.field > small { color: var(--muted); font-size: 8px; }

@media (max-width: 1180px) {
  .pulse-strip { grid-template-columns: repeat(3, 1fr); }
  .pulse-strip > p { grid-column: 1 / -1; min-height: 61px; border-top: 1px solid var(--line); }
  .review-layout { grid-template-columns: minmax(0,1fr) 270px; }
  .board { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .evidence-detail { position: static; }
  .company-columns { grid-template-columns: 1fr; }
  .projects-workspace { grid-template-columns: minmax(220px,.72fr) minmax(390px,1.4fr); }
  .project-rail { grid-column: 1 / -1; display: grid; grid-template-columns: 1fr 1fr; gap: 20px; padding: 22px 0; border-top: 1px solid var(--line); }
  .project-rail > section + section { margin: 0; padding: 0 0 0 20px; border-top: 0; border-left: 1px solid var(--line); }
}

@media (max-width: 820px) {
  .app-shell { display: block; padding-bottom: 64px; }
  .sidebar { min-height: 0; height: 64px; width: 100%; display: block; position: fixed; inset: auto 0 0; padding: 7px 9px; border: 0; border-top: 1px solid var(--line); background: rgba(245,246,247,.96); backdrop-filter: blur(16px); }
  .brand-lockup { display: none; }
  .side-tools, .account-summary { display: none; }
  .side-nav { height: 100%; grid-template-columns: repeat(5,minmax(0,1fr)); gap: 3px; overflow: visible; }
  .nav-item { grid-template-columns: 1fr; gap: 1px; justify-items: center; padding: 3px; }.nav-item > .ph { font-size: 17px; }.nav-item b { font-size: 8px; }.nav-item em { display: none; }
  .more-menu { position: absolute; right: 0; bottom: 59px; width: 200px; max-height: 60dvh; overflow-y: auto; margin: 0; padding: 6px; border: 1px solid var(--line); border-radius: var(--radius-card); background: var(--surface); box-shadow: var(--shadow-small); }
  .more-menu .nav-item { grid-template-columns: 21px 1fr; justify-items: start; padding: 9px; }.more-menu .nav-item b { font-size: 11px; }
  .topbar { height: 55px; padding: 0 18px; }
  .workspace-switcher { min-height: 40px; width: min(250px, 55vw); padding: 5px 7px; }
  main { padding: 24px 18px 49px; }
  .review-layout { grid-template-columns: 1fr; }.decision-card { position: static; }
  .context-browser { grid-template-columns: 225px minmax(0,1fr); }.preview-panel { padding: 23px; }
  .agent-grid { grid-template-columns: 1fr; }
  .integration-grid { grid-template-columns: 1fr; }
  .projects-hero { min-height: 0; padding: 3px 0 20px; }
  .projects-summary { padding-left: 0; gap: 12px; overflow-x: auto; }
  .projects-workspace { display: block; }.project-index, .project-focus { border-right: 0; border-bottom: 1px solid var(--line); }.project-index { padding-right: 0; }.project-focus { padding: 28px 2px; }.project-rail { display: grid; grid-template-columns: 1fr 1fr; }
  .people-grid, .workstream-grid { grid-template-columns: 1fr; }
}

@media (max-width: 620px) {
  .settings-section { display: block; padding: 22px 0; }.settings-section header { margin-bottom: 18px; }.settings-section header p { max-width: none; }
  .settings-member { display: block; }.member-controls { margin-top: 12px; }.member-controls select { flex: 1; max-width: none; }
  .onboarding-step { grid-template-columns: 32px minmax(0,1fr); gap: 12px; }.onboarding-step > a { grid-column: 2; justify-self: start; }.onboarding-head h1 { font-size: 26px; }
  .crumb span, .crumb b { display: none; }.top-actions .button { padding: 7px 9px; }.top-actions .button .ph { margin: 0; }.top-actions .button { font-size: 0; }.top-actions .button .ph { font-size: 15px; }#analyze { display: none; }
  .work-intro, .page-head, .agents-hero { min-height: 0; align-items: flex-start; }.work-intro p, .page-head p, .agents-hero p { font-size: 10px; }
  .pulse-strip { grid-template-columns: 1fr; }.pulse-strip > div { min-height: 64px; border-right: 0; border-bottom: 1px solid var(--line); }.pulse-strip > p { grid-column: auto; border-top: 0; }
  .section-head { align-items: flex-start; flex-direction: column; }.context-heading { gap: 10px; }.context-actions { width: 100%; flex-wrap: wrap; }.lineage-controls { width: 100%; justify-content: flex-start; }.search-field { flex: 1; min-width: 220px; }.context-filter { flex: 1; max-width: none; }
  .context-hero { min-height: 185px; }.context-hero img { object-position: 60% center; }.context-hero-copy { left: 18px; right: 18px; bottom: 17px; }.hero-index { left: 10px; right: auto; top: 10px; }
  .context-tabs { width: 100%; }.context-tab { min-width: 0; grid-template-columns: 25px 1fr; padding: 7px; }.context-tab > .ph { width: 25px; height: 25px; }.context-tab small { display: none; }
  .context-browser { height: auto; min-height: 0; display: block; }.tree-panel { max-height: 245px; display: block; overflow: auto; padding: 12px; border-right: 0; border-bottom: 1px solid var(--line); }.context-tree { overflow: visible; padding-right: 0; scrollbar-gutter: auto; }.preview-panel { min-height: 400px; overflow: visible; scrollbar-gutter: auto; }.preview-empty { min-height: 310px; }
  .lineage, .source-metadata { grid-template-columns: 1fr; }.source-preview-cap, .source-read-actions { align-items: flex-start; flex-direction: column; }.source-section { grid-template-columns: minmax(0,1fr) 15px; }.source-section p { grid-column: 1 / -1; grid-row: 2; }
  .board { grid-template-columns: 1fr; }.evidence-detail-grid { grid-template-columns: 1fr; }
  .projects-hero { display: grid; }.projects-hero .button { width: fit-content; }.projects-summary { gap: 9px; font-size: 9px; }.projects-summary > .ph { font-size: 12px; }.projects-summary b { font-size: 11px; }
  .project-rail { display: block; }.project-rail > section + section { margin-top: 22px; padding: 18px 0 0; border-top: 1px solid var(--line); border-left: 0; }.project-task { grid-template-columns: minmax(0,1fr) auto; }.project-task > em { display: none; }.project-facts > span { padding: 0 8px; }.project-facts > span:nth-child(3) { border-right: 0; }.project-facts .button { width: 100%; margin: 12px 0 0; }
  .field-pair, .capability-field { grid-template-columns: 1fr; }.field-pair { gap: 0; }.capability-field label:last-child { grid-column: auto; }
  .agent-boundary { grid-template-columns: 30px 1fr; }.agent-card { min-height: 0; }.agent-card-foot { align-items: flex-start; flex-direction: column; }.agent-card-foot > div { justify-content: flex-start; }
  .activity-row { grid-template-columns: 1fr; gap: 4px; }.activity-row .button { justify-self: start; }.detail-grid { grid-template-columns: 1fr; }
  .secret-panel, .verify-panel { grid-template-columns: 1fr; }.secret-panel > p, .verify-panel small { grid-column: auto; }.secret-panel .button, .verify-panel .button { width: 100%; }
  .memory-health-cell { min-height: 0; }.coverage-grid { grid-template-columns: 1fr; }.history-item { grid-template-columns: 1fr 32px; }.history-item > time { grid-column: 1 / -1; padding: 0; text-align: left; }.history-item:not(:last-child):before { left: 15px; top: 54px; }.history-item > .ph { grid-column: 1; }.history-item > div { grid-column: 2; grid-row: 2; }
}

@supports not (backdrop-filter: blur(1px)) {
  .topbar, .sidebar { background-color: var(--canvas); }
}

@media (prefers-reduced-motion: reduce) {
  *, *:before, *:after { animation-duration: .001ms !important; animation-iteration-count: 1 !important; transition-duration: .001ms !important; scroll-behavior: auto !important; }
}
`;
