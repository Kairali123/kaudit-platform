import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise'
import {
  KserveSettlementConflictError,
  MAX_SETTLEMENT_HISTORY,
  asSafeSettlementError,
  readStoredDecimal,
  validateRecordSettlementRequest,
  type RecordSettlementRequest,
  type ValidatedSettlementRequest,
} from '../billing/kserveSettlement.ts'

/**
 * MySQL persistence for `kaudit_kserve_monthly_settlement` (migration 0013) —
 * the append-only record of what Kairali actually paid KServe for a bill month,
 * and NOTHING else.
 *
 * Scope: persistence only. No HTTP, no DTO, no worker, no model call, no
 * reporting, and no Call Audit. The only table named in any statement below is
 * the settlement table itself.
 *
 * Contracts:
 *
 *   * APPEND-ONLY, structurally. There is no UPDATE statement and no DELETE
 *     statement in this module, not even for the row a correction supersedes.
 *     A correction is a new version whose `supersedes_settlement_id` names its
 *     predecessor; the predecessor's bytes are never touched again.
 *   * The CURRENT version is derived — the highest `version_no` for the month —
 *     so nothing has to be written back to make a row "not current".
 *   * A retry with the same key and the same payload REPLAYS the stored
 *     version. The same key with a DIFFERENT amount is a typed conflict, never
 *     a second version and never a silent overwrite.
 *   * Concurrency is settled by the database, not by a read: two administrators
 *     saving the same month at once both compute the same next version, and
 *     `uq_kserve_settlement_month_version` lets exactly one of them commit. The
 *     loser is told to re-read and try again; it never lands a duplicate.
 *   * Only settlement rows are ever locked, and only rows of the ONE month
 *     being written. No `FOR UPDATE` in this module touches any other table.
 *
 * Source-table safety: `ai_voice_leads_received` is external and READ-ONLY.
 * Nothing here selects, writes, locks, or foreign-keys it.
 *
 * Privacy and failure: every path exits through `asSafeSettlementError`, so a
 * driver message, a constraint name, a stored amount, or an unknown thrown
 * value can never leave this module. Callers see a typed input error, a typed
 * conflict, or one bounded "unavailable".
 */

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------

/**
 * One version, as a reader may see it.
 *
 * Deliberately absent: the row id, the superseded id, the idempotency key, the
 * request digest, the actor, and the correlation id. None of them is a business
 * fact about the payment, and every one of them is something an API response
 * must not carry.
 */
export interface KserveSettlementVersion {
  versionNo: number
  finalPaidAmountInr: string
  currency: string
  recordedAt: string
  /** True for the highest version of the month, false for a superseded one. */
  isCurrent: boolean
}

export interface KserveSettlementHistory {
  /** Newest first. Never longer than the requested, bounded limit. */
  versions: KserveSettlementVersion[]
  /** True when older versions exist beyond the returned window. */
  truncated: boolean
}

export interface RecordSettlementResult {
  versionNo: number
  finalPaidAmountInr: string
  currency: string
  recordedAt: string
  /** `replayed` means an identical retry matched the stored version. */
  outcome: 'recorded' | 'replayed'
}

export interface KserveSettlementRepository {
  /** The newest `limit` versions of one month, newest first. */
  readHistory(
    billMonth: string,
    limit: number,
  ): Promise<KserveSettlementHistory>
  recordSettlement(
    request: RecordSettlementRequest,
  ): Promise<RecordSettlementResult>
}

// ---------------------------------------------------------------------------
// Statements. Parameterized throughout; no value is ever interpolated.
// ---------------------------------------------------------------------------

const TABLE = '`kaudit_kserve_monthly_settlement`'

/**
 * DECIMAL and DATETIME(6) are read as CHAR so the driver cannot hand back a
 * JavaScript number for money or a `Date` for a UTC-naive stamp. The text that
 * was stored is the text that comes back.
 */
const VERSION_PROJECTION = `\`version_no\`,
       CAST(\`final_paid_amount\` AS CHAR) AS \`final_paid_amount\`,
       \`currency\`,
       CAST(\`recorded_at\` AS CHAR) AS \`recorded_at\``

