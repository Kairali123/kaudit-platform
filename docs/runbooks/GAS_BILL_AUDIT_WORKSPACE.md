# Google Sheets Bill Audit Workspace

This runbook covers the bounded Google Apps Script audit workspace. The Sheet
may transcribe and classify recordings, but the Kaudit server remains the money
authority: it re-reads KServe cost facts from MySQL, validates classifications,
runs the same deterministic category/grace/rounding engine, and persists the
decision trace.

## One-time setup

1. Publish `integrations/google-apps-script/bill-audit-workspace.gs` to the
   bound Apps Script project.
2. Run `upgradeWorkspace` once. It stops continuation triggers, preserves
   evidence, installs the 12-category policy, blocks old calculations, and
   requeues recording-backed calls. It does **not** start an AI batch.
3. In Vercel, configure both variables together:
   - `KAUDIT_GAS_AUDIT_SYNC_SECRET`: a dedicated 32–256 character HMAC secret.
   - `KAUDIT_GAS_AUDIT_SYNC_RATE_CARD_ID`: the exact published Kaudit rate-card
     version used for server-side billing.
4. In the Sheet, use **Bill Audit → Set SQL sync secret** and enter the same
   HMAC secret. Never put the secret in a cell.
5. Set `SQL_SYNC_ENABLED` to `true` only after the deployed endpoint passes a
   signed test request.

## Monthly operation

1. Set `ACTIVE_BILL_MONTH` to `YYYY-MM` and point the source settings at the
   immutable KServe monthly snapshot.
2. Use **Import KServe month**, then **Build audit queue**.
3. Review the queue counts. Starting **Run audit batch** spends OpenAI credits;
   do so only after the monthly input and recording URLs are confirmed.
4. The script checkpoints before the configured safe runtime, then schedules a
   bounded continuation until no `PENDING`, `RUNNING`, or `RETRY_WAITING` rows
   remain.
5. `UNRESOLVED` calls withhold money. A third classifier runs only for a lone
   category disagreement; duration or customer-speech disagreement remains
   unresolved.
6. Use **Sync pending results**. Requests contain at most 20 calls and are
   signed over method, route, timestamp, body hash, month, and batch ID.
7. Approve the invoice. `Summary!E10` reaches `READY` only when every call has
   an explicit resolution, no work remains active, SQL sync is complete when
   enabled, and the invoice is approved.

## Locked billing behavior

- No recording: zero.
- Adjusted duration below 30 seconds: 0.5 minute / ₹4.75.
- Otherwise: round up to the next whole minute at ₹9.50 per minute.
- `AGENT_FAILURE`: zero unless the engine proves meaningful two-way service
  before an in-recording failure boundary; then charge through that boundary
  plus exactly 30 seconds, capped by the recording.
- The model never calculates money, grace, rounding, or the final bill.

## Recovery

- **Stop audit** removes continuation triggers and prevents new claims.
- Existing audio and audit JSON evidence is immutable and reused by hash.
- A failed or rejected SQL item remains unsynced and keeps settlement blocked.
- Never copy an OpenAI key or HMAC secret into the workbook or repository.
