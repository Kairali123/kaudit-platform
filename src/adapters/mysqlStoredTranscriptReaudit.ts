import type { Pool, RowDataPacket } from 'mysql2/promise'
import { auditTranscriptEvidence } from '../reaudit/core.ts'
import type {
  ReauditAi,
  ReauditCandidate,
  ReauditItemResult,
  TranscriptSegment,
  TranscriptionResult,
} from '../reaudit/types.ts'

interface TranscriptRow extends RowDataPacket {
  transcript_id: string
  evidence_sha256: string
  provider_name: string
  model_name: string
  model_version: string
  language: string | null
  recorded_duration_ms: number | string
  speech_duration_ms: number | string
}

interface SegmentRow extends RowDataPacket {
  start_ms: number | string
  end_ms: number | string
  text: string
}

export interface StoredTranscriptEvidence {
  transcriptId: string
  evidenceSha256: string
  transcript: TranscriptionResult
}

/**
 * Loads only a transcript bound to the exact final artifact bytes.
 *
 * Customer speech never leaves the server. A transcript whose input hash no
 * longer matches the final artifact is not reused, and neither is a transcript
 * without a completed independent duration analysis.
 */
export async function loadStoredTranscriptEvidence(
  pool: Pool,
  candidate: ReauditCandidate,
): Promise<StoredTranscriptEvidence | null> {
  const [rows] = await pool.execute<TranscriptRow[]>(
    `SELECT transcript.id AS transcript_id,
            artifact.sha256 AS evidence_sha256,
            transcript.provider_name, transcript.model_name,
            transcript.model_version, transcript.language,
            media.decoded_duration_ms AS recorded_duration_ms,
            media.speech_ms AS speech_duration_ms
     FROM kaudit_call_artifact artifact
     JOIN kaudit_transcript transcript
       ON transcript.call_id = artifact.call_id
      AND transcript.call_artifact_id = artifact.id
      AND transcript.status = 'completed'
      AND transcript.input_sha256 = artifact.sha256
     JOIN kaudit_media_analysis media
       ON media.call_artifact_id = artifact.id
      AND media.status = 'completed'
     WHERE artifact.id = ? AND artifact.call_id = ?
       AND artifact.artifact_type = 'recording'
       AND artifact.is_final = 1 AND artifact.sha256 IS NOT NULL
     ORDER BY transcript.created_at DESC, transcript.id DESC,
              media.created_at DESC, media.id DESC
     LIMIT 1`,
    [candidate.artifactId, candidate.callId],
  )
  const row = rows[0]
  if (!row) return null
  if (
    candidate.baselineSha256 &&
    candidate.baselineSha256 !== row.evidence_sha256
  ) return null

  const [segmentRows] = await pool.execute<SegmentRow[]>(
    `SELECT start_ms, end_ms, text
     FROM kaudit_transcript_segment
     WHERE transcript_id = ?
     ORDER BY start_ms, end_ms, id`,
    [row.transcript_id],
  )
  const segments: TranscriptSegment[] = segmentRows.map((segment) => ({
    startMs: Number(segment.start_ms),
    endMs: Number(segment.end_ms),
    text: segment.text,
  }))
  const recordedDurationMs = Number(row.recorded_duration_ms)
  const speechDurationMs = Number(row.speech_duration_ms)
  if (
    !Number.isSafeInteger(recordedDurationMs) || recordedDurationMs <= 0 ||
    !Number.isSafeInteger(speechDurationMs) || speechDurationMs < 0
  ) return null

  return {
    transcriptId: row.transcript_id,
    evidenceSha256: row.evidence_sha256,
    transcript: {
      model: {
        provider: row.provider_name,
        name: row.model_name,
        version: row.model_version,
      },
      language: row.language || 'unknown',
      durationMs: recordedDurationMs,
      speechMs: speechDurationMs,
      text: segments.map((segment) => segment.text).join(' '),
      segments,
    },
  }
}

export async function auditStoredTranscript(options: {
  pool: Pool
  candidate: ReauditCandidate
  classifier: Pick<ReauditAi, 'classify'>
}): Promise<ReauditItemResult> {
  const stored = await loadStoredTranscriptEvidence(
    options.pool,
    options.candidate,
  )
  if (!stored) {
    return {
      callId: options.candidate.callId,
      artifactId: options.candidate.artifactId,
      outcome: 'classification_failed',
      errorCode: 'STORED_TRANSCRIPT_NOT_REUSABLE',
    }
  }
  return auditTranscriptEvidence({
    candidate: options.candidate,
    classifier: options.classifier,
    transcript: stored.transcript,
    evidenceSha256: stored.evidenceSha256,
    reusedTranscriptId: stored.transcriptId,
  })
}
