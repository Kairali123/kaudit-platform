import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  KSERVE_MINUTE_MS,
  KSERVE_SHORT_CALL_CUTOFF_MS,
} from '../billing/kserveRules.ts'
import {
  KSERVE_VENDOR_RATE_PER_MINUTE,
  vendorBilledAssertionsSql,
} from './mysqlKserveVendorBilled.ts'

/**
 * Read model for the Billing Audit CATEGORY ANALYSIS page.
 *
 * A dedicated adapter rather than another branch of the audit monitor: the
 * monitor answers "is processing keeping up", this answers "what does each
 * outcome category cost, and how far does the vendor's billed time sit from the
 * time we audited". The two questions want different scopes and different
 * aggregates, and the monitor is already large.
 *
 * Boundaries this module keeps:
 *
 *   * READ-ONLY SELECTs over Kaudit-owned `kaudit_*` tables only. Nothing here
 *     writes, locks, alters, or references the external voice-lead source table.
 *   * The vendor figure comes from its supplied amount when present, with a
 *     billed-minutes rate fallback only when blank. The auditor figure is a capped audit
 *     projection: the audited duration is priced with the locked KServe
 *     rounding rule, then capped per call at the vendor charge. A call without
 *     an audited duration contributes no auditor amount and is counted as
 *     unpriced; this preserves the long-standing invariant that the auditor
 *     amount cannot exceed KServe for the same call.
 *   * The row shape carries no recording URL, evidence hash, internal call id,
 *     transcript, source-row id, or provider prose. The only call identity is
 *     the approved task reference. Internal ids are used inside the statements
 *     for joining, ranking and ordering, and are never projected.
 *   * "Audited" means what it means everywhere else on the platform: ONE final
 *     recording artifact carrying both a completed, classified media analysis
 *     and a completed transcript. Evidence is never assembled from two
 *     different artifacts.
 *
 * Performance: every relation a row or an aggregate needs — task reference,
 * recording availability, audited evidence, current vendor cost, current final
 * calculation — is a grouped or ranked derived table joined ONCE. There is no
 * per-row correlated subquery, so a page of rows costs the same shape of work
 * as one row.
 */

// ---------------------------------------------------------------------------
// Port
// ---------------------------------------------------------------------------

export interface BillingCategoryScope {
  /** Inclusive bill-period bounds, or null for every stored period. */
  periodStart: string | null
  periodEnd: string | null
}

/** One bounded page of one category selection inside a month. */
export interface BillingCategoryPageScope extends BillingCategoryScope {
  /** A single canonical outcome code, or null for every category. */
  category: string | null
  limit: number
  offset: number
}

/**
 * One category's totals over the WHOLE selected month, never over a page.
 *
 * Decimal money arrives as the database's own fixed-precision text; it is
 * normalized once, at the reporting edge, and never through a binary float.
 */
export interface BillingCategoryTotalsRow {
  category: string
  /**
   * Audited calls in the category for the whole month. It is also the pager's
   * denominator: the page statement selects from the same scoped calls under
   * the same audited-evidence join, so this counts exactly what a page pages.
   */
  auditedCallCount: number
  issueFoundCount: number
  noIssueFoundCount: number
  /** Calls carrying final vendor billed-minute evidence. */
  kservePricedCalls: number
  kserveChargeInr: string
  /** Calls with a capped auditor amount projection. */
  auditorFinalPricedCalls: number
  /** Audited calls with no audited duration, so no auditor amount. */
  auditorUnfinalizedCalls: number
  auditorFinalChargeInr: string
  /** Null when no call in the category carried the duration at all. */
  kserveChargeTimeMs: number | null
  aiAuditedDurationMs: number | null
  /** Calls carrying BOTH durations, so the gap is defined. */
  comparableCalls: number
  gapMs: number | null
  aiAuditedDurationCalls: number
}

