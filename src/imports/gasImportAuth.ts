import { createHmac, timingSafeEqual } from 'node:crypto'

export const GAS_IMPORT_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

export interface GasImportSignatureInput {
  method: string
  pathname: string
  timestamp: string
  bodySha256: string
  filename: string
  periodStart: string
  periodEnd: string
}

export function gasImportSigningPayload(input: GasImportSignatureInput): string {
  return [
    input.method.toUpperCase(),
    input.pathname,
    input.timestamp,
    input.bodySha256,
    input.filename,
    input.periodStart,
    input.periodEnd,
  ].join('\n')
}

export function configuredGasImportSecret(
  env: NodeJS.ProcessEnv,
): string | null {
  const secret = env.KAUDIT_GAS_IMPORT_SECRET?.trim() || ''
  if (!secret) return null
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(secret)) {
    throw new Error('KAUDIT_GAS_IMPORT_SECRET is invalid')
  }
  return secret
}

export function verifyGasImportSignature(input: {
  secret: string
  signature: string
  nowMs: number
} & GasImportSignatureInput): boolean {
  if (!/^\d{13}$/.test(input.timestamp)) return false
  if (!/^[a-f0-9]{64}$/.test(input.bodySha256)) return false
  if (!/^[a-f0-9]{64}$/.test(input.signature)) return false
  const timestampMs = Number(input.timestamp)
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(input.nowMs - timestampMs) > GAS_IMPORT_MAX_CLOCK_SKEW_MS
  ) return false
  const expected = createHmac('sha256', input.secret)
    .update(gasImportSigningPayload(input))
    .digest()
  const supplied = Buffer.from(input.signature, 'hex')
  return supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
}
