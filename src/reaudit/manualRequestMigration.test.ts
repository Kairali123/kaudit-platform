import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  MAX_MANUAL_REAUDIT_ATTEMPTS,
  MAX_MANUAL_REAUDIT_CALLS,
} from './manualRequests.ts'

/**
 * Static contract for migration 0015.
 *
 * The migration is APPLIED AS A FILE ONLY here — nothing in this suite opens a
 * connection, and no statement in it is executed against any database. What is
 * pinned is the shape: expand-only, Kaudit-owned, blind to the external source
 * table, and carrying no content, money, or PII.
 */

const sql = readFileSync(
  new URL('../../migrations/0015_billing_reaudit_requests.sql', import.meta.url),
  'utf8',
)
/** Comments carry the rollback plan, so rules about statements ignore them. */
const executableSql = sql.replace(/^\s*--.*$/gm, '')

test('the re-audit queue migration is expand-only and Kaudit-owned', () => {
  assert.match(sql, /CREATE TABLE `kaudit_billing_reaudit_request`/)
  assert.match(sql, /CREATE TABLE `kaudit_billing_reaudit_item`/)
  assert.doesNotMatch(
    executableSql,
    /^\s*(?:ALTER|DROP|DELETE|UPDATE|REPLACE|TRUNCATE|INSERT)\b/im,
  )
  // The external source table is read-only and is not even named here.
  assert.doesNotMatch(sql, /ai_voice_leads_received/i)
})

test('one active re-audit per internal call is a schema guarantee', () => {
  assert.match(
    sql,
    /`active_call_id`[\s\S]{0,200}GENERATED ALWAYS AS[\s\S]{0,200}'queued','processing'/,
  )
  assert.match(sql, /UNIQUE KEY `uq_billing_reaudit_active_call` \(`active_call_id`\)/)
  // And one item per call within one request, so a retried body cannot fan out.
  assert.match(
    sql,
    /UNIQUE KEY `uq_billing_reaudit_request_call` \(`request_id`, `call_id`\)/,
  )
})

test('a retry key is unique and every item carries its baseline audit run', () => {
  assert.match(
    sql,
    /UNIQUE KEY `uq_billing_reaudit_request_key` \(`idempotency_key`\)/,
  )
  assert.match(sql, /`request_digest` char\(64\) NOT NULL/)
  assert.match(sql, /`baseline_audit_run_id` varchar\(36\) NOT NULL/)
  assert.match(
    sql,
    /FOREIGN KEY \(`baseline_audit_run_id`\) REFERENCES `kaudit_audit_run` \(`id`\)/,
  )
})

test('the API ceiling and single-claim policy are restated in the schema', () => {
  assert.match(
    sql,
    new RegExp(
      `CHECK \\(\`requested_count\` BETWEEN 1 AND ${MAX_MANUAL_REAUDIT_CALLS}\\)`,
    ),
  )
  assert.match(
    sql,
    new RegExp(
      `CHECK \\(\`attempt_count\` <= ${MAX_MANUAL_REAUDIT_ATTEMPTS}\\)`,
    ),
  )
})

test('both lifecycles are closed sets', () => {
  assert.match(
    sql,
    /CHECK \(`status` IN\s*\n?\s*\('queued','running','completed','completed_with_failures'\)\)/,
  )
  assert.match(
    sql,
    /CHECK \(`status` IN \('queued','processing','completed','skipped','failed'\)\)/,
  )
})

test('the queue stores no content, reference, URL, prompt, money, or PII', () => {
  // Read against the STATEMENTS. The file's own prose is allowed to name what
  // the tables deliberately exclude; no column, key, or constraint may.
  for (const forbidden of [
    'task_id',
    'external_id',
    'call_reference',
    'logical_call_key',
    'source_url',
    'recording',
    'transcript',
    'prompt',
    'response_json',
    'raw_response',
    'amount',
    'currency',
    'minutes',
    'phone',
    'email',
    'password',
    'token',
    'secret',
  ]) {
    assert.doesNotMatch(
      executableSql,
      new RegExp(`\\b${forbidden}\\b`, 'i'),
      `${forbidden} must not appear in the re-audit queue schema`,
    )
  }
})

test('the file states that it is applied only as a supervised operation', () => {
  assert.match(sql, /APPLY ONLY as an approved, supervised schema operation/)
  assert.match(sql, /Rollback BEFORE USE only/)
})
