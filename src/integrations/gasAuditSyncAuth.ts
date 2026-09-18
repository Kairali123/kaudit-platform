import { createHmac, timingSafeEqual } from 'node:crypto'

export const GAS_AUDIT_SYNC_MAX_CLOCK_SKEW_MS = 5 * 60 * 1_000

export interface GasAuditSyncSignatureInput {
  method: string
  pathname: string
  timestamp: string
  bodySha256: string
  billMonth: string
  batchId: string
}

export function gasAuditSyncSigningPayload(
  input: GasAuditSyncSignatureInput,
): string {
  return [
    input.method.toUpperCase(),
    input.pathname,
    input.timestamp,
    input.bodySha256,
    input.billMonth,
    input.batchId,
  ].join('\n')
}

export function configuredGasAuditSyncSecret(
  env: NodeJS.ProcessEnv,
): string | null {
  const secret = env.KAUDIT_GAS_AUDIT_SYNC_SECRET?.trim() || ''
  if (!secret) return null
  if (!/^[A-Za-z0-9._~-]{32,256}$/.test(secret)) {
    throw new Error('KAUDIT_GAS_AUDIT_SYNC_SECRET is invalid')
  }
  return secret
}

export function verifyGasAuditSyncSignature(input: {
  secret: string
  signature: string
  nowMs: number
} & GasAuditSyncSignatureInput): boolean {
  if (!/^\d{13}$/.test(input.timestamp)) return false
  if (!/^[a-f0-9]{64}$/.test(input.bodySha256)) return false
  if (!/^[a-f0-9]{64}$/.test(input.signature)) return false
  if (!/^\d{4}-\d{2}$/.test(input.billMonth)) return false
  if (!/^[A-Za-z0-9-]{16,64}$/.test(input.batchId)) return false
  const timestampMs = Number(input.timestamp)
  if (
    !Number.isSafeInteger(timestampMs) ||
    Math.abs(input.nowMs - timestampMs) > GAS_AUDIT_SYNC_MAX_CLOCK_SKEW_MS
  ) return false
  const expected = createHmac('sha256', input.secret)
    .update(gasAuditSyncSigningPayload(input))
    .digest()
  const supplied = Buffer.from(input.signature, 'hex')
  return supplied.byteLength === expected.byteLength &&
    timingSafeEqual(supplied, expected)
}