/**
 * One bounded page of history, newest first.
 *
 * The caller asks for `limit + 1` rows and reports the extra one as truncation
 * rather than running a second COUNT over the month, so a page costs exactly
 * one indexed backward scan of `uq_kserve_settlement_month_version`.
 */
const SELECT_HISTORY_SQL = `SELECT ${VERSION_PROJECTION}
   FROM ${TABLE}
   WHERE \`bill_month\` = ?
   ORDER BY \`version_no\` DESC
   LIMIT ?`

/**
 * The row a retry would replay, locked.
 *
 * Read through `uq_kserve_settlement_month_key`, so the lock covers exactly one
 * unique index entry of one month. On a first attempt it matches nothing and
 * InnoDB holds only the gap for that key, which is precisely the window that
 * must not admit a second insert of the same key.
 */
const SELECT_BY_KEY_FOR_UPDATE_SQL = `SELECT ${VERSION_PROJECTION},
       \`request_digest\`
   FROM ${TABLE}
   WHERE \`bill_month\` = ? AND \`idempotency_key\` = ?
   FOR UPDATE`

/**
 * The month's current tail, locked: the row a new version will supersede.
 *
 * LIMIT 1 is enough because the unique key on (bill_month, version_no) is what
 * actually settles a race — a concurrent writer that read the same tail loses
 * its INSERT on that key rather than on this lock.
 */
const SELECT_CURRENT_FOR_UPDATE_SQL = `SELECT \`id\`, \`version_no\`
   FROM ${TABLE}
   WHERE \`bill_month\` = ?
   ORDER BY \`version_no\` DESC
   LIMIT 1
   FOR UPDATE`

const INSERT_COLUMNS = [
  'id',
  'bill_month',
  'period_start',
  'period_end',
  'currency',
  'final_paid_amount',
  'version_no',
  'supersedes_settlement_id',
  'idempotency_key',
  'request_digest',
  'recorded_by_user_id',
  'correlation_id',
  'recorded_at',
] as const

