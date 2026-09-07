import type { Pool, RowDataPacket } from 'mysql2/promise'
import { createHash } from 'node:crypto'
import type {
  TranscriptCachePort,
  TranscriptCacheKey,
} from '../reaudit/types.ts'
import type { TranscriptionResult } from '../reaudit/types.ts'

/**
 * A short-lived cache of audio already transcribed.
 *
 * Transcription is 93% of what an audit costs, and a classification failure
 * used to discard the transcript entirely -- the failure path writes only a
 * failed audit run -- so every retry paid Whisper again for identical bytes.
 *
 * The key is a hash of the audio itself, so only byte-identical audio can
 * reuse a transcript. That is the same hash the audit already computes to
 * detect altered evidence, which means a recording that changed cannot be
 * matched to the transcript of the recording it replaced.
 *
 * Rows expire. They hold customer speech, and this exists to avoid paying
 * twice within a retry window, not to become a second transcript store.
 */

/**
 * Long enough to cover the retry schedule with room to spare, short enough
 * that transcripts are not accumulating here.
 */
export const TRANSCRIPTION_CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000

const TABLE = '`kaudit_transcription_cache`'

interface CacheRow extends RowDataPacket {
  payload_json: string | null
  payload_sha256: string | null
  provider_name: string | null
  model_name: string | null
  model_version: string | null
}

function digest(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex')
}

/**
 * What is stored is deliberately NOT the whole result.
 *
 * `usage` is dropped, because a reused transcript spent nothing. Replaying a
 * usage record would invent provider spend that never happened and quietly
 * corrupt the cost figures this cache exists to reduce.
 */
export function cacheablePayload(
  transcript: TranscriptionResult,
): Omit<TranscriptionResult, 'usage'> {
  const { usage: _discarded, ...rest } = transcript
  return rest
}

export function createMysqlTranscriptionCache(
  pool: Pool,
  ttlMs: number = TRANSCRIPTION_CACHE_TTL_MS,
): TranscriptCachePort {
  return {
    async read(key: TranscriptCacheKey) {
      try {
        const [rows] = await pool.query<CacheRow[]>(
          `SELECT payload_json, payload_sha256, provider_name,
                  model_name, model_version
             FROM ${TABLE}
            WHERE input_sha256 = ?
              AND expires_at > UTC_TIMESTAMP(6)`,
          [key.evidenceSha256],
        )
        const row = rows[0]
        if (!row?.payload_json) return null
        /**
         * A payload produced by a different model is not reused. Otherwise
         * changing the transcription model would silently keep serving the old
         * one's output, and the evidence would name a model that did not
         * produce the words.
         */
        if (
          row.provider_name !== key.provider ||
          row.model_name !== key.modelName ||
          row.model_version !== key.modelVersion
        ) {
          return null
        }
        // Verified, not trusted: a row that fails its own digest was altered
        // by something outside this path and is discarded rather than replayed
        // into an audit.
        if (digest(row.payload_json) !== row.payload_sha256) return null
        return JSON.parse(row.payload_json) as TranscriptionResult
      } catch {
        // A cache that cannot be read costs a transcription, not an audit.
        return null
      }
    },

    async write(key: TranscriptCacheKey, transcript: TranscriptionResult) {
      try {
        const payload = JSON.stringify(cacheablePayload(transcript))
        await pool.query(
          `INSERT INTO ${TABLE}
             (input_sha256, call_artifact_id, provider_name, model_name,
              model_version, payload_json, payload_sha256, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?,
                   DATE_ADD(UTC_TIMESTAMP(6), INTERVAL ? MICROSECOND))
           ON DUPLICATE KEY UPDATE
             payload_json = VALUES(payload_json),
             payload_sha256 = VALUES(payload_sha256),
             expires_at = VALUES(expires_at)`,
          [
            key.evidenceSha256,
            key.artifactId,
            key.provider,
            key.modelName,
            key.modelVersion,
            payload,
            digest(payload),
            ttlMs * 1000,
          ],
        )
      } catch {
        // Failing to cache costs money next time; failing the audit costs the
        // audit. Never trade the second for the first.
      }
    },

    async purgeExpired() {
      try {
        const [result] = await pool.query(
          `DELETE FROM ${TABLE} WHERE expires_at <= UTC_TIMESTAMP(6)`,
        )
        return Number((result as { affectedRows?: number }).affectedRows ?? 0)
      } catch {
        return 0
      }
    },
  }
}
