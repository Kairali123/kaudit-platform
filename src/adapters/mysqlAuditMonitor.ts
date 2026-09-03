import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  KSERVE_MINUTE_MS,
  KSERVE_SHORT_CALL_CUTOFF_MS,
} from '../billing/kserveRules.ts'
import { calculateOpenAiAuditCost } from '../usage/openAiCost.ts'
import type { ManualReauditRowStatus } from '../reaudit/manualRequests.ts'
import { readManualReauditRowStatuses } from './mysqlManualReauditQueue.ts'
import { KSERVE_VENDOR_RATE_PER_MINUTE } from './mysqlKserveVendorBilled.ts'

export interface AuditMonitorQuery {
  page: number
  pendingPage: number
  noRecordingPage: number
  pageSize: number
  category: string | null
  taskId: string | null
  periodStart?: string | null
  periodEnd?: string | null
}

export interface AuditMonitorRow {
  callReference: string
  billingPeriodDate: string | null
  category: string
  outcomeTaxonomyVersion: string | null
  confidence: string | null
  confirmationStatus: string
  language: string
  asrProvider: string | null
  asrModel: string | null
  asrModelVersion: string | null
  auditEngineVersion: string | null
  recordedDurationMs: number | null
  speechDurationMs: number | null
  conversationEndMs: number | null
  graceAdjustedDurationMs: number | null
  vendorConnectedDurationMs: number | null
  varianceDurationMs: number | null
  evidenceHashRecorded: boolean
  lastEvidenceVerifiedAt: string | null
  auditedAt: string | null
  /**
   * Latest visible administrator-requested re-audit lifecycle for this row.
   *
   * The ONLY re-audit state this DTO carries: no request id, no queue item, no
   * baseline run, no attempt count, no error code, and no internal call id. The
   * page needs to know that a row is spoken for, and nothing else.
   */
  reAuditStatus: ManualReauditRowStatus | null
  reAuditCompletedAt: string | null
  reAuditFailureCode: string | null
  aiUsage: {
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    audioSeconds: string | null
  }
}

/**
 * The queue DTO deliberately carries NO recording URL.
 *
 * A stored `source_url` is signed/provider evidence: it is what the server
 * fetches to audit a call and it must not be handed to a browser. The column
 * was exposed temporarily for one diagnosis; server-side recording processing
 * reads `kaudit_call_artifact.source_url` directly and is unchanged.
 */
export interface AuditQueueRow {
  callReference: string
  billingPeriodDate: string | null
  processingStatus: string
  attemptCount: number
  evidenceHashRecorded: boolean
  lastEvidenceVerifiedAt: string | null
  vendorBilledMinutes: string | null
  vendorConnectedDurationMs: number | null
  auditorAmount: string | null
  billingStatus: string | null
  billingBasis: string | null
  auditRemark: string | null
  lastActivityAt: string | null
}

export interface AuditPagination {
  page: number
  pageSize: number
  totalRows: number
  totalPages: number
}

export interface AuditMonitorData {
  generatedAt: string
  summary: {
    totalCalls: number
    aiAuditedCalls: number
    auditCoveragePercent: string
    recordingAvailableCalls: number
    pendingEligibleCalls: number
    noRecordingCalls: number
    processingFailureCalls: number
    reauditV2Calls: number
    aiUsage: {
      trackedAuditRuns: number
      gptInputTokens: number
      gptOutputTokens: number
      gptTotalTokens: number
      whisperAudioSeconds: string
      historicalUsageRecorded: boolean
    }
    auditedFinancials: {
      scopedAuditedCalls: number
      aiSpendTrackedCalls: number
      aiSpendUntrackedCalls: number
      estimatedAiSpendUsd: string
      aiSpendPricingVersion: string
      aiSpendPricingBasis: string
      unpricedAiUsageRows: number
      kservePricedCalls: number
      kserveChargeInr: string
      /** Audited calls with a capped auditor amount projection. */
      auditorFinalPricedCalls: number
      /** Audited calls with no audited duration, so no auditor amount. */
      auditorUnfinalizedCalls: number
      /**
       * Capped auditor amount: audited duration priced with locked KServe
       * rounding, capped per call at KServe's own charge.
       */
      auditorFinalChargeInr: string
    }
  }
  rows: AuditMonitorRow[]
  pendingRows: AuditQueueRow[]
  noRecordingRows: AuditQueueRow[]
  pagination: AuditPagination
  pendingPagination: AuditPagination
  noRecordingPagination: AuditPagination
  filters: {
    category: string | null
    taskId: string | null
    availableCategories: string[]
  }
  authority: 'automated'
  contentBoundary: string
}

export type AuditMonitorSummaryData = Pick<
  AuditMonitorData,
  'generatedAt' | 'summary' | 'filters' | 'authority'
>

type AuditMonitorSummary = AuditMonitorData['summary']

export interface AuditMonitorCoreSummaryData {
  generatedAt: string
  summary: Omit<AuditMonitorSummary, 'aiUsage' | 'auditedFinancials'>
  filters: AuditMonitorData['filters']
  authority: 'automated'
}

export interface AuditMonitorUsageSummaryData {
  generatedAt: string
  aiUsage: AuditMonitorSummary['aiUsage']
  aiSpend: Pick<
    AuditMonitorSummary['auditedFinancials'],
    | 'aiSpendTrackedCalls'
    | 'estimatedAiSpendUsd'
    | 'aiSpendPricingVersion'
    | 'aiSpendPricingBasis'
    | 'unpricedAiUsageRows'
  >
  authority: 'automated'
}

export interface AuditMonitorFinancialSummaryData {
  generatedAt: string
  auditedFinancials: Pick<
    AuditMonitorSummary['auditedFinancials'],
    | 'scopedAuditedCalls'
    | 'kservePricedCalls'
    | 'kserveChargeInr'
    | 'auditorFinalPricedCalls'
    | 'auditorUnfinalizedCalls'
    | 'auditorFinalChargeInr'
  >
  authority: 'automated'
}

export type AuditMonitorRowsData = Pick<
  AuditMonitorData,
  | 'generatedAt'
  | 'rows'
  | 'pendingRows'
  | 'noRecordingRows'
  | 'pagination'
  | 'pendingPagination'
  | 'noRecordingPagination'
  | 'contentBoundary'
  | 'authority'
> & { totalsFinal: boolean }

export type AuditMonitorSection =
  | 'all'
  | 'summary'
  | 'summary-core'
  | 'summary-usage'
  | 'summary-financial'
  | 'rows'
