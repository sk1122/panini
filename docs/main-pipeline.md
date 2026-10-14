# Main pipeline baseline

Selected on 2026-10-14: ObservationAgent v26, gpt-6-luna, medium reasoning, Voyage-4 work embeddings.

The source and compiled code matched the completed full replay before cleanup. The actor and prompt were not changed. The local environment, example environment, and Compose now select the observation-agent configuration and model. PostgreSQL serves accepted-memory retrieval. The separate accepted-file embedding index stays disabled; the actor uses its own budgeted Voyage-4 work embeddings.

The worker requires explicit budget and visibility settings. No production worker, connector, or review server was started. Legacy library modules remain where app routes, migrations, or compatibility tests depend on them; they are not the selected pipeline.

## Retained data

- Source database: `panini_e2e`. Existing source tables were preserved.
- Completed full replay: `panini_replay_full_dataset_medium_20261005`.
- Medium gold runs: `panini_replay_observation_final_native_v26_medium_{a,b}_s{1,2,3,4}`.
- Local artifacts: latest gold v8, medium run receipts, chronology, final accounting, full replay manifest, source/prompt snapshots, and cleanup evidence.
- Credentials and source backups remain local. Private artifacts and backups are excluded from Git.

The completed replay processed 2,963 input records: 2,706 processed observations and 257 duplicates. It contains 127 tasks and 668 context entries. The recorded provider cost is $27.64263811, including conservative charges for uncertain calls. Full-corpus accuracy remains unscored. The previous medium gold results were 37/38 and 38/38; they are not a full-corpus score.

## Verification

Build with `npm run build`. The existing `scripts/observation-agent-e2e.mjs` checks separate server/worker processes, accepted API data, source time, and duplicate-free restart using local provider stubs. It requires a disposable PostgreSQL test database and saves a JSON receipt. It does not measure model accuracy.

The read-only `scripts/observation-full-dataset-audit.mjs` checks saved request hashes, model/effort, accounting, and the durable frozen snapshot under `artifacts/observation-agent/code-snapshots/native_v26_medium`. It requires the local content key and database URL. No provider request is made.

The original full replay runner is retained as historical evidence. It references a temporary code directory and the original source database, which no longer exist. Do not use it to restart the completed run. The saved full replay, manifest, receipts, and durable code snapshot are the record of that run.
