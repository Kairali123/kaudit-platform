import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  KSERVE_SETTLEMENT_CURRENCY,
  MAX_ACTOR_ID_LENGTH,
  MAX_CORRELATION_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
} from './kserveSettlement.ts'

/**
 * Schema-contract test for migrations/0013_kserve_monthly_settlement.sql.
 *
 * It reads the migration as TEXT — no database connection, ever — and pins the
 * properties the settlement depends on:
 *
 *   * one additive table, no DDL on anything that already exists, and no data
 *     statement of any kind;
 *   * append-only by construction: no UPDATE path, no DELETE path, and no
 *     lifecycle flag that would require writing back onto a prior version;
 *   * the three keys that make "current version" derivable and race-free;
 *   * fixed-precision money, pinned currency, and a non-negative check;
 *   * column widths that match the application's own bounds, so a value this
 *     code accepts can never be silently truncated by the column;
 *   * no column that could hold call content, evidence, or an external
 *     identifier, and no reference to the external source table.
 *
 * Nothing real is read or written. Every value compared here is a module
 * constant.
 */

const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../migrations/0013_kserve_monthly_settlement.sql',
    import.meta.url,
  ),
)

const TABLE = 'kaudit_kserve_monthly_settlement'
const EXTERNAL_SOURCE_TABLE = 'ai_voice_leads_received'

const sql = readFileSync(MIGRATION_PATH, 'utf8')

/** The migration with every `--` comment line removed. */
const executableSql = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')

/** Body of the CREATE TABLE statement, without its trailing table options. */
const body = (() => {
  const start = executableSql.indexOf('CREATE TABLE `' + TABLE + '` (')
  assert.notEqual(start, -1, `migration does not create ${TABLE}`)
  const end = executableSql.indexOf('\n) ENGINE=', start)
  assert.notEqual(end, -1, 'no table options found')
  return executableSql.slice(start, end)
})()

const declaredColumns = body
  .split('\n')
  .map((line) => /^\s+`(\w+)`\s+\S/.exec(line))
  .filter((matched): matched is RegExpExecArray => matched !== null)
  .map((matched) => matched[1])

/**
 * The declared TYPE of every column, with COMMENT prose excluded. Column
 * comments legitimately use words like "float" to say what the column is not,
 * so a type check has to look at the type and nothing else.
 */
const declaredTypes = body
  .split('\n')
  .map((line) => /^\s+`\w+`\s+([^,]*?)(?:\s+COMMENT\b|,?\s*$)/.exec(line))
  .filter((matched): matched is RegExpExecArray => matched !== null)
  .map((matched) => matched[1])
  .join(' | ')

function columnLine(column: string): string {
  const line = body
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
  assert.ok(line, `${TABLE} is missing column ${column}`)
  return line
}

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

test('creates exactly one table and performs no DDL on a pre-existing one', () => {
  const created = [
    ...executableSql.matchAll(/CREATE TABLE\s+`([a-z0-9_]+)`/gi),
  ].map((match) => match[1])
  assert.deepEqual(created, [TABLE])

  for (const [, target] of executableSql.matchAll(
    /ALTER TABLE\s+`([a-z0-9_]+)`/gi,
  )) {
    assert.equal(target, TABLE, `migration alters ${target}`)
  }
  for (const preExisting of [
    'kaudit_user',
    'kaudit_call',
    'kaudit_provider_cost',
    'kaudit_billing_calculation',
    'kaudit_invoice',
    'kaudit_audit_log',
    'kaudit_call_audit_run',
    EXTERNAL_SOURCE_TABLE,
  ]) {
    assert.equal(
      new RegExp(
        '(?:CREATE|ALTER|DROP)\\s+TABLE\\s+`?' + preExisting + '`?',
      ).test(executableSql),
      false,
      `migration performs DDL on pre-existing table ${preExisting}`,
    )
  }
})

test('is expand only: no data statements and no destructive DDL', () => {
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+`?[a-z0-9_]+`?\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bDROP\s+(TABLE|COLUMN|DATABASE|INDEX)\b/i,
    /\bRENAME\s+TABLE\b/i,
    /\bREPLACE\s+INTO\b/i,
    /\bGRANT\b/i,
  ]) {
    assert.equal(
      forbidden.test(executableSql),
      false,
      `migration contains ${forbidden}`,
    )
  }
})

test('never references the external read-only source table', () => {
  assert.equal(
    executableSql.includes(EXTERNAL_SOURCE_TABLE),
    false,
    'migration names the external source table',
  )
})

// ---------------------------------------------------------------------------
// Append-only
// ---------------------------------------------------------------------------

test('has no column that would require rewriting a prior version', () => {
  // Each of these is a lifecycle flag whose maintenance means UPDATE-ing a row
  // that has already been recorded as financial history.
  for (const forbidden of [
    'is_current',
    'current',
    'superseded_by_settlement_id',
    'superseded_at',
    'voided',
    'void_reason',
    'deleted_at',
    'updated_at',
    'status',
  ]) {
    assert.equal(
      declaredColumns.includes(forbidden),
      false,
      `${forbidden} would make a prior version mutable`,
    )
  }
})

