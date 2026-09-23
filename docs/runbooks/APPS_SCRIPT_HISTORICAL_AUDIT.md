# Apps Script historical audit and re-audit

This workflow handles a prior month without an audit worker. It downloads the
month's database facts into the private Bill Audit spreadsheet, lets an
administrator select exact calls, runs the same Apps Script AI audit, and
appends verified results back to MySQL for the Vercel application.

## Safety rules

- Database recording URLs are server-only and are never downloaded to the
  spreadsheet. `Recording Status` says only `ATTACHED` or `MISSING`.
- An administrator must paste a recording URL and tick `Audit Required` for
  every call that should run. Unmarked rows never enter the AI queue.
- A missing URL may be attached once. An existing evidence URL may be used for
  re-audit only when the submitted URL resolves to the same canonical object.
  It is never overwritten.
- Audit and billing history is append-only. A successful re-audit advances the
  current audit and supersedes the prior verified calculation; it does not
  rewrite the KServe invoice or the settled vendor payment.
- A signed state token stops stale spreadsheet rows from replacing a newer
  database audit. Re-sync the month when `ROW_CHANGED_RESYNC_REQUIRED` appears.

## Operator steps

1. In `Settings`, set `ACTIVE_BILL_MONTH` to the required month in `YYYY-MM`
   format. Keep `SQL_SYNC_ENABLED` set to `true`.
2. Use **Bill Audit → Sync database month**. The `Database Audit` tab receives
   all audited and unaudited calls in pages of 500.
3. For each required call, paste the supplied URL into `Recording URL` and tick
   `Audit Required`. Do not tick calls that should remain unchanged.
4. Use **Bill Audit → Queue marked database rows**. The server validates the
   task, month, evidence state, URL host, and immutable evidence match before
   the row enters `AI Queue`.
5. Use **Bill Audit → Start or resume audit**. Continuation triggers process
   only the queued rows, in the configured batch size.
6. Use **Bill Audit → Sync pending results** until the selected rows show
   `SYNCED`. Each signed request contains at most 20 results and one month.
7. Use **Bill Audit → Sync database month** again to refresh the current
   category, confidence, amount, calculation basis, and audit status. The
   Vercel application reads the same current database records.

`Prepared Mode` explains the server decision:

- `LATE_RECORDING`: the call had no recording and no completed audit.
- `INITIAL_AUDIT`: recording evidence existed but no completed audit existed.
- `REAUDIT`: a completed audit existed; the new successful result is appended.

The sync preserves operator columns such as `Recording URL`, `Audit Required`,
request key, and notes for matching Task IDs, while refreshing database-owned
facts and the signed state token.
