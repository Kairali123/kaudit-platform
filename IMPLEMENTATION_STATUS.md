# Implementation status

Updated: 2026-07-24

## Current slice

Phase 1 production foundation is in progress on `phase1-production-foundation`.

Implemented with synthetic tests:

- W3 URL reference/backfill/hash verification tooling.
- W1 two-role, deny-by-default identity and sensitivity model.
- Local aggregate audit/billing/findings/D-12 dashboard.
- Secure dashboard foundation: OIDC JWT verification, database-backed role checks,
  safe readiness, correlation/problem responses, and hash-chained access audit.
- CI and tracked-file secret checks.

Not run/applied:

- Migrations 0003/0004 against the real database.
- OIDC integration with Kairali's identity provider.
- Deployment, production data mutation, rate-card publication, calibration, or automated
  financial/health decisions.

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

- `npm run check`: passed; secret scan, TypeScript, and **89/89** synthetic tests.
- Migrations 0003 and 0004: applied successfully to a disposable MySQL 9.6 database.
- Audit writer integration: two synthetic events produced distinct hashes,
  `chain_ok`, and `head_ok`.
- `npm install` reported zero known vulnerabilities for the installed dependency set.
  A separate live `npm audit` request was unavailable in the restricted execution
  environment; CI retains that check for the approved private repository runner.
