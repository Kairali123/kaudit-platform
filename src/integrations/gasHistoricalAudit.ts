import { createHash, createHmac, timingSafeEqual } from 'node:crypto'
import type {
  Pool,
  PoolConnection,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import {
  canonicalizeLateRecordingUrl,
  canonicalUrlSha256,
} from '../lateRecording/corrections.ts'

const MONTH = /^(\d{4})-(\d{2})$/
const TASK_ID = /^[A-Za-z0-9._:-]{1,128}$/
const REQUEST_KEY = /^[A-Za-z0-9-]{16,64}$/
const MAX_PAGE_SIZE = 200
const MAX_PREPARE_ROWS = 20

interface HistoricalDetailRow extends RowDataPacket {
  call_id: string
  artifact_id: string | null
  source_url: string | null
  artifact_sha256: string | null
  latest_audit_run_id: string | null
  latest_audit_status: string | null
  connected_seconds: string | null
  vendor_billed_minutes: string | null
  vendor_billed_amount: string | null
  category: string | null
  confidence: string | null
  verified_amount: string | null
  calculation_basis: string | null
}

interface HistoricalRow extends HistoricalDetailRow {
  task_id: string
}

interface HistoricalPageRow extends RowDataPacket {
  task_id: string
  call_id: string
}

export interface GasHistoricalStateTokenPayload {
  v: 1
  month: string
  taskId: string
  callId: string
  artifactId: string | null
  sourceUrlSha256: string | null
  latestAuditRunId: string | null
}

type Raw = Record<string, unknown>

export interface GasHistoricalMonthRequest {
  billMonth: string
  body: unknown
  tokenSecret: string
}

export interface GasHistoricalPrepareRequest extends GasHistoricalMonthRequest {
  allowedRecordingHosts: readonly string[]
}

export interface GasHistoricalMonthReceipt {
  billMonth: string
  rows: Array<{
    taskId: string
    billMonth: string
    connectedSeconds: string | null
    vendorBilledMinutes: string | null
    vendorBilledAmount: string | null
    recordingStatus: 'ATTACHED' | 'MISSING'
    auditStatus: 'AUDITED' | 'NOT_AUDITED'
    currentCategory: string | null
    currentConfidence: string | null
    currentVerifiedAmount: string | null
    currentCalculationBasis: string | null
    stateToken: string
  }>
  nextCursor: string | null
}

export interface GasHistoricalPrepareReceipt {
  items: Array<{
    taskId: string
    status: 'prepared' | 'rejected'
    mode?: 'LATE_RECORDING' | 'INITIAL_AUDIT' | 'REAUDIT'
    stateToken?: string
    requestKey?: string
    code?: string
  }>
}

function record(value: unknown, name: string): Raw {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`)
  }
  return value as Raw
}

function text(value: unknown, name: string, max = 1_200): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new TypeError(`${name} is invalid`)
  }
  return value.trim()
}

function validMonth(value: string): string {
  const match = MONTH.exec(value)
  const month = Number(match?.[2] ?? 0)
  if (!match || month < 1 || month > 12) {
    throw new TypeError('bill_month is invalid')
  }
  return value
}

function monthBounds(month: string): { start: string; end: string } {
  const valid = validMonth(month)
  const [year, part] = valid.split('-').map(Number)
  const finalDay = new Date(Date.UTC(year, part, 0)).getUTCDate()
  return {
    start: `${valid}-01`,
    end: `${valid}-${String(finalDay).padStart(2, '0')}`,
  }
}

function hash(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function tokenPayload(
  row: HistoricalRow,
  month: string,
): GasHistoricalStateTokenPayload {
  return {
    v: 1,
    month,
    taskId: row.task_id,
    callId: row.call_id,
    artifactId: row.artifact_id,
    sourceUrlSha256: row.source_url ? canonicalUrlSha256(row.source_url) : null,
    latestAuditRunId: row.latest_audit_run_id,
  }
}

export function signGasHistoricalStateToken(
  payload: GasHistoricalStateTokenPayload,
  secret: string,
): string {
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
  const signature = createHmac('sha256', secret).update(encoded).digest('base64url')
  return `${encoded}.${signature}`
}

export function verifyGasHistoricalStateToken(
  token: string,
  secret: string,
): GasHistoricalStateTokenPayload {
  const [encoded, supplied, extra] = token.split('.')
  if (!encoded || !supplied || extra) throw new Error('STATE_TOKEN_INVALID')
  const expected = createHmac('sha256', secret).update(encoded).digest()
  let actual: Buffer
  try {
    actual = Buffer.from(supplied, 'base64url')
  } catch {
    throw new Error('STATE_TOKEN_INVALID')
  }
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new Error('STATE_TOKEN_INVALID')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  } catch {
    throw new Error('STATE_TOKEN_INVALID')
  }
  const value = record(parsed, 'state token')
  if (
    value.v !== 1 ||
    typeof value.month !== 'string' ||
    typeof value.taskId !== 'string' ||
    typeof value.callId !== 'string' ||
    !(value.artifactId == null || typeof value.artifactId === 'string') ||
    !(value.sourceUrlSha256 == null || typeof value.sourceUrlSha256 === 'string') ||
    !(value.latestAuditRunId == null || typeof value.latestAuditRunId === 'string')
  ) {
    throw new Error('STATE_TOKEN_INVALID')
  }
  return value as unknown as GasHistoricalStateTokenPayload
}

function stateMatches(
  left: GasHistoricalStateTokenPayload,
  right: GasHistoricalStateTokenPayload,
): boolean {
  return hash(JSON.stringify(left)) === hash(JSON.stringify(right))
}

const HISTORICAL_DETAILS_SELECT = `
  SELECT c.id AS call_id,
         recording.id AS artifact_id, recording.source_url,
         recording.sha256 AS artifact_sha256,
         c.latest_audit_run_id,
         latest_run.status AS latest_audit_status,
         CAST((
           SELECT MAX(cost.quantity_decimal)
           FROM kaudit_provider_cost cost
           WHERE cost.call_id = c.id
             AND cost.provider_sku = 'duration_without_ringing_sec'
             AND cost.is_final = 1
         ) AS CHAR) AS connected_seconds,
         CAST((
           SELECT MAX(cost.minutes_decimal)
           FROM kaudit_provider_cost cost
           WHERE cost.call_id = c.id
             AND cost.provider_sku = 'vendor_asserted_billed_minutes'
             AND cost.is_final = 1
         ) AS CHAR) AS vendor_billed_minutes,
         CAST((
           SELECT MAX(cost.quantity_decimal)
           FROM kaudit_provider_cost cost
           WHERE cost.call_id = c.id
             AND cost.provider_sku = 'vendor_asserted_billed_amount'
             AND cost.is_final = 1
         ) AS CHAR) AS vendor_billed_amount,
         c.canonical_outcome_code AS category,
         CAST(latest_finding.confidence AS CHAR) AS confidence,
         CAST(current_calc.total_amount AS CHAR) AS verified_amount,
         current_calc.calculation_basis
  FROM kaudit_call c
  LEFT JOIN kaudit_call_artifact recording
    ON recording.id = (
      SELECT artifact.id
      FROM kaudit_call_artifact artifact
      WHERE artifact.call_id = c.id
        AND artifact.artifact_type = 'recording'
        AND artifact.is_final = 1
      ORDER BY artifact.created_at DESC, artifact.id DESC
      LIMIT 1
    )
  LEFT JOIN kaudit_audit_run latest_run
    ON latest_run.id = c.latest_audit_run_id
  LEFT JOIN kaudit_audit_finding latest_finding
    ON latest_finding.id = (
      SELECT finding.id
      FROM kaudit_audit_finding finding
      WHERE finding.audit_run_id = c.latest_audit_run_id
        AND finding.origin = 'model'
      ORDER BY finding.created_at DESC, finding.id DESC
      LIMIT 1
    )
  LEFT JOIN kaudit_billing_calculation current_calc
    ON current_calc.call_id = c.id
   AND NOT EXISTS (
     SELECT 1 FROM kaudit_billing_calculation newer
     WHERE newer.supersedes_calculation_id = current_calc.id
   )`

async function loadHistoricalRow(
  connection: PoolConnection,
  taskId: string,
  bounds: { start: string; end: string },
  lock = false,
): Promise<HistoricalRow | null> {
  const [rows] = await connection.execute<HistoricalRow[]>(
    `${HISTORICAL_DETAILS_SELECT}
     JOIN kaudit_call_external_reference ref
       ON ref.call_id = c.id AND ref.reference_type = 'task_id'
     WHERE c.billing_period_date BETWEEN ? AND ?
       AND ref.external_id = ?
     LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [bounds.start, bounds.end, taskId],
  )
  return rows[0] ? { ...rows[0], task_id: taskId } : null
}

