import mysql, { type RowDataPacket } from 'mysql2/promise'
import { createProxyResolvingFetcher } from '../adapters/proxyResolvingFetcher.ts'
import { createMysqlReauditWriteRepo } from '../adapters/mysqlReauditWriteRepo.ts'
import { createOpenAiReaudit } from '../adapters/openaiReaudit.ts'
import { createMysqlBillingSpendGuard } from '../adapters/mysqlBillingSpendLease.ts'
import { createMysqlTranscriptionCache } from '../adapters/mysqlTranscriptionCache.ts'
import { createMysqlBillingMonthSummaryStore } from '../adapters/mysqlBillingMonthSummary.ts'
import { tagPoolAcquisitionFailures } from '../adapters/mysqlPoolAcquisition.ts'
import {
  loadPublishedRateCard,
} from '../adapters/mysqlCycleClose.ts'
import {
  collectAutomatedValidationCandidates,
} from '../adapters/mysqlAutomatedValidation.ts'
import { createOpenAiConsensusReviewer } from '../adapters/openaiConsensus.ts'
import { runAutomatedValidation } from '../automation/validationRun.ts'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import { persistVerifiedBillingRecords } from '../adapters/mysqlVerifiedBilling.ts'
import {
  createMysqlLateRecordingCandidateRepository,
  finalizeLateRecordingBatch,
  listLateRecordingCorrectionFacts,
  listUnfinishedLateRecordingBatchIds,
  prepareLateRecordingBatch,
  readActualPaidAmount,
  readVerifiedMonthTotal,
  settleLateRecordingItem,
  type LateRecordingCorrectionFacts,
} from '../adapters/mysqlLateRecordingCorrections.ts'
import {
  buildAuditedProjectionRecords,
} from '../billing/auditedProjectionSettlement.ts'
import { buildAcceptedAsBilledRecords } from '../billing/acceptedAsBilled.ts'
import type { PublishedRateCard } from '../billing/types.ts'
import { proposedFinanceAdjustment } from '../lateRecording/corrections.ts'
import { decideLateRecordingOutcome } from '../lateRecording/eligibility.ts'
import {
  acquireBillingAuditLock,
  BILLING_AUDIT_LOCK_ERROR_CODE,
} from '../auditWorkers/billingAdvisoryLock.ts'
import { auditOneCall } from '../reaudit/core.ts'
import { runReauditBatch } from '../reaudit/worker.ts'
import { asReauditFatalError, ReauditFatalError } from '../reaudit/failures.ts'
import { parseBillingMonth } from '../reporting/billingMonth.ts'
import { loadRuntimeConfig } from '../config/runtime.ts'
import { resolveDatabaseTls } from '../runtime/databaseTls.ts'

/**
 * The dedicated LATE-RECORDING worker scope.
 *
 * It is deliberately its own runner rather than another mode of the general
 * billing worker. Three properties are what earn it that:
 *
 *   * SCOPE IS A BATCH ID AND NOTHING ELSE. The only input is an opaque
 *     `lrb_` handle. No Task ID, no call id, and above all no recording URL
 *     ever appears in a workflow input, an environment variable, a dispatch
 *     payload, or a log line. Candidate selection is an exact join to that
 *     batch's accepted items, so a run physically cannot reach an unrelated
 *     call.
 *   * AUDIT AND MONEY ARE SEPARATE PASSES. The audit pass writes audit
 *     evidence; the correction pass reads what was actually persisted and
 *     decides the money from it. The second pass is therefore a function of
 *     durable state and is safe to re-run after any interruption.
 *   * SPEND SAFETY IS REUSED, NOT REINVENTED. The same advisory lock, the same
 *     durable pre-model spend lease, and the same transcript cache as every
 *     other Billing Audit run.
 */

const BILLING_LOCK = 'kaudit-independent-reaudit-v2'
/** Opaque batch handles only. This shape is asserted before anything runs. */
const BATCH_ID = /^lrb_[0-9a-f-]{36}$/

function required(name: string): string {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const value = Number(process.env[name] || fallback)
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} must be from ${minimum} to ${maximum}`)
  }
  return value
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** Bounded, URL-free progress output. Task references are never printed. */
function report(event: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(event)}\n`)
}

interface BatchScope {
  batchId: string
  billMonth: string
}

interface BatchRow extends RowDataPacket {
  id: string
  bill_month: string
  period_start: Date | string
  period_end: Date | string
  rate_card_version_id: string
}

