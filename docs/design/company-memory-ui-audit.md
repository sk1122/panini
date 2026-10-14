# Company memory UI audit

Date: 2026-09-20

Status: Implemented and running on the data-backed local app at port 4141.

Panini should help someone understand what the company knows, how that knowledge changed, how work progressed, and why decisions were made. The current UI repeatedly exposes the machinery used to establish that knowledge.

This audit began with the local UI source and `PRODUCT.md`. The authenticated app on port 4141 was inspected before and after the update. The revised app now reads the existing Postgres data; the Postgres container and volume were left in place. Populated Company, Projects, Knowledge, and History screens were checked in the browser after deployment.

## Implemented in this pass

- The main navigation is Company, Work, Knowledge, History, and People. Work holds Projects, Workstreams, and Tasks. Sources, Review, Agents, and Integrations sit under More. System controls moved to Integrations; navigation counts, the decorative image, and repeated architecture copy were removed from the main reading path.
- Company leads with projects, blocked work, and recent accepted changes. It keeps the source coverage caveat visible, with details available on demand.
- History now requests only accepted task and knowledge revisions for the ordinary timeline. It shows changed fields, a recorded rationale when present, and links to the current task or knowledge entry. The old all-events API remains available for technical consumers. Knowledge revisions can show the earlier document content.
- Knowledge search presents readable entries and original sources. Raw IDs, hashes, JSON, and provenance details are moved behind disclosure controls or removed from ordinary cards. People show named earlier tasks where the current board resolves them.

The full test suite passed (137 tests, 7 skipped), and the TypeScript build passed. The data-backed app at port 4141 showed 3 projects, 128 knowledge entries, and 215 history changes during the final check. This confirms the main populated screens, not every possible record or workflow.

Still missing: period/project/person filters in History, a true as-of view across the company, sourced project milestones and decisions, and reliable distinction between a proposal's processing rationale and an actual business reason. The new History labels the rationale as a recorded note; it does not infer a reason. `appliedAt` remains a recorded time rather than a proven business effective date.

## Findings

| Priority | Surface | Current implementation | Proposed experience |
| --- | --- | --- | --- |
| First | Company history | Mixes task revisions, context revisions, source observations, and administrative events. Summaries are strings such as `Context revision 3: accepted`. Filters are database event types. | A dated account of decisions, changed plans, responsibility changes, delivered outcomes, and setbacks. Filter by period, project, person, and kind of company change. Open each item to see its context and sources. |
| First | Context history | The revision list displays a version, actor, and timestamp. It does not display the previous and new content or the recorded reason. | Show what we believed or required before, what changed, when it applied, and the recorded reason. Let users read the entry as it stood at an earlier date. |
| First | Evidence chain | Context and task details contain prominent "Evidence lineage", "Accepted revisions", "Source reference", and receipt metadata sections. | Lead with current context and its history. Keep "View sources" and deeper verification details available from each change. Preserve the chain underneath. |
| First | IDs and hashes | History prints shortened proposal IDs; audit rows print target IDs; source views print references and hash prefixes; identity and dependency labels can fall back to raw IDs. | Show document titles, channel names, people, and task names. Put internal identifiers behind technical details/copy actions. Keep useful external references such as PR numbers. If a name cannot be resolved, state that plainly without inventing one. |
| First | Company overview | Leads with counts of "Current memory", "Needs review", and "Outside interval". Recent decisions are rendered from audit action names. | Lead with current priorities, meaningful changes during a selected period, milestones reached, blockers, and actual company decisions. Keep incomplete coverage visible in a concise note. |
| Next | Projects and workstreams | Project cards emphasize accepted-task counts and resolved/unresolved links. Missing outcomes expose implementation copy about projections and future authoring. | Show purpose, owner, current position, milestones, changed scope, related decisions, and project history. Express dependencies as named work that is waiting on other work. |
| Next | People | Historical contribution is a count of historical tasks and linked memory items. Provider identities and agent profiles receive substantial space. | Let users browse a person's responsibilities over time, named contributions, decisions, and handoffs. Keep identity linking and agent administration in details. Do not interpret activity counts as performance. |
| First | Search | Ordinary context search renders an "Agent context pack", an "Accepted-state reading guide", a "Budgeted context catalog", provider names, candidate counts, and character budgets. | Return relevant company knowledge and source links for the person's question. Keep agent-pack inspection and retrieval diagnostics in an explicit agent/developer view. |
| First | System language and controls | Repeated copy includes "Adjudicator off", "Models propose; the audited policy gate decides", "Panini adjudicates cited findings", PostgreSQL/Jev status, and a conditional "Analyze evidence" action. | Explain the consequence for the user: sources updated, new material still processing, information awaiting review, or a known gap. Move engine controls and storage/ranking details to administration. |
| Next | Exceptions | Labels include "Upsert atomic fact", "Stale base", "Rebase", "Supersede", and "Autonomous decision queued". Changed fields are rendered from object keys and values. | Present the conflicting statements, their dates and sources, the currently recorded position, and the precise decision needed. Preserve action semantics while using plain language. Routine processing need not be an exception. |
| Next | Source reading | The evidence panel defaults to raw JSON. Source documents display an "Evidence boundary" instruction block, content hashes, and section character counts. | Render readable source content with its title, author when available, original date, and original link. A short state label can explain that a source has not been adopted as company knowledge. Raw payloads and hashes belong in technical details. |
| Later | Context organization and chrome | The page leads with a decorative observatory image, fact/file/source counts, and a path tree. Every navigation item carries a count. | Prioritize company subjects such as decisions, plans, policies, architecture, and research, with useful recent changes. Retain folder browsing where useful. Reserve badges for information that needs attention. |

