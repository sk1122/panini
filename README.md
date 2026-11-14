# <img src="public/panini-mark.svg" alt="Panini logo" width="36" height="36" align="absmiddle"> Panini

Memory for your agents. Panini is an open-source work ledger for teams whose people run coding agents: shared company context, who is working on what, handoffs, and proof of what is done.

[![Verify](https://github.com/sk1122/panini/actions/workflows/verify.yml/badge.svg)](https://github.com/sk1122/panini/actions/workflows/verify.yml)

Use the web app to see and undo work. Use MCP to give an agent access to the same company context through a scoped profile.

[![Download the product demo](media/panini-demo.png)](https://github.com/sk1122/panini/raw/refs/heads/main/media/panini-demo.mp4)

[Download the 66-second MP4 demo](https://github.com/sk1122/panini/raw/refs/heads/main/media/panini-demo.mp4) · [Captions](media/panini-demo.srt). Recorded in the real local app with fictional data and simulated model responses. The demo agent makes a real scoped MCP request.

## Screenshots

**Home**: notes from agents, who is working on what, and what changed.

![Home](media/screenshots/home.png)

**Agents**: what each agent is doing, what it did last, what it cost, and what was blocked. Undo a whole session in one click.

![Agents](media/screenshots/agents.png)

**Changes**: agents and the nightly run apply changes at once. Undo any one of them here.

![Changes](media/screenshots/changes.png)

**Tasks**: everything the team and its agents are working on.

![Tasks](media/screenshots/tasks.png)

**Context**: decisions, plans and policies, with every earlier version.

![Context](media/screenshots/context.png)

## What it does

- Captures observations from Slack, Notion, GitHub, and authenticated APIs.
- Stores source payloads encrypted at rest and retains source time and provenance.
- Processes observations into task and context changes with version history.
- Tracks provider calls against explicit cost, call, and token budgets.
- Filters source access and exposes accepted context through the UI and MCP.
- Includes account setup, invitations, agent enrollment, and backup/restore tools.

```mermaid
flowchart LR
    A[Connectors and API] --> B[Encrypted source observations]
    B --> C[Outbox and worker]
    C --> D[Evidence and proposed changes]
    D --> E[Applied at once, undoable]
    E --> F[Accepted tasks, context and history]
    F --> G[Web app and MCP]
```

A source report is evidence, not independent verification. A commit can show implementation progress without proving that a feature is deployed or works.

## A model of work

Panini connects five parts of company work:

| Record             | Meaning                                                     |
| ------------------ | ----------------------------------------------------------- |
| Task and scope     | What was requested and which requirements remain open       |
| Execution attempt  | What was tried, in which environment, and with what result  |
| Artifact           | What was produced, including its reference and revision     |
| Evidence assertion | What a source actually reported, with exact supporting text |
| Assessment         | Why a change was made and which evidence supports it        |

Open a task to inspect its requested work, linked attempts and outputs, reported result, and original source. Long descriptions remain available without hiding the work requirements.

Relationships connect attempts, outputs, supporting evidence, and conflicting reports. Source identity and authority are separate: a message that claims a requirement was removed cannot approve that change on its own.

Work completion and result are also separate. A finished investigation can have an unknown result. A completed experiment can have a failed result. Partial implementation does not complete a task whose remaining requirements lack evidence.

The worker uses `gpt-6-luna` with medium reasoning and budgeted Voyage-4 work embeddings. Scope and state assessments operate on retained evidence; native checks validate source access, versions, authority, leases, and call receipts before accepting writes. Exact quotes establish provenance, not whether a model's interpretation is correct.

Panini is under development. New installations keep connectors and provider processing disabled until configured. Task descriptions and context organization still need refinement. Complete company coverage and model accuracy on an unseen company are not established.

## Quick start

Requirements: Node.js 22 or later.

```sh
npx panini-work
```

This starts Panini on your machine with a private embedded PostgreSQL and a demo company: tasks, two agents with sessions, a claim, a handoff note, a team note and a decision. No Docker and no API key. Sign-in details are printed once and saved in `.panini/quickstart/state.json`. Use `--empty` for no demo data, or `--database-url` to use an existing PostgreSQL.

Then connect your coding agent from its repository:

```sh
npx panini-work connect
```

It opens the browser, asks you to approve the agent, stores the token in your macOS keychain (elsewhere in `~/.panini/agent.json`, readable only by you), registers the MCP server for Claude Code with a helper that reads the token at request time, installs session hooks, and prints the setup line for other clients.

## Self-hosting with Docker

Requirements: Node.js 22 or later, Docker with Compose v2, and persistent disk space.

```sh
git clone https://github.com/sk1122/panini.git
cd panini
node scripts/selfhost.mjs init --url http://127.0.0.1:4141
node scripts/selfhost.mjs doctor
node scripts/selfhost.mjs start
```

Open [http://127.0.0.1:4141/setup](http://127.0.0.1:4141/setup). Use the generated installation token from your local `.env` file to create the first owner. Keep that file private. The installer does not overwrite an existing `.env`. The same commands are available as `npx panini-work selfhost <command>`.

```sh
node scripts/selfhost.mjs stop
```

Stopping services preserves the database. See [self-hosting](docs/self-hosting.md) for HTTPS, upgrades, backups, restore, and account recovery.

## Local development

Requirements: Node.js 22+, pnpm, and PostgreSQL 17. Use the dependency versions in `pnpm-lock.yaml`.

```sh
pnpm install --frozen-lockfile
cp .env.example .env
```

Edit `.env`: set `DATABASE_URL`, `APP_ADMIN_TOKEN`, and `CONTENT_ENCRYPTION_KEY`. Generate a content key with `openssl rand -base64 32`. Keep that key across restarts and backups; encrypted source data cannot be recovered without it. Set `PANINI_PUBLIC_URL` to the exact app origin.

```sh
pnpm build
node --env-file=.env dist/src/db/migrate.js
node --env-file=.env dist/src/main.js
```

The app listens at [http://127.0.0.1:4141](http://127.0.0.1:4141) by default. `pnpm dev` and `pnpm dev:worker` offer watch mode after the environment is supplied to the process.

### Enable observation processing

Use `config/panini.observation-agent.yaml`. Configure the required connector, set `intelligence.enabled: true`, and provide:

- `INTELLIGENCE_API_KEY` for the OpenAI endpoint.
- `OPENROUTER_API_KEY` for work embeddings.
- `JEV_WORK_ALLOWED_VISIBILITIES` for sources permitted to leave the installation.
- `PANINI_EVIDENCE_V2_VERSION` for the run version.
- `PANINI_EVIDENCE_V2_BUDGET_ID` for an explicit provider budget.

Keep `RETRIEVAL_PROVIDER=postgres` and `EMBEDDING_PROVIDER=disabled` for the default setup. The latter disables the separate accepted-file index, not the observation agent's work embeddings. The server and worker must share the database, content key, and configuration.

Create a budget before starting the worker. Supply these environment variables:

```dotenv
PANINI_EVIDENCE_BUDGET_DATABASE=your_database_name
PANINI_EVIDENCE_BUDGET_DEADLINE=replace_with_a_future_ISO_timestamp
PANINI_EVIDENCE_BUDGET_MAX_USD=1
PANINI_EVIDENCE_BUDGET_MAX_CALLS=100
PANINI_EVIDENCE_BUDGET_MAX_INPUT_TOKENS=1000000
PANINI_EVIDENCE_BUDGET_MAX_OUTPUT_TOKENS=100000
```

```sh
node --env-file=.env dist/src/maintenance/create-evidence-budget.js
```

Save the returned ID as `PANINI_EVIDENCE_V2_BUDGET_ID`, then start one worker:

```sh
node --env-file=.env dist/src/worker.js
```

Enabling processing can send permitted source text to the configured providers and incur charges. Budget limits are guards, not a provider invoice.

## Connect an agent

Use `npx panini-work connect`, or create a profile in the **Agents** view and follow its setup recipe. MCP is served at `/mcp`. Agents authenticate with their profile's secret, or with MCP OAuth 2.1 (PKCE, one-hour access tokens bound to `/mcp`, rotating refresh tokens); a member approves each new OAuth client in the browser. Grant only the access the agent needs.

What an agent does through Panini:

- `context_get` returns its session, the task it holds, the last handoff note on that task, unconfirmed team notes, and company context.
- `task_claim` and `task_release` say who is working on what. A claim expires after two hours without activity on the task, and starts planned work.
- `work_report`, `handoff_write`, `note_drop` and `decision_propose` add evidence, handoffs, shared notes and decision drafts.
- Every tool call is logged per agent session by id, never by content. The **Agents** view shows each session: owner, claimed task, reads, writes, denied calls, cost, and a one-click rollback of what the session wrote.

Claude Code hooks report session start and end to `/api/agent/hooks`. Point an agent's OpenTelemetry log export (OTLP over HTTP with JSON) at `/api/agent/otlp/v1/logs` with its token to see cost per session. Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the server to export each tool call as an `execute_tool` span.

See [agent setup](docs/agent-setup.md), [Codex integration](integrations/codex/README.md), [Claude Code integration](integrations/claude-code/README.md), and [Slack integration](integrations/slack/README.md).

## Changes apply at once

Nothing waits for a person. Agents and the nightly run create and change tasks, context and decisions directly. Each change records who made it, why, and its sources.

- **Changes** lists every recent change with an **Undo** button.
- **Agents** can undo everything one session did, or revoke the agent.
- Access rules still apply: an agent changes only what its profile can reach.

## Scheduled reconcile

The worker model no longer runs on every message. Once per `PANINI_RECONCILE_INTERVAL_HOURS` (default 24), or when an admin presses **Run now** on Home, it reads every new source observation since the last run. Agent claims, handoffs and reports apply immediately by rule. Threads are read in parallel (`PANINI_RECONCILE_CONCURRENCY`, default 3) and a `:panini:` reaction on a Slack message runs it at once. Set `PANINI_RECONCILE_MODE=live` for the previous per-message behaviour, and `PANINI_DIGEST_WEBHOOK_URL` to post the digest after each run. Any OpenAI Responses-compatible model works with `INTELLIGENCE_MODEL` plus `INTELLIGENCE_PRICE_INPUT_PER_MILLION` and `INTELLIGENCE_PRICE_OUTPUT_PER_MILLION`.

**Turn it on in the app:** an owner or admin opens **Settings → Nightly run**, picks a model (Claude Haiku 5.5, Claude Sonnet 5.5 or GPT-6 Luna) and pastes their own API key. Panini checks the key with the provider, stores it encrypted, and never shows it again. Each month gets a spending cap (`PANINI_MONTHLY_MODEL_BUDGET_USD`, default 10). `npx panini-work` starts the worker that runs it. On a server you can instead set `INTELLIGENCE_MODEL` and `INTELLIGENCE_API_KEY`; those take precedence. Prices are built in. A live run that closed a task from a Slack report and created a task from a chat request used 20 model calls and cost about $0.01. Task search uses keywords unless a Voyage embedding key is set.

## Rotating the content key

Set the new key in `CONTENT_ENCRYPTION_KEY`, a new `CONTENT_ENCRYPTION_KEY_VERSION` (for example `v2`), and keep the old key readable with `CONTENT_ENCRYPTION_PREVIOUS_KEYS=v1:<old key>`. New data uses the new key; old data still decrypts.

## Verify changes

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm format:check
```

The database-backed suite requires a disposable PostgreSQL database; browser tests also need Chromium. The database-backed suite passed locally on 2026-11-14 (206 passed, 2 browser tests skipped because Chromium was not installed). See [repeatable verification](docs/production-verification.md) for the environment and commands. These are fixture checks, not live provider accuracy results.

The process E2E check starts separate server and worker processes with local provider stubs. It checks accepted writes, source time, and restart behavior, and saves a JSON receipt under `artifacts/observation-agent/`.

```sh
PANINI_TEST_DATABASE_URL=postgres://user:password@localhost:5432/panini_e2e \
CONTENT_ENCRYPTION_KEY=your_test_key \
node scripts/observation-agent-e2e.mjs
```

Use a disposable database account that can create test databases. Run with `PANINI_TEST_ONTOLOGY=1` to check the default work ontology; the unflagged fixture checks legacy compatibility. These checks make no paid provider calls and do not measure model accuracy. See [verification](docs/production-verification.md).

## Repository map

| Path                        | Purpose                                          |
| --------------------------- | ------------------------------------------------ |
| `src/connectors/`           | Slack, Notion, and GitHub ingestion              |
| `src/intelligence/`         | Observation processing, model calls, and budgets |
| `src/domain/`               | Work rules, evidence, access, and contracts      |
| `src/store/`, `drizzle/`    | PostgreSQL storage and schema migrations         |
| `src/http/`, `public/`      | Web server, app shell and assets                 |
| `src/client/`               | Web app browser code (TypeScript)                |
| `src/mcp/`, `integrations/` | Agent access and harness integrations            |
| `scripts/`, `test/`         | Installation and repeatable verification         |
| `config/`, `docs/`          | Configuration examples and operating guides      |

Private source exports, credentials, backups, generated builds, and historical experiments stay outside version control. Runtime-linked assets and migration history remain included.

## Security and contributing

Read [SECURITY.md](SECURITY.md) before exposing an installation. Keep provider keys, enrollment secrets, source data, and database dumps out of issues and commits. Public operation requires HTTPS, protected backups, monitoring, and real connector checks.

See [CONTRIBUTING.md](CONTRIBUTING.md). Code uses tabs with width 4, blank lines around variable groups, and blank lines between functions. YAML uses spaces.

Licensed under [MIT](LICENSE).
