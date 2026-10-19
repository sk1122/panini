# Main pipeline

Panini uses the work ontology in `src/domain/work-ontology.ts` and `src/domain/work-state.ts`. The observation worker selects it by default. The model is `gpt-6-luna` with medium reasoning; Voyage-4 provides budgeted work embeddings.

## Processing

Connectors or authenticated API requests store encrypted source observations. Outbox jobs deliver them to the worker. The observation agent retains assertions, attempts, artifacts, and task relationships. Scope and transition assessments propose state changes. Native checks validate evidence access, versions, authority, and receipts before accepted revisions are written. Ambiguous or unauthorized scope changes require review.

Task completion and observed result are independent. Exact source text and effective time stay linked to evidence. A source report does not establish independent verification.

## Operations

Configure `config/panini.observation-agent.yaml`, provider credentials, permitted source visibilities, and an explicit inference budget before starting a worker. Keep the server and worker on the same database, content key, and configuration. New installations disable provider processing.

Private source data, paid evaluation receipts, and previous replay databases remain local and are excluded from Git. Publishing this repository does not start a worker or reprocess existing records.

## Verification

Run `pnpm typecheck`, `pnpm build`, and the process E2E described in [verification](production-verification.md). The ontology fixture uses local provider stubs and omits the worker's ontology override to check default routing. It saves a JSON receipt and checks accepted data, source time, review rules, and restart behavior. Stub checks do not establish live model accuracy or company coverage.
