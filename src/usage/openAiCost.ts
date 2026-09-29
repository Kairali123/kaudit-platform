const NANODOLLARS_PER_DOLLAR = 1_000_000_000n

// Pricing snapshot from the OpenAI and ElevenLabs official API pricing pages,
// retrieved 2026-09-25. This is an estimate before tax, credits, negotiated
// pricing, regional uplift, optional feature surcharges, or card/FX charges.
export const AI_AUDIT_PRICING_VERSION =
  'openai-elevenlabs-standard-2026-09-29'
export const AI_AUDIT_PRICING_BASIS =
  'GPT-6 Luna: $0.10/1M input + $0.50/1M output; ' +
  'Whisper: $0.006/min; ElevenLabs Scribe v2: $0.22/hour'

export interface AiUsageCostInput {
  providerName: string
  modelName: string
  inputTokens: number
  outputTokens: number
  audioSeconds: string
}

function nonNegativeInteger(value: number, name: string): bigint {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`)
  }
  return BigInt(value)
}

function decimalThousandths(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,3}))?$/.exec(value)
  if (!match) {
    throw new TypeError('audioSeconds must have at most three decimals')
  }
  return BigInt(match[1] || '0') * 1_000n +
    BigInt((match[2] || '').padEnd(3, '0'))
}

function dollars(nanodollars: bigint): string {
  const whole = nanodollars / NANODOLLARS_PER_DOLLAR
  const fraction = (nanodollars % NANODOLLARS_PER_DOLLAR)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '')
  return fraction ? `${whole}.${fraction}` : String(whole)
}

export function calculateAiAuditCost(
  rows: AiUsageCostInput[],
): {
  estimatedUsd: string
  pricedRows: number
  unpricedRows: number
  pricingVersion: string
  pricingBasis: string
} {
  let nanodollars = 0n
  let pricedRows = 0
  let unpricedRows = 0
  for (const row of rows) {
    const provider = row.providerName.toLowerCase()
    const model = row.modelName.toLowerCase()
    if (
      provider === 'openai' &&
      model === 'gpt-6-luna'
    ) {
      // $0.10 and $0.50 per 1M tokens equal 100 and 500
      // nanodollars per token.
      nanodollars +=
        nonNegativeInteger(row.inputTokens, 'inputTokens') * 100n +
        nonNegativeInteger(row.outputTokens, 'outputTokens') * 500n
      pricedRows += 1
      continue
    }
    if (
      provider === 'openai' &&
      (model === 'whisper' || model === 'whisper-1')
    ) {
      // $0.006/minute = $0.0001/second = 100,000
      // nanodollars/second.
      nanodollars +=
        (decimalThousandths(row.audioSeconds) * 100_000n) /
        1_000n
      pricedRows += 1
      continue
    }
    if (provider === 'elevenlabs' && model === 'scribe_v2') {
      // $0.22/hour, priced from exact audio milliseconds. Optional keyterm,
      // entity, or role-detection surcharges are not enabled by this adapter.
      nanodollars +=
        (decimalThousandths(row.audioSeconds) * 220_000_000n) /
        3_600_000n
      pricedRows += 1
      continue
    }
    unpricedRows += 1
  }
  return {
    estimatedUsd: dollars(nanodollars),
    pricedRows,
    unpricedRows,
    pricingVersion: AI_AUDIT_PRICING_VERSION,
    pricingBasis: AI_AUDIT_PRICING_BASIS,
  }
}
