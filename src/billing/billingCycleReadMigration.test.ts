import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(
  new URL(
    '../../migrations/0018_billing_cycle_read_indexes.sql',
    import.meta.url,
  ),
  'utf8',
)
const executableSql = sql.replace(/^\s*--.*$/gm, '')

test('billing-cycle read migration adds the exact audit-run covering index', () => {
  assert.match(
    executableSql,
    /ALTER TABLE `kaudit_audit_run`\s+ADD KEY `idx_audit_run_call_engine_status`\s+\(`call_id`, `engine_version`, `status`\)/,
  )
  assert.doesNotMatch(executableSql, /ALTER TABLE `kaudit_automated_decision`/)
})

test('billing-cycle read migration is additive and touches no evidence rows', () => {
  assert.doesNotMatch(
    executableSql,
    /^\s*(?:DROP|DELETE|INSERT|UPDATE|REPLACE|TRUNCATE)\b/im,
  )
  assert.doesNotMatch(sql, /ai_voice_leads_received/i)
})
