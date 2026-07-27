# Implementation status

## Full-call re-audit preflight — 2026-07-27

- ✅ Read-only production preflight confirms only 224/43,245 calls have a
  completed classification and only 96 have a conversation-end timestamp.
- ✅ Read-only shadow pipeline now performs fresh proxy fetch, evidence hashing,
  Whisper timestamp transcription, natural-block merging, structured
  GPT-4o-mini classification, 60-second wrap-up grace, and deterministic billing
  projection.
- ✅ Five authorized real calls completed 5/5 without processing failures; no
  database writes or transcript/customer content were emitted.
- ⚠️ Only 16,371 calls have recording URLs. The other 26,874 are unauditable and
  must remain explicitly accepted-as-billed/unverified at cycle close.
- ⚠️ All 43,245 calls currently default to K2. K2/K3 final automation remains
  inactive because the clinical/safety owner is still unnamed.
- ⚠️ Calibration is incomplete, the only rate card is draft, and migration 0006
  has not been applied. A regenerated bill can therefore only be provisional.
- ❌ The resumable production writer/full-batch executor has not been activated.
  See `docs/REAUDIT_RUNBOOK.md`.

Updated: 2026-07-27

## Current slice

Phase 1-5 production work remains in progress. The current implementation slice is on
`feature/billing-v2-engine`.

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
- Idempotent administrator provisioning with an explicit K3 sensitivity grant
  and a compatible audit entry; application-owned passwords remain prohibited.
- Finance-approved KServe billing V2 pure core using verifier-derived conversation end,
  60-second wrap-up grace, fixed-precision INR calculations, and exact boundary tests.
- Calibration/threshold/automated-recheck and K2/K3 activation gates in the billing
  decision path.
- Reproducible per-call decision traces containing model, classifier/deterministic
  rulesets, confidence/threshold, evidence hashes, timestamp, and every money
  intermediate.
- Additive migration 0006 plus a transactional append-only MySQL writer that supersedes
  legacy calculations, records the automated decision, and enqueues an outbox event.
- Dashboard authority now requires traced final calculation coverage; publishing a rate
  card cannot relabel the 43,245 legacy vendor-duration calculations as authoritative.

Not run/applied:

- Migration 0004 against the real database. Migration 0003 is present.
- OIDC integration with Kairali's identity provider.
- Deployment, production data mutation, rate-card publication, calibration, or automated
  financial/health decisions.
- Write-side Phase 2-5 services for ingestion, automated classification/re-check,
  full-batch recalculation orchestration, reconciliation, and snapshot persistence.
- Migration 0006 and the verified-billing writer against the real database.
- Publication of a new immutable rate-card row carrying the locked ruleset hash and
  named finance approval. The existing draft card/legacy calculations remain unchanged.

## Release blockers

- Supervised publication of the approved D-03 ruleset as a new immutable rate-card
  version and versioned deterministic recalculation.
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

- `npm run check`: passed with the isolated test socket enabled; secret scan,
  backend/frontend TypeScript, production web build, and **133/133** tests passed,
  including reliable-processing and verified-billing MySQL integration.
- Migrations 0003 and 0004: applied successfully to a disposable MySQL 9.6 database
  and are now present in the configured real database.
- `dme@kairali.com` is provisioned as an active `admin` with a K3 sensitivity
  ceiling. The grant has an audit entry; application-owned password storage remains
  disabled.
- Audit writer integration: two synthetic events produced distinct hashes,
  `chain_ok`, and `head_ok`.
- The latest frontend install reported two high-severity advisories, but the approved
  environment did not permit sending the dependency manifest to npm's live advisory
  endpoint for attribution. The offline cache reported zero. Treat the live result as
  unresolved and require the private CI audit before release.
- Migration 0005: applied successfully to a disposable MySQL 9.6 database.
- MySQL reliability integration: passed with one published message, one completed inbox
  record, and one completed/replayable idempotency record.
- Migration 0006: applied successfully to a disposable MySQL 9.6 database; all ten
  additive calculation-trace columns, the automated-decision table, and four foreign
  keys were verified.
- Verified-billing MySQL integration: passed; one synthetic legacy calculation was
  superseded append-only, one final component/decision/outbox message was written, and
  an identical replay produced no duplicate.
- React billing route: inspected in the local browser against aggregate data; it keeps
  the existing INR 2,12,244.25 visibly provisional, reports migration 0006 telemetry as
  unavailable, and emitted no browser console errors.

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
| 5. Billing/reporting | UI, D-12 projections, and tested calculation/finalization core exist; migration 0006, card publication, full recalculation, reconciliation, and persisted snapshots remain incomplete |

The application is useful for controlled monitoring, but it is not yet a
production-authoritative audit/billing engine.

The Phase 5 core is complete only at library/adapter level. It is not live until
migration 0006 is approved/applied, a new hashed card is published, calibration supplies
thresholds, and a controlled historical recalculation proves coverage and totals.