export interface BillingCategoryCallRow {
  /** Approved display identifier. Never an internal call id. */
  callReference: string
  /** `YYYY-MM-DD` of the stored call start, or of the bill period. */
  callDate: string | null
  /** Stored wall-clock reading `YYYY-MM-DD HH:MM:SS`. Never re-zoned. */
  callStartAt: string | null
  callEndAt: string | null
  category: string
  /** Final vendor billed minutes expressed in milliseconds. */
  kserveChargeTimeMs: number | null
  /** Vendor-supplied amount, with the fixed-rate fallback only when absent. */
  kserveChargeInr: string
  /** Grace-adjusted audited duration: audit metadata, not a charge. */
  aiAuditedDurationMs: number | null
  /** Deterministic audited-duration projection, capped at the vendor charge. */
  auditorFinalChargeInr: string | null
  /** Latest classifier confidence as exact decimal text. */
  aiConfidence: string | null
  aiAuditResult: 'Issue found' | 'No issue found'
  /** Bounded Kaudit-owned rationale from the authoritative latest audit run. */
  aiAuditRemark: string | null
  /** KServe billed duration minus AI-audited duration. Sign preserved. */
  gapMs: number | null
  /** Presence signal only. The recording reference itself never leaves here. */
  recordingAvailable: boolean
}

/**
 * The MONTH-level half of the read model: the two aggregates that describe a
 * whole bill month and do not move when a reader selects a category or turns a
 * page. Kept as its own port so the table reads below cannot accidentally pull
 * a month-wide scan in behind them.
 */
export interface BillingCategorySummaryPort {
  /**
   * Every available category for the month with its month-wide totals. The
   * table's own scope totals are read from this same result, so a footer total
   * can never drift from the KPI it sits under.
   */
  listCategoryTotals(
    scope: BillingCategoryScope,
  ): Promise<BillingCategoryTotalsRow[]>
  listNoRecordingTotals(
    scope: BillingCategoryScope,
  ): Promise<BillingCategoryTotalsRow>
}

/**
 * The PAGE-level half: ONE read, for one bounded page of rows.
 *
 * There is deliberately no second read here. The pager's denominator is the
 * selected category's `auditedCallCount`, which the month summary above already
 * reports for every category and for the all-categories selection, and which is
 * the count of exactly the population `listCalls` pages over. Counting it again
 * per page would double every table request for a number the page already holds.
 */
export interface BillingCategoryPagePort {
  listCalls(
    scope: BillingCategoryPageScope,
  ): Promise<BillingCategoryCallRow[]>
}

export interface BillingCategoryAnalysisPort
  extends BillingCategorySummaryPort,
    BillingCategoryPagePort {}

// ---------------------------------------------------------------------------
// Derived relations. Each is grouped or ranked to exactly one row per call.
// ---------------------------------------------------------------------------

/**
 * A call's audited evidence: the media analysis that defines its audited
 * duration, chosen so the analysis and the transcript that make the call
 * "audited" come from ONE final recording artifact.
 *
 * This is the platform's audited invariant (`AUDITED_JOIN` in
 * `mysqlAuditMonitor.ts`) expressed as a one-row-per-call relation. A call is
 * audited only where a single final recording artifact carries BOTH a
 * completed, classified media analysis AND a completed transcript. Taking the
 * latest analysis across all artifacts and, separately, any completed
 * transcript on the call would let a call qualify on evidence that never
 * described the same recording — and would report that mismatched analysis's
 * duration as the audited one.
 *
 * Ranked rather than grouped for two reasons: two columns of one specific
 * analysis are needed together (a GROUP BY with two MAX() could blend one
 * analysis's decoded duration with another's conversation end), and a call with
 * several eligible artifacts must resolve to exactly one complete evidence set.
 * The rank orders by analysis recency and breaks ties on the analysis id, which
 * is unique, so the choice is total and repeatable; because the ranking runs
 * only over artifact-consistent pairs, the winning analysis is also the latest
 * one on its own artifact. Neither the artifact id nor the analysis id is
 * projected out of the relation.
 */