const INSERT_SETTLEMENT_SQL = `INSERT INTO ${TABLE}
     (${INSERT_COLUMNS.map((column) => `\`${column}\``).join(', ')})
   VALUES (${INSERT_COLUMNS.map(() => '?').join(', ')})`

interface VersionRow extends RowDataPacket {
  version_no: number | string
  final_paid_amount: string | null
  currency: string
  recorded_at: string | null
  request_digest?: string
}

interface CurrentRow extends RowDataPacket {
  id: string
  version_no: number | string
}

/** MySQL duplicate-key error, raised when a concurrent writer won the race. */
const DUPLICATE_ENTRY = 'ER_DUP_ENTRY'

function isDuplicateEntry(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { code?: string }).code === DUPLICATE_ENTRY
  )
}

/**
 * MySQL renders DATETIME(6) with six fractional digits. It is returned exactly
 * as stored — a UTC-naive instant, never re-zoned — because moving it to a
 * local clock could shift a settlement onto a different calendar day.
 */
const NAIVE_DATETIME =
  /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?/

export function readSettlementTimestamp(value: unknown): string {
  const match = NAIVE_DATETIME.exec(String(value ?? '').trim())
  if (!match) {
    // Unreadable provenance is a storage failure, not something to display.
    throw new Error('settlement timestamp is unreadable')
  }
  return `${match[1]} ${match[2]}.${(match[3] ?? '').padEnd(6, '0')}`
}

/**
 * Copies the database row field by field. Never a spread: a column added to a
 * statement later must be reviewed here before it can reach an API.
 */
export function toSettlementVersion(
  row: VersionRow,
  isCurrent: boolean,
): KserveSettlementVersion {
  const amount = readStoredDecimal(row.final_paid_amount, 'finalPaidAmountInr')
  if (amount == null) {
    throw new Error('settlement amount is missing')
  }
  return {
    versionNo: Number(row.version_no),
    finalPaidAmountInr: amount,
    currency: String(row.currency),
    recordedAt: readSettlementTimestamp(row.recorded_at),
    isCurrent,
  }
}

/** UTC-naive `YYYY-MM-DD HH:MM:SS.ffffff`, matching the datetime(6) column. */
export function settlementTimestampOf(now: Date): string {
  return now.toISOString().replace('T', ' ').replace('Z', '000')
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export function createMysqlKserveSettlementRepository(
  pool: Pool,
  clock: () => Date = () => new Date(),
): KserveSettlementRepository {
  /**
   * Runs one save inside a transaction, replaying or inserting. A duplicate-key
   * error is allowed to escape so the caller can settle a lost race after the
   * connection is released.
   */
  async function write(
    request: ValidatedSettlementRequest,
  ): Promise<RecordSettlementResult> {
    const connection: PoolConnection = await pool.getConnection()
    try {
      await connection.beginTransaction()
      const [existing] = await connection.execute<VersionRow[]>(
        SELECT_BY_KEY_FOR_UPDATE_SQL,
        [request.billMonth, request.idempotencyKey],
      )
      const replay = existing[0]
      if (replay) {
        // Never an UPDATE: a recorded settlement is final. The only acceptable
        // outcome is proving the stored row IS this payload.
        if (replay.request_digest !== request.requestDigest) {
          throw new KserveSettlementConflictError(
            'idempotencyKey',
            'has already recorded a different amount for this month; ' +
              'a correction needs its own save',
          )
        }
        await connection.rollback()
        const version = toSettlementVersion(replay, false)
        return {
          versionNo: version.versionNo,
          finalPaidAmountInr: version.finalPaidAmountInr,
          currency: version.currency,
          recordedAt: version.recordedAt,
          outcome: 'replayed',
        }
      }

      const [currentRows] = await connection.execute<CurrentRow[]>(
        SELECT_CURRENT_FOR_UPDATE_SQL,
        [request.billMonth],
      )
      const current = currentRows[0]
      const versionNo = current ? Number(current.version_no) + 1 : 1
      const supersedes = current ? String(current.id) : null
      const recordedAt = settlementTimestampOf(clock())

      await connection.execute(INSERT_SETTLEMENT_SQL, [
        request.settlementId,
        request.billMonth,
        request.periodStart,
        request.periodEnd,
        request.currency,
        request.finalPaidAmountInr,
        versionNo,
        supersedes,
        request.idempotencyKey,
        request.requestDigest,
        request.recordedByUserId,
        request.correlationId,
        recordedAt,
      ])
      await connection.commit()
      return {
        versionNo,
        finalPaidAmountInr: request.finalPaidAmountInr,
        currency: request.currency,
        recordedAt,
        outcome: 'recorded',
      }
    } catch (error) {
      await connection.rollback()
      throw error
    } finally {
      connection.release()
    }
  }

  return {
    async readHistory(billMonth, limit) {
      try {
        const bounded = Math.min(
          Math.max(Math.trunc(limit) || 1, 1),
          MAX_SETTLEMENT_HISTORY,
        )
        const [rows] = await pool.execute<VersionRow[]>(SELECT_HISTORY_SQL, [
          billMonth,
          // One extra row answers "is there more" without a second query.
          bounded + 1,
        ])
        const window = rows.slice(0, bounded)
        return {
          // The first row is the highest version for the month, which IS the
          // current settlement. Currency, status and order all come from the
          // one indexed scan; nothing is recomputed per row.
          versions: window.map((row, index) =>
            toSettlementVersion(row, index === 0),
          ),
          truncated: rows.length > bounded,
        }
      } catch (error) {
        throw asSafeSettlementError(error)
      }
    },

    async recordSettlement(request) {
      const validated = validateRecordSettlementRequest(request)
      try {
        return await write(validated)
      } catch (error) {
        if (isDuplicateEntry(error)) {
          // A concurrent administrator committed the version this attempt was
          // building. Nothing was written twice; the caller re-reads and, if
          // the correction is still wanted, saves again against the new tail.
          throw new KserveSettlementConflictError(
            'month',
            'another settlement version for this month was recorded at the ' +
              'same time; re-read the current version and save again',
          )
        }
        throw asSafeSettlementError(error)
      }
    },
  }
}
