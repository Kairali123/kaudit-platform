import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { normalizeUsername } from './credentialIdentity.ts'

/**
 * Schema-contract test for migrations/0009_create_user_credential.sql.
 *
 * It reads the migration as text — no database connection, ever — and pins the
 * contracts a future login route depends on: one credential per user, a
 * duplicate-proof normalized username, a one-way hash, the session-revocation
 * counter, disable-or-tombstone instead of deletion, and the absence of any
 * reference to a table outside the kaudit_* schema.
 */

const MIGRATION_PATH = fileURLToPath(
  new URL('../../migrations/0009_create_user_credential.sql', import.meta.url),
)
const MIGRATION_0003_PATH = fileURLToPath(
  new URL('../../migrations/0003_create_user_and_roles.sql', import.meta.url),
)

const TABLE = 'kaudit_user_credential'
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

function hasColumn(column: string): boolean {
  return new RegExp('^\\s+`' + column + '`\\s+\\S', 'm').test(body)
}

function columnLine(column: string): string {
  const line = body
    .split('\n')
    .find((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
  assert.ok(line, `${TABLE} is missing column ${column}`)
  return line
}

// ---------------------------------------------------------------------------
// Shape: additive, reviewable, and scoped to one new table
// ---------------------------------------------------------------------------

test('creates exactly one table and touches no pre-existing one', () => {
  const created = [...executableSql.matchAll(/CREATE TABLE\s+`([a-z0-9_]+)`/gi)]
    .map((match) => match[1])
  assert.deepEqual(created, [TABLE])

  // The only ALTER TABLE targets are the new table itself.
  for (const [, target] of executableSql.matchAll(
    /ALTER TABLE\s+`([a-z0-9_]+)`/gi,
  )) {
    assert.equal(target, TABLE, `migration alters ${target}`)
  }
  for (const preExisting of [
    'kaudit_user',
    'kaudit_user_role',
    'kaudit_call',
    'kaudit_evidence_object',
    'kaudit_security_audit_event',
  ]) {
    assert.equal(
      new RegExp('(?:CREATE|ALTER|DROP)\\s+TABLE\\s+`' + preExisting + '`').test(
        executableSql,
      ),
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
      `migration contains forbidden statement ${forbidden}`,
    )
  }
})

test('migration 0003 is left exactly as it was', () => {
  // The credential table is additive: 0003 defines kaudit_user and must not be
  // edited to carry login columns.
  const original = readFileSync(MIGRATION_0003_PATH, 'utf8')
  assert.equal(original.includes('password'), false)
  assert.equal(original.includes('username'), false)
  assert.equal(original.includes('session_version'), false)
})

// ---------------------------------------------------------------------------
// One credential per user, linked only to kaudit_user
// ---------------------------------------------------------------------------

test('the primary key makes one credential per user structurally impossible to break', () => {
  assert.match(columnLine('user_id'), /varchar\(40\) NOT NULL/)
  assert.match(body, /PRIMARY KEY \(`user_id`\)/)
  // A surrogate id would allow two credential rows for the same person.
  assert.equal(hasColumn('id'), false)
})

test('the only foreign key points at kaudit_user, and never cascades a delete', () => {
  const references = [
    ...executableSql.matchAll(
      /FOREIGN KEY \(`([a-z_]+)`\) REFERENCES `([a-z0-9_]+)` \(`([a-z_]+)`\)/g,
    ),
  ]
  assert.equal(references.length, 1)
  assert.deepEqual(references[0].slice(1), ['user_id', 'kaudit_user', 'id'])
  // RESTRICT (the default) is what stops a user row from being deleted out from
  // under the audit history that names them.
  assert.equal(/ON DELETE\s+CASCADE/i.test(executableSql), false)
  assert.equal(/ON DELETE\s+SET NULL/i.test(executableSql), false)
})

test('nothing here references an external or non-kaudit table', () => {
  for (const [, referenced] of executableSql.matchAll(
    /REFERENCES `([a-z0-9_]+)`/g,
  )) {
    assert.match(referenced, /^kaudit_/, `references non-kaudit table ${referenced}`)
  }
  // The external call source is never named as an identifier or a target.
  const withoutLiterals = executableSql.replace(/'[^']*'/g, "''")
  assert.equal(withoutLiterals.includes(EXTERNAL_SOURCE_TABLE), false)
  assert.equal(sql.includes('`' + EXTERNAL_SOURCE_TABLE + '`'), false)
  assert.equal(/\bkcrm\b/i.test(executableSql), false)
})

// ---------------------------------------------------------------------------
// Duplicate-safe, case-normalized username
// ---------------------------------------------------------------------------

test('the username is unique and stored already normalized', () => {
  assert.match(
    columnLine('username_normalized'),
    /varchar\(64\)/,
  )
  assert.match(
    body,
    /UNIQUE KEY `uq_user_credential_username` \(`username_normalized`\)/,
  )
  // utf8mb4_bin makes both the unique key and the lowercase CHECK exact; under
  // a case-insensitive collation the CHECK below would be vacuously true.
  assert.match(body, /`username_normalized` varchar\(64\)\s*\n\s*CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/)
  assert.match(
    body,
    /CONSTRAINT `ck_user_credential_username_normalized`\s*\n?\s*CHECK \(`username_normalized` = LOWER\(`username_normalized`\)\)/,
  )
})

/** The username CHECK, from its constraint name to the end of that clause. */
const usernameShapeCheck = body.slice(
  body.indexOf('ck_user_credential_username_shape'),
)

test('a username can never contain an @ and so can never shadow an email', () => {
  assert.match(
    usernameShapeCheck,
    /CHAR_LENGTH\(`username_normalized`\) BETWEEN 3 AND 64/,
  )
  assert.match(usernameShapeCheck, /`username_normalized` NOT LIKE '%@%'/)
  assert.match(usernameShapeCheck, /`username_normalized` NOT LIKE '% %'/)
})

test('the username CHECK enforces the application pattern, not just @ and space', () => {
  // Excluding '@' and ' ' alone would let the table hold handles no login could
  // ever resolve. The CHECK must pin the pattern normalizeUsername produces.
  const matched = /REGEXP '(\^[^']+\$)'/.exec(usernameShapeCheck)
  assert.ok(matched, 'the username CHECK must pin the application pattern')
  const pattern = new RegExp(matched[1])

  // A handle is storable exactly when it is ALREADY its own normalized form:
  // the column holds the normalized value, so 'Admin' belongs to the login box,
  // not to the row.
  const isStorableHandle = (value: string): boolean => {
    try {
      return normalizeUsername(value) === value
    } catch {
      return false
    }
  }

  for (const handle of [
    'adm',
    'audit.admin',
    'audit_admin',
    'a-b-c',
    'a1.b_2-c3',
    '0admin9',
    'a--b',
    'a'.repeat(64),
    // Everything below must be refused by the database, not merely by the app.
    '',
    'ab',
    'a'.repeat(65),
    '.admin',
    'admin.',
    '_admin',
    'admin-',
    '-admin',
    'Admin',
    'ad min',
    ' admin',
    'admin@example.test',
    'ad$min',
    'ad/min',
    'ädmin',
  ]) {
    assert.equal(
      pattern.test(handle),
      isStorableHandle(handle),
      `CHECK and normalizeUsername disagree on ${JSON.stringify(handle)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// One-way password material only
// ---------------------------------------------------------------------------

test('the password is stored as a one-way hash, never as a recoverable value', () => {
  assert.match(columnLine('password_hash'), /varchar\(255\)/)
  assert.match(body, /`password_hash` varchar\(255\)\s*\n\s*CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/)
  assert.match(
    body,
    /CONSTRAINT `ck_user_credential_password_hash`\s*\n?\s*CHECK \(CHAR_LENGTH\(`password_hash`\) >= 40\)/,
  )
  for (const forbidden of [
    'password',
    'password_plain',
    'plaintext_password',
    'password_encrypted',
    'password_hint',
    'password_reset_token',
    'secret',
    'api_key',
    'totp_secret',
  ]) {
    assert.equal(hasColumn(forbidden), false, `${TABLE} must not store ${forbidden}`)
  }
  assert.match(sql, /ONE-WAY salted scrypt hash/)
})

test('the credential table holds no identity attribute that belongs on kaudit_user', () => {
  for (const forbidden of [
    'email',
    'display_name',
    'oidc_issuer',
    'oidc_subject',
    'max_sensitivity_tier',
    'role_code',
    'phone',
    'mobile',
  ]) {
    assert.equal(hasColumn(forbidden), false, `${TABLE} must not duplicate ${forbidden}`)
  }
})

// ---------------------------------------------------------------------------
// Session revocation and timestamps
// ---------------------------------------------------------------------------

test('session_version is a positive integer counter that starts at one', () => {
  assert.match(
    columnLine('session_version'),
    /int unsigned NOT NULL DEFAULT 1/,
  )
  assert.match(
    body,
    /CONSTRAINT `ck_user_credential_session_version`\s*\n?\s*CHECK \(`session_version` >= 1\)/,
  )
  assert.match(sql, /revoke every outstanding session/)
})

test('password change and row lifecycle timestamps are recorded at microsecond precision', () => {
  assert.match(
    columnLine('password_changed_at'),
    /datetime\(6\) NOT NULL DEFAULT current_timestamp\(6\)/,
  )
  assert.match(
    columnLine('created_at'),
    /datetime\(6\) NOT NULL DEFAULT current_timestamp\(6\)/,
  )
  assert.match(
    columnLine('updated_at'),
    /datetime\(6\) DEFAULT NULL ON UPDATE current_timestamp\(6\)/,
  )
  // Every declared *_at column, not the ones merely named inside a CHECK.
  for (const line of body.split('\n')) {
    const declared = /^\s+`(\w+_at)`\s+(\S+)/.exec(line)
    if (!declared) continue
    assert.equal(declared[2], 'datetime(6)', `${declared[1]} must be datetime(6)`)
  }
})

// ---------------------------------------------------------------------------
// Delete is a state change, never a row removal
// ---------------------------------------------------------------------------

test('an account is disabled or tombstoned, never physically deleted', () => {
  assert.match(columnLine('status'), /varchar\(20\) NOT NULL DEFAULT 'active'/)
  assert.match(
    body,
    /CHECK \(`status` IN \('active', 'disabled', 'tombstoned'\)\)/,
  )
  assert.match(columnLine('disabled_at'), /datetime\(6\) DEFAULT NULL/)
  // A non-active credential must say when it stopped being usable.
  assert.match(
    body,
    /\(`status` = 'active' AND `disabled_at` IS NULL\)\s*\n?\s*OR \(`status` <> 'active' AND `disabled_at` IS NOT NULL\)/,
  )
  assert.match(sql, /DISABLE \/ TOMBSTONE, NEVER PHYSICAL DELETE/)
  assert.match(sql, /RETIRED, never reissued/)
})

// ---------------------------------------------------------------------------
// Repository conventions
// ---------------------------------------------------------------------------

test('follows the InnoDB utf8mb4 convention and aligns collation before its foreign key', () => {
  assert.match(
    executableSql,
    /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci/,
  )
  const align = executableSql.indexOf('@kaudit_user_id_collation')
  const foreignKey = executableSql.indexOf('ADD CONSTRAINT `fk_user_credential_user`')
  assert.notEqual(align, -1, 'user_id must inherit the installation collation')
  assert.ok(align < foreignKey, 'collation alignment must precede the foreign key')
})

test('documents rollback and the forward-fix policy', () => {
  assert.match(sql, /EXPAND ONLY/)
  assert.match(sql, /DOWN \(rollback/)
  assert.match(sql, /Forward-fix policy:/)
  assert.match(sql, /VERIFY \(read-only\):/)
})
