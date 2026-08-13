import type { Pool, RowDataPacket } from 'mysql2/promise'
import {
  validateSourceChangeQuery,
  validateSourceCandidateQuery,
  type SourceChangeCursor,
  type SourceChangeQuery,
  type SourceCandidateQuery,
} from '../callaudit/sourceQuery.ts'
import { normalizeSourceRowId } from '../callaudit/sourceRowId.ts'
import {
  CALL_AUDIT_SOURCE_TABLE,
  CallAuditSourceRowError,
  type InternalSourceCandidate,
} from '../callaudit/sourceTypes.ts'

/**
 * READ-ONLY adapter over the external KServe source table.
 *
 * Contract:
 *   * SELECT only — this module issues no INSERT, UPDATE, DELETE, REPLACE,
 *     ALTER, CREATE, DROP, TRUNCATE, or locking statement, ever;
 *   * an explicit column list, never SELECT *;
 *   * every caller value is a prepared placeholder, never concatenated;
 *   * the SQL text is a module constant, so there is no injection surface;
 *   * the only content column selected is `transcription`, the approved audit
 *     evidence. Client name, mobile, email, transcription/IVR URLs, and source
 *     free text are never selected, so they cannot leak downstream.
 *
 * Timezone: source timestamps are UTC-naive database values, and this adapter
 * expects period boundaries ALREADY CONVERTED to that same UTC-naive form. It
 * performs no zone conversion; turning an Asia/Kolkata calendar period into
 * source boundaries belongs to scheduling, not here.
 */

/**
 * Deterministic effective call time. Repeated verbatim in the WHERE clause
 * because MySQL does not allow a SELECT alias in WHERE.
 */
const EFFECTIVE_CALL_TIME =
  'COALESCE(src.`call_start_time`, src.`date_time`, src.`timestamp`)'

const SOURCE_CHANGE_TIME =
  `COALESCE(src.\`updated_at\`, ${EFFECTIVE_CALL_TIME})`

const SELECT_LIST = `
    CAST(src.\`id\` AS CHAR) AS source_row_id,
    src.\`lead_id\` AS lead_id,
    src.\`transcription\` AS transcription,
    src.\`updated_at\` AS source_updated_at,
    src.\`call_start_time\` AS call_started_at,
    src.\`call_end_time\` AS call_ended_at,
    src.\`call_duration_sec\` AS call_duration_sec,
    ${EFFECTIVE_CALL_TIME} AS effective_call_time,
    src.\`company_by_kserve\` AS company_by_kserve,
    src.\`company\` AS company,
    src.\`data_source\` AS data_source,
    src.\`verified_source\` AS verified_source,
    src.\`service_category\` AS service_category,
    src.\`call_type\` AS call_type,
    src.\`call_status\` AS call_status,
    src.\`call_end_reason\` AS call_end_reason,
    src.\`final_call_status\` AS final_call_status,
    src.\`ai_call_category\` AS ai_call_category,
    src.\`customer_engagement_level\` AS customer_engagement_level,
    src.\`interest_level\` AS interest_level,
    src.\`call_outcome\` AS call_outcome,
    src.\`lead_status\` AS lead_status,
    src.\`final_lead_outcome\` AS final_lead_outcome,
    src.\`calculated_qualification_status\` AS calculated_qualification_status,
    src.\`followup_required\` AS followup_required`

const CHANGE_SELECT_LIST = `${SELECT_LIST},
    ${SOURCE_CHANGE_TIME} AS source_change_time`

/**
 * Half-open period predicate: start inclusive, end exclusive. Every call in the
 * period is selected, including calls with no transcript, so operational
 * reporting stays complete.
 */
const PERIOD_PREDICATE = `${EFFECTIVE_CALL_TIME} >= ?
     AND ${EFFECTIVE_CALL_TIME} < ?`

/**
 * Keyset pagination, never OFFSET: strictly after the last row consumed. The
 * id comparison targets `src.id` (BIGINT) against a prepared decimal string, so
 * MySQL compares numerically at full BIGINT precision.
 */
