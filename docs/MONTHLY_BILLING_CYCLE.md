# Monthly KServe billing cycle

## Business outcome

Kairali does not release its verified bill or revenue-variance report until
every imported call in the cycle has reached an explicit audit resolution.
There is no human-review checkpoint, and the legacy K2/K3 label does not alter
processing authority.

An audit resolution is one of:

1. `independent_conversation_end` — recording fetched and hashed, AI audit
   completed, confidence/calibration policy passed, and deterministic billing
   calculated from the verified duration; or
2. `accepted_as_billed_unverified` — no usable recording remained after the
   automatic retry window and, at cycle close, the approved fallback explicitly
   accepted KServe's supplied minutes.

Missing recordings are never silently counted as audited.

## How next month's data enters SQL

The supported source contract is one row per KServe task with:

- Task ID
- Destination Number
- Call Start Time
- Call Connected Time
- Call End Time
- Duration (seconds) With Ringing
- Duration (seconds) Without Ringing
- Duration (minutes)

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
   `kaudit_call_artifact.source_url`.
7. A row with an optional approved `Recording URL` is committed with an
   idempotent audit-request outbox message. The locked eight-column sheet does
   not contain recording URLs, so those calls remain explicitly without
   recording evidence until a separate manifest/API feed supplies one.

Original files are content-addressed under `KAUDIT_IMPORT_ROOT` (default
`.data/imports`, gitignored) and indexed by SHA-256. The application never reads
KCRM source code or KCRM's local evidence folders. SQL is the processing gate
after import.

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

Run the persistent worker as a separate supervised process:

```bash
KAUDIT_AUDIT_MODE=EXECUTE KAUDIT_AUDIT_WATCH=true npm run audit:worker
```

Watch mode continues polling for newly imported/due calls. It skips any call
already backed by a completed legacy or V2 audit. The dashboard process never
starts paid OpenAI work merely because a user opens a page.

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

`import_pending → audit_pending → calibration_pending → rate_card_pending → calculation_pending → ready`

The bill is released only at `ready`, when:

- every call has an explicit audit resolution;
- no current automated decision is unresolved;
- the immutable rate card is published with approval;
- every call has one current final traced calculation; and
- the calculation uses independent duration or the explicit cycle-close
  fallback.

While the cycle is incomplete, `/billing` displays `Audit pending`. The reports
API withholds verified revenue, variance, and trend values; vendor-claimed
figures may remain visible as vendor claims.

Once ready, the report worker will persist the weekly/monthly/quarterly/yearly
management snapshot, generate PDF and Excel exports, and notify configured
finance/management recipients. In the current build, only the live dashboard
projection exists—automatic PDF/Excel generation and email/in-app delivery are
still pending implementation.

## Current implementation truth

| Capability | Status |
|---|---|
| Real SQL cycle-completion read model | Implemented |
| `Audit pending` bill withholding | Implemented |
| Report-value withholding before audit completion | Implemented |
| K2/K3-specific automation barrier | Retired |
| Monthly CSV upload and normalization writer | Implemented |
| Resumable continuous full audit worker | Implemented; production execution not launched |
| KServe recording manifest/API feed | Missing when the monthly CSV lacks Recording URL |
| Cycle-close accepted-as-billed fallback writer | Not implemented |
| Persisted D-12 snapshot generator | Not implemented |
| PDF/Excel export and recipient notification | Not implemented |
