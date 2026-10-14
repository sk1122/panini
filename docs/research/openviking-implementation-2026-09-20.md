# OpenViking implementation: ingestion, embeddings, and retrieval

**Source snapshot:** official OpenViking documentation and `main` source inspected 20 September 2026. GitHub was reachable for source inspection, but `git ls-remote` was not, so this is **not pinned to a verified commit**. Recheck behavior against the exact fork/version before implementation. This note describes upstream code, not a running Panini integration. Panini's [implementation plan](../05-product-implementation-plan.md) says OpenViking remains disabled behind license and product gates.

## What happens to added information

```text
resource → parse/split → viking:// tree and canonical files in AGFS
         → asynchronous semantic enrichment (directory L0/L1, file summaries)
         → embedding queue → vector-index records
query    → query embedding → vector candidates → optional deep traversal/rerank
```

The [extraction design](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/06-extraction.md) describes a parser, tree builder, and asynchronous semantic queue. For long text it splits by headings, merges very small sections, and places sections over its 1,024-token target into subdirectories. L0 and L1 are **directory-level** short and medium sidecar summaries, built bottom-up; L2 is the content/file level. Multimodal semantic extraction uses the configured VLM. AGFS stores the content/tree; vector records are a derived index, not the only copy of the source. [Storage design](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/05-storage.md), [extraction design](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/06-extraction.md).

The index does **not** simply embed every file's L0/L1 summary. Current [embedding code](https://github.com/volcengine/OpenViking/blob/main/openviking/utils/embedding_utils.py#L2229-L2450) makes L0/L1 vectors for directories and selected root/virtual-directory bodies. For L2 text, the default `content_only` strategy embeds raw text truncated to the configured input-token limit (4,096 by default); `summary_first` is an alternative. Images can use multimodal embeddings plus summaries; audio/video use summaries. [Embedding code](https://github.com/volcengine/OpenViking/blob/main/openviking/utils/embedding_utils.py#L2486-L2732), [embedding configuration](https://github.com/volcengine/OpenViking/blob/main/openviking_cli/utils/config/embedding_config.py#L3230-L3345). The queue's handler calls the embedding model, validates dimensions, and upserts records with URI, level/type, scalar filters, dense vector, and optional sparse vector. [Collection schema/handler](https://github.com/volcengine/OpenViking/blob/main/openviking/storage/collection_schemas.py#L62-L164), [embedding upsert](https://github.com/volcengine/OpenViking/blob/main/openviking/storage/collection_schemas.py#L636-L782).

Session-derived memories are a different input path. On session commit, messages are archived, then an asynchronous model summarizes/extracts memory candidates. Similar existing memories are prefiltered by vectors; a model can choose skip/create/merge/delete before files are written and vectorized, with a `memory_diff` record. That is OpenViking's own automatic memory mutation, **not** Panini's evidence-backed acceptance process. [Session design](https://github.com/volcengine/OpenViking/blob/main/docs/en/concepts/08-session.md).

## Models and search paths

The [configuration guide](https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/01-configuration.md) and [default embedding config](https://github.com/volcengine/OpenViking/blob/main/openviking_cli/utils/config/embedding_config.py#L3230-L3345) show a local dense `bge-small-zh-v1.5-f16` default when no embedding section is supplied, local AGFS/vector storage, cosine similarity, and `content_only` text embeddings. The VLM model/provider is unset by default; it must be configured for normal semantic enrichment. Query planning is optional and can fall back to the VLM; reranking is optional. Sparse/hybrid search requires a supported Volcengine/VikingDB *embedding provider* and a positive `storage.vectordb.sparse_weight`; do not assume a local BM25 fallback. [VLM defaults](https://github.com/volcengine/OpenViking/blob/main/openviking_cli/utils/config/vlm_config.py#L2036-L2085), [configuration guide](https://github.com/volcengine/OpenViking/blob/main/docs/en/guides/01-configuration.md).

The API names matter more than the general description of “hierarchical retrieval”:

| Call/path | Current source behavior |
| --- | --- |
| `find()` | Explicitly requests `QUICK`: one tenant-filtered vector search, followed by score thresholding/deduplication. It does **not** recursively descend the directory tree, even if a reranker is configured. [Call site](https://github.com/volcengine/OpenViking/blob/main/openviking/storage/viking_fs/_semantic.py#L176-L287), [quick path](https://github.com/volcengine/OpenViking/blob/main/openviking/retrieve/hierarchical_retriever.py#L92-L200). |
| `search()` | Can analyze intent when enabled and session context is present; otherwise it searches the raw query. With no reranker it defaults to `QUICK`; with a configured reranker it selects `THINKING`. [Call site](https://github.com/volcengine/OpenViking/blob/main/openviking/storage/viking_fs/_semantic.py#L342-L475). |
| `THINKING` | Searches for global L0/L1 entry points, then expands children through a priority queue; optional reranking can revise scores and failures fall back to vector scores. [Traversal](https://github.com/volcengine/OpenViking/blob/main/openviking/retrieve/hierarchical_retriever.py#L200-L303), [expansion/rerank](https://github.com/volcengine/OpenViking/blob/main/openviking/retrieve/hierarchical_retriever.py#L342-L538). |

One subtle default: `score_propagation_alpha = 1.0` makes the child score wholly determine the blended score; a parent contributes only if alpha is configured below 1.0. “Deep” therefore does not by itself mean parent relevance boosts descendants. [Retriever scoring](https://github.com/volcengine/OpenViking/blob/main/openviking/retrieve/hierarchical_retriever.py#L387-L538).

## Panini implication

The existing [assessment](openviking-assessment.md#retrieval) recommends `find` for a first, lower-model integration, and the [plan](../05-product-implementation-plan.md#9-context-compilation-and-openviking) keeps OpenViking as a disposable derived index behind Panini. That remains a reasonable **flat semantic locator** evaluation, but it would not test OpenViking's recursive hierarchy. A hierarchy evaluation needs an explicit `search`/`THINKING` path and pinned settings for reranking, traversal, score propagation, latency, and candidate budgets. In either path Panini must still filter visibility, reauthorize candidate IDs, and load accepted text from its canonical store; OpenViking-generated summaries and session memories cannot establish accepted company state. These are integration implications inferred from the cited source and Panini plan, not tested Panini behavior.
