import { roundKServeChargeableDuration } from '../billing/calculateVerifiedCharge.ts'
import type { ModelClassification } from '../reaudit/types.ts'
import {
  resolveCategoryCharge,
  type CategoryChargeDecision,
} from '../billing/categoryChargePolicy.ts'

/**
 * v2 (approved 2026-09-30): a majority decides the CATEGORY. When the passes
 * that agree on it differ on billable duration, a tie-breaker is asked and
 * the duration most of them support wins; only if no two agree is the
 * shortest used. Deterministic policy then prices it. v1 also required an
 * identical customer-speech flag and rounded duration from two passes, so
 * e.g. two AGENT_FAILURE passes a minute apart could never be priced under
 * the current rules.
 */
export const AUTOMATED_VALIDATION_VERSION =
  'leadership-approved-auto-consensus/2.0.0'
export const AUTOMATED_VALIDATION_THRESHOLD = '0.65000000'
export const AUTOMATED_VALIDATION_CHECKS = [
  'category_majority_of_passes',
  'majority_agreeing_billable_duration_else_shortest',
  'agreeing_confidence_at_or_above_floor',
] as const

export interface ConsensusInput {
  primary: ModelClassification
  secondary: ModelClassification
  adjudicator?: ModelClassification
  recordedDurationMs: number
}

export interface ConsensusResult {
  status: 'accepted' | 'unresolved'
  version: typeof AUTOMATED_VALIDATION_VERSION
  threshold: typeof AUTOMATED_VALIDATION_THRESHOLD
  effectiveConfidence: string
  reasons: string[]
  selectedSource: 'primary' | 'secondary' | 'adjudicator' | null
  selectedClassification: ModelClassification | null
  selectedChargeDecision: CategoryChargeDecision | null
  primaryBillableDurationMs: number
  secondaryBillableDurationMs: number
  adjudicatorBillableDurationMs: number | null
}

function confidence(value: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    throw new RangeError('Model confidence must be from 0 to 1')
  }
  return parsed
}

function projectedCharge(
  classification: ModelClassification,
  recordedDurationMs: number,
): { decision: CategoryChargeDecision; billableDurationMs: number } {
  const decision = resolveCategoryCharge({
    category: classification.category,
    recordedDurationMs,
    lastCustomerExchangeMs:
      classification.lastMeaningfulCustomerExchangeMs,
    lastAgentExchangeMs:
      classification.lastMeaningfulAgentExchangeMs ?? null,
    lastVoicemailExchangeMs:
      classification.lastVoicemailExchangeMs ?? null,
    lastBusinessRelevantCustomerExchangeMs:
      classification.lastBusinessRelevantCustomerExchangeMs ?? null,
    lastVerifiedInteractionMs:
      classification.lastVerifiedInteractionMs ?? null,
    // Engine-validated facts only; without them every AGENT_FAILURE would
    // price at zero regardless of the service actually delivered.
    agentFailureMode: classification.agentFailureMode ?? null,
    meaningfulServiceBeforeFailure:
      classification.meaningfulServiceBeforeFailure === true,
    failureStartMs: classification.failureStartMs ?? null,
  })
  return {
    decision,
    billableDurationMs: roundKServeChargeableDuration(
      decision.adjustedChargeableDurationMs,
    ).billableDurationMs,
  }
}

export function evaluateAutomatedConsensus(
  input: ConsensusInput,
): ConsensusResult {
  const threshold = Number(AUTOMATED_VALIDATION_THRESHOLD)
  const outputs = [
    { source: 'primary' as const, value: input.primary },
    { source: 'secondary' as const, value: input.secondary },
    ...(input.adjudicator
      ? [
          {
            source: 'adjudicator' as const,
            value: input.adjudicator,
          },
        ]
      : []),
  ].map((output) => ({
    ...output,
    confidence: confidence(output.value.confidence),
    ...projectedCharge(output.value, input.recordedDurationMs),
  }))
  const groups = new Map<string, typeof outputs>()
  for (const output of outputs) {
    const key = output.value.category
    groups.set(key, [...(groups.get(key) || []), output])
  }
  const winningGroup = [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right.length - left.length)[0]
  // The two most confident members of the majority must clear the floor.
  const supporting = winningGroup
    ? [...winningGroup]
        .sort((left, right) => right.confidence - left.confidence)
        .slice(0, 2)
    : []
  const durations = new Set(
    (winningGroup ?? []).map((output) => output.billableDurationMs),
  )
  const reasons: string[] = []
  if (!winningGroup) {
    reasons.push('CATEGORY_DISAGREEMENT')
  } else if (durations.size > 1 && !input.adjudicator) {
    // Same category, different money: ask the tie-breaker before pricing.
    reasons.push('BILLABLE_DURATION_DISAGREEMENT')
  } else if (supporting.some((output) => output.confidence < threshold)) {
    reasons.push('WINNING_CONSENSUS_CONFIDENCE_BELOW_FLOOR')
  }
  // The duration most agreeing passes support; if none is shared, the
  // shortest. Ties keep pass order (primary, secondary, adjudicator).
  const byDuration = (candidates: typeof outputs) => [...candidates].sort(
    (left, right) => left.billableDurationMs - right.billableDurationMs,
  )
  const sharedDuration = (winningGroup ?? []).find((output) =>
    winningGroup!.filter(
      (other) => other.billableDurationMs === output.billableDurationMs,
    ).length >= 2)
  const selected = reasons.length === 0
    ? sharedDuration ?? byDuration(winningGroup!)[0]
    : null
  const effectiveConfidence = supporting.length
    ? Math.min(...supporting.map((output) => output.confidence))
    : Math.min(...outputs.map((output) => output.confidence))
  return {
    status: reasons.length === 0 ? 'accepted' : 'unresolved',
    version: AUTOMATED_VALIDATION_VERSION,
    threshold: AUTOMATED_VALIDATION_THRESHOLD,
    effectiveConfidence: effectiveConfidence.toFixed(8),
    reasons,
    selectedSource: selected?.source ?? null,
    selectedClassification: selected?.value ?? null,
    selectedChargeDecision: selected?.decision ?? null,
    primaryBillableDurationMs: outputs[0].billableDurationMs,
    secondaryBillableDurationMs: outputs[1].billableDurationMs,
    adjudicatorBillableDurationMs:
      outputs.find((output) => output.source === 'adjudicator')
        ?.billableDurationMs ?? null,
  }
}
