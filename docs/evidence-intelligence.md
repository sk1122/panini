# Evidence intelligence

## Purpose

Notion task rows are baseline claims about work, not reliable proof of its present state. Panini accepts later observations from Slack, code hosts, and coding agents, then uses a bounded LLM pass to identify possible task updates, new commitments, and durable context.

The result is a proposal boundary followed by autonomous adjudication, not a direct model rewrite of accepted state.

## Processing boundary

1. A connector or agent records an immutable source event.
2. The store deduplicates it by provider installation and provider event ID.
3. A manual or scheduled run selects only events not included in a completed interpretation run.
4. The engine compiles bounded task, context, and evidence digests.
5. The interpreter performs a durable-context pass and a separate task-board reconciliation pass, then returns strict structured findings. Plans and open actions remain work; they are not completion evidence.
6. The engine rejects invented citations, unknown tasks, incomplete shapes, and low-confidence findings.
7. A proposed completion additionally requires the higher completion threshold, the configured minimum number of distinct evidence items, and evidence from a configured delivery provider.
8. Valid findings become pending task or context proposals.
9. Panini batches pending proposals with active evidence, evidence time, accepted revision history, and related proposal history.
10. Deterministic guards supersede revoked, duplicated, or chronologically overtaken proposals and reject completion claims that lack configured corroboration.
11. The adjudicator returns strict `approve`, `reject`, `supersede`, or `escalate` decisions. Low-confidence approvals become escalations.
12. A domain transaction records the decision, audit details, immutable revision, and projection effect. The model never writes accepted state directly.
13. A person handles only proposals persisted as `escalated` because Panini could not safely resolve a rare credible conflict.

The interpretation run records the model name, input hash, event IDs, validated output, outcomes, timestamps, and any failure. Failed runs leave their events eligible for retry; completed runs consume them even when an individual finding was rejected or abstained. An authorized targeted refresh may explicitly pass active `eventIds` to `POST /api/intelligence/run`; this reinterprets those receipts without deleting prior run history and is intended for compiler/prompt upgrades or operator repair.

For long-form source documents, accepted context files remain concise rather than mirroring the entire page. Headings, implemented-versus-planned labels, interfaces, invariants, and the primary relationship-bearing Mermaid/ASCII diagram are preserved when present. Atomic claims still become separate facts so independently changeable statements do not hide in a narrative blob.

Adjudication decisions record the decision actor/model, confidence, temporal basis, historical basis, and decision note on the proposal audit path. Provider failures leave proposals pending for the next run. Set `policy.mode: autonomous` and enable `adjudication` to use this path; `manual_review` remains the operational rollback.

## Raw evidence contract

`POST /api/evidence/events` accepts:

```json
{
  "provider": "github",
  "installationKey": "organization/repository",
  "providerEventId": "push:abc123",
  "eventKind": "code.pushed",
  "occurredAt": "2026-09-12T09:00:00.000Z",
  "sourceRef": "github:organization/repository:abc123",
  "sourceUrl": "https://github.com/organization/repository/commit/abc123",
  "visibility": "company",
  "payloadVersion": "github-push-v1",
  "payload": {
    "sha": "abc123",
    "branch": "main",
    "linkedTaskIds": ["task UUID when known"]
  }
}
```

The caller does not supply a content hash. Panini computes it from the event identity, kind, and payload. Repeating the same provider event returns the existing receipt.

## Collector expectations

- GitHub or another code host should emit push, pull-request, review, merge, and check-suite receipts with stable provider IDs and explicit task links where available.
- Slack stays limited to administrator-selected public project channels. A deployment may use explicit reaction capture or explicitly approved full-channel ingestion; avoid DMs, private channels, files, user tokens, and workspace-wide collection.
- Coding agents should use `work_report` for structured lifecycle evidence. Artifact references and verification summaries are useful; prompts, full transcripts, secrets, and raw tool output are not.
- Message edits, deletions, force-pushes, reverted changes, and failed checks should be appended as new observations rather than mutating old receipts.

Live Slack and code-host transports are deliberately separate adapters. Slack uses Socket Mode. In reaction mode, an allowed `:panini:` or `:bookmark:` reaction captures one message. In all-messages mode, Panini performs an idempotent startup backfill of accessible history and thread replies, then records new allowlisted messages. GitHub uses signed webhook deliveries. Both retain provider-specific permissions, allowlists, authenticity checks, and revocation behavior behind the common evidence contract.
