import assert from 'node:assert/strict'
import test from 'node:test'
import { sha256Hex } from '../lib/hash.ts'
import {
  canonicalJson,
  type JsonValue,
} from '../messaging/canonicalJson.ts'
import { buildMonthlyEmailReport } from './monthlyEmailReport.ts'
import {
  buildMonthlyReportEmailPayload,
  MONTHLY_REPORT_EMAIL_EVENT,
} from './reportEmail.ts'
import { runReportEmailBatch } from './reportEmailWorker.ts'

const report = buildMonthlyEmailReport({
  period: {
    month: '2026-04',
    start: '2026-04-01',
    end: '2026-04-30',
    label: 'April 2026',
  },
  generatedAt: '2026-05-01T00:00:00.000Z',
  invoiceClaimedAmount: '9.50',
  rows: [],
})

test('sends one report package and marks its outbox event published', async () => {
  const built = buildMonthlyReportEmailPayload(report, [
    'dme@kairali.com',
  ])
  const payloadJson = canonicalJson(
    built.payload as unknown as JsonValue,
  )
  const published: string[] = []
  const sent: string[] = []
  const summary = await runReportEmailBatch({
    owner: 'synthetic-worker',
    limit: 1,
    now: new Date('2026-05-01T00:00:00.000Z'),
    repository: {
      async claim() {
        return [{
          id: 'outbox-1',
          messageId: built.messageId,
          aggregateType: 'billing_cycle',
          aggregateId: '2026-04',
          eventType: MONTHLY_REPORT_EMAIL_EVENT,
          payloadJson,
          payloadSha256: sha256Hex(payloadJson),
          correlationId: null,
          attempts: 0,
        }]
      },
      async markPublished(value) {
        published.push(value.id)
      },
      async markFailed() {
        assert.fail('send should not fail')
      },
    },
    transport: {
      async send(message) {
        sent.push(message.subject)
        assert.equal(message.attachments.length, 2)
        return { providerMessageId: 'synthetic-message' }
      },
    },
    async loadReport() {
      return report
    },
  })
  assert.deepEqual(summary, {
    claimed: 1,
    sent: 1,
    retried: 0,
    deadLettered: 0,
  })
  assert.deepEqual(published, ['outbox-1'])
  assert.equal(sent.length, 1)
})
