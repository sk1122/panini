# Agent memory systems: evidence, benchmarks, and the Panini decision

**Checked:** 2026-09-16  
**Scope:** OpenViking, Mem0, Zep/Graphiti, Letta/MemGPT, and LangMem; LoCoMo, LongMemEval, DMR, and MemoryAgentBench. Only first-party repositories/documentation and original papers are used.  
**Decision:** Build Panini's canonical memory contract in PostgreSQL. Coding harnesses connect only to Panini. Subject to the combined-program AGPL decision and preregistered evaluation gates, Panini will embed a pinned OpenViking fork in local-library mode behind its private retrieval seam; it will not call or expose an OpenViking server. PostgreSQL remains canonical and the fallback. Graphiti remains an evaluation challenger, not a product dependency. See the [current implementation plan](../05-product-implementation-plan.md#6-should-panini-use-openvikings-code-or-call-an-openviking-server).

## Executive answer

OpenViking is interesting, but its published `80–83%` LoCoMo results are not enough to adopt it as Panini's memory core. They are vendor-reported, use OpenViking's own 2026 agent-integration protocol and Doubao model stack, and have no published independent reproduction. They cannot be ranked directly against Mem0's 2025 LoCoMo paper, Mem0's proprietary 2026 service, or Zep's LongMemEval results because the answer model, judge, retrieval budget, system boundary, and sometimes dataset slice differ. OpenViking does publish both detailed results and runnable harnesses, which makes it a credible pilot candidate, not validated infrastructure. [OpenViking benchmark results](https://github.com/volcengine/OpenViking#proof-it-works), [OpenViking LoCoMo harness](https://github.com/volcengine/OpenViking/tree/main/benchmark/locomo)

The products also solve different problems:

- **OpenViking** is a context database: a filesystem-like hierarchy over resources, memories, and skills, with progressive summaries and model-driven session memory.
- **Mem0** is a fact-extraction and retrieval layer, optionally with a graph. Its strongest current results apply to a managed algorithm that the project explicitly says includes proprietary optimizations unavailable in the open-source SDK.
- **Zep/Graphiti** is a temporal knowledge graph built from raw episodes, entities, facts, validity windows, and communities. It has the best conceptual match for derived relationship and history retrieval.
- **Letta/MemGPT** is a stateful agent runtime in which the model actively manages in-context blocks and out-of-context archival memory. It is more agent harness than embeddable organizational-memory substrate.
- **LangMem** is a small toolkit for application-defined semantic, episodic, and procedural memory. It is the easiest source of reusable primitives, but leaves storage, authorization, lineage, and policy to the application.

For Panini, "memory" must mean a permission-filtered projection of evidence-backed accepted state, not whatever an LLM decided was memorable. The safe architecture is:

```text
source observations -> evidence ledger -> cited finding -> proposal -> authority decision
                                                                  |
                                                                  v
                                                   accepted PostgreSQL revision
                                                                  |
                                                     authorized projection outbox
                                                                  |
                                                                  v
                                        private disposable retrieval implementation
                                     (embedded OpenViking fork, never authority)
```

The immediate choice is therefore **build the narrow core, resolve the fork's license, embed it behind a private seam, and benchmark it before making it the default**. A simple Panini-native baseline—PostgreSQL full-text/vector search over immutable evidence, accepted facts, and revision-aware context packs—is cheaper to govern, easier to delete, and already aligned with the product's domain model. The embedded OpenViking fork becomes useful only if hierarchical retrieval produces a material quality or token advantage after reauthorization and freshness checks. Graphiti remains useful as a benchmark challenger only if temporal relationship queries justify the graph-construction cost.

## 1. What each system treats as memory

