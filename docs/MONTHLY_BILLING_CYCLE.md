# Monthly KServe billing cycle

## Business outcome

Kairali does not release its verified bill or revenue-variance report until
every imported call in the cycle has reached an explicit audit resolution.
There is no human-review checkpoint, and the legacy K2/K3 label does not alter
processing authority.

An audit resolution is one of:

1. `independent_conversation_end` — recording fetched and hashed, AI audit
   completed, confidence/calibration policy passed, and deterministic billing
   calculated from the verified duration;
2. `independent_category_service_end` — the same verified evidence path with
   the versioned management category policy selecting the service endpoint and
   category-specific grace; or
3. `accepted_as_billed_unverified` — a recording existed but automated audit
   exhausted its retry window; at cycle close, the approved fallback explicitly
   retains KServe's supplied minutes and amount; or
4. `no_recording_zero` — no recording URL exists, so audited duration and amount
   are zero and the recorded remark is `No Recording Found`.

Neither fallback is described as an independent AI audit.

## How next month's data enters SQL

The supported source contract is one row per KServe task with:

- Task ID
- Destination Number
- Call Start Time
- Call Connected Time
- Call End Time
- Duration (Seconds) With Ringing
- Duration (Seconds) Without Ringing
- Duration (Minutes) - Actual Billing Mins
- Actual Billing Amount
- Recording URL

The implemented CSV import path is:

1. An admin selects the monthly KServe CSV at `/imports/new`. The server
   performs a non-persistent deterministic preview, validates the locked
   columns, derives the period, and counts rows with/without recording URLs.
2. The admin selects the invoice PDF. OpenAI reads the PDF into a strict
   metadata schema and suggests invoice dates and totals. These suggestions
   are editable and are not authoritative.
3. The admin checks the suggested fields and presses the separate
   `Submit usage` and `Submit invoice` buttons. Analysis alone writes nothing
   to SQL. XLSX must currently be exported to CSV first.
4. On submit, the server computes a file hash and creates one
   `kaudit_ingestion_batch`. Re-uploading identical bytes replays the existing
   result instead of creating duplicate calls.
5. Header/schema validation runs before row writes. An invalid file is rejected
   before SQL normalization starts.
6. Accepted rows are normalized into `kaudit_call`,
   `kaudit_call_external_reference`, call timing/provider-cost records, and
   `kaudit_call_artifact.source_url`. KServe's per-row billed amount is retained
   as a separate vendor assertion and used as the vendor claim. When that cell
   is blank, the claim falls back to billed minutes times the locked rate. It
   does not decide Kaudit's independently verified amount.
7. A row with an approved `Recording URL` is committed with an idempotent
   audit-request outbox message. The column is required by the template, but a
   blank cell remains explicitly without recording evidence until a separate
   manifest/API feed supplies one.

Original files are content-addressed under the configured durable import store:
`KAUDIT_IMPORT_ROOT` for the persistent local runtime, or the Kaudit Google
Shared Drive boundary for Vercel. They are indexed by SHA-256. The application
never reads KCRM source code or KCRM's local evidence folders. SQL is the
processing gate after import.

## Automatic audit

The import records one idempotent audit-request outbox message per
recording-backed call for traceability and future queue delivery. In the
current build, the continuous worker does not consume that outbox; it safely
polls eligible SQL call/artifact rows, uses a database advisory lock, and skips
every call that already has a completed audit. The worker:

1. fetches the KServe recording through the unpod proxy;
2. hashes the returned audio and checks the stored baseline;
3. transcribes with timestamped Whisper output;
4. merges natural speech blocks and classifies the call;
5. records model/version, classifier/ruleset, confidence, evidence hashes, and
   timestamps;
6. retries source, transcription, classification, and low-confidence failures
   according to policy; and
7. writes a final independent calculation only when calibration and the
   published rate card permit it.

The worker considers a call eligible only after a matching invoice period is
present. Once both the usage CSV and invoice are committed, the persistent
worker drains that period automatically:

```bash
KAUDIT_AUDIT_MODE=EXECUTE KAUDIT_AUDIT_WATCH=true npm run audit:worker
```

