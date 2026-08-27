# Usage import reliability (GAS → Kaudit)

## Contract

- The Google Apps Script (`integrations/google-apps-script/usage-import.gs`)
  sends up to 500 pending rows per request to `/api/v1/imports/usage`.
- Column K (`Import Status`) is the only state the script keeps:
  - **blank** — pending; retried on every run;
  - **Submitted** — durably accepted by Kaudit (accepted + duplicates accounted);
    never resent;
  - **Needs review** — permanently invalid against the canonical input
    contract; skipped by all later runs until an operator fixes the row and
    clears column K.

## Why a batch can be refused

Kaudit validates every row of a batch BEFORE any storage write. A batch with at
least one invalid row is refused whole (valid batches stay atomic), and the
400 response carries bounded descriptors only:

```json
{ "code": "INVALID_IMPORT_ROWS",
  "issues": [ { "rowIndex": 12, "field": "recordingUrl",
                "code": "RECORDING_URL_INVALID" } ] }
```

`rowIndex` is the 0-based position within the submitted CSV data rows; `field`
and `code` come from closed allowlists. Invalid values are NEVER returned.

Allowlisted codes: `TASK_ID_REQUIRED`, `TASK_ID_DUPLICATE`, `DURATION_INVALID`,
`AMOUNT_INVALID`, `DATETIME_INVALID`, `RECORDING_URL_INVALID`.

## What the script does

1. Local prevalidation pass mirrors the same contract before any network call.
   Locally invalid rows are marked `Needs review` immediately (spreadsheet row
   number, field, and code are logged — never values).
2. Batches are sent containing only still-blank rows.
3. On `INVALID_IMPORT_ROWS`, exactly the named rows are marked `Needs review`
   and the remainder is resubmitted without them.
4. On transient failures (network, 5xx) rows stay blank; the next run retries
   the identical batch.

## Operator recovery

To clear a malformed-row backlog:

1. Open Apps Script executions logs and filter for `kaudit_usage_row_invalid`;
   each entry names the spreadsheet row, field, and code.
2. Fix those source cells in the sheet (do not commit real values anywhere).
3. Clear column K for the fixed rows so they become pending again.
4. `Needs review` is terminal-by-default: the trigger never re-sends such rows.

Valid requests are written to canonical tables in bounded 500-row SQL batches.
Google Drive failures surface only one stage code (`CONFIGURATION`, `TOKEN`,
`LOOKUP`, `UPLOAD_SESSION`, or `UPLOAD`) under the common import-storage
refusal; provider response prose is discarded.

## Verification

```
npm run test:imports
KAUDIT_TEST_MYSQL_SOCKET=<isolated socket> npm run test:spend-lease:mysql
```

The GAS suite executes the real script inside a sandboxed VM with synthetic
sheets and network responses — no production sheet is ever touched.

## Deployment configuration

Set `KAUDIT_GAS_IMPORT_SECRET` in the Vercel environment and set the same value
in GAS Script Properties. The Vercel release preflight requires the secret and
validates its shape without printing it. Requests are accepted without a
browser cookie only when the HMAC binds the exact body hash, route, timestamp,
filename, and billing period.
