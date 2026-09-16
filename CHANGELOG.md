# Changelog

## 2026-07-27 — read-only full-call re-audit preflight

- Added a read-only real-call shadow runner using fresh KServe proxy bytes,
  SHA-256 evidence checks, Whisper timestamps, pinned GPT-4o-mini structured
  classification, and deterministic KServe charge projection.
- Added synthetic tests for transcript-block merging, impossible model outputs,
  60-second wrap-up grace, uncalibrated authority, and evidence alteration.
- Confirmed by metadata-only queries that 224/43,245 calls were classified,
  16,371 have recording URLs, and 26,874 do not.
- Ran five real shadow calls successfully with zero database writes.

## Unreleased

- Corrected the USER_SILENCE / INACTIVE_CALL split. No meaningful customer
  speech with at least one valid Saanvi block is now USER_SILENCE whatever the
  model proposed; INACTIVE_CALL is reserved for a transcript with neither.
  Background audio, unclear blocks, media-like transcription, and ASR junk can
  no longer zero-rate a call the agent actually worked. Voicemail, IVR, and real
  human interaction still outrank both fallbacks, and the attributed agent
  blocks behind the decision are persisted.
- AGENT_FAILURE now distinguishes failure from start from failure mid
  conversation. A failure that begins after validated meaningful service charges
  the service period through `failureStartMs` plus exactly 30,000 ms grace,
  capped at the recorded duration and the vendor charge; every other
  AGENT_FAILURE stays 0 seconds and INR 0. The model may point at the boundary,
  but deterministic validated code re-derives whether service preceded it and
  decides the money, failing closed to zero on anything missing or contradictory.
  `failureMode`, `meaningfulServiceBeforeFailure`, `failureStartMs`, and the
  supporting block numbers are persisted and shown on the call detail page.
- Bumped the classifier ruleset to `kairali-12cat/2.9.0`, the engine to
  `kairali-independent-reaudit/2.7.0`, and the category charge policy to
  `management-category-charge/2026-09-16.1`, each with its hash recomputed from
  the updated document.
- Added the recurring late-recording correction workflow: an administrator
  uploads a bounded CSV of Task ID and Recording URL against one bill month,
  previews it without writing anything, then commits. Only the uploaded tasks
  are audited, and each successful audit appends a new final calculation that
  supersedes the current `no_recording_zero` one while leaving it unchanged.
- Added migration 0020, three expand-only Kaudit-owned tables holding batch and
  item provenance and an append-only per-month correction result. No table in it
  can hold a recording URL: the canonical URL's only home stays
  `kaudit_call_artifact.source_url`, and everything else identifies it by
  SHA-256. The one permitted evidence transition is `NULL -> canonical URL`.
- Extracted the per-call automated consensus validation and adjudication into
  one shared runner and gave the candidate query an optional exact call scope,
  so a late-recording correction applies the same approved policy the
  month-wide runner does without either caller widening the other's scope. An
  empty exact scope selects nothing rather than a whole month.
- Added a dedicated late-recording worker scope whose only input is an opaque
  batch handle, selecting candidates by an exact join to that batch's accepted
  items, reusing the Billing Audit advisory lock, spend leases and transcript
  cache, with immediate dispatch plus an hourly scheduled recovery for batches
  whose dispatch was lost.
- Late-recording corrections invalidate and recompute the ended month's billing
  summary and record previous total, revised total, delta, corrected count and
  completion time at fixed precision. `kaudit_kserve_monthly_settlement` is
  never written: the delta is recorded as a proposed Finance adjustment and
  accepting it remains an explicit append-only Finance action.
- Added administrator-selected Billing Audit re-audits on the Audit Monitor:
  per-row checkboxes with page-scoped select-all, a bounded "Re-audit selected"
  action, live queued/processing state per row, and clear pending/success/error
  feedback.
- Added migration 0015, an expand-only Kaudit-owned re-audit request queue that
  stores internal ids, lifecycle, provenance, hashes, counts, ruleset, and
  bounded error codes only — no references, URLs, content, money, or PII — and
  enforces one active request per call in the schema.
- Added an admin-only `POST /api/v1/audits/re-audit` gated on `audit:control`
  before the body is read, bounded to 100 exact displayed references and one
  retry key, idempotent on retry, and returning no internal call ids.
- Added a billing-only requested/manual worker mode that drains the durable
  queue while the general billing queue is paused, captures a baseline audit run
  per item, skips safely when the call moved on, appends a new audit run on
  success, and leaves the prior successful result current on failure.
- Added the finance-approved KServe verified-billing V2 core: final-customer-exchange
  basis, 60-second wrap-up grace, strict 60-second one-way-tail alert, INR 4.75 short
  call and whole-minute INR 9.50 rounding, all using integer/fixed-precision math.
- Added calibration, per-threshold, and automated re-check authority gates to
  the pure billing decision path.
- Retired the K2/K3-specific runtime and billing authority gate; legacy
  sensitivity metadata remains database-compatible but does not block calls.
- Added latest-cycle audit readiness and withheld verified bill/report values
  until all calls are independently audited or explicitly resolved through the
  cycle-close accepted-as-billed fallback.
- Added reproducible model/ruleset/confidence/evidence-hash traces, an additive
  automated-decision schema, append-only superseding calculation writer, transactional
  outbox event, and isolated-MySQL integration coverage.
- Prevented a published rate card alone from making legacy vendor-duration
  calculations appear authoritative in the dashboard.
- Added a React/Vite application with Home/Profile as `/` and separate Overview,
  Evidence, Findings, Billing, Reports, and Operations routes.
- Split the secure aggregate API into page-scoped endpoints.
- Added real-data aggregate operations views for outbox/inbox/jobs/idempotency/audit.
- Added fail-closed calibration runtime gates.
- Added an explicit loopback-only preview mode so the real aggregate UI can run before
  user provisioning without weakening the authenticated startup path.
- Moved the built preview to port 4176 and added a clear startup message for occupied
  ports, avoiding collisions with the development API on 4175.
- Added a public `/login` page, public non-sensitive auth configuration endpoint,
  protected-page redirects, and validated Kairali SSO login URL support without adding
  app-owned password authentication.
- Added a visible top-bar logout action and `/logout` route. Preview/local sessions
  return to login; OIDC logout redirects only to a validated HTTPS provider endpoint.
- Preserved visible D-03, calibration, and D-12 authority warnings.
- Added production configuration validation and fail-closed OIDC authentication.
- Added database-backed role authorization for the aggregate dashboard.
- Added idempotent, audited administrator provisioning and configured the
  approved local identity as full-access `admin`.
- Added privacy-safe API/problem responses, readiness checks, security headers, and
  correlation IDs.
- Added an additive migration and writer for hash-chained security audit events.
- Added CI, secret scanning, deployment/runbook documentation, and synthetic tests.
- Added additive reliable-processing controls, canonical message hashing, transactional
  outbox enqueue, leased publication/retry/DLQ, inbox deduplication, and mutation
  idempotency.
