# Read-query performance: verification and index proposal

Scope: the read-only statements rewritten for the category page, audit monitor,
billing page, revenue reports, admin call access, and the Call Audit period
summary. Nothing in this runbook writes data or changes schema. Every command
below is a `SELECT`, `SHOW`, or `EXPLAIN`, and must be run by an approved
operator against a read replica or with a read-only account.

`EXPLAIN ANALYZE` executes the statement it explains. Run it only against
July 2026 (the month that timed out), one statement at a time, outside peak
hours. Plain `EXPLAIN FORMAT=TREE` does not execute and is the safe first step.

## 1. Inventory current indexes first

Do not propose or create an index until this has been compared.

```sql
SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME,
       COLLATION, SUB_PART
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN (
    'kaudit_call', 'kaudit_call_external_reference', 'kaudit_call_artifact',
    'kaudit_media_analysis', 'kaudit_transcript', 'kaudit_audit_finding',
    'kaudit_audit_run', 'kaudit_provider_cost', 'kaudit_billing_calculation',
    'kaudit_automated_decision', 'kaudit_ai_usage_event',
    'kaudit_call_audit_result', 'kaudit_call_audit_source_ref'
  )
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

SELECT VERSION();
```

A partial check already exists in the repo: the `billing-read-performance`
diagnostic (`scripts/report-billing-read-performance.mjs`) checks the
migration 0014/0016/0018 indexes by name and column order.

### Indexes the rewrite relies on

Already defined by reviewed migrations (verify present; do not duplicate):

| Table | Index | Used by |
| --- | --- | --- |
| `kaudit_call` | `idx_call_billing_period_id (billing_period_date, id)` (0014) | every month scope, billing page |
| `kaudit_call` | `idx_call_period_category_started (billing_period_date, canonical_outcome_code, source_started_at, id)` (0016) | category page window, monitor financial `FORCE INDEX` |
| `kaudit_call_artifact` | `idx_call_artifact_call_recording_final (call_id, artifact_type, is_final)` (0016) | every artifact probe |
| `kaudit_media_analysis` | `idx_media_analysis_artifact_classified_latest (call_artifact_id, status, classification_status, created_at DESC, id DESC)` (0016) | eligibility, latest analysis |
| `kaudit_transcript` | `idx_transcript_artifact_status_call (call_artifact_id, status, call_id)` (0016) | per-artifact transcript EXISTS |
| `kaudit_call_external_reference` | `idx_call_reference_call_type_first (call_id, reference_type, id)` (0016) | first task reference per call |
| `kaudit_audit_finding` | `idx_audit_finding_call_code_latest (call_id, finding_code, created_at DESC, id DESC)` (0016) | latest finding per call |
| `kaudit_audit_run` | `idx_audit_run_call_engine_status (call_id, engine_version, status)` (0018) | completed re-audit EXISTS |
| `kaudit_provider_cost` | `idx_provider_cost_call_sku_final (call_id, provider_sku, is_final)` (0016) | scoped vendor aggregation |
| `kaudit_billing_calculation` | `idx_billing_calc_supersedes (supersedes_calculation_id)` (0014), `uq_billing_calc_manifest (call_id, …)` (0006) | supersession, per-call EXISTS |
| `kaudit_automated_decision` | `fk_automated_decision_supersedes (supersedes_decision_id)`, `uq_automated_decision_manifest (call_id, decision_type, …)` (0006) | unresolved decisions |
| `kaudit_ai_usage_event` | `uq_ai_usage_audit_pass (audit_run_id, operation, pass_name)` (0007) | page usage aggregate by run |

Owned outside this repository's migrations (inspect with the query above):

- `kaudit_call.logical_call_key`
- `kaudit_call_external_reference.external_id`

The Task-ID candidate set (`matching_calls`) probes these two columns once per
request. Without an index on each, that probe is a single table scan per
request (still far cheaper than the former per-call `OR`/`EXISTS`, but not a
point lookup).

## 2. Statement plans for July 2026

Build the exact statement text from the repository (the builders are pure and
contact no database), then explain it with the same bound values:

```sh
node --input-type=module -e "
import { categoryCallsSql } from './src/adapters/mysqlBillingCategoryAnalysis.ts'
console.log(categoryCallsSql([
  'c.canonical_outcome_code IS NOT NULL',
  'c.billing_period_date BETWEEN ? AND ?',
]))"
```

