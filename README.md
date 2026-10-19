# Panini

Company memory for people and agents. Panini turns observations from connected tools into tasks, shared context, and a history of changes, with evidence attached.

Use the web app to review work. Use MCP to give an agent access to the same company context through a scoped profile.

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
    D --> E[Policy checks or human review]
    E --> F[Accepted tasks, context and history]
    F --> G[Web app and MCP]
```

A source report is evidence, not independent verification. A commit can show implementation progress without proving that a feature is deployed or works.

## A model of work

Panini connects five parts of company work:

| Record                | Meaning                                                     |
| --------------------- | ----------------------------------------------------------- |
| Task and scope        | What was requested and which requirements remain open       |
| Execution attempt     | What was tried, in which environment, and with what result  |
| Artifact              | What was produced, including its reference and revision     |
| Evidence assertion    | What a source actually reported, with exact supporting text |
| Assessment and review | Whether the evidence permits a change or needs human review |

Relationships connect attempts, outputs, supporting evidence, and conflicting reports. Source identity and authority are separate: a message that claims a requirement was removed cannot approve that change on its own.

Work completion and result are also separate. A finished investigation can have an unknown result. A completed experiment can have a failed result. Partial implementation does not complete a task whose remaining requirements lack evidence.

The worker uses `gpt-6-luna` with medium reasoning and budgeted Voyage-4 work embeddings. Scope and state assessments operate on retained evidence; native checks validate source access, versions, authority, leases, and call receipts before accepting writes. Exact quotes establish provenance, not whether a model's interpretation is correct.

Panini is under development. New installations keep connectors and provider processing disabled until configured. Task descriptions and context organization still need refinement. Complete company coverage and model accuracy on an unseen company are not established.

## Quick start with Docker

Requirements: Node.js 22 or later, Docker with Compose v2, and persistent disk space.

```sh
git clone git@github.com:sk1122/panini.git
cd panini
node scripts/selfhost.mjs init --url http://127.0.0.1:4141
node scripts/selfhost.mjs doctor
node scripts/selfhost.mjs start
```

Open [http://127.0.0.1:4141/setup](http://127.0.0.1:4141/setup). Use the generated installation token from your local `.env` file to create the first owner. Keep that file private. The installer does not overwrite an existing `.env`.

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

Create an agent profile in the app's **Agents** view and save its one-time enrollment secret privately. MCP is served at `/mcp` and requires the enrolled profile's Bearer token. Grant only the access the agent needs.

See [agent setup](docs/agent-setup.md), [Codex integration](integrations/codex/README.md), [Claude Code integration](integrations/claude-code/README.md), and [Slack integration](integrations/slack/README.md).

## Verify changes

```sh
pnpm typecheck
pnpm build
pnpm test
pnpm format:check
```

The full Vitest suite is not currently green. Some integration tests also require a disposable database or service. See [current verification results](docs/production-verification.md#repository-check-on-2026-10-20) and check environment requirements before running them.

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
| `src/http/`, `public/`      | Web app and assets                               |
| `src/mcp/`, `integrations/` | Agent access and harness integrations            |
| `scripts/`, `test/`         | Installation and repeatable verification         |
| `config/`, `docs/`          | Configuration examples and operating guides      |

Private source exports, credentials, backups, generated builds, and historical experiments stay outside version control. Runtime-linked assets and migration history remain included.

## Security and contributing

Read [SECURITY.md](SECURITY.md) before exposing an installation. Keep provider keys, enrollment secrets, source data, and database dumps out of issues and commits. Public operation requires HTTPS, protected backups, monitoring, and real connector checks.

See [CONTRIBUTING.md](CONTRIBUTING.md). Code uses tabs with width 4, blank lines around variable groups, and blank lines between functions. YAML uses spaces.

Licensed under [MIT](LICENSE).