/**
 * The approved automated validation and adjudication policy, applied to ONE
 * corrected call.
 *
 * It is the same policy the month-wide runner applies, through the same shared
 * function — the candidate query is simply narrowed to this exact call, so a
 * correction can never validate a call the administrator did not upload.
 *
 * A call with no candidate row (no task reference, no evidence hash, or a
 * verified calculation already current) returns null and the deterministic
 * projection below decides the money instead. Consensus is an improvement on
 * the answer, never a precondition for having one.
 */
async function validateCorrectedCall(
  pool: mysql.Pool,
  options: {
    callId: string
    period: BillingMonthScope
    rateCard: PublishedRateCard
    reviewer: ReturnType<typeof createOpenAiConsensusReviewer>
    adjudicator: ReturnType<typeof createOpenAiReaudit>
    correlationId: string
    decidedAt: string
  },
): Promise<{ billingStatus: 'final' | 'unresolved'; amount: string | null } | null> {
  const [candidate] = await collectAutomatedValidationCandidates(pool, {
    start: options.period.start,
    end: options.period.end,
    limit: 1,
    callIds: [options.callId],
  })
  if (!candidate) return null
  const outcome = await runAutomatedValidation(pool, {
    candidate,
    reviewer: options.reviewer,
    adjudicator: options.adjudicator,
    rateCard: options.rateCard,
    correlationId: options.correlationId,
    decidedAt: options.decidedAt,
  })
  report({
    event: 'late_recording_validation',
    status: outcome.status,
    billingStatus: outcome.billingStatus,
  })
  return { billingStatus: outcome.billingStatus, amount: outcome.amount }
}

