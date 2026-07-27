# Changelog

## 2026-07-27 — read-only full-call re-audit preflight

- Added a read-only real-call shadow runner using fresh KServe proxy bytes,
  SHA-256 evidence checks, Whisper timestamps, pinned GPT-4o-mini structured
  classification, and deterministic KServe charge projection.
- Added synthetic tests for transcript-block merging, impossible model outputs,
  60-second wrap-up grace, K2 provisional gating, and evidence alteration.
- Confirmed by metadata-only queries that 224/43,245 calls were classified,
  16,371 have recording URLs, 26,874 do not, and all calls currently default to
  K2.
- Ran five real shadow calls successfully with zero database writes.

## Unreleased

- Added the finance-approved KServe verified-billing V2 core: final-customer-exchange
  basis, 60-second wrap-up grace, strict 60-second one-way-tail alert, INR 4.75 short
  call and whole-minute INR 9.50 rounding, all using integer/fixed-precision math.
- Added calibration, per-threshold, automated re-check, and K2/K3 fail-closed authority
  gates to the pure billing decision path.
- Added reproducible model/ruleset/confidence/evidence-hash traces, an additive
  automated-decision schema, append-only superseding calculation writer, transactional
  outbox event, and isolated-MySQL integration coverage.
- Prevented a published rate card alone from making legacy vendor-duration
  calculations appear authoritative in the dashboard.
- Added a React/Vite application with Home/Profile as `/` and separate Overview,
  Evidence, Findings, Billing, Reports, and Operations routes.
- Split the secure aggregate API into page-scoped endpoints.
- Added real-data aggregate operations views for outbox/inbox/jobs/idempotency/audit.
- Added fail-closed calibration and K2/K3 runtime gates.
- Added an explicit loopback-only preview mode so the real aggregate UI can run before
  user provisioning without weakening the authenticated startup path.
- Moved the built preview to port 4176 and added a clear startup message for occupied
  ports, avoiding collisions with the development API on 4175.
- Added a public `/login` page, public non-sensitive auth configuration endpoint,
  protected-page redirects, and validated Kairali SSO login URL support without adding
  app-owned password authentication.
- Added a visible top-bar logout action and `/logout` route. Preview/local sessions
  return to login; OIDC logout redirects only to a validated HTTPS provider endpoint.
- Preserved visible D-03, calibration, D-12, and K2/K3 authority warnings.
- Added production configuration validation and fail-closed OIDC authentication.
- Added database-backed role authorization for the aggregate dashboard.
- Added idempotent, audited administrator provisioning and configured the approved
  local identity as full-access `admin` with a K3 sensitivity ceiling.
- Added privacy-safe API/problem responses, readiness checks, security headers, and
  correlation IDs.
- Added an additive migration and writer for hash-chained security audit events.
- Added CI, secret scanning, deployment/runbook documentation, and synthetic tests.
- Added additive reliable-processing controls, canonical message hashing, transactional
  outbox enqueue, leased publication/retry/DLQ, inbox deduplication, and mutation
  idempotency.
