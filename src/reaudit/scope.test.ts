import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  AuditScopeError,
  normalizeTaskIdScope,
  parseRecordingBackedTaskIds,
} from './scope.ts'

test('reads only recording-backed task IDs from a synthetic cleanup manifest', () => {
  const taskIds = parseRecordingBackedTaskIds(
    JSON.stringify({
      target: {
        taskIds: ['recording-1|1', 'missing-1|1'],
        recordingBackedTaskIds: ['recording-1|1', 'recording-2|1'],
        noRecordingTaskIds: ['missing-1|1'],
      },
    }),
  )
  assert.deepEqual(taskIds, ['recording-1|1', 'recording-2|1'])
})

test('rejects an empty, duplicate, or malformed task scope', () => {
  assert.throws(() => normalizeTaskIdScope([]), AuditScopeError)
  assert.throws(
    () => normalizeTaskIdScope(['duplicate|1', 'duplicate|1']),
    AuditScopeError,
  )
  assert.throws(
    () => parseRecordingBackedTaskIds('{"target":{"taskIds":[]}}'),
    AuditScopeError,
  )
})
