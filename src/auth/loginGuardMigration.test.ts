import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  deriveLoginGuardDigest,
  deriveLoginGuardSecret,
  LOGIN_GUARD_DIGEST_LENGTH,
  LOGIN_GUARD_MAX_FAILURE_COUNT,
  LOGIN_GUARD_SCOPES,
} from './loginService.ts'

/**
 * Schema-contract test for migrations/0010_create_login_guard.sql.
 *
 * It reads the migration as text — no database connection, ever — and pins the
 * properties the throttle depends on and the properties that keep the table
 * from becoming a record of who tried to sign in from where: one additive
 * table, no data or destructive statement, a composite key of scope and keyed
 * digest, a digest column that can only hold a lowercase SHA-256, exactly the
 * two scopes the application knows, a bounded counter, a retention bound that
 * is indexed, no foreign key, and no column that could hold an identifier, a
 * network value, or credential material.
 *
 * Everything compared against the application here comes from module constants
 * or a digest derived from a synthetic secret. Nothing real is read or written.
 */

const MIGRATION_PATH = fileURLToPath(
  new URL('../../migrations/0010_create_login_guard.sql', import.meta.url),
)

const TABLE = 'kaudit_login_guard'
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

/** Every column the table actually declares, in declaration order. */
const declaredColumns = body
  .split('\n')
  .map((line) => /^\s+`(\w+)`\s+\S/.exec(line))
  .filter((matched): matched is RegExpExecArray => matched !== null)
  .map((matched) => matched[1])

function hasColumn(column: string): boolean {
  return declaredColumns.includes(column)
}

function columnLine(column: string): string {
  const line = body
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
  assert.ok(line, `${TABLE} is missing column ${column}`)
  return line
}

// ---------------------------------------------------------------------------
// Shape: one additive table, and nothing that touches data
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
    'kaudit_user_credential',
    'kaudit_user_role',
    'kaudit_audit_log',
    'kaudit_call',
    'kaudit_evidence_object',
  ]) {
    assert.equal(
      new RegExp(
        '(?:CREATE|ALTER|DROP)\\s+TABLE\\s+`' + preExisting + '`',
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
    /\bSELECT\b/i,
  ]) {
    assert.equal(
      forbidden.test(executableSql),
      false,
      `migration contains forbidden statement ${forbidden}`,
    )
  }
})

test('every table it names is a kaudit_ table', () => {
  for (const [, named] of executableSql.matchAll(
    /(?:CREATE|ALTER|DROP)\s+TABLE\s+`([a-z0-9_]+)`/gi,
  )) {
    assert.match(named, /^kaudit_/, `names non-kaudit table ${named}`)
  }
})

// ---------------------------------------------------------------------------
// The composite key: one row per (scope, keyed digest)
// ---------------------------------------------------------------------------

test('the primary key is exactly the scope and the keyed digest', () => {
  const keys = [...body.matchAll(/PRIMARY KEY \(([^)]*)\)/g)]
  assert.equal(keys.length, 1)
  assert.equal(keys[0][1], '`guard_scope`, `guard_digest`')
  // A surrogate id would let one guard hold two rows, and the atomic upsert
  // the failure path depends on would stop being atomic.
  assert.equal(hasColumn('id'), false)
})

test('the digest column can hold nothing but a lowercase SHA-256', () => {
  assert.match(columnLine('guard_digest'), /char\(64\)/)
  assert.match(
    body,
    /`guard_digest` char\(64\)\s*\n\s*CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/,
  )
  assert.match(body, /CHAR_LENGTH\(`guard_digest`\) = 64/)

  const matched = /`guard_digest` REGEXP '(\^[^']+\$)'/.exec(body)
  assert.ok(matched, 'the digest CHECK must pin a hex pattern')
  const pattern = new RegExp(matched[1])

  // What the application actually produces must be storable, and nothing that
  // could carry a pre-image may be.
  const digest = deriveLoginGuardDigest(
    LOGIN_GUARD_SCOPES.login,
    'sample.operator',
    deriveLoginGuardSecret('synthetic-login-guard-secret-0123456789'),
  )
  assert.equal(digest.length, LOGIN_GUARD_DIGEST_LENGTH)
  assert.equal(pattern.test(digest), true)
  for (const rejected of [
    digest.toUpperCase(),
    digest.slice(0, 63),
    digest + 'a',
    'sample.operator',
    'sample.operator@example.invalid',
    '203.0.113.7',
  ]) {
    assert.equal(pattern.test(rejected), false, rejected)
  }
})