export type AuditMonitorRowTable =
  | 'all'
  | 'audited'
  | 'pending'
  | 'no-recording'

interface CountRow extends RowDataPacket {
  n: number | string
}

interface OverallSummaryRow extends RowDataPacket {
  total_calls: number | string
  audited_calls: number | string
  recording_available: number | string
  pending_calls: number | string
  no_recording_calls: number | string
  processing_failures: number | string
}

interface UsageSummaryRow extends RowDataPacket {
  tracked_audit_runs: number | string
  input_tokens: number | string | null
  output_tokens: number | string | null
  total_tokens: number | string | null
  audio_seconds: number | string | null
}

interface UsageCostRow extends RowDataPacket {
  model_name: string | null
  input_tokens: number | string | null
  output_tokens: number | string | null
  audio_seconds: number | string | null
}

type UsageModelCostRow = UsageCostRow & { model_name: string }

interface AuditedFinancialSummaryRow extends RowDataPacket {
  audited_calls: number | string
  kserve_priced_calls: number | string
  kserve_charge: number | string | null
  auditor_final_priced_calls: number | string
  auditor_unfinalized_calls: number | string
  auditor_final_charge: number | string | null
}

interface DataRow extends RowDataPacket {
  /**
   * Read so the re-audit queue can be joined by internal key. It is used to
   * look up `reAuditStatus` and is NEVER copied into the DTO below.
   */
  internal_call_id: string | null
  call_reference: string
  billing_period_date: Date | string | null
  category: string
  outcome_taxonomy_version: string | null
  confidence: string | null
  confirmation_status: string | null
  language: string | null
  provider_name: string | null
  model_name: string | null
  model_version: string | null
  engine_version: string | null
  decoded_duration_ms: number | string | null
  speech_ms: number | string | null
  conversation_end_ms: number | string | null
  grace_adjusted_duration_ms: number | string | null
  vendor_connected_duration_ms: number | string | null
  evidence_sha256: string | null
  last_verified_at: Date | string | null
  audited_at: Date | string | null
  ai_input_tokens: number | string | null
  ai_output_tokens: number | string | null
  ai_total_tokens: number | string | null
  ai_audio_seconds: number | string | null
}

interface QueueDataRow extends RowDataPacket {
  call_reference: string
  billing_period_date: Date | string | null
  processing_status: string | null
  attempt_count: number | string | null
  evidence_sha256: string | null
  last_verified_at: Date | string | null
  vendor_billed_minutes: string | null
  vendor_connected_duration_ms: number | string | null
  auditor_amount: string | null
  billing_status: string | null
  billing_basis: string | null
  audit_remark: string | null
  last_activity_at: Date | string | null
}

function count(row: CountRow | undefined): number {
  return Number(row?.n || 0)
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
}

/**
 * Non-monetary audit metadata: how far the vendor's connected duration sits
 * from the grace-adjusted audited duration. It is a duration difference for
 * review, never a charge, and stays null when either side is missing.
 *
 * Derived here rather than in SQL so the connected duration is read once per
 * displayed row.
 */
export function durationVarianceMs(
  vendorConnectedDurationMs: number | null,
  graceAdjustedDurationMs: number | null,
): number | null {
  if (vendorConnectedDurationMs == null) return null
  if (graceAdjustedDurationMs == null) return null
  return vendorConnectedDurationMs - graceAdjustedDurationMs
}

function moneyDecimal(value: unknown): string {
  const raw = value == null ? '0' : String(value)
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(raw)
  if (!match) throw new TypeError('Database money value is invalid')
  return `${match[1]}${match[2]}.${(match[3] || '')
    .padEnd(8, '0')
    .slice(0, 8)}`
}

function isoDate(value: Date | string | null): string | null {
  if (value == null) return null
  const date = value instanceof Date ? value : new Date(value)
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString()
}

const AUDITED_JOIN = `
  FROM kaudit_call c
  JOIN kaudit_call_artifact ca
    ON ca.call_id = c.id
   AND ca.artifact_type = 'recording'
   AND ca.is_final = 1
  JOIN kaudit_media_analysis ma
    ON ma.call_artifact_id = ca.id
   AND ma.status = 'completed'
   AND ma.classification_status = 'completed'
   AND ma.id = (
     SELECT ma_latest.id
     FROM kaudit_media_analysis ma_latest
     WHERE ma_latest.call_artifact_id = ca.id
       AND ma_latest.status = 'completed'
       AND ma_latest.classification_status = 'completed'
     ORDER BY ma_latest.created_at DESC, ma_latest.id DESC
     LIMIT 1
   )
  JOIN kaudit_transcript t
    ON t.call_id = c.id
   AND t.call_artifact_id = ca.id
   AND t.status = 'completed'
   AND t.id = (
     SELECT t_latest.id
     FROM kaudit_transcript t_latest
     WHERE t_latest.call_id = c.id
       AND t_latest.call_artifact_id = ca.id
       AND t_latest.status = 'completed'
     ORDER BY t_latest.created_at DESC, t_latest.id DESC
     LIMIT 1
   )
  LEFT JOIN kaudit_audit_run ar ON ar.id = c.latest_audit_run_id
`

/** Vendor-asserted billed minutes, one row per call. */
const VENDOR_BILLED_MINUTES_SQL = `
  SELECT
    cost.call_id,
    MAX(CASE
      WHEN cost.provider_sku = 'vendor_asserted_billed_minutes'
      THEN cost.minutes_decimal
    END) AS minutes_decimal,
    MAX(CASE
      WHEN cost.provider_sku = 'vendor_asserted_billed_amount'
      THEN cost.quantity_decimal
    END) AS amount_decimal
  FROM kaudit_provider_cost cost
  WHERE cost.provider_sku IN (
      'vendor_asserted_billed_minutes',
      'vendor_asserted_billed_amount'
    )
    AND cost.is_final = 1
  GROUP BY cost.call_id
`

/**
 * Audited-call financial summary.
 *
 * Two independent aggregates over the same scoped calls, never blended:
 *
 *   * `kserve_charge` — what the vendor asserts, from its own billed-minutes
 *     evidence; and
 *   * `auditor_final_charge` — capped auditor projection: audited duration
 *     priced with the locked KServe rounding rule, capped per call at KServe's
 *     own charge.
 *
 * The cap is applied before summing, so a call where the audited duration is
 * longer than KServe's billed duration contributes KServe's charge, never a
 * higher amount. A call with no audited duration is counted in
 * `auditor_unfinalized_calls` instead.
 *
 * `scopedAuditedCallsSql` must yield one `id` column and one
 * `grace_adjusted_duration_ms` column per audited call.
 */