const AUDITED_EVIDENCE_SQL = `
  SELECT
    ranked.call_id,
    ranked.decoded_duration_ms,
    ranked.conversation_end_ms,
    ranked.metrics_json
  FROM (
    SELECT
      artifact.call_id,
      analysis.decoded_duration_ms,
      analysis.conversation_end_ms,
      analysis.metrics_json,
      ROW_NUMBER() OVER (
        PARTITION BY artifact.call_id
        ORDER BY analysis.created_at DESC, analysis.id DESC
      ) AS current_rank
    FROM kaudit_call_artifact artifact
    JOIN scoped_calls evidence_scope
      ON evidence_scope.id = artifact.call_id
    JOIN kaudit_media_analysis analysis
      ON analysis.call_artifact_id = artifact.id
    JOIN (
      SELECT DISTINCT
        transcript.call_id,
        transcript.call_artifact_id
      FROM kaudit_transcript transcript
      WHERE transcript.status = 'completed'
    ) transcript
      ON transcript.call_id = artifact.call_id
     AND transcript.call_artifact_id = artifact.id
    WHERE artifact.artifact_type = 'recording'
      AND artifact.is_final = 1
      AND analysis.status = 'completed'
      AND analysis.classification_status = 'completed'
  ) ranked
  WHERE ranked.current_rank = 1
`

/** Whether a final recording artifact carries a source at all. Never the URL. */
const RECORDING_AVAILABILITY_SQL = `
  SELECT
    artifact.call_id,
    MAX(artifact.source_url IS NOT NULL) AS recording_available
  FROM kaudit_call_artifact artifact
  JOIN scoped_calls recording_scope
    ON recording_scope.id = artifact.call_id
  WHERE artifact.artifact_type = 'recording'
    AND artifact.is_final = 1
  GROUP BY artifact.call_id
`

/**
 * The approved task reference, one row per call.
 *
 * The platform's convention is the FIRST matching reference by `reference.id`
 * (see `mysqlAuditMonitor.ts` and `mysqlAdminCallDetail.ts`), not the
 * lexicographically smallest external id: a call that later gains a second task
 * reference must keep displaying the one it has always displayed, and
 * `MIN(external_id)` would silently switch it whenever the newer id happens to
 * sort earlier. Ranked once per call rather than looked up per displayed row,
 * so the page still costs one pass over this relation. The internal reference id
 * orders the rank and is never projected.
 */
const TASK_REFERENCE_SQL = `
  SELECT
    ranked.call_id,
    ranked.external_id
  FROM (
    SELECT
      reference.call_id,
      reference.external_id,
      ROW_NUMBER() OVER (
        PARTITION BY reference.call_id
        ORDER BY reference.id ASC
      ) AS reference_rank
    FROM kaudit_call_external_reference reference
    JOIN scoped_calls reference_scope
      ON reference_scope.id = reference.call_id
    WHERE reference.reference_type IN ('task_id','taskId','task')
  ) ranked
  WHERE ranked.reference_rank = 1
`

/** Classifier result belonging to the call's authoritative latest audit run. */
const LATEST_AUDIT_FINDING_SQL = `
  SELECT
    ranked.call_id,
    ranked.confidence,
    ranked.explanation
  FROM (
    SELECT
      finding.call_id,
      finding.confidence,
      finding.explanation,
      ROW_NUMBER() OVER (
        PARTITION BY finding.call_id
        ORDER BY finding.created_at DESC, finding.id DESC
      ) AS finding_rank
    FROM kaudit_audit_finding finding
    JOIN scoped_calls finding_scope
      ON finding_scope.id = finding.call_id
     AND finding_scope.latest_audit_run_id = finding.audit_run_id
     AND finding_scope.canonical_outcome_code = finding.finding_code
  ) ranked
  WHERE ranked.finding_rank = 1
`

/**
 * Both vendor assertions in one scoped provider-cost pass. `MAX(CASE ...)`
 * preserves the revision semantics of the shared KServe read model while
 * avoiding two full grouped scans for every category-analysis request.
 */
const SCOPED_VENDOR_BILLING_SQL = vendorBilledAssertionsSql(
  'JOIN scoped_calls vendor_scope ON vendor_scope.id = cost.call_id',
)

