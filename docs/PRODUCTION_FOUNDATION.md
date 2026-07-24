# Phase 1 production foundation

Status: implemented on `phase1-production-foundation`; synthetic validation only.
Nothing in this change has been applied to the real database or deployed.

Validation evidence: `npm run check` passes (89 tests); migrations 0003/0004 and two
linked synthetic audit events were verified in a disposable MySQL 9.6 instance
(`chain_ok`, `head_ok`).

## Delivered in this slice

- A secure server path (`npm run ui:secure`) for the existing aggregate dashboard.
- Production rejects local authentication and plaintext MySQL configuration.
- OIDC JWT verification uses issuer, audience, expiry, issued-at, algorithm allowlist,
  remote JWKS caching, and bounded network timeouts.
- OIDC subject/issuer must already map to an active `kaudit_user`; login never creates a
  user or grants a role.
- Every protected route checks `metrics:read` server-side. `unassigned`, unknown, and
  disabled users are denied.
- `/api/v1/me`, `/api/v1/dashboard`, `/health/live`, and `/health/ready`.
- Aggregate dashboard access is recorded in a serialized SHA-256 audit chain.
- Correlation IDs and privacy-safe problem responses; internal SQL/error/token content is
  not returned or logged.
- Strict browser security headers; no external scripts/assets or raw call content.
- CI, tracked-file secret checks, dependency audit, TypeScript, and synthetic tests.

## Still required before production

1. Apply/review migrations 0003 and 0004 in staging, then seed and explicitly assign users.
2. Register the Kairali OIDC application; confirm issuer, audience, JWKS URI, MFA policy,
   offboarding, group ownership, and whether an identity-aware proxy supplies the token
   cookie. The application never accepts an unsigned identity header.
3. Put the service behind the approved WAF/TLS ingress; configure proxy trust only for that
   ingress; use an India-region secret manager and TLS-authenticated MySQL.
4. Mirror audit logs to a protected security log store. The database chain detects edits
   but is not a substitute for an independently administered archive.
5. Add real React/NestJS deployable units and generated OpenAPI contract. This slice
   secures the existing dashboard; it does not claim the complete target stack.
6. Complete D-03, calibration, K2/K3 owner sign-off, retention/legal-hold controls,
   queue/outbox processing, reconciliation, disputes, corrective actions, backup/restore,
   performance/security tests, and the historical/live shadow cycles.

## Deliberate limits

- `local` auth is a loopback-only development aid. It still requires a provisioned,
  active user and role; production configuration rejects it.
- Protected routes are read-only aggregates. Raw audio, transcript, URLs, phone numbers,
  customer identifiers, and health content are not exposed.
- Rate-card approval and finding calibration gates remain visible and unchanged.
