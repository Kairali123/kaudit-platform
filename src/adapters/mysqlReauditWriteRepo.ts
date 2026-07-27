import { randomUUID } from 'node:crypto'
import type {
  Pool,
  ResultSetHeader,
  RowDataPacket,
} from 'mysql2/promise'
import {
  REAUDIT_CLASSIFIER_RULESET_SHA256,
} from './openaiReaudit.ts'
import {
  REAUDIT_CLASSIFIER_RULESET_VERSION,
  REAUDIT_ENGINE_VERSION,
} from '../reaudit/core.ts'
import type {
  ReauditCandidate,
  ReauditItemResult,
} from '../reaudit/types.ts'
import type { ReauditResultRepository } from '../reaudit/worker.ts'
import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { createMysqlOutboxWriter } from './mysqlOutbox.ts'

interface CountRow extends RowDataPacket {
  n: number | string
}

interface AttemptRow extends RowDataPacket {
  audio_attempt_count: number | string
}

const MAX_ATTEMPTS = 8

function retryDelayMs(attempt: number): number {
  return Math.min(6 * 60 * 60_000, 60_000 * 2 ** Math.max(0, attempt - 1))
}

function failureStatus(outcome: ReauditItemResult['outcome']): string {
  if (outcome === 'source_missing') return 'fetch_failed'
  if (outcome === 'transcription_failed') return 'transcribe_failed'
  if (outcome === 'classification_failed') return 'classify_failed'
  return 'exhausted'
}

function failureFinding(outcome: ReauditItemResult['outcome']): string {
  if (outcome === 'source_missing') return 'SOURCE_MISSING'
  if (outcome === 'evidence_altered') return 'EVIDENCE_ALTERED'
  if (outcome === 'unsafe_url') return 'UNSAFE_SOURCE_URL'
  if (outcome === 'transcription_failed') return 'TRANSCRIPTION_FAILED'
  return 'CLASSIFICATION_FAILED'
}

