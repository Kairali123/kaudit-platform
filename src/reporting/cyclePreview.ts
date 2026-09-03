import {
  roundKServeChargeableDuration,
} from '../billing/calculateVerifiedCharge.ts'
import { KSERVE_WRAP_UP_GRACE_MS } from '../billing/kserveRules.ts'

const SCALE = 100_000_000n
const RATE_PAISE = 950n

export interface CyclePreviewInputRow {
  callId: string
  callReference: string
  recordingAvailable: boolean
  category: string | null
  confidence: string | null
  vendorBilledMinutes: string
  vendorBilledAmount?: string | null
  vendorConnectedDurationMs: number | null
  recordedDurationMs: number | null
  conversationEndMs: number | null
  evidenceSha256: string
  auditRunId: string | null
}

export interface CyclePreviewRow {
  callReference: string
  auditResolution:
    | 'provisional_ai_uncalibrated'
    | 'accepted_as_billed_unverified'
    | 'no_recording_zero'
  category: string
  confidence: string | null
  vendorBilledMinutes: string
  verifiedBillableMinutes: string
  vendorAmount: string
  verifiedAmount: string
  variance: string
  vendorConnectedDurationMs: number | null
  recordedDurationMs: number | null
  conversationEndMs: number | null
  graceAdjustedDurationMs: number | null
  evidenceSha256: string
  auditRunId: string | null
}

function scale8(value: string): bigint {
  if (!/^-?\d+(?:\.\d{1,8})?$/.test(value)) {
    throw new TypeError(`Invalid decimal: ${value}`)
  }
  const negative = value.startsWith('-')
  const unsigned = negative ? value.slice(1) : value
  const [whole, fraction = ''] = unsigned.split('.')
  const result =
    BigInt(whole) * SCALE +
    BigInt((fraction + '00000000').slice(0, 8))
  return negative ? -result : result
}

function fixed8(value: bigint): string {
  const negative = value < 0n
  const magnitude = negative ? -value : value
  return `${negative ? '-' : ''}${magnitude / SCALE}.${(
    magnitude % SCALE
  ).toString().padStart(8, '0')}`
}

function amountFromMinutes(minutes: string): string {
  const scaledMinutes = scale8(minutes)
  return fixed8((scaledMinutes * RATE_PAISE) / 100n)
}

export function buildCyclePreviewRow(
  row: CyclePreviewInputRow,
): CyclePreviewRow {
  const vendorAmount = row.vendorBilledAmount == null
    ? amountFromMinutes(row.vendorBilledMinutes)
    : fixed8(scale8(row.vendorBilledAmount))
  if (!row.recordingAvailable) {
    return {
      callReference: row.callReference,
      auditResolution: 'no_recording_zero',
      category: 'NO_RECORDING',
      confidence: null,
      vendorBilledMinutes: row.vendorBilledMinutes,
      verifiedBillableMinutes: '0.00000000',
      vendorAmount,
      verifiedAmount: '0.00000000',
      variance: fixed8(scale8(vendorAmount)),
      vendorConnectedDurationMs: row.vendorConnectedDurationMs,
      recordedDurationMs: null,
      conversationEndMs: null,
      graceAdjustedDurationMs: null,
      evidenceSha256: row.evidenceSha256,
      auditRunId: null,
    }
  }
  if (
    row.recordedDurationMs == null ||
    !row.auditRunId ||
    !row.evidenceSha256
  ) {
    throw new Error(
      `Recording-backed call ${row.callReference} is missing its completed audit trace`,
    )
  }
  const adjusted =
    row.conversationEndMs == null
      ? 0
      : Math.min(
          row.recordedDurationMs,
          row.conversationEndMs + KSERVE_WRAP_UP_GRACE_MS,
        )
  const rounded = roundKServeChargeableDuration(adjusted)
  return {
    callReference: row.callReference,
    auditResolution: 'provisional_ai_uncalibrated',
    category: row.category ?? 'UNCLASSIFIED',
    confidence: row.confidence,
    vendorBilledMinutes: row.vendorBilledMinutes,
    verifiedBillableMinutes: rounded.billableMinutes,
    vendorAmount,
    verifiedAmount: rounded.amount,
    variance: fixed8(
      scale8(vendorAmount) - scale8(rounded.amount),
    ),
    vendorConnectedDurationMs: row.vendorConnectedDurationMs,
    recordedDurationMs: row.recordedDurationMs,
    conversationEndMs: row.conversationEndMs,
    graceAdjustedDurationMs: adjusted,
    evidenceSha256: row.evidenceSha256,
    auditRunId: row.auditRunId,
  }
}

export function sumCyclePreview(rows: CyclePreviewRow[]) {
  const totals = rows.reduce(
    (sum, row) => ({
      vendorMinutes:
        sum.vendorMinutes + scale8(row.vendorBilledMinutes),
      verifiedMinutes:
        sum.verifiedMinutes + scale8(row.verifiedBillableMinutes),
      vendorAmount: sum.vendorAmount + scale8(row.vendorAmount),
      verifiedAmount:
        sum.verifiedAmount + scale8(row.verifiedAmount),
      variance: sum.variance + scale8(row.variance),
    }),
    {
      vendorMinutes: 0n,
      verifiedMinutes: 0n,
      vendorAmount: 0n,
      verifiedAmount: 0n,
      variance: 0n,
    },
  )
  return Object.fromEntries(
    Object.entries(totals).map(([key, value]) => [
      key,
      fixed8(value),
    ]),
  ) as Record<keyof typeof totals, string>
}
