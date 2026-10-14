# Integration research: Notion, Slack, Claude Code, and MCP

**Checked:** 2026-09-12  
**Scope:** official Notion, Slack, Anthropic, and Model Context Protocol documentation only.

## Recommendation

Build four deliberately separate adapters around one evidence and proposal core:

1. A read-only, periodically scheduled Notion importer for durable company intent, with webhooks as an optional acceleration path.
2. A channel-allowlisted Slack connector for selected discussion-derived work signals.
3. A local Claude Code relay that emits low-sensitivity lifecycle metadata automatically and sends text only through an explicit user/agent proposal action.
4. One authenticated MCP server exposing `get_context`, `get_task`, and `propose_task_change` to Claude Code, Codex, and future agent clients.

The control plane should never equate “the connector can read this” with “every employee or agent may receive this.” Preserve the source visibility realm on every event, snapshot, signal, proposal, and context-pack fragment. The task board remains a governed projection: `propose_task_change` creates a proposal and the server-side policy engine decides whether it can be applied or requires owner review.

## What is a supported surface?

| System | Build on | Do not build on |
|---|---|---|
| Notion | Versioned REST API, connection capabilities/content access, signed webhook events | Webhooks as exact diffs or as guaranteed current/ordered state |
| Slack | Events API, Socket Mode or signed HTTP delivery, OAuth scopes, stable provider IDs | Workspace-wide passive collection, user-token omniscience, delivery order, exactly-once delivery |
| Claude Code | Documented hook event JSON, Agent SDK/CLI structured output, skills, plugins, MCP configuration | Parsing transcript JSONL records as an application contract |
| MCP | Current specification and official TypeScript SDK, JSON Schema tool contracts, OAuth for HTTP | Implicit per-connection authorization/state or trusting model-supplied identity/annotations |