export function auditedFinancialSummarySql(
  scopedAuditedCallsSql: string,
): string {
  const vendorCharge = `COALESCE(
       CAST(vendor.amount_decimal AS DECIMAL(20,8)),
       vendor.minutes_decimal * ${KSERVE_VENDOR_RATE_PER_MINUTE}
     )`
  const projectedCharge = `CASE
       WHEN scoped.grace_adjusted_duration_ms IS NULL THEN NULL
       WHEN scoped.grace_adjusted_duration_ms = 0 THEN 0
       WHEN scoped.grace_adjusted_duration_ms < ${KSERVE_SHORT_CALL_CUTOFF_MS}
         THEN ${KSERVE_VENDOR_RATE_PER_MINUTE} / 2
       ELSE CEIL(scoped.grace_adjusted_duration_ms / ${KSERVE_MINUTE_MS}.0)
         * ${KSERVE_VENDOR_RATE_PER_MINUTE}
     END`
  const cappedCharge = `CASE
       WHEN ${projectedCharge} IS NULL THEN NULL
       WHEN ${vendorCharge} IS NULL THEN ${projectedCharge}
       WHEN ${projectedCharge}
         <= ${vendorCharge}
         THEN ${projectedCharge}
       ELSE ${vendorCharge}
     END`
  return `SELECT
     COUNT(*) AS audited_calls,
     SUM((${vendorCharge}) IS NOT NULL) AS kserve_priced_calls,
     COALESCE(SUM(${vendorCharge}), 0) AS kserve_charge,
     SUM((${cappedCharge}) IS NOT NULL)
       AS auditor_final_priced_calls,
     SUM((${cappedCharge}) IS NULL)
       AS auditor_unfinalized_calls,
     COALESCE(SUM(${cappedCharge}), 0)
       AS auditor_final_charge
   FROM (
     ${scopedAuditedCallsSql}
   ) scoped
   LEFT JOIN (
     ${VENDOR_BILLED_MINUTES_SQL}
   ) vendor ON vendor.call_id = scoped.id`
}

function categoryAdjustedDurationSql(alias: string): string {
  const serviceEnd = `COALESCE(
    CAST(JSON_EXTRACT(
      ${alias}.metrics_json,
      '$.chargeableServiceEndMs'
    ) AS SIGNED),
    ${alias}.conversation_end_ms
  )`
  const grace = `COALESCE(
    CAST(JSON_EXTRACT(
      ${alias}.metrics_json,
      '$.appliedBillingGraceMs'
    ) AS SIGNED),
    60000
  )`
  return `CASE
    WHEN ${serviceEnd} IS NULL THEN NULL
    ELSE LEAST(
      COALESCE(${alias}.decoded_duration_ms, ${serviceEnd} + ${grace}),
      ${serviceEnd} + ${grace}
    )
  END`
}

const TASK_REFERENCE_SQL = `
  COALESCE(
    (
      SELECT external_id
      FROM kaudit_call_external_reference ref
      WHERE ref.call_id = c.id
        AND ref.reference_type IN ('task_id','taskId','task')
      ORDER BY ref.id
      LIMIT 1
    ),
    c.logical_call_key
  )
`

function pagination(
  page: number,
  pageSize: number,
  totalRows: number,
): AuditPagination {
  return {
    page,
    pageSize,
    totalRows,
    totalPages: Math.max(1, Math.ceil(totalRows / pageSize)),
  }
}

function windowPagination(
  page: number,
  pageSize: number,
  fetchedRows: number,
): AuditPagination {
  const visibleRows = Math.min(pageSize, fetchedRows)
  const hasNextPage = fetchedRows > pageSize
  const minimumRows = (page - 1) * pageSize + visibleRows
  return {
    page,
    pageSize,
    totalRows: minimumRows + (hasNextPage ? 1 : 0),
    totalPages: page + (hasNextPage ? 1 : 0),
  }
}

function mapQueueRow(row: QueueDataRow): AuditQueueRow {
  return {
    callReference: row.call_reference,
    billingPeriodDate: isoDate(row.billing_period_date),
    processingStatus: row.processing_status || 'not_started',
    attemptCount: Number(row.attempt_count || 0),
    evidenceHashRecorded: Boolean(row.evidence_sha256),
    lastEvidenceVerifiedAt: isoDate(row.last_verified_at),
    vendorBilledMinutes: row.vendor_billed_minutes,
    vendorConnectedDurationMs: nullableNumber(
      row.vendor_connected_duration_ms,
    ),
    auditorAmount: row.auditor_amount,
    billingStatus: row.billing_status,
    billingBasis: row.billing_basis,
    auditRemark: row.audit_remark,
    lastActivityAt: isoDate(row.last_activity_at),
  }
}

function filterSql(query: AuditMonitorQuery): {
  sql: string
  params: unknown[]
} {
  const clauses = ['c.canonical_outcome_code IS NOT NULL']
  const params: unknown[] = []
  if (query.periodStart && query.periodEnd) {
    clauses.push('c.billing_period_date BETWEEN ? AND ?')
    params.push(query.periodStart, query.periodEnd)
  }
  if (query.category) {
    clauses.push('c.canonical_outcome_code = ?')
    params.push(query.category)
  }
  if (query.taskId) {
    clauses.push(taskIdPredicate('c'))
    params.push(query.taskId, query.taskId)
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params }
}

