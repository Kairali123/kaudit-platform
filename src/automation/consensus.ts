import { roundKServeChargeableDuration } from '../billing/calculateVerifiedCharge.ts'
import type { ModelClassification } from '../reaudit/types.ts'
import {
  resolveCategoryCharge,
  type CategoryChargeDecision,
} from '../billing/categoryChargePolicy.ts'

export const AUTOMATED_VALIDATION_VERSION =
  'leadership-approved-auto-consensus/1.1.0'
export const AUTOMATED_VALIDATION_THRESHOLD = '0.80000000'

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
    const key = [
      output.value.category,
      output.value.customerSpoke ? 'customer' : 'no-customer',
      output.billableDurationMs,
    ].join(':')
    groups.set(key, [...(groups.get(key) || []), output])
  }
  const winningGroup = [...groups.values()]
    .filter((group) => group.length >= 2)
    .sort((left, right) => right.length - left.length)[0]
  const reasons: string[] = []
  if (!winningGroup) {
    reasons.push('CATEGORY_DISAGREEMENT')
    if (
      new Set(
        outputs.map((output) => output.value.customerSpoke),
      ).size > 1
    ) {
      reasons.push('CUSTOMER_SPEECH_DISAGREEMENT')
    }
    if (
      new Set(
        outputs.map((output) => output.billableDurationMs),
      ).size > 1
    ) {
      reasons.push('BILLABLE_DURATION_DISAGREEMENT')
    }
  } else if (
    winningGroup.some((output) => output.confidence < threshold)
  ) {
    reasons.push('WINNING_CONSENSUS_CONFIDENCE_BELOW_FLOOR')
  }
  const selected = reasons.length === 0 ? winningGroup?.[0] : null
  const effectiveConfidence = winningGroup
    ? Math.min(...winningGroup.map((output) => output.confidence))
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