/**
 * Duration semantics, defined once and used by both the aggregate and the rows.
 *
 *   * `kserve_charge_time_ms` — final vendor BILLED minutes, in milliseconds.
 *     This is the time KServe charges for.
 *   * `ai_audited_duration_ms` — the grace-adjusted audited duration: the
 *     recorded duration capped at the category-policy grace after its verified
 *     service endpoint. Legacy rows fall back to customer end plus one minute.
 *   * `gap_ms` — KServe billed duration MINUS AI-audited duration, sign
 *     preserved, null unless both sides exist.
 *
 * No rounding rule, cutoff, or minute ceiling from the locked billing ruleset is
 * reproduced here: these are durations for review, not a calculation.
 */
const CATEGORY_SERVICE_END_SQL = `COALESCE(
      CAST(JSON_EXTRACT(
        media.metrics_json,
        '$.chargeableServiceEndMs'
      ) AS SIGNED),
      media.conversation_end_ms
    )`

const CATEGORY_GRACE_SQL = `COALESCE(
      CAST(JSON_EXTRACT(
        media.metrics_json,
        '$.appliedBillingGraceMs'
      ) AS SIGNED),
      60000
    )`

const AI_AUDITED_DURATION_SQL = `CASE
      WHEN ${CATEGORY_SERVICE_END_SQL} IS NULL THEN NULL
      WHEN media.decoded_duration_ms IS NOT NULL
       AND media.decoded_duration_ms <
         ${CATEGORY_SERVICE_END_SQL} + ${CATEGORY_GRACE_SQL}
        THEN media.decoded_duration_ms
      ELSE ${CATEGORY_SERVICE_END_SQL} + ${CATEGORY_GRACE_SQL}
    END`

const DURATION_COLUMNS_SQL = `
    ROUND(vendor.minutes_decimal * 60000) AS kserve_charge_time_ms,
    ${AI_AUDITED_DURATION_SQL} AS ai_audited_duration_ms`

const VENDOR_CHARGE_SQL = `COALESCE(
      CAST(vendor.amount_decimal AS DECIMAL(20,8)),
      vendor.minutes_decimal * ${KSERVE_VENDOR_RATE_PER_MINUTE}
    )`

const AUDITOR_PROJECTED_CHARGE_SQL = `CASE
      WHEN ${AI_AUDITED_DURATION_SQL} IS NULL THEN NULL
      WHEN ${AI_AUDITED_DURATION_SQL} = 0 THEN 0
      WHEN ${AI_AUDITED_DURATION_SQL} < ${KSERVE_SHORT_CALL_CUTOFF_MS}
        THEN ${KSERVE_VENDOR_RATE_PER_MINUTE} / 2
      ELSE CEIL(${AI_AUDITED_DURATION_SQL} / ${KSERVE_MINUTE_MS}.0)
        * ${KSERVE_VENDOR_RATE_PER_MINUTE}
    END`

const AUDITOR_CAPPED_CHARGE_SQL = `CASE
      WHEN ${AUDITOR_PROJECTED_CHARGE_SQL} IS NULL THEN NULL
      WHEN ${VENDOR_CHARGE_SQL} IS NULL THEN ${AUDITOR_PROJECTED_CHARGE_SQL}
      WHEN ${AUDITOR_PROJECTED_CHARGE_SQL}
        <= ${VENDOR_CHARGE_SQL}
        THEN ${AUDITOR_PROJECTED_CHARGE_SQL}
      ELSE ${VENDOR_CHARGE_SQL}
    END`

/**
 * Audited calls in scope, one row per call, with every fact a KPI or a table row
 * needs already joined. `select` is the caller's projection over the joined
 * relations; `filters`/`params` scope it.
 *
 * The single inner JOIN is what makes a call audited, and it carries both halves
 * of the invariant at once: there is no separate transcript join, because a
 * transcript only counts when it covers the same artifact the audited analysis
 * describes. Every other relation is a LEFT JOIN, so a missing cost, recording
 * flag or task reference reports as absent rather than dropping a call.
 */
