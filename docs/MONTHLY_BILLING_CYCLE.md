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

The production import path will be:

1. An admin uploads the monthly KServe workbook/CSV through the platform's
   cycle-import page (or a future approved service account delivers the same
   file).
2. The server computes a file hash and creates one
   `kaudit_ingestion_batch`. Re-uploading identical bytes replays the existing
   result instead of creating duplicate calls.
3. Header/schema validation runs before row writes. Invalid rows create
   `kaudit_normalization_issue` records and block the batch from completion.
4. Accepted rows are normalized into `kaudit_call`,
   `kaudit_call_external_reference`, call timing/provider-cost records, and
   `kaudit_call_artifact.source_url`.
5. Each accepted call and its audit request are committed with an outbox
   message in the same transaction.

The application never continues its billing workflow from the user's local
spreadsheet. SQL is the processing gate after import.

## Automatic audit

The outbox publisher delivers one idempotent audit job per call. The worker:

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

This is intended to start automatically after a successful import. The
production write-side scheduler/executor is **not wired yet**; the repository
currently has the read-only real-call shadow runner and tested pure/writer
components.

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
| Monthly workbook/CSV upload and normalization writer | Not implemented |
| Automatic outbox-triggered full audit worker | Not implemented |
| Cycle-close accepted-as-billed fallback writer | Not implemented |
| Persisted D-12 snapshot generator | Not implemented |
| PDF/Excel export and recipient notification | Not implemented |