// ---------------------------------------------------------------------------
// Two fixed scopes, and a counter that stays a counter
// ---------------------------------------------------------------------------

test('the scope column holds exactly the two scopes the application knows', () => {
  const matched = /CHECK \(`guard_scope` IN \(([^)]*)\)\)/.exec(body)
  assert.ok(matched, 'the scope CHECK must pin a fixed vocabulary')
  const scopes = matched[1]
    .split(',')
    .map((value) => value.trim().replace(/^'|'$/g, ''))
  assert.deepEqual(scopes.sort(), Object.values(LOGIN_GUARD_SCOPES).sort())
  assert.match(
    body,
    /`guard_scope` varchar\(16\)\s*\n\s*CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/,
  )
})

test('the failure counter is a bounded unsigned integer', () => {
  assert.match(columnLine('failure_count'), /int unsigned NOT NULL DEFAULT 0/)
  const matched = /CHECK \(`failure_count` BETWEEN (\d+) AND (\d+)\)/.exec(body)
  assert.ok(matched, 'the counter must be bounded by a CHECK')
  assert.equal(Number(matched[1]), 0)
  assert.equal(Number(matched[2]), LOGIN_GUARD_MAX_FAILURE_COUNT)
})

// ---------------------------------------------------------------------------
// Retention: a row must always be deletable in bounded time
// ---------------------------------------------------------------------------

test('the retention bound exists, is indexed, and outlives the window it starts', () => {
  assert.match(columnLine('expires_at'), /datetime\(6\) NOT NULL/)
  assert.match(body, /KEY `idx_login_guard_expiry` \(`expires_at`\)/)
  assert.match(body, /CHECK \(`expires_at` > `window_started_at`\)/)
  // Every declared *_at column, at the precision the rest of the schema uses.
  for (const column of declaredColumns.filter((name) => name.endsWith('_at'))) {
    assert.match(columnLine(column), /datetime\(6\)/, column)
  }
  assert.match(columnLine('blocked_until'), /datetime\(6\) DEFAULT NULL/)
})

// ---------------------------------------------------------------------------
// Standalone: written on unauthenticated requests, so it references nothing
// ---------------------------------------------------------------------------

test('the table has no foreign key, so a throttle write locks nothing else', () => {
  assert.equal(/\bFOREIGN KEY\b/i.test(executableSql), false)
  assert.equal(/\bREFERENCES\b/i.test(executableSql), false)
  assert.equal(/\bON DELETE\b/i.test(executableSql), false)
})

test('nothing here references CRM, an external table, or a non-kaudit schema', () => {
  const lowered = sql.toLowerCase()
  for (const forbidden of ['kcrm', EXTERNAL_SOURCE_TABLE, 'crm_']) {
    assert.equal(
      lowered.includes(forbidden),
      false,
      `migration must not reference ${forbidden}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Counters and instants only — never a pre-image
// ---------------------------------------------------------------------------

test('the table declares counters, windows, and timestamps, and nothing else', () => {
  assert.deepEqual(declaredColumns, [
    'guard_scope',
    'guard_digest',
    'failure_count',
    'window_started_at',
    'last_failure_at',
    'blocked_until',
    'expires_at',
    'created_at',
    'updated_at',
  ])
})

test('no column could hold an identifier, a network value, or credential material', () => {
  for (const forbidden of [
    'username',
    'username_normalized',
    'login',
    'login_identifier',
    'email',
    'display_name',
    'phone',
    'user_id',
    'actor_user_id',
    'ip',
    'ip_address',
    'client_ip',
    'remote_addr',
    'forwarded_for',
    'x_forwarded_for',
    'user_agent',
    'request_header',
    'password',
    'password_hash',
    'secret',
    'session_token',
    'token',
    'api_key',
    'guard_value',
    'guard_source',
  ]) {
    assert.equal(hasColumn(forbidden), false, `${TABLE} must not store ${forbidden}`)
  }
})

// ---------------------------------------------------------------------------
// Repository conventions
// ---------------------------------------------------------------------------

test('follows the InnoDB utf8mb4 convention and documents its own rollback', () => {
  assert.match(
    executableSql,
    /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci/,
  )
  assert.match(sql, /EXPAND ONLY/)
  assert.match(sql, /VERIFY \(read-only\):/)
  assert.match(sql, /DOWN \(rollback/)
  assert.match(sql, /Forward-fix policy:/)
})