export function scopedAuditedCallsSql(
  select: string,
  filters: readonly string[],
  options: {
    includeRecording?: boolean
    includeTaskReference?: boolean
    includeAuditFinding?: boolean
  } = {},
): string {
  const includeRecording = options.includeRecording ?? true
  const includeTaskReference = options.includeTaskReference ?? true
  const includeAuditFinding = options.includeAuditFinding ?? false
  return `WITH scoped_calls AS (
     SELECT
       c.id,
       c.logical_call_key,
       c.canonical_outcome_code,
       c.billing_period_date,
       c.source_started_at,
       c.source_ended_at,
       c.latest_audit_run_id
     FROM kaudit_call c
     WHERE ${filters.join('\n       AND ')}
   )
   SELECT
${select}
   FROM scoped_calls c
   JOIN (
     ${AUDITED_EVIDENCE_SQL}
   ) media ON media.call_id = c.id
   LEFT JOIN (
     ${SCOPED_VENDOR_BILLING_SQL}
   ) vendor ON vendor.call_id = c.id
   ${includeRecording ? `LEFT JOIN (
     ${RECORDING_AVAILABILITY_SQL}
   ) recording ON recording.call_id = c.id` : ''}
   ${includeTaskReference ? `LEFT JOIN (
     ${TASK_REFERENCE_SQL}
   ) task_reference ON task_reference.call_id = c.id` : ''}
   ${includeAuditFinding ? `LEFT JOIN (
     ${LATEST_AUDIT_FINDING_SQL}
   ) audit_finding ON audit_finding.call_id = c.id` : ''}`
}

function periodFilter(scope: BillingCategoryScope): {
  filters: string[]
  params: unknown[]
} {
  const filters = ['c.canonical_outcome_code IS NOT NULL']
  const params: unknown[] = []
  if (scope.periodStart && scope.periodEnd) {
    filters.push('c.billing_period_date BETWEEN ? AND ?')
    params.push(scope.periodStart, scope.periodEnd)
  }
  return { filters, params }
}

/**
 * The month filter narrowed to one category selection. The category is bound as
 * a parameter, never interpolated, and it is the same equality the per-category
 * totals group by — so the page and the KPI that sizes it describe one
 * population.
 */
function selectionFilter(scope: BillingCategoryPageScope): {
  filters: string[]
  params: unknown[]
} {
  const { filters, params } = periodFilter(scope)
  if (scope.category) {
    filters.push('c.canonical_outcome_code = ?')
    params.push(scope.category)
  }
  return { filters, params }
}

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * Per-category totals over the whole scoped month.
 *
 * The two money aggregates are kept apart on purpose: `kserve_charge_inr` is
 * what the vendor asserts from its own billed minutes, `auditor_final_charge_inr`
 * is the capped auditor projection. It is calculated per call before summing,
 * so a long audited duration can never make the auditor amount exceed KServe's
 * charge for that call. A duration SUM ignores nulls and yields null when
 * nothing carried the duration at all, so "not recorded" stays distinct from a
 * recorded zero.
 *
 * `scopedRowsSql` must yield one row per audited call with the columns
 * `category`, `kserve_charge_inr`, `auditor_final_amount`,
 * `kserve_charge_time_ms` and `ai_audited_duration_ms`.
 */
export function categoryTotalsSql(scopedRowsSql: string): string {
  return `SELECT
     scoped.category,
     COUNT(*) AS audited_call_count,
     SUM(scoped.category <> 'OK') AS issue_found_count,
     SUM(scoped.category = 'OK') AS no_issue_found_count,
     SUM(scoped.kserve_charge_time_ms IS NOT NULL) AS kserve_priced_calls,
     COALESCE(SUM(scoped.kserve_charge_inr), 0) AS kserve_charge_inr,
     SUM(scoped.auditor_final_amount IS NOT NULL)
       AS auditor_final_priced_calls,
     SUM(scoped.auditor_final_amount IS NULL)
       AS auditor_unfinalized_calls,
     COALESCE(SUM(scoped.auditor_final_amount), 0)
       AS auditor_final_charge_inr,
     SUM(scoped.kserve_charge_time_ms) AS kserve_charge_time_ms,
     SUM(scoped.ai_audited_duration_ms) AS ai_audited_duration_ms,
     SUM(scoped.ai_audited_duration_ms IS NOT NULL)
       AS ai_audited_duration_calls,
     SUM(
       scoped.kserve_charge_time_ms IS NOT NULL
       AND scoped.ai_audited_duration_ms IS NOT NULL
     ) AS comparable_calls,
     CASE
       WHEN SUM(scoped.kserve_charge_time_ms IS NOT NULL) = 0
        AND SUM(scoped.ai_audited_duration_ms IS NOT NULL) = 0
       THEN NULL
       ELSE COALESCE(SUM(scoped.kserve_charge_time_ms), 0)
          - COALESCE(SUM(scoped.ai_audited_duration_ms), 0)
     END AS gap_ms
   FROM (
     ${scopedRowsSql}
   ) scoped
   GROUP BY scoped.category
   ORDER BY scoped.category`
}