Claude Code does store sessions locally, but Anthropic explicitly says the JSONL entry format is internal and can change between releases. The documented integration choices are hook fields, `/export`, structured `claude -p` output, or the Agent SDK. Hooks expose `transcript_path`, but that is a locator, not a stable transcript schema. [Claude Code session interfaces and transcript warning](https://code.claude.com/docs/en/sessions)

## 1. Notion connector

### Installation and permissions

For the first single-company deployment, use a team-owned **internal connection** with only **Read content** and explicit access to configured handbook/project/task roots. Internal connections use a static workspace token and can access only pages shared with the connection; child content is accessible beneath a shared root. A future multi-tenant edition should use a public OAuth connection and its page picker. Keep tokens in the deployment secret store, never source control. [Notion authorization](https://developers.notion.com/guides/get-started/authorization), [connection capabilities](https://developers.notion.com/reference/capabilities)

Pin the `Notion-Version` header. The current official examples use `2026-03-11`; store the API version with each raw payload because Notion has already replaced several database concepts/events with data-source equivalents across versions. [Notion version changes](https://developers.notion.com/reference/changes-by-version)

### Initial import

Walk only configured roots and recursively page through their pages, blocks, data sources, and relevant properties. Normalize stable provider IDs, parent relationships, URL, last-edited time, selected owner/project/dependency fields, and a canonical snapshot hash. Do not grant update/insert capabilities in the MVP: task changes belong in the control-plane proposal ledger, not back in Notion yet.

Respect Notion's average rate limit of three requests per second per connection and obey `Retry-After` on `429`. [Notion request limits](https://developers.notion.com/reference/request-limits)

### Scheduled reconciliation and optional webhooks

Use periodic polling as the default self-hosted mode. Each connection stores its configured interval, last attempted run, last successful run, and per-resource snapshot hashes. Scheduling must be overlap-safe, retry with backoff, and emit source events only when a snapshot is new or changed. A full repair scan periodically re-walks the configured roots.

Webhooks are an optional freshness optimization. Notion requires a publicly reachable HTTPS endpoint; localhost/private-only ingress is unsupported. Verify `X-Notion-Signature`, which is an HMAC-SHA256 signature over the request body using the webhook verification token. [Notion webhook setup and validation](https://developers.notion.com/reference/webhooks)

Every webhook has a unique event `id`, timestamp, installation/subscription identifiers, authors, entity, and attempt number. Insert the raw envelope first with a unique constraint on `(provider, installation_id, provider_event_id)`, acknowledge, and process asynchronously. [Notion event fields](https://developers.notion.com/reference/webhooks-events-delivery)

A webhook is a change notification, not full content or an exact diff. Events can be aggregated, delayed, retried, and delivered out of order; the follow-up REST read may show a later state. Therefore retain:

- the immutable webhook envelope;
- the fetched snapshot, retrieval time, and hash;
- a source link and visibility label;
- an epistemic label such as `latest_state_after_event`, never `exact_change`.

Notion recommends fetching the latest API state, says most events arrive within a minute and should arrive within five minutes, and may retry failed delivery up to eight times with the final attempt roughly 24 hours later. [Notion event delivery semantics](https://developers.notion.com/reference/webhooks-events-delivery)

Run a periodic re-snapshot of the allowlisted roots to discover changes, repair gaps, and detect permission changes. A webhook, when enabled, merely requests an earlier run of the same reconciliation path.

## 2. Slack connector

### MVP transport and scope profile

Use a customer-owned Slack app with a bot token and **Socket Mode** for the self-hosted MVP. Socket Mode is an outbound WebSocket and does not require a public Slack request URL. It carries normal Events API payloads inside an envelope with an `envelope_id` that must be acknowledged. URLs refresh regularly, disconnects are expected, and event distribution across concurrent connections is not ordered. Socket Mode apps cannot currently be listed in the public Slack Marketplace, so isolate transport from normalization and support signed HTTP Events later. [Slack Socket Mode](https://docs.slack.dev/apis/events-api/using-socket-mode/)

Start with explicitly selected public project channels and bot scopes only:

- `message.channels` with `channels:history`;
- the minimum channel identity/membership read scope needed by the selected workflow;
- no `im:history`, `mpim:history`, user tokens, `files:read`, or email scope.

Private channels should be a later, explicit administrator opt-in with the bot invited to each channel. Slack separates public-channel, private-channel, DM, and multiparty-DM message subscriptions and history scopes. [Slack message events and scopes](https://docs.slack.dev/reference/events/message/), [Slack scopes](https://docs.slack.dev/reference/scopes/)

For the pilot, prefer an explicit capture gesture, such as a designated reaction or slash command, over treating every message as evidence. Fetch only the selected message/thread, derive a typed signal, and keep its Slack channel/message identifiers as the durable source pointer.

### Delivery, recovery, and privacy

For Socket Mode, acknowledge the `envelope_id` immediately after durably inserting the envelope. For a future HTTP receiver, verify Slack's HMAC signature against the raw body and reject request timestamps more than five minutes from local time. HTTP Events must receive a `2xx` within three seconds; Slack retries failures three times on an exponential schedule and supplies retry headers. [Slack request verification](https://docs.slack.dev/authentication/verifying-requests-from-slack/), [Events API delivery and retries](https://docs.slack.dev/apis/events-api/)

The top-level Events API `event_id` is globally unique. Use `(provider, event_id)` as the event idempotency key and keep `team_id`, `enterprise_id`, `event_time`, inner `event_ts`, and Socket Mode `envelope_id` separately. [Slack Events API callback fields](https://docs.slack.dev/apis/events-api/)

Use `conversations.history` only for selected channels and bounded gap recovery. A bot token can retrieve history only for conversations it is a member of. [Slack conversations.history](https://docs.slack.dev/reference/methods/conversations.history/)

Slack's stated privacy model is that an app must not expose private-channel names, messages, or files to someone who could not access them in Slack. Store a source visibility realm with every record and re-check it before compiling context. Slack also restricts bulk export/backup patterns and using Slack API data to train an LLM; commercial distribution needs a focused product/legal review. [Slack app privacy guidelines](https://docs.slack.dev/slack-marketplace/slack-marketplace-app-guidelines-and-requirements/), [Slack API Terms](https://slack.com/terms-of-service/api)

Keep revocable content separate from immutable provenance: the ledger may retain provider IDs, timestamps, hashes, typed signals, and tombstones, while encrypted message bodies/excerpts follow source deletion and retention policy. Model edits and deletions as later evidence events rather than silently rewriting the original receipt.

## 3. Claude Code local relay

### Stable observation surface

Claude Code hooks are an official lifecycle surface. Relevant events include `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `TaskCreated`, `TaskCompleted`, `Stop`, `PreCompact`, `PostCompact`, and `SessionEnd`. Hook JSON includes common fields such as `session_id`, `prompt_id` on supported versions, `cwd`, `permission_mode`, and event-specific identifiers. `TaskCreated`/`TaskCompleted` expose task ID, subject, and optional description; `SubagentStop` and `Stop` expose `last_assistant_message` without requiring transcript parsing. [Claude Code hooks reference](https://code.claude.com/docs/en/hooks)

Treat the hook interface as versioned even though it is documented: pin a minimum supported Claude Code version, record the client version during install/health checks, accept unknown fields, and make each event adapter tolerant of absent optional fields.

### Default privacy policy

The automatic hook path should emit only:

- pseudonymous device and session IDs;
- an administrator-mapped project ID instead of raw `cwd`;
- hook event type and local event time;
- task/subagent/tool identifiers and coarse tool class where useful;
- success/failure state and a locally generated relay event ID.

Do **not** send prompt text, `tool_input`, `tool_response`, command contents, file contents, `last_assistant_message`, `transcript_path`, or raw filesystem paths by default. A local policy may explicitly permit selected fields. Text should normally enter the company system when the user invokes an installable skill and sees the resulting MCP proposal call.

This matters because hook commands run with the full permissions of the user's OS account. Anthropic recommends validating inputs, using absolute paths, blocking path traversal, and skipping sensitive files. Repository hook settings also have workspace-trust nuances, especially in non-interactive `-p`/SDK sessions. [Claude Code hook security](https://code.claude.com/docs/en/hooks#security-considerations)

### Relay process and offline behavior

Package a small local relay/daemon and a thin hook executable:

```text
Claude hook JSON on stdin
  -> local policy/redaction
  -> durable encrypted outbox insert
  -> immediate success
  -> daemon batches outbound uploads
  -> server dedupes relay_event_id
```

The hook must only enqueue locally, not wait on network or model inference. Claude Code's `async: true` command hooks have no built-in deduplication, and unfinished async hooks are killed when a non-interactive `claude -p` session tears down. A resident daemon or durable handoff is therefore required if delivery must outlive the session. [Claude Code async hook behavior](https://code.claude.com/docs/en/hooks#run-hooks-in-the-background)

Use at-least-once relay upload with an idempotency key created and persisted before the first send. Back off with jitter, cap the encrypted local queue by age and size, surface a health warning before dropping anything, and never block Claude work while offline. Credentials should be device-bound, revocable, and stored in the OS credential store, not a project file.

Cache the last authorized context pack locally for optional offline startup. A launch-time `SessionStart` **MCP-tool hook is not reliable** because Claude Code fires initial `SessionStart` before MCP servers are available; Anthropic recommends a command hook for first-turn startup work. The command hook can inject a small cached, signed context summary, while the skill calls live `get_context` once MCP is available. [Claude Code MCP hooks at SessionStart](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields)

### Do not parse transcript JSONL

Claude Code stores plaintext session transcripts under `~/.claude/projects/` for 30 days by default, configurable with `cleanupPeriodDays`. The files are useful for resumption, but their per-line JSON format is explicitly internal and may change on any release. The transcript is also written asynchronously and may lag the in-memory conversation when a hook fires. Use documented event fields, `/export`, `claude -p --output-format json|stream-json`, or the Agent SDK for structured workflows. [Claude Code data usage and local retention](https://code.claude.com/docs/en/data-usage), [session script interfaces](https://code.claude.com/docs/en/sessions), [hook common fields](https://code.claude.com/docs/en/hooks#common-input-fields)

## 4. Skills and MCP integration

### Claude Code packaging

Ship one Claude Code plugin that contains:

- the MCP server definition;
- the local relay hooks;
- `/company-context`, `/company-task`, and `/company-propose` skills;
- an installer/health check that registers the device and verifies policy.

Claude Code officially supports project, personal, enterprise, and plugin skills. A `SKILL.md` is loaded on demand and may be invoked directly; project skills can be committed, while plugin skills are namespaced and can travel with MCP and hooks. [Claude Code skills](https://code.claude.com/docs/en/skills), [Claude Code plugins](https://code.claude.com/docs/en/plugins)

For early development, a project-scoped `.mcp.json` is acceptable and shareable through version control, but Claude Code prompts users before enabling project-scoped MCP servers. Keep secrets out of that file and use environment expansion or OAuth. Production enterprise deployments can use managed MCP configuration. [Claude Code MCP scopes and approval](https://code.claude.com/docs/en/mcp), [managed MCP configuration](https://code.claude.com/docs/en/managed-mcp)

### MCP deployment contract

The current MCP specification is `2026-07-28`, and the official TypeScript SDK v2 is its stable implementation line. The v2 HTTP handler serves the modern protocol and, by default, legacy 2025-era stateless clients as well. Use that dual-era path until every supported agent client is verified. For local-only development use stdio; for the shared self-hosted control plane use authenticated Streamable HTTP. [MCP transport overview](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports), [official TypeScript SDK server package](https://github.com/modelcontextprotocol/typescript-sdk/tree/main/packages/server), [SDK protocol-version compatibility](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/protocol-versions.md)

HTTP MCP authorization should follow the MCP OAuth profile: Protected Resource Metadata, least-privilege scopes, OAuth 2.1, bearer tokens in the `Authorization` header on every request, resource/audience binding, and `401` versus `403` scope handling. Stdio should obtain credentials from the process environment rather than run the HTTP OAuth flow. [MCP authorization](https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization)

Recommended scopes:

- `context:read`
- `task:read`
- `proposal:create`
- a separate `evidence:excerpt` only when policy allows text transfer

Authorization is enforced from the authenticated caller and source ACLs on every request. Never accept `actor_id`, role, or source visibility from tool arguments as authority.

### Tool contracts

MCP tools are model-controlled, so the protocol recommends a human-visible invocation/confirmation path for sensitive operations. Servers must validate inputs, enforce access control and rate limits, and sanitize outputs. Tools support JSON Schema input/output and structured results. [MCP tools and security](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

Use these contracts:

```ts
get_context({
  objective: string,
  project_id?: string,
  task_ids?: string[],
  max_items?: number
}) -> {
  context_pack_id: string,
  revision: string,
  generated_at: string,
  summary: string,
  projects: ProjectContext[],
  tasks: TaskContext[],
  constraints: PolicyConstraint[],
  evidence_links: VisibleEvidenceLink[]
}

get_task({ task_id: string }) -> {
  task: TaskProjection,
  revision: string,
  dependencies: Dependency[],
  visible_evidence: VisibleEvidenceLink[],
  pending_proposals: ProposalSummary[]
}

propose_task_change({
  client_event_id: string,
  task_id?: string,
  base_revision?: string,
  changes: ProposedFieldChange[],
  rationale: string,
  evidence_refs: string[],
  approved_excerpt?: string
}) -> {
  proposal_id: string,
  status: "pending_review" | "auto_approved" | "rejected",
  applied_revision?: string,
  review_url?: string
}
```

`client_event_id` is mandatory and unique per authenticated installation/device. `base_revision` makes stale writes visible. The server checks that every evidence reference is both visible to the caller and eligible for the proposed field. Even when policy auto-approves a low-risk change, the tool only submits the proposal; it never bypasses the proposal ledger.

Return compact structured content plus a human-readable text fallback for older clients. For larger context packs, return an authorized MCP resource link rather than flooding model context. MCP has no modern protocol-level session on which application state or authority can safely depend, so proposal/context IDs are explicit opaque handles and authorization is rechecked on each call. [MCP structured tool results and stateful-tool guidance](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)

Treat all Notion and Slack text as untrusted evidence, never as policy or agent instructions. Preserve provenance boundaries in tool output and strip control characters/unsafe rendering, but rely on server-side authorization and policy rather than prompting to prevent exfiltration.

## 5. Suggested implementation sequence

1. **Core contracts:** installations, source visibility realms, immutable event receipts, revocable encrypted content, normalized signals, proposals, revisions, policy decisions, and context packs.
2. **Notion import:** read-only import of configured organization roots; snapshot/version/hash; configurable field mapping; periodic re-snapshot.
3. **Durable ingress:** signed Notion webhook and Slack Socket Mode receiver; atomic dedupe-before-ack; queue-backed processors.
4. **Slack pilot:** explicit reaction/command captures one selected message or thread and creates a typed blocker/progress signal.
5. **MCP server:** dual-era official TypeScript SDK; authenticated `get_context`, `get_task`, and `propose_task_change`; field-level policy and audit records.
6. **Claude package:** plugin skills plus hook-to-local-relay adapter; metadata-only defaults; encrypted offline outbox; device enrollment and revocation.
7. **Vertical proof:** import organization intent from Notion, observe one selected Slack or Claude event, create the correct evidence-backed proposal, approve/apply it, then have Claude call `get_context` and receive the new revision.

## 6. Required failure and security tests

- Duplicate, retried, aggregated, delayed, and out-of-order Notion events.
- Duplicate Slack `event_id`, Socket Mode reconnect, missed acknowledgement, edited/deleted message, and bounded history recovery.
- Crash after durable receipt but before acknowledgement; crash after acknowledgement but before interpretation.
- Source access revoked after ingestion; private source referenced by a less-privileged context request.
- Revoked/expired Notion, Slack, relay-device, and MCP tokens.
- Claude relay offline across restarts, duplicate upload, full queue, older hook payload, missing optional fields, and `claude -p` teardown.
- Prompt injection in Slack/Notion text, forged evidence references, stale `base_revision`, and an agent attempting a field change outside its authority.
- Policy result reproducibility: the proposal records policy version, input evidence IDs, decision, reviewer, and applied revision.

## MVP boundary

The MVP should **not** include DMs, private Slack channels by default, files, user tokens, direct Notion writes, central transcript upload, transcript JSONL parsing, arbitrary full-text workspace search, or agent tools that mutate a task directly. Those are later features with separate consent, rights, retention, and authorization design.
