import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import {
  configuredGasImportSecret,
  gasImportSigningPayload,
  verifyGasImportSignature,
} from './gasImportAuth.ts'

const secret = 'synthetic-gas-import-secret-32-characters'
const request = {
  method: 'POST',
  pathname: '/api/v1/imports/usage',
  timestamp: '1787634000000',
  bodySha256: 'a'.repeat(64),
  filename: 'synthetic-usage.csv',
  periodStart: '2026-06-01',
  periodEnd: '2026-06-30',
}

function signature(): string {
  return createHmac('sha256', secret)
    .update(gasImportSigningPayload(request))
    .digest('hex')
}

test('accepts an exact, fresh GAS usage-import signature', () => {
  assert.equal(verifyGasImportSignature({
    ...request,
    secret,
    signature: signature(),
    nowMs: Number(request.timestamp),
  }), true)
})

test('binds the signature to body, route, period, and filename', () => {
  for (const changed of [
    { bodySha256: 'b'.repeat(64) },
    { pathname: '/api/v1/imports/invoice' },
    { periodEnd: '2026-07-01' },
    { filename: 'changed.csv' },
  ]) {
    assert.equal(verifyGasImportSignature({
      ...request,
      ...changed,
      secret,
      signature: signature(),
      nowMs: Number(request.timestamp),
    }), false)
  }
})

test('rejects stale requests and malformed signatures', () => {
  assert.equal(verifyGasImportSignature({
    ...request,
    secret,
    signature: signature(),
    nowMs: Number(request.timestamp) + 300_001,
  }), false)
  assert.equal(verifyGasImportSignature({
    ...request,
    secret,
    signature: 'not-a-signature',
    nowMs: Number(request.timestamp),
  }), false)
})

test('the optional runtime secret is strongly shaped and never returned in errors', () => {
  assert.equal(configuredGasImportSecret({}), null)
  assert.equal(
    configuredGasImportSecret({ KAUDIT_GAS_IMPORT_SECRET: secret }),
    secret,
  )
  assert.throws(
    () => configuredGasImportSecret({ KAUDIT_GAS_IMPORT_SECRET: 'short' }),
    (error: Error) =>
      error.message === 'KAUDIT_GAS_IMPORT_SECRET is invalid' &&
      !error.message.includes('short'),
  )
})