/**
 * KServe-charged calls whose final recording has no source URL. They are not
 * audited and never receive an invented auditor charge, but the vendor's
 * supplied amount/minutes remain part of the financial population.
 */
export function noRecordingTotalsSql(
  scope: BillingCategoryScope,
): { sql: string; params: unknown[] } {
  const scopedFilters = ['1 = 1']
  const params: unknown[] = []
  if (scope.periodStart && scope.periodEnd) {
    scopedFilters.push('c.billing_period_date BETWEEN ? AND ?')
    params.push(scope.periodStart, scope.periodEnd)
  }
  return {
    sql: `SELECT
      'NO_RECORDING' AS category,
      COUNT(*) AS audited_call_count,
      0 AS issue_found_count,
      0 AS no_issue_found_count,
      COUNT(*) AS kserve_priced_calls,
      COALESCE(SUM(${VENDOR_CHARGE_SQL}), 0) AS kserve_charge_inr,
      0 AS auditor_final_priced_calls,
      0 AS auditor_unfinalized_calls,
      0 AS auditor_final_charge_inr,
      COALESCE(SUM(ROUND(vendor.minutes_decimal * 60000)), 0)
        AS kserve_charge_time_ms,
      0 AS ai_audited_duration_ms,
      0 AS ai_audited_duration_calls,
      0 AS comparable_calls,
      COALESCE(SUM(ROUND(vendor.minutes_decimal * 60000)), 0) AS gap_ms
    FROM (
      ${vendorBilledAssertionsSql()}
    ) vendor
    STRAIGHT_JOIN kaudit_call c ON c.id = vendor.call_id
    LEFT JOIN kaudit_call_artifact recording
      ON recording.call_id = c.id
     AND recording.artifact_type = 'recording'
     AND recording.is_final = 1
     AND recording.source_url IS NOT NULL
    WHERE ${scopedFilters.join('\n      AND ')}
      AND vendor.minutes_decimal IS NOT NULL
      AND recording.id IS NULL`,
    params,
  }
}

/** The scoped projection the totals aggregate is defined over. */
export function categoryTotalsRowsSql(filters: readonly string[]): string {
  return scopedAuditedCallsSql(
    `    c.canonical_outcome_code AS category,
    ${VENDOR_CHARGE_SQL} AS kserve_charge_inr,
    ${AUDITOR_CAPPED_CHARGE_SQL} AS auditor_final_amount,
${DURATION_COLUMNS_SQL}`,
    filters,
    { includeRecording: false, includeTaskReference: false },
  )
}

/**
 * One page of audited calls.
 *
 * Ordering is TOTAL: newest stored call start first, then the task reference,
 * then the call's internal id. The first two keys are what a reader sees, but
 * neither is unique — several calls can start in the same stored second, and two
 * calls can carry the same task reference or fall back to display keys that
 * collide. Without a unique final key the engine is free to return tied rows in
 * a different order for each OFFSET, which makes adjacent pages overlap and skip
 * rows. `c.id` breaks that tie inside the ORDER BY only: it is not selected, so
 * it reaches neither the row shape, the API, nor a browser.
 */
