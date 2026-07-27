# Implementation status

Updated: 2026-07-24

## Current slice

Phase 1-5 production work remains in progress. The current UI slice is on
`app-phase1-5-pages`.

Implemented with synthetic tests:

- W3 URL reference/backfill/hash verification tooling.
- W1 two-role, deny-by-default identity and sensitivity model.
- Local aggregate audit/billing/findings/D-12 dashboard.
- Secure dashboard foundation: OIDC JWT verification, database-backed role checks,
  safe readiness, correlation/problem responses, and hash-chained access audit.
- Reliable-processing foundation: canonical payload hashes, transaction-scoped outbox
  writer, leased publisher/retry/DLQ, inbox deduplication/integrity checks, and mutation
  idempotency.
- CI and tracked-file secret checks.
- Routed React application with Home/Profile, overview-only, calls/evidence, findings,
  billing, D-12 reports, and operations pages.
- Page-scoped authenticated aggregate APIs and production static-asset serving.
- Runtime release gates that fail closed for uncalibrated/K2-K3 automation.

Not run/applied:

- Migrations 0003/0004 against the real database.
- OIDC integration with Kairali's identity provider.
- Deployment, production data mutation, rate-card publication, calibration, or automated
  financial/health decisions.
- Write-side Phase 2-5 services for ingestion, automated classification/re-check,
  deterministic recalculation/finalization, reconciliation, and snapshot persistence.

## Release blockers

- D-03 approved/published rate card and versioned deterministic recalculation.
- Calibration and per-language/per-finding thresholds.
- Named clinical/safety owner before K2/K3 zero-human activation.
- Full W3 baseline result and remediation of missing/altered evidence.
- Retention/legal-hold/redaction approval and enforcement.
- Carrier-independent evidence availability remains constrained.
- Delegation target/contract remains open.
- Production infrastructure, backup/restore, observability, load/security tests, and
  historical plus live shadow cycles.

No production-readiness claim is made while these remain open.

## Verification evidence for this branch

- `npm run check`: passed; secret scan, backend/frontend TypeScript, production web
  build, **113** tests passed, and the isolated-MySQL integration test was correctly
  skipped without its gated socket.
- Migrations 0003 and 0004: applied successfully to a disposable MySQL 9.6 database.
- Audit writer integration: two synthetic events produced distinct hashes,
  `chain_ok`, and `head_ok`.
- The latest frontend install reported two high-severity advisories, but the approved
  environment did not permit sending the dependency manifest to npm's live advisory
  endpoint for attribution. The offline cache reported zero. Treat the live result as
  unresolved and require the private CI audit before release.
- Migration 0005: applied successfully to a disposable MySQL 9.6 database.
- MySQL reliability integration: passed with one published message, one completed inbox
  record, and one completed/replayable idempotency record.

## D2/D3 closure status

The reliability foundation is now implemented, but **D2 is not closed** until actual
ingestion and mutation write paths use it in production. D3 remains open: historical calls
still lack append-only `call_event` history and projection rebuild behavior.

## Phase 1-5 truth

| Phase area | Current status |
|---|---|
| 1. Security/reliability | Implemented in code; real migrations, OIDC, and infrastructure rollout remain gated |
| 2. Ingestion/evidence | Real aggregate UI exists; live ingestion is not yet moved onto the new outbox/idempotency path |
| 3. Evidence/audio integrity | URL backfill and hash tooling exist; full baseline remediation remains open |
| 4. Findings automation | UI/API exist; calibration, thresholds, automated re-check, and decision audit remain incomplete |
| 5. Billing/reporting | UI and D-12 projections exist; D-03, recalculation, finalization, and persisted snapshots remain incomplete |

The application is useful for controlled monitoring, but it is not yet a
production-authoritative audit/billing engine.
