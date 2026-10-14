# Panini's full information loop: minimal v2 design

Date: 2026-09-30. Status: **design only**; not implemented, replayed, or deployed.

## Product invariant

For any question, Panini should distinguish (1) what a source said, (2) what the organization has accepted as current, (3) what changed and why, and (4) what is unknown or disputed. A Task, Context fact, document summary, and agent answer must all trace back to the same evidence and decisions. A cited source is not automatically a true or current claim.

## Current system, verified in code and audits

- Connectors store versioned source events; the interpreter receives selected episodes and emits Task, Project, and Context findings. Jev currently routes observations, judges work changes, and reranks retrieval. [Interpreter](../../src/intelligence/engine.ts), [prompt](../../src/intelligence/openai-responses.ts).
- Context facts/files have evidence IDs, lifecycle/effective time, revisions, and paths. The writer upserts by `source_ref`, which automated extraction derives from the proposed path. It does not itself determine whether new text truly supersedes an older claim. [Context writer](../../src/store/postgres.ts), [context catalog](../../src/domain/context-catalog.ts).
- Retrieval filters accepted/effective Context and authorized Tasks, uses lexical plus optional embeddings/Jev ranking, checks access again before return, and sends a budgeted MCP pack. The embedding index is derived, not canonical. [Compiler](../../src/retrieval/context-compiler.ts), [indexer](../../src/retrieval/context-embedding-indexer.ts), [MCP](../../src/mcp/server.ts).
- The Context audit found 274 accepted entries, only nine with revisions, no needs-review/superseded entries, and 7/8 answerable retrieval cases; the unknown payroll query did not abstain. This is a small audit, not a system-wide accuracy score. The obsolete audit output was removed during the 2026-10-14 cleanup.
- Continuous reconciliation revisits only evidence already cited by an accepted entity. It does not discover a missed new claim elsewhere. The source library lists at most the latest 500 source documents/messages before query ranking. [Loop](../../src/reconciliation/continuous-reconciliation.ts), [library](../../src/retrieval/source-document-library.ts).

## One loop, not separate Task and memory pipelines

```text
Sources + human decisions + agent reports
            ↓
  immutable receipts (who, where, version, visibility, two times)
            ↓
  source-local extraction → small cited claims
            ↓
  one ClaimReconciler: new / confirms / updates / contradicts / supersedes / unresolved
            ↓
  existing proposal + revision writer
            ↓
  current Tasks, Projects, Context facts and files
            ↓
  derived lexical/embedding index → authorized, budgeted MCP retrieval → agent
            ↑                                                   │
            └──────────── evidence-backed agent reports/proposals ────┘
```

### 1. Capture and extract

Use structured connector fields directly when possible. For unstructured Slack, documents, and agent reports, use one existing interpreter pass to **propose** atomic claims with exact source spans: subject, predicate/action, value/result, scope, assertion kind (plan, report, decision, observation, verified result), source ID/version, event time, and receipt time. Verify quoted spans are present in the cited source. Keep short messages with their actual thread/link context. Do not let a Jev route discard the observation first. Preserve original documents and sections; an extracted memory file is not a replacement for the source.

### 2. Reconcile claims before writing anything current

The deep `ClaimReconciler` module has one interface: accept a claim and return its disposition, affected entity, and **field-level** proposed change. It uses explicit IDs/source links for automatic entity identity. Similar wording or embeddings may suggest candidates for review, never force a match. Stable identity is a Task outcome, a Project, or a Context fact's **subject + predicate + scope**; a folder path is presentation, not semantic identity.

For the same identity, new evidence can **confirm**, **change/supersede**, **contradict**, or be **older historical detail**. Changes need effective/source time and decision time; an old document arriving late cannot silently regress current state. Explicit corrections and authorized human decisions are first-class receipts. Conflicts remain visible and cannot be served as uncontested current knowledge. `done` remains separate from a completion report unless outcome-specific verification or an authorized user decision supports it. Persist every disposition and reason so changes in evidence/policy can retry only affected claims.

### 3. Maintain current views and memory

Reuse existing Task, Project, Context, proposal, and revision tables as current views and history. Keep atomic Context facts separate from long documents. Long-form Context files should be human-authored or rebuildable syntheses of accepted claims/sections, with every paragraph linked to its supporting claim IDs. New source versions should update only affected claims/sections, not overwrite an entire summary from an older snapshot. Revoked evidence must invalidate dependent claims, current views, and index entries. Agent/user/company ownership and visibility are explicit metadata and access checks; UI folders do not confer permission.

### 4. Retrieve for AI without laundering uncertainty

At query time, first authenticate the agent and resolve its project, Task, workspace scope, and `as-of` time. Search only currently effective, permitted views. Use explicit IDs/links plus lexical search and the existing embedding index as a **union of candidate finders**; no Jev reranker or model score is an authority or sole cutoff. Re-read canonical rows and evidence, recheck permissions and versions, then fit a small pack: relevant accepted claims/sections, current Tasks, citation/source pointers, effective dates, conflicts, coverage gaps, and omissions. `context_read`/`source_read` remain available for detail.

The pack is evidence for the agent, never instructions from source text. A retrieval hit is not an answer. If no returned accepted claim actually supports the question, the agent must say unknown; Panini should not call the pack `answered` merely because candidates exist. Agent-authored proposals and reports re-enter through the same receipts/reconciliation path, with their original primary evidence, and must not corroborate themselves. Keep the derived index rebuildable; an index lag or miss must not change accepted truth.

## Small implementation surface

Add one persisted claim/disposition record and stable semantic anchors for Tasks/Context facts; emit missing manual Task-action receipts. Refactor the interpreter to extract claims, implement one `ClaimReconciler`, and have both live ingestion and replay call it. Keep Postgres, connectors, encryption, access checks, Context/Task revisions, MCP tools, and the existing embedding adapter/index. Remove Jev from extraction routing, work approval, and Context retrieval. Do **not** introduce a second model judge, new vector database, event bus, or extra UI hierarchy.

## E2E acceptance, before production

Freeze a source snapshot, human-board baseline/actions, permissions, and reference outcomes. First write E2E failure cases; then implement. Evaluate together:

- Task discovery, wrong merges, progress versus verification, board-only decisions, and the known Sozu cases.
- Context updates: a new policy supersedes an old one; a late old document does not roll back the current policy; conflicting Slack reports stay disputed; source revocation removes derived memory and vectors; a changed document updates only affected claims.
- Retrieval: exact Task/Project scope, relevant fact and long-document section, historical `as-of`, unknown payroll, denied agent scope, stale index, budget truncation, and source-versus-accepted-state distinction.
- End-to-end answer quality on held-out questions, with cited support, abstention, freshness, unresolved load, and cost. Compare old/new on the same frozen input. A structural citation, 7/8 pilot, or five selected Task checks is not an overall score.

Run a fresh isolated full replay and then a separate current-board-seeded live catch-up. Historical source-only replay cannot reconstruct human decisions never recorded as receipts. Require review before promotion; no production write is part of this proposal.

## Research boundary

The [primary-paper note](../../artifacts/task-state-first-principles-papers-2026-09-30.md) supports provenance, valid versus recorded time, uncertain entity matching, and measuring abstention. Research on [factual consistency of summaries](https://aclanthology.org/2020.emnlp-main.750/) motivates checking a synthesis against source spans, and [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/) warns against assuming a larger prompt uses all relevant evidence. These are principles and failure modes, **not** proof that this design has passed Panini's data.