test('the supersession chain is linear and rooted', () => {
  // At most one version per (month, version): two concurrent corrections
  // cannot both become the next version.
  assert.match(
    body,
    /UNIQUE KEY `uq_kserve_settlement_month_version` \(`bill_month`, `version_no`\)/,
  )
  // A version may be superseded at most once, so the chain cannot fork.
  assert.match(
    body,
    /UNIQUE KEY `uq_kserve_settlement_supersedes` \(`supersedes_settlement_id`\)/,
  )
  // Version 1 is the root; every later version names its predecessor.
  assert.match(body, /CONSTRAINT `chk_kserve_settlement_chain`/)
  assert.match(
    body,
    /`version_no` = 1 AND `supersedes_settlement_id` IS NULL/,
  )
  assert.match(
    body,
    /`version_no` > 1 AND `supersedes_settlement_id` IS NOT NULL/,
  )
  // The only foreign key points back at this same table.
  const references = [
    ...executableSql.matchAll(/REFERENCES\s+`([a-z0-9_]+)`/gi),
  ].map((match) => match[1])
  assert.deepEqual(references, [TABLE])
})

test('a retry cannot create duplicate financial history', () => {
  assert.match(
    body,
    /UNIQUE KEY `uq_kserve_settlement_month_key` \(`bill_month`, `idempotency_key`\)/,
  )
  assert.match(columnLine('request_digest'), /char\(64\) NOT NULL/)
})

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

test('money is fixed precision, non-negative, and INR only', () => {
  assert.match(columnLine('final_paid_amount'), /decimal\(20,8\) NOT NULL/)
  for (const floating of [/\bfloat\b/i, /\bdouble\b/i, /\breal\b/i]) {
    assert.equal(
      floating.test(declaredTypes),
      false,
      `a column type uses ${floating}`,
    )
  }
  assert.match(body, /CONSTRAINT `chk_kserve_settlement_amount_non_negative`/)
  assert.match(body, /CHECK \(`final_paid_amount` >= 0\)/)
  assert.match(
    body,
    new RegExp(
      "CHECK \\(`currency` = '" + KSERVE_SETTLEMENT_CURRENCY + "'\\)",
    ),
  )
})

test('the period identity is a whole month, stated explicitly', () => {
  assert.match(columnLine('bill_month'), /char\(7\) NOT NULL/)
  assert.match(columnLine('period_start'), /date NOT NULL/)
  assert.match(columnLine('period_end'), /date NOT NULL/)
  assert.match(body, /CONSTRAINT `chk_kserve_settlement_period_order`/)
})

// ---------------------------------------------------------------------------
// Column widths match the application's own bounds
// ---------------------------------------------------------------------------

test('column widths match the bounds the repository enforces', () => {
  assert.match(
    columnLine('idempotency_key'),
    new RegExp('varchar\\(' + MAX_IDEMPOTENCY_KEY_LENGTH + '\\) NOT NULL'),
  )
  assert.match(
    columnLine('recorded_by_user_id'),
    new RegExp('varchar\\(' + MAX_ACTOR_ID_LENGTH + '\\) DEFAULT NULL'),
  )
  assert.match(
    columnLine('correlation_id'),
    new RegExp('varchar\\(' + MAX_CORRELATION_ID_LENGTH + '\\) DEFAULT NULL'),
  )
  // The deterministic id is prefix + 36 hex characters: the column exactly.
  assert.match(columnLine('id'), /varchar\(40\) NOT NULL/)
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test('no column could hold call content, evidence, or an external identifier', () => {
  const allowed = new Set([
    'id',
    'bill_month',
    'period_start',
    'period_end',
    'currency',
    'final_paid_amount',
    'version_no',
    'supersedes_settlement_id',
    'idempotency_key',
    'request_digest',
    'recorded_by_user_id',
    'correlation_id',
    'recorded_at',
    'created_at',
  ])
  for (const column of declaredColumns) {
    assert.ok(allowed.has(column), `unexpected column ${column}`)
  }
  for (const forbidden of [
    /transcript/i,
    /recording/i,
    /source_url/i,
    /\bprompt\b/i,
    /lead_id/i,
    /task_id/i,
    /phone/i,
    /email/i,
    /sha256/i,
    /call_id/i,
    /token/i,
  ]) {
    assert.equal(
      forbidden.test(declaredColumns.join(' ')),
      false,
      `a column name matches ${forbidden}`,
    )
  }
})

test('provenance is present but is never a display name', () => {
  // The actor is a kaudit_user.id and there is deliberately no FK: this
  // financial history outlives the accounts that produced it.
  assert.match(sql, /kaudit_user\.id/)
  assert.equal(/REFERENCES\s+`kaudit_user`/.test(executableSql), false)
  assert.match(columnLine('recorded_at'), /datetime\(6\) NOT NULL/)
  assert.match(columnLine('created_at'), /datetime\(6\) NOT NULL DEFAULT/)
})
