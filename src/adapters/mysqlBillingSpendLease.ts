import { createHash, randomUUID } from 'node:crypto'
import type { Pool, ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import { REAUDIT_CLASSIFIER_RULESET_VERSION } from '../reaudit/core.ts'
import { REAUDIT_ENGINE_VERSION } from '../reaudit/core.ts'
import { REAUDIT_CLASSIFIER_RULESET_SHA256 } from './openaiReaudit.ts'
import type { ReauditCandidate, ReauditItemResult } from '../reaudit/types.ts'

/**
 * Durable pre-model spend claiming for Billing Audit (migration 0017).
 *
 * A lease is committed BEFORE any model call and is keyed by the exact work
 * identity, so two overlapping runs can never both spend on the same question.
 * Interruptions are recovered from normalized staged output. If no output was
 * staged, the claim is converted to a bounded terminal result; ambiguity is
 * never resolved by making another paid call.
 *
 * Temporary staging contains only fields the existing final writer needs. It
 * excludes URLs, prompts, raw responses/errors, displayed references, and all
 * monetary projections, and is cleared after final persistence. Transcript
 * segments and the bounded finding explanation follow the same database
 * access and retention boundary as their final Kaudit-owned records.
 */

export const SPEND_LEASE_TTL_MINUTES = 30
export const MAX_SPEND_LEASE_ATTEMPTS = 1

interface LeaseRow extends RowDataPacket {
  status: 'active' | 'completed' | 'released' | 'expired'
  staged_result_json: unknown
}

interface OwnershipRow extends RowDataPacket {
  owned: number | string
}

/**
 * The deterministic, privacy-safe work identity behind a lease. For an
 * administrator-requested re-audit the queue item id is bound in so every
 * request stays its own claimable unit of work.
 */
export function billingSpendLeaseId(candidate: ReauditCandidate): string {
  return createHash('sha256')
    .update([
      candidate.callId,
      candidate.artifactId,
      candidate.baselineSha256 ?? '',
      REAUDIT_CLASSIFIER_RULESET_VERSION,
      REAUDIT_ENGINE_VERSION,
      REAUDIT_CLASSIFIER_RULESET_SHA256,
      candidate.manualRequest?.itemId ?? '',
    ].join('\u0000'))
    .digest('hex')
}

function leaseExpiry(at: Date): Date {
  return new Date(at.getTime() + SPEND_LEASE_TTL_MINUTES * 60_000)
}

export function createMysqlBillingSpendGuard(
  pool: Pool,
  options: { exclusiveRecovery?: boolean } = {},
) {
  const workerId = randomUUID()
  return {
    async claim(candidate: ReauditCandidate): Promise<
      | { outcome: 'acquired' }
      | { outcome: 'busy' }
      | { outcome: 'closed'; result: ReauditItemResult }
      | { outcome: 'recovered'; result: ReauditItemResult }
    > {
      const at = new Date()
      const id = billingSpendLeaseId(candidate)
      const expiresAt = leaseExpiry(at)
      try {
        await pool.execute<ResultSetHeader>(
          `INSERT INTO kaudit_billing_spend_lease
             (id, call_id, artifact_id, manual_item_id, status, attempt_count,
              worker_id, claimed_at, lease_expires_at)
           VALUES (?, ?, ?, ?, 'active', 1, ?, ?, ?)`,
          [
            id,
            candidate.callId,
            candidate.artifactId,
            candidate.manualRequest?.itemId ?? null,
            workerId,
            at,
            expiresAt,
          ],
        )
        return { outcome: 'acquired' }
      } catch (error) {
        // Only a duplicate-key race is meaningful here; anything else is an
        // infrastructure failure the caller's phase classifier owns.
        if (
          typeof error !== 'object' ||
          error === null ||
          (error as { code?: unknown }).code !== 'ER_DUP_ENTRY'
        ) {
          throw error
        }
      }
      const [rows] = await pool.execute<LeaseRow[]>(
        `SELECT status, staged_result_json
         FROM kaudit_billing_spend_lease
         WHERE id = ?`,
        [id],
      )
      const existing = rows[0]
      if (!existing) return { outcome: 'busy' }
      // Completed and terminal-expired questions never spend again without an
      // explicit administrator request carrying a distinct queue item id. If
      // stale work state selected the item again, reconcile it through the
      // normal writer instead of leaving it eligible for a hot loop.
      if (existing.status === 'completed' || existing.status === 'expired') {
        return { outcome: 'closed', result: unknownSpendResult(candidate) }
      }
      // A proven NO-spend release continues freely.
      if (existing.status === 'released') {
        const [resumed] = await pool.execute<ResultSetHeader>(
          `UPDATE kaudit_billing_spend_lease
           SET status = 'active',
               worker_id = ?, claimed_at = ?, lease_expires_at = ?,
               staged_result_json = NULL, staged_at = NULL, settled_at = NULL
           WHERE id = ? AND status = 'released'`,
          [workerId, at, expiresAt, id],
        )
        return resumed.affectedRows === 1
          ? { outcome: 'acquired' }
          : { outcome: 'busy' }
      }
      const mayRecoverNow = options.exclusiveRecovery === true ? 1 : 0
      if (existing.staged_result_json) {
        const [recovered] = await pool.execute<ResultSetHeader>(
          `UPDATE kaudit_billing_spend_lease
           SET worker_id = ?, claimed_at = ?, lease_expires_at = ?,
               settled_at = NULL
           WHERE id = ? AND status = 'active'
             AND (lease_expires_at <= ? OR ? = 1)
             AND staged_result_json IS NOT NULL`,
          [workerId, at, expiresAt, id, at, mayRecoverNow],
        )
        if (recovered.affectedRows === 1) {
          return {
            outcome: 'recovered',
            result: parseStagedResult(existing.staged_result_json),
          }
        }
        return { outcome: 'busy' }
      }
      // No staged output means the old worker may have crossed the paid
      // boundary and died before it could record the result. Convert that
      // ambiguity into a recoverable terminal result, never a second model
      // invocation. The worker persists this bounded result through the same
      // transactional writer used by every other outcome.
      const terminalResult = unknownSpendResult(candidate)
      const [recovered] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_billing_spend_lease
         SET worker_id = ?, claimed_at = ?, lease_expires_at = ?,
             staged_result_json = ?, staged_at = ?, settled_at = NULL
         WHERE id = ? AND status = 'active'
           AND (lease_expires_at <= ? OR ? = 1)
           AND staged_result_json IS NULL`,
        [
          workerId,
          at,
          expiresAt,
          serializeStagedResult(terminalResult),
          at,
          id,
          at,
          mayRecoverNow,
        ],
      )
      return recovered.affectedRows === 1
        ? { outcome: 'recovered', result: terminalResult }
        : { outcome: 'busy' }
    },

    async stageResult(
      candidate: ReauditCandidate,
      result: ReauditItemResult,
    ): Promise<void> {
      const at = new Date()
      const id = billingSpendLeaseId(candidate)
      const [updated] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_billing_spend_lease
         SET staged_result_json = ?, staged_at = ?
         WHERE id = ? AND status = 'active' AND worker_id = ?`,
        [serializeStagedResult(result), at, id, workerId],
      )
      if (updated.affectedRows !== 1) throw leaseOwnershipError()
    },

    async settle(
      candidate: ReauditCandidate,
      outcome: 'model_spent' | 'no_model_call' | 'unknown',
    ): Promise<void> {
      const at = new Date()
      const id = billingSpendLeaseId(candidate)
      if (outcome === 'unknown') {
        const [owned] = await pool.execute<OwnershipRow[]>(
          `SELECT 1 AS owned
           FROM kaudit_billing_spend_lease
           WHERE id = ? AND status = 'active' AND worker_id = ?`,
          [id, workerId],
        )
        if (Number(owned[0]?.owned || 0) !== 1) throw leaseOwnershipError()
        // The staged result, when present, remains active for recovery. An
        // unstaged ambiguity is converted to a terminal result on recovery.
        return
      }
      const [updated] = await pool.execute<ResultSetHeader>(
        `UPDATE kaudit_billing_spend_lease
         SET status = ?, settled_at = ?,
             staged_result_json = NULL, staged_at = NULL
         WHERE id = ? AND status = 'active' AND worker_id = ?`,
        [outcome === 'model_spent' ? 'completed' : 'released', at, id, workerId],
      )
      if (updated.affectedRows !== 1) throw leaseOwnershipError()
    },
  }
}

