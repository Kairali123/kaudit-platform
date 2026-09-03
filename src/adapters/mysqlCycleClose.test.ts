import assert from 'node:assert/strict'
import test from 'node:test'
import type { Pool } from 'mysql2/promise'
import { listAcceptedAsBilledCandidates } from './mysqlCycleClose.ts'

test('cycle close admits recording-backed calls only after audit exhaustion', async () => {
  let statement = ''
  const pool = {
    async execute(sql: string) {
      statement = sql
      return [[]]
    },
  } as unknown as Pool

  await listAcceptedAsBilledCandidates(pool, {
    month: '2026-06',
    label: 'June 2026',
    start: '2026-06-01',
    end: '2026-06-30',
  }, 100)

  assert.match(
    statement,
    /exhausted_recording\.audio_processing_status = 'exhausted'/,
  )
  assert.match(statement, /exhausted_recording\.source_url IS NOT NULL/)
  assert.doesNotMatch(
    statement,
    /audio_processing_status IN \('pending','transcribe_failed'/,
  )
})
