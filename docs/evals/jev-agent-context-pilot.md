# Jev agent-context pilot (pre-registered exploratory run)

Date: 2026-09-19. This is an internal, read-only diagnostic on the current Panini instance, **not** CompanyMemoryBench and not a production enablement decision. The earlier 5/10 agent-context rating was provisional and has no sealed scoring rubric; this pilot reports component metrics rather than silently converting them into a new 10-point score.

## Question set and gold accepted paths

These are the eight answerable questions and one unanswerable control used in the prior agent-context probe. Gold paths were checked against accepted context before this pilot. They are frozen before Jev calls.

| ID | Agent question | Must-retrieve accepted path(s) |
| --- | --- | --- |
| edge | Can a newly discovered causal edge propagate belief before source-verified calibration? | `/decisions/graph-core/edge-lifecycle-validation`, `/decisions/graph-core/propagation-ownership` |
| gdelt | What should GDELT be used for: live event triggers or historical depth? | `/constraints/data-collection/gdelt-live-vs-historical-use` |
| weekly | What is the current weekly mini-project writeup rule and deadline? | `/policies/project-reporting/weekly-mini-project-writeups` |
| verifier | Is the claim-to-node evaluation dataset sufficient to promote the verifier? | `/constraints/evidence-evaluation/verifier-dataset-and-model-independence` |
| source | How should an agent treat Notion and Slack source text versus accepted company memory? | `/company/product-contract.md` |
| instagram | What is the current Instagram ingestion adapter status? | `/constraints/data-ingestion/instagram-adapter-status` |
| prior | Is the raw prior ready to use as a final calibrated prior? | `/decisions/bayesian-core/raw-vs-debiased-prior` |
| stability | What evidence supports calling the evidence-generation semantics stable? | `/facts/evidence-generation/semantic-stability-failed` |
| unknown | What is the payroll key rotation policy for the Quasar team? | None; abstain |

## Systems and read boundary

- Baseline: current `/api/context/search` with the whole question as objective and explicit query, 10-entry limit, 30,000-character budget.
- Challenger: Jev `jev-1.13.0` scores each **currently accepted** context entry for each frozen question. One request per entry carries nine independent `Noul` questions. Input is limited to path, title, kind, and at most 1,500 characters of accepted body/value. Entries with credential-like patterns are excluded from external calls. No raw source events, transcripts, pending proposals, or credentials are sent.
- This is an admin-scope diagnostic because the current workspace has no scoped agent profile. It cannot certify employee visibility or revocation behavior. A production adapter must authorize before scoring, reauthorize before return, and fall back to the canonical PostgreSQL retriever on errors.
- No Jev score may alter accepted memory, task state, source coverage, or citation authority. No model-generated prose is part of this pilot.

## Frozen measurement and stop conditions

- Report exact-path recall@10 separately for baseline and Jev, plus complete-question success (all gold paths in top 10). Report the highest unknown-control score and whether a threshold of 0.70 would abstain. Show the gold-path scores to diagnose ranking, but do not tune a production threshold on nine cases.
- Report model ID, call count, total input tokens, elapsed time, API failures, candidate count, and exclusions. The API cost is computed from TypeSafe's documented current input-token price, not a billing receipt.
- Stop without enabling production if any call fails, a gold path is missing from the accepted index or excluded, the credential scan finds a high-risk entry, the result is not better than baseline, or the unknown control appears answerable at the provisional 0.70 threshold.
- The pilot's maximum is 120 accepted entries, one TypeSafe request per included entry, nine questions per request, 1,500 body/value characters per entry, and no retries. Do not publish Jev-specific performance without contractual clearance; TypeSafe's customer agreement restricts benchmark publication.

## Product follow-through

Independently of Jev, improve the deterministic context-pack budget and clarify that broad-query `ready` means a pack was assembled, not that the question is answerable. Add regression tests. A useful Jev result would justify a *separate* scoped retrieval adapter and larger sealed evaluation, not immediate production activation.

## Execution note

The initial local preflight inspected context-list metadata only, which does not include accepted entry bodies. That pass was invalid for the stated input boundary and was discarded. The script now opens each accepted entry's detail, verifies its current hash and lifecycle, and limits the text sent for scoring. The corrected pilot was run once. Results remain in the private review conversation, not this repository, pending contractual clearance to publish Jev-specific performance.
