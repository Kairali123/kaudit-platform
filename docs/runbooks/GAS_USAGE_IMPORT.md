# Google Apps Script usage import

This integration submits the first 10 sheet columns as the locked KServe usage
CSV contract. Column K is Kaudit-owned import status. A row is eligible only when
column K is blank. Blank Task IDs are still validated and marked `Needs review`;
they are never silently omitted from the pending set.

## Configuration

1. Deploy Kaudit with `KAUDIT_GAS_IMPORT_SECRET` set to a random 32-byte-or-longer
   URL-safe value. Do not reuse a database, Google Drive, browser-session, or
   GitHub credential.
2. Open the source spreadsheet's Apps Script project and add
   `integrations/google-apps-script/usage-import.gs`.
3. In Apps Script Project Settings, add these Script Properties:

| Property | Value |
| --- | --- |
| `KAUDIT_IMPORT_ENDPOINT` | The deployed `/api/v1/imports/usage` endpoint |
| `KAUDIT_GAS_IMPORT_SECRET` | The exact dedicated secret configured in Vercel |
| `KAUDIT_PERIOD_START` | Inclusive billing start, such as `2026-06-01` |
| `KAUDIT_PERIOD_END` | Billing end, such as `2026-06-30` |
| `KAUDIT_SHEET_NAME` | Optional tab name; active tab is used when omitted |

4. Run `submitPendingKauditUsage` once from the Apps Script editor and approve
   Sheets and external-request permissions.
5. Run `installKauditUsageTrigger` once to install the five-minute retry trigger.

## Retry behavior

Each trigger run submits at most four batches of 500 rows. Kaudit signs and
checks the exact CSV bytes, period, filename, route, and a five-minute timestamp.
The script writes `Submitted` to column K only when the response accounts for
every row as accepted or duplicate. Permanent validation failures become
`Needs review`; transport, server, malformed-receipt, and partial-receipt
failures leave K blank, so the next trigger retries those rows.

Kaudit's content hash and Task ID constraints make a retry after a lost response
safe: an already committed batch is returned as duplicate and then marked
`Submitted`. Logs contain only bounded stage/status/count information, never
sheet values, recording references, response bodies, credentials, or database
details.

See `docs/runbooks/USAGE_IMPORT_RELIABILITY.md` for row-validation behavior and
operator recovery.