const CURSOR_PREDICATE = `AND (
       ${EFFECTIVE_CALL_TIME} > ?
       OR (${EFFECTIVE_CALL_TIME} = ? AND src.\`id\` > ?)
     )`

/**
 * Ordering and the cursor comparison both use `src.id` — the BIGINT column
 * itself, never the CHAR alias. Ordering the cast alias would sort lexically,
 * putting id 10 before id 9 and making keyset pagination skip rows.
 */
const ORDER_AND_LIMIT = `ORDER BY effective_call_time ASC, src.\`id\` ASC
   LIMIT ?`

export const SOURCE_CANDIDATE_SQL = `SELECT${SELECT_LIST}
   FROM \`${CALL_AUDIT_SOURCE_TABLE}\` src
   WHERE ${PERIOD_PREDICATE}
   ${ORDER_AND_LIMIT}`

export const SOURCE_CANDIDATE_SQL_AFTER_CURSOR = `SELECT${SELECT_LIST}
   FROM \`${CALL_AUDIT_SOURCE_TABLE}\` src
   WHERE ${PERIOD_PREDICATE}
     ${CURSOR_PREDICATE}
   ${ORDER_AND_LIMIT}`

export const SOURCE_CHANGED_CANDIDATE_SQL = `SELECT${CHANGE_SELECT_LIST}
   FROM \`${CALL_AUDIT_SOURCE_TABLE}\` src
   WHERE (
       ${SOURCE_CHANGE_TIME} > ?
       OR (${SOURCE_CHANGE_TIME} = ? AND src.\`id\` > ?)
     )
     AND ${SOURCE_CHANGE_TIME} < ?
   ORDER BY source_change_time ASC, src.\`id\` ASC
   LIMIT ?`

interface SourceCandidateRow extends RowDataPacket {
  /** Always CHAR: the SELECT casts the BIGINT so mysql2 cannot round it. */
  source_row_id: string | number
  lead_id: string | null
  transcription: string | null
  source_updated_at: Date | string | null
  call_started_at: Date | string | null
  call_ended_at: Date | string | null
  call_duration_sec: Date | string | null
  effective_call_time: Date | string | null
  company_by_kserve: string | null
  company: string | null
  data_source: string | null
  verified_source: string | null
  service_category: string | null
  call_type: string | null
  call_status: string | null
  call_end_reason: string | null
  final_call_status: string | null
  ai_call_category: string | null
  customer_engagement_level: string | null
  interest_level: string | null
  call_outcome: string | null
  lead_status: string | null
  final_lead_outcome: string | null
  calculated_qualification_status: string | null
  followup_required: string | null
  source_change_time?: Date | string | null
}