function financialAuditedScope(query: AuditMonitorQuery): {
  sql: string
  params: unknown[]
} {
  const params: unknown[] = []
  const clauses = [
    `EXISTS (
      SELECT 1
      FROM kaudit_transcript completed_transcript
      WHERE completed_transcript.call_id = c.id
        AND completed_transcript.call_artifact_id = ca.id
        AND completed_transcript.status = 'completed'
    )`,
    'c.canonical_outcome_code IS NOT NULL',
  ]
  if (query.periodStart && query.periodEnd) {
    clauses.push('c.billing_period_date BETWEEN ? AND ?')
    params.push(query.periodStart, query.periodEnd)
  }
  if (query.category) {
    clauses.push('c.canonical_outcome_code = ?')
    params.push(query.category)
  }
  if (query.taskId) {
    clauses.push(taskIdPredicate('c'))
    params.push(query.taskId, query.taskId)
  }

  const hasPeriod = Boolean(query.periodStart && query.periodEnd)
  const callIndex = hasPeriod
    ? ' FORCE INDEX (idx_call_period_category_started)'
    : ''
  const join = hasPeriod ? 'STRAIGHT_JOIN' : 'JOIN'
  return {
    sql: `SELECT DISTINCT
       c.id,
       ${categoryAdjustedDurationSql('ma')}
         AS grace_adjusted_duration_ms
     FROM kaudit_call c${callIndex}
     ${join} kaudit_call_artifact ca
       ON ca.call_id = c.id
      AND ca.artifact_type = 'recording'
      AND ca.is_final = 1
     ${join} kaudit_media_analysis ma
       ON ma.call_artifact_id = ca.id
      AND ma.status = 'completed'
      AND ma.classification_status = 'completed'
      AND ma.id = (
        SELECT ma_latest.id
        FROM kaudit_media_analysis ma_latest
        WHERE ma_latest.call_artifact_id = ca.id
          AND ma_latest.status = 'completed'
          AND ma_latest.classification_status = 'completed'
        ORDER BY ma_latest.created_at DESC, ma_latest.id DESC
        LIMIT 1
      )
     WHERE ${clauses.join(' AND ')}`,
    params,
  }
}

function taskIdPredicate(callAlias: string): string {
  return `(
    ${callAlias}.logical_call_key = ?
    OR EXISTS (
      SELECT 1
      FROM kaudit_call_external_reference task_ref
      WHERE task_ref.call_id = ${callAlias}.id
        AND task_ref.reference_type IN ('task_id','taskId','task')
        AND task_ref.external_id = ?
    )
  )`
}

export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
): Promise<AuditMonitorData>
export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: 'summary',
): Promise<AuditMonitorSummaryData>
export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: 'summary-core',
): Promise<AuditMonitorCoreSummaryData>
export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: 'summary-usage',
): Promise<AuditMonitorUsageSummaryData>
export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: 'summary-financial',
): Promise<AuditMonitorFinancialSummaryData>
export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: 'rows',
  rowTable?: AuditMonitorRowTable,
): Promise<AuditMonitorRowsData>
export function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: AuditMonitorSection,
  rowTable?: AuditMonitorRowTable,
): Promise<
  | AuditMonitorData
  | AuditMonitorSummaryData
  | AuditMonitorCoreSummaryData
  | AuditMonitorUsageSummaryData
  | AuditMonitorFinancialSummaryData
  | AuditMonitorRowsData
>
export async function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
  section: AuditMonitorSection = 'all',
  rowTable: AuditMonitorRowTable = 'all',
): Promise<
  | AuditMonitorData
  | AuditMonitorSummaryData
  | AuditMonitorCoreSummaryData
  | AuditMonitorUsageSummaryData
  | AuditMonitorFinancialSummaryData
  | AuditMonitorRowsData