function publicRow(row: HistoricalRow, month: string, secret: string) {
  const audited = row.latest_audit_status === 'completed'
  return {
    taskId: row.task_id,
    billMonth: month,
    connectedSeconds: row.connected_seconds,
    vendorBilledMinutes: row.vendor_billed_minutes,
    vendorBilledAmount: row.vendor_billed_amount,
    recordingStatus: row.source_url ? 'ATTACHED' as const : 'MISSING' as const,
    auditStatus: audited ? 'AUDITED' as const : 'NOT_AUDITED' as const,
    currentCategory: row.category,
    currentConfidence: row.confidence,
    currentVerifiedAmount: row.verified_amount,
    currentCalculationBasis: row.calculation_basis,
    stateToken: signGasHistoricalStateToken(tokenPayload(row, month), secret),
  }
}

export function createGasHistoricalAudit(pool: Pool): {
  list(input: GasHistoricalMonthRequest): Promise<GasHistoricalMonthReceipt>
  prepare(input: GasHistoricalPrepareRequest): Promise<GasHistoricalPrepareReceipt>
} {
  return {
    async list(input) {
      const month = validMonth(input.billMonth)
      const body = record(input.body, 'body')
      if (body.schema_version !== '1') throw new TypeError('schema version is invalid')
      if (text(body.bill_month, 'bill_month', 7) !== month) {
        throw new TypeError('bill month does not match')
      }
      const limit = Math.min(
        MAX_PAGE_SIZE,
        Math.max(1, Number(body.limit || MAX_PAGE_SIZE)),
      )
      if (!Number.isSafeInteger(limit)) throw new TypeError('limit is invalid')
      const cursor = body.cursor == null || body.cursor === ''
        ? ''
        : text(body.cursor, 'cursor', 128)
      const bounds = monthBounds(month)
      // Resolve the page from the narrow month/call-id index before touching
      // artifacts, costs, findings, or calculations. Applying LIMIT after the
      // historical detail joins made MySQL evaluate thousands of correlated
      // lookups for a 500-row response and could outlive the Vercel function.
      const [candidates] = await pool.execute<HistoricalPageRow[]>(
        `SELECT ref.external_id AS task_id, c.id AS call_id
         FROM kaudit_call c
         JOIN kaudit_call_external_reference ref
           ON ref.call_id = c.id AND ref.reference_type = 'task_id'
         WHERE c.billing_period_date BETWEEN ? AND ?
           AND c.id > ?
         ORDER BY c.id
         LIMIT ?`,
        [bounds.start, bounds.end, cursor, limit + 1],
      )
      const page = candidates.slice(0, limit)
      if (!page.length) {
        return { billMonth: month, rows: [], nextCursor: null }
      }
      const callIds = page.map((row) => row.call_id)
      const placeholders = callIds.map(() => '?').join(',')
      const [details] = await pool.execute<HistoricalDetailRow[]>(
        `${HISTORICAL_DETAILS_SELECT}
         WHERE c.id IN (${placeholders})`,
        callIds,
      )
      const detailByCallId = new Map(details.map((row) => [row.call_id, row]))
      const rows = page.map((candidate): HistoricalRow => {
        const detail = detailByCallId.get(candidate.call_id)
        if (!detail) throw new Error('HISTORICAL_PAGE_INCONSISTENT')
        return { ...detail, task_id: candidate.task_id }
      })
      return {
        billMonth: month,
        rows: rows.map((row) => publicRow(row, month, input.tokenSecret)),
        nextCursor: candidates.length > limit
          ? page[page.length - 1]?.call_id ?? null
          : null,
      }
    },

    async prepare(input) {
      const month = validMonth(input.billMonth)
      const body = record(input.body, 'body')
      if (body.schema_version !== '1') throw new TypeError('schema version is invalid')
      if (text(body.bill_month, 'bill_month', 7) !== month) {
        throw new TypeError('bill month does not match')
      }
      if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > MAX_PREPARE_ROWS) {
        throw new TypeError('items must contain 1 to 20 rows')
      }
      const bounds = monthBounds(month)
      const receipts: GasHistoricalPrepareReceipt['items'] = []
      for (const rawItem of body.items) {
        let taskId = 'invalid'
        const connection = await pool.getConnection()
        try {
          const item = record(rawItem, 'item')
          taskId = text(item.task_id, 'task_id', 128)
          if (!TASK_ID.test(taskId)) throw new Error('TASK_ID_INVALID')
          const requestKey = text(item.request_key, 'request_key', 64)
          if (!REQUEST_KEY.test(requestKey)) throw new Error('REQUEST_KEY_INVALID')
          const suppliedState = verifyGasHistoricalStateToken(
            text(item.state_token, 'state_token', 2_000),
            input.tokenSecret,
          )
          if (suppliedState.month !== month || suppliedState.taskId !== taskId) {
            throw new Error('STATE_TOKEN_SCOPE_MISMATCH')
          }
          const submittedUrl = text(item.recording_url, 'recording_url', 8_192)
          const normalized = canonicalizeLateRecordingUrl(
            submittedUrl,
            input.allowedRecordingHosts,
          )
          if (!('canonicalUrl' in normalized)) throw new Error(normalized.code)
          await connection.beginTransaction()
          let row = await loadHistoricalRow(connection, taskId, bounds, true)
          if (!row) throw new Error('TASK_NOT_FOUND')
          if (!stateMatches(suppliedState, tokenPayload(row, month))) {
            throw new Error('ROW_CHANGED_RESYNC_REQUIRED')
          }
          const wasMissing = !row.source_url
          if (row.source_url) {
            const existing = canonicalizeLateRecordingUrl(
              row.source_url,
              input.allowedRecordingHosts,
            )
            if (
              !('canonicalUrl' in existing) ||
              canonicalUrlSha256(existing.canonicalUrl) !==
                canonicalUrlSha256(normalized.canonicalUrl)
            ) {
              throw new Error('RECORDING_EVIDENCE_CONFLICT')
            }
          } else {
            if (!row.artifact_id) throw new Error('RECORDING_ARTIFACT_NOT_FOUND')
            const [updated] = await connection.execute<ResultSetHeader>(
              `UPDATE kaudit_call_artifact
               SET source_url = ?, audio_processing_status = 'pending',
                   audio_attempt_count = 0, audio_last_attempt_at = NULL,
                   audio_next_attempt_at = NULL, audio_last_error = NULL
               WHERE id = ? AND call_id = ?
                 AND artifact_type = 'recording' AND is_final = 1
                 AND source_url IS NULL AND sha256 IS NULL`,
              [normalized.canonicalUrl, row.artifact_id, row.call_id],
            )
            if (updated.affectedRows !== 1) {
              throw new Error('ROW_CHANGED_RESYNC_REQUIRED')
            }
            row = { ...row, source_url: normalized.canonicalUrl }
          }
          await connection.commit()
          const mode = row.latest_audit_status === 'completed'
            ? 'REAUDIT' as const
            : wasMissing
              ? 'LATE_RECORDING' as const
              : 'INITIAL_AUDIT' as const
          receipts.push({
            taskId,
            status: 'prepared',
            mode,
            stateToken: signGasHistoricalStateToken(
              tokenPayload(row, month),
              input.tokenSecret,
            ),
            requestKey,
          })
        } catch (error) {
          try { await connection.rollback() } catch { /* best effort */ }
          receipts.push({
            taskId,
            status: 'rejected',
            code: error instanceof Error && /^[A-Z0-9_]{3,80}$/.test(error.message)
              ? error.message
              : 'HISTORICAL_PREPARE_FAILED',
          })
        } finally {
          connection.release()
        }
      }
      return { items: receipts }
    },
  }
}
