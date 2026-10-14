# Panini autonomously adjudicates proposals

Status: Accepted. Supersedes ADR 0001's requirement for routine human review while preserving its finding/proposal/revision boundary.

Panini, rather than a person, normally decides whether a Work Proposal is approved, rejected, or superseded. It receives the active cited evidence, current accepted target, accepted revision history, and related proposal history. Chronology is explicit: `occurredAt` is the source's claim time, `fetchedAt` and `receivedAt` are transport times, and `appliedAt` is acceptance time. Later ingestion alone never makes a claim newer.

The adjudication model returns strict structured decisions, but it does not write accepted state. Deterministic code validates active citations, completion-evidence gates, duplicate or overtaken proposals, target/base consistency, and the approval confidence threshold. Only the domain transaction writes the proposal decision, immutable revision, audit event, and projection outbox effect. Stale non-conflicting task proposals may be rebased through a replacement proposal before approval so the original history remains intact.

Human attention is an exception, represented by the persisted `escalated` proposal state. Panini escalates only when credible evidence remains mutually inconsistent, a materially sensitive ambiguity cannot be resolved safely, or an approval is below the configured confidence floor. Unsupported claims are rejected and obsolete claims are superseded rather than sent to people. Provider failures leave proposals pending for retry instead of silently escalating or mutating state.

This increases model dependence and makes adjudication quality an operational concern, but avoids a permanent human review bottleneck. The rollback is configuration-only: switch proposal policy to `manual_review` and disable adjudication; the proposal ledger, evidence lineage, and revision model remain unchanged.
