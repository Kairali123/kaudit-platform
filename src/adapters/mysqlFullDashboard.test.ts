import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  collectBilling,
  collectBillingReadiness,
} from './mysqlFullDashboard.ts'

test('billing aggregates propagate a database statement timeout', async () => {
  const timeout = Object.assign(new Error('synthetic timeout'), {
    code: 'ER_QUERY_TIMEOUT',
  })
  const pool = {
    async query(sql: string) {
      if (sql.includes('COUNT(*) AS calculations')) throw timeout
      if (sql.includes('AS total_calls')) {
        return [[{
          total_calls: 0,
          recording_available_calls: 0,
          completed_audit_calls: 0,
          processing_failure_calls: 0,
        }], []]
      }
      return [[{}], []]
    },
  } as unknown as Pool

  await assert.rejects(
    collectBilling(pool, {
      month: '2026-05',
      start: '2026-05-01',
      end: '2026-05-31',
      label: 'May 2026',
    }),
    (error) => error === timeout,
  )
})

test('report readiness skips full billing summary and authority reads', async () => {
  const statements: string[] = []
  const pool = {
    async query(sql: string) {
      statements.push(sql)
      if (sql.includes('FROM kaudit_rate_card_version')) {
        return [[{
          status: 'published',
          approved_by: 'synthetic-admin',
          approved_at: '2026-07-31 00:00:00',
        }], []]
      }
      if (sql.includes('AS total_calls')) {
        return [[{
          total_calls: 1,
          recording_available_calls: 1,
          completed_audit_calls: 1,
          processing_failure_calls: 0,
        }], []]
      }
      if (sql.includes('AS accepted_as_billed_calls')) {
        return [[{
          accepted_as_billed_calls: 0,
          final_calculation_calls: 1,
          calculated_total: '9.50',
          billable_minutes: '1',
          currency: 'INR',
        }], []]
      }
      return [[{ unresolved_decision_calls: 0 }], []]
    },
  } as unknown as Pool

  const readiness = await collectBillingReadiness(pool, {
    month: '2026-07',
    start: '2026-07-01',
    end: '2026-07-31',
    label: 'July 2026',
  })

  assert.equal(readiness.cycle.totalCalls, 1)
  assert.equal(statements.length, 4)
  assert.ok(statements.every((sql) => !sql.includes('COUNT(*) AS calculations')))
  assert.ok(statements.every((sql) => !sql.includes('authoritative_calculations')))
})
