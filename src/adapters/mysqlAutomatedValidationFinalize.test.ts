import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import { finalizeAutomatedFindingStates } from './mysqlAutomatedValidation.ts'

/**
 * Per-call finalization after an accepted consensus. Recording fake pool;
 * every id and category is SYNTHETIC.
 */
function fakePool(primaryFindingCode: string) {
  const statements: Array<{ sql: string; parameters: unknown[] }> = []
  const run = async (sql: string, parameters: unknown[] = []) => {
    statements.push({ sql, parameters })
    if (/FROM kaudit_automated_decision decision_row/.test(sql)) {
      return [[{
        id: 'decision-1',
        call_id: 'call-1',
        audit_run_id: 'run-2',
        decision_output_sha256: 'b'.repeat(64),
        evidence_refs_json: '[]',
        decision_output_json: JSON.stringify({
          outcome: { selectedSource: 'secondary' },
          primary: { category: primaryFindingCode, confidence: '0.9', model: {} },
          secondary: { category: 'USER_SILENCE', confidence: '0.8', model: {} },
          adjudicator: null,
          policy: { version: 'synthetic' },
        }),
      }], []]
    }
    if (/FROM kaudit_audit_finding\s+WHERE call_id = \? AND audit_run_id = \? AND origin/.test(sql)) {
      return [[{
        id: 'finding-1', finding_code: primaryFindingCode, status: 'open',
        confirmation_status: 'model_output', root_cause_status: 'unknown',
      }], []]
    }
    if (/^\s*(INSERT|UPDATE)/i.test(sql)) return [{ affectedRows: 1 }, []]
    return [[], []]
  }
  const connection = {
    execute: run,
    query: run,
    beginTransaction: async () => {},
    commit: async () => {},
    rollback: async () => {},
    release: () => {},
  }
  return {
    pool: { execute: run, query: run, getConnection: async () => connection } as unknown as Pool,
    statements,
  }
}

test('the displayed category follows the billed consensus for that call only', async () => {
  const fake = fakePool('OK')
  const summary = await finalizeAutomatedFindingStates(fake.pool, { callIds: ['call-1'] })
  assert.deepEqual(summary, { confirmed: 0, rejected: 1, insertedReplacement: 1 })
  assert.deepEqual(fake.statements[0]?.parameters, ['call-1'])
  const update = fake.statements.find(({ sql }) => /UPDATE kaudit_call\s+SET canonical_outcome_code/.test(sql))
  // Guarded by the decision's audit run, so a newer audit is never overwritten.
  assert.deepEqual(update?.parameters, ['USER_SILENCE', 'call-1', 'run-2'])
})

test('an empty call scope reads nothing', async () => {
  const fake = fakePool('OK')
  assert.deepEqual(
    await finalizeAutomatedFindingStates(fake.pool, { callIds: [] }),
    { confirmed: 0, rejected: 0, insertedReplacement: 0 },
  )
  assert.equal(fake.statements.length, 0)
})
