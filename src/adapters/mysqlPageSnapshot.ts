import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'

/**
 * Stored results of heavy page aggregates (`kaudit_page_snapshot`, 0022).
 *
 * A cache, never evidence: every failure here degrades to "no snapshot" and the
 * caller computes live, so a missing table or an unreadable row is a slower
 * page, not a broken one.
 */
export interface PageSnapshot {
  payload: unknown
  computedAt: string
  refreshing: boolean
}

export interface PageSnapshotStore {
  /** The stored result for `definition`, or null when there is none usable. */
  read(key: string, definition: string): Promise<PageSnapshot | null>
  /** True when this caller won the right to recompute `key`. */
  claimRefresh(key: string, leaseSeconds: number): Promise<boolean>
  /** Stores a result and ends the claim. */
  write(key: string, definition: string, payload: unknown): Promise<void>
  /** Ends a claim without storing, e.g. after a failed recompute. */
  release(key: string): Promise<void>
}

const TABLE = '`kaudit_page_snapshot`'

interface SnapshotRow extends RowDataPacket {
  payload_json: string | null
  payload_sha256: string | null
  definition: string | null
  computed_at: string | Date | null
  refreshing: number | string
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

function isoInstant(value: string | Date | null): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  // MySQL returns a UTC-naive 'YYYY-MM-DD HH:MM:SS.ffffff'.
  const text = String(value).trim().replace(' ', 'T')
  const parsed = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`)
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString()
}

export function createMysqlPageSnapshotStore(pool: Pool): PageSnapshotStore {
  return {
    async read(key, definition) {
      try {
        const [rows] = await pool.query<SnapshotRow[]>(
          `SELECT payload_json, payload_sha256, definition,
                  CAST(computed_at AS CHAR) AS computed_at,
                  refresh_started_at IS NOT NULL
                    AND refresh_started_at > UTC_TIMESTAMP(6) - INTERVAL 300 SECOND
                    AS refreshing
             FROM ${TABLE}
            WHERE snapshot_key = ?`,
          [key],
        )
        const row = rows[0]
        if (!row?.payload_json || row.definition !== definition) return null
        // Verified, not trusted: a row altered outside this module is ignored.
        if (sha256(row.payload_json) !== row.payload_sha256) return null
        const computedAt = isoInstant(row.computed_at)
        if (!computedAt) return null
        return {
          payload: JSON.parse(row.payload_json),
          computedAt,
          refreshing: Number(row.refreshing) === 1,
        }
      } catch {
        return null
      }
    },

    async claimRefresh(key, leaseSeconds) {
      try {
        await pool.query(
          `INSERT IGNORE INTO ${TABLE} (snapshot_key) VALUES (?)`,
          [key],
        )
        // One refresh per key at a time; an abandoned claim expires.
        const [result] = await pool.query<ResultSetHeader>(
          `UPDATE ${TABLE}
              SET refresh_started_at = UTC_TIMESTAMP(6)
            WHERE snapshot_key = ?
              AND (refresh_started_at IS NULL
                   OR refresh_started_at <= UTC_TIMESTAMP(6) - INTERVAL ? SECOND)`,
          [key, leaseSeconds],
        )
        return result.affectedRows === 1
      } catch {
        // Without the table there is nothing to coordinate: compute.
        return true
      }
    },

    async write(key, definition, payload) {
      try {
        const json = JSON.stringify(payload)
        await pool.query(
          `UPDATE ${TABLE}
              SET payload_json = ?, payload_sha256 = ?, definition = ?,
                  computed_at = UTC_TIMESTAMP(6), refresh_started_at = NULL
            WHERE snapshot_key = ?`,
          [json, sha256(json), definition, key],
        )
      } catch {
        // A snapshot that cannot be stored is recomputed next time.
      }
    },

    async release(key) {
      try {
        await pool.query(
          `UPDATE ${TABLE} SET refresh_started_at = NULL WHERE snapshot_key = ?`,
          [key],
        )
      } catch {
        // The claim expires on its own.
      }
    },
  }
}
