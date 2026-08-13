import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  parseAuditSystem,
  parseDesiredState,
  AuditWorkerControlError,
} from './control.ts'

test('worker control accepts only the two independent audit systems', () => {
  assert.equal(parseAuditSystem('billing'), 'billing')
  assert.equal(parseAuditSystem('call'), 'call')
  assert.throws(() => parseAuditSystem('all'), AuditWorkerControlError)
})

test('worker control accepts only running and paused administrator intent', () => {
  assert.equal(parseDesiredState('running'), 'running')
  assert.equal(parseDesiredState('paused'), 'paused')
  assert.throws(() => parseDesiredState('stopped'), AuditWorkerControlError)
})
