# Concrete provider processing decisions

Status: inspected code and official provider documentation; proposed changes, not implemented or benchmarked. This note narrows the earlier architecture. No private payloads were sent to external providers.

## Verified implementation

- `src/connectors/github/sync.ts`: polls branches, PRs/reviews, commit metadata and check runs. It does not fetch implementation files or diffs. Limits can leave incomplete coverage.
- `src/connectors/github/webhook.ts`: retains repository/event/action/kind/text but discards much artifact structure. Delivery IDs identify receipts, not stable work objects.
- `src/connectors/slack/socket-mode.ts`: stores message/thread/author identifiers and text, with edits/deletions. Conversations offer exact grouping, not guaranteed task identity.
- `src/connectors/notion/normalize.ts`: preserves page properties and blocks and renders document text; unknown mapped statuses default to backlog.
- `src/domain/team-ledger.ts` ingest: Notion rows remain source evidence, not direct authoritative Task updates.
- `src/relay/protocol.ts`: agent reports have optional workItemId, phase, outcome, artifactRefs and verification strings. These are attributed reports, not independent proof.

## Decisions by process

1. Capture: existing connectors, webhook deliveries plus periodic reconciliation; Postgres receipts and encrypted payloads. Deduplicate delivery and artifact revision separately.
2. Structure: provider-specific TypeScript adapters emit typed assertions with source field pointers. Missing fields stay unknown; defaults are not evidence.
3. GitHub artifacts: preserve repository/PR/check/deployment IDs, exact commit SHAs, author/reviewer identities and provider timestamps. Fetch canonical resource details after a notification when necessary. A failed fetch remains retryable and visibly incomplete.
4. Code context: use PR files/commit comparisons to discover changes, then fetch relevant source files at exact SHAs. Cache by repository, commit and path. Include configuration and callers where necessary; file presence does not prove runtime behavior. Handle binary/missing patches and API truncation as explicit gaps.
5. Conversation context: exact Slack thread retrieval, followed by lexical and embedding search of related work and sources. Search results are candidates, not identity decisions.
6. Interpretation: one structured LLM extraction over meaningful free text and its context; no model call to rediscover explicit IDs or provider status values. No custom small model prerequisite.
7. Linking: exact foreign keys and explicit references first; otherwise retain scored candidates using participant, time, project, branch and text evidence. No uncalibrated score treated as probability; ambiguous pairs await evidence or correction.
8. State: existing proposal/revision infrastructure extended to individual-field evidence and scope. Task acceptance conditions determine completion; PR/check state remains independently queryable.
9. Context/documents: typed scoped assertions plus versioned documents. Reverse evidence links identify affected sections. LLM proposes section edits with evidence; persist the actual accepted text rather than regenerate on read. Unaffected sections remain unchanged.
10. Memory/retrieval: scoped workspace records; explicit user/agent writes need authorization/version checks rather than semantic extraction. Retrieve current fields plus relevant historical evidence; exact lookup, Postgres full-text search and embeddings. Add reranking only after evaluating retrieval failures.

## GitHub concrete example

PR 123 targets branch B at commit abc. Check 456 succeeds against abc. Persist those facts through code. If a new commit def becomes the head, abc's success remains historical and does not establish def's checks. Link to company Task through an explicit reference if present. Otherwise retrieve candidate Tasks and related conversations; same author/topic alone is insufficient. Task completion depends on its recorded requested outcome. Source files at abc can support a bounded implementation explanation; merge or deployment state needs its own evidence.

## Verification before changing production

Build an isolated fixture with raw payloads and expected assertions for a PR/check pair, changed head SHA, duplicate delivery, delayed delivery, missing permissions, Slack request with ambiguous referent, Notion unmapped status and explicit agent Task ID. Verify deterministic assertions and retain a replay artifact. Then add reviewed real mixed episodes to evaluate free-text extraction, linking and complete product views. This research does not establish accuracy or coverage percentages.

## Official sources checked

- GitHub PR endpoints: https://docs.github.com/en/rest/pulls/pulls — file listing is paginated and capped at 3,000 files; treat cap as a coverage limit.
- GitHub contents: https://docs.github.com/en/rest/repos/contents — `ref` accepts commit/branch/tag; pin a SHA for reproducibility.
- GitHub checks: https://docs.github.com/en/rest/checks/runs — check results are associated with a Git reference and include head SHA; fork associations and pagination require care.
- Slack thread replies: https://docs.slack.dev/reference/methods/conversations.replies/ — thread retrieval depends on token access and pagination.
- Notion pages: https://developers.notion.com/reference/retrieve-a-page — page properties are distinct from block content.
- Notion blocks: https://developers.notion.com/reference/retrieve-a-block — inspect block content and children through the relevant endpoints.
