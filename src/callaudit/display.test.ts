import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toCallAuditDisplay } from './display.ts'
import {
  KSERVE_AI_CALLER,
  KSERVE_AI_CALLER_NAME,
  SENSITIVE_SOURCE_FIELDS,
  type CallAuditDisplay,
  type CallAuditSourceRow,
  type SensitiveSourceField,
} from './types.ts'

/**
 * Compile-time half of the privacy boundary: the display type must not expose
 * any sensitive source field. If one is ever added, this fails `tsc --noEmit`.
 */
type AssertNever<T extends never> = T
type LeakedSensitiveField = Extract<
  keyof CallAuditDisplay,
  SensitiveSourceField
>
export type NoSensitiveFieldOnDisplay = AssertNever<LeakedSensitiveField>

/** Synthetic fixture only — never real customer data. */
function syntheticRow(
  overrides: Partial<CallAuditSourceRow> = {},
): CallAuditSourceRow {
  return {
    callId: 'call-0001',
    leadId: 'LEAD-2026-000123',
    calledAt: '2026-08-01T09:15:00Z',
    durationSeconds: 84,
    clientName: 'Synthetic Client',
    mobile: '+910000000000',
    email: 'synthetic@example.invalid',
    transcriptionViewUrl: 'https://vendor.example.invalid/view/0001',
    transcript: 'Saanvi: hello? Caller: yes, tell me more.',
    ...overrides,
  }
}

test('the display projection carries no sensitive field', () => {
  const display = toCallAuditDisplay(syntheticRow())
  const keys = Object.keys(display)
  for (const field of SENSITIVE_SOURCE_FIELDS) {
    assert.equal(
      keys.includes(field),
      false,
      `display exposed sensitive field ${field}`,
    )
  }
})

test('no sensitive value survives serialization of the display', () => {
  const row = syntheticRow()
  const serialized = JSON.stringify(toCallAuditDisplay(row))
  for (const field of SENSITIVE_SOURCE_FIELDS) {
    const value = row[field]
    assert.equal(typeof value, 'string')
    assert.equal(
      serialized.includes(String(value)),
      false,
      `display leaked the value of ${field}`,
    )
  }
})

test('exposes only a presence signal for the transcript', () => {
  const withTranscript = toCallAuditDisplay(syntheticRow())
  assert.equal(withTranscript.hasTranscript, true)
  assert.equal(withTranscript.eligibility, 'content_auditable')

  const blank = toCallAuditDisplay(syntheticRow({ transcript: '   ' }))
  assert.equal(blank.hasTranscript, false)
  assert.equal(blank.eligibility, 'operational_only')

  const missing = toCallAuditDisplay(syntheticRow({ transcript: null }))
  assert.equal(missing.hasTranscript, false)
  assert.equal(missing.eligibility, 'operational_only')
})

test('derives the Task ID and keeps the non-sensitive audit fields', () => {
  const display = toCallAuditDisplay(syntheticRow())
  assert.equal(display.callId, 'call-0001')
  assert.equal(display.taskId, '000123')
  assert.equal(display.calledAt, '2026-08-01T09:15:00Z')
  assert.equal(display.durationSeconds, 84)
})

test('surfaces the Task ID but never the full lead ID', () => {
  const row = syntheticRow()
  const display = toCallAuditDisplay(row)

  assert.equal('leadId' in display, false)
  assert.equal(Object.keys(display).includes('leadId'), false)
  assert.equal(display.taskId, '000123')

  const serialized = JSON.stringify(display)
  assert.equal(serialized.includes('leadId'), false)
  assert.equal(serialized.includes(String(row.leadId)), false)
  assert.equal(serialized.includes('LEAD-2026'), false)
  assert.equal(serialized.includes('"taskId":"000123"'), true)
})

test('leaks no part of the lead ID beyond the final segment', () => {
  const row = syntheticRow({ leadId: 'CAMPAIGN-CLIENTREF-BATCH9-000777' })
  const display = toCallAuditDisplay(row)
  const serialized = JSON.stringify(display)

  assert.equal(display.taskId, '000777')
  for (const prefixSegment of ['CAMPAIGN', 'CLIENTREF', 'BATCH9']) {
    assert.equal(
      serialized.includes(prefixSegment),
      false,
      `display leaked lead ID segment ${prefixSegment}`,
    )
  }
  assert.equal(serialized.includes('CAMPAIGN-CLIENTREF-BATCH9-000777'), false)
})

test('leaves the Task ID null when the lead ID yields none', () => {
  assert.equal(toCallAuditDisplay(syntheticRow({ leadId: null })).taskId, null)
  assert.equal(
    toCallAuditDisplay(syntheticRow({ leadId: 'LEAD-2026-' })).taskId,
    null,
  )
})

test('identifies the KServe AI caller as Saanvi on every call', () => {
  assert.equal(KSERVE_AI_CALLER_NAME, 'Saanvi')
  assert.deepEqual(KSERVE_AI_CALLER, { kind: 'kserve_ai', name: 'Saanvi' })
  assert.equal(Object.isFrozen(KSERVE_AI_CALLER), true)
  assert.equal(toCallAuditDisplay(syntheticRow()).caller.name, 'Saanvi')
})

test('projection is deterministic and does not mutate the source row', () => {
  const row = syntheticRow()
  const snapshot = { ...row }
  assert.deepEqual(toCallAuditDisplay(row), toCallAuditDisplay(row))
  assert.deepEqual(row, snapshot)
})
