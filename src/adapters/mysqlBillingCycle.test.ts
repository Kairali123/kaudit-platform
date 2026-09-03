import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { collectLatestBillingCycle } from './mysqlBillingCycle.ts'

test('billing cycle uses bounded month queries and preserves calculated values', async () => {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async query(sql: string, parameters: unknown[]) {
      statements.push({ sql, parameters })
      if (sql.includes('AS total_calls')) {
        return [[{
          total_calls: 12,
          recording_available_calls: 10,
          completed_audit_calls: 8,
          processing_failure_calls: 1,
        }], []]
      }
      if (sql.includes('AS accepted_as_billed_calls')) {
        return [[{
          accepted_as_billed_calls: 2,
          final_calculation_calls: 7,
          calculated_total: '1250.50',
          billable_minutes: '83.25',
          currency: 'INR',
        }], []]
      }
      return [[{ unresolved_decision_calls: 3 }], []]
    },
  } as unknown as Pool

  const result = await collectLatestBillingCycle(pool, {
    month: '2026-05',
    start: '2026-05-01',
    end: '2026-05-31',
    label: 'May 2026',
  })

  assert.deepEqual(result, {
    periodStart: '2026-05-01',
    periodEnd: '2026-05-31',
    totalCalls: 12,
    recordingAvailableCalls: 10,
    completedAuditCalls: 8,
    acceptedAsBilledCalls: 2,
    finalCalculationCalls: 7,
    unresolvedDecisionCalls: 3,
    processingFailureCalls: 1,
    calculatedTotal: '1250.50',
    billableMinutes: '83.25',
    currency: 'INR',
  })
  assert.equal(statements.length, 3)
  for (const statement of statements) {
    assert.deepEqual(statement.parameters, ['2026-05-01', '2026-05-31'])
    assert.match(statement.sql, /billing_period_date BETWEEN \? AND \?/)
  }
  assert.match(statements[0]?.sql ?? '', /FROM kaudit_audit_run audit_run/)
  assert.match(
    statements[1]?.sql ?? '',
    /newer\.supersedes_calculation_id = calculation\.id/,
  )
  assert.match(
    statements[2]?.sql ?? '',
    /newer\.supersedes_decision_id = decision_row\.id/,
  )
})

test('an optional cycle query cannot conceal a database statement timeout', async () => {
  const timeout = Object.assign(new Error('synthetic timeout'), {
    code: 'ER_STATEMENT_TIMEOUT',
  })
  const pool = {
    async query(sql: string) {
      if (sql.includes('AS total_calls')) {
        return [[{
          total_calls: 1,
          recording_available_calls: 1,
          completed_audit_calls: 1,
          processing_failure_calls: 0,
        }], []]
      }
      throw timeout
    },
  } as unknown as Pool

  await assert.rejects(
    collectLatestBillingCycle(pool, {
      month: '2026-05',
      start: '2026-05-01',
      end: '2026-05-31',
      label: 'May 2026',
    }),
    (error) => error === timeout,
  )
})
