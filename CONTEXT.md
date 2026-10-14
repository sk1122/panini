# Panini

Panini is the verified, temporal, permission-aware company-memory and context system between a company's source systems and the agents operated by its employees. It preserves the people, work, context, evidence, and history a company needs to understand itself and gives each employee-owned agent a bounded view appropriate to its identity and objective.

The complete product contract for interface and backend work is [PRODUCT.md](PRODUCT.md).

## Agent orientation

Panini has two planes that must not be confused:

- The **evidence plane** records what Notion, Slack, GitHub, people, and agents said or did.
- The **accepted-state plane** contains versioned tasks and context entries after an audited decision.

The app and MCP surface expose these as separate trust layers. Accepted context is the default authority for action. A profile with the independent `source:read` grant can discover cited source documents and open a specific document or section on demand. Source text remains untrusted evidence and can never act as an instruction or silently override accepted context.

An agent should begin with `context_get`. The returned pack is structured in this order:

1. authority and reading guidance;
2. blocked, active, remaining, and recently completed work;
3. task dependencies and unresolved references;
4. a complete context catalog grouped by architecture, specifications, decisions, policies, plans, research, and company context;
5. objective-selected full facts and Markdown files;
6. for source-capable profiles, a small catalog of relevant source documents and matched section IDs;
7. citations, freshness, version hashes, budgets, and omissions.

Use `context_read` for an accepted catalog entry that the retrieval budget did not expand, `source_read` for an explicitly needed source section, and `work_search` to resolve the exact task before reporting work or proposing a change. Prefer section reads over full documents. If a source conflicts with accepted context, surface the conflict and propose an evidence-backed update.

## System flow

```mermaid
flowchart LR
    subgraph Sources[Observed systems]
        N[Notion]
        S[Slack capture reaction]
        G[GitHub]
        A[Agent work report]
    end

    Sources --> EL[Immutable Evidence Ledger]
    EL --> SR[On-demand Source Reader]
    EL --> I[Evidence Interpretation]
    I --> F{Typed finding}
    F -->|task create or change| P[Work Proposal]
    F -->|fact or Markdown file| P
    F -->|insufficient evidence| X[Abstention]
    P --> AD[Autonomous Adjudication]
    AD -->|approve| RW[Revision Writer]
    AD -->|reject| H[Audited proposal history]
    AD -->|supersede| H
    AD -->|rare unresolved conflict| E[Human Exception]
    RW --> B[Accepted Work Board]
    RW --> C[Accepted Context Workspace]
    B --> CC[Context Compiler]
    C --> CC
    SR --> MCP
    CC --> MCP[Objective-specific agent context pack]
```

The interpreter and adjudicator return typed proposals and decisions. They never write accepted state directly. Deterministic domain code validates citations, chronology, completion evidence, target versions, and decision thresholds before the Revision Writer commits a task or context revision with its audit and outbox effects.

## Work reconciliation

Every interpretation run performs two passes over new evidence:

```mermaid
flowchart TD
    E[New evidence] --> C[Context pass]
    E --> W[Work-board pass]
    C --> CF[Atomic durable facts]
    C --> CD[Structured Markdown files]
    W --> M{Matches an accepted task?}
    M -->|yes| TC[Propose complete task snapshot]
    M -->|no, explicit open commitment| TN[Propose new task]
    M -->|ambiguous or only discussion| WA[Abstain]
    TC --> Q{Completion evidence sufficient?}
    Q -->|yes| DONE[May propose done]
    Q -->|no| OPEN[Keep planned, active, blocked, or review]
```

Plans and discussions remain open work. A task becomes `done` only when configured delivery evidence and corroboration support the intended outcome. Context files preserve the primary source-authored architecture diagram when prose compression would erase important relationships.

## Agent write loop

```text
context_get -> context_read/source_read/work_search -> do work -> work_report
           -> proposal_create/task_create_proposal -> proposal_status
           -> accepted revision appears in the next context_get
```

Pending proposals are not accepted state. An escalated proposal is a rare unresolved exception, not a routine review queue.

## Language

**Company Memory**:
The durable, permission-aware history of accepted people, work, context, decisions, relationships, and evidence lineage that Panini maintains for an organization.
_Avoid_: Context dump, document corpus, task board

**Context Pack**:
An ephemeral, bounded projection of Company Memory compiled for one employee principal, Agent Profile, scope, objective, time, and budget.
_Avoid_: Company Memory, global prompt, search results

**Working Memory**:
The private session state, transcript, scratchpad, tool output, and unfinished reasoning retained by an employee's local Harness unless explicitly contributed under company policy.
_Avoid_: Company Memory, accepted context

**Workstream**:
A coherent track or mini-project inside a Project that groups related Tasks toward a defined outcome.
_Avoid_: Tag, Task list, arbitrary folder

**Coverage Window**:
The time range and source realm for which Panini has successfully observed authorized material, including any known gaps or exclusions.
_Avoid_: Complete history, retention period

**Verification Chain**:
The trace from a returned context fragment or interface field through its accepted revision, decision, proposal, Evidence Items, and Source Observations.
_Avoid_: Citation count, confidence score

