import { test } from 'node:test'
import assert from 'node:assert/strict'
import { usageProviderCostClaims } from './mysqlCycleImport.ts'

test('normalizes the vendor billed amount as a distinct fixed-precision claim', () => {
  const claims = usageProviderCostClaims({
    taskId: 'synthetic-task',
    destinationNumber: '+910000000000',
    callStartTime: '2026-06-01 10:00:00',
    callConnectedTime: '2026-06-01 10:00:04',
    callEndTime: '2026-06-01 10:00:34',
    durationWithRingingSec: '34',
    durationWithoutRingingSec: '30',
    durationMinutes: '0.5',
    billedAmount: '4.75000000',
    recordingUrl: null,
  })

  assert.deepEqual(claims.at(-1), {
    providerSku: 'vendor_asserted_billed_amount',
    quantity: '4.75000000',
    quantityUnit: 'currency',
    minutes: null,
  })
})

test('does not create a vendor amount claim for a blank amount', () => {
  const claims = usageProviderCostClaims({
    taskId: 'synthetic-task',
    destinationNumber: '+910000000000',
    callStartTime: '2026-06-01 10:00:00',
    callConnectedTime: '2026-06-01 10:00:04',
    callEndTime: '2026-06-01 10:00:34',
    durationWithRingingSec: '34',
    durationWithoutRingingSec: '30',
    durationMinutes: '0.5',
    billedAmount: null,
    recordingUrl: null,
  })

  assert.equal(
    claims.some(
      (claim) => claim.providerSku === 'vendor_asserted_billed_amount',
    ),
    false,
  )
})
