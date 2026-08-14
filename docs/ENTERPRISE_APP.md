# Enterprise app

The current UI is a routed React application backed by authenticated, page-scoped
APIs. Operational pages are aggregate-only. An explicit admin audit-monitor flow
can expose one selected call's verified recording, timestamped transcript, and
per-call charge calculation when both role and sensitivity checks pass.

## Pages

| Route | Purpose | Live source |
|---|---|---|
| `/login` | Public sign-in entry point; local loopback credentials or Kairali SSO | public auth configuration only |
| `/` | Home/Profile: identity, role, permissions, sensitivity ceiling | `kaudit_user`, `kaudit_user_role` |
| `/overview` | Headline coverage and release gates only | call/evidence aggregates and configured gates |
| `/evidence` | Ingestion, references, hash baselines, integrity events | call/evidence/audit aggregates |
| `/findings` | Finding totals, confidence, catalog, origins, decisions | audit-run/finding aggregates |
| `/billing` | Calculation, claim, variance, rate card, reconciliation | billing/rate-card/reconciliation aggregates |
| `/billing/categories` | Admin-only category analysis: per-category audited counts, KServe charge, auditor final charge, and duration gap, with a server-paged call table | audited-call, provider-cost, and final-calculation aggregates |
| `/reports` | D-12 summaries plus monthly email-delivery status | live period aggregates and report outbox |
| `/operations` | Outbox, inbox, jobs, idempotency, access-audit health | reliability/security aggregates |
| `/audits` | Three admin queues: audited, pending audit, and no recording; restricted review links where applicable | audit/finding/billing metadata |
| `/audits/call?task=…` | Admin-only recording, transcript, and KServe-vs-auditor calculation | one sensitivity-authorized call |

Each endpoint returns only the data used by its page. `/overview` does not return
findings, billing, or snapshot payloads.

## Restricted call review

- `/api/v1/audit-call` and `/api/v1/audit-audio` require `audit:inspect`,
  which is granted to the `admin` role only.
- The selected call's `sensitivity_tier` must not exceed the signed-in
  administrator's `max_sensitivity_tier`.
- The browser never receives the vendor `source_url`. Audio is streamed through
  the application after the KServe URL is allowlisted, fetched afresh through
  the configured proxy, and matched against the stored SHA-256 baseline.
- Missing or altered evidence fails closed; it is never played as trusted audio.
- Detail and audio reads are written to `kaudit_audit_log` with the call ID and
  purpose `admin_call_review`.
- Responses are private and non-cacheable. Aggregate APIs continue to exclude
  transcript text, recording URLs, phone numbers, and customer identifiers.
- Per-call KServe charges are derived from sheet minutes because KServe supplies
  aggregate invoice lines, not per-task invoice amounts. Per-call values exclude
  cycle-level IGST, TDS, and round-off.

## Category analysis

- `/billing/categories` and `/api/v1/billing/categories` require `audit:inspect`,
  which is granted to the `admin` role only, because the table lists per-call
  task references and links into the restricted review route. Both the page and
  the API are refused for anyone else, and every read is access-audited as
  `billing_category_analysis.read`.
- Selecting a KPI re-queries the table; paging is server-side and bounded
  (`page`, `pageSize` 10–100, `category`, `month`), with total rows, total pages,
  and a deterministic order returned.
- **KServe charge time** is the final vendor-asserted billed minutes — the time
  the vendor charges for. **AI-audited duration** is the grace-adjusted audited
  duration: audit metadata and a projection, not a charge, unless a current final
  billing calculation prices the call. **Gap** is KServe billed duration minus
  AI-audited duration, sign preserved.
- **KServe charge** money comes from the vendor's own billed-minute evidence.
  **Auditor amount** totals only current, non-superseded final
  `kaudit_billing_calculation` rows; audited calls without one release no auditor
  charge and are reported as unfinalized rather than as a verified zero. Amounts
  stay fixed-precision decimal text end to end.
- The footer totals cover the entire selected category for the month, not the
  current page. Columns that cannot be summed are labelled, and a duration
  nobody recorded stays blank rather than becoming `0.00`.
- The response carries no recording URL, evidence hash, internal call ID,
  transcript, source-row ID, or provider content.

## Login behavior

- Local loopback mode accepts email/password on `/login`, verifies a one-way
  scrypt hash from ignored `.env.local`, and issues a signed, expiring HttpOnly,
  SameSite cookie. The plaintext password is never stored in the browser,
  database, source code, or environment file.
