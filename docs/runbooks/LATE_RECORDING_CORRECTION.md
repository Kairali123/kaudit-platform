# Late recording correction runbook

Recurring monthly workflow for calls KServe supplied with a Task ID but **no
recording**.

Those calls settle at INR 0 under the standing `no_recording_zero` rule: there
is no evidence to support a charge. When the recording turns up later — often a
month after the bill closed — an administrator uploads it against the month it
belongs to, and **only those exact tasks** are re-audited and re-priced.

---

## What it is, and what it is not

It **is** an evidence attachment followed by an ordinary audit and an ordinary
deterministic billing pass. The revised amount may be zero or non-zero; the
recording decides, not the workflow.

It is **not** a way to reopen a call that already has evidence. An artifact
whose `source_url` is already set, or that already carries a `sha256`, is
immutable: a different URL is a **conflict** and is refused, never overwritten.
The one permitted transition is `NULL -> canonical URL`, because before it there
was no evidence at all.

It **never** writes `kaudit_kserve_monthly_settlement`. That table is what
Finance actually **paid**. This workflow corrects what the auditor says was
**payable**, records the delta as a proposal, and leaves accepting it an
explicit, append-only Finance action.

---

## Prerequisites

| Requirement | Why |
|---|---|
| Migration 0020 applied | Creates the three control tables. |
| An invoice received for the month | A month with no invoice is not reconcilable. |
| A published rate card covering the month | Money cannot be written without one; the upload is refused as a whole if there is none. |
| `KAUDIT_ALLOWED_RECORDING_HOSTS` set | An empty allowlist rejects every URL. |
| A worker dispatcher configured | A commit is refused if nothing can audit the evidence it would attach. |
| `admin` role (`billing:approve` **and** `audit:control`) | The workflow supersedes a settled month's calculations and spends on a model. |

### Applying migration 0020

Expand-only: three `CREATE TABLE`s, no row of any existing table read or
written. Safe to re-run; an existing table is reported and left as found.

Run the `audit-worker.yml` workflow with:

- `system: billing`
- `mode: migration-0020`
- `migration_confirmation: APPLY_0020`

Verify with the read-only `SHOW CREATE TABLE` / `information_schema` queries at
the bottom of `migrations/0020_late_recording_corrections.sql`.

---

## The file

Exactly two columns, up to **100 rows**, one bill month per upload:

```csv
Task ID,Recording URL
T-EXAMPLE-0001,https://<allowlisted-s3-host>/media/private/example.ogg
```

Signed (`?X-Amz-...`) and proxy-wrapped (`?url=...`) URLs are accepted. The
signing query is stripped and only the **canonical stable S3 object URL** is
stored — so re-uploading the same spreadsheet with a fresh signature is an
idempotent replay, not a conflict.

---

## Steps

### 1. Check the file (writes nothing)

Admin → **Imports** → *Late recording correction*. Pick the bill month, choose
the CSV, press **Check file**.

Every statement this runs is a `SELECT`. It reports, per spreadsheet row, one
of: ready, already attached, or a bounded rejection reason.

### 2. Attach and audit

Press **Attach and audit**. In one transaction this:

1. sets `source_url` on each accepted artifact, with
   `source_url IS NULL AND sha256 IS NULL` carried into the `UPDATE`, so the
   database itself refuses a row that changed since the preview;
2. writes the batch and its items (`kaudit_late_recording_batch`,
   `kaudit_late_recording_item`); and
3. dispatches the late-recording worker with the **opaque batch handle only**.

The retry key makes a double-clicked button, a retried fetch, or a re-delivered
request replay the same batch. The same key carrying a *different* selection is
a 409 conflict, never a second attachment.

### 3. Watch it finish

The same panel shows accepted, queued, auditing, completed, failed, old amount,
revised amount, and the total adjustment. It polls every 10 s and stops only
after the immutable month-correction row exists; terminal item counts alone do
not make the screen report a finished financial correction.

---

## What the worker does

`npm run latereco:worker`, or the `late-recording` workflow mode.

```
KAUDIT_LATE_RECORDING_MODE=EXECUTE
KAUDIT_LATE_RECORDING_BATCH_ID=lrb_<uuid>     # omit for recovery
KAUDIT_LATE_RECORDING_BATCH=5
```

It takes the **same** `kaudit-independent-reaudit-v2` advisory lock as the
general Billing Audit worker, and the **same** durable pre-model spend lease and
transcript cache, so two runs can never pay twice for one recording.

Then, per batch:

