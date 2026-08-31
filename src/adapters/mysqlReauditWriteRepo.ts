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
import {
  ManualReauditError,
  manualReauditBaselineDecision,
  manualReauditOutboxMessageId,
} from '../reaudit/manualRequests.ts'
import {
  manualReauditLatestAuditRunId,
  settleManualReauditItem,
} from './mysqlManualReauditQueue.ts'
import type { ReauditResultRepository } from '../reaudit/worker.ts'
import {
  canonicalJson,
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { createMysqlOutboxWriter } from './mysqlOutbox.ts'
import { insertAiUsageEvent } from './mysqlAiUsage.ts'
import {
  CATEGORY_CHARGE_POLICY_SHA256,
  CATEGORY_CHARGE_POLICY_VERSION,
} from '../billing/categoryChargePolicy.ts'

interface CountRow extends RowDataPacket {
  n: number | string
}

interface AttemptRow extends RowDataPacket {
  audio_attempt_count: number | string
}

interface ManualItemStateRow extends RowDataPacket {
  status: 'queued' | 'processing' | 'completed' | 'skipped' | 'failed'
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
  if (outcome === 'spend_state_unknown') return 'SPEND_STATE_UNKNOWN'
  return 'CLASSIFICATION_FAILED'
}

/**
 * The queue item behind an administrator-requested re-audit.
 *
 * Reading it through one accessor keeps the manual paths below from ever
 * assuming a candidate carries queue provenance: a manual writer handed an
 * ordinary candidate is a wiring bug, and is refused rather than allowed to
 * spend on a call nothing will settle.
 */
function manualRequestOf(
  candidate: ReauditCandidate,
): NonNullable<ReauditCandidate['manualRequest']> {
  const request = candidate.manualRequest
  if (!request) {
    throw new ManualReauditError(
      'REAUDIT_ITEM_UNCLAIMED',
      500,
      'Requested re-audit writer received an unclaimed candidate',
    )
  }
  return request
}

export function createMysqlReauditWriteRepo(
  pool: Pool,
  options: {
    allowCompletedReaudit?: boolean
    /**
     * Administrator-requested mode. The call's CURRENT audit run — captured as
     * a baseline when the row was selected — decides whether to spend, in place
     * of the ruleset comparison targeted mode uses. That is deliberate: a
     * manual re-audit exists because the prior AI output may be wrong, so the
     * SAME ruleset must still be allowed to run again.
     */
    manualRequest?: boolean
  } = {},
): ReauditResultRepository {
  const manualRequest = options.manualRequest === true
  const allowCompletedReaudit =
    options.allowCompletedReaudit === true || manualRequest
  return {
    async markStarted(candidate, at) {
      const connection = await pool.getConnection()
      try {
        await connection.beginTransaction()
        if (manualRequest) {
          const request = manualRequestOf(candidate)
          const decision = manualReauditBaselineDecision({
            baselineAuditRunId: request.baselineAuditRunId,
            latestAuditRunId: await manualReauditLatestAuditRunId(
              connection,
              candidate.callId,
            ),
          })
          const [itemRows] = await connection.execute<ManualItemStateRow[]>(
            `SELECT status
             FROM kaudit_billing_reaudit_item
             WHERE id = ? AND request_id = ? AND call_id = ?
             FOR UPDATE`,
            [request.itemId, request.requestId, candidate.callId],
          )
          const item = itemRows[0]
          if (!item || !['queued', 'processing'].includes(item.status)) {
            await connection.commit()
            return 'already_completed'
          }
          if (item.status === 'queued') {
            const [claimed] = await connection.execute<ResultSetHeader>(
              `UPDATE kaudit_billing_reaudit_item
               SET status = 'processing',
                   attempt_count = attempt_count + 1,
                   started_at = ?, last_error_code = NULL
               WHERE id = ? AND status = 'queued' AND attempt_count < 1`,
              [at, request.itemId],
            )
            if (claimed.affectedRows !== 1) {
              await connection.commit()
              return 'already_completed'
            }
            await connection.execute(
              `UPDATE kaudit_billing_reaudit_request
               SET status = 'running',
                   started_at = COALESCE(started_at, ?)
               WHERE id = ? AND status = 'queued'`,
              [at, request.requestId],
            )
          }
          if (decision === 'skip_baseline_changed') {
            await settleManualReauditItem(connection, {
              requestId: request.requestId,
              itemId: request.itemId,
              outcome: 'skipped',
              at,
            })
            await connection.commit()
            return 'already_completed'
          }
          // A queued item is now claimed; a processing item is a spend-guard
          // recovery. Neither path mutates the call before final persistence.
          await connection.commit()
          return 'acquired'
        }
        const [completed] = await connection.execute<CountRow[]>(
          allowCompletedReaudit
            ? `SELECT EXISTS (
                 SELECT 1
                 FROM kaudit_call c
                 JOIN kaudit_audit_run latest
                   ON latest.id = c.latest_audit_run_id
                  AND latest.status = 'completed'
                 WHERE c.id = ?
                   AND c.outcome_taxonomy_version = ?
               ) AS n`
            : `SELECT
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
          allowCompletedReaudit
            ? [candidate.callId, REAUDIT_CLASSIFIER_RULESET_VERSION]
            : [
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
        if (allowCompletedReaudit) {
          await connection.commit()
          return 'acquired'
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
        if (manualRequest) {
          // Re-read under the row lock the whole write then holds. Between the
          // claim and here, another worker may have advanced this call; that
          // result stays current and this attempt is discarded rather than
          // overwriting a newer answer with an older question's one.
          const request = manualRequestOf(candidate)
          const latestAuditRunId = await manualReauditLatestAuditRunId(
            connection,
            candidate.callId,
          )
          const [itemRows] = await connection.execute<ManualItemStateRow[]>(
            `SELECT status
             FROM kaudit_billing_reaudit_item
             WHERE id = ? AND request_id = ? AND call_id = ?
             FOR UPDATE`,
            [request.itemId, request.requestId, candidate.callId],
          )
          if (itemRows[0]?.status !== 'processing') {
            await connection.commit()
            return 'already_completed'
          }
          const decision = manualReauditBaselineDecision({
            baselineAuditRunId: request.baselineAuditRunId,
            latestAuditRunId,
          })
          if (decision === 'skip_baseline_changed') {
            await settleManualReauditItem(connection, {
              requestId: request.requestId,
              itemId: request.itemId,
              outcome: 'skipped',
              at,
            })
            await connection.commit()
            return 'already_completed'
          }
        }
        // Skipped entirely in manual mode: the baseline above already decided
        // this call, and asking again whether a completed run exists would
        // refuse every administrator-requested re-audit, since one always does.
        if (!manualRequest) {
          const [completed] = await connection.execute<CountRow[]>(
            allowCompletedReaudit
              ? `SELECT EXISTS (
                   SELECT 1
                   FROM kaudit_audit_run latest
                   WHERE latest.id = c.latest_audit_run_id
                     AND latest.status = 'completed'
                     AND c.outcome_taxonomy_version = ?
                 ) AS n
                 FROM kaudit_call c
                 WHERE c.id = ?
                 FOR UPDATE`
              : `SELECT COUNT(*) AS n
                 FROM kaudit_audit_run
                 WHERE call_id = ? AND status = 'completed'
                 FOR UPDATE`,
            allowCompletedReaudit
              ? [REAUDIT_CLASSIFIER_RULESET_VERSION, candidate.callId]
              : [candidate.callId],
          )
          if (Number(completed[0]?.n || 0) > 0) {
            await connection.commit()
            return 'already_completed'
          }
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
          // The artifact's own attempt counter belongs to the ordinary intake
          // queue. A manual re-audit is counted by its queue item instead, and
          // must not read or advance the pipeline's retry state.
          const [attemptRows] = manualRequest
            ? [[] as AttemptRow[]]
            : await connection.execute<AttemptRow[]>(
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
            result.outcome === 'spend_state_unknown' ||
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
              manualRequest
                ? 'Requested re-audit could not complete; the prior completed audit remains current.'
                : allowCompletedReaudit
                  ? 'Targeted re-audit could not complete; the prior completed audit remains current.'
                  : 'Automated audit could not complete; the call remains unresolved.',
            ],
          )
          if (manualRequest) {
            // Terminal for this item on purpose. A settled failure is never
            // retried automatically, so a model is never paid twice for the
            // same question; an administrator may select the row again.
            const request = manualRequestOf(candidate)
            await settleManualReauditItem(connection, {
              requestId: request.requestId,
              itemId: request.itemId,
              outcome: 'failed',
              errorCode: result.errorCode ?? failureFinding(result.outcome),
              at,
            })
            await connection.commit()
            return 'terminal_failure'
          }
          if (allowCompletedReaudit) {
            await connection.commit()
            return 'terminal_failure'
          }
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
        // Requested re-audits deliberately reuse the artifact, evidence, and
        // analyzer version. Bind the schema's fourth uniqueness component to
        // this append-only run so prior media history is retained.
        const mediaConfigVersion = `2:${auditRunId}`
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
        if (transcript.usage) {
          await insertAiUsageEvent(connection, {
            auditRunId,
            callId: candidate.callId,
            operation: 'transcription',
            passName: 'primary_asr',
            providerName: transcript.model.provider,
            modelName: transcript.model.name,
            modelVersion: transcript.model.version,
            usage: transcript.usage,
            recordedAt: at,
          })
        }
        if (classification.usage) {
          await insertAiUsageEvent(connection, {
            auditRunId,
            callId: candidate.callId,
            operation: 'classification',
            passName: 'primary_classifier',
            providerName: classification.model.provider,
            modelName: classification.model.name,
            modelVersion: classification.model.version,
            usage: classification.usage,
            recordedAt: at,
          })
        }
        await connection.execute(
          `INSERT INTO kaudit_media_analysis
             (id, call_artifact_id, input_sha256, analyzer_name,
              analyzer_version, config_version, status, decoded_duration_ms,
              speech_ms, customer_speech_ms, agent_speech_ms,
              conversation_end_ms, classification_status, metrics_json)
           VALUES (?, ?, ?, 'kairali-independent-reaudit', ?, ?,
                   'completed', ?, ?, ?, ?, ?, 'completed', ?)`,
          [
            mediaAnalysisId,
            candidate.artifactId,
            analysis.evidenceSha256,
            REAUDIT_ENGINE_VERSION,
            mediaConfigVersion,
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
              categoryChargePolicyVersion:
                CATEGORY_CHARGE_POLICY_VERSION,
              categoryChargePolicySha256:
                CATEGORY_CHARGE_POLICY_SHA256,
              categoryChargePolicyCode:
                analysis.categoryChargePolicyCode,
              chargeableServiceEndMs:
                analysis.chargeableServiceEndMs,
              appliedBillingGraceMs:
                analysis.appliedBillingGraceMs,
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
              chargeableServiceEndMs:
                analysis.chargeableServiceEndMs,
              appliedBillingGraceMs:
                analysis.appliedBillingGraceMs,
              categoryChargePolicyVersion:
                CATEGORY_CHARGE_POLICY_VERSION,
              categoryChargePolicySha256:
                CATEGORY_CHARGE_POLICY_SHA256,
              categoryChargePolicyCode:
                analysis.categoryChargePolicyCode,
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
        if (manualRequest) {
          const request = manualRequestOf(candidate)
          await settleManualReauditItem(connection, {
            requestId: request.requestId,
            itemId: request.itemId,
            outcome: 'completed',
            at,
          })
        }
        const outbox = createMysqlOutboxWriter(connection)
        await outbox.enqueue({
          // The ordinary identity is the input manifest hash, which is
          // IDENTICAL for a same-ruleset rerun over the same evidence — exactly
          // what an administrator asks for here. Binding the queue item in
          // gives each requested rerun its own message instead of colliding
          // with the run it replaces.
          messageId: manualRequest
            ? manualReauditOutboxMessageId({
                itemId: manualRequestOf(candidate).itemId,
                inputManifestSha256,
              })
            : `audit-completed:${inputManifestSha256}`,
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
