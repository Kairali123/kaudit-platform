import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalJson,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { buildMonthlyEmailReport } from './monthlyEmailReport.ts'
import {
  buildMonthlyReportEmailPayload,
  MONTHLY_REPORT_EMAIL_EVENT,
  parseMonthlyReportEmailPayload,
} from './reportEmail.ts'

const report = buildMonthlyEmailReport({
  period: {
    month: '2026-04',
    start: '2026-04-01',
    end: '2026-04-30',
    label: 'April 2026',
  },
  generatedAt: '2026-05-01T00:00:00.000Z',
  invoiceClaimedAmount: '9.5',
  rows: [],
})

test('normalizes recipients and creates a stable report message id', () => {
  const first = buildMonthlyReportEmailPayload(report, [
    'DME@KAIRALI.COM',
    'dme@kairali.com',
  ])
  const second = buildMonthlyReportEmailPayload(report, [
    'dme@kairali.com',
  ])
  assert.deepEqual(first, second)
  assert.match(first.messageId, /^report:2026-04:/)
})

test('keeps the same delivery identity when only generation time changes', () => {
  const later = buildMonthlyReportEmailPayload(
    {
      ...report,
      generatedAt: '2026-05-02T00:00:00.000Z',
    },
    ['dme@kairali.com'],
  )
  const original = buildMonthlyReportEmailPayload(report, [
    'dme@kairali.com',
  ])
  assert.equal(later.messageId, original.messageId)
  assert.equal(
    later.payload.reportSha256,
    original.payload.reportSha256,
  )
  assert.notEqual(
    later.payload.generatedAt,
    original.payload.generatedAt,
  )
})

test('parses a hashed report event and rejects outside recipients', () => {
  const built = buildMonthlyReportEmailPayload(report, [
    'dme@kairali.com',
  ])
  const parsed = parseMonthlyReportEmailPayload({
    id: 'outbox-1',
    messageId: built.messageId,
    aggregateType: 'billing_cycle',
    aggregateId: '2026-04',
    eventType: MONTHLY_REPORT_EMAIL_EVENT,
    payloadJson: canonicalJson(
      built.payload as unknown as JsonValue,
    ),
    payloadSha256: '0'.repeat(64),
    correlationId: null,
    attempts: 0,
  })
  assert.equal(parsed.month, '2026-04')
  assert.throws(
    () =>
      buildMonthlyReportEmailPayload(report, [
        'external@example.test',
      ]),
    /@kairali\.com/,
  )
})
