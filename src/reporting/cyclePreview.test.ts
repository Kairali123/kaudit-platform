import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildCyclePreviewRow,
  sumCyclePreview,
} from './cyclePreview.ts'

test('keeps no-recording calls explicit and accepted at the vendor amount', () => {
  const result = buildCyclePreviewRow({
    callId: 'call-1',
    callReference: 'task-1',
    recordingAvailable: false,
    category: null,
    confidence: null,
    vendorBilledMinutes: '0.50000000',
    vendorBilledAmount: '5.25000000',
    vendorConnectedDurationMs: 14_000,
    recordedDurationMs: null,
    conversationEndMs: null,
    evidenceSha256: 'a'.repeat(64),
    auditRunId: null,
  })
  assert.equal(result.auditResolution, 'accepted_as_billed_unverified')
  assert.equal(result.vendorAmount, '5.25000000')
  assert.equal(result.verifiedAmount, '5.25000000')
  assert.equal(result.variance, '0.00000000')
})

test('uses conversation end plus grace for provisional AI preview and sums exactly', () => {
  const ai = buildCyclePreviewRow({
    callId: 'call-2',
    callReference: 'task-2',
    recordingAvailable: true,
    category: 'OK',
    confidence: '0.90000000',
    vendorBilledMinutes: '3.00000000',
    vendorBilledAmount: null,
    vendorConnectedDurationMs: 180_000,
    recordedDurationMs: 180_000,
    conversationEndMs: 61_000,
    evidenceSha256: 'b'.repeat(64),
    auditRunId: 'audit-2',
  })
  assert.equal(ai.graceAdjustedDurationMs, 121_000)
  assert.equal(ai.verifiedBillableMinutes, '3.00000000')
  assert.equal(ai.verifiedAmount, '28.50000000')
  const totals = sumCyclePreview([ai])
  assert.equal(totals.variance, '0.00000000')
})
