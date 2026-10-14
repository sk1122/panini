# Panini: first-principles research on company state

Date: 2026-09-30

Status: research synthesis, not an implementation design

## Executive conclusion

Panini should not be defined as enterprise search, a task extractor, a knowledge graph, a meeting-notes tool, or an agent memory.

Its intended job is:

> Continuously reconstruct the evidence-backed state of a company’s work from scattered observations, preserve how that state changed over time, determine what is still open versus actually fulfilled, and serve the smallest correct context to people and agents.

That breaks into four distinct promises:

1. **Recall:** find the relevant evidence across sources.
2. **Reconstruction:** decide which evidence refers to the same real-world work.
3. **Reconciliation:** derive the best-supported state without hiding conflict or uncertainty.
4. **Use:** present and retrieve that state as tasks, projects, decisions, memories, working documents, timelines, and agent context.

Most competitors are strong at one or two of these. None of the products reviewed publicly demonstrates the full chain, especially evidence-based work fulfillment inferred across disconnected tools.

## The end goal, stated precisely

For every meaningful unit of company work, Panini should be able to answer:

- What is it?
- Why does it exist?
- Who owns or participates in it?
- What is its current state?
- What changed, when, and because of which observation?
- What decisions, artifacts, experiments, code changes, deployments, and outcomes belong to it?
- Is it merely discussed, claimed complete, implemented, tested, deployed, observed in production, accepted, or genuinely fulfilled?
- Which evidence supports each answer?
- What is missing, contradictory, stale, or inaccessible?
- What did the company believe at an earlier time, and what do we now believe was true at that earlier time?

The desired product is therefore an **evidence-backed, temporal company-state system**.

It must represent both short-lived work and long-lived knowledge:

- tasks, blockers, reviews, follow-ups, experiments, incidents, and releases;
- projects, initiatives, systems, products, teams, owners, and goals;
- decisions and superseded decisions;
- architecture, operational knowledge, research, and other working documents;
- source records and the provenance of every derived statement.

Long documents are not always supplied as clean source documents. Panini may need to maintain a working document synthesized from Slack discussions, code, pull requests, experiments, and older documents. Such a document is a **derived view**, not a new source of truth. Every material statement must remain traceable to its underlying evidence, and later corrections must update the affected statements without erasing history.

## First-principles vocabulary

These distinctions prevent the system from collapsing different kinds of truth into one table.

| Concept | Meaning |
|---|---|
| Observation | An immutable thing Panini received: message, commit, PR event, document revision, meeting transcript, deployment event, or tracker update. |
| Claim | A small assertion extracted from an observation, such as “the causal worker was tested.” It may be true, false, incomplete, quoted, hypothetical, or stale. |
| Event | A proposed real-world occurrence, such as a test run, merge, deployment, review, or decision. Multiple observations may describe one event. |
| Work object | A continuing thing whose state changes: task, project, experiment, incident, decision, system, document, or release. |
| State | A time-bounded, evidence-backed interpretation of a work object. State is derived; it is not identical to the latest sentence seen. |
| Fulfillment | Satisfaction of the work object’s acceptance conditions, supported by appropriate evidence. A status label or sentence saying “done” is not sufficient by itself. |
| Provenance | The observations and transformations that explain where a derived value came from and why it exists. |
| Coverage | Which sources, identities, repositories, branches, channels, time ranges, and event types Panini could actually observe. |