| System | Memory representation and write path | Recall path | What Panini would actually use |
| --- | --- | --- | --- |
| **OpenViking** | Resources, memories, and skills live at `viking://` URIs. Directory-level L0 abstracts and L1 overviews guide loading of L2 detail. A committed session archives messages and asynchronously asks an LLM to summarize and skip/create/merge/delete long-term memories. [Context types](https://docs.openviking.ai/en/concepts/02-context-types), [context layers](https://docs.openviking.ai/en/concepts/03-context-layers), [sessions](https://docs.openviking.ai/en/concepts/08-session) | `find` performs direct semantic retrieval; `search` can add LLM intent analysis, recursive directory retrieval, and reranking. The filesystem is canonical for OpenViking and the vector index is derived. [Retrieval](https://docs.openviking.ai/en/concepts/07-retrieval), [storage](https://docs.openviking.ai/en/concepts/05-storage) | At most, directory-scoped retrieval over accepted context exported by Panini. Do not use automatic session capture or memory mutation. |
| **Mem0** | The 2025 paper extracts natural-language facts from each message pair, compares each fact with ten similar memories, then lets GPT-4o-mini choose `ADD`, `UPDATE`, `DELETE`, or `NOOP`; Mem0\(^{g}\) additionally stores entity-relation triplets in Neo4j and invalidates conflicting edges. [Mem0 paper, methods](https://arxiv.org/html/2504.19413#S2) The April 2026 managed algorithm instead uses one-pass, ADD-only extraction and accumulates memories. [Current algorithm](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026) | Dense-vector recall in the paper; current managed retrieval fuses semantic, BM25, entity, and temporal signals. [Current algorithm](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026) | Possible extraction/retrieval experiment, but no model-selected update or delete may mutate accepted Panini state. The closed managed path conflicts with local-control goals. |
| **Zep / Graphiti** | Raw episodes are the provenance stream; LLM extraction creates entities, relation/fact edges with valid and invalid times, evolving summaries, and communities. New episodes update the graph incrementally rather than rebuilding it. [Graphiti repository](https://github.com/getzep/graphiti#what-is-a-context-graph), [Zep paper, architecture](https://arxiv.org/html/2501.13956#S3) | Hybrid semantic, BM25, and graph traversal, with optional rerankers. Graphiti is the Apache-2.0 framework; Zep is the managed production service built around its context-graph approach. [Graphiti repository](https://github.com/getzep/graphiti) | A derived temporal relationship index, after accepted-state IDs and evidence pointers are preserved. It should not infer acceptance or become the only copy of history. |
| **Letta / MemGPT** | Persistent memory blocks are always in the model's context; message history is recall memory; archival passages sit outside the active window. The agent invokes tools to move or rewrite information between tiers. Blocks and archives can be shared across agents. [MemGPT paper](https://arxiv.org/html/2310.08560), [Letta block attachment](https://docs.letta.com/tutorials/attaching-detaching-blocks/), [Letta passage API](https://docs.letta.com/api/resources/agents) | The model decides when to edit blocks, search archival memory, or page conversation history. Current Letta Code also projects context into a git-tracked memory filesystem. [Letta Code](https://github.com/letta-ai/letta-code#feature-overview) | Not a Panini storage dependency. Its memory hierarchy is useful for agent UX experiments, but giving an agent authority to rewrite shared organizational memory violates Panini's acceptance boundary. |
| **LangMem** | Semantic memory is either a searchable collection or one current-state profile; episodic memory stores successful examples; procedural memory changes prompt instructions. An LLM may form memory in the hot path or in a background manager. [LangMem concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/) | The developer supplies a `BaseStore` and namespaces; agents can receive manage/search tools or the application can call the extraction primitives directly. Production examples point to an asynchronous PostgreSQL store. [LangMem repository](https://github.com/langchain-ai/langmem#creating-an-agent) | Reuse prompts or primitives only behind Panini's proposal gate. It is not a database, access-control layer, or provenance model. |

Cognee is not shortlisted as a Panini dependency. It is included in MemoryAgentBench as a graph-memory baseline, but that independent evaluation found no quality advantage over simpler baselines and very high construction cost in its tested adapter. That is enough evidence to keep it out of the first pilot, not enough to make a general product-quality judgment. [MemoryAgentBench implementation and results](https://arxiv.org/html/2507.05257#S3)

## 2. LoCoMo: what it measures and what the scores mean

### Dataset and task

The original LoCoMo paper created 50 LLM-generated, human-edited conversations. Each averaged 19.3 sessions, 15.8 turns per session, and 9,209.2 tokens. Its 7,512 QA examples comprised 2,705 single-hop, 1,104 multi-hop, 1,547 temporal, 285 open-domain, and 1,871 adversarial questions. Annotators edited about 15% of dialogue turns and removed or replaced about 19% of generated images. The original QA score was normalized token-overlap F1; annotated answers were kept close to conversation wording specifically to make that metric workable. [LoCoMo paper, construction and task](https://arxiv.org/html/2402.17753#S3), [LoCoMo paper, dataset statistics](https://arxiv.org/html/2402.17753#A1.SS1)

The public benchmark used by recent memory-system papers is not that full 50-conversation set. The official repository now releases `locomo10.json`: ten of the longest, best-annotated conversations, selected partly to reduce closed-model evaluation cost; images are omitted but URLs and BLIP captions remain. [Official LoCoMo repository](https://github.com/snap-research/LoCoMo#data) It contains 1,986 questions, of which the four answerable categories total 1,540 (841 single-hop, 282 multi-hop, 321 temporal, 96 open-domain) and 446 are adversarial. The counts can be reproduced from the [released JSON](https://github.com/snap-research/LoCoMo/blob/main/data/locomo10.json); the category mapping is encoded in the [official evaluator](https://github.com/snap-research/LoCoMo/blob/main/task_eval/evaluation.py).

### Methodology cautions

LoCoMo is useful for long-range personal fact recall, but it is not a proxy for Panini's organizational truth or governance:

- It is a small set of synthetic two-person conversations, selected rather than randomly sampled. Ten conversations create substantial clustering: treating 1,540 questions as independent overstates the effective sample size.
- Open-domain questions require outside model knowledge, so they do not isolate memory. Adversarial questions test abstention, yet Mem0 and OpenViking headline runs omit them.
- The original token F1, Mem0's repeated LLM judge, and OpenViking's binary accuracy judge are different endpoints. Even two LLM-judge scores are incompatible unless prompts, judge version, answer model, memory ingest, retrieval budget, and question set match.
- The dataset has been public since 2024. No reviewed primary source provides a contamination audit for the later proprietary models used in the 2025–2026 results. Exposure is therefore **possible but unproven**; Panini should keep a private, newly authored holdout.
- LoCoMo evaluates answers after a completed history. It does not test tenant isolation, revoked access, source deletion, evidence lineage, stale revisions, adversarial memory writes, or whether a claimed fact was authorized.

### Comparable panel A: Mem0 paper's 2025 LoCoMo-10 run

This is one internally comparable experiment, authored by Mem0. It excludes adversarial questions. LangMem used GPT-4o-mini and `text-embedding-3-small`; all Mem0 LLM operations used GPT-4o-mini with ten recent messages and ten similar memories. Temperature was zero where applicable. The reported judge score is the mean of ten stochastic LLM-judge runs, with one standard deviation. The paper publishes the judge prompt but describes the judge only as a separate, more capable LLM; it does not identify the judge model or version. Memory tokens are retrieved context, not construction tokens. [Experimental setup](https://arxiv.org/html/2504.19413#S3), [prompt appendix](https://arxiv.org/html/2504.19413#A1)

| Method | Single-hop J | Multi-hop J | Open-domain J | Temporal J | Overall J | Retrieved tokens | Search p95 | End-to-end p95 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Full conversation | — | — | — | — | 72.90 ± 0.19 | 26,031 | — | 17.117 s |
| LangMem | 62.23 ± 0.75 | 47.92 ± 0.47 | 71.12 ± 0.20 | 23.43 ± 0.39 | 58.10 ± 0.21 | 127 | 59.82 s | 60.40 s |
| Zep | 61.70 ± 0.32 | 41.35 ± 0.48 | 76.60 ± 0.13 | 49.31 ± 0.50 | 65.99 ± 0.16 | 3,911 | 0.778 s | 2.926 s |
| Mem0 | 67.13 ± 0.65 | 51.15 ± 0.31 | 72.93 ± 0.11 | 55.51 ± 0.34 | 66.88 ± 0.15 | 1,764 | 0.200 s | 1.440 s |
| Mem0\(^{g}\) | 65.71 ± 0.45 | 47.19 ± 0.67 | 75.71 ± 0.21 | 58.13 ± 0.44 | 68.44 ± 0.17 | 3,616 | 0.657 s | 2.590 s |

Source: [Mem0 paper, Tables 1 and 2](https://arxiv.org/html/2504.19413#S4). These are **vendor-authored**, not independent results. The full-context row is also a warning: at this dataset length, retrieval systems did not beat the strongest quality baseline, although they used fewer answer-context tokens and had lower latency.

### Separate panel B: OpenViking's 2026 LoCoMo run

OpenViking v0.3.22 reports the following paired integration results. Its repository identifies Doubao 2.0 Pro as the VLM and `doubao-embedding-vision-251215` as the embedding model. The current harness defaults to `locomo10.json`, whose released answerable categories total 1,540 questions, but its README also shows a `locomo_qa_1528.csv` example. The published result summary does not pin which exact 1,528- or 1,540-question slice produced the table, fully pin the evaluator version used for that run, or name a common answer model across the three agent integrations. The harness's current default binary judge is `doubao-seed-2-0-pro-260215`. Token totals include answer-agent input, and the repository separately records ingestion model tokens. Each native/with-OpenViking pair is informative, but the three agent integrations are different systems. [OpenViking results and model configuration](https://github.com/volcengine/OpenViking#proof-it-works), [harness and judge configuration](https://github.com/volcengine/OpenViking/blob/main/benchmark/locomo/README.md)

| Agent integration | Accuracy | Mean query time | Total input tokens |
| --- | ---: | ---: | ---: |
| OpenClaw native memory | 24.20% | 95.14 s | 392,559,404 |
| OpenClaw + OpenViking | 82.08% | 38.8 s | 37,423,456 |
| Hermes native memory | 33.38% | 82.4 s | 79,228,398 |
| Hermes + OpenViking | 82.86% | 27.9 s | 52,026,755 |
| Claude Code auto-memory | 57.21% | 49.1 s | 353,306,422 |
| Claude Code + OpenViking | 80.32% | 20.4 s | 129,968,899 |

These are **vendor-reported results with published reproduction code**, not an independent reproduction. They demonstrate a large improvement over those three native integrations under OpenViking's setup. They do **not** show that OpenViking beats Mem0, Zep, full-context, or a Panini-native retriever under a matched protocol.

### Separate panel C: Mem0's April 2026 managed service

Mem0 currently reports 92.5 on LoCoMo and 94.4 on LongMemEval, with 7.0K/6.8K tokens and 0.88/1.09-second p50 latency respectively. The configuration is single-pass retrieval at `top_200` on a "production-representative model stack." Mem0 explicitly states that these scores reflect its managed platform and proprietary optimizations unavailable in the open-source SDK. Its current extraction is ADD-only, which means old memories accumulate rather than being overwritten or deleted. [Mem0 current benchmark disclosure](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026)

These are **vendor-reported managed-service figures with an under-specified model/judge in the repository summary**. They belong in their own panel and cannot support an open-source or self-hosted procurement decision.

## 3. Other benchmarks worth using

### LongMemEval: stronger conversational coverage

LongMemEval has 500 questions covering information extraction, multi-session reasoning, temporal reasoning, knowledge update, and abstention, with six published question types including assistant-provided facts and user-preference updates. `LongMemEval_S` contains up to roughly 115K-token/80-session histories; `LongMemEval_M` scales to roughly 1.5M tokens/500 sessions. It uses question-specific GPT-4o judging prompts that the authors report at 98% agreement with human annotations. The official repository announced a cleaned September 2025 release after finding history-interference problems, so version pinning is essential. [LongMemEval paper](https://arxiv.org/html/2410.10813), [official repository and data notice](https://github.com/xiaowu0162/LongMemEval)

Zep's vendor-authored paper provides one useful, matched `LongMemEval_S` panel. It used BGE-m3 for embedding/reranking, GPT-4o-mini for graph construction, the official GPT-4o judge prompts, top-20 retrieved nodes/edges, and tests run from Boston against Zep in AWS `us-west-2`:

| Memory | Answer model | Judge score | Latency | Average answer context |
| --- | --- | ---: | ---: | ---: |
| Full context | `gpt-4o-mini-2024-07-18` | 55.4% | 31.3 s | 115K tokens |
| Zep | `gpt-4o-mini-2024-07-18` | 63.8% | 3.20 s | 1.6K tokens |
| Full context | `gpt-4o-2024-11-20` | 60.2% | 28.9 s | 115K tokens |
| Zep | `gpt-4o-2024-11-20` | 71.2% | 2.58 s | 1.6K tokens |

Source: [Zep paper, LongMemEval setup and Table 2](https://arxiv.org/html/2501.13956#S4.SS3). This is **vendor-authored** and evaluates the then-hosted Zep system, not necessarily today's Apache-licensed Graphiti default stack.

### DMR: now too easy to select a system

DMR has 500 conversations, each only five sessions and at most 60 messages, with one factual QA each. In the Zep paper's matched rerun, session summaries/full-context/Zep scored 78.6/94.4/94.8 with `gpt-4-turbo-2024-04-09`, and 88.0/98.0/98.2 with `gpt-4o-mini-2024-07-18`; the 93.4 MemGPT result in the same table is copied from the MemGPT paper, not reproduced. Zep's authors explicitly say the conversations fit in modern context windows, questions are single-fact and sometimes ambiguous, and they could not reproduce MemGPT with GPT-4o-mini due to insufficient methodological detail. [Zep paper, DMR](https://arxiv.org/html/2501.13956#S4.SS2)

DMR remains a smoke test for gross retrieval failure. A 0.2–0.4 percentage-point improvement over full context is not a procurement signal.

### MemoryAgentBench: breadth and an independent warning

MemoryAgentBench evaluates 2,071 questions across 103K–1.44M-token histories and four capability groups: accurate retrieval, test-time learning, long-range understanding, and selective forgetting. It incrementally feeds chunks rather than handing every product a finished database. The paper states that all RAG and commercial-memory rows use GPT-4o-mini unless specified, explicitly identifies GPT-4o-mini as Mem0's answer backbone, and fixes Mem0, Cognee, and Zep at 4,096-token chunks. Under its adapter-specific settings, overall scores were 42.2 for full-context GPT-4o-mini, 41.5 for BM25, 21.1 for Mem0, 20.6 for Cognee, 24.0 for Zep, and 28.3 for MemGPT. Those results conflict sharply with vendor leaderboards and show how much adapter, task mix, and ingestion protocol matter. [MemoryAgentBench scope](https://arxiv.org/html/2507.05257#S2), [Table 3 and settings](https://arxiv.org/html/2507.05257#S4)

The same independent paper reports very high construction times on LongMemEval(S*): 2,946 s for Mem0 and 738 s for Cognee (both fixed at 4,096-token chunks), and 85.5 s for MemGPT, versus 0.08 s for BM25; query execution was 1.7, 4.1, 12.3, and 1.9 seconds respectively. This is one hardware/protocol snapshot, not current service latency, but it shows why ingest cost must be measured rather than inferred from query latency. [MemoryAgentBench latency table](https://arxiv.org/html/2507.05257#A2.SS5)

Its "selective forgetting" score is **not** proof of deletion or regulatory erasure. The benchmark retains conflicting facts in the input, assigns serial numbers, and explicitly tells the model to prefer newer facts. That tests answer-time supersession and interference resistance. It does not verify physical deletion from raw stores, embeddings, graph edges, caches, backups, or audit logs. [MemoryAgentBench prompt design](https://arxiv.org/html/2507.05257#A7)

## 4. Operations, privacy, and governance

| System | Self-hosting, license, and maturity | Deletion / authorization / provenance | Panini risk |
| --- | --- | --- | --- |
| **OpenViking** | Python/Rust/C++ implementation with local-library and server modes; main implementation AGPL-3.0, TypeScript SDK Apache-2.0. Latest checked release is pre-1.0 `v0.4.20`; recent releases include migrations and changing defaults. [embedded quick start](https://docs.openviking.ai/en/getting-started/02-quickstart), [v0.4.20](https://github.com/volcengine/OpenViking/releases/tag/v0.4.20), [license](https://github.com/volcengine/OpenViking/blob/main/LICENSE) | Account/user identity, API keys, roles, opt-in resource ACLs, opt-in AES-256-GCM envelope encryption, snapshots, source metadata, and memory diffs. API/MCP clients can write and delete; session extraction can mutate memory. Panini will not expose or use those server/session surfaces. [Multi-tenancy](https://docs.openviking.ai/en/concepts/11-multi-tenant), [ACLs](https://docs.openviking.ai/en/concepts/15-acl), [encryption](https://docs.openviking.ai/en/concepts/10-encryption), [snapshots](https://docs.openviking.ai/en/guides/15-snapshot) | Combined-program AGPL decision, added Python/native runtime, model/VLM cost at ingest, and overly powerful upstream write surfaces. Pin the fork, strip the shipped path to retrieval needs, and keep it private behind Panini. |
| **Mem0** | Apache-2.0 SDK/library and self-hosted server plus managed cloud; repository states advanced features are concentrated in cloud and managed benchmark behavior is not identical to OSS. [Deployment modes](https://github.com/mem0ai/mem0#quickstart-guide), [license](https://github.com/mem0ai/mem0/blob/main/LICENSE) | User/agent/session scoping and explicit delete APIs exist, but the core abstraction is mutable extracted memory; the 2025 LLM can delete a contradicted fact and the 2026 managed algorithm never overwrites. Neither is an immutable evidence/decision model. [Delete operations](https://docs.mem0.ai/core-concepts/memory-operations/delete), [2025 algorithm](https://arxiv.org/html/2504.19413#S2.SS1), [2026 algorithm](https://github.com/mem0ai/mem0#new-memory-algorithm-april-2026) | Semantic deletion is not compliance deletion; managed accuracy is closed; memory formation may transmit content to configured model/vector providers. |
| **Graphiti / Zep** | Graphiti is Apache-2.0, self-hosted Python, and supports several graph databases; Zep is a distinct managed service. Graph construction requires LLM and embedding calls. [Graphiti setup and databases](https://github.com/getzep/graphiti#installation), [license](https://github.com/getzep/graphiti/blob/main/LICENSE) | Episodes preserve raw provenance and facts have temporal validity. `group_id` partitions graphs and APIs can remove episodes/entities, but these are storage primitives rather than Panini capability checks, approval records, or source-derived visibility. [Graph model](https://github.com/getzep/graphiti#what-is-a-context-graph), [API reference](https://github.com/getzep/graphiti/tree/main/graphiti_core) | Graph-derived statements may look authoritative. Every node/edge returned to an agent must retain source IDs and be reauthorized; cascade and backup erasure need explicit tests. |
| **Letta / MemGPT** | Current Letta Code is an Apache-2.0 agent harness with local execution and Letta Cloud state. The older `letta` repository says active development moved to `letta-code`; its Docker server is no longer an actively supported product surface. [Current repository](https://github.com/letta-ai/letta-code), [repository transition](https://github.com/letta-ai/letta), [Docker notice](https://docs.letta.com/v1-sdk/docker) | Blocks can be attached/detached, archival passages deleted, and current context can be git-tracked. The agent itself is expected to rewrite memory, skills, and prompts. [Block controls](https://docs.letta.com/tutorials/attaching-detaching-blocks/), [passage API](https://docs.letta.com/api/resources/agents), [Letta Code memory](https://github.com/letta-ai/letta-code#feature-overview) | Runtime ownership is too broad: self-editing is valuable for a personal agent but unsafe as the writer of shared accepted company state. Product-surface churn increases integration risk. |
| **LangMem** | MIT Python library, not a service; works with any store and has a PostgreSQL-backed LangGraph path. [Repository](https://github.com/langchain-ai/langmem) | Namespaces and underlying store supply isolation/deletion. The memory manager can insert/update/delete model-produced records; deletion is disabled by default in the manager unless enabled. No built-in organizational ACL, audit, or provenance contract. [Concepts](https://langchain-ai.github.io/langmem/concepts/conceptual_guide/), [memory manager API](https://langchain-ai.github.io/langmem/reference/memory/) | Lowest lock-in and easiest to constrain, but Panini must build almost all governance. Prefer borrowing patterns over coupling the domain model to LangGraph. |

Costs have three separate components that vendor charts often mix: (1) memory construction—extraction, summarization, embeddings, graph updates; (2) storage and reindexing; and (3) per-query retrieval, reranking, and answer generation. The Mem0 paper's “memory tokens” and OpenViking's total agent input tokens do not include the same boundary. Panini's evaluation must report all three, plus cold-start and rebuild cost.

## 5. Use versus build for Panini

### Build now

Build a small, explicit memory kernel inside Panini's existing PostgreSQL boundary:

1. **Canonical objects:** immutable source observations and receipts; revocable/encrypted content bodies; evidence-citing findings; proposals; authority decisions; accepted entity/task/context revisions.
2. **Memory views:** accepted current facts, temporal revision history, user-approved preferences, project summaries, and episodic work examples. Each item carries tenant, visibility, source IDs, accepted revision, timestamps, content hash, and deletion/retention state.
3. **Formation:** deterministic extraction and validation first. LLM output is a cited candidate finding or proposal, never a direct accepted write.
4. **Recall:** authorize before search, query only allowed partitions, return compact candidates, reauthorize and version-check results, then load canonical text from PostgreSQL.
5. **Forgetting:** distinguish supersession, user-requested deletion, source revocation, retention expiry, and cryptographic erasure. Preserve minimal non-sensitive audit facts where policy permits without retaining deleted content.

This is not “building another Mem0.” It is building the part none of these products supplies: Panini's authority, provenance, and privacy contract. Start with PostgreSQL full-text search plus an approved vector extension if needed, and keep the retrieval interface replaceable.

### Embed and evaluate after the license gate

Build the pinned **OpenViking fork** into Panini's private memory runtime when the workload contains deep project/document hierarchies where L0/L1/L2 navigation plausibly saves tokens. Export only accepted, redacted projections via an outbox; use separate workspaces/roots per organization and visibility realm; invoke the lower-complexity local `find` implementation first; never expose OpenViking server, write, or session tools to agents. The combined-program AGPL or alternative commercial-license path must be accepted before code is imported.

Pilot **Graphiti** instead when the target questions depend on changing relationships—owner-at-time, dependency-at-revision, blocker-before-resolution—and a flat revision-aware retriever misses them. Treat episodes, nodes, edges, and summaries as rebuildable derived indexes.

Do not pilot Mem0 managed until local-control requirements change; do not use its 92.5 claim to justify the OSS SDK. Use LangMem only as an implementation aid in an isolated experiment. Use Letta if Panini later needs to run persistent autonomous agents, not to store shared company truth.

## 6. Narrow, decision-producing evaluation

### Freeze before running

- **Systems:** Panini PostgreSQL baseline; full-context baseline where it fits; OpenViking `v0.4.20` adapter; Graphiti at a pinned commit. Add Mem0 OSS only if engineering capacity permits.
- **Model stack:** one fixed answer model, one fixed embedding model, one fixed judge version and prompt, temperature zero, and identical maximum answer tokens. Do not allow a vendor-specific answer agent in the main comparison.
- **Inputs:** official `locomo10.json` answerable set for comparability; the cleaned pinned LongMemEval release; and a private Panini holdout built from synthetic but production-shaped evidence/revision streams. Keep at least 20% of the private cases sealed until the pipeline is frozen.
- **Retrieval contract:** identical maximum retrieved tokens and maximum candidate count, with retrieved IDs/text recorded before answer generation. Preserve a no-retrieval and full-context baseline.
- **Repeat policy:** run deterministic retrieval once; run the LLM judge at least three times or manually adjudicate every disagreement. Bootstrap confidence intervals by conversation/workspace, not by treating correlated questions as independent.

### Private Panini cases

The private set should contain at least these gates:

| Gate | Required behavior |
| --- | --- |
| Current accepted state | Answer from the latest approved revision and cite its evidence; reject later unapproved proposals. |
| Temporal history | Correctly answer what was accepted at a specified time without replacing history with current state. |
| Multi-source synthesis | Combine two permitted sources and expose both citations; do not invent a causal link. |
| Abstention | Say the answer is unknown when no accepted evidence supports it. |
| Visibility | A caller lacking one source cannot infer its fact, existence, title, embedding, or graph neighbor. Zero cross-tenant leaks. |
| Revocation/deletion | After source revocation or deletion, no returned body, summary, edge, cache, or stale index contains the removed information. |
| Stale index | An old adapter candidate is rejected when its accepted revision/hash no longer matches PostgreSQL. |
| Poisoning | Malicious source text cannot change retrieval policy, authority, or system instructions. |
| Rebuild | Delete the derived index and reproduce searchable IDs, versions, hashes, and partitions from the canonical outbox. |
| Failure mode | Adapter outage degrades recall but never blocks canonical task/evidence writes or silently returns unauthorized context. |

### Metrics and stop conditions

Report quality by question type: answer correctness, evidence recall@k, citation precision, abstention precision/recall, temporal-currentness accuracy, and proposal/accepted-state confusion. Report p50/p95 ingestion lag, retrieval latency, end-to-end latency, retrieved and generated tokens, model calls, storage bytes per accepted item, rebuild time, and cost per 1,000 ingested events/queries. Separately report security and deletion tests as pass/fail; never average them into an accuracy score.

**Proposed initial decision rule, to confirm before running:** adopt an adapter only if it meets all hard gates—zero tenant/visibility leaks, 100% stale-result rejection, 100% required deletion/revocation tests, complete source/revision lineage, and successful rebuild—and then either (a) improves the Panini baseline by at least **5 percentage points** on private evidence-grounded correctness, with the conversation/workspace-clustered 95% bootstrap confidence interval for the difference excluding zero, or (b) cuts retrieved tokens by at least **30%** while losing no more than **1 quality point**, with the clustered interval ruling out a loss greater than one point. These are starting decision thresholds, not empirically established constants. The adapter must also stay below p95 latency and monthly cost budgets fixed before the run. If neither OpenViking nor Graphiti clears those gates, keep the Panini-native retriever; the product has lost no canonical data and no migration is required.

## Bottom line

Use OpenViking's hierarchy through a pinned, embedded fork behind Panini's private retrieval seam, after resolving the license gate. Treat that runtime as disposable and rebuildable, not as Panini's memory authority; do not adopt its automatic memory or treat its LoCoMo headline as a cross-vendor leaderboard. Build Panini's authority-aware memory kernel because it is the differentiating requirement and none of the compared systems provides it. Let a preregistered, production-shaped evaluation—not vendor benchmark numbers—decide whether the embedded fork becomes the default retriever; use Graphiti only as a challenger for temporal graph retrieval.
