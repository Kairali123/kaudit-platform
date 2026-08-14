import type { Pool, RowDataPacket } from 'mysql2/promise'
import { CURRENT_FINAL_BILLING_CALCULATION_SQL } from './mysqlAuditMonitor.ts'

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
 *   * Money is never synthesized. The vendor figure comes from final
 *     vendor-asserted billed minutes — the provider's own billing evidence — and
 *     the auditor figure is summed ONLY from current (non-superseded) final
 *     `kaudit_billing_calculation` rows. A call with no such row contributes no
 *     auditor money and is counted as unfinalized instead, so an absent
 *     calculation can never be read as a verified zero.
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
  auditedCallCount: number
  /** Calls carrying final vendor billed-minute evidence. */
  kservePricedCalls: number
  kserveChargeInr: string
  /** Calls priced by a current final deterministic calculation. */
  auditorFinalPricedCalls: number
  /** Audited calls with no current final calculation: no auditor money. */
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
  /** Grace-adjusted audited duration: audit metadata, not a charge. */
  aiAuditedDurationMs: number | null
  /** KServe billed duration minus AI-audited duration. Sign preserved. */
  gapMs: number | null
  /** Presence signal only. The recording reference itself never leaves here. */
  recordingAvailable: boolean
}

export interface BillingCategoryAnalysisPort {
  /**
   * Every available category for the month with its month-wide totals. The
   * table's own scope totals are read from this same result, so a footer total
   * can never drift from the KPI it sits under.
   */
  listCategoryTotals(
    scope: BillingCategoryScope,
  ): Promise<BillingCategoryTotalsRow[]>
  listCalls(
    scope: BillingCategoryPageScope,
  ): Promise<BillingCategoryCallRow[]>
}

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
    ranked.conversation_end_ms
  FROM (
    SELECT
      artifact.call_id,
      analysis.decoded_duration_ms,
      analysis.conversation_end_ms,
      ROW_NUMBER() OVER (
        PARTITION BY artifact.call_id
        ORDER BY analysis.created_at DESC, analysis.id DESC
      ) AS current_rank
    FROM kaudit_call_artifact artifact
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

/**
 * Vendor-asserted billed minutes, one row per call. This is the provider's own
 * billing evidence and the only basis for the KServe figures below.
 */
const VENDOR_BILLED_MINUTES_SQL = `
  SELECT
    cost.call_id,
    MAX(cost.minutes_decimal) AS minutes_decimal
  FROM kaudit_provider_cost cost
  WHERE cost.provider_sku = 'vendor_asserted_billed_minutes'
    AND cost.is_final = 1
  GROUP BY cost.call_id
`

/** Whether a final recording artifact carries a source at all. Never the URL. */
const RECORDING_AVAILABILITY_SQL = `
  SELECT
    artifact.call_id,
    MAX(artifact.source_url IS NOT NULL) AS recording_available
  FROM kaudit_call_artifact artifact
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
    WHERE reference.reference_type IN ('task_id','taskId','task')
  ) ranked
  WHERE ranked.reference_rank = 1
`

/**
 * The KServe contract rate per billed minute, stated as the SQL literal the
 * other KServe-evidence surfaces use. It prices vendor-asserted minutes only;
 * the auditor's own money is never derived from a rate here.
 */
const VENDOR_RATE_PER_MINUTE = '9.5'

/**
 * Duration semantics, defined once and used by both the aggregate and the rows.
 *
 *   * `kserve_charge_time_ms` — final vendor BILLED minutes, in milliseconds.
 *     This is the time KServe charges for.
 *   * `ai_audited_duration_ms` — the grace-adjusted audited duration: the
 *     recorded duration capped at one wrap-up grace minute after the last
 *     customer exchange. Non-monetary audit metadata, null when the audit
 *     recorded no conversation end.
 *   * `gap_ms` — KServe billed duration MINUS AI-audited duration, sign
 *     preserved, null unless both sides exist.
 *
 * No rounding rule, cutoff, or minute ceiling from the locked billing ruleset is
 * reproduced here: these are durations for review, not a calculation.
 */
const DURATION_COLUMNS_SQL = `
    ROUND(vendor.minutes_decimal * 60000) AS kserve_charge_time_ms,
    CASE
      WHEN media.conversation_end_ms IS NULL THEN NULL
      WHEN media.decoded_duration_ms IS NOT NULL
       AND media.decoded_duration_ms < media.conversation_end_ms + 60000
        THEN media.decoded_duration_ms
      ELSE media.conversation_end_ms + 60000
    END AS ai_audited_duration_ms`

/**
 * Audited calls in scope, one row per call, with every fact a KPI or a table row
 * needs already joined. `select` is the caller's projection over the joined
 * relations; `filters`/`params` scope it.
 *
 * The single inner JOIN is what makes a call audited, and it carries both halves
 * of the invariant at once: there is no separate transcript join, because a
 * transcript only counts when it covers the same artifact the audited analysis
 * describes. Every other relation is a LEFT JOIN, so a missing cost, calculation,
 * recording flag or task reference reports as absent rather than dropping a call.
 */
export function scopedAuditedCallsSql(
  select: string,
  filters: readonly string[],
): string {
  return `SELECT
${select}
   FROM kaudit_call c
   JOIN (
     ${AUDITED_EVIDENCE_SQL}
   ) media ON media.call_id = c.id
   LEFT JOIN (
     ${VENDOR_BILLED_MINUTES_SQL}
   ) vendor ON vendor.call_id = c.id
   LEFT JOIN (
     ${CURRENT_FINAL_BILLING_CALCULATION_SQL}
   ) final_calculation ON final_calculation.call_id = c.id
   LEFT JOIN (
     ${RECORDING_AVAILABILITY_SQL}
   ) recording ON recording.call_id = c.id
   LEFT JOIN (
     ${TASK_REFERENCE_SQL}
   ) task_reference ON task_reference.call_id = c.id
   WHERE ${filters.join('\n     AND ')}`
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

// ---------------------------------------------------------------------------
// Statements
// ---------------------------------------------------------------------------

/**
 * Per-category totals over the whole scoped month.
 *
 * The two money aggregates are kept apart on purpose: `kserve_charge_inr` is
 * what the vendor asserts from its own billed minutes, `auditor_final_charge_inr`
 * is deterministic billing-engine money. They are never added together, and no
 * duration column feeds either one. A duration SUM ignores nulls and yields null
 * when nothing carried the duration at all, so "not recorded" stays distinct
 * from a recorded zero.
 *
 * `scopedRowsSql` must yield one row per audited call with the columns
 * `category`, `kserve_charge_inr`, `auditor_final_amount`,
 * `kserve_charge_time_ms` and `ai_audited_duration_ms`.
 */
export function categoryTotalsSql(scopedRowsSql: string): string {
  return `SELECT
     scoped.category,
     COUNT(*) AS audited_call_count,
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
     SUM(
       CASE
         WHEN scoped.kserve_charge_time_ms IS NOT NULL
          AND scoped.ai_audited_duration_ms IS NOT NULL
         THEN scoped.kserve_charge_time_ms - scoped.ai_audited_duration_ms
       END
     ) AS gap_ms
   FROM (
     ${scopedRowsSql}
   ) scoped
   GROUP BY scoped.category
   ORDER BY scoped.category`
}

/** The scoped projection the totals aggregate is defined over. */
export function categoryTotalsRowsSql(filters: readonly string[]): string {
  return scopedAuditedCallsSql(
    `    c.canonical_outcome_code AS category,
    vendor.minutes_decimal * ${VENDOR_RATE_PER_MINUTE} AS kserve_charge_inr,
    final_calculation.total_amount AS auditor_final_amount,
${DURATION_COLUMNS_SQL}`,
    filters,
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
${DURATION_COLUMNS_SQL}`,
    filters,
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
  kserve_charge_time_ms: number | string | null
  ai_audited_duration_ms: number | string | null
}

function wholeNumber(value: unknown): number {
  return Number(value ?? 0)
}

function nullableWholeNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

/** The database's own decimal text, kept as text. Never parsed to a float. */
function decimalText(value: unknown): string {
  return value == null ? '0' : String(value)
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
  return {
    callReference: row.call_reference,
    callDate: storedDate(row.call_started_at, row.billing_period_date),
    callStartAt: storedTimestamp(row.call_started_at),
    callEndAt: storedTimestamp(row.call_ended_at),
    category: row.category,
    kserveChargeTimeMs,
    aiAuditedDurationMs,
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
    async listCalls(scope) {
      const { filters, params } = periodFilter(scope)
      if (scope.category) {
        filters.push('c.canonical_outcome_code = ?')
        params.push(scope.category)
      }
      const [rows] = await pool.query<CallDataRow[]>(
        categoryCallsSql(filters),
        [...params, scope.limit, scope.offset],
      )
      return rows.map(toCategoryCallRow)
    },
  }
}
