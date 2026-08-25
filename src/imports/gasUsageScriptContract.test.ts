import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'

const script = await readFile(
  new URL('../../integrations/google-apps-script/usage-import.gs', import.meta.url),
  'utf8',
)

test('GAS usage import retries blank K rows in bounded batches', () => {
  assert.match(script, /statusColumn:\s*11/)
  assert.match(script, /batchSize:\s*500/)
  assert.match(script, /status === ''/)
  assert.match(script, /submittedStatus:\s*'Submitted'/)
  assert.match(script, /receipt\.accepted.*receipt\.duplicates/s)
})

test('GAS usage import keeps credentials out of source and SQL out of GAS', () => {
  assert.match(script, /PropertiesService\.getScriptProperties\(\)/)
  assert.match(script, /KAUDIT_GAS_IMPORT_SECRET/)
  assert.doesNotMatch(script, /DB_(?:HOST|NAME|USER|PASSWORD)/)
  assert.doesNotMatch(script, /\b(?:SELECT|INSERT|UPDATE|DELETE)\b/i)
})

test('GAS usage import logs status only and never logs response prose', () => {
  assert.match(script, /submittedThisRun/)
  assert.match(script, /pendingRows/)
  assert.doesNotMatch(script, /console\.log\([^\n]*getContentText/)
})
