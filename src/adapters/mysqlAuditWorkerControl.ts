import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import {
  parseAuditSystem,
  parseDesiredState,
  type AuditSystem,
  type AuditWorkerControlPort,
  type AuditWorkerObservedState,
  type AuditWorkerPublicState,
  type CallAuditCheckpoint,
} from '../auditWorkers/control.ts'

interface ControlRow extends RowDataPacket {
  audit_system: string
  desired_state: string
  observed_state: string
  state_version: number | string
  last_heartbeat_at: Date | string | null
  last_progress_at: Date | string | null
  last_error_code: string | null
  processed_total: number | string
  failed_total: number | string
  checkpoint_at?: Date | string | null
  checkpoint_source_row_id?: number | string | null
  work_sequence?: number | string
}

function iso(value: Date | string | null): string | null {
  if (value == null) return null
  const parsed = value instanceof Date ? value : new Date(value)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0')
}

/** Inverse of mysql2's local DATETIME construction; no timezone conversion. */
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

function publicState(row: ControlRow): AuditWorkerPublicState {
  return {
    system: parseAuditSystem(row.audit_system),
    desiredState: parseDesiredState(row.desired_state),
    observedState: row.observed_state as AuditWorkerObservedState,
    stateVersion: Number(row.state_version),
    lastHeartbeatAt: iso(row.last_heartbeat_at),
    lastProgressAt: iso(row.last_progress_at),
    lastErrorCode: row.last_error_code,
    processedTotal: Number(row.processed_total),
    failedTotal: Number(row.failed_total),
  }
}

const PUBLIC_SELECT = `SELECT audit_system, desired_state, observed_state,
       state_version, last_heartbeat_at, last_progress_at, last_error_code,
       processed_total, failed_total
  FROM kaudit_audit_worker_control`

function safeDelta(value: number | undefined): number {
  const resolved = value ?? 0
  if (!Number.isSafeInteger(resolved) || resolved < 0) {
    throw new RangeError('worker counter delta must be a non-negative integer')
  }
  return resolved
}

export function createMysqlAuditWorkerControl(
  pool: Pool,
): AuditWorkerControlPort {
  async function readOne(system: AuditSystem): Promise<AuditWorkerPublicState> {
    const [rows] = await pool.execute<ControlRow[]>(
      `${PUBLIC_SELECT} WHERE audit_system = ?`,
      [system],
    )
    if (!rows[0]) throw new Error('audit worker control row is unavailable')
    return publicState(rows[0])
  }

  return {
    async listPublicStates() {
      const [rows] = await pool.query<ControlRow[]>(
        `${PUBLIC_SELECT} ORDER BY audit_system`,
      )
      return rows.map(publicState)
    },

    async setDesiredState(input) {
      const system = parseAuditSystem(input.system)
      const desiredState = parseDesiredState(input.desiredState)
      await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_audit_worker_control
            SET state_version = state_version +
                  IF(desired_state = ?, 0, 1),
                desired_state = ?,
                observed_state = CASE
                  WHEN ? = 'running' THEN 'running'
                  WHEN observed_state IN ('running', 'pausing')
                    THEN 'pausing'
                  ELSE 'paused'
                END,
                last_error_code = NULL
          WHERE audit_system = ?`,
        [desiredState, desiredState, desiredState, system],
      )
      return readOne(system)
    },

    async getDesiredState(system) {
      return (await readOne(parseAuditSystem(system))).desiredState
    },

    async recordObservation(input) {
      const system = parseAuditSystem(input.system)
      const processedDelta = safeDelta(input.processedDelta)
      const failedDelta = safeDelta(input.failedDelta)
      const errorCode = input.errorCode?.trim() || null
      if (errorCode && !/^[A-Z0-9_]{1,80}$/.test(errorCode)) {
        throw new RangeError('worker error code must be bounded')
      }
      await pool.execute(
        `UPDATE kaudit_audit_worker_control
            SET observed_state = ?,
                last_heartbeat_at = current_timestamp(6),
                last_progress_at = CASE
                  WHEN ? = 1 THEN current_timestamp(6)
                  ELSE last_progress_at
                END,
                last_error_code = ?,
                processed_total = processed_total + ?,
                failed_total = failed_total + ?
          WHERE audit_system = ?`,
        [
          input.observedState,
          input.progressed ? 1 : 0,
          errorCode,
          processedDelta,
          failedDelta,
          system,
        ],
      )
    },

    async getCallCheckpoint() {
      const [rows] = await pool.execute<ControlRow[]>(
        `SELECT checkpoint_at, checkpoint_source_row_id
           FROM kaudit_audit_worker_control
          WHERE audit_system = 'call'`,
      )
      const row = rows[0]
      if (!row?.checkpoint_at || row.checkpoint_source_row_id == null) {
        return null
      }
      const changedAt = naiveDatetime(row.checkpoint_at)
      if (!changedAt) return null
      return {
        changedAt,
        sourceRowId: String(row.checkpoint_source_row_id),
      }
    },

    async initializeCallCheckpoint(checkpoint) {
      await pool.execute(
        `UPDATE kaudit_audit_worker_control
            SET checkpoint_at = ?, checkpoint_source_row_id = ?
          WHERE audit_system = 'call' AND checkpoint_at IS NULL`,
        [checkpoint.changedAt, checkpoint.sourceRowId],
      )
    },

    async advanceCallCheckpoint(checkpoint) {
      await pool.execute(
        `UPDATE kaudit_audit_worker_control
            SET checkpoint_at = ?, checkpoint_source_row_id = ?,
                last_progress_at = current_timestamp(6)
          WHERE audit_system = 'call'
            AND (checkpoint_at < ? OR
                 (checkpoint_at = ? AND checkpoint_source_row_id < ?))`,
        [
          checkpoint.changedAt,
          checkpoint.sourceRowId,
          checkpoint.changedAt,
          checkpoint.changedAt,
          checkpoint.sourceRowId,
        ],
      )
    },

    async nextWorkSequence(system) {
      const parsed = parseAuditSystem(system)
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        await connection.execute(
          `UPDATE kaudit_audit_worker_control
              SET work_sequence = LAST_INSERT_ID(work_sequence + 1)
            WHERE audit_system = ?`,
          [parsed],
        )
        const [rows] = await connection.query<ControlRow[]>(
          'SELECT LAST_INSERT_ID() AS work_sequence',
        )
        await connection.commit()
        return Number(rows[0]?.work_sequence ?? 0)
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },
  }
}
