import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CALL_AUDIT_METRIC_CODES,
  CALL_AUDIT_METRIC_WEIGHT,
  CALL_AUDIT_RUBRIC,
  CALL_AUDIT_TOTAL_WEIGHT,
  isCallAuditMetricCode,
  metricWeight,
} from './rubric.ts'

test('defines exactly the eight approved metric codes', () => {
  assert.deepEqual(
    [...CALL_AUDIT_METRIC_CODES],
    [
      'PRODUCT_SERVICE_KNOWLEDGE',
      'CUSTOMER_UNDERSTANDING',
      'COMMUNICATION_CLARITY',
      'OBJECTION_CALLBACK_HANDLING',
      'CLOSING_NEXT_STEP',
      'PROFESSIONALISM',
      'QUALIFICATION_COMPLETENESS',
      'COMPLIANCE_PRIVACY',
    ],
  )
  assert.equal(CALL_AUDIT_METRIC_CODES.length, 8)
  assert.equal(new Set(CALL_AUDIT_METRIC_CODES).size, 8)
})

test('pins each approved weight', () => {
  assert.deepEqual(CALL_AUDIT_METRIC_WEIGHT, {
    PRODUCT_SERVICE_KNOWLEDGE: 15,
    CUSTOMER_UNDERSTANDING: 20,
    COMMUNICATION_CLARITY: 15,
    OBJECTION_CALLBACK_HANDLING: 10,
    CLOSING_NEXT_STEP: 10,
    PROFESSIONALISM: 10,
    QUALIFICATION_COMPLETENESS: 15,
    COMPLIANCE_PRIVACY: 5,
  })
})

test('weights are positive integers totalling exactly 100', () => {
  let total = 0
  for (const metric of CALL_AUDIT_RUBRIC) {
    assert.ok(Number.isInteger(metric.weight), `${metric.code} weight not integer`)
    assert.ok(metric.weight > 0, `${metric.code} weight not positive`)
    total += metric.weight
  }
  assert.equal(total, 100)
  assert.equal(total, CALL_AUDIT_TOTAL_WEIGHT)
})

test('the rubric covers every metric code once', () => {
  assert.equal(CALL_AUDIT_RUBRIC.length, CALL_AUDIT_METRIC_CODES.length)
  assert.deepEqual(
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
    [...CALL_AUDIT_METRIC_CODES],
  )
})

test('only the two genuinely optional metrics may be NA', () => {
  const naAble = CALL_AUDIT_RUBRIC.filter(
    (metric) => metric.naAllowedWhenCustomerSpoke,
  ).map((metric) => metric.code)
  assert.deepEqual(naAble, [
    'PRODUCT_SERVICE_KNOWLEDGE',
    'OBJECTION_CALLBACK_HANDLING',
  ])
  for (const metric of CALL_AUDIT_RUBRIC) {
    assert.equal(
      typeof metric.naReason === 'string',
      metric.naAllowedWhenCustomerSpoke,
      `${metric.code} NA reason must match its NA policy`,
    )
  }
})

test('documents why each optional metric may be NA', () => {
  const byCode = new Map(CALL_AUDIT_RUBRIC.map((m) => [m.code, m]))
  assert.match(
    byCode.get('PRODUCT_SERVICE_KNOWLEDGE')?.naReason ?? '',
    /no product or service explanation occurred/,
  )
  assert.match(
    byCode.get('OBJECTION_CALLBACK_HANDLING')?.naReason ?? '',
    /no objection or callback request occurred/,
  )
})

test('carries no audio-only metric, because this audit reads transcripts', () => {
  for (const banned of [
    'AUDIO_VOLUME',
    'VOICE_CLARITY',
    'VOICE_QUALITY',
    'TONE_OF_VOICE',
    'SPEAKING_PACE',
    'AUDIO_QUALITY',
  ]) {
    assert.equal(
      isCallAuditMetricCode(banned),
      false,
      `${banned} must not be a metric`,
    )
  }
})

test('recognizes approved metric codes and rejects everything else', () => {
  for (const code of CALL_AUDIT_METRIC_CODES) {
    assert.ok(isCallAuditMetricCode(code))
    assert.equal(metricWeight(code), CALL_AUDIT_METRIC_WEIGHT[code])
  }
  for (const value of ['', 'greeting', 'product_service_knowledge', null, 5, {}]) {
    assert.equal(isCallAuditMetricCode(value), false)
  }
})