- `/login` and `/api/v1/auth/config` are public; they expose no business data.
- In OIDC mode, the button uses the validated HTTPS `KAUDIT_OIDC_LOGIN_URL` owned by
  Kairali's identity provider or approved identity-aware proxy.
- The top-bar logout button calls `/logout`. OIDC mode delegates session termination
  to the validated HTTPS `KAUDIT_OIDC_LOGOUT_URL`; local/preview mode returns to
  `/login`.
- In local mode, a valid session is required for every protected app/API request;
  logout clears the local session cookie.
- In preview mode, the page is visibly labeled unauthenticated and offers only the
  loopback preview entry.
- Unauthenticated browser navigation to protected app routes redirects to `/login`.
  Protected API requests continue to return `401` JSON rather than an HTML redirect.
- Static frontend assets are public because they contain code only; all aggregate
  business APIs remain server-authorized.

## Run local authenticated development with real aggregate data

This requires the database variables in gitignored `.env` and local identity,
password-hash, and session settings in gitignored `.env.local`:

```bash
npm run app:dev
```

Open `http://127.0.0.1:4173`. Vite serves the UI and proxies `/api` to the
authenticated server at `127.0.0.1:4175`. Unauthenticated navigation redirects
to `/login`, and successful/denied requests are access-audited.

To preview the built bundle instead of Vite:

```bash
npm run app:preview
```

Open `http://127.0.0.1:4176`. The built preview uses a separate port so it can
run alongside `app:dev`, whose API uses `4175`.

## Run the authenticated application

Prerequisites:

1. review and apply migrations `0003` and `0004` in the approved staged process;
2. provision an active `kaudit_user` with an `admin` or `user` role;
3. configure local auth or the approved OIDC integration in `.env`;
4. keep release gates false unless their named approval and evidence exist.

Secure development:

```bash
npm run app:dev:secure
```

Production-shaped authenticated build:

```bash
npm run app:start
```

Local dashboard plus the continuous skip-completed audit worker:

```bash
npm run app:operate
```

`app:operate` also starts the monthly report-email worker. It remains idle until
`KAUDIT_REPORT_EMAIL_ENABLED=true`; readiness and reporting gates still prevent
premature delivery. SMTP setup and the supervised first-month procedure are in
`docs/runbooks/AUTOMATED_REPORT_EMAIL.md`.

For OIDC browser login, configure:

```text
KAUDIT_OIDC_LOGIN_URL=https://<approved-kairali-identity-entry>
KAUDIT_OIDC_LOGOUT_URL=https://<approved-kairali-session-endpoint>
```

The identity provider/proxy must return a validated bearer token or secure HttpOnly
cookie according to the existing OIDC server configuration. D-14 remains open until
that provider, client, MFA policy, callback/proxy behavior, and logout path are approved.

Open `http://127.0.0.1:4175`. Static assets are served from the authenticated
server with a same-origin CSP.

Business data queries are read-only. Aggregate pages remain content-free; the
restricted admin call-review endpoints are the only raw-content exception.
Successful and denied app/API access is written to the hash-chained audit log
in authenticated modes.

## Authority labels

- Billing becomes `authoritative` only when the newest rate card is `published` with
  `approved_by`/`approved_at`, every current calculation is final with an approved
  calculation basis, input/ruleset/decision-trace hashes are present, and no current
  automated billing decision is unresolved.
- Findings remain `uncalibrated` unless `KAUDIT_CALIBRATION_COMPLETE=true` is set
  after the approved calibration protocol is complete.
- Legacy K2/K3 metadata does not control automation authority. Calibration and
  evidence/rate-card gates apply uniformly to every call.
- Reports remain `provisional` until billing calculations are authoritative and
  `KAUDIT_REPORTING_APPROVED=true`.
- Audit Monitor reports exact GPT input/output/total tokens and Whisper billed
  audio minutes from migration 0007 onward. Historical audits remain labeled
  `Not recorded`.

These flags change labels and release posture. They do not retroactively validate,
recalculate, or finalize existing data.

## Production boundary

This app is production-shaped, not production-approved. D-03 publication/recalculation,
calibration, privacy/retention, OIDC, infrastructure, and shadow-run
acceptance remain release blockers. Do not expose the Vite server or use local
authentication outside loopback development.