export interface ChangedCallAuditCandidate {
  candidate: InternalSourceCandidate
  cursor: SourceChangeCursor
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/**
 * Normalizes a datetime to a UTC-naive 'YYYY-MM-DD HH:MM:SS.ffffff' literal.
 *
 * Source timestamps are UTC-naive database values. mysql2 builds a Date for a
 * DATETIME using the process timezone, so formatting it back with local getters
 * is the exact inverse and returns the stored wall-clock digits unchanged.
 * Converting to a UTC ISO string instead would shift every value by the process
 * offset and silently move calls across period boundaries.
 */
function naiveDatetime(value: Date | string | null): string | null {
  if (value == null) return null
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null
    return (
      `${value.getFullYear()}-${pad(value.getMonth() + 1, 2)}-` +
      `${pad(value.getDate(), 2)} ${pad(value.getHours(), 2)}:` +
      `${pad(value.getMinutes(), 2)}:${pad(value.getSeconds(), 2)}.` +
      `${pad(value.getMilliseconds(), 3)}000`
    )
  }
  const match =
    /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?/.exec(
      value.trim(),
    )
  if (!match) return null
  return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`
}

/** MySQL TIME arrives as a string; keep it raw for the domain parser. */
function timeText(value: Date | string | null): string | null {
  if (value == null) return null
  return typeof value === 'string' ? value : null
}

function mapRow(row: SourceCandidateRow): InternalSourceCandidate {
  const sourceRowId = normalizeSourceRowId(row.source_row_id)
  if (sourceRowId === null) {
    throw new CallAuditSourceRowError(
      'Source row ID is not a canonical positive decimal within BIGINT range',
    )
  }
  // Every call must be placeable in a period. A row whose call_start_time,
  // date_time, and timestamp are all null or unparseable would persist as an
  // unreportable row, so it is rejected here instead.
  const effectiveCallTime = naiveDatetime(row.effective_call_time)
  if (effectiveCallTime === null) {
    throw new CallAuditSourceRowError(
      `Source row ${sourceRowId} has no valid effective call time`,
    )
  }
  return {
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId,
    leadId: row.lead_id,
    transcript: row.transcription,
    effectiveCallTime,
    sourceUpdatedAt: naiveDatetime(row.source_updated_at),
    callStartedAt: naiveDatetime(row.call_started_at),
    callEndedAt: naiveDatetime(row.call_ended_at),
    callDurationSec: timeText(row.call_duration_sec),
    company_by_kserve: row.company_by_kserve,
    company: row.company,
    data_source: row.data_source,
    verified_source: row.verified_source,
    service_category: row.service_category,
    call_type: row.call_type,
    call_status: row.call_status,
    call_end_reason: row.call_end_reason,
    final_call_status: row.final_call_status,
    ai_call_category: row.ai_call_category,
    customer_engagement_level: row.customer_engagement_level,
    interest_level: row.interest_level,
    call_outcome: row.call_outcome,
    lead_status: row.lead_status,
    final_lead_outcome: row.final_lead_outcome,
    calculated_qualification_status: row.calculated_qualification_status,
    followup_required: row.followup_required,
  }
}

export function createMysqlCallAuditSourceReader(pool: Pool) {
  return {
    /**
     * Reads one bounded, deterministically ordered page of source candidates.
     * Returns SERVER-INTERNAL values: the caller must not forward them to a
     * browser, report, or export.
     */
    async listCandidates(
      query: SourceCandidateQuery,
    ): Promise<InternalSourceCandidate[]> {
      const validated = validateSourceCandidateQuery(query)
      const [rows] = validated.cursor
        ? await pool.execute<SourceCandidateRow[]>(
            SOURCE_CANDIDATE_SQL_AFTER_CURSOR,
            [
              validated.periodStart,
              validated.periodEndExclusive,
              validated.cursor.effectiveCallTime,
              validated.cursor.effectiveCallTime,
              validated.cursor.sourceRowId,
              validated.batchSize,
            ],
          )
        : await pool.execute<SourceCandidateRow[]>(SOURCE_CANDIDATE_SQL, [
            validated.periodStart,
            validated.periodEndExclusive,
            validated.batchSize,
          ])
      return rows.map(mapRow)
    },

    /**
     * Reads source rows that changed after a durable scheduler checkpoint.
     * The external table remains SELECT-only; the checkpoint itself lives in
     * a Kaudit-owned table and is never returned by a browser route.
     */
    async listChangedCandidates(
      query: SourceChangeQuery,
    ): Promise<ChangedCallAuditCandidate[]> {
      const validated = validateSourceChangeQuery(query)
      const [rows] = await pool.execute<SourceCandidateRow[]>(
        SOURCE_CHANGED_CANDIDATE_SQL,
        [
          validated.changedAfter.changedAt,
          validated.changedAfter.changedAt,
          validated.changedAfter.sourceRowId,
          validated.changedBeforeExclusive,
          validated.batchSize,
        ],
      )
      return rows.map((row) => {
        const candidate = mapRow(row)
        const changedAt = naiveDatetime(row.source_change_time ?? null)
        if (!changedAt) {
          throw new CallAuditSourceRowError(
            'Source row has no valid change time',
          )
        }
        return {
          candidate,
          cursor: { changedAt, sourceRowId: candidate.sourceRowId },
        }
      })
    },
  }
}