export function categoryCallsSql(filters: readonly string[]): string {
  return `${scopedAuditedCallsSql(
    `    COALESCE(task_reference.external_id, c.logical_call_key)
      AS call_reference,
    c.source_started_at AS call_started_at,
    c.source_ended_at AS call_ended_at,
    c.billing_period_date,
    c.canonical_outcome_code AS category,
    COALESCE(recording.recording_available, 0) AS recording_available,
    ${VENDOR_CHARGE_SQL} AS kserve_charge_inr,
    ${AUDITOR_CAPPED_CHARGE_SQL} AS auditor_final_charge_inr,
    CAST(audit_finding.confidence AS CHAR) AS ai_confidence,
    audit_finding.explanation AS ai_audit_remark,
${DURATION_COLUMNS_SQL}`,
    filters,
    { includeAuditFinding: true },
  )}
   ORDER BY call_started_at DESC, call_reference ASC, c.id ASC
   LIMIT ? OFFSET ?`
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

interface TotalsDataRow extends RowDataPacket {
  category: string
  audited_call_count: number | string
  issue_found_count: number | string | null
  no_issue_found_count: number | string | null
  kserve_priced_calls: number | string | null
  kserve_charge_inr: number | string | null
  auditor_final_priced_calls: number | string | null
  auditor_unfinalized_calls: number | string | null
  auditor_final_charge_inr: number | string | null
  kserve_charge_time_ms: number | string | null
  ai_audited_duration_ms: number | string | null
  ai_audited_duration_calls: number | string | null
  comparable_calls: number | string | null
  gap_ms: number | string | null
}

interface CallDataRow extends RowDataPacket {
  call_reference: string
  call_started_at: Date | string | null
  call_ended_at: Date | string | null
  billing_period_date: Date | string | null
  category: string
  recording_available: number | string | null
  kserve_charge_inr: number | string | null
  auditor_final_charge_inr: number | string | null
  ai_confidence: number | string | null
  ai_audit_remark: string | null
  kserve_charge_time_ms: number | string | null
  ai_audited_duration_ms: number | string | null
}

function wholeNumber(value: unknown): number {
  return Number(value ?? 0)
}

function nullableWholeNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

function boundedAuditRemark(value: unknown): string | null {
  if (value == null) return null
  const remark = String(value).trim()
  return remark ? remark.slice(0, 1200) : null
}

/** The database's own decimal text, kept as text. Never parsed to a float. */
function decimalText(value: unknown): string {
  return value == null ? '0' : String(value)
}

function nullableDecimalText(value: unknown): string | null {
  return value == null ? null : String(value)
}

const NAIVE_TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2})/

function pad(value: number): string {
  return String(value).padStart(2, '0')
}

/**
 * The stored call timestamp, exactly as stored: `YYYY-MM-DD HH:MM:SS`.
 *
 * The column is a naive DATETIME, so it carries a wall-clock reading and no
 * offset. The driver rebuilds that reading in local components; reading it back
 * the same way keeps it intact. Converting to an instant instead would attach a
 * timezone the column never had and could move a call across midnight — onto a
 * different call date — purely by where the server runs.
 */