async function correctOneItem(
  pool: mysql.Pool,
  options: {
    facts: LateRecordingCorrectionFacts
    batchId: string
    period: BillingMonthScope
    rateCard: PublishedRateCard
    reviewer: ReturnType<typeof createOpenAiConsensusReviewer>
    adjudicator: ReturnType<typeof createOpenAiReaudit>
    decidedAt: string
    correlationId: string
  },
): Promise<'corrected' | 'failed' | 'in_flight'> {
  const { facts } = options
  if (facts.persistedRevisedAmount != null) {
    // The calculation committed but the item transition did not. Recovery
    // completes the bookkeeping from the baseline snapshot instead of running
    // consensus again or appending a second superseding calculation.
    await settleLateRecordingItem(pool, {
      batchId: options.batchId,
      itemId: facts.itemId,
      outcome: 'corrected',
      previousAmount: facts.baselineTotalAmount ?? '0',
      revisedAmount: facts.persistedRevisedAmount,
      supersededCalculationId: facts.baselineCalculationId,
      at: new Date(),
    })
    return 'corrected'
  }
  const outcome = decideLateRecordingOutcome(facts)
  if (outcome === 'in_flight') return 'in_flight'
  if (outcome === 'audited_projection') {
    /**
     * Consensus first. When it resolves, it has ALREADY written the verified
     * calculation -- superseding the no_recording_zero one, because that path
     * does not skip the supersede probe -- and there is nothing left for the
     * projection to write. The item simply records what was written.
     */
    const validated = await validateCorrectedCall(pool, {
      callId: facts.callId,
      period: options.period,
      rateCard: options.rateCard,
      reviewer: options.reviewer,
      adjudicator: options.adjudicator,
      correlationId: options.correlationId,
      decidedAt: options.decidedAt,
    })
    if (validated?.billingStatus === 'final' && validated.amount) {
      await settleLateRecordingItem(pool, {
        batchId: options.batchId,
        itemId: facts.itemId,
        outcome: 'corrected',
        previousAmount: facts.baselineTotalAmount ?? '0',
        revisedAmount: validated.amount,
        supersededCalculationId: facts.baselineCalculationId,
        at: new Date(),
      })
      return 'corrected'
    }
    /**
     * Consensus could not resolve. The audit still happened and its duration
     * is still this platform's own measurement, so the deterministic projection
     * below prices it -- labelled `independent_audited_projection`, which says
     * exactly how much scrutiny the number received. The vendor's claim is
     * accepted only where there is no audited duration at all.
     */
  }
  if (!facts.evidenceObjectId || !facts.evidenceSha256) {
    // The vendor usage manifest is what every settlement hashes against. With
    // no manifest there is no evidence reference to write money under, and
    // inventing one is not an option.
    await settleLateRecordingItem(pool, {
      batchId: options.batchId,
      itemId: facts.itemId,
      outcome: 'failed',
      errorCode: 'LATE_RECORDING_EVIDENCE_MANIFEST_MISSING',
      at: new Date(),
    })
    return 'failed'
  }
  const sourceEvidence = {
    kind: 'call_manifest' as const,
    referenceId: facts.evidenceObjectId,
    sha256: facts.evidenceSha256,
  }
  /**
   * The audited amount, priced from this platform's own audited duration and
   * capped at the vendor charge. It may be zero: a recording that turns out to
   * be an inactive call is still evidence, and evidence decides.
   */
  const records =
    outcome === 'audited_projection'
      ? buildAuditedProjectionRecords(
          {
            callId: facts.callId,
            auditRunId: facts.auditRunId,
            category: facts.category,
            recordedDurationMs: facts.recordedDurationMs,
            speechDurationMs: facts.speechDurationMs,
            serviceEndMs: facts.serviceEndMs,
            graceMs: facts.graceMs,
            claimedDurationMs: facts.claimedDurationMs,
            connectedDurationMs: facts.connectedDurationMs,
            vendorBilledAmount: facts.vendorBilledAmount,
            sourceEvidence,
            decidedAt: options.decidedAt,
          },
          options.rateCard,
        )
      : null
  /**
   * Evidence was attached and the audit still could not resolve it.
   *
   * The approved `accepted_as_billed_unverified` policy applies, scoped to
   * THIS task only. What it must never do is leave the call silently described
   * as `no_recording_zero`: a recording exists now, and a record that still
   * says none was found would be false.
   */
  const settlement =
    records ??
    (facts.vendorBilledMinutes == null
      ? null
      : buildAcceptedAsBilledRecords(
          {
            callId: facts.callId,
            auditRunId: facts.auditRunId,
            fallbackReason:
              outcome === 'accepted_as_billed_unverified'
                ? 'audit_exhausted'
                : 'audited_duration_unavailable',
            claimedDurationMs: facts.claimedDurationMs,
            connectedDurationMs: facts.connectedDurationMs,
            vendorBilledMinutes: facts.vendorBilledMinutes,
            vendorBilledAmount: facts.vendorBilledAmount,
            sourceEvidence,
            decidedAt: options.decidedAt,
          },
          options.rateCard,
        ))
  if (!settlement?.calculation) {
    await settleLateRecordingItem(pool, {
      batchId: options.batchId,
      itemId: facts.itemId,
      outcome: 'failed',
      errorCode: 'LATE_RECORDING_VENDOR_QUANTITY_MISSING',
      at: new Date(),
    })
    return 'failed'
  }
  /**
   * `firstSettlement` is deliberately FALSE here.
   *
   * The whole point of a correction is that a live calculation already exists,
   * so the writer's supersede probe has to run: the new final calculation must
   * name the `no_recording_zero` row it replaces, and that row must survive
   * unchanged. Skipping the probe, as a bulk cycle close does, would leave two
   * live calculations for one call.
   */
  const written = await persistVerifiedBillingRecords(pool, {
    records: settlement,
    rateCard: options.rateCard,
    correlationId: options.correlationId,
  })
  await settleLateRecordingItem(pool, {
    batchId: options.batchId,
    itemId: facts.itemId,
    outcome: 'corrected',
    previousAmount: facts.baselineTotalAmount ?? '0',
    revisedAmount: settlement.calculation.totalAmount,
    supersededCalculationId: facts.baselineCalculationId,
    at: new Date(),
  })
  report({
    event: 'late_recording_item_corrected',
    basis: settlement.calculation.calculationBasis,
    persisted: written.outcome,
  })
  return 'corrected'
}

