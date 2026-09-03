import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { collectBilling } from './mysqlFullDashboard.ts'

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
