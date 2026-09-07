import type { Pool, RowDataPacket, ResultSetHeader } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import type { RawBillingMetrics } from '../ui/fullDashboard.ts'

/**
 * A cache of one month's billing aggregates.
 *
 * A closed bill month never changes, and the page was recomputing it on every
 * load: five aggregates each walking every call in the month. June's 39,094
 * calls put that at 15-30s against a 30s request limit.
 *
 * Three rules keep a cache from becoming a way to show a wrong number.
 *
 * A month that has not ended is never served from here. It is still receiving
 * calls and audits, so any stored answer about it is a guess about the past.
 *
 * A missing row always means "compute it". Every failure in this module --
 * absent table, unreadable JSON, write refused -- degrades to a live read, so
 * the worst outcome of a bug here is the slowness we already had, never a
 * figure that disagrees with the ledger.
 *
 * And the summary is stamped with the build that computed it. When the
 * definition of an aggregate changes, rows computed by the old definition are
 * not served: a cache that outlives the meaning of its own contents is worse
 * than no cache, because it is confidently wrong instead of merely old.
 */

/**
 * Bump when the MEANING of any cached aggregate changes -- a different basis
 * counted, a different join, a corrected total. Not for unrelated edits.
 */
export const BILLING_SUMMARY_DEFINITION = 'billing-month-summary/1.0.0'

const TABLE = '`kaudit_billing_month_summary`'

export interface CachedBillingSummary {
  metrics: RawBillingMetrics
  computedAt: string
}

export interface BillingMonthSummaryStore {
  read(period: BillingMonthScope): Promise<CachedBillingSummary | null>
  write(
    period: BillingMonthScope,
    metrics: RawBillingMetrics,
  ): Promise<boolean>
  invalidate(month: string): Promise<void>
}

/**
 * Has the month finished?
 *
 * Compared as calendar dates in UTC. A month is servable from cache only once
 * its last day is behind us, so "today's month" always reads live.
 */
export function monthHasEnded(
  period: BillingMonthScope,
  now: Date = new Date(),
): boolean {
  const today = now.toISOString().slice(0, 10)
  return period.end < today
}

export function summaryDigest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

interface SummaryRow extends RowDataPacket {
  payload_json: string | null
  payload_sha256: string | null
  computed_at: string | Date | null
  source_engine_version: string | null
}

function instant(value: string | Date | null): string | null {
  if (value == null) return null
  return value instanceof Date ? value.toISOString() : String(value)
}

export function createMysqlBillingMonthSummaryStore(
  pool: Pool,
): BillingMonthSummaryStore {
  return {
    async read(period) {
      if (!monthHasEnded(period)) return null
      try {
        const [rows] = await pool.query<SummaryRow[]>(
          `SELECT payload_json, payload_sha256, source_engine_version,
                  CAST(computed_at AS CHAR) AS computed_at
             FROM ${TABLE}
            WHERE bill_month = ?`,
          [period.month],
        )
        const row = rows[0]
        if (!row?.payload_json) return null
        if (row.source_engine_version !== BILLING_SUMMARY_DEFINITION) {
          return null
        }
        /**
         * The digest is verified, not trusted. A row that does not match its
         * own hash has been altered by something that did not go through this
         * module, and the honest response to that is to ignore it and
         * recompute rather than to render it.
         */
        if (summaryDigest(row.payload_json) !== row.payload_sha256) return null
        const computedAt = instant(row.computed_at)
        if (!computedAt) return null
        return {
          metrics: JSON.parse(row.payload_json) as RawBillingMetrics,
          computedAt,
        }
      } catch {
        // Absent table, malformed JSON, unreadable row: compute it live.
        return null
      }
    },

    async write(period, metrics) {
      if (!monthHasEnded(period)) return false
      try {
        const payload = JSON.stringify(metrics)
        await pool.query<ResultSetHeader>(
          `INSERT INTO ${TABLE}
             (bill_month, period_start, period_end, payload_json,
              payload_sha256, source_engine_version, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE
             period_start = VALUES(period_start),
             period_end = VALUES(period_end),
             payload_json = VALUES(payload_json),
             payload_sha256 = VALUES(payload_sha256),
             source_engine_version = VALUES(source_engine_version),
             computed_at = VALUES(computed_at)`,
          [
            period.month,
            period.start,
            period.end,
            payload,
            summaryDigest(payload),
            BILLING_SUMMARY_DEFINITION,
          ],
        )
        return true
      } catch {
        // A cache that cannot be written is a slow page, not a broken one.
        return false
      }
    },

    async invalidate(month) {
      try {
        await pool.query(`DELETE FROM ${TABLE} WHERE bill_month = ?`, [month])
      } catch {
        /**
         * Swallowed on purpose, and this is the one swallow that needs
         * justifying. A failed DELETE leaves a stale summary, so it must never
         * be the last line of defence -- it is not. The definition stamp and
         * the ended-month rule bound what can be served, and every writer
         * calls this after its own work has already committed. Letting a
         * cache-eviction failure roll back a settled month would be the worse
         * trade by far.
         */
      }
    },
  }
}