async function main(): Promise<void> {
  if (required('KAUDIT_LATE_RECORDING_MODE') !== 'EXECUTE') {
    throw new Error('KAUDIT_LATE_RECORDING_MODE must be exactly EXECUTE')
  }
  const explicitBatchId =
    process.env.KAUDIT_LATE_RECORDING_BATCH_ID?.trim() || null
  if (explicitBatchId && !BATCH_ID.test(explicitBatchId)) {
    // A malformed handle is refused before a connection is opened, so nothing
    // that is not a batch id can ever reach a statement.
    throw new Error('KAUDIT_LATE_RECORDING_BATCH_ID is not a batch handle')
  }
  const batchSize = integer('KAUDIT_LATE_RECORDING_BATCH', 5, 1, 100)
  const lockWaitMs =
    integer('KAUDIT_LATE_RECORDING_LOCK_WAIT_SECONDS', 30, 0, 120) * 1_000
  const deadlineSeconds = integer(
    'KAUDIT_WORKER_DEADLINE_SECONDS',
    19_200,
    300,
    21_000,
  )
  const deadline = Date.now() + deadlineSeconds * 1_000
  const allowedHosts = required('KAUDIT_ALLOWED_RECORDING_HOSTS')
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
  const config = loadRuntimeConfig(process.env)
  const ssl = resolveDatabaseTls(config, process.env)
  const pool = tagPoolAcquisitionFailures(
    mysql.createPool({
      host: config.database.host,
      port: config.database.port,
      database: config.database.name,
      user: config.database.user,
      password: config.database.password,
      ...(ssl ? { ssl } : {}),
      connectTimeout: 30_000,
      connectionLimit: 4,
    }),
  )
  let lockConnection
  try {
    lockConnection = await pool.getConnection()
  } catch (error) {
    await pool.end()
    throw asReauditFatalError('pool_acquisition', error)
  }
  let lockAcquired = false
  try {
    /**
     * The SAME advisory lock the general Billing Audit worker takes.
     *
     * This run writes audit evidence and claims pre-model spend leases over
     * the same calls that worker could otherwise claim. Sharing the lock is
     * what keeps two runs from paying twice for one recording.
     */
    lockAcquired = await acquireBillingAuditLock({
      timeoutMs: lockWaitMs,
      retryMs: 1_000,
      wait,
      tryAcquire: async () => {
        const [rows] = await lockConnection.query<RowDataPacket[]>(
          `SELECT GET_LOCK('${BILLING_LOCK}', 0) AS acquired`,
        )
        const acquired = Number(rows[0]?.acquired)
        if (acquired === 1) return true
        if (acquired === 0) return false
        throw new ReauditFatalError('claim', 'DB_UNKNOWN')
      },
    })
    if (!lockAcquired) {
      report({
        event: 'late_recording_lock_busy',
        category: BILLING_AUDIT_LOCK_ERROR_CODE,
      })
      throw new ReauditFatalError('claim', 'WORKER_LOCK_BUSY')
    }

    /**
     * Immediate dispatch names ONE batch. Scheduled recovery finds every batch
     * that was accepted and never drained -- a dispatch that failed, a host
     * that died, a worker that lost its lock -- so a stuck correction is
     * finished without an administrator re-uploading anything.
     */
    const batchIds = explicitBatchId
      ? [explicitBatchId]
      : await listUnfinishedLateRecordingBatchIds(pool)
    if (batchIds.length === 0) {
      report({ event: 'late_recording_no_work' })
      return
    }
    const transcriptCache = createMysqlTranscriptionCache(pool)
    const fetcher = createProxyResolvingFetcher(
      required('KAUDIT_UNPOD_PROXY_BASE'),
    )
    const ai = createOpenAiReaudit(required('OPENAI_API_KEY'))
    // The second and third opinions of the approved validation policy. The
    // adjudicator is the primary classifier re-run, exactly as the month-wide
    // validation runner uses it.
    const reviewer = createOpenAiConsensusReviewer(required('OPENAI_API_KEY'))
    const summaries = createMysqlBillingMonthSummaryStore(pool)

    for (const batchId of batchIds) {
      if (Date.now() >= deadline) {
        report({ event: 'late_recording_deadline_reached' })
        break
      }
      const [batchRows] = await pool.execute<BatchRow[]>(
        `SELECT id, bill_month, period_start, period_end,
                rate_card_version_id
         FROM kaudit_late_recording_batch
         WHERE id = ?`,
        [batchId],
      )
      const batch = batchRows[0]
      if (!batch) {
        report({ event: 'late_recording_batch_not_found' })
        continue
      }
      const period = parseBillingMonth(batch.bill_month)
      if (!period) {
        report({ event: 'late_recording_batch_month_invalid' })
        continue
      }
      const scope: BatchScope = { batchId, billMonth: period.month }
      const prepared = await prepareLateRecordingBatch(pool, {
        batchId,
        period,
        at: new Date(),
      })
      if (!prepared) {
        report({ event: 'late_recording_batch_not_found' })
        continue
      }
      if (prepared.finalized) {
        report({ event: 'late_recording_batch_already_finished' })
        continue
      }
      if (prepared.rateCardVersionId !== batch.rate_card_version_id) {
        report({ event: 'late_recording_rate_card_binding_invalid' })
        continue
      }
      const rateCard = await loadPublishedRateCard(
        pool,
        prepared.rateCardVersionId,
      )

      // ----- pass one: audit the attached recordings -----------------------
      const candidates = createMysqlLateRecordingCandidateRepository(pool, {
        batchId,
      })
      const results = createMysqlReauditWriteRepo(pool)
      for (;;) {
        if (Date.now() >= deadline) break
        const summary = await runReauditBatch({
          candidates,
          results,
          batchSize,
          concurrency: 1,
          spendGuard: createMysqlBillingSpendGuard(pool, {
            exclusiveRecovery: true,
          }),
          shouldContinue: async () => Date.now() < deadline,
          processor: {
            process: (candidate) =>
              auditOneCall({
                candidate,
                fetcher,
                ai,
                allowedHosts,
                transcriptCache,
              }),
          },
        })
        report({
          event: 'late_recording_audit_batch',
          selected: summary.selected,
          completed: summary.completed,
          retried: summary.retriesScheduled,
          terminal: summary.terminalFailures,
        })
        if (summary.selected === 0 || summary.stoppedEarly) break
      }

      // ----- pass two: write the money -------------------------------------
      /**
       * A function of durable state, not of the pass above. Re-running this is
       * harmless and is exactly how an interrupted batch finishes.
       */
      const decidedAt = new Date().toISOString()
      const facts = await listLateRecordingCorrectionFacts(pool, batchId)
      let corrected = 0
      let failed = 0
      let inFlight = 0
      for (const item of facts) {
        try {
          const outcome = await correctOneItem(pool, {
            facts: item,
            batchId,
            period,
            rateCard,
            reviewer,
            adjudicator: ai,
            decidedAt,
            correlationId: `late-recording:${scope.billMonth}`,
          })
          if (outcome === 'corrected') corrected += 1
          else if (outcome === 'failed') failed += 1
          else inFlight += 1
        } catch {
          // One call cannot abandon the batch. The item stays in flight and a
          // later recovery run retries it; the money is never half written,
          // because each correction is its own transaction.
          inFlight += 1
        }
      }

      // ----- pass three: the month's correction record ----------------------
      /**
       * The month's aggregates have just changed, so the cached summary of it
       * is now wrong. Dropped BEFORE the total is re-read so nothing in this
       * run can be computed from a stale cache, and the next page load
       * recomputes and re-caches.
       */
      await summaries.invalidate(period.month)
      const revisedVerifiedTotal = await readVerifiedMonthTotal(pool, period)
      /**
       * `kaudit_kserve_monthly_settlement` is the amount Finance ACTUALLY
       * PAID, and this run does not write it. The proposed adjustment and the
       * revised variance are recorded here instead, and accepting them stays
       * an explicit Finance action against that table.
       */
      const actualPaidAmount = await readActualPaidAmount(pool, period.month)
      const proposal = proposedFinanceAdjustment({
        previousVerifiedTotal: prepared.previousVerifiedTotal,
        revisedVerifiedTotal,
        actualPaidAmount,
      })
      const finalized = await finalizeLateRecordingBatch(pool, {
        batchId,
        billMonth: period.month,
        revisedVerifiedTotal,
        actualPaidAmount,
        revisedVariance: proposal.revisedVariance,
      })
      if (finalized.outcome === 'in_flight') {
        report({
          event: 'late_recording_batch_incomplete',
          corrected: finalized.correctedCount,
          failed: finalized.failedCount,
          inFlight,
        })
        continue
      }
      report({
        event: 'late_recording_batch_finished',
        month: period.month,
        corrected: finalized.correctedCount,
        failed: finalized.failedCount,
        previousVerifiedTotal: finalized.previousVerifiedTotal,
        revisedVerifiedTotal: finalized.revisedVerifiedTotal,
        totalAdjustment: finalized.deltaAmount,
        settlementAction: proposal.settlementAction,
        correctionRecord: finalized.outcome,
      })
    }
  } finally {
    try {
      if (lockAcquired) {
        await lockConnection
          .query(`SELECT RELEASE_LOCK('${BILLING_LOCK}')`)
          .catch(() => undefined)
      }
    } finally {
      lockConnection.release()
      await pool.end()
    }
  }
}

main().catch((error: unknown) => {
  /**
   * The final line of defence keeps the original failure bounded. A raw error
   * here could quote SQL or a recording URL, so only a classified phase and an
   * allowlisted category are ever printed.
   */
  const detail =
    error instanceof ReauditFatalError
      ? ` (phase=${error.phase}; category=${error.category})`
      : ''
  process.stderr.write(
    `[late-recording-worker] stopped: LATE_RECORDING_WORKER_FAILED${detail}\n`,
  )
  process.exitCode = 1
})
