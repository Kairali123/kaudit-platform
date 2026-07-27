# Full audit dashboard — local aggregate preview

This is the real local UI for the Kairali voice-audit platform. It reads aggregate
values from the existing `kaudit_*` tables and renders four sections:

1. calls and evidence integrity;
2. automated findings and quality signals;
3. billing and reconciliation;
4. D-12 weekly, monthly, fiscal-quarterly, and fiscal-yearly revenue snapshots.

It intentionally renders **no call rows, phone numbers, evidence URLs, audio,
transcripts, customer identifiers, or health content**.

## Run locally

With the gitignored `.env` configured:

```bash
npm run ui:dashboard
```

Open `http://127.0.0.1:4174`.

For a DB-free representative preview:

```bash
npm run ui:dashboard:sample
open dashboard-sample.html
```

The static preview's monetary figures are illustrative. The local live server uses
aggregate database values.

## Mandatory gates shown in the UI

- **Access control not enforced:** W1 defines `admin` / `user` and sensitivity
  ceilings, but the local server has no login or request-level permission guard.
  It binds to loopback only and must not be deployed or distributed.
- **Billing provisional:** D-03's interpretation is approved, but the new hashed card
  is not published and the legacy vendor-duration rows are not independently traced.
  Monetary values remain provisional until final calculations supersede them.
- **Findings uncalibrated:** model confidence is shown but never represented as
  measured accuracy.
- **Snapshots provisional:** the four D-12 cards are live projections over existing
  aggregate data, not approved immutable management snapshots. Weekly periods are
  Mon-Sun; quarter/year use the recommended Indian Apr-Mar fiscal calendar.

## Revenue conventions

- `verified billable` is the sum of current, non-superseded
  `kaudit_billing_calculation.total_amount` for calls in the period.
- `vendor claim` uses an exact-period invoice when present. Otherwise it is provider-
  asserted billed minutes valued at the per-minute rate found in existing billing
  component results and is labeled `provider-asserted usage; no invoice`.
- `variance identified = vendor claim - verified billable`.
- Identified variance is **not** represented as recovered savings.
- Trend compares verified billable revenue with the prior same-cadence period using a
  2% dead-band.

## Security posture

The server:

- binds only to `127.0.0.1`;
- performs aggregate-only `SELECT` queries;
- emits no scripts or external requests;
- sends `no-store`, CSP, no-referrer, no-sniff, and deny-framing headers;
- escapes all database-derived labels.

This remains a local preview until W1 authentication and authorization are wired.
