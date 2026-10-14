# Task picture v2: first-principles design

Date: 2026-09-30. Status: **partial proposal, superseded by the [full information-loop design](panini-full-information-loop-2026-09-30.md)**. This note covers work but not the complete Context and retrieval system. No code, replay, or production data was changed by this design.

## Goal

A person should be able to ask what work exists, what changed, what is still open, and why Panini believes it. Every answer should distinguish a source's report from an accepted decision and from verified completion. Unknown work must be visible as unresolved, not silently discarded.

This design concerns the source-to-Tasks/Context pipeline. It does not replace authentication, connectors, the UI, PostgreSQL, or the existing proposal/revision writer.

## Why the current pipeline fails

The current path makes a Jev route before full Task context, filters `neither`, gives a prose interpreter a mutable Task snapshot, then uses further Jev judgments and directly approved full-snapshot proposals. A completed interpretation run excludes its events even when its findings were rejected. Separate human board decisions are not all replayable as source receipts. These are observed in the [root-cause audit](../../artifacts/task-picture-root-cause-2026-09-27.md), [cached-gate replay](../../artifacts/cached-gate-replay-2026-09-27.md), and [Task audit](../../artifacts/new-run-task-audit-2026-09-27.md).

## Minimal replacement

```text
Source receipts + human board actions
        -> cited, atomic claims
        -> one WorkReconciler module
        -> existing proposals/revisions
        -> Tasks, Context, history, unresolved review queue
```

1. **Capture.** Keep immutable source receipts. Record authorized board creates/edits/status changes as source receipts too. Deduplicate identical source versions; retain edits and supersessions. Record both source time and receipt time.
2. **Extract once.** The existing interpreter can propose small claims such as requested deliverable, progress report, blocker, test result, completion report, and Context fact. Each claim must include exact supporting text or structured source fields and source IDs. Code verifies that quoted text exists in the cited receipt. This is candidate extraction, not permission to change a Task. Do not pre-filter events with Jev. Keep short replies with their thread or linked-object context, in bounded batches.
3. **Reconcile.** A single deep `WorkReconciler` module accepts a claim and returns `applied`, `needs_review`, `superseded`, or `irrelevant`, with a reason. It links automatically only by explicit, unique identifiers or previously accepted source links. It never merges work because titles, topics, embeddings, or scores look similar. Search may suggest candidates to a reviewer, but does not authorize a link. An explicit new deliverable can open a proposed Task; ambiguous Slack language stays in review.
4. **Reduce fields, not snapshots.** A claim changes only the field it actually supports. Preserve an accepted Task's stable outcome and source anchors. Earlier evidence can enrich history but cannot silently replace a later accepted field. Explicit corrections can supersede claims. A reported completion is not verified completion; `done` needs an authorized human action or outcome-specific accepted verification. Disagreement becomes review, not an arbitrary last-write-wins update.
5. **Persist disposition.** Store each claim and its decision/reason/version in one new durable record. `processed` means extraction attempted, not reconciled. Retry `needs_review` or temporary failures when missing context, a Task link, source coverage, or policy changes. Never rerun the whole corpus just because one claim was unresolved.

Reuse PostgreSQL source events, proposals, revisions, and outbox. The necessary new state is a claim/disposition record plus stable Task outcome/source anchors; manual board actions need replayable receipts. Do not add another vector database, model judge, distributed event bus, or new product navigation. Remove Jev routing, ranking, and gating from the source-to-work path; do not replace Jev with a second LLM judge. Keep the existing model only for cited candidate extraction and readable summaries.

## Consequence and honest limit

This prioritizes no false Task merge or false `done` over automatic acceptance of every ambiguous sentence. The review queue is part of the product, not a failure to hide. Missing GitHub Checks, agent reports, some Slack identity data, and historical board actions cannot be reconstructed from model choice. A source-only historical replay and an accurate current-state board are different claims; the latter needs a trusted current-board baseline or replayable past human actions.

## Validation before adoption

1. Freeze one corpus and source-coverage cutoff. Curate an outcome-level reference set with positives, negatives, distinct-versus-related work, explicit status/verification, and missing-source labels. Keep held-out cases separate from design cases.
2. First write E2E failure cases and expected artifacts, then implement the smallest module. Include Polymarket partial progress, causal-worker retest as separate work, heap memory versus product memory, Generate evidence baseline, bare standup, duplicate receipts, out-of-order evidence, and human board actions. Record claim IDs, dispositions, revisions, and the resulting board as repeatable artifacts.
3. Compare old and new on the same frozen inputs: distinct-work recall, unsupported Task rate, wrong-link rate, false `done` count, status freshness, unresolved-review load, and provider cost. A five-case spot check or source-event coverage is not an overall score.
4. Run a full isolated replay and a separate current-board-seeded catch-up. Review failures and costs before any production promotion.

## Research boundary

The [primary-paper note](../../artifacts/task-state-first-principles-papers-2026-09-30.md) covers provenance, two kinds of time, uncertain identity matching, selective abstention, and long-context retrieval failures. These support the design questions and evaluation method, not a claim that this implementation will work on Sozu's data without the E2E and held-out replay above.
