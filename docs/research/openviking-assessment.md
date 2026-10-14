# OpenViking assessment for Panini

**Checked:** 2026-09-16  
**Scope:** OpenViking's official repository, documentation, source/configuration files, and releases only.  
**Decision:** Coding harnesses connect only to Panini. Subject to the AGPL licensing decision and evaluation gates, Panini will maintain a pinned OpenViking fork and use its embedded Python local-library implementation behind a private Panini retrieval seam. It will not call or expose OpenViking's HTTP/MCP server or hosted interfaces. PostgreSQL remains canonical and the fallback. See the [current implementation plan](../05-product-implementation-plan.md#6-should-panini-use-openvikings-code-or-call-an-openviking-server).

## Executive conclusion

OpenViking is a self-hostable **context database for AI agents**. It organizes resources, agent memories, and skills in a `viking://` virtual filesystem; generates short and medium directory summaries; stores full content separately from a vector index; and exposes retrieval, file, memory, session, and skill operations through HTTP, SDKs, a CLI, and MCP. Its strongest fit for Panini is **derived hierarchical retrieval over already accepted context**, not organizational truth, task state, evidence governance, or decision authority. [Official repository](https://github.com/volcengine/OpenViking), [architecture](https://docs.openviking.ai/en/concepts/01-architecture), [context types](https://docs.openviking.ai/en/concepts/02-context-types)

Panini and OpenViking solve adjacent but different problems:

- Panini reconciles intended work with observed work and maintains an evidence-backed, reviewable projection of accepted company state.
- OpenViking makes agent context navigable, searchable, progressively loadable, and reusable across sessions.

The safe relationship is therefore:

```text
Notion / Slack / GitHub / agent receipts
                    |
                    v
       Panini PostgreSQL control plane
 evidence -> findings -> proposals -> decisions -> accepted revisions
                    |
             accepted-context outbox
                    |
                    v
   embedded forked OpenViking runtime
     URIs + summaries + vectors, never authority
                    |
                    v
      Panini reauthorizes and serves context
```

OpenViking must never replace Panini's PostgreSQL evidence ledger, proposal gate, revision history, or MCP authorization boundary. Agents should connect to Panini's MCP service, not receive an OpenViking API key or unrestricted access to OpenViking's write-capable MCP tools.

## 1. What OpenViking is

OpenViking describes itself as an open-source context database for AI agents. Its basic abstraction has three context types:

| OpenViking type | Meaning | Typical owner of the write |
| --- | --- | --- |
| Resource | Documents, code, manuals, research, and other external knowledge | User/application |
| Memory | Durable knowledge learned from interactions or task execution | Agent/session pipeline |
| Skill | A declarable capability package such as a `SKILL.md` directory | User/system |

These types live in a virtual filesystem addressed with `viking://{scope}/{path}`. Shared resources are account-scoped; user data contains memories, resources, skills, peers, and sessions; agent-scoped paths hold shared agent capabilities. The `viking://~` alias resolves to the authenticated caller's user root. [Context types](https://docs.openviking.ai/en/concepts/02-context-types), [Viking URI](https://docs.openviking.ai/en/concepts/04-viking-uri)

This is not equivalent to Panini's domain model. OpenViking's public model does not define an immutable source observation, baseline claim, evidence-citing finding, pending work proposal, authority decision, or accepted task revision. It does have source metadata, memory change logs, filesystem snapshots, identity boundaries, and ACLs, but those are storage/retrieval governance mechanisms rather than Panini's organizational acceptance workflow. This distinction is an inference from the official models reviewed above and OpenViking's documented session and snapshot behavior. [Sessions](https://docs.openviking.ai/en/concepts/08-session), [snapshots](https://docs.openviking.ai/en/guides/15-snapshot)

## 2. Architecture and data flow

### Service shape

OpenViking's documented stack is:

```text
Client / HTTP / CLI / MCP
          |
       Service layer
          |
  +-------+---------+----------+
  |                 |          |
Retrieve          Session     Parse
intent/search     commit      document extraction
hierarchy/rerank  memory      tree construction
  |                 |          |
  +----------- Compressor -----+
                  |
             VikingFS/RAGFS
             /            \
       content store    vector index
```

The service layer separates filesystem, search, session, resource, pack, and debug operations from transports. Resource ingestion parses documents, constructs a tree, writes content, queues bottom-up semantic generation, and updates the vector index. Retrieval performs intent analysis, recursively searches the directory hierarchy, then optionally reranks candidates. [Architecture](https://docs.openviking.ai/en/concepts/01-architecture)

### Context layers

OpenViking progressively loads context at three levels:

| Layer | Stored form | Default body limit | Use |
| --- | --- | ---: | --- |
| L0 | Directory `.abstract.md` | 256 characters | Candidate recall and quick filtering |
| L1 | Directory `.overview.md` | 4,000 characters | Navigation and reranking |
| L2 | Original/parsed files and subdirectories | No uniform limit | Full detail on demand |

L0 and L1 are directory-level semantic sidecars rather than one summary pair per ordinary file. They are generated bottom-up from contained files and child-directory abstracts. This is directly useful to Panini: an agent can first inspect a small company/project tree, then request a project overview, then load the exact accepted fact or document it needs. [Context layers](https://docs.openviking.ai/en/concepts/03-context-layers)

### Content and index storage

OpenViking deliberately separates content from retrieval indexes:

- AGFS, now implemented through in-process Rust RAGFS bindings, stores L0/L1/L2 content and media.
- The vector index stores URIs, vectors, scalar metadata, names, descriptions, and abstracts, not canonical file content.
- VikingFS maps authenticated `viking://` paths to physical account/user paths and keeps filesystem moves/deletes aligned with vector records.
- Content backends include local filesystem, S3-compatible storage, and in-memory test storage. Vector backends include local persistence, an HTTP service, and Volcengine VikingDB.

The official reliability principle is that the filesystem is the source of truth and the vector database is a rebuildable derived index. Path locks protect writes; persistent QueueFS work supports recovery of asynchronous session-memory processing. QueueFS uses SQLite by default. [Storage architecture](https://docs.openviking.ai/en/concepts/05-storage), [transactions and recovery](https://docs.openviking.ai/en/concepts/09-transaction), [configuration](https://docs.openviking.ai/en/guides/01-configuration)

That is a good indexing principle but not a reason to replace Panini's database. In Panini, PostgreSQL remains the source of truth for evidence, proposals, decisions, accepted context, tasks, and revisions. If OpenViking is added, its entire content/index tree must be disposable and rebuildable from authorized Panini projections.

### Retrieval

OpenViking exposes two main retrieval styles:

- `find`: lower-latency semantic retrieval without session context or LLM intent analysis.
- `search`: optional session-aware intent analysis that expands the request into typed queries, performs hierarchical retrieval, and reranks results.

The hierarchy matters because the search begins in a bounded directory scope, selects promising branches, and propagates parent/child relevance instead of treating all chunks as one flat corpus. [Retrieval mechanism](https://docs.openviking.ai/en/concepts/07-retrieval)

For Panini, `find` is the safer first integration. It has fewer model-owned steps, lower latency, and a simpler evaluation surface. `search` should remain optional until Panini has frozen authorization, evaluation, token-budget, and observability requirements.

### Sessions and self-evolving memory

OpenViking sessions record user/assistant messages plus text, image, context, and tool-call parts. A session commit synchronously archives messages to `messages.jsonl`, then asynchronously uses an LLM to summarize the archive and extract long-term memories. Candidate memories are vector-matched against existing memories, after which an LLM can choose to skip, create, merge, or delete. Applied changes are recorded in `memory_diff.json`. [Session management](https://docs.openviking.ai/en/concepts/08-session)

This is useful for personal agent memory, but it conflicts with Panini's default company-data boundary in two ways:

1. It can retain complete messages and tool inputs/outputs. Panini's current rule is to retain privacy-filtered work receipts, artifact references, approved excerpts, and hashes—not raw prompts, full transcripts, secrets, or raw tool output.
2. Model-generated memory decisions can directly create, merge, or delete stored memory. A change log is valuable, but it is not the same as a pre-mutation proposal requiring deterministic validation and explicit authority.

Therefore Panini must not send harness sessions, Slack transcripts, raw GitHub payloads, or raw evidence bodies into OpenViking's session-memory pipeline. The embedded runtime should call only the local resource/file and retrieval implementation needed for accepted projections, with session memory and automatic capture disabled or removed from the shipped path.

## 3. Where models are used

OpenViking separates several model roles:

| Model role | What it does | Mandatory for a Panini pilot? |
| --- | --- | --- |
| Embedding | Vectorizes summaries/content and queries | Yes, if OpenViking semantic retrieval is being evaluated |
| VLM/LLM semantic extraction | Produces L0/L1 summaries and understands multimodal content | Yes for OpenViking-generated hierarchy summaries; avoid multimodal input initially |
| Query planner | Performs intent analysis for `search` | No; begin with `find` |
| Reranker | Reorders retrieved candidates | No; add only if evaluation shows a measurable gain |
| Session-memory extractor | Generates and deduplicates long-term memory | No; out of scope for Panini company context |
| Compile runtime/VikingBot | Uses skills to transform context into reports, wikis, and other artifacts | No; Panini owns product workflows and role-specific projections |

The server configuration supports many hosted and local embedding providers, including OpenAI-compatible endpoints, Ollama, and built-in local embeddings. The VLM performs L0/L1 semantic extraction; a separately configurable query planner can use a smaller local model, while reranking is optional. OpenViking's setup wizard asks separately for embedding and VLM configuration, and `openviking-server doctor` validates the resulting setup. [Configuration](https://docs.openviking.ai/en/guides/01-configuration), [setup procedure](https://docs.openviking.ai/en/getting-started/04-setup-for-agent)

For Panini, every OpenViking-generated summary is a **derived retrieval artifact**, never an accepted fact. The canonical content, evidence lineage, source visibility, and accepted version remain in PostgreSQL. Search results should return candidate IDs/URIs; Panini should reauthorize those candidates and load the final text from its canonical store.

## 4. API, SDK, CLI, MCP, and UI surfaces

OpenViking's server listens on port `1933` by default and exposes REST APIs plus Web Studio at `/studio`. Official clients include synchronous/asynchronous Python SDKs, a Go SDK, and an HTTP-only JavaScript/TypeScript SDK for Node.js 18+. The `ov`/`openviking` CLI reads `~/.openviking/ovcli.conf` and exposes filesystem, resource, retrieval, session, snapshot, privacy, ACL, and administration operations. [API overview](https://docs.openviking.ai/en/api/01-overview), [CLI configuration](https://docs.openviking.ai/en/configuration/02-client)

The built-in HTTP MCP endpoint is `/mcp` on the same port. Current documentation lists 15 tools, including semantic search, read/list/tree, memory creation, direct file write/edit, resource import, grep/glob, and deletion/forget operations. It shares the REST API-key identity model and also supports native OAuth 2.1 for compatible public clients. [MCP integration](https://docs.openviking.ai/en/guides/06-mcp-integration), [integration capability reference](https://docs.openviking.ai/en/agent-integrations/16-capability-reference)

Panini should not proxy this complete MCP surface to agents. OpenViking's direct `write`, `edit`, `remember`, and `forget` capabilities do not preserve Panini's evidence/proposal/approval semantics. Panini's MCP service remains the only agent-facing surface and calls a narrow internal `ContextRetrievalIndex` after Panini has authenticated the agent, resolved its organization/member/profile, and computed permitted context scopes.

The chosen implementation does not use the OpenViking REST API or TypeScript SDK. A co-packaged private Python runtime imports the pinned fork in local-library mode with `OpenViking(path=...)`; a Panini-owned local bridge connects it to the TypeScript/Bun `ContextCompiler` without a listening port, OpenViking credentials, or a public OpenViking interface. [Embedded quick start](https://docs.openviking.ai/en/getting-started/02-quickstart)

## 5. Deployment and self-hosting

### Runtime requirements

- Prebuilt package path: Python 3.10+ on Linux, macOS, or Windows.
- Source-build path: the official setup guidance additionally calls for Rust/Cargo, CMake, and a supported GCC/Clang toolchain because RAGFS/vector components are compiled.
- Persistent local deployment: a workspace directory containing `ov.conf`, file/index state, QueueFS SQLite data, and snapshot data.
- Model access: an embedding provider and, for semantic summary generation, a configured VLM/LLM; both can point to local services where supported.
- Embedded Panini deployment: a co-packaged private Python runtime, Panini-managed workspace and backups, no OpenViking network listener, and explicit organization/visibility partitioning.

[Quick start](https://docs.openviking.ai/en/getting-started/02-quickstart), [FAQ requirements](https://docs.openviking.ai/en/faq/faq), [server deployment](https://docs.openviking.ai/en/guides/03-deployment)

### Supported installation/deployment choices

| Option | Official path | Panini assessment |
| --- | --- | --- |
| Local package/library | `uv tool install openviking --upgrade`, `pipx install openviking`, or `pip install openviking`; Python import mode | Relevant upstream path; Panini will build the pinned fork into its private runtime rather than install a mutable package |
| Standalone server | `openviking-server init`, `doctor`, then `openviking-server` | Supported upstream, but not used by Panini |
| Docker | `ghcr.io/volcengine/openviking:<version>` with `~/.openviking:/app/.openviking` | Supported upstream, but not Panini's chosen boundary |
| Docker Compose | Official service plus persistent mount; optional Caddy | Supported upstream, but Panini will not add an OpenViking service or port |
| Kubernetes/Helm | Chart under `examples/k8s-helm` | Defer until Panini itself requires multi-instance deployment |
| Managed SaaS | Volcano Engine-operated service | Do not make the default for privacy-first Panini |
| Commercial self-managed | Vendor-supported BYOC/offline edition | Future enterprise option, subject to commercial/legal review |

The official Docker image starts the OpenViking service and Web Studio and currently bundles/starts VikingBot unless disabled. Those facts matter when reproducing upstream behavior, but the Panini product path will not ship that server image. [Server deployment](https://docs.openviking.ai/en/guides/03-deployment), [official Docker Compose](https://github.com/volcengine/OpenViking/blob/main/docker-compose.yml)

Create the Panini fork from the exact `v0.4.20` upstream commit for an evaluation performed against this report; record the commit and maintain a small patch queue rather than tracking a mutable branch. The latest official release as checked on 2026-09-16 is `v0.4.20`, released on 2026-09-14. [v0.4.20 release](https://github.com/volcengine/OpenViking/releases/tag/v0.4.20)

### Identity, ACLs, encryption, and snapshots

OpenViking supports account and user isolation, ROOT/ADMIN/USER roles, user API keys, a trusted upstream identity mode, and per-resource ACLs inside an account. Without a root API key it runs in localhost-only development mode and treats requests as ROOT. [Multi-tenancy](https://docs.openviking.ai/en/concepts/11-multi-tenant), [authentication](https://docs.openviking.ai/en/guides/04-authentication), [resource ACLs](https://docs.openviking.ai/en/concepts/15-acl)

At-rest encryption is opt-in and uses envelope encryption: a root key derives account keys, which wrap per-write AES-256-GCM file keys. Root-key providers include a local key file, HashiCorp Vault, and Volcengine KMS. [Encryption](https://docs.openviking.ai/en/concepts/10-encryption)

Filesystem snapshots are enabled by default and implemented with gitoxide in RAGFS. They create immutable account-tree commits, support history/diff/restore, and use forward-commit restore semantics so restoration adds history rather than rewriting it. This is valuable for index recovery and rollback, but it is not a substitute for Panini's per-proposal authority record and evidence-linked task/context revisions. [Snapshots](https://docs.openviking.ai/en/guides/15-snapshot)

## 6. Licensing and maturity

### Licensing

The main OpenViking project is **AGPL-3.0**. The official repository states that `crates/ov_cli` and examples are Apache-2.0 and third-party components retain their own licenses. The tagged Python package metadata also labels the main project AGPL-3.0; the TypeScript SDK package metadata labels that SDK Apache-2.0. [Repository license section](https://github.com/volcengine/OpenViking#license), [AGPL license text](https://github.com/volcengine/OpenViking/blob/main/LICENSE), [main package metadata](https://github.com/volcengine/OpenViking/blob/v0.4.20/pyproject.toml), [TypeScript SDK metadata](https://github.com/volcengine/OpenViking/blob/main/sdk/typescript/package.json)

Implications for Panini:

- Do not import or ship the fork while Panini remains MIT-licensed without a deliberate licensing decision.
- The conservative compliance plan for direct incorporation is to license the combined Panini distribution under AGPL-3.0, preserve notices and modification dates, publish complete corresponding source and build/install material, and provide the section 13 source offer to network users.
- If Panini must remain MIT or closed-source, obtain a separate commercial license from OpenViking's copyright holders before using the embedded-code design; attribution alone is insufficient.
- Keep the fork behind a Panini-owned interface and exclude its server, MCP, administration, session-transcript, and direct agent-write surfaces from the shipped path.
- Obtain legal review before distribution. This report is an engineering assessment, not legal advice.

### Maturity

OpenViking is active and substantial, but it is not yet a conservative infrastructure dependency:

- The tagged `v0.4.20` package remains pre-1.0.
- `pyproject.toml` declares `Development Status :: 3 - Alpha`.
- The September release notes include interface migrations, removed CLI options, changed memory-extraction defaults, and continuing identity/ACL evolution.
- The official release page shows frequent releases and 33 commits already on `main` after `v0.4.20` at the time of inspection.

[v0.4.20 release and migration notes](https://github.com/volcengine/OpenViking/releases/tag/v0.4.20), [tagged package metadata](https://github.com/volcengine/OpenViking/blob/v0.4.20/pyproject.toml)

The practical conclusion is not “do not use it”; it is “pin it, isolate it, test it, and keep a fallback.” Panini must remain functional when OpenViking is disabled, unavailable, reindexing, or upgraded.

## 7. Panini versus OpenViking

| Concern | Panini | OpenViking | Integration consequence |
| --- | --- | --- | --- |
| Primary job | Reconcile observed work into governed company state | Store, navigate, retrieve, and evolve agent context | Complementary, not substitutable |
| Canonical persistence | PostgreSQL ledger, projections, proposals, revisions | RAGFS/AGFS content is canonical; vector index is derived | PostgreSQL remains Panini truth |
| Provenance | Provider receipt, stable event ID, timestamp, hash, visibility, evidence links | Resource/source metadata, session archives/diffs, snapshots | Preserve Panini IDs in projection metadata; never infer acceptance from an OpenViking write |
| Mutation authority | Agent writes are evidence or proposals; approval changes accepted state | MCP/API can directly write/edit/delete resources and LLM memory extraction can merge/delete | Do not expose OpenViking write surfaces to Panini agents |
| Context structure | Typed atomic facts and Markdown files at stable paths | Resource/memory/skill trees with L0/L1/L2 layers | Strong conceptual fit for derived retrieval |
| Retrieval | Lightweight tree/read today; richer role-aware retrieval is planned | Mature hierarchical vector retrieval and rerank pipeline | The main reason to run a pilot |
| Privacy default | No raw prompts, transcripts, secrets, or raw tool output in receipts | Sessions may persist messages and ToolParts | Never feed raw harness sessions into the embedded runtime |
| Authorization | Panini profile capabilities plus source visibility and proposal rules | Account/user identity, API keys, ACLs, trusted gateway | Map tenants, but always reauthorize in Panini |
| Versioning | Evidence-linked proposal decisions and entity revisions | Whole-tree Git-like snapshots and memory diffs | OpenViking history is operational recovery, not organizational authority |
| Agent protocol | Narrow Panini MCP tools shaped around accepted context and proposals | Broad read/write/memory filesystem MCP | Agents use Panini MCP only |
| License | Currently MIT | Main implementation AGPL-3.0 | Resolve combined-program AGPL or commercial-license path before importing code |

Panini sources for this comparison: [product contract](../../README.md), [domain language](../../CONTEXT.md), [LLM authority ADR](../adr/0001-llm-findings-never-write-work-state.md), [context model ADR](../adr/0002-context-is-a-tree-of-facts-and-files.md), and [agent identity ADR](../adr/0003-agent-profiles-use-scoped-one-time-secrets.md).

## 8. Recommended embedded-fork design

### Public Panini seam

Define a provider-neutral interface owned by the Panini backend:

```ts
interface ContextRetrievalIndex {
  upsertAccepted(entry: AcceptedContextProjection): Promise<IndexReceipt>;
  removeAccepted(entryId: string, acceptedVersion: number): Promise<IndexReceipt>;
  search(input: AuthorizedSearchRequest): Promise<ContextCandidate[]>;
  rebuild(scope: OrganizationScope): Promise<RebuildReceipt>;
  health(): Promise<ContextIndexHealth>;
}
```

Implement `PostgresContextIndex` first as the default provider and fallback. Add `EmbeddedOpenVikingContextIndex` only after the license gate, behind configuration such as `CONTEXT_INDEX_PROVIDER=openviking`. No domain, HTTP route, MCP handler, or harness integration should import OpenViking-specific types.

### Projection contract

Only publish accepted, authorized context:

```text
Panini approval transaction
  -> accepted context row/revision
  -> transactional outbox event
  -> projection worker
  -> embedded OpenViking local-library resource write
  -> async processing task reaches terminal state
  -> projection receipt saved in PostgreSQL
```

The outbox payload should contain only:

- Panini organization/workspace ID;
- context entry ID and accepted version;
- stable context path and kind;
- accepted title/body or fact rendering;
- content hash;
- visibility realm/authorization partition;
- source/evidence IDs as opaque metadata, not raw evidence bodies;
- operation ID for idempotency.

Suggested URI layout:

```text
viking://resources/panini/context/files/<panini-context-path>
viking://resources/panini/context/facts/<panini-context-path>.md
```

Use a separate Panini-managed OpenViking workspace or root per Panini organization, plus visibility-specific subroots where needed. OpenViking's own ACLs are defense in depth, not the authority boundary. Never broaden access for retrieval convenience.

### Query contract

1. Panini authenticates the human or agent profile.
2. Panini computes the authorized organization, project, task, and context scopes.
3. The embedded adapter invokes OpenViking's local `find` implementation against only those roots.
4. OpenViking returns candidate URIs, scores, and abstracts.
5. Panini maps candidates to canonical context IDs.
6. Panini rechecks visibility and accepted version in PostgreSQL.
7. Panini loads final content from PostgreSQL and assembles the role-specific context pack.

This makes OpenViking an untrusted-but-useful locator. A stale vector, stale summary, or embedded-runtime failure cannot directly turn rejected or superseded text into accepted company context.

### Packaging profile

For the gated pilot, package the fork as a private runtime within the Panini image:

- pin and record the exact upstream commit plus Panini patch commits;
- expose no OpenViking port and start no OpenViking HTTP/MCP server or Web Studio;
- use a dedicated Panini-managed workspace per organization/visibility realm;
- disable or remove VikingBot, session capture, automatic memory acceptance, and broad administration/write tools from the shipped path;
- configure an approved local or hosted embedding/VLM provider through Panini;
- back up the workspace and any encryption material using Panini's deployment workflow;
- expose only Panini-owned health semantics and degrade safely to PostgreSQL-only context reads when the embedded runtime is unhealthy;
- publish the fork's complete corresponding source, notices, modification history, and build/install material when distributing or network-serving the combined AGPL program.

Keep the feature off by default until the licensing, model, storage, privacy, and quality gates are accepted.

## 9. Adoption gates

Treat OpenViking as **reference only** until all of these gates pass:

1. **License gate:** written decision on distribution, source-offer, notices, and whether Panini may offer the optional image in its self-hosting bundle.
2. **Canonical-state gate:** OpenViking can be wiped and rebuilt from PostgreSQL with identical accepted IDs, versions, hashes, and visibility partitions.
3. **Authorization gate:** zero cross-organization, cross-user, private-channel, or revoked-source leakage in adversarial tests.
4. **Privacy gate:** no raw prompts, full transcripts, raw Slack threads, secrets, local paths, or raw tool outputs are sent to OpenViking or its model providers.
5. **Quality gate:** on a frozen set of real company questions, hierarchical retrieval materially improves precision/recall or context-pack token efficiency over PostgreSQL full-text search and a simple `pgvector` baseline.
6. **Freshness gate:** accepted updates and revocations appear within the target lag; stale candidates are rejected by Panini's version recheck.
7. **Reliability gate:** duplicate delivery, embedded-runtime outage, processing failure, reindex, backup/restore, and version upgrade do not corrupt or block accepted Panini state.
8. **Cost gate:** embedding, semantic summary, rerank, storage, and operational costs are measurable and administratively bounded.

Minimum pilot metrics:

- retrieval precision@5 and recall@10 on frozen role-specific questions;
- unauthorized-result rate: exactly zero;
- stale-result-to-user rate: exactly zero after Panini reauthorization;
- context projection p95 lag;
- retrieval p95 latency;
- tokens loaded per correct answer;
- model cost per 1,000 accepted context changes;
- rebuild duration and recovery point objective;
- percentage of queries served successfully when OpenViking is unavailable.

## Final recommendation matrix

| Decision | Recommendation |
| --- | --- |
| Replace PostgreSQL with OpenViking | **No** |
| Store source events/evidence in OpenViking | **No** |
| Use OpenViking memory extraction as Panini acceptance logic | **No** |
| Expose OpenViking MCP directly to company agents | **No** |
| Copy its filesystem/L0-L1-L2/retrieval ideas | **Yes, as design references** |
| Add its server to Panini's mandatory stack | **No** |
| Build a provider-neutral `ContextIndex` seam | **Yes** |
| Embed the pinned OpenViking fork behind that seam | **Yes, after licensing and evaluation gates** |
| Make it the default retrieval provider now | **No; earn this through evaluation** |

OpenViking is best understood as a potentially valuable **context retrieval substrate beneath Panini**, while Panini remains the **context authority and organizational reconciliation layer above it**.

## Primary sources

- [Official OpenViking repository and README](https://github.com/volcengine/OpenViking)
- [Architecture overview](https://docs.openviking.ai/en/concepts/01-architecture)
- [Context types](https://docs.openviking.ai/en/concepts/02-context-types)
- [Context layers](https://docs.openviking.ai/en/concepts/03-context-layers)
- [Viking URI](https://docs.openviking.ai/en/concepts/04-viking-uri)
- [Storage architecture](https://docs.openviking.ai/en/concepts/05-storage)
- [Retrieval mechanism](https://docs.openviking.ai/en/concepts/07-retrieval)
- [Session management](https://docs.openviking.ai/en/concepts/08-session)
- [Transactions and recovery](https://docs.openviking.ai/en/concepts/09-transaction)
- [Encryption](https://docs.openviking.ai/en/concepts/10-encryption)
- [Multi-tenancy](https://docs.openviking.ai/en/concepts/11-multi-tenant)
- [Resource ACLs](https://docs.openviking.ai/en/concepts/15-acl)
- [Configuration](https://docs.openviking.ai/en/guides/01-configuration)
- [Deployment](https://docs.openviking.ai/en/guides/03-deployment)
- [Authentication](https://docs.openviking.ai/en/guides/04-authentication)
- [MCP integration](https://docs.openviking.ai/en/guides/06-mcp-integration)
- [Snapshots](https://docs.openviking.ai/en/guides/15-snapshot)
- [API overview](https://docs.openviking.ai/en/api/01-overview)
- [Agent integration capability reference](https://docs.openviking.ai/en/agent-integrations/16-capability-reference)
- [Official Docker Compose](https://github.com/volcengine/OpenViking/blob/main/docker-compose.yml)
- [Tagged v0.4.20 release](https://github.com/volcengine/OpenViking/releases/tag/v0.4.20)
- [Tagged Python package metadata](https://github.com/volcengine/OpenViking/blob/v0.4.20/pyproject.toml)
- [TypeScript SDK package metadata](https://github.com/volcengine/OpenViking/blob/main/sdk/typescript/package.json)
- [AGPL-3.0 license](https://github.com/volcengine/OpenViking/blob/main/LICENSE)