| Surface | Builder | Bound values (July 2026) |
| --- | --- | --- |
| Category page 1 (all) | `categoryCallsSql(filters)` | `'2026-07-01','2026-07-31',25,0` |
| Category page (one category) | `categoryCallsSql([...filters,'c.canonical_outcome_code = ?'])` | `'2026-07-01','2026-07-31','<CATEGORY>',25,0` |
| Category totals | `categoryTotalsSql(categoryTotalsRowsSql(filters))` | `'2026-07-01','2026-07-31'` |
| No-recording totals | `noRecordingTotalsSql({periodStart,periodEnd})` | its `params` |
| Monitor core recording summary | `coreSummarySql(true)` | `'2026-07-01','2026-07-31'` |
| Monitor accepted fallback summary | `coreAcceptedFallbackSql(true)` | `'2026-07-01','2026-07-31'` |
| Monitor completed re-audit summary | `coreCompletedReauditSql(true)` | `'kairali-independent-reaudit/%','2026-07-01','2026-07-31'` |
| Monitor audited count / usage | `auditedCountAndUsageSql(filterSql(query))` | `filterSql(query).params` |
| Monitor financial | `auditedFinancialSummarySql(financialAuditedScope(query).sql)` | `financialAuditedScope(query).params` |
| Monitor audited rows | `auditedRowsSql(filterSql(query))` | `params, 26, 0` |
| Task-ID scoped rows | as above with `taskId` set | includes the Task ID twice |
| Admin call access | `ADMIN_CALL_ACCESS_SQL` | the Task ID four times |
| Billing summary | `billingCalculationSummarySql(period)`, `unresolvedAutomatedDecisionsSql(period)` | `'2026-07-01','2026-07-31'` |
| Revenue provider totals | `providerPeriodTotalsSql(n)` | `key,start,end` per period |
| Call Audit summary | repository `getPeriodSummary` (one statement) | vocabularies, flag needles, then scope |

Then, per statement:

```sql
EXPLAIN FORMAT=TREE <statement>;          -- safe: does not execute
EXPLAIN ANALYZE <statement>;              -- executes; July only, one at a time
```

What to look for:

- No `Table scan on` a base table (`kaudit_media_analysis`,
  `kaudit_call_artifact`, `kaudit_transcript`, `kaudit_provider_cost`,
  `kaudit_ai_usage_event`) at the root of a join. Scans of CTE/derived names
  (`page_calls`, `vendor`, `provider_claim`, `audited_page`, …) are expected.
- The category page shows `Limit: 25 row(s)` inside `page_calls`, before the
  vendor, media payload, and finding lookups.
- `matching_calls` is not a `dependent` subquery (`EXPLAIN FORMAT=JSON`).
- The three `JOIN_FIXED_ORDER()` hints (category evidence, category page window,
  monitor `artifact_state`) keep `kaudit_call` leading. Without them a local
  MySQL 9.6 run drove from every media analysis / artifact in the table.

Known, unchanged: the category totals' vendor relation
(`SCOPED_VENDOR_BILLING_SQL`) may still scan `kaudit_provider_cost` when the
optimizer prefers it; it was not part of this rewrite.

## 3. Index proposal (NOT applied; needs separate approval)

Only if the inventory in section 1 shows the column is not already the leading
column of an index:

```sql
-- Task-ID candidate resolution (matching_calls).
ALTER TABLE kaudit_call
  ADD KEY idx_call_logical_key (logical_call_key);
ALTER TABLE kaudit_call_external_reference
  ADD KEY idx_call_reference_external_type (external_id, reference_type, call_id);
```

Evaluated and not proposed now (an existing index already leads with the
lookup columns, or each call has only a handful of rows, so a wider index is
not justified without a production plan showing otherwise):

- `kaudit_call_artifact(call_id, artifact_type, is_final, created_at, id)` —
  0016 index covers the lookup; per-call rows are few.
- `kaudit_transcript(call_artifact_id, status, call_id, created_at, id)` —
  0016 index covers the EXISTS; latest transcript sorts a few rows.
- `kaudit_audit_finding(call_id, audit_run_id, finding_code, created_at, id)` —
  0016 index covers `call_id, finding_code` with the same ordering.
- `kaudit_billing_calculation(call_id, status, calculation_basis)` —
  `uq_billing_calc_manifest` leads with `call_id`.
- `kaudit_automated_decision(supersedes_decision_id)` — already
  `fk_automated_decision_supersedes`.
- `kaudit_automated_decision(call_id, decision_status, decision_type)` —
  `uq_automated_decision_manifest` leads with `call_id, decision_type`.
- `kaudit_ai_usage_event(audit_run_id, call_id)` — `uq_ai_usage_audit_pass`
  leads with `audit_run_id`.

## 4. Local equivalence suite

`src/adapters/readQueryRewrite.mysql.integration.test.ts` runs every
rewritten statement beside the statement it replaced on a disposable local
MySQL and requires identical results (including DECIMAL text). It runs only
when `KAUDIT_TEST_MYSQL_SOCKET` points at `/tmp/kaudit-*/mysql.sock`:

```sh
KAUDIT_TEST_MYSQL_SOCKET=/tmp/kaudit-<name>/mysql.sock npm run test:read-rewrite:mysql
```
