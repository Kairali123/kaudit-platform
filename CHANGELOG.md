# Changelog

## Unreleased

- Added a React/Vite application with Home/Profile as `/` and separate Overview,
  Evidence, Findings, Billing, Reports, and Operations routes.
- Split the secure aggregate API into page-scoped endpoints.
- Added real-data aggregate operations views for outbox/inbox/jobs/idempotency/audit.
- Added fail-closed calibration and K2/K3 runtime gates.
- Added an explicit loopback-only preview mode so the real aggregate UI can run before
  user provisioning without weakening the authenticated startup path.
- Preserved visible D-03, calibration, D-12, and K2/K3 authority warnings.
- Added production configuration validation and fail-closed OIDC authentication.
- Added database-backed role authorization for the aggregate dashboard.
- Added privacy-safe API/problem responses, readiness checks, security headers, and
  correlation IDs.
- Added an additive migration and writer for hash-chained security audit events.
- Added CI, secret scanning, deployment/runbook documentation, and synthetic tests.
- Added additive reliable-processing controls, canonical message hashing, transactional
  outbox enqueue, leased publication/retry/DLQ, inbox deduplication, and mutation
  idempotency.