Object-centric event logs are a useful conceptual precedent: one event can concern several objects, an object can change attributes over time, and event-object and object-object relationships can have explicit roles. OCEL 2.0 formalizes those properties. It does not solve language understanding, identity resolution, or fulfillment, but it shows why “one source event becomes one task” is the wrong abstraction. [OCEL 2.0](https://www.ocel-standard.org/)

## Three kinds of state that must not be conflated

1. **Declared state:** what a person or tool says, for example “tested” or a Jira status of Done.
2. **Observed state:** what the collected evidence directly shows, for example a test run completed or a commit exists on a branch.
3. **Accepted operational state:** the company’s current best-supported interpretation after applying task-specific completion rules and resolving conflicts.

A fourth category, **unknown**, is essential. Absence of evidence can mean the work did not happen, but it can also mean the relevant source, branch, private channel, deployment environment, or offline decision was not observed.

“Correct for the whole company” can only mean correct relative to an explicit coverage envelope. The product must show gaps instead of silently converting them into negative facts.

## Time is two-dimensional

Company history needs at least two clocks:

- **Valid time:** when something was true in the company’s world.
- **Recorded time:** when Panini learned or stored it.

This is the classic bitemporal distinction. It is necessary for late-arriving Slack history, backfilled GitHub events, edited documents, corrected identities, and retrospective human decisions. Without both clocks, a correction rewrites history and Panini cannot answer both:

- “What did Panini believe on September 20?”
- “Given everything known now, what was actually true on September 20?”

[Snodgrass and Ahn on valid and transaction time](https://www2.cs.arizona.edu/~rts/pubs/TODS87.pdf)

## The hardest problems

### 1. Cross-source identity

The same project, task, event, person, or artifact is described differently across tools. A Slack message may use a nickname; a branch may use a ticket-like slug that never appears in Slack; a meeting may say “the causal worker”; a commit may touch the relevant code without mentioning the project.

Cross-document event-coreference research defines event identity using the event action plus participants, time, and location/context. It also shows that signals vary across datasets and that superficially similar mentions are not necessarily the same real-world event. [Generalizing cross-document event coreference](https://direct.mit.edu/coli/article/47/3/575/102774/Generalizing-Cross-Document-Event-Coreference)

For company work, the useful identity signals expand to:

- people and teams;
- repository, branch, files, and code symbols;
- project and task candidates;
- temporal proximity and ordering;
- shared vocabulary, customers, systems, and deliverables;
- quoted text, links, thread ancestry, mentions, and notification metadata;
- causal compatibility: whether one observation can plausibly be a continuation of another.

The system must allow unresolved and ambiguous identity. A confident wrong merge corrupts every later task, document, and retrieval result.

### 2. Event reconstruction

Sources contain mentions of events, not necessarily the events themselves. “We tested it,” a CI run, a GitHub notification, and a later request to review results may be four observations of one test-and-review episode—or unrelated work with similar language.

Event reconstruction requires candidate retrieval followed by identity judgment. Stuffing the entire corpus into a long prompt is not reliable: long-context models can miss relevant information depending on where it appears. [Lost in the Middle](https://aclanthology.org/2024.tacl-1.9/)

### 3. State transitions

Panini must understand transitions, not just store snapshots:

- proposed → accepted or rejected;
- planned → active → blocked → resumed;
- implemented → tested → reviewed → deployed → observed → accepted;
- current decision → superseded decision;
- current document section → revised or contradicted section.

This resembles process mining, where event logs are used to discover processes and conformance checking diagnoses differences between observed and expected behavior. Panini’s problem is harder because the event log itself must first be reconstructed from unstructured and incomplete evidence. [Process discovery and conformance checking](https://doi.org/10.3233/FI-2014-1006)

### 4. Fulfillment, not status

Completion semantics are work-specific:

- A code task may require merged code plus passing relevant checks.
- A production fix may require deployment plus a production observation.
- An experiment may require results, methodology, and a review decision.
- A research task may require an artifact and evidence that it answers the requested question.
- A human review task may remain open even after the artifact under review is complete.

Therefore, completion cannot be inferred from sentiment, “looks good,” a closed PR, a commit, or a tracker status alone. Each work type needs explicit acceptance conditions and evidence classes. The system should distinguish **claim of completion**, **technical completion**, **deployment**, **outcome**, and **human acceptance**.

### 5. Conflicting and unequal evidence

Evidence authority is predicate-specific:

- Git can strongly support “code exists at commit X,” but not “it is deployed.”
- CI can support “these checks passed,” but not “all requirements are met.”
- a deployment system can support “version X was deployed,” but not “users received the intended outcome.”
- a Slack statement can support intent or acceptance, but may be mistaken about runtime state.
- an issue tracker can support declared workflow state, but may be stale.

Truth-discovery research tries to infer truth from conflicting providers and source reliability, but it also identifies “no-truth” cases where the correct answer is absent from every source. A single global trust score per source is unsuitable here; authority depends on the claim type and context. [Modeling Truth Existence in Truth Discovery](https://pmc.ncbi.nlm.nih.gov/articles/PMC4688015/) and [Domain-Aware Multi-Truth Discovery](https://www.vldb.org/pvldb/vol11/p635-lin.pdf)

### 6. Faithful synthesis

Generated summaries and documents can add unsupported material. Research on abstractive summarization finds substantial hallucinated content and shows that ordinary similarity metrics do not measure factual consistency. [Maynez et al.](https://aclanthology.org/2020.acl-main.173/) and [Kryscinski et al.](https://aclanthology.org/2020.emnlp-main.750/)

A long-running architecture document therefore cannot be a periodically regenerated blob. Each material claim must retain support, contradictions, validity, and revision history. Prose is a projection over evidence-backed claims, not the primary truth store.

### 7. Provenance

Database provenance research distinguishes **where** a derived value was copied from and **why** that value exists. Panini needs both. A source link alone is insufficient if it does not explain why that source supports a status or decision. [Why and Where: A Characterization of Data Provenance](https://www.pure.ed.ac.uk/ws/files/16509989/Why_and_Where_A_Characterization_of_Data_Provenance.pdf)

### 8. Organizational memory is distributed

Company memory is not just stored text. It exists across people, tools, routines, and knowledge of “who knows what.” Organizational-memory research cautions against treating a company as a single symbolic memory store, while transactive-memory research emphasizes expertise directories and retrieval coordination. [Ackerman and Halverson](https://web.eecs.umich.edu/~ackerm/pub/98b24/cscw98.om.html)

Panini therefore needs to represent ownership, participation, expertise, and the social context of evidence—not only documents and facts.

## The corrected GitHub example

Suppose a Slack thread says:

> “The causal worker is tested, there are some good results, please review it.”

There may be no GitHub URL in that thread. The related notification may be in another channel, the commit may be on a non-default branch, or no GitHub event may have been ingested at all.

The system cannot convert a nonexistent URL into a stable identifier. It must treat the Slack text as a partial event mention, retrieve plausible work/event candidates using people, topic, time, repository, branch, files, code symbols, and prior project state, and then judge whether the observations refer to the same real-world episode. If coverage does not contain the relevant branch or event, the correct result is an unresolved review request with a visible evidence gap—not a fabricated link and not a false completed task.

This is a cross-document event-identity problem under incomplete observability, not URL normalization. :codex-annotation{index="1"}

## Competitor landscape

### 1. Enterprise search and context platforms

**Glean**

- Public docs describe connectors that ingest, map, and normalize content, activity, and permissions, then build a search index and enterprise graph used for search and RAG.
- Customers include large, distributed enterprises such as Booking.com, Zillow, Ericsson, TIME, and Databricks. The primary value is finding and using company knowledge across many systems.
- Strengths relevant to Panini: connector depth, permissions, ranking, people/content relationships, citations, and enterprise adoption.
- Publicly demonstrated boundary: its core public story is search, answers, and agents grounded in indexed enterprise context. That is not the same as maintaining an auditable canonical lifecycle for implicitly described work or proving fulfillment.

Sources: [Glean connector architecture](https://docs.glean.com/connectors/connectors-power-glean), [customer stories](https://www.glean.com/resources/customer-stories)

**Atlassian Rovo and Teamwork Graph**

- Rovo connects Jira, Confluence, code, and third-party sources into search, chat, agents, and automations. Connectors may sync and index, query live, or use Smart Link context. Permissions come from source systems.
- Its strongest position is Atlassian-native work: explicit Jira objects plus connected knowledge and code. Customers shown publicly include Cisco, Mercedes-Benz, and Intermedia.
- Strengths relevant to Panini: a graph that already contains explicit work objects, code-aware tools, permission-aware context, write-back, and agents embedded where work happens.
- Boundary: the graph is strongest when Jira/Confluence already encode the object and workflow. Public docs do not establish reliable reconstruction and fulfillment of work that was never explicitly tracked.

Sources: [Rovo overview](https://support.atlassian.com/rovo/docs/what-is-rovo/), [connector types](https://support.atlassian.com/rovo/docs/manage-rovo-connectors/), [Rovo Studio](https://www.atlassian.com/software/rovo/studio)

**Microsoft 365 Copilot Search**

- Uses Microsoft Graph, the Microsoft 365 knowledge index, behavioral and organizational signals, and synced or live federated connectors.
- Best suited to Microsoft-heavy enterprises that need permission-aware search and assistance across email, files, chats, meetings, and line-of-business data.
- Strengths relevant to Panini: identity, access control, governance, broad enterprise content, and both indexed and live retrieval.
- Boundary: connector content is made searchable and reasoned over. The public architecture is not a temporal evidence ledger that derives accepted work state.

Sources: [Copilot Search FAQ](https://learn.microsoft.com/en-us/microsoft-365/copilot/microsoft-365-copilot-search-faq), [Copilot connector models](https://learn.microsoft.com/en-us/microsoft-365/copilot/extensibility/overview-copilot-connector)

**Notion Enterprise Search and Slack Enterprise Search**

- Both retrieve and answer over connected applications while respecting permissions and citing sources.
- Notion uses embeddings stored in a vector database and periodically synchronized permissions. Slack makes conversations and connected apps queryable in the communication surface.
- Their natural customers are teams already centered on Notion or Slack and seeking lower-friction knowledge access.
- Strengths: adoption through an existing work surface, citations, semantic retrieval, and permissions.
- Boundary: search results and generated answers remain query-time views. They do not, by themselves, become an independently reconciled history of company work.

Sources: [Notion search architecture](https://www.notion.com/help/enterprise-search-security-and-privacy-practices), [Slack enterprise search](https://slack.com/help/articles/38693462131219-Search-across-your-applications-with-enterprise-search)

### 2. Explicit work systems

**Linear, Jira, and Asana**

- Linear models issues, projects, initiatives, cycles, statuses, milestones, owners, and updates. Asana’s Work Graph models cross-functional tasks, projects, portfolios, goals, and one-to-many relationships.
- Their customers are teams willing to make the work system authoritative by creating and updating work objects. Linear is especially strong with product and engineering teams; Asana spans cross-functional enterprise work.
- Strengths relevant to Panini: clear work identity, state machines, ownership, hierarchy, dependencies, and reporting.
- Critical boundary: their correctness depends on adoption and maintenance. Customer stories explicitly describe moving work out of random docs, Slack, and email into the tracker. They solve scattered work partly by changing human behavior; Panini is trying to reconstruct work even when that discipline is absent.

Sources: [Linear conceptual model](https://linear.app/docs/conceptual-model), [Expo’s Linear adoption](https://linear.app/customers/expo), [Asana Work Graph](https://asana.com/resources/work-graph), [Danone case study](https://asana.com/case-study/danone)

### 3. Operational ontology and digital-twin systems

**Palantir Foundry Ontology**

- Represents real-world objects, relations, properties, logic, actions, security, and operational write-back over integrated data sources.
- Serves large, complex, often mission-critical organizations in industry, healthcare, government, defense, and logistics.
- This is the closest conceptual competitor to a living company model. It treats an ontology as an operational system, not merely a semantic search graph.
- Boundary: its public model is configured around defined object types, links, source mappings, functions, and actions. Panini’s distinctive problem is automatically discovering and maintaining soft, ambiguous knowledge-work state from natural-language and code observations with a much lighter deployment and operating model.

Sources: [Ontology system](https://www.palantir.com/docs/foundry/architecture-center/ontology-system), [Ontology objects and actions](https://www.palantir.com/explore/platforms/foundry/ontology/)

### 4. Temporal agent memory

**Zep/Graphiti, Mem0, and Letta**

- Graphiti ingests episodes, extracts entities and relationships, attaches time and provenance, invalidates outdated facts, and supports hybrid semantic, keyword, and graph retrieval.
- Mem0 exposes add, search, update, delete, metadata, user, agent, app, and run scopes around memory items.
- Letta keeps persistent memory blocks directly in an agent’s context and offers archival/retrieved memory.
- Their primary customers are developers building agents that need persistent user, account, or application context.
- Strengths relevant to Panini: incremental memory updates, temporal facts, source episodes, scoped identities, and retrieval.
- Boundary: generic agent memory does not know company-specific work identity, acceptance criteria, evidence authority, or what counts as fulfillment. A temporally invalidated fact is not the same as a verified project state.

Sources: [Graphiti overview](https://help.getzep.com/graph-overview), [Mem0 API](https://github.com/mem0ai/mem0/blob/main/skills/mem0/references/api-reference.md), [Letta memory blocks](https://docs.letta.com/v1-sdk/memory/memory-blocks)

### 5. Meeting memory

**Granola**

- Produces structured meeting notes from transcripts and user notes, distinguishes user-authored from AI-authored text, and lets users trace generated notes to exact transcript evidence.
- It serves meeting-heavy individuals and teams that want high-quality recall and synthesis without a visible meeting bot.
- Strengths relevant to Panini: narrow-scope capture, human guidance, source zoom-in, and strong note experience.
- Boundary: meeting memory covers one observation class. It does not reconstruct the full lifecycle across chat, documents, code, trackers, deployments, and production signals.

Sources: [Granola product design](https://www.granola.ai/blog/announcement), [Granola Chat scopes](https://help.granola.ai/article/chatting-with-your-meetings)

## Competitive gap

The market contains:

- systems that **find source material**;
- systems where people **declare and maintain work state**;
- systems that **model configured operational objects**;
- systems that **remember evolving agent facts**;
- systems that **summarize one source class**.

Panini’s potential category is the missing combination:

> Reconstruct and maintain an evidence-backed, temporal model of knowledge work when the company did not consistently encode that model itself.

That is also why this problem is harder than every individual category above. Panini cannot assume either a clean source of truth or a fixed schema for all work.

## Who the customer is

### Best initial customer profile

This is an inference from the problem and competitor behavior, not a confirmed market result:

- roughly 20–500-person technical, product, research, consulting, or operations-heavy companies;
- work is spread across Slack or Teams, GitHub or GitLab, Notion or Drive, meetings, and a partially maintained tracker;
- costly coordination failures are common: stale status, lost decisions, duplicated work, onboarding delays, missed review requests, and unclear ownership;
- the company has enough data to reconstruct work but not enough discipline or staff to maintain a comprehensive manual system;
- it increasingly uses AI agents and needs governed, current context rather than raw search results.

### Buyers

- founder, COO, CTO, or chief of staff in a smaller company;
- head of engineering, product operations, research operations, or knowledge management;
- enterprise IT or AI platform owner later, once permissions, governance, and audit are mature.

### Users

- an individual contributor asking, “What happened, what do I need to do, and what context matters?”
- a manager asking, “What is actually moving, blocked, stale, or falsely marked complete?”
- a new employee asking for a reliable project history and working document;
- an AI agent asking for scoped, current state and the evidence needed to act safely;
- an auditor or operator asking how and why a state changed.

## Important quirks and failure modes

### Observation gaps

- repositories or non-default branches are not connected;
- private channels or direct messages are inaccessible;
- deployments, experiments, or customer outcomes happen in unconnected systems;
- offline decisions are never written down;
- a connector is stale, rate-limited, revoked, or only partially backfilled.

### Language ambiguity

- pronouns and shorthand depend on thread or social context;
- sarcasm, negation, quotes, hypotheticals, and plans resemble assertions;
- “done,” “tested,” “shipped,” and “works” mean different things to different teams;
- the same name refers to a project, service, repository, feature, or customer;
- projects split, merge, rename, or are revived.

### Time and ordering

- messages arrive late or are edited;
- commit time, author time, ingestion time, merge time, deploy time, and observation time differ;
- a later document may describe an earlier event;
- backfills can incorrectly appear newer than live data;
- clock skew and timezone errors change event order.

### Evidence dependence

- ten Slack messages repeating one announcement are not ten independent confirmations;
- a GitHub notification and the PR it announces are the same underlying evidence chain;
- generated Panini summaries can be re-ingested and falsely amplify themselves;
- copied outdated docs can outvote a newer authoritative change if evidence independence is ignored.

### State and fulfillment

- a merged PR may not be deployed;
- a deployment may be rolled back;
- a passing test may cover the wrong behavior;
- a positive experiment result may still await review;
- the artifact can be complete while the human review task remains open;
- a project may be canceled, superseded, or intentionally paused rather than incomplete.

### Documents and memory

- a synthesized document can sound coherent while combining incompatible versions;
- updating a whole document can erase valid historical sections;
- retrieval may select an eloquent old design instead of the current implementation;
- a fact can be obsolete while the source document remains historically important;
- people need both current guidance and the path by which it became current.

### Identity and permissions

- one person has different emails or usernames across systems;
- bots, service accounts, and AI agents act for people or teams;
- a user may be allowed to see a derived task title but not the private evidence that produced it;
- permission changes must affect both retrieval and derived views;
- company, user, team, and agent memory scopes must not bleed into one another.

### Model behavior

- LLM extraction is nondeterministic and can invent links or normalize away uncertainty;
- embeddings retrieve semantically similar but non-identical work;
- rerankers can overfit topical similarity;
- a hard classification veto can delete rare but important evidence;
- model or prompt upgrades can silently reinterpret old observations;
- long prompts do not guarantee that relevant evidence is used.

### Human and organizational concerns

- inferred activity can feel like employee surveillance;
- “the system says” can suppress legitimate disagreement;
- owners need a correction mechanism and visibility into why a conclusion exists;
- local team language and acceptance rules vary;
- automation can create tasks that no one has agreed to own.

## What “correct and complete” should mean

Panini should never claim metaphysical truth. It can claim a measurable contract:

### Correct

- each material state field is supported by relevant evidence;
- incompatible claims are visible or resolved by an explicit rule;
- entity and event merges are accurate;
- current and historical answers respect time;
- generated documents do not add unsupported claims;
- access controls are preserved.

### Complete

- all eligible observations in the declared coverage envelope were processed;
- no in-scope source, branch, channel, or time range is silently missing;
- expected work types are represented;
- unresolved observations and gaps are counted and inspectable.

### Fulfilled

- the work-specific acceptance conditions are satisfied;
- the evidence class is appropriate to the claim;
- dependent human review or operational outcome is separately represented;
- rollback, rejection, supersession, or reopening can reverse the current state without deleting history.

## Evaluation dimensions

A single “quality score” would hide the main failure modes. The product needs a scorecard:

1. **Coverage:** eligible source observations processed, with gaps by source and time.
2. **Extraction recall and precision:** material claims and events found without noise.
3. **Identity precision and recall:** same-work observations linked; similar-but-different work kept separate.
4. **Task/project coverage:** gold work objects represented with stable identity.
5. **Current-state accuracy:** field-level agreement with a human-audited current picture.
6. **Fulfillment precision:** items marked fulfilled that truly meet acceptance criteria.
7. **Historical accuracy:** correct state as-of a past valid time and as-known-at recorded time.
8. **Document faithfulness:** every material statement supported; contradictions and outdated sections handled.
9. **Provenance quality:** users can see where and why each conclusion exists.
10. **Correction behavior:** wrong merges, statuses, and facts can be corrected without corrupting history.
11. **Retrieval usefulness:** people and agents receive the right evidence and current state for a task.
12. **Permission safety:** zero unauthorized source or derived-information leakage.
13. **Freshness and cost:** updates converge within the target latency and operating budget.

Evaluation sets must include negative and ambiguous cases, not only known positive tasks. Particularly important cases are:

- same topic, different task;
- same task, no shared URL or identifier;
- work on a non-default branch;
- claimed complete but not deployed;
- deployed then rolled back;
- artifact complete but review still open;
- a later correction to an earlier event;
- an inaccessible source that makes the answer unknowable;
- duplicate messages derived from one original event;
- long documents with a mixture of current and superseded sections.

## Non-negotiable principles for the later architecture

This research does not prescribe the implementation yet, but it rules out several architectures:

1. Raw observations must remain immutable and replayable.
2. Derived state must never destroy provenance or competing claims.
3. Identity resolution must support uncertainty, not only merge or reject.
4. Time must distinguish when something was true from when it was learned.
5. Completion must be evidence- and work-type-specific.
6. Search similarity cannot be the final judge of identity or truth.
7. LLM output must be treated as a proposal, not authoritative state.
8. Generated documents must be views over supported claims and history.
9. Coverage and permission boundaries must be first-class product state.
10. Human corrections must be durable evidence, not silent overwrites.
11. The system must represent “unknown,” “conflicting,” and “not yet verified.”
12. Retrieval for people, product, MCP, and skills must use the same governed state while respecting caller identity and purpose.

## Open questions before architecture

These need concrete answers before choosing components or prompts:

- What is the smallest initial set of work-object types Panini promises to reconstruct?
- Which sources form the initial coverage contract?
- What evidence is sufficient for each transition and fulfillment type?
- Which claims may be auto-accepted, which require corroboration, and which require a human?
- How should ambiguous cross-source identity be shown and corrected?
- What latency is required for messages, commits, deployments, and document changes?
- Which derived information may be visible when the underlying evidence is private?
- What exact user and agent scopes are supported?
- Which 50–100 real company episodes form the first mixed gold dataset, including negatives and unknowns?
- What is the acceptable precision/recall tradeoff for creating a task versus missing one?

Only after those are fixed should the architecture be selected. The architecture should be judged by whether it satisfies this contract, not by how elegant its graph, prompt, or model pipeline looks.