Watch mode continues polling for newly imported/due calls. It skips any call
already backed by a completed legacy or V2 audit. The dashboard process never
starts paid OpenAI work merely because a user opens a page.

An administrator can use **Stop audit** on `/audits`; the worker finishes the
current call and claims no next call. **Resume audit** continues from SQL.
Unexpected call-level processing failures are stored with bounded codes and
scheduled under the existing retry policy while later calls continue.

For local operation, one command starts the built dashboard and the continuous
worker together:

```bash
npm run app:operate
```

`npm run app:start` intentionally starts only the dashboard. Opening a browser
must never be the trigger for paid or long-running audit work. In production,
the API and worker must be separate supervised services with restart policy,
health checks, and centralized secret management.

## Bill and report release

The latest cycle follows:

`import_pending → audit_pending → validation_pending → rate_card_pending → calculation_pending → ready`

The bill is released only at `ready`, when:

- every call has an explicit audit resolution;
- no current automated decision is unresolved;
- the leadership-approved automated-consensus policy (or a separately approved
  human calibration) is active;
- the immutable rate card is published with approval;
- every call has one current final traced calculation; and
- the calculation uses independent duration or the explicit cycle-close
  fallback.

While the cycle is incomplete, `/billing` displays `Audit pending`. The reports
API withholds verified revenue, variance, and trend values; vendor-claimed
figures may remain visible as vendor claims.

Once ready, the automated email worker generates a concise monthly PDF plus a
call-level Excel workbook and sends them to configured Kairali
finance/management recipients. Delivery uses the existing hashed outbox,
content/recipient-bound idempotency, bounded retry, and a visible dead-letter
state. SMTP configuration and the reporting approval gate remain
deny-by-default. See `docs/runbooks/AUTOMATED_REPORT_EMAIL.md`.

Weekly/monthly/quarterly/yearly snapshot views remain available in the
dashboard. Persisting immutable D-12 snapshots at all four cadences remains a
separate reporting-infrastructure item.

The current build also supports an explicitly non-authoritative cycle preview.
It can generate a JSON calculation package and a watermarked PDF before
calibration, but it must remain labeled
`PROVISIONAL_UNCALIBRATED_TEST_ONLY`. The preview does not release a bill or
create a vendor dispute. It is not eligible for the authoritative email worker.

For recording-backed calls, `npm run automation:validate` performs the
leadership-approved zero-human-review policy. Two independent passes must agree
on category, customer-speech state, and rounded billable duration. A third
automated pass adjudicates disagreements. This is called automated validation,
not ground-truth calibration.

## Global bill-month filter

The application shell exposes one global `Bill month` selector. It is backed
by billing periods that actually exist in `kaudit_call`, displays each month
with its call count, and stores the selected value in the URL as
`?month=YYYY-MM`. Overview, evidence, findings, billing, reports, and audit
monitoring all use the same selected period. Navigation preserves the month,
so users do not accidentally compare April calls with May billing.

`All periods` remains available for historical comparison. Operations is a
system-wide page and clearly states that the month selector does not scope it.

## Current implementation truth

| Capability | Status |
|---|---|
| Real SQL cycle-completion read model | Implemented |
| `Audit pending` bill withholding | Implemented |
| Report-value withholding before audit completion | Implemented |
| K2/K3-specific automation barrier | Retired |
| Monthly CSV upload and normalization writer | Implemented |
| Resumable continuous full audit worker | Implemented with durable Stop/Resume; deployment pending |
| KServe recording manifest/API feed | Missing when the monthly CSV lacks Recording URL |
| Global bill-month filter | Implemented across aggregate business pages |
| Cycle-close accepted-as-billed fallback writer | Implemented with dry-run/execute safety switch and deterministic trace |
| Automated consensus + adjudication | Implemented with traced pass/fail outcomes and automated finding finalization |
| Provisional JSON/PDF cycle preview | Implemented; watermarked and withheld from authority |
| Persisted D-12 snapshot generator | Not implemented |
| Authoritative monthly PDF/Excel email notification | Implemented; disabled until SMTP + reporting approval are configured |
| Exact AI usage capture | Implemented for future calls after migration 0007; legacy usage unavailable |
