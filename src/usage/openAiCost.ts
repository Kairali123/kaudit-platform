const NANODOLLARS_PER_DOLLAR = 1_000_000_000n

// Pricing snapshot from https://developers.openai.com/api/docs/pricing,
// retrieved 2026-07-29. This is an estimate before tax, credits, negotiated
// pricing, regional uplift, or card/FX charges.
export const OPENAI_AUDIT_PRICING_VERSION =
  'openai-standard-2026-07-29'
export const OPENAI_AUDIT_PRICING_BASIS =
  'GPT-4o-mini: $0.15/1M input + $0.60/1M output; Whisper: $0.006/min'

export interface OpenAiUsageCostInput {
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

export function calculateOpenAiAuditCost(
  rows: OpenAiUsageCostInput[],
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
    const model = row.modelName.toLowerCase()
    if (
      model === 'gpt-4o-mini' ||
      model.startsWith('gpt-4o-mini-')
    ) {
      // $0.15 and $0.60 per 1M tokens equal 150 and 600
      // nanodollars per token.
      nanodollars +=
        nonNegativeInteger(row.inputTokens, 'inputTokens') * 150n +
        nonNegativeInteger(row.outputTokens, 'outputTokens') * 600n
      pricedRows += 1
      continue
    }
    if (model === 'whisper' || model === 'whisper-1') {
      // $0.006/minute = $0.0001/second = 100,000
      // nanodollars/second.
      nanodollars +=
        (decimalThousandths(row.audioSeconds) * 100_000n) /
        1_000n
      pricedRows += 1
      continue
    }
    unpricedRows += 1
  }
  return {
    estimatedUsd: dollars(nanodollars),
    pricedRows,
    unpricedRows,
    pricingVersion: OPENAI_AUDIT_PRICING_VERSION,
    pricingBasis: OPENAI_AUDIT_PRICING_BASIS,
  }
}
