# Automated monthly report email

The report-email worker sends one authoritative monthly package to configured
Kairali recipients after the cycle reaches `ready`.

## What is sent

- a concise PDF management summary;
- an Excel workbook containing call-level task reference, category, confidence,
  resolution basis, KServe minutes/derived amount, verified minutes/amount, and
  variance; and
- an HTML email containing only the three headline revenue figures.

No recording URL, audio, transcript, phone number, or customer/health content is
included.

## Release gates

The worker queues nothing unless all of these are true:

1. `KAUDIT_REPORT_EMAIL_ENABLED=true`;
2. `KAUDIT_REPORTING_APPROVED=true`;
3. either automated validation or calibration is approved;
4. every call in the month has an explicit resolution;
5. every call has one current final, hashed calculation;
6. the rate card is published with named approval; and
7. an invoice exists for the exact billing month.

`npm run app:start` starts the dashboard only. `npm run app:operate` starts the
dashboard, Billing Audit worker, and report-email worker. The report worker
remains inactive when its enable switch is false.

## Configuration

Put real values only in ignored `.env.local` or the production secret manager:

```text
KAUDIT_REPORT_EMAIL_ENABLED=true
KAUDIT_EMAIL_TRANSPORT=gmail-oauth
KAUDIT_REPORT_RECIPIENTS=dme@kairali.com
KAUDIT_REPORT_FROM=<approved sender address>
KAUDIT_GOOGLE_CLIENT_ID=<OAuth client id>
KAUDIT_GOOGLE_CLIENT_SECRET=<OAuth client secret>
KAUDIT_GOOGLE_REFRESH_TOKEN=<offline refresh token>
KAUDIT_REPORT_EMAIL_WATCH=true
KAUDIT_REPORT_EMAIL_POLL_MS=60000
```

The preferred production transport is Gmail API OAuth with the least-privilege
`gmail.send` scope. The refresh token identifies the sending Workspace account;
the client secret and refresh token must be held only in the ignored local
environment file or production secret manager.

The legacy SMTP transport remains available with:

```text
KAUDIT_EMAIL_TRANSPORT=smtp
KAUDIT_SMTP_HOST=<approved SMTP host>
KAUDIT_SMTP_PORT=587
KAUDIT_SMTP_SECURE=false
KAUDIT_SMTP_USER=<secret/optional for trusted relay>
KAUDIT_SMTP_PASSWORD=<secret/optional for trusted relay>
```

For a supervised single-month test, set
`KAUDIT_REPORT_EMAIL_MONTH=2026-04` and run:

```bash
npm run report:email-worker
```

Recipients are restricted to `@kairali.com`, normalized, deduplicated, and
bound into the message id.

## Idempotency and retry

The stable outbox message id binds billing month, report-content SHA-256, and
recipient-set SHA-256. Repeated scans do not enqueue the same package twice.
Transient SMTP failures use bounded exponential retry and then a visible
`dead_letter` state. The Reports page shows queued, retry, sent, or dead-letter
status.

SMTP cannot guarantee exactly-once delivery when the server accepts a message
but the connection fails before acknowledgement. The worker supplies a stable
RFC Message-ID to support recipient-side deduplication; production should use a
mail provider with provider-level idempotency if strict exactly-once external
delivery is required.

## Google Workspace troubleshooting

- `EDNS` means the configured SMTP hostname could not be resolved. Kairali's
  current Google Workspace submission host is `smtp.gmail.com`, port `587`,
  with `KAUDIT_SMTP_SECURE=false` (STARTTLS).
- `EAUTH` means Google rejected the login. A normal Google Workspace account
  password is not valid for this SMTP flow. Use a 16-digit app password for an
  account with 2-Step Verification, or have a Workspace administrator configure
  `smtp-relay.gmail.com` and its sender/IP policy.
- Do not keep retrying bad credentials: a message is dead-lettered after the
  configured maximum attempts. Correct the secret, then rerun the same month;
  the original outbox message is reused and is not duplicated.
- After correcting a dead-lettered transport, perform one controlled replay:
  `KAUDIT_REPORT_EMAIL_MONTH=2026-04
  KAUDIT_REPORT_EMAIL_REPLAY_DEAD_LETTER=true npm run report:email-worker`.
  The OAuth token exchange is verified before the outbox attempt counter is
  reset.

## AI usage accounting

Migration `0007_ai_usage_telemetry.sql` enables append-only usage capture:

- GPT classification passes: exact input, output, and total tokens returned by
  OpenAI;
- Whisper-1: exact billed audio seconds returned by OpenAI (Whisper does not
  report text-token usage for this API response); and
- model/provider/version, operation/pass, audit run, call, request id, and
  timestamp.

Audit Monitor aggregates these values by the global bill-month filter. Calls
processed before migration 0007 remain explicitly `Not recorded`; historical
token counts are not estimated.
