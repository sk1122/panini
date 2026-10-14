# LLM findings never write current work state

Status: Superseded by [ADR 0004](./0004-panini-autonomously-adjudicates-proposals.md).

Notion rows are treated as Baseline Claims, while Slack, code, and agent activity are immutable Evidence Items. An LLM may correlate them into typed, evidence-citing Findings, but it cannot directly create accepted context or mutate current task state; deterministic validation and the proposal policy sit between interpretation and versioned state. This adds a review step and allows abstention, but prevents a stale row, duplicated message, prompt injection, or confident agent summary from becoming company truth without an auditable decision.
