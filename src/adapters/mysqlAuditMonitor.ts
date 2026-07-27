import type { Pool, RowDataPacket } from 'mysql2/promise'

export interface AuditMonitorQuery {
  page: number
  pageSize: number
  category: string | null
  language: string | null
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
  }
  rows: AuditMonitorRow[]
  pagination: {
    page: number
    pageSize: number
    totalRows: number
    totalPages: number
  }
  filters: {
    category: string | null
    language: string | null
    availableCategories: string[]
    availableLanguages: string[]
  }
  authority: 'uncalibrated'
  contentBoundary: string
}

interface CountRow extends RowDataPacket {
  n: number | string
}

interface StatusSummaryRow extends RowDataPacket {
  recording_available: number | string
  processing_failures: number | string
}

interface DataRow extends RowDataPacket {
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
  variance_duration_ms: number | string | null
  evidence_sha256: string | null
  last_verified_at: Date | string | null
  audited_at: Date | string | null
}

function count(row: CountRow | undefined): number {
  return Number(row?.n || 0)
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value)
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

function filterSql(query: AuditMonitorQuery): {
  sql: string
  params: unknown[]
} {
  const clauses = ['c.canonical_outcome_code IS NOT NULL']
  const params: unknown[] = []
  if (query.category) {
    clauses.push('c.canonical_outcome_code = ?')
    params.push(query.category)
  }
  if (query.language) {
    clauses.push('LOWER(COALESCE(t.language, ?)) = ?')
    params.push('unknown', query.language.toLowerCase())
  }
  return { sql: `WHERE ${clauses.join(' AND ')}`, params }
}

export async function collectAuditMonitor(
  pool: Pool,
  query: AuditMonitorQuery,
): Promise<AuditMonitorData> {
  const filters = filterSql(query)
  const [
    totalRows,
    auditedRows,
    statusRows,
    reauditRows,
    filteredRows,
    categories,
    languages,
  ] = await Promise.all([
    pool.query<CountRow[]>('SELECT COUNT(*) AS n FROM kaudit_call'),
    pool.query<CountRow[]>(
      `SELECT COUNT(DISTINCT c.id) AS n ${AUDITED_JOIN}
       WHERE c.canonical_outcome_code IS NOT NULL`,
    ),
    pool.query<StatusSummaryRow[]>(
      `SELECT
         SUM(source_url IS NOT NULL) AS recording_available,
         SUM(audio_processing_status IN
           ('fetch_failed','transcribe_failed','classify_failed','exhausted')) AS processing_failures
       FROM kaudit_call_artifact
       WHERE artifact_type = 'recording' AND is_final = 1`,
    ),
    pool.query<CountRow[]>(
      `SELECT COUNT(DISTINCT call_id) AS n
       FROM kaudit_audit_run
       WHERE engine_version = 'kairali-independent-reaudit/2.0.0'
         AND status = 'completed'`,
    ),
    pool.query<CountRow[]>(
      `SELECT COUNT(DISTINCT c.id) AS n
       ${AUDITED_JOIN}
       ${filters.sql}`,
      filters.params,
    ),
    pool.query<RowDataPacket[]>(
      `SELECT DISTINCT canonical_outcome_code AS value
       FROM kaudit_call
       WHERE canonical_outcome_code IS NOT NULL
       ORDER BY canonical_outcome_code`,
    ),
    pool.query<RowDataPacket[]>(
      `SELECT DISTINCT LOWER(COALESCE(language, 'unknown')) AS value
       FROM kaudit_transcript
       WHERE status = 'completed'
       ORDER BY value`,
    ),
  ])

  const totalCalls = count(totalRows[0][0])
  const aiAuditedCalls = count(auditedRows[0][0])
  const recordingAvailableCalls = Number(
    statusRows[0][0]?.recording_available || 0,
  )
  const totalFilteredRows = count(filteredRows[0][0])
  const offset = (query.page - 1) * query.pageSize
  const [rowResult] = await pool.query<DataRow[]>(
    `SELECT
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
       ) AS call_reference,
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
       CASE
         WHEN ma.conversation_end_ms IS NULL THEN NULL
         ELSE LEAST(
           COALESCE(ma.decoded_duration_ms, ma.conversation_end_ms + 60000),
           ma.conversation_end_ms + 60000
         )
       END AS grace_adjusted_duration_ms,
       (
         SELECT ROUND(MAX(pc.quantity_decimal) * 1000)
         FROM kaudit_provider_cost pc
         WHERE pc.call_id = c.id
           AND pc.provider_sku = 'duration_without_ringing_sec'
       ) AS vendor_connected_duration_ms,
       CASE
         WHEN ma.conversation_end_ms IS NULL THEN NULL
         ELSE (
           SELECT ROUND(MAX(pc.quantity_decimal) * 1000)
           FROM kaudit_provider_cost pc
           WHERE pc.call_id = c.id
             AND pc.provider_sku = 'duration_without_ringing_sec'
         ) - LEAST(
           COALESCE(ma.decoded_duration_ms, ma.conversation_end_ms + 60000),
           ma.conversation_end_ms + 60000
         )
       END AS variance_duration_ms,
       ca.sha256 AS evidence_sha256,
       ca.last_verified_at,
       COALESCE(ar.completed_at, ma.created_at) AS audited_at
     ${AUDITED_JOIN}
     ${filters.sql}
     ORDER BY audited_at DESC, c.id
     LIMIT ? OFFSET ?`,
    [...filters.params, query.pageSize, offset],
  )

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      totalCalls,
      aiAuditedCalls,
      auditCoveragePercent:
        totalCalls === 0
          ? '0.00'
          : ((aiAuditedCalls / totalCalls) * 100).toFixed(2),
      recordingAvailableCalls,
      pendingEligibleCalls: Math.max(
        0,
        recordingAvailableCalls - aiAuditedCalls,
      ),
      noRecordingCalls: Math.max(0, totalCalls - recordingAvailableCalls),
      processingFailureCalls: Number(
        statusRows[0][0]?.processing_failures || 0,
      ),
      reauditV2Calls: count(reauditRows[0][0]),
    },
    rows: rowResult.map((row) => ({
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
      graceAdjustedDurationMs: nullableNumber(
        row.grace_adjusted_duration_ms,
      ),
      vendorConnectedDurationMs: nullableNumber(
        row.vendor_connected_duration_ms,
      ),
      varianceDurationMs: nullableNumber(row.variance_duration_ms),
      evidenceHashRecorded: Boolean(row.evidence_sha256),
      lastEvidenceVerifiedAt: isoDate(row.last_verified_at),
      auditedAt: isoDate(row.audited_at),
    })),
    pagination: {
      page: query.page,
      pageSize: query.pageSize,
      totalRows: totalFilteredRows,
      totalPages: Math.max(
        1,
        Math.ceil(totalFilteredRows / query.pageSize),
      ),
    },
    filters: {
      category: query.category,
      language: query.language,
      availableCategories: categories[0].map((row) => String(row.value)),
      availableLanguages: languages[0].map((row) => String(row.value)),
    },
    authority: 'uncalibrated',
    contentBoundary:
      'Admin-only audit metadata. Phone numbers, audio, transcripts, recording URLs, health content, and free-text finding explanations are excluded.',
  }
}