function storedTimestamp(value: Date | string | null): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1)}-` +
      `${pad(value.getDate())} ${pad(value.getHours())}:` +
      `${pad(value.getMinutes())}:${pad(value.getSeconds())}`
    )
  }
  const match = NAIVE_TIMESTAMP.exec(String(value).trim())
  return match ? `${match[1]} ${match[2]}` : null
}

/** Calendar date of the stored call start, or of the bill period when absent. */
function storedDate(
  startedAt: Date | string | null,
  billingPeriodDate: Date | string | null,
): string | null {
  for (const candidate of [startedAt, billingPeriodDate]) {
    if (candidate == null) continue
    if (candidate instanceof Date) {
      if (Number.isNaN(candidate.getTime())) continue
      return (
        `${candidate.getFullYear()}-${pad(candidate.getMonth() + 1)}-` +
        `${pad(candidate.getDate())}`
      )
    }
    const text = String(candidate).trim()
    const match = /^(\d{4}-\d{2}-\d{2})/.exec(text)
    if (match) return match[1]
  }
  return null
}

/**
 * KServe billed duration minus AI-audited duration.
 *
 * Derived once per row from columns already read, and null unless both sides
 * exist: a missing duration is unknown, never a zero gap. The sign is kept —
 * a negative gap means the audit measured MORE time than the vendor billed, and
 * flattening that to a magnitude would hide the direction of the difference.
 */
export function durationGapMs(
  kserveChargeTimeMs: number | null,
  aiAuditedDurationMs: number | null,
): number | null {
  if (kserveChargeTimeMs == null) return null
  if (aiAuditedDurationMs == null) return null
  return kserveChargeTimeMs - aiAuditedDurationMs
}

export function toCategoryTotalsRow(
  row: TotalsDataRow,
): BillingCategoryTotalsRow {
  return {
    category: row.category,
    auditedCallCount: wholeNumber(row.audited_call_count),
    issueFoundCount: wholeNumber(row.issue_found_count),
    noIssueFoundCount: wholeNumber(row.no_issue_found_count),
    kservePricedCalls: wholeNumber(row.kserve_priced_calls),
    kserveChargeInr: decimalText(row.kserve_charge_inr),
    auditorFinalPricedCalls: wholeNumber(row.auditor_final_priced_calls),
    auditorUnfinalizedCalls: wholeNumber(row.auditor_unfinalized_calls),
    auditorFinalChargeInr: decimalText(row.auditor_final_charge_inr),
    kserveChargeTimeMs: nullableWholeNumber(row.kserve_charge_time_ms),
    aiAuditedDurationMs: nullableWholeNumber(row.ai_audited_duration_ms),
    aiAuditedDurationCalls: wholeNumber(row.ai_audited_duration_calls),
    comparableCalls: wholeNumber(row.comparable_calls),
    gapMs: nullableWholeNumber(row.gap_ms),
  }
}

/**
 * Copies the database row field by field. Never a spread: a column added to a
 * statement later must be reviewed here before it can reach a browser.
 */
export function toCategoryCallRow(
  row: CallDataRow,
): BillingCategoryCallRow {
  const kserveChargeTimeMs = nullableWholeNumber(
    row.kserve_charge_time_ms,
  )
  const aiAuditedDurationMs = nullableWholeNumber(
    row.ai_audited_duration_ms,
  )
  const noIssueFound = row.category === 'OK'
  return {
    callReference: row.call_reference,
    callDate: storedDate(row.call_started_at, row.billing_period_date),
    callStartAt: storedTimestamp(row.call_started_at),
    callEndAt: storedTimestamp(row.call_ended_at),
    category: row.category,
    kserveChargeTimeMs,
    kserveChargeInr: decimalText(row.kserve_charge_inr),
    aiAuditedDurationMs,
    auditorFinalChargeInr: nullableDecimalText(
      row.auditor_final_charge_inr,
    ),
    aiConfidence:
      row.ai_confidence == null ? null : String(row.ai_confidence),
    aiAuditResult: noIssueFound ? 'No issue found' : 'Issue found',
    aiAuditRemark: boundedAuditRemark(row.ai_audit_remark),
    gapMs: durationGapMs(kserveChargeTimeMs, aiAuditedDurationMs),
    recordingAvailable: Number(row.recording_available ?? 0) === 1,
  }
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export function createMysqlBillingCategoryAnalysisRepository(
  pool: Pool,
): BillingCategoryAnalysisPort {
  return {
    async listCategoryTotals(scope) {
      const { filters, params } = periodFilter(scope)
      const [rows] = await pool.query<TotalsDataRow[]>(
        categoryTotalsSql(categoryTotalsRowsSql(filters)),
        params,
      )
      return rows.map(toCategoryTotalsRow)
    },
    async listNoRecordingTotals(scope) {
      const statement = noRecordingTotalsSql(scope)
      const [rows] = await pool.query<TotalsDataRow[]>(
        statement.sql,
        statement.params,
      )
      return toCategoryTotalsRow(rows[0]!)
    },
    async listCalls(scope) {
      const { filters, params } = selectionFilter(scope)
      const [rows] = await pool.query<CallDataRow[]>(
        categoryCallsSql(filters),
        [...params, scope.limit, scope.offset],
      )
      return rows.map(toCategoryCallRow)
    },
  }
}
