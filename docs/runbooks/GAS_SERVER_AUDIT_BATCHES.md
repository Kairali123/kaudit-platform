# Google Apps Script server audit batches

This is the no-GitHub-worker path for monthly audits and prior-month
reconciliation. Google Sheets controls a bounded queue; the dedicated Vercel
function fetches the recording or stored transcript, runs the models, persists
the audit, and applies deterministic billing.

## Supported Sheet modes

| Mode | Sheet input | Server behavior |
| --- | --- | --- |
| `new_month` | Imported Task ID and recording URL | Uses the imported database call, transcribes with ElevenLabs Scribe v2, classifies with GPT-6 Luna, validates, and bills. |
| `late_recording` | Task ID and replacement recording URL | Attaches the new immutable recording evidence, audits it, appends the correction, and recalculates the month adjustment. |
| `transcript_reaudit` | Task ID only | Reuses the completed transcript bound to the final recording hash. It does not download or transcribe the recording again. |

All three modes share one `Audit Intake` tab (A:J the locked KServe usage
columns, K `Import Status`, L `Kaudit Audit Mode`, M `Kaudit Bill Month`, then
the lifecycle columns). The base importer uploads only `new_month` (or blank
mode) rows and leaves the other modes untouched. Run
`setupKauditUnifiedIntake` (menu: **Set up Audit Intake tab**) once; it creates
or repairs headers, the mode dropdown, the text month column, the frozen header
and status colours, and stops without writing if an existing header conflicts.
It never clears or queues rows.

Only Task IDs placed in the configured tabs are selected. Existing historical
rows elsewhere, including old `REAUDIT_REQUIRED` rows, are not swept into this
queue.

## Vercel configuration

Set these production environment variables and redeploy:

```text
KAUDIT_RECONCILIATION_ENABLED=true
KAUDIT_TRANSCRIPTION_PROVIDER=elevenlabs
ELEVENLABS_API_KEY=<set manually in Vercel>
OPENAI_API_KEY=<existing OpenAI project key>
KAUDIT_GAS_AUDIT_SYNC_SECRET=<existing dedicated Sheet sync secret>
KAUDIT_GAS_AUDIT_SYNC_RATE_CARD_ID=<published finance rate card>
KAUDIT_UNPOD_PROXY_BASE=<existing recording proxy>
KAUDIT_ALLOWED_RECORDING_HOSTS=<existing allowlist>
```

The server default is ElevenLabs. Whisper remains an explicit rollback only
when `KAUDIT_TRANSCRIPTION_PROVIDER=openai` is deliberately configured.

## Apps Script configuration

Add both the existing importer and
`integrations/google-apps-script/server-audit-batches.gs` to the bound Apps
Script project. Set these Script Properties:

| Property | Required | Example |
| --- | --- | --- |
| `KAUDIT_RECONCILIATION_ENDPOINT` | Yes, unless derived from `KAUDIT_IMPORT_ENDPOINT` | `https://kaudit-platform.vercel.app/api/v1/reconciliation/batch` |
| `KAUDIT_GAS_AUDIT_SYNC_SECRET` | Yes | Same dedicated secret as Vercel |
| `KAUDIT_AUDIT_SHEET_NAMES` | Optional; defaults to `Audit Intake` (never the active tab) | `Audit Intake` |
| `KAUDIT_BILL_MONTH` | Fallback only; prefer the row's `Kaudit Bill Month` | `2026-08` |
| `KAUDIT_AUDIT_YEAR` | Optional for tabs named only by month | `2026` |
| `KAUDIT_AUDIT_PARALLEL_BATCHES` | Optional, 1–8 | `4` |
| `KAUDIT_AUDIT_MODE` | Optional default | `new_month` |

For a new-month source tab, keep the existing `Import Status` column. A row is
not audited until the base importer has written `Submitted`. Use
`KAUDIT_BASE_DATA_ALREADY_IMPORTED=true` only for a supervised sheet whose
exact Task IDs are already present in Kaudit.

A row without a usable month is marked `FAILED` / `BILL_MONTH_MISSING`
without stopping the other rows; fix the month and use **Retry selected server
audits**.

Run `installKauditServerAuditTrigger` once. The one-minute trigger sends up to
four parallel requests by default, with no more than three calls in each
request. Increase the parallel-request count only after observing database and
provider capacity.

## Per-row lifecycle

The controller adds these columns without changing the source columns:

- `Kaudit Audit Status`
- `Kaudit Audit Stage`
- `Kaudit Audit Error`
- `Kaudit Audit Batch ID`
- `Kaudit Audit Attempt`
- `Kaudit Audit Updated At`
- `Kaudit Revised Amount`

It drains all first attempts before retrying failed or transient rows. A retry reuses
the original batch ID and the complete original batch, so a lost response is
idempotent. Each batch gets at most one automatic final retry. Permanent
validation errors remain `FAILED`; use `retrySelectedKauditServerAudits` only
after correcting the cause.

Billing writes remain append-only, use the published fixed-precision rate card,
and supersede prior calculations through the audited database workflow. The
model never calculates the amount.
