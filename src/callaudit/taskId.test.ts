import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractTaskId } from './taskId.ts'

test('takes the final hyphen segment of a lead ID as the Task ID', () => {
  assert.equal(extractTaskId('LEAD-2026-000123'), '000123')
  assert.equal(extractTaskId('KS-42'), '42')
  assert.equal(extractTaskId('a-b-c-d'), 'd')
})

test('treats a lead ID without a hyphen as its own Task ID', () => {
  assert.equal(extractTaskId('000123'), '000123')
})

test('trims whitespace around the lead ID and the final segment', () => {
  assert.equal(extractTaskId('  LEAD-2026-000123  '), '000123')
  assert.equal(extractTaskId('LEAD-2026-  000123  '), '000123')
  assert.equal(extractTaskId('\tLEAD-\n000123\n'), '000123')
})

test('returns null when no Task ID can be derived', () => {
  assert.equal(extractTaskId(null), null)
  assert.equal(extractTaskId(undefined), null)
  assert.equal(extractTaskId(''), null)
  assert.equal(extractTaskId('   '), null)
  assert.equal(extractTaskId('\t\n'), null)
  assert.equal(extractTaskId('LEAD-2026-'), null)
  assert.equal(extractTaskId('LEAD-2026-   '), null)
  assert.equal(extractTaskId('-'), null)
})

test('keeps a leading empty segment from breaking extraction', () => {
  assert.equal(extractTaskId('-000123'), '000123')
  assert.equal(extractTaskId('--000123'), '000123')
})

test('does not interpret the Task ID beyond trimming', () => {
  assert.equal(extractTaskId('LEAD-2026-000123 456'), '000123 456')
  assert.equal(extractTaskId('LEAD-2026-Ab_9'), 'Ab_9')
  assert.equal(extractTaskId('LEAD-2026-0'), '0')
})

test('is deterministic for repeated calls', () => {
  const leadId = ' LEAD-2026-000123 '
  assert.equal(extractTaskId(leadId), extractTaskId(leadId))
})