**Source Observation**:
An immutable receipt of something observed in an external work system at a particular time.
_Avoid_: Truth, update, fact

**Evidence Episode**:
A bounded set of Source Observations joined by explicit source-native relationships, such as a Slack thread, GitHub pull request, commit, linked document, or accepted work reference, and interpreted together when one observation depends on the others.
_Avoid_: Arbitrary batch, embedding cluster, complete history

**Baseline Claim**:
An imported statement of intended work or organizational context that may be stale, such as a Notion task row.
_Avoid_: Source of truth, authoritative task

**Evidence Item**:
A Source Observation eligible to support or contradict a claim about work, such as a reviewed code change, agent outcome, or selected Slack discussion.
_Avoid_: Proof, activity log

**Interpretation Run**:
One bounded attempt to compare new Evidence Items with current work state and produce Findings.
_Avoid_: Sync, reasoning session

**Finding**:
A typed, evidence-citing model conclusion proposing a task creation, task change, Context File upsert, Atomic Fact upsert, or abstention.
_Avoid_: Decision, mutation, fact

**Corroboration**:
Support for the same Finding from meaningfully different Evidence Items or source classes.
_Avoid_: Duplicate message, repeated claim

**Work Proposal**:
A requested task creation, task change, or context change that has not yet become accepted state. In autonomous mode it waits for Panini's adjudication, not routine human review.
_Avoid_: Update, completed task

**Autonomous Adjudication**:
Panini's audited decision over a Work Proposal using active Evidence Items, their claim times, current accepted state, revision history, and related proposals. It yields approval, rejection, supersession, or rare escalation.
_Avoid_: Direct model write, auto-approval, review shortcut

**Evidence Time**:
The `occurredAt` time at which a source claims information held. `fetchedAt` and `receivedAt` describe transport, while `appliedAt` records when Panini accepted a revision.
_Avoid_: Ingestion order, latest row wins

**Supersession**:
An adjudication that preserves a Work Proposal in history but retires it because the same change is already reflected or later evidence or accepted history has overtaken it.
_Avoid_: Rejection, deletion, overwrite

**Escalation**:
A rare unresolved Work Proposal that requires a person because credible evidence conflicts or a materially sensitive ambiguity cannot be resolved safely. Low-quality or unsupported claims are rejected rather than escalated.
_Avoid_: Review queue, uncertainty, model failure

**Accepted Work State**:
The latest accepted, versioned representation of a task after an audited autonomous or authorized decision.
_Avoid_: Notion state, agent state

**Context Workspace**:
The provenance-backed space for company and Project knowledge, including standalone facts and long-lived documents, organized by Context Paths.
_Avoid_: Memory blob, prompt, context dump

**Context Path**:
A slash-separated location that places an Atomic Fact or Context File inside the Context Workspace; it is not the item's identity or authority.
_Avoid_: Tag, source URL

**Project Folder**:
The part of the Context Workspace where a Project's living architecture, plans, work notes, decisions, and other documents are organized. Its ownership comes from the Project relationship, not the folder name alone.
_Avoid_: Separate memory, task list

**Atomic Fact**:
One accepted standalone claim with a typed scalar value and evidence lineage. It must not combine multiple independently changeable claims.
_Avoid_: Note, paragraph, summary

**Context File**:
An enduring, versioned long-form document at a Context Path that preserves ideas, architecture, plans, work notes, or decisions that should not be flattened into facts. Being available as a document does not make every statement in it a verified fact.
_Avoid_: Memory, blob, fact

**Synthesized Context File**:
A Panini-maintained working Context File assembled from multiple cited Source Observations, accepted claims, code evidence, and earlier documents. Every section retains evidence lineage and distinguishes implemented, decided, proposed, disputed, and outdated material.
_Avoid_: Source document, verified truth, generated summary

**Document State**:
The standing of a Context File as a working draft, accepted reference, decision record, or archived document; it is separate from the truth status of claims inside it.
_Avoid_: Fact confidence, task status

**Workspace Member**:
A person who owns Agent Profiles and is accountable for the access granted to them.
_Avoid_: Agent owner, API user

**Agent Profile**:
A revocable, member-owned identity and capability bundle for one external agent configuration. A member may own many Agent Profiles.
_Avoid_: Running agent, worker, bot process

**Harness**:
The external agent runtime that uses an Agent Profile to connect, such as Codex, Claude Code, or Pi.
_Avoid_: Agent Profile, model

**Capability Grant**:
An explicit class of Panini operations available to an Agent Profile. Write grants create evidence or proposals and never bypass Autonomous Adjudication.
_Avoid_: Role, admin access

**Enrollment Secret**:
A revocable secret revealed once when a Harness is connected to an Agent Profile.
_Avoid_: Password, reusable setup link

**Abstention**:
An explicit result that the available Evidence Items are insufficient, contradictory, or unsafe to turn into a proposal.
_Avoid_: Failure, empty response

**Completion Evidence**:
Evidence that the intended outcome is delivered or verified, rather than merely attempted or discussed.
_Avoid_: Activity, commit exists, agent says done
