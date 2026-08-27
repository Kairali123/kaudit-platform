import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/apply-billing-spend-lease-migration.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')

test('spend lease migration command requires explicit 0017 confirmation', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })

  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({ migration: '0017', result: 'failed', stage: 'confirmation' }),
  )
})

test('spend lease migration command verifies the complete schema contract', () => {
  assert.match(command, /KAUDIT_MIGRATION_CONFIRM !== 'APPLY_0017'/)
  assert.match(command, /PREREQUISITE_TABLE = 'kaudit_billing_reaudit_item'/)
  assert.match(command, /information_schema\.COLUMNS/)
  assert.match(command, /information_schema\.STATISTICS/)
  assert.match(command, /information_schema\.TABLE_CONSTRAINTS/)
  assert.match(command, /information_schema\.KEY_COLUMN_USAGE/)
  assert.match(command, /information_schema\.CHECK_CONSTRAINTS/)
  assert.match(command, /chk_billing_spend_lease_attempts/)
  assert.match(command, /fk_billing_spend_lease_manual_item/)
  assert.match(command, /setStage\('verify-check'\)/)
  assert.doesNotMatch(command, /console\.(?:error|log)\([^\n]*error/i)
})
