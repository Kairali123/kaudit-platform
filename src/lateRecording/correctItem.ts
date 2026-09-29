import type { Pool } from 'mysql2/promise'
import {
  collectAutomatedValidationCandidates,
} from '../adapters/mysqlAutomatedValidation.ts'
import {
  settleLateRecordingItem,
  type LateRecordingCorrectionFacts,
} from '../adapters/mysqlLateRecordingCorrections.ts'
import { persistVerifiedBillingRecords } from '../adapters/mysqlVerifiedBilling.ts'
import { runAutomatedValidation } from '../automation/validationRun.ts'
import { buildAcceptedAsBilledRecords } from '../billing/acceptedAsBilled.ts'
import { buildAuditedProjectionRecords } from '../billing/auditedProjectionSettlement.ts'
import type { PublishedRateCard } from '../billing/types.ts'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import type { ReauditAi } from '../reaudit/types.ts'
import { decideLateRecordingOutcome } from './eligibility.ts'

type ClassificationOnly = Pick<ReauditAi, 'classify'>

async function validateCorrectedCall(
  pool: Pool,
  options: {
    callId: string
    period: BillingMonthScope
    rateCard: PublishedRateCard
    reviewer: ClassificationOnly
    adjudicator: ClassificationOnly
    correlationId: string
    decidedAt: string
  },
): Promise<{ billingStatus: 'final' | 'unresolved'; amount: string | null } | null> {
  const [candidate] = await collectAutomatedValidationCandidates(pool, {
    start: options.period.start,
    end: options.period.end,
    limit: 1,
    callIds: [options.callId],
    allowExistingCalculation: true,
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
  return { billingStatus: outcome.billingStatus, amount: outcome.amount }
}

/**
 * Prices one late-recording item from durable audit state.
 *
 * It is safe to invoke after parallel audit requests: an already persisted
 * calculation is detected, every new calculation supersedes rather than
 * overwrites, and the item transition itself is conditional.
 */
export async function correctLateRecordingItem(
  pool: Pool,
  options: {
    facts: LateRecordingCorrectionFacts
    batchId: string
    period: BillingMonthScope
    rateCard: PublishedRateCard
    reviewer: ClassificationOnly
    adjudicator: ClassificationOnly
    decidedAt: string
    correlationId: string
  },
): Promise<'corrected' | 'failed' | 'in_flight'> {
  const { facts } = options
  if (facts.persistedRevisedAmount != null) {
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
  }

  if (!facts.evidenceObjectId || !facts.evidenceSha256) {
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
  await persistVerifiedBillingRecords(pool, {
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
  return 'corrected'
}