> {
  const includeCombinedSummary = section === 'all' || section === 'summary'
  const includeCoreSummary =
    includeCombinedSummary || section === 'summary-core'
  const includeUsageSummary =
    includeCombinedSummary || section === 'summary-usage'
  const includeFinancialSummary =
    includeCombinedSummary || section === 'summary-financial'
  const includeRows = section === 'all' || section === 'rows'
  const filters = filterSql(query)
  const periodClause =
    query.periodStart && query.periodEnd
      ? ' AND c.billing_period_date BETWEEN ? AND ?'
      : ''
  const periodParams =
    query.periodStart && query.periodEnd
      ? [query.periodStart, query.periodEnd]
      : []
  const taskClause = query.taskId
    ? ` AND ${taskIdPredicate('c')}`
    : ''
  const taskParams = query.taskId ? [query.taskId, query.taskId] : []
  const queueScopeClause = `${periodClause}${taskClause}`
  const queueScopeParams = [...periodParams, ...taskParams]
  const summaryPrelude = await Promise.all([
    includeCoreSummary
      ? pool.query<OverallSummaryRow[]>(
      `SELECT
         COUNT(*) AS total_calls,
         SUM(
           COALESCE(artifact.recording_available, 0) = 1
           AND c.canonical_outcome_code IS NOT NULL
           AND COALESCE(artifact.pipeline_complete, 0) = 1
         ) AS audited_calls,
         SUM(
           COALESCE(artifact.recording_available, 0) = 1
         ) AS recording_available,
         SUM(
           COALESCE(artifact.recording_available, 0) = 1
           AND NOT (
             c.canonical_outcome_code IS NOT NULL
             AND COALESCE(artifact.pipeline_complete, 0) = 1
           )
         ) AS pending_calls,
         SUM(
           COALESCE(artifact.recording_available, 0) = 0
         ) AS no_recording_calls,
         SUM(
           COALESCE(artifact.processing_failure, 0) = 1
         ) AS processing_failures
       FROM kaudit_call c
       LEFT JOIN (
         SELECT
           ca.call_id,
           MAX(ca.source_url IS NOT NULL) AS recording_available,
           MAX(
             ca.source_url IS NOT NULL
             AND completed_media.call_artifact_id IS NOT NULL
             AND completed_transcript.call_artifact_id IS NOT NULL
           ) AS pipeline_complete,
           MAX(ca.audio_processing_status IN
             ('fetch_failed','transcribe_failed','classify_failed','exhausted'))
             AS processing_failure
         FROM kaudit_call_artifact ca
         LEFT JOIN (
           SELECT DISTINCT call_artifact_id
           FROM kaudit_media_analysis
           WHERE status = 'completed'
             AND classification_status = 'completed'
         ) completed_media
           ON completed_media.call_artifact_id = ca.id
         LEFT JOIN (
           SELECT DISTINCT call_artifact_id
           FROM kaudit_transcript
           WHERE status = 'completed'
         ) completed_transcript
           ON completed_transcript.call_artifact_id = ca.id
         WHERE ca.artifact_type = 'recording'
           AND ca.is_final = 1
         GROUP BY ca.call_id
       ) artifact ON artifact.call_id = c.id
       WHERE 1=1${periodClause}`,
      periodParams,
    )
      : Promise.resolve<[OverallSummaryRow[], never]>([
        [],
        undefined as never,
      ]),
    includeCoreSummary
      ? pool.query<CountRow[]>(
      `SELECT COUNT(DISTINCT run.call_id) AS n
       FROM kaudit_audit_run run
       JOIN kaudit_call c ON c.id = run.call_id
       WHERE run.engine_version = 'kairali-independent-reaudit/2.0.0'
         AND run.status = 'completed'${periodClause}`,
      periodParams,
    )
      : Promise.resolve<[CountRow[], never]>([[], undefined as never]),
    section === 'all'
      ? pool.query<CountRow[]>(
      `SELECT COUNT(DISTINCT c.id) AS n
       ${AUDITED_JOIN}
       ${filters.sql}`,
      filters.params,
    )
      : Promise.resolve<[CountRow[], never]>([[], undefined as never]),
    includeCoreSummary
      ? pool.query<RowDataPacket[]>(
      `SELECT DISTINCT c.canonical_outcome_code AS value
       FROM kaudit_call c
       WHERE c.canonical_outcome_code IS NOT NULL${periodClause}
       ORDER BY c.canonical_outcome_code`,
      periodParams,
    )
      : Promise.resolve<[RowDataPacket[], never]>([[], undefined as never]),
  ])

  const [overallRows, reauditRows, filteredRows, categories] =
    summaryPrelude

  const overall = overallRows[0][0]
  const totalCalls = Number(overall?.total_calls || 0)
  const aiAuditedCalls = Number(overall?.audited_calls || 0)
  const totalFilteredRows = count(filteredRows[0][0])
  const summaryPendingRows = Number(overall?.pending_calls || 0)
  const summaryNoRecordingRows = Number(
    overall?.no_recording_calls || 0,
  )
  let totalPendingRows = summaryPendingRows
  let totalNoRecordingRows = summaryNoRecordingRows
  if (query.taskId && includeCoreSummary) {
    const [pendingCountResult, noRecordingCountResult] =
      await Promise.all([
        pool.query<CountRow[]>(
          `SELECT COUNT(DISTINCT c.id) AS n
           FROM kaudit_call c
           JOIN kaudit_call_artifact ca
             ON ca.call_id = c.id
            AND ca.artifact_type = 'recording'
            AND ca.is_final = 1
            AND ca.source_url IS NOT NULL
           LEFT JOIN (
             SELECT DISTINCT call_artifact_id
             FROM kaudit_media_analysis
             WHERE status = 'completed'
               AND classification_status = 'completed'
           ) completed_media
             ON completed_media.call_artifact_id = ca.id
           LEFT JOIN (
             SELECT DISTINCT call_artifact_id
             FROM kaudit_transcript
             WHERE status = 'completed'
           ) completed_transcript
             ON completed_transcript.call_artifact_id = ca.id
           WHERE NOT (
             c.canonical_outcome_code IS NOT NULL
             AND completed_media.call_artifact_id IS NOT NULL
             AND completed_transcript.call_artifact_id IS NOT NULL
           )${queueScopeClause}`,
          queueScopeParams,
        ),
        pool.query<CountRow[]>(
          `SELECT COUNT(DISTINCT c.id) AS n
           FROM kaudit_call c
           WHERE NOT EXISTS (
             SELECT 1
             FROM kaudit_call_artifact recording
             WHERE recording.call_id = c.id
               AND recording.artifact_type = 'recording'
               AND recording.is_final = 1
               AND recording.source_url IS NOT NULL
           )${queueScopeClause}`,
          queueScopeParams,
        ),
      ])
    totalPendingRows = count(pendingCountResult[0][0])
    totalNoRecordingRows = count(noRecordingCountResult[0][0])
  }
  const recordingAvailableCalls = Number(
    overall?.recording_available || 0,
  )
  let usage: UsageSummaryRow | null = null
  let usageCostRows: UsageModelCostRow[] = []
  if (includeUsageSummary) {
    try {
      const [usageResult] = await pool.query<
        Array<UsageSummaryRow & UsageCostRow>
      >(
        `SELECT
           usage_event.model_name,
           COUNT(DISTINCT usage_event.audit_run_id)
             AS tracked_audit_runs,
           COALESCE(SUM(usage_event.input_tokens), 0)
             AS input_tokens,
           COALESCE(SUM(usage_event.output_tokens), 0)
             AS output_tokens,
           COALESCE(SUM(usage_event.total_tokens), 0)
             AS total_tokens,
           COALESCE(SUM(usage_event.audio_seconds), 0)
             AS audio_seconds
         FROM kaudit_ai_usage_event usage_event
         JOIN (
           SELECT DISTINCT c.id AS call_id, ar.id AS audit_run_id
           ${AUDITED_JOIN}
           ${filters.sql}
         ) audited
          ON audited.call_id = usage_event.call_id
          AND audited.audit_run_id = usage_event.audit_run_id
         GROUP BY usage_event.model_name WITH ROLLUP`,
        filters.params,
      )
      usage = usageResult.find((row) => row.model_name == null) ?? null
      usageCostRows = usageResult.filter(
        (row): row is UsageSummaryRow & UsageModelCostRow =>
          typeof row.model_name === 'string',
      )
    } catch {
      // Migration 0007 is additive. Until it is applied, the UI explicitly
      // reports usage as unrecorded instead of hiding the audit data.
      usage = null
      usageCostRows = []
    }
  }
  const financialScope = financialAuditedScope(query)
  const [financialRows] = includeFinancialSummary
    ? await pool.query<AuditedFinancialSummaryRow[]>(
      auditedFinancialSummarySql(financialScope.sql),
      financialScope.params,
    )
    : [[] as AuditedFinancialSummaryRow[]]
  const financial = financialRows[0]
  const aiCost = calculateOpenAiAuditCost(
    usageCostRows
      .filter((row) => typeof row.model_name === 'string')
      .map((row) => ({
        modelName: row.model_name,
        inputTokens: Number(row.input_tokens || 0),
        outputTokens: Number(row.output_tokens || 0),
        audioSeconds: Number(row.audio_seconds || 0).toFixed(3),
      })),
  )
  const generatedAt = new Date().toISOString()
  const coreSummary: AuditMonitorCoreSummaryData['summary'] = {
    totalCalls,
    aiAuditedCalls,
    auditCoveragePercent:
      totalCalls === 0
        ? '0.00'
        : ((aiAuditedCalls / totalCalls) * 100).toFixed(2),
    recordingAvailableCalls,
    pendingEligibleCalls: Math.max(0, summaryPendingRows),
    noRecordingCalls: summaryNoRecordingRows,
    processingFailureCalls: Number(overall?.processing_failures || 0),
    reauditV2Calls: count(reauditRows[0][0]),
  }
  const aiUsage: AuditMonitorUsageSummaryData['aiUsage'] = {
    trackedAuditRuns: Number(usage?.tracked_audit_runs || 0),
    gptInputTokens: Number(usage?.input_tokens || 0),
    gptOutputTokens: Number(usage?.output_tokens || 0),
    gptTotalTokens: Number(usage?.total_tokens || 0),
    whisperAudioSeconds: Number(usage?.audio_seconds || 0).toFixed(3),
    historicalUsageRecorded: usage != null,
  }
  const aiSpend: AuditMonitorUsageSummaryData['aiSpend'] = {
    aiSpendTrackedCalls: aiUsage.trackedAuditRuns,
    estimatedAiSpendUsd: aiCost.estimatedUsd,
    aiSpendPricingVersion: aiCost.pricingVersion,
    aiSpendPricingBasis: aiCost.pricingBasis,
    unpricedAiUsageRows: aiCost.unpricedRows,
  }
  const auditedFinancials: AuditMonitorFinancialSummaryData['auditedFinancials'] = {
    scopedAuditedCalls: Number(financial?.audited_calls || 0),
    kservePricedCalls: Number(financial?.kserve_priced_calls || 0),
    kserveChargeInr: moneyDecimal(financial?.kserve_charge),
    auditorFinalPricedCalls: Number(
      financial?.auditor_final_priced_calls || 0,
    ),
    auditorUnfinalizedCalls: Number(
      financial?.auditor_unfinalized_calls || 0,
    ),
    auditorFinalChargeInr: moneyDecimal(financial?.auditor_final_charge),
  }
  const summaryFilters: AuditMonitorData['filters'] = {
    category: query.category,
    taskId: query.taskId,
    availableCategories: categories[0].map((row) => String(row.value)),
  }
  if (section === 'summary-core') {
    return {
      generatedAt,
      summary: coreSummary,
      filters: summaryFilters,
      authority: 'automated',
    }
  }
  if (section === 'summary-usage') {
    return { generatedAt, aiUsage, aiSpend, authority: 'automated' }
  }
  if (section === 'summary-financial') {
    return { generatedAt, auditedFinancials, authority: 'automated' }
  }
  const summaryResponse: AuditMonitorSummaryData = {
    generatedAt,
    summary: {
      ...coreSummary,
      aiUsage,
      auditedFinancials: {
        ...auditedFinancials,
        ...aiSpend,
        aiSpendUntrackedCalls: Math.max(
          0,
          auditedFinancials.scopedAuditedCalls - aiUsage.trackedAuditRuns,
        ),
      },
    },
    filters: summaryFilters,
    authority: 'automated',
  }
  if (!includeRows) return summaryResponse

  const offset = (query.page - 1) * query.pageSize
  const pendingOffset = (query.pendingPage - 1) * query.pageSize
  const noRecordingOffset =
    (query.noRecordingPage - 1) * query.pageSize
  const rowLimit = section === 'rows' ? query.pageSize + 1 : query.pageSize
  const includeAuditedRows = rowTable === 'all' || rowTable === 'audited'
  const includePendingRows = rowTable === 'all' || rowTable === 'pending'
  const includeNoRecordingRows =
    rowTable === 'all' || rowTable === 'no-recording'
  const auditedPageTail = `FROM (
         SELECT
           c.id AS call_id,
           ca_candidate.id AS call_artifact_id,
           c.billing_period_date
         FROM kaudit_call c
         JOIN kaudit_call_artifact ca_candidate
           ON ca_candidate.id = (
             SELECT latest_artifact.id
             FROM kaudit_call_artifact latest_artifact
             WHERE latest_artifact.call_id = c.id
               AND latest_artifact.artifact_type = 'recording'
               AND latest_artifact.is_final = 1
               AND EXISTS (
                 SELECT 1
                 FROM kaudit_media_analysis completed_media
                 WHERE completed_media.call_artifact_id = latest_artifact.id
                   AND completed_media.status = 'completed'
                   AND completed_media.classification_status = 'completed'
               )
               AND EXISTS (
                 SELECT 1
                 FROM kaudit_transcript completed_transcript
                 WHERE completed_transcript.call_id = c.id
                   AND completed_transcript.call_artifact_id = latest_artifact.id
                   AND completed_transcript.status = 'completed'
               )
             ORDER BY latest_artifact.created_at DESC,
                      latest_artifact.id DESC
             LIMIT 1
           )
         JOIN kaudit_transcript t
           ON t.call_id = c.id
          AND t.call_artifact_id = ca_candidate.id
          AND t.status = 'completed'
          AND t.id = (
            SELECT t_candidate_latest.id
            FROM kaudit_transcript t_candidate_latest
            WHERE t_candidate_latest.call_id = c.id
              AND t_candidate_latest.call_artifact_id = ca_candidate.id
              AND t_candidate_latest.status = 'completed'
            ORDER BY t_candidate_latest.created_at DESC,
                     t_candidate_latest.id DESC
            LIMIT 1
          )
         ${filters.sql}
         ORDER BY c.billing_period_date DESC, c.id DESC
         LIMIT ? OFFSET ?
       ) audited_page
       JOIN kaudit_call c
         ON c.id = audited_page.call_id
       JOIN kaudit_call_artifact ca
         ON ca.id = audited_page.call_artifact_id
       JOIN kaudit_media_analysis ma
         ON ma.call_artifact_id = ca.id
        AND ma.status = 'completed'
        AND ma.classification_status = 'completed'
        AND ma.id = (
          SELECT ma_latest.id
          FROM kaudit_media_analysis ma_latest
          WHERE ma_latest.call_artifact_id = ca.id
            AND ma_latest.status = 'completed'
            AND ma_latest.classification_status = 'completed'
          ORDER BY ma_latest.created_at DESC, ma_latest.id DESC
          LIMIT 1
        )
       JOIN kaudit_transcript t
         ON t.call_id = c.id
        AND t.call_artifact_id = ca.id
        AND t.status = 'completed'
        AND t.id = (
          SELECT t_latest.id
          FROM kaudit_transcript t_latest
          WHERE t_latest.call_id = c.id
            AND t_latest.call_artifact_id = ca.id
            AND t_latest.status = 'completed'
          ORDER BY t_latest.created_at DESC, t_latest.id DESC
          LIMIT 1
        )
       LEFT JOIN kaudit_audit_run ar
         ON ar.id = c.latest_audit_run_id
       ORDER BY audited_page.billing_period_date DESC,
                audited_page.call_id DESC`
  const [auditedResult, pendingResult, noRecordingResult] =
    await Promise.all([
      includeAuditedRows ? pool.query<DataRow[]>(
    `SELECT
       c.id AS internal_call_id,
       ${TASK_REFERENCE_SQL} AS call_reference,
       c.billing_period_date,
       c.canonical_outcome_code AS category,
       c.outcome_taxonomy_version,
       CAST((
         SELECT af.confidence
         FROM kaudit_audit_finding af
         WHERE af.call_id = c.id
           AND af.finding_code = c.canonical_outcome_code
         ORDER BY af.created_at DESC, af.id DESC
         LIMIT 1
       ) AS CHAR) AS confidence,
       COALESCE((
         SELECT af.confirmation_status
         FROM kaudit_audit_finding af
         WHERE af.call_id = c.id
           AND af.finding_code = c.canonical_outcome_code
         ORDER BY af.created_at DESC, af.id DESC
         LIMIT 1
       ), 'model_output') AS confirmation_status,
       LOWER(COALESCE(t.language, 'unknown')) AS language,
       t.provider_name, t.model_name, t.model_version,
       ar.engine_version,
       ma.decoded_duration_ms,
       ma.speech_ms,
       ma.conversation_end_ms,
       ${categoryAdjustedDurationSql('ma')}
         AS grace_adjusted_duration_ms,
       -- Read once per displayed row. The difference against the
       -- grace-adjusted duration is derived from these two columns after the
       -- fact instead of repeating the lookup.
       (
         SELECT ROUND(MAX(pc.quantity_decimal) * 1000)
         FROM kaudit_provider_cost pc
         WHERE pc.call_id = c.id
           AND pc.provider_sku = 'duration_without_ringing_sec'
       ) AS vendor_connected_duration_ms,
       ca.sha256 AS evidence_sha256,
       ca.last_verified_at,
       COALESCE(ar.completed_at, ma.created_at) AS audited_at,
       (
         SELECT SUM(usage_event.input_tokens)
         FROM kaudit_ai_usage_event usage_event
         WHERE usage_event.audit_run_id = ar.id
       ) AS ai_input_tokens,
       (
         SELECT SUM(usage_event.output_tokens)
         FROM kaudit_ai_usage_event usage_event
         WHERE usage_event.audit_run_id = ar.id
       ) AS ai_output_tokens,
       (
         SELECT SUM(usage_event.total_tokens)
         FROM kaudit_ai_usage_event usage_event
         WHERE usage_event.audit_run_id = ar.id
       ) AS ai_total_tokens,
       (
         SELECT SUM(usage_event.audio_seconds)
         FROM kaudit_ai_usage_event usage_event
         WHERE usage_event.audit_run_id = ar.id
       ) AS ai_audio_seconds
     ${auditedPageTail}`,
    [...filters.params, rowLimit, offset],
      ) : Promise.resolve([[] as DataRow[]]),
      includePendingRows ? pool.query<QueueDataRow[]>(
        `SELECT
           COALESCE(
             (
               SELECT external_id
               FROM kaudit_call_external_reference ref
               WHERE ref.call_id = pending.call_id
                 AND ref.reference_type IN ('task_id','taskId','task')
               ORDER BY ref.id
               LIMIT 1
             ),
             pending.logical_call_key
           ) AS call_reference,
           pending.billing_period_date,
           pending.processing_status,
           pending.attempt_count,
           pending.evidence_sha256,
           pending.last_verified_at,
           (
             SELECT CAST(MAX(cost.minutes_decimal) AS CHAR)
             FROM kaudit_provider_cost cost
             WHERE cost.call_id = pending.call_id
               AND cost.provider_sku =
                   'vendor_asserted_billed_minutes'
               AND cost.is_final = 1
           ) AS vendor_billed_minutes,
           (
             SELECT ROUND(MAX(cost.quantity_decimal) * 1000)
             FROM kaudit_provider_cost cost
             WHERE cost.call_id = pending.call_id
               AND cost.provider_sku =
                   'duration_without_ringing_sec'
               AND cost.is_final = 1
           ) AS vendor_connected_duration_ms,
           NULL AS auditor_amount,
           NULL AS billing_status,
           NULL AS billing_basis,
           NULL AS audit_remark,
           pending.last_activity_at
         FROM (
           SELECT
             c.id AS call_id,
             c.logical_call_key,
             c.billing_period_date,
             ca.audio_processing_status AS processing_status,
             ca.audio_attempt_count AS attempt_count,
             ca.sha256 AS evidence_sha256,
             ca.last_verified_at,
             COALESCE(ca.audio_last_attempt_at, ca.created_at)
               AS last_activity_at
           FROM kaudit_call c
           JOIN kaudit_call_artifact ca
             ON ca.call_id = c.id
            AND ca.artifact_type = 'recording'
            AND ca.is_final = 1
            AND ca.source_url IS NOT NULL
           WHERE NOT (
             c.canonical_outcome_code IS NOT NULL
             AND EXISTS (
               SELECT 1
               FROM kaudit_media_analysis completed_media
               WHERE completed_media.call_artifact_id = ca.id
                 AND completed_media.status = 'completed'
                 AND completed_media.classification_status = 'completed'
             )
             AND EXISTS (
               SELECT 1
               FROM kaudit_transcript completed_transcript
               WHERE completed_transcript.call_artifact_id = ca.id
                 AND completed_transcript.status = 'completed'
             )
           )${queueScopeClause}
           ORDER BY c.billing_period_date DESC, c.id DESC
           LIMIT ? OFFSET ?
         ) pending
         ORDER BY pending.billing_period_date DESC, pending.call_id DESC`,
        [...queueScopeParams, rowLimit, pendingOffset],
      ) : Promise.resolve([[] as QueueDataRow[]]),
      includeNoRecordingRows ? pool.query<QueueDataRow[]>(
        `SELECT
           ${TASK_REFERENCE_SQL} AS call_reference,
           c.billing_period_date,
           COALESCE(ca.audio_processing_status, 'no_recording')
             AS processing_status,
           COALESCE(ca.audio_attempt_count, 0) AS attempt_count,
           ca.sha256 AS evidence_sha256,
           ca.last_verified_at,
           CAST(minutes.minutes_decimal AS CHAR)
             AS vendor_billed_minutes,
           ROUND(connected.quantity_decimal * 1000)
             AS vendor_connected_duration_ms,
           CASE
             WHEN calculation.id IS NULL THEN '0.00000000'
             ELSE CAST(calculation.total_amount AS CHAR)
           END AS auditor_amount,
           calculation.status AS billing_status,
           calculation.calculation_basis AS billing_basis,
           'No Recording Found' AS audit_remark,
           COALESCE(ca.audio_last_attempt_at, ca.created_at, c.created_at)
             AS last_activity_at
         FROM (
           SELECT
             c.id,
             c.logical_call_key,
             c.billing_period_date,
             c.created_at
           FROM kaudit_call c
           WHERE NOT EXISTS (
             SELECT 1
             FROM kaudit_call_artifact recording
             WHERE recording.call_id = c.id
               AND recording.artifact_type = 'recording'
               AND recording.is_final = 1
               AND recording.source_url IS NOT NULL
           )${queueScopeClause}
           ORDER BY c.billing_period_date DESC, c.id DESC
           LIMIT ? OFFSET ?
         ) c
         LEFT JOIN kaudit_call_artifact ca
           ON ca.call_id = c.id
          AND ca.artifact_type = 'recording'
          AND ca.is_final = 1
          AND ca.id = (
            SELECT latest_artifact.id
            FROM kaudit_call_artifact latest_artifact
            WHERE latest_artifact.call_id = c.id
              AND latest_artifact.artifact_type = 'recording'
              AND latest_artifact.is_final = 1
            ORDER BY latest_artifact.created_at DESC,
                     latest_artifact.id DESC
            LIMIT 1
          )
         LEFT JOIN kaudit_provider_cost minutes
           ON minutes.call_id = c.id
          AND minutes.provider_sku = 'vendor_asserted_billed_minutes'
          AND minutes.is_final = 1
         LEFT JOIN kaudit_provider_cost connected
           ON connected.call_id = c.id
          AND connected.provider_sku = 'duration_without_ringing_sec'
          AND connected.is_final = 1
         LEFT JOIN kaudit_billing_calculation calculation
           ON calculation.call_id = c.id
          AND calculation.status = 'final'
          AND calculation.calculation_basis = 'no_recording_zero'
          AND NOT EXISTS (
            SELECT 1
            FROM kaudit_billing_calculation superseding
            WHERE superseding.supersedes_calculation_id = calculation.id
          )
         ORDER BY c.billing_period_date DESC, c.id DESC
         `,
        [...queueScopeParams, rowLimit, noRecordingOffset],
      ) : Promise.resolve([[] as QueueDataRow[]]),
    ])
  const fetchedRows = auditedResult[0]
  const fetchedPendingRows = pendingResult[0]
  const fetchedNoRecordingRows = noRecordingResult[0]
  const rowResult = fetchedRows.slice(0, query.pageSize)
  const pendingRowResult = fetchedPendingRows.slice(0, query.pageSize)
  const noRecordingRowResult = fetchedNoRecordingRows.slice(
    0,
    query.pageSize,
  )
  // Scoped to the rows actually on screen. The keys go in, only the two safe
  // lifecycle words come back, and neither the keys nor the queue's own ids
  // reach the response.
  const reAuditStatuses = await readManualReauditRowStatuses(
    pool,
    rowResult
      .map((row) => row.internal_call_id)
      .filter((value): value is string => typeof value === 'string'),
  )

  const rowsResponse: AuditMonitorRowsData = {
    generatedAt,
    rows: rowResult.map((row) => {
      const graceAdjustedDurationMs = nullableNumber(
        row.grace_adjusted_duration_ms,
      )
      const vendorConnectedDurationMs = nullableNumber(
        row.vendor_connected_duration_ms,
      )
      return {
        callReference: row.call_reference,
        billingPeriodDate: isoDate(row.billing_period_date),
        category: row.category,
        outcomeTaxonomyVersion: row.outcome_taxonomy_version,
        confidence: row.confidence,
        confirmationStatus: row.confirmation_status || 'model_output',
        language: row.language || 'unknown',
        asrProvider: row.provider_name,
        asrModel: row.model_name,
        asrModelVersion: row.model_version,
        auditEngineVersion: row.engine_version,
        recordedDurationMs: nullableNumber(row.decoded_duration_ms),
        speechDurationMs: nullableNumber(row.speech_ms),
        conversationEndMs: nullableNumber(row.conversation_end_ms),
        graceAdjustedDurationMs,
        vendorConnectedDurationMs,
        varianceDurationMs: durationVarianceMs(
          vendorConnectedDurationMs,
          graceAdjustedDurationMs,
        ),
        evidenceHashRecorded: Boolean(row.evidence_sha256),
        lastEvidenceVerifiedAt: isoDate(row.last_verified_at),
        auditedAt: isoDate(row.audited_at),
        reAuditStatus: row.internal_call_id
          ? reAuditStatuses.get(row.internal_call_id)?.status ?? null
          : null,
        reAuditCompletedAt: row.internal_call_id
          ? isoDate(
              reAuditStatuses.get(row.internal_call_id)?.completedAt ?? null,
            )
          : null,
        reAuditFailureCode: row.internal_call_id
          ? reAuditStatuses.get(row.internal_call_id)?.failureCode ?? null
          : null,
        aiUsage: {
          inputTokens: nullableNumber(row.ai_input_tokens),
          outputTokens: nullableNumber(row.ai_output_tokens),
          totalTokens: nullableNumber(row.ai_total_tokens),
          audioSeconds:
            row.ai_audio_seconds == null
              ? null
              : Number(row.ai_audio_seconds).toFixed(3),
        },
      }
    }),
    pendingRows: pendingRowResult.map((row) => mapQueueRow(row)),
    noRecordingRows: noRecordingRowResult.map((row) => mapQueueRow(row)),
    pagination: section === 'rows'
      ? windowPagination(query.page, query.pageSize, fetchedRows.length)
      : pagination(query.page, query.pageSize, totalFilteredRows),
    pendingPagination: section === 'rows'
      ? windowPagination(
        query.pendingPage,
        query.pageSize,
        fetchedPendingRows.length,
      )
      : pagination(query.pendingPage, query.pageSize, totalPendingRows),
    noRecordingPagination: section === 'rows'
      ? windowPagination(
        query.noRecordingPage,
        query.pageSize,
        fetchedNoRecordingRows.length,
      )
      : pagination(
        query.noRecordingPage,
        query.pageSize,
        totalNoRecordingRows,
      ),
    totalsFinal: section !== 'rows',
    authority: 'automated',
    contentBoundary:
      'Admin-only audit metadata. Use Admin review for restricted evidence, transcript, and per-call billing context when available.',
  }
  if (!includeCombinedSummary) return rowsResponse
  return { ...summaryResponse, ...rowsResponse }
}
