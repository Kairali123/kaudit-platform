import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  LATE_RECORDING_ITEM_STATES,
  MAX_LATE_RECORDING_ROWS,
} from './corrections.ts'
// The migration runner is plain Node.js; this pure helper intentionally has no
// database or environment side effects.
// @ts-expect-error JavaScript helper has no separate declaration file.
import { planCreateTables } from '../../scripts/expand-migration-plan.mjs'

/**
 * Static contract for migration 0020.
 *
 * The migration is READ AS A FILE ONLY — nothing in this suite opens a
 * connection, and no statement in it is executed against any database. What is
 * pinned is the shape: expand-only, Kaudit-owned, append-only where it holds
 * money, blind to the external source table, and carrying no URL.
 */

const sql = readFileSync(
  new URL('../../migrations/0020_late_recording_corrections.sql', import.meta.url),
  'utf8',
)
/** Comments carry the rollback plan, so rules about statements ignore them. */
const executableSql = sql.replace(/^\s*--.*$/gm, '')

test('the late-recording migration is expand-only and Kaudit-owned', () => {
  assert.match(sql, /CREATE TABLE `kaudit_late_recording_batch`/)
  assert.match(sql, /CREATE TABLE `kaudit_late_recording_item`/)
  assert.match(
    sql,
    /CREATE TABLE `kaudit_late_recording_month_correction`/,
  )
  assert.doesNotMatch(
    executableSql,
    /^\s*(?:ALTER|DROP|DELETE|UPDATE|REPLACE|TRUNCATE|INSERT)\b/im,
  )
  // The external source table is read-only. No statement names it; the only
  // mention is the forward-fix policy comment forbidding one.
  assert.doesNotMatch(executableSql, /ai_voice_leads_received/i)
})

test('no table in this migration can hold a recording URL', () => {
  // The single home of a canonical URL is kaudit_call_artifact.source_url.
  // A column here that could hold one is the failure this test exists to catch.
  assert.doesNotMatch(executableSql, /`[a-z_]*url[a-z_]*`\s+(?:var)?char/i)
  assert.match(
    executableSql,
    /`canonical_url_sha256` char\(64\) NOT NULL/,
  )
  assert.match(executableSql, /`source_file_sha256` char\(64\) NOT NULL/)
  assert.doesNotMatch(executableSql, /https?:/i)
})

test('one active item per internal call is a schema guarantee', () => {
  assert.match(
    sql,
    /`active_call_id`[\s\S]{0,240}GENERATED ALWAYS AS[\s\S]{0,240}'accepted','auditing'/,
  )
  assert.match(
    sql,
    /UNIQUE KEY `uq_late_recording_active_call` \(`active_call_id`\)/,
  )
  // And one item per call within one batch, so a retried body cannot fan out.
  assert.match(
    sql,
    /UNIQUE KEY `uq_late_recording_batch_call` \(`batch_id`, `call_id`\)/,
  )
})

test('the item lifecycle in the schema matches the one the code uses', () => {
  const states = LATE_RECORDING_ITEM_STATES.map(
    (state) => `'${state}'`,
  ).join(',')
  assert.match(
    sql,
    new RegExp(`chk_late_recording_item_state[\\s\\S]{0,120}${states}`),
  )
})

test('a retry key is unique and the batch is bounded in the schema too', () => {
  assert.match(
    sql,
    /UNIQUE KEY `uq_late_recording_batch_key` \(`idempotency_key`\)/,
  )
  assert.match(
    sql,
    new RegExp(
      `chk_late_recording_batch_count[\\s\\S]{0,140}BETWEEN 1 AND ${MAX_LATE_RECORDING_ROWS}`,
    ),
  )
})

test('the month correction is append-only, fixed precision, and INR', () => {
  for (const column of [
    'previous_verified_total',
    'revised_verified_total',
    'delta_amount',
  ]) {
    assert.match(
      sql,
      new RegExp(`\`${column}\` decimal\\(20,8\\) NOT NULL`),
    )
  }
  assert.match(sql, /chk_late_recording_correction_currency[\s\S]{0,80}'INR'/)
  // One correction result per batch: a retried finalize replays it.
  assert.match(
    sql,
    /UNIQUE KEY `uq_late_recording_correction_batch` \(`batch_id`\)/,
  )
  // No updated_at anywhere in the append-only table.
  const correction = sql.slice(
    sql.indexOf('CREATE TABLE `kaudit_late_recording_month_correction`'),
  )
  assert.doesNotMatch(correction, /`updated_at`/)
})

test('nothing here references or writes the actual-paid settlement table', () => {
  // Finance's own record of what was PAID is never touched by this workflow.
  assert.doesNotMatch(
    executableSql,
    /REFERENCES `kaudit_kserve_monthly_settlement`/,
  )
})

test('a partial three-table migration retries only the missing tables', () => {
  const statements = [
    'CREATE TABLE `kaudit_late_recording_batch` (`id` int)',
    'CREATE TABLE `kaudit_late_recording_item` (`id` int)',
    'CREATE TABLE `kaudit_late_recording_month_correction` (`id` int)',
  ]
  const plan = planCreateTables(statements, [
    'kaudit_late_recording_batch',
  ])
  assert.deepEqual(plan?.tables, [
    'kaudit_late_recording_batch',
    'kaudit_late_recording_item',
    'kaudit_late_recording_month_correction',
  ])
  assert.deepEqual(
    plan?.missing.map((entry: { table: string }) => entry.table),
    ['kaudit_late_recording_item', 'kaudit_late_recording_month_correction'],
  )
  assert.deepEqual(planCreateTables(statements, plan?.tables ?? [])?.missing, [])
})