## Concrete code locations

- History rendering and proposal IDs: `src/http/ui-script.ts:273`; history projection and mechanical summaries: `src/domain/team-ledger.ts:345`.
- Context history, evidence sections, and source references: `src/http/ui-script.ts:425` and `src/http/ui-script.ts:432`.
- Company metrics, audit decisions, and source diagnostics: `src/http/ui-script.ts:220`; decision selection: `src/domain/team-ledger.ts:289`.
- Project cards and implementation placeholders: `src/http/ui-script.ts:198`; workstream cards: `src/http/ui-script.ts:260`.
- People and identity fallbacks: `src/http/ui-script.ts:248`.
- Search results, ID fallbacks, and retrieval manifest: `src/http/ui-script.ts:656`.
- Engine status and retrieval implementation labels: `src/http/ui-script.ts:691`.
- Exceptions and technical actions: `src/http/ui-script.ts:148`.
- Source hashes, instructions, and section metadata: `src/http/ui-script.ts:336`.
- Evidence table and raw JSON detail: `src/http/ui-script.ts:515`.
- Audit target IDs: `src/http/ui-script.ts:622`.
- Task version badges and pending-change copy: `src/http/ui-script.ts:117`; task history: `src/http/ui-script.ts:636`.
- Navigation counts and permanent policy explanation: `src/http/ui.ts:37` and `src/http/ui.ts:56`.
- Company, Work, Projects, Context, and History headings and banners: `src/http/ui.ts:73` through `src/http/ui.ts:161`.

## What history should contain

Each meaningful change should answer:

1. **What changed?** The actual old and new values or a readable content difference.
2. **Why?** The recorded business reason, linked to its supporting material. If none was recorded, say so.
3. **When?** When the change took effect. Show when Panini recorded it separately when relevant, especially for later imports or corrections.
4. **Who?** The responsible person or actual approving authority. Distinguish the person who made a company decision from the system that recorded it.
5. **What does it relate to?** Named projects, work, people, and other context, with navigation.
6. **What supports it?** Readable source links, with deeper verification available on demand.

Illustrative example only, not a claim about this workspace:

> **Launch moved from 1 October to 15 October**
>
> The release plan changed after an unresolved payment issue was recorded in the launch review. Open the previous plan, updated plan, and related work. View the original review note for the recorded reason.

This needs actual previous/new values and a recorded reason. A model must not invent the explanation to make the timeline feel complete. Company progress should include reversals and blocked outcomes as well as achievements.

## Existing foundations and missing work

The task and context revision types already retain `previous`, `current`, `proposalId`, `appliedAt`, and `appliedBy` (`src/domain/types.ts:471` and `src/domain/types.ts:528`). Proposals retain a rationale, decision note, decision maker, and evidence references (`src/domain/types.ts:433`). These are useful foundations for readable change history.

The current history projection discards previous/new content and does not join the proposal reason into the displayed event. It also maps revision `appliedAt` to `occurredAt`. Therefore, richer history requires projection/data work as well as new labels. A recorded import or approval time must not be presented as the date the underlying company decision happened.

Do not assume every proposal rationale explains a company decision: some are import or processing descriptions. Do not turn every task revision into a company milestone. Broader project, responsibility, and milestone history needs source support and may require additional domain data.

## Smallest useful sequence

1. **Remove exposed internals from normal reading.** Hide IDs, hashes, raw payloads, retrieval diagnostics, and repeated architecture explanations behind details or administration. Keep understandable review, stale, revoked, and coverage states visible where they affect the answer.
2. **Make existing history readable.** Use stored previous/current revisions, resolve names, join recorded reasons and sources, and link related work. Separate company changes from processing/access logs. Add time and subject filters.
3. **Bring company progress to the foreground.** Build the Company overview, project history, and people's contribution history from those same records. Offer current and historical views without creating a separate source of truth.

The success criterion is that an employee can open a topic or project and understand its current position, the path that led there, and the material supporting it without having to interpret Panini's storage or AI pipeline.
