import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

const commandPath = new URL(
  '../../scripts/apply-billing-read-indexes.mjs',
  import.meta.url,
)
const command = await readFile(commandPath, 'utf8')
const migrations = await Promise.all([
  readFile(new URL('../../migrations/0014_dashboard_read_indexes.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../migrations/0016_billing_category_analysis_indexes.sql', import.meta.url), 'utf8'),
  readFile(new URL('../../migrations/0018_billing_cycle_read_indexes.sql', import.meta.url), 'utf8'),
])

test('billing read index application requires an exact confirmation', () => {
  const result = spawnSync(process.execPath, [commandPath.pathname], {
    env: {},
    encoding: 'utf8',
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(
    result.stderr.trim(),
    JSON.stringify({
      migration: 'billing-read-indexes',
      result: 'failed',
      stage: 'confirmation',
      applied: 0,
    }),
  )
})

test('billing read index application is allowlisted and online-only', () => {
  assert.match(command, /APPLY_BILLING_READ_INDEXES/)
  assert.match(command, /ALGORITHM=INPLACE, LOCK=NONE/)
  assert.match(command, /FROM information_schema\.STATISTICS/)
  assert.doesNotMatch(
    command,
    /OPENAI_API_KEY|source_url|transcript_text|audio_bytes|recording_url/i,
  )
  assert.doesNotMatch(
    command,
    /[`'"]\s*(?:INSERT|UPDATE|DELETE|DROP|TRUNCATE|REPLACE)\b/i,
  )
  assert.equal((command.match(/ADD KEY/g) ?? []).length, 10)
})

test('the supervised command covers exactly the three read-index migrations', () => {
  const names = (source: string) => [...source.matchAll(/ADD KEY `([^`]+)`/g)]
    .map((match) => match[1])
    .sort()
  assert.deepEqual(names(command), names(migrations.join('\n')))
})
