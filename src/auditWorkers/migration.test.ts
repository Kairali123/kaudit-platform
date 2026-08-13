import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sql = readFileSync(
  new URL('../../migrations/0012_automatic_audit_workers.sql', import.meta.url),
  'utf8',
)
const executableSql = sql.replace(/^\s*--.*$/gm, '')

test('automatic worker migration is expand-only and Kaudit-owned', () => {
  assert.match(sql, /CREATE TABLE `kaudit_audit_worker_control`/)
  assert.doesNotMatch(
    executableSql,
    /^\s*(?:ALTER|DROP|DELETE|UPDATE|REPLACE|TRUNCATE)\b/im,
  )
  assert.doesNotMatch(sql, /ai_voice_leads_received/i)
})

test('automatic worker migration defaults both systems to running', () => {
  assert.match(sql, /\('billing', 'running', 'idle'\)/)
  assert.match(sql, /\('call', 'running', 'idle'\)/)
  assert.match(sql, /PRIMARY KEY \(`audit_system`\)/)
})

test('worker state stores no content, provider response, prompt, URL, or money', () => {
  for (const forbidden of [
    'transcript',
    'prompt',
    'response_json',
    'source_url',
    'amount',
    'currency',
  ]) {
    assert.doesNotMatch(sql, new RegExp(`\\b${forbidden}\\b`, 'i'))
  }
})
