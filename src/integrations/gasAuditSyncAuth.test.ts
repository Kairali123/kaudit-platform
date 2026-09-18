import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  configuredGasAuditSyncSecret,
  GAS_AUDIT_SYNC_MAX_CLOCK_SKEW_MS,
  gasAuditSyncSigningPayload,
  verifyGasAuditSyncSignature,
} from './gasAuditSyncAuth.ts'

const secret = 'synthetic-audit-sync-secret-32-characters'
const nowMs = Date.UTC(2026, 7, 31, 12, 0, 0)
const base = {
  method: 'POST',
  pathname: '/api/v1/imports/gas-audit-results',
  timestamp: String(nowMs),
  bodySha256: 'a'.repeat(64),
  billMonth: '2026-08',
  batchId: 'batch-20260831-abcdef',
}

function signature(input = base): string {
  return createHmac('sha256', secret)
    .update(gasAuditSyncSigningPayload(input))
    .digest('hex')
}

test('accepts a current signature over method, path, body, month and batch', () => {
  assert.equal(verifyGasAuditSyncSignature({
    ...base,
    secret,
    signature: signature(),
    nowMs,
  }), true)
})

test('rejects tampering and stale signatures', () => {
  assert.equal(verifyGasAuditSyncSignature({
    ...base,
    bodySha256: 'b'.repeat(64),
    secret,
    signature: signature(),
    nowMs,
  }), false)
  assert.equal(verifyGasAuditSyncSignature({
    ...base,
    secret,
    signature: signature(),
    nowMs: nowMs + GAS_AUDIT_SYNC_MAX_CLOCK_SKEW_MS + 1,
  }), false)
})

test('validates configured secret shape without exposing it', () => {
  assert.equal(configuredGasAuditSyncSecret({}), null)
  assert.equal(configuredGasAuditSyncSecret({
    KAUDIT_GAS_AUDIT_SYNC_SECRET: secret,
  }), secret)
  assert.throws(() => configuredGasAuditSyncSecret({
    KAUDIT_GAS_AUDIT_SYNC_SECRET: 'short',
  }), /invalid/)
})
