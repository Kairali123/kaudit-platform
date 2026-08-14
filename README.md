# kaudit-platform

Decoupled application for the **Kairali Voice Agent Call Audit & Billing Platform**.

Separate from the KCRM Next.js app (per the architecture's "audit system is its own
system" principle). Connects to the **same MySQL** (`kaudit_*` tables) — a data-location
decision made by the director — but the audit logic lives here, not inside the CRM app.
KCRM is not a runtime source: this application never imports its code or reads its
local evidence folders.

Architecture package: `../voice-agent-call-audit-architecture`.

## Status

Active remediation/build. W3 evidence-reference integrity, W1 identity/access
primitives, the aggregate dashboard, and the first production security foundation
are implemented on feature branches with synthetic tests. The platform is **not
production-ready yet**: D-03 rate-card publication/recalculation, calibration,
retention/compliance controls, reliable ingestion/jobs,
reconciliation, corrective actions, infrastructure, and shadow-month acceptance remain
gated. See
`IMPLEMENTATION_STATUS.md`.

The finance interpretation for D-03 is now locked in code with fixed-precision,
synthetic boundary tests. The existing database card and 43,245 legacy calculations
have not been changed: migration 0006 and publication of a new hashed rate-card version
remain supervised operations. See `docs/VERIFIED_BILLING_V2.md`.

> **⚠️ Trade-off in effect (D-13, cost-driven, made knowingly):** recordings are
> referenced by their **KServe URL** and are **not** copied into independent Kairali
> storage. Evidence is vendor-hosted. The sha256 gate is the only safeguard and works
> only while the URL resolves; if KServe expires/deletes a recording we keep a hash but
> cannot reproduce the bytes. This weakens dispute-evidence strength and the audit's
> independence for these recordings. See `docs/W3_STORAGE_MIGRATION.md`.

## Requirements

- **Node >= 24** — native TypeScript type-stripping; tests run with `node --test`, no build.

## Test (synthetic fixtures — no DB, no network, no real data)

```
npm run test:w3
```

Covers URL reachability/safety, hash-on-ingestion, hash-mismatch (evidence_altered)
detection, and missing-URL (source_missing) handling.

## Verification pass (gated)

`npm run w3:verify` defaults to **dry-run** (fetch + report, write nothing). It writes
hashes/verifications/findings only when `KAUDIT_VERIFY_MODE=EXECUTE`, touches the
production DB in that mode, and must be run as an approved, supervised pass.

## Independently verified billing core

```bash
npm run test:billing
```

This covers the approved INR 4.75/INR 9.50 boundaries, 60-second wrap-up grace,
whole-minute ceiling, strict one-way-tail alert, calibration/low-confidence handling,
ruleset publication checks, audit-cycle bill withholding, and reproducible decision
traces.

Migration `0006_verified_billing_trace.sql` and the MySQL writer are not applied or
invoked by this command. Existing production calculations remain untouched.

## Local dashboards

Full aggregate preview without a database:

```bash
npm run ui:dashboard:sample
open dashboard-sample.html
```

Full live aggregate dashboard using the gitignored `.env`:

```bash
npm run ui:dashboard
```

Then open `http://127.0.0.1:4174`. The full dashboard is local-only and visibly
marks access control as unenforced, billing as provisional (D-03), and findings as
uncalibrated. It renders aggregate data only—never call audio, transcripts, phone
numbers, customer identifiers, or health content. See `docs/FULL_DASHBOARD.md`.

## Secure dashboard foundation

`npm run ui:secure` starts the protected aggregate server after migrations 0003/0004,
user provisioning, and the environment in `.env.example` are configured. Production
requires OIDC, a pre-provisioned active user/role, a stated MySQL transport
(`DB_TLS_MODE=required` with a CA, or `DB_TLS_MODE=disabled` for the plaintext
connection the CRM uses — never inferred from a missing CA), and a working
hash-chained audit sink; it rejects the loopback development-auth mode.

Do not apply migrations or point this path at production until the staged sequence in
`docs/runbooks/SECURE_DASHBOARD.md` is approved and completed.

## Routed enterprise app

The application is page-based: `/` is Home/Profile, `/overview` is overview only, and
`/evidence`, `/findings`, `/billing`, `/reports`, and `/operations` contain their
dedicated aggregate views. `/login` is the public sign-in entry point. It never
stores passwords in the browser. Loopback development verifies a one-way
scrypt password hash from ignored `.env.local` and issues a signed, expiring,
HttpOnly, SameSite session cookie. Production login and logout delegate to the
configured Kairali SSO/proxy; local password mode is rejected in production.

For loopback development with the local sign-in page:

```bash
npm run app:dev
```

Open `http://127.0.0.1:4173`. Unauthenticated users are redirected to
`/login`. Use `npm run app:preview` only for the explicitly unauthenticated,
built preview on `127.0.0.1:4176`; it must not be exposed.

After identity migrations and user/OIDC provisioning, use `npm run app:dev:secure`
or `npm run app:start`. See `docs/ENTERPRISE_APP.md`.

## Vercel web/API deployment candidate

`vercel.json` and `api/index.ts` make the authenticated web/API application
deployable as a Git-backed Vercel candidate on a Node.js 24 Function, sharing the
persistent server's dependency bootstrap so the two cannot drift on security posture.
A web deployment hosts pages and API reads only — the billing worker, Call Audit batch,
report-email worker, migrations, and durable imports are not started by it, and there
are no Cron entries. No Vercel project is linked and no deployment has been made. See
`docs/runbooks/VERCEL_DEPLOYMENT.md`.

## Monthly import and continuous audit

An administrator uploads the KServe usage CSV and invoice PDF at
`/imports/new`. File selection first runs a non-persistent preview: CSV
columns/period/recording coverage are validated deterministically across every
row, and OpenAI suggests editable invoice metadata from the PDF using a strict
schema. Separate `Submit usage` and `Submit invoice` actions are required
before anything is written. Original bytes are then content-addressed under the
configured durable import store — `KAUDIT_IMPORT_ROOT` for the persistent local
runtime, or the Kaudit Google Shared Drive boundary for Vercel — and normalized
into the shared `kaudit_*` tables. A usage row may include an optional `Recording URL`; without a
recording URL the call is retained but cannot enter audio audit.

Run the Billing Audit worker as its own supervised process. Once the usage CSV
and matching invoice are committed, it drains eligible calls automatically:

```bash
KAUDIT_AUDIT_MODE=EXECUTE KAUDIT_AUDIT_WATCH=true npm run audit:worker
```

It processes only recording-backed, unaudited calls and skips every call that
already has a completed audit. Opening the dashboard never starts paid OpenAI
work.

For local operation, start the built dashboard and continuous audit worker
together:

```bash
npm run app:operate
```

This is a convenience wrapper around separate API, audit, and report
processes. Production still requires independently supervised API and worker
services.

## Automatic Call Audit

`npm run callaudit:worker` continuously reads the external Call Audit source
with `SELECT`-only keyset polling, audits new or changed immutable revisions,
and persists results before reports can display them. Migration
`0012_automatic_audit_workers.sql` supplies the durable checkpoint and the
administrator Stop/Resume state shared by both workers.

The automatic worker needs `KAUDIT_CALL_AUDIT_AUTO_START` only when its durable
checkpoint has never been initialized. It polls every 60 seconds by default and
continues from SQL after process restarts. A persistent supervisor, not Vercel,
must keep both workers running.

## Call Audit batch

`npm run callaudit:batch` runs one bounded Call Audit batch over one
operator-supplied period and exits. It is not a scheduler, and it refuses to
write or spend unless `KAUDIT_CALL_AUDIT_BATCH_MODE` is exactly `EXECUTE`.

The one-shot command remains available for supervised backfills and bounded
reconciliation. Follow `docs/runbooks/CALL_AUDIT_BATCH.md`.
