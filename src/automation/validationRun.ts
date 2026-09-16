import type { Pool } from 'mysql2/promise'
import {
  agentFailureTrace,
  persistAutomatedValidation,
  type AutomatedValidationCandidate,
} from '../adapters/mysqlAutomatedValidation.ts'
import { persistVerifiedBillingDecision } from '../adapters/mysqlVerifiedBilling.ts'
import {
  evaluateAutomatedConsensus,
  AUTOMATED_VALIDATION_VERSION,
} from './consensus.ts'
import {
  mergeTranscriptSegments,
  validateClassification,
  REAUDIT_CLASSIFIER_RULESET_VERSION,
} from '../reaudit/core.ts'
import { REAUDIT_CLASSIFIER_RULESET_SHA256 } from '../adapters/openaiReaudit.ts'
import {
  canonicalJsonSha256,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { calculateVerifiedKServeCharge } from '../billing/calculateVerifiedCharge.ts'
import {
  CATEGORY_CHARGE_POLICY_SHA256,
  CATEGORY_CHARGE_POLICY_VERSION,
} from '../billing/categoryChargePolicy.ts'
import type { PublishedRateCard } from '../billing/types.ts'
import type { ReauditAi } from '../reaudit/types.ts'

/**
 * Only the classification half of a model port.
 *
 * The consensus reviewer transcribes nothing — the transcript already exists —
 * so requiring the full audit port would force a caller to supply a
 * transcriber this step can never use.
 */
type ClassificationOnly = Pick<ReauditAi, 'classify'>

/**
 * ONE call's automated consensus validation and adjudication, end to end.
 *
 * Extracted from the month-wide validation runner so it can also be applied to
 * an EXACT set of calls — a late-recording correction batch — without either
 * caller re-implementing the policy or widening the other's scope. The month
 * runner and the correction worker now execute byte-identical logic; the only
 * difference is which candidates they hand it.
 *
 * The sequence is the approved one and is not varied here:
 *
 *   1. a second independent classification of the same transcript;
 *   2. consensus on category AND rounded billable duration;
 *   3. a third adjudicating pass ONLY for a lone category disagreement; and
 *   4. the deterministic charge, written with its full decision trace.
 *
 * A model never decides money at any step. It supplies a classification; the
 * consensus rule and `calculateVerifiedKServeCharge` decide what is billable.
 */

export interface AutomatedValidationOutcome {
  callId: string
  status: 'accepted' | 'unresolved'
  reasons: readonly string[]
  /**
   * What was durably written. `final` means a verified calculation now exists
   * and supersedes whatever the call carried before; `unresolved` means only a
   * decision was recorded and the caller still owns the money question.
   */
  billingStatus: 'final' | 'unresolved'
  /** The verified amount, present only when a final calculation was written. */
  amount: string | null
  /** The category-charge decision money was computed from, when accepted. */
  policyCode: string | null
}

export async function runAutomatedValidation(
  pool: Pool,
  options: {
    candidate: AutomatedValidationCandidate
    /** The second independent opinion. */
    reviewer: ClassificationOnly
    /** The third, used only to break a lone category disagreement. */
    adjudicator: ClassificationOnly
    rateCard: PublishedRateCard
    correlationId: string | null
    decidedAt: string
    /**
     * DRY-RUN: compute the identical outcome -- second opinion, adjudication,
     * consensus and verified charge -- and write nothing at all.
     */
    dryRun?: boolean
  },
): Promise<AutomatedValidationOutcome> {
  const { candidate } = options
  const blocks = mergeTranscriptSegments(candidate.segments)
  const durationMismatch =
    candidate.connectedDurationMs != null &&
    Math.abs(candidate.connectedDurationMs - candidate.recordedDurationMs) >
      5_000
  const classify = async (ai: ClassificationOnly) =>
    validateClassification(
      await ai.classify({
        blocks,
        language: candidate.language,
        recordedDurationMs: candidate.recordedDurationMs,
        speechDurationMs: candidate.speechDurationMs,
        connectedDurationMs: candidate.connectedDurationMs,
        durationMismatch,
      }),
      blocks,
      candidate.recordedDurationMs,
      { durationMismatch },
    )

  const secondary = await classify(options.reviewer)
  let consensus = evaluateAutomatedConsensus({
    primary: candidate.primary,
    secondary,
    recordedDurationMs: candidate.recordedDurationMs,
  })
  let adjudication = null
  /**
   * A third pass is paid for ONLY when the single thing the two passes
   * disagree on is the category. Any other disagreement — a differing
   * billable duration above all — is a question a third opinion cannot
   * settle, and the call stays unresolved rather than being voted on.
   */
  if (
    consensus.status === 'unresolved' &&
    consensus.reasons.length === 1 &&
    consensus.reasons[0] === 'CATEGORY_DISAGREEMENT'
  ) {
    adjudication = await classify(options.adjudicator)
    consensus = evaluateAutomatedConsensus({
      primary: candidate.primary,
      secondary,
      adjudicator: adjudication,
      recordedDurationMs: candidate.recordedDurationMs,
    })
  }

  if (!options.dryRun) {
    await persistAutomatedValidation(pool, {
      candidate,
      secondary,
      adjudicator: adjudication,
      consensus,
      decidedAt: options.decidedAt,
    })
  }
  const validationTraceSha256 = canonicalJsonSha256({
    version: consensus.version,
    threshold: consensus.threshold,
    primary: {
      model: candidate.primary.model,
      category: candidate.primary.category,
      confidence: candidate.primary.confidence,
      customerSpoke: candidate.primary.customerSpoke,
      lastMeaningfulCustomerExchangeMs:
        candidate.primary.lastMeaningfulCustomerExchangeMs,
      ...agentFailureTrace(candidate.primary),
      billableDurationMs: consensus.primaryBillableDurationMs,
    },
    secondary: {
      model: secondary.model,
      category: secondary.category,
      confidence: secondary.confidence,
      customerSpoke: secondary.customerSpoke,
      lastMeaningfulCustomerExchangeMs:
        secondary.lastMeaningfulCustomerExchangeMs,
      ...agentFailureTrace(secondary),
      billableDurationMs: consensus.secondaryBillableDurationMs,
    },
    adjudicator: adjudication
      ? {
          model: adjudication.model,
          category: adjudication.category,
          confidence: adjudication.confidence,
          customerSpoke: adjudication.customerSpoke,
          lastMeaningfulCustomerExchangeMs:
            adjudication.lastMeaningfulCustomerExchangeMs,
          ...agentFailureTrace(adjudication),
          billableDurationMs: consensus.adjudicatorBillableDurationMs,
        }
      : null,
    outcome: { status: consensus.status, reasons: consensus.reasons },
  } as unknown as JsonValue)

  const input = {
    callId: candidate.callId,
    auditRunId: candidate.auditRunId,
    claimedDurationMs: candidate.claimedDurationMs,
    connectedDurationMs: candidate.connectedDurationMs,
    recordedDurationMs: candidate.recordedDurationMs,
    speechDurationMs: candidate.speechDurationMs,
    conversationAssessment: consensus.selectedClassification?.customerSpoke
      ? ('established' as const)
      : ('no_meaningful_exchange' as const),
    lastMeaningfulCustomerExchangeMs:
      consensus.selectedClassification?.lastMeaningfulCustomerExchangeMs ??
      null,
    ...(consensus.selectedClassification && consensus.selectedChargeDecision
      ? {
          categoryCharge: {
            category: consensus.selectedClassification.category,
            serviceEndMs: consensus.selectedChargeDecision.serviceEndMs,
            graceMs: consensus.selectedChargeDecision.graceMs,
            policyCode: consensus.selectedChargeDecision.policyCode,
            policyVersion: CATEGORY_CHARGE_POLICY_VERSION,
            policySha256: CATEGORY_CHARGE_POLICY_SHA256,
            ...agentFailureTrace(consensus.selectedClassification),
          },
        }
      : {}),
    model:
      consensus.selectedClassification?.model ?? candidate.primary.model,
    classifierRulesetVersion: REAUDIT_CLASSIFIER_RULESET_VERSION,
    classifierRulesetSha256: REAUDIT_CLASSIFIER_RULESET_SHA256,
    evidence: candidate.evidence,
    authority: {
      calibrationVersion: AUTOMATED_VALIDATION_VERSION,
      calibrationComplete: consensus.status === 'accepted',
      validationMethod: 'automated_consensus' as const,
      validationTraceSha256,
      confidence: consensus.effectiveConfidence,
      threshold: consensus.threshold,
      language: candidate.language,
      findingType:
        consensus.selectedClassification?.category ??
        candidate.primary.category,
      sensitivityTier: 'K0' as const,
      recheckAttempt: 1,
      maximumRechecks: 3,
    },
    calculatedAt: options.decidedAt,
  }
  const billing = calculateVerifiedKServeCharge(input, options.rateCard)
  if (!options.dryRun) {
    await persistVerifiedBillingDecision(pool, {
      input,
      rateCard: options.rateCard,
      result: billing,
      correlationId: options.correlationId,
    })
  }
  return {
    callId: candidate.callId,
    status: consensus.status,
    reasons: consensus.reasons,
    billingStatus: billing.status,
    amount: billing.status === 'final' ? billing.amount : null,
    policyCode: consensus.selectedChargeDecision?.policyCode ?? null,
  }
}