function serializeStagedResult(result: ReauditItemResult): string {
  return JSON.stringify(minimalPersistenceResult(result))
}

function parseStagedResult(value: unknown): ReauditItemResult {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Invalid staged Billing audit result')
  }
  return parsed as ReauditItemResult
}

function unknownSpendResult(candidate: ReauditCandidate): ReauditItemResult {
  return {
    callId: candidate.callId,
    artifactId: candidate.artifactId,
    outcome: 'spend_state_unknown',
    errorCode: 'AUDIT_SPEND_STATE_UNKNOWN',
  }
}

function minimalPersistenceResult(
  result: ReauditItemResult,
): ReauditItemResult {
  const base: ReauditItemResult = {
    callId: result.callId,
    artifactId: result.artifactId,
    outcome: result.outcome,
    ...(result.errorCode ? { errorCode: result.errorCode } : {}),
  }
  if (
    result.outcome !== 'projected' ||
    !result.analysis ||
    !result.transcription ||
    !result.classification
  ) return base
  return {
    ...base,
    analysis: result.analysis,
    transcription: {
      model: result.transcription.model,
      language: result.transcription.language,
      durationMs: result.transcription.durationMs,
      speechMs: result.transcription.speechMs,
      text: '',
      segments: result.transcription.segments,
      ...(result.transcription.usage
        ? { usage: result.transcription.usage }
        : {}),
    },
    classification: {
      model: result.classification.model,
      category: result.classification.category,
      confidence: result.classification.confidence,
      customerBlockNumbers: [],
      unclearBlockNumbers: [],
      customerSpoke: result.classification.customerSpoke,
      lastMeaningfulCustomerExchangeMs:
        result.classification.lastMeaningfulCustomerExchangeMs,
      remarks: '',
      disputeRecommended: result.classification.disputeRecommended,
      ...(result.classification.usage
        ? { usage: result.classification.usage }
        : {}),
    },
  }
}

function leaseOwnershipError(): Error {
  return Object.assign(new Error('Billing spend lease is not owned by worker'), {
    code: 'REAUDIT_ITEM_STATE_CONFLICT',
  })
}