| Pass | What it does |
|---|---|
| 1 — audit | Claims accepted items of **this batch only** (`batch_id = ?`, nothing else selects work), runs the ordinary audit, persists model/ruleset/confidence/evidence hash. |
| 2 — correct | Reads persisted audit state and writes money. A completed audit runs the approved automated consensus validation and adjudication policy, scoped to that exact call through the same shared runner the month-wide validation uses. Consensus accepted → the verified calculation it writes **supersedes** the `no_recording_zero` one. Consensus unresolved → the deterministic `independent_audited_projection`, this platform's own audited duration capped at the vendor charge. Terminal audit exhaustion (no audit result at all) → the approved `accepted_as_billed_unverified` policy, scoped to that task. Still in flight → nothing is written. |
| 3 — month | Invalidates the month summary cache, re-reads the verified total, and atomically appends one `kaudit_late_recording_month_correction` row and terminalizes the batch: previous total, revised total, delta, corrected count, completion time, plus a snapshot of what Finance has recorded as paid and the proposed adjustment. |

Pass 2 is a **function of durable state**, so re-running it is harmless and is
exactly how an interrupted batch finishes. Note that the consensus pass inside
it spends on a second (and occasionally a third) model call per corrected call,
exactly as the month-wide validation runner does; unlike the audit pass it is
not covered by a pre-model spend lease, so the batch bound of 100 rows is the
ceiling on that spend.

The superseded calculation and its decision are preserved unchanged. Nothing is
updated in place.

---

## Recovery

A batch with no immutable correction row — a failed dispatch, a dead host, a
worker that lost its lock, or a crash after every item settled but before the
month result was appended — is finished automatically by the hourly
`late-recording-recover` schedule. It discovers its own work from durable state
and takes no batch handle, so an administrator never has to re-upload.

An interrupted item remains `auditing`. The ordinary artifact processing state
controls its bounded resume: a retry whose `audio_next_attempt_at` is due is
reclaimed under the same item claim, completed audits are never re-spent, and
terminally exhausted audits move to the approved fallback in the correction
pass. Attaching a late recording resets the artifact's stale no-recording retry
state before the first attempt.

To finish a specific batch by hand, dispatch `audit-worker.yml` with
`mode: late-recording` and `late_recording_batch_id: lrb_<uuid>`.

---

## Privacy

A **recording URL has exactly one home**: `kaudit_call_artifact.source_url`,
which is server-only and never exported.

Nothing else holds or emits one. The batch and item tables store the SHA-256 of
the canonical URL. No preview, receipt, progress read, dispatch payload,
workflow input, worker log line, access-log entry, error, or export carries a
URL, and the API responses and audit events are asserted against that in
`src/http/enterpriseDashboardServer.lateRecording.test.ts`.

The progress screen shows the Task IDs the administrator typed themselves. It
shows no call id, artifact id, audit-run id, item id, or batch handle.

---

## Rejection reasons

Every refusal is one of a closed set, reported against a spreadsheet row number
and nothing else.

| Code | Meaning |
|---|---|
| `TASK_ID_REQUIRED` / `TASK_ID_DUPLICATE` / `TASK_ID_TOO_LONG` | Shape of the Task ID column. |
| `RECORDING_URL_REQUIRED` / `RECORDING_URL_TOO_LONG` | Shape of the URL column. |
| `URL_UNPARSEABLE` / `URL_NOT_HTTPS` / `URL_NOT_ALLOWLISTED` | The URL is not an allowlisted HTTPS S3 object. |
| `TASK_NOT_FOUND` | No call with that Task ID **in the selected month**. |
| `TASK_AMBIGUOUS` | The Task ID matches more than one call; never guessed. |
| `INVOICE_MISSING` | No invoice received for the month. |
| `CALL_STATE_INELIGIBLE` | Already settled on other evidence. |
| `RECORDING_ARTIFACT_MISSING` | No final recording artifact to attach to. |
| `RECORDING_URL_ALREADY_PRESENT` | Evidence is already attached; a different URL is a conflict. |
| `AUDIT_ALREADY_COMPLETED` | The call has already been audited. |
| `RATE_CARD_UNAVAILABLE` | No published rate card covers the month; the whole upload is refused. |

---

## Finance hand-off

After a batch completes, the auditor-verified payable total and the variance
update automatically (the month summary cache is dropped, so the next read
recomputes them).

`kaudit_late_recording_month_correction` holds the proposal:

```sql
SELECT bill_month, previous_verified_total, revised_verified_total,
       delta_amount, actual_paid_amount, revised_variance,
       corrected_count, failed_count, completed_at
FROM kaudit_late_recording_month_correction
ORDER BY completed_at DESC;
```

If Finance accepts it, they record the new actual-paid figure through the
existing monthly settlement action, which appends a superseding version to
`kaudit_kserve_monthly_settlement`. Nothing in this workflow does that for them.

---

## Tests

```bash
npm run test:latereco
```

Covers validation, exact batch scope, duplicates and conflicts, URL privacy,
settled-calculation supersession, partial failures, retries, cache
invalidation, and fixed-precision correction totals.
