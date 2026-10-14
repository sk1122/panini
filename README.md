# Panini

Panini is the verified, temporal, permission-aware company-memory and context system between a company's source systems and the agents operated by its employees. It maintains people, work, projects, context, evidence, and their history, then compiles the authorized memory an employee's agent needs for a particular task and objective.

The canonical product definition and the contract that the interface and backend must preserve live in [PRODUCT.md](PRODUCT.md). Source observations, proposed changes, and accepted revisions remain separate, so neither a connector nor an agent can silently turn a plausible claim into company truth.

The public identity lives at [panini.work](https://panini.work).

## Current main pipeline

The main pipeline is ObservationAgent v26 with `gpt-6-luna`, medium reasoning, and Voyage-4 work embeddings. Each observation uses one conversation. Accepted task and context writes retain their source evidence and source time.

Use `config/panini.observation-agent.yaml`. The local environment and Compose defaults select this configuration. A worker requires an explicit inference budget, source visibility scope, and provider keys. This cleanup does not start a worker or connector.

The completed full replay is retained in `panini_replay_full_dataset_medium_20261005`: 2,963 records, 127 tasks, and 668 context entries. Full-corpus accuracy is unscored. Both medium gold runs and the latest gold labels are retained locally. See [the baseline record](docs/main-pipeline.md).

## What this checkout implements

This is a runnable, feature-level Phase 1–5 slice with personal accounts and tested self-hosting operations. See the [self-hosting guide](docs/self-hosting.md) and [release verification](docs/production-verification.md). A local test run is not certification of an external production deployment.

| Capability | Implemented and tested | Still required before production |
| --- | --- | --- |
| Trusted workspace | Secret-protected first owner; personal password accounts, persistent revocable sessions, company/profile settings, role-bound invitations/recovery, member disable, onboarding; evidence-backed Projects/Tasks and revisions | SSO/MFA, automatic email delivery; multi-tenant SaaS is out of scope |
| Work decisions | ObservationAgent v26 processes each observation in one conversation, retrieves work with Voyage-4, and records source-backed accepted task/context revisions | Independent full-corpus accuracy review and live connector/worker validation |
| Slack and GitHub | Slack channel capture and backfill; signed GitHub webhook ingestion; connected GitHub App with selected-repository branch/PR/commit sync and access-loss revocation | GitHub check-run permission, webhook delivery-age enforcement, credential lifecycle, and outage tests |
| Agent memory | Capability-scoped MCP profiles, `panini://` reads, opt-in encrypted per-agent workspace files, proposals, work reports, device enrollment, repository mappings, signed relay delivery | OIDC/OAuth, portable signed relay package, non-macOS keychain adapters, continuously supervised delivery |
| Trusted retrieval | Exact/reference lookup, bounded objective/project/task filters, citations, manifests, final authorization re-check, optional Jev ranking, and an opt-in OpenRouter embedding shortlist of accepted files before Jev reranking | Embedded OpenViking still needs explicit license approval and privacy/quality/operations gates; semantic quality and unknown-question abstention need wider evaluation |
| Evidence reconciliation | Bounded cross-source episodes, duplicate-Task links, connector-coverage gates on terminal state, and a convergent recurring check against cited active evidence | Wider live-corpus evaluation and operator controls for large drains |
| Operations | Private installer/doctor, non-root locked image, app/worker health, migrations, upgrade/recovery checks, actual backup/restore including encrypted data, optional Caddy HTTPS edge | External DNS/TLS validation, off-host backup scheduling, alerting, key rotation process, capacity/security review and release packaging |

The current server is Fastify with server-rendered HTML/CSS/JavaScript. The plan's Hono/React migration is not represented as complete. PostgreSQL is the persistent path; the in-memory adapter is for development and tests only.

## Run locally

### Installable operator CLI

The `panini` command is packaged for npm. After a release is published, install Node.js 22 or newer and Docker Compose v2, then use a dedicated, persistent directory:

```sh
mkdir panini-data
cd panini-data
npx --yes --package=panini-work@0.1.0 panini init --url https://panini.example.com
npx --yes --package=panini-work@0.1.0 panini start --https
npx --yes --package=panini-work@0.1.0 panini doctor --https
```

The command saves `.env` and the release files in that directory. The Docker Compose project is always named `panini`, so the database volume survives package upgrades. Run later commands from the same directory, or pass `--directory /absolute/path/to/panini-data`. Keep an encrypted off-host backup of `.env` and database dumps. For an upgrade, pin a reviewed newer package version and use `panini update --file /private/path/pre-update.dump --https` from the same directory. The npm package has not been published yet; the commands above become available after publication.

To inspect the local release archive before publication, run `node scripts/package-cli-e2e.mjs`; it writes a tarball and verification report under `artifacts/package-cli/`.

Publishing requires control of the `panini-work` name on npm and an authenticated npm account. From this checkout, run `pnpm install --frozen-lockfile`, `node scripts/package-cli-e2e.mjs`, then `npm publish --access public` after reviewing the archive. Publication is a separate step; building the archive does not make the `npx` commands available from the registry.

Requirements: Node.js 22 or newer, pnpm, Docker, and PostgreSQL 17 through the supplied Compose file. The scripts also run with an installed Bun toolchain, but Node remains the declared packaged runtime in this slice.

```sh
node scripts/selfhost.mjs init --url http://127.0.0.1:4141
node scripts/selfhost.mjs doctor
node scripts/selfhost.mjs start
```

`pnpm run setup init` fills missing `CONTENT_ENCRYPTION_KEY` and `APP_ADMIN_TOKEN` values in the selected environment file, sets mode `0600`, and never prints the secrets. It preserves existing values. `pnpm run setup doctor` reports whether the encryption key, admin token, and database URL are configured. Use `--env-file path/to/file` with either command when `.env` is not the target. Keep the content key stable and backed up: changing or losing it makes retained source payloads unreadable. Installed packages expose the same commands as `panini-setup init|doctor`.

Open [http://127.0.0.1:4141/setup](http://127.0.0.1:4141/setup) to create the first company owner using the installation secret in `.env`. Use the exact configured origin. PostgreSQL is exposed only on loopback port `55432` by default. Memory storage is development-only; production refuses to start without PostgreSQL, an encryption key, a strong installation secret and an explicit public origin.

For a development process instead of containers, install dependencies, run the database and migrations, then use Node's environment-file support. Do not source an untrusted environment file as shell code:

```sh
pnpm install --frozen-lockfile
docker compose up -d postgres
node --env-file=.env --import tsx src/db/migrate.ts
node --env-file=.env --import tsx src/main.ts
```

The application fails closed when PostgreSQL is configured without `CONTENT_ENCRYPTION_KEY`. Startup migrations use the checked-in Drizzle migration journal when `AUTO_MIGRATE=true`.

To build embeddings, set `EMBEDDING_PROVIDER=openrouter` and `OPENROUTER_API_KEY` in the private environment used by both app and worker. `OPENROUTER_EMBEDDING_MODEL` defaults to `voyageai/voyage-4`. Context files use document embeddings for a bounded shortlist before Jev reranking. Evidence episodes and existing Task/Project candidates use the same embedding-first, Jev-second order; query and document inputs use Voyage's asymmetric input types. Unchanged candidate vectors are cached within each process. Credential-like candidates are excluded from hosted retrieval. Context vectors are rebuildable and never accepted memory. If context embedding or Jev ranking fails, the authorized local retrieval fallback remains available. PostgreSQL uses a bounded exact-ID scan rather than an ANN/pgvector index. `/health/ready` reports configuration, not index freshness.

## Configure sources

Copy `config/panini.example.yaml` to an ignored local file and point `APP_CONFIG_PATH` at it. For Compose, keep the file under `config/` and set `TEAM_LEDGER_CONTAINER_CONFIG_PATH` to its `/app/config/...` path.

### Notion

Create a read-only internal integration, share only the intended pages/data sources, set `NOTION_TOKEN`, enable `notion`, and replace the example IDs and property names:

```yaml
notion:
  enabled: true
  pollIntervalSeconds: 300
  apiVersion: "2026-03-11"
  sources:
    - key: delivery-board
      kind: data_source
      resourceId: your-data-source-id
      ingestAs: task_board
      properties:
        title: Work item
        status: Stage
        owner: Owner
        dueDate: Due
        priority: Priority
        project: Project
        dependencies: Blocked by
    - key: handbook
      kind: page
      resourceId: your-page-id
      ingestAs: company_context
      contextPath: /sources/notion/handbook.md
    - key: workspace-pages
      kind: workspace
      ingestAs: company_context
      contextPath: /sources/notion/pages
```

`kind: workspace` uses Notion's paginated Search endpoint to discover every page shared with the integration. Explicit page roots and rows belonging to configured task-board data sources are excluded from that discovery pass, so they are not ingested twice. Child pages become independent source documents instead of being flattened into every ancestor. Notion can only return content that has been shared with the integration.

Polling paginates complete scans, hashes and deduplicates snapshots, persists per-resource cursor/high-water and repair status, reports installation health, and revokes retained content when an allowed page becomes archived, disappears from a successful repair scan, or becomes inaccessible. A failed/incomplete scan never treats unseen content as deleted. Imported task changes remain pending proposals for review. A Project is not created automatically from a task's free-text Project cell; an exact name or alias can nominate an existing Project link for review.

`company_context` pages stay in Evidence until the configured evidence interpreter emits cited findings. Accepted Context still goes through the proposal/revision writer; the source page itself is never copied directly into canonical memory.

### Slack

Create a customer-owned Slack app from [`integrations/slack/manifest.yaml`](integrations/slack/manifest.yaml). It enables Socket Mode and requests `channels:history`, `reactions:read`, and `users:read`; it does not request email access. After installing it, generate an app-level `xapp-` token with `connections:write`, invite the bot to the intended public channels, and run the secret-safe setup command documented in [`integrations/slack/README.md`](integrations/slack/README.md). Existing installations must be reinstalled after adding `users:read`. The command stores `SLACK_APP_TOKEN` and `SLACK_BOT_TOKEN` privately and writes the explicit channel allowlist. Choose reaction mode for deliberate capture or all-messages mode for administrator-approved channel ingestion:

```yaml
slack:
  enabled: true
  installationKey: default
  channels: [C0123456789]
  captureMode: all_messages
  captureReactions: [panini, bookmark]
```

In `reaction` mode, Panini ignores ordinary conversation and records only messages carrying an allowed capture reaction. In `all_messages` mode, startup backfills every accessible message and thread reply in the allowlisted channels, then Socket Mode records new messages. Later edit/delete events revoke the earlier encrypted body. In both modes Slack text remains untrusted evidence and cannot change accepted work on its own. The worker supervises reconnection and uses a PostgreSQL session advisory lease so only one process owns a configured Socket Mode connection at a time.

At worker startup, Panini synchronizes human Slack profiles and reconciles them with Notion task-owner identities under the organization. Provider IDs are retained separately from the canonical member: an existing provider identity wins, then an exact email match when a connector supplies one, then a unique normalized display-name match. Ambiguous names are never merged, and an opaque Slack user ID stays unresolved until a profile is available. Bots and app users are excluded, deleted users are retained as disabled identities, and Slack email is not requested. Member-directory health is tracked independently from message capture. A missing `users:read` grant does not block evidence reconciliation or terminal-state decisions when message capture itself is healthy. A message author is not automatically the task owner.

### GitHub

Register a **GitHub App**, not an OAuth App. For a public HTTPS origin such as `https://panini.example.com`, use these GitHub App settings:

- **Callback URL:** `https://panini.example.com/api/github/oauth/callback`
- **Webhook URL:** `https://panini.example.com/api/webhooks/github` (active, SSL verification enabled)
- **Request user authorization (OAuth) during installation:** off. Panini starts authorization itself with state and PKCE. Leave the optional Setup URL blank.
- **Repository permissions:** Metadata (implicit), Contents (read), Pull requests (read), Checks (read). Subscribe to Pull requests, Check runs, Installation, and Installation repositories. Deployment statuses are optional and require Deployments (read). Branches, commits, PR reviews, and checks are also captured during periodic REST sync.

Route the same HTTPS origin to the app on local port 4141, and open `/app` on that **same origin** before choosing **More → Integrations → Connect GitHub**. The admin session cookie must return to the same host after GitHub authorization. `localhost` and `127.0.0.1` are different cookie hosts: if the callback is `http://localhost:4141/api/github/oauth/callback`, start from `http://localhost:4141/app`, unlock that host, and begin Connect GitHub again. For a local OAuth-only test, `http://127.0.0.1:4141/api/github/oauth/callback` is also accepted when the browser starts at `http://127.0.0.1:4141/app`. GitHub cannot deliver webhooks to either loopback address.

Add these values to the ignored, mode-0600 `.env`. `GITHUB_CALLBACK_URL` must exactly match the Callback URL registered at GitHub. Generate a client secret and download a PEM private key in the GitHub App settings; base64-encode the PEM as one line for `GITHUB_APP_PRIVATE_KEY_BASE64` (for example, `base64 < /path/to/app.pem | tr -d '\n'`). Set the *same* randomly generated webhook secret in GitHub and `.env`. Do not paste these secrets into chat or the YAML file.

```dotenv
GITHUB_APP_ID=<numeric-app-id>
GITHUB_CLIENT_ID=<client-id>
GITHUB_CLIENT_SECRET=<client-secret>
GITHUB_APP_SLUG=<your-app-slug>
GITHUB_APP_PRIVATE_KEY_BASE64=<one-line-base64-of-pem>
GITHUB_CALLBACK_URL=https://panini.example.com/api/github/oauth/callback
GITHUB_WEBHOOK_SECRET=<same-secret-as-github-webhook-setting>
```

The GitHub App flow needs **no** `github:` block in `config/team-ledger.local.yaml`; leave the example `github.enabled: false` if present. GitHub's installation screen and Panini's repository picker establish the selected scope. Restart the app and worker with `docker compose up -d app worker`, then authorize, install or update the App on the organization with selected repositories, and finish the repository selection in Panini. If you installed it after opening the picker, choose **Connect GitHub** again to refresh the installation list. The legacy static YAML allowlist is for older webhook-only connections; do not enable it for this App flow.

Deliveries reach `POST /api/webhooks/github`. Panini verifies `X-Hub-Signature-256`, deduplicates `X-GitHub-Delivery`, ignores repositories outside the selected set, and revokes repository-scoped content after installation suspension/deletion or repository removal. The selected-repository backfill records bounded branch, commit, pull-request, review, and check snapshots when permissions allow. The connected `FetcchX/sozu-backend` installation has live branch/PR/commit snapshots; check-run coverage is degraded until the App receives Checks read permission.

## Evidence reconciliation

`POST /api/reconciliation/shadow` and `/api/reconciliation/shadow/draft` remain read-only checks. The main interpreter selects one coherent evidence episode per run, retrieves existing Task and Project candidates through Voyage followed by Jev, and can create, change, or mark duplicate Tasks, update Projects, and write durable Context. Findings must cite supplied evidence and pass route, confidence, owner, completion-evidence, and connector-coverage gates. All accepted changes still pass through audited proposals and revisions.

The worker periodically rechecks accepted Tasks, Projects, and Context against their cited active evidence. A durable signature of accepted version plus evidence makes the loop converge; unchanged state is not reprocessed. `pnpm intelligence:replay` provides a one-shot corpus drain with hard run and token limits, and stops on the first provider failure. Held-out semantic accuracy remains unverified.

## Agent and relay integration

The **Agents** view creates separate capability-scoped profiles for Codex, Claude Code, Hermes, Pi, and other Streamable HTTP MCP clients. Enrollment secrets are displayed once, can be rotated/revoked, and are required for `/mcp`. `context:read` grants the accepted context layer; the separate `source:read` grant allows on-demand discovery and reading of source documents and sections. Installable Codex and Claude Code host packages live under `integrations/`; the Claude hooks emit metadata-only, non-blocking relay reports. See [docs/agent-setup.md](docs/agent-setup.md).

The MCP surface includes `context_get`, `context_search`, `context_read`, `memory_read`, `source_read`, `work_search`, agent file list/read/write/delete, task/context proposal tools, `proposal_status`, and privacy-filtered `work_report`. Agents only propose changes; they never write accepted tasks or context directly. When Jev work classification is configured, each new proposal is checked against the agent-visible accepted tasks, context, and evidence: fitting proposals remain pending for review, invalid proposals are rejected with an audit record, and classifier failures fail closed. Context packs are objective-specific agent briefs: they lead with accepted-state rules; separate blocked, active, remaining, and recently completed work; resolve task dependencies; expose a budgeted categorized context catalog; expand only budgeted relevant entries; and finish with citations, omissions, freshness, and version hashes. `context_read` lazily expands accepted entries. For profiles with `source:read`, the pack also points to relevant source documents and matched sections. `source_read` rechecks access and returns a pinned source snapshot with an explicit untrusted-evidence warning.

The current local relay supports macOS only because private signing and outbox keys are stored in the login Keychain; it refuses a plaintext fallback on other systems. Its public config is mode `0600`, and queued report bodies are encrypted in SQLite.

```sh
pnpm build
./dist/src/relay/cli.js init --server http://127.0.0.1:4141
./dist/src/relay/cli.js enroll --device-id DEVICE_UUID
./dist/src/relay/cli.js enqueue --report report.json
./dist/src/relay/cli.js flush
./dist/src/relay/cli.js status
```

Reports must contain structured outcomes, artifact references, and verification only. Do not send prompts, transcripts, secrets, raw tool output, or unrelated files.

## Security boundary

- PostgreSQL source payloads are encrypted with AES-256-GCM in `source_event_contents`; immutable receipt metadata/hashes remain separately auditable.
- Revocation removes future payload reads without rewriting the immutable receipt.
- PostgreSQL installations use personal accounts and opaque, revocable `HttpOnly`, `SameSite=Lax` sessions (Secure on HTTPS). The installation secret is used for first-owner setup and service administration, not ordinary browser login. Cookie-authenticated writes require CSRF. The development memory adapter retains the legacy shared-token flow and must not be deployed publicly.
- Bearer authentication remains available for API automation. MCP always requires an active agent secret or the configured admin token, even when the local admin API is otherwise open.
- Put Panini behind HTTPS and an identity-aware proxy before any network exposure. The current local member/owner labels are not verified organization identities.

## Main HTTP surfaces

| Surface | Purpose |
| --- | --- |
| `GET /health/live`, `GET /health/ready` | Process liveness and workspace/storage readiness |
| `/api/session` | Local-admin cookie session exchange/status/logout |
| `/api/board`, `/api/tasks/*`, `/api/proposals/*`, `/api/projects/*`, `/api/project-proposals/*` | Accepted work, revisions, project/task proposals, review, rebase, and undo |
| `/api/work-graph`, `/api/workspace` | Projects, Tasks, typed work links, and workspace/connector health |
| `/api/context`, `/api/context/search`, `/api/context/entries/*` | Context tree, objective-specific retrieval, and lazy full reads |
| `/api/evidence/events`, `/api/audit` | Receipt metadata, explicit content revocation, and audit history |
| `/api/installations`, `/api/notion/sync`, `/api/github/connect/*`, `/api/webhooks/github` | Connector configuration/health, GitHub App connection, and provider ingress |
| `/api/agents`, `/api/devices`, `/api/repository-mappings` | Agent/device enrollment and repository scope |
| `/api/relay/work-reports`, `/api/reconciliation/shadow` | Signed local reports and gated, read-only work judgments |
| `/api/operations/replay/verify` | Read-only current-projection comparison against immutable revisions |
| `/mcp` | Authenticated Streamable HTTP company-memory and proposal surface |

## Development and verification

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm db:check
```

Migrations and matching snapshots live in `drizzle/`. Generate changes with `pnpm db:generate`; never edit only the SQL or only the snapshot.

Verify projections against the immutable revision ledger at any time:

```sh
pnpm replay:verify
pnpm replay:rebuild
```

The second command is a non-mutating shadow preview by default. Applying a rebuild takes transaction/advisory locks, refuses unexpected projection rows, and requires both maintenance mode and an exact organization confirmation:

```sh
PANINI_MAINTENANCE_MODE=true pnpm replay:rebuild --apply --organization-id ORGANIZATION_UUID
```

The PostgreSQL integration test is deliberately gated so the normal unit suite does not mutate an arbitrary database. Point it only at a disposable database:

```sh
PANINI_TEST_DATABASE_URL=postgres://.../panini_test \
CONTENT_ENCRYPTION_KEY=... \
pnpm test:postgres
```

The integration test covers clean migrations, idempotent import, connector checkpoints/access-loss repair, stale proposal/rebase/approval, atomic projection writes, undo, projects/legacy workstreams/links, retrieval, agent/device and repository mapping flows, encryption at rest, revocation, advisory-lease contention, audit projection, and shadow replay preview/apply.

Equivalent `bun run typecheck`, `bun run test`, and `bun run build` commands are also checked in this checkout. That verifies the repository under Bun; it does not yet replace the declared Node runtime or the target Hono/React architecture.

## Known boundaries

- Embedded OpenViking is disabled. Its retrieval seam exists, but importing/forking AGPL code requires an explicit AGPL-3.0 or commercial-license decision and the published privacy/quality/operations gates. PostgreSQL retrieval is the default and fallback. Set `RETRIEVAL_PROVIDER=jev` and `OPENROUTER_API_KEY` to opt into pinned `typesafe/jev-1.13` ranking through OpenRouter Decisions; only already-authorized accepted context excerpts (at most 1,500 characters per entry) leave Panini. A credential screen, 120-entry cap, 25-second deadline, and model-error fallback bound the external call. Jev never decides access, accepted state, or answerability.
- OpenRouter embeddings are a derived index, not accepted memory or proof that a result answers the question. The credential screen is a guardrail, not a general data-loss-prevention system. The provider/model can be changed through the adapter seam; other providers are not implemented. Files without a current vector remain directly readable and visible in the authorized catalog; when embedding fails entirely, Jev receives the full authorized pool.
- Notion source-document capture and evidence interpretation are enabled in the local profile. Raw pages are not automatically accepted as context; every finding must cite retained evidence and pass the proposal/revision boundary.
- The supported replay rebuild covers accepted task/context projections and regenerates deterministic work links. It is an operator maintenance path, not a substitute for a tested database backup/restore procedure.
- The outbox worker has durable leases, retries, and terminal dead-letter state. Notion has durable full-scan repair checkpoints; Slack has idempotent startup history/thread backfill but not yet an incremental history checkpoint. A broader operator repair/dead-letter UI is still missing.
- There is no production OIDC/RBAC/RLS tenant boundary, backup/restore workflow, key rotation procedure, or public-internet deployment profile.
- Live Slack full-channel capture, history/thread backfill, idempotent replay, Socket Mode reconnect, and evidence-backed local board projection have been exercised for one allowlisted channel. Live GitHub branch/PR/commit snapshots are present for the selected private repository. Check-run permission and production outage scenarios remain unverified.

See [docs/05-product-implementation-plan.md](docs/05-product-implementation-plan.md) for the full target architecture and release gates, [docs/04-integration-implementation-plan.md](docs/04-integration-implementation-plan.md) for connector sequencing, and [docs/research/openviking-assessment.md](docs/research/openviking-assessment.md) for the license/retrieval adoption gate.

## License

MIT. See [LICENSE](LICENSE). OpenViking code is not included.