export function createMysqlReauditWriteRepo(
  pool: Pool,
): ReauditResultRepository {
  return {
    async markStarted(candidate, at) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [completed] = await connection.execute<CountRow[]>(
          `SELECT
             (
               EXISTS (
                 SELECT 1 FROM kaudit_audit_run
                 WHERE call_id = ? AND status = 'completed'
               )
               OR EXISTS (
                 SELECT 1
                 FROM kaudit_call c
                 JOIN kaudit_media_analysis ma
                   ON ma.call_artifact_id = ?
                  AND ma.status = 'completed'
                  AND ma.classification_status = 'completed'
                 JOIN kaudit_transcript transcript
                   ON transcript.call_id = c.id
                  AND transcript.call_artifact_id = ?
                  AND transcript.status = 'completed'
                 WHERE c.id = ? AND c.canonical_outcome_code IS NOT NULL
               )
             ) AS n`,
          [
            candidate.callId,
            candidate.artifactId,
            candidate.artifactId,
            candidate.callId,
          ],
        )
        if (Number(completed[0]?.n || 0) > 0) {
          await connection.commit()
          return 'already_completed'
        }
        const [updated] = await connection.execute<ResultSetHeader>(
          `UPDATE kaudit_call_artifact
           SET audio_processing_status = 'processing',
               audio_attempt_count = audio_attempt_count + 1,
               audio_last_attempt_at = ?,
               audio_next_attempt_at = NULL,
               audio_last_error = NULL
           WHERE id = ? AND call_id = ? AND artifact_type = 'recording'
             AND is_final = 1 AND source_url IS NOT NULL
             AND audio_processing_status NOT IN ('completed','exhausted')`,
          [at, candidate.artifactId, candidate.callId],
        )
        await connection.commit()
        return updated.affectedRows === 1
          ? 'acquired'
          : 'already_completed'
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },

    async persist(candidate, result, at) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        const [completed] = await connection.execute<CountRow[]>(
          `SELECT COUNT(*) AS n
           FROM kaudit_audit_run
           WHERE call_id = ? AND status = 'completed'
           FOR UPDATE`,
          [candidate.callId],
        )
        if (Number(completed[0]?.n || 0) > 0) {
          await connection.commit()
          return 'already_completed'
        }

        const auditRunId = randomUUID()
        const inputManifestSha256 = canonicalJsonSha256({
          schemaVersion: '1',
          callId: candidate.callId,
          artifactId: candidate.artifactId,
          sourceEvidenceSha256:
            result.analysis?.evidenceSha256 ?? candidate.baselineSha256,
          engineVersion: REAUDIT_ENGINE_VERSION,
          classifierRulesetVersion:
            REAUDIT_CLASSIFIER_RULESET_VERSION,
          classifierRulesetSha256:
            REAUDIT_CLASSIFIER_RULESET_SHA256,
        } as unknown as JsonValue)

        if (
          result.outcome !== 'projected' ||
          !result.analysis ||
          !result.transcription ||
          !result.classification
        ) {
          const [attemptRows] =
            await connection.execute<AttemptRow[]>(
              `SELECT audio_attempt_count
               FROM kaudit_call_artifact
               WHERE id = ? FOR UPDATE`,
              [candidate.artifactId],
            )
          const attempt = Number(
            attemptRows[0]?.audio_attempt_count || 1,
          )
          const terminal =
            result.outcome === 'evidence_altered' ||
            result.outcome === 'unsafe_url' ||
            attempt >= MAX_ATTEMPTS
          const nextAttempt = terminal
            ? null
            : new Date(at.getTime() + retryDelayMs(attempt))
          await connection.execute(
            `INSERT INTO kaudit_audit_run
               (id, call_id, audit_policy_version, engine_version,
                input_manifest_sha256, status, started_at, completed_at)
             VALUES (?, ?, 'automated-v2', ?, ?, 'failed', ?, ?)`,
            [
              auditRunId,
              candidate.callId,
              REAUDIT_ENGINE_VERSION,
              inputManifestSha256,
              at,
              at,
            ],
          )
          await connection.execute(
            `INSERT INTO kaudit_audit_finding
               (id, audit_run_id, call_id, finding_code, severity, origin,
                confidence, status, confirmation_status, evidence_refs_json,
                signal_values_json, billing_relevance, explanation)
             VALUES (?, ?, ?, ?, 'high', 'rule', NULL, 'open',
                     'system_observed', ?, ?, 'blocks_close', ?)`,
            [
              randomUUID(),
              auditRunId,
              candidate.callId,
              failureFinding(result.outcome),
              canonicalJson({
                artifactId: candidate.artifactId,
                baselineSha256: candidate.baselineSha256,
              }),
              canonicalJson({
                errorCode: result.errorCode ?? 'unknown',
                attempt,
              }),
              'Automated audit could not complete; the call remains unresolved.',
            ],
          )
          await connection.execute(
            `UPDATE kaudit_call_artifact
             SET audio_processing_status = ?, audio_next_attempt_at = ?,
                 audio_last_error = ?
             WHERE id = ?`,
            [
              terminal ? 'exhausted' : failureStatus(result.outcome),
              nextAttempt,
              (result.errorCode ?? result.outcome).slice(0, 1_000),
              candidate.artifactId,
            ],
          )
          await connection.execute(
            `UPDATE kaudit_call
             SET processing_status = ?, updated_at = ?
             WHERE id = ?`,
            [
              terminal ? 'audit_failed' : 'audit_retry',
              at,
              candidate.callId,
            ],
          )
          await connection.commit()
          return terminal ? 'terminal_failure' : 'retry_scheduled'
        }

        const analysis = result.analysis
        const transcript = result.transcription
        const classification = result.classification
        const mediaAnalysisId = randomUUID()
        const transcriptId = randomUUID()
        await connection.execute(
          `INSERT INTO kaudit_audit_run
             (id, call_id, audit_policy_version, engine_version,
              input_manifest_sha256, status, started_at, completed_at)
           VALUES (?, ?, 'automated-v2', ?, ?, 'completed', ?, ?)`,
          [
            auditRunId,
            candidate.callId,
            REAUDIT_ENGINE_VERSION,
            inputManifestSha256,
            at,
            at,
          ],
        )
        await connection.execute(
          `INSERT INTO kaudit_media_analysis
             (id, call_artifact_id, input_sha256, analyzer_name,
              analyzer_version, config_version, status, decoded_duration_ms,
              speech_ms, customer_speech_ms, agent_speech_ms,
              conversation_end_ms, classification_status, metrics_json)
           VALUES (?, ?, ?, 'kairali-independent-reaudit', ?, '2',
                   'completed', ?, ?, ?, ?, ?, 'completed', ?)`,
          [
            mediaAnalysisId,
            candidate.artifactId,
            analysis.evidenceSha256,
            REAUDIT_ENGINE_VERSION,
            analysis.recordedDurationMs,
            analysis.speechDurationMs,
            analysis.customerSpeechMs,
            analysis.agentSpeechMs,
            analysis.lastMeaningfulCustomerExchangeMs,
            canonicalJson({
              durationMismatch: analysis.durationMismatch,
              disputeRecommended: analysis.disputeRecommended,
              classifierRulesetVersion:
                REAUDIT_CLASSIFIER_RULESET_VERSION,
              classifierRulesetSha256:
                REAUDIT_CLASSIFIER_RULESET_SHA256,
            }),
          ],
        )
        await connection.execute(
          `INSERT INTO kaudit_transcript
             (id, call_id, call_artifact_id, source_type, provider_name,
              model_name, model_version, language, status, input_sha256)
           VALUES (?, ?, ?, 'independent_asr', ?, ?, ?, ?, 'completed', ?)`,
          [
            transcriptId,
            candidate.callId,
            candidate.artifactId,
            transcript.model.provider,
            transcript.model.name,
            transcript.model.version,
            transcript.language,
            analysis.evidenceSha256,
          ],
        )
        for (const segment of transcript.segments) {
          await connection.execute(
            `INSERT INTO kaudit_transcript_segment
               (id, transcript_id, start_ms, end_ms, text, language,
                is_redacted)
             VALUES (?, ?, ?, ?, ?, ?, 0)`,
            [
              randomUUID(),
              transcriptId,
              segment.startMs,
              segment.endMs,
              segment.text,
              transcript.language,
            ],
          )
        }
        await connection.execute(
          `INSERT INTO kaudit_audit_finding
             (id, audit_run_id, call_id, finding_code, severity, origin,
              confidence, status, confirmation_status, root_cause_status,
              evidence_refs_json, signal_values_json, billing_relevance,
              explanation)
           VALUES (?, ?, ?, ?, 'medium', 'model', ?, 'open',
                   'model_output', 'unknown', ?, ?, 'duration_input', ?)`,
          [
            randomUUID(),
            auditRunId,
            candidate.callId,
            analysis.category,
            analysis.confidence,
            canonicalJson({
              artifactId: candidate.artifactId,
              audioSha256: analysis.evidenceSha256,
              transcriptId,
              mediaAnalysisId,
            }),
            canonicalJson({
              model: classification.model,
              rulesetVersion: REAUDIT_CLASSIFIER_RULESET_VERSION,
              rulesetSha256: REAUDIT_CLASSIFIER_RULESET_SHA256,
              recordedDurationMs: analysis.recordedDurationMs,
              speechDurationMs: analysis.speechDurationMs,
              conversationEndMs:
                analysis.lastMeaningfulCustomerExchangeMs,
              durationMismatch: analysis.durationMismatch,
              disputeRecommended: analysis.disputeRecommended,
            }),
            analysis.remarks,
          ],
        )
        await connection.execute(
          `UPDATE kaudit_call_artifact
           SET sha256 = COALESCE(sha256, ?), last_verified_at = ?,
               fetch_status = 'fetched', fetch_error = NULL,
               audio_processing_status = 'completed',
               audio_next_attempt_at = NULL, audio_last_error = NULL
           WHERE id = ?`,
          [analysis.evidenceSha256, at, candidate.artifactId],
        )
        await connection.execute(
          `UPDATE kaudit_call
           SET processing_status = 'audited',
               canonical_outcome_code = ?,
               outcome_taxonomy_version = ?,
               latest_audit_run_id = ?,
               updated_at = ?
           WHERE id = ?`,
          [
            analysis.category,
            REAUDIT_CLASSIFIER_RULESET_VERSION,
            auditRunId,
            at,
            candidate.callId,
          ],
        )
        const outbox = createMysqlOutboxWriter(connection)
        await outbox.enqueue({
          messageId: `audit-completed:${inputManifestSha256}`,
          aggregateType: 'call',
          aggregateId: candidate.callId,
          eventType: 'call.audit_completed',
          correlationId: null,
          payload: {
            callId: candidate.callId,
            auditRunId,
            artifactId: candidate.artifactId,
            inputManifestSha256,
            evidenceSha256: analysis.evidenceSha256,
            category: analysis.category,
            confidence: analysis.confidence,
            engineVersion: REAUDIT_ENGINE_VERSION,
          },
        })
        await connection.commit()
        return 'completed'
      } catch (error) {
        await connection.rollback()
        throw error
      } finally {
        connection.release()
      }
    },
  }
}
