import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'

/**
 * Applies migration 0013: the append-only record of what Kairali ACTUALLY PAID
 * KServe for a bill month.
 *
 * The application has read this table on every billing page load since the
 * settlement card shipped. The table was never created in production, so that
 * read has always failed, and the card has been reporting "settlement could not
 * be read" — which was true, and gave no way to learn that a migration was the
 * reason.
 *
 * EXPAND ONLY. One CREATE TABLE and one self-referencing foreign key. It reads
 * no row and alters, backfills and deletes nothing, so an existing table is
 * left exactly as found rather than replaced.
 */

const TABLE = 'kaudit_kserve_monthly_settlement'
const MIGRATION = new URL(
  '../migrations/0013_kserve_monthly_settlement.sql',
  import.meta.url,
)

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing:${name}`)
  return value
}

function connectionOptions() {
  const tlsMode = required('DB_TLS_MODE').toLowerCase()
  if (tlsMode !== 'required' && tlsMode !== 'disabled') {
    throw new Error('invalid:DB_TLS_MODE')
  }
  const port = Number(required('DB_PORT'))
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid:DB_PORT')
  }
  let ssl
  if (tlsMode === 'required') {
    const inline = process.env.DB_SSL_CA_PEM?.trim()
    const file = process.env.DB_SSL_CA_FILE?.trim()
    if (Boolean(inline) === Boolean(file)) {
      throw new Error('invalid:database-ca-source')
    }
    const ca = inline?.replaceAll('\\n', '\n') ?? readFileSync(file, 'utf8')
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('invalid:database-ca')
    }
    ssl = { ca, rejectUnauthorized: true, verifyIdentity: true }
  } else if (
    process.env.DB_SSL_CA_PEM?.trim() ||
    process.env.DB_SSL_CA_FILE?.trim()
  ) {
    throw new Error('conflict:database-ca')
  }
  return {
    host: required('DB_HOST'),
    port,
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ...(ssl ? { ssl } : {}),
    connectTimeout: 10_000,
    multipleStatements: false,
  }
}

/**
 * The migration file is the source of truth, so the statements applied are the
 * reviewed ones rather than a copy that can drift from them.
 *
 * Splitting on ";" alone is wrong here and was caught being wrong: this schema
 * documents itself with COMMENT strings, and several of those contain
 * semicolons, so a naive split produced nine fragments of a CREATE TABLE. The
 * scanner below tracks quoting, so a delimiter inside a string is text and only
 * a delimiter between statements ends one.
 */
function statementsFrom(sql) {
  const statements = []
  let current = ''
  let quote = null
  let lineComment = false
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]
    const next = sql[index + 1]
    if (lineComment) {
      if (character === '\n') {
        lineComment = false
        current += character
      }
      continue
    }
    if (quote) {
      current += character
      if (character === '\\' && quote !== '`') {
        // A backslash escape consumes the next character, so a trailing
        // escaped quote cannot be mistaken for the end of the string.
        current += next ?? ''
        index += 1
        continue
      }
      if (character === quote) {
        // Doubling is the SQL way to write the quote character itself; it
        // reopens the same string rather than closing it.
        if (next === quote) {
          current += next
          index += 1
          continue
        }
        quote = null
      }
      continue
    }
    if (character === '-' && next === '-') {
      lineComment = true
      index += 1
      continue
    }
    if (character === "'" || character === '"' || character === '`') {
      quote = character
      current += character
      continue
    }
    if (character === ';') {
      statements.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (quote) throw new Error('unexpected:unterminated-quote')
  statements.push(current.trim())
  const applicable = statements.filter(Boolean)
  for (const statement of applicable) {
    if (!/^(CREATE TABLE|ALTER TABLE)\b/i.test(statement)) {
      throw new Error('unexpected:non-expand-statement')
    }
  }
  if (applicable.length !== 2) throw new Error('unexpected:statement-count')
  return applicable
}

async function tableExists(connection) {
  const [rows] = await connection.query(
    `SELECT COUNT(*) AS present
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?`,
    [TABLE],
  )
  return Number(rows[0]?.present ?? 0) > 0
}

let connection
let stage = 'confirmation'
let applied = 0
try {
  if (process.env.KAUDIT_MIGRATION_CONFIRM !== 'APPLY_0013') {
    throw new Error('confirmation:required')
  }
  stage = 'read-migration'
  const statements = statementsFrom(readFileSync(MIGRATION, 'utf8'))
  stage = 'connect'
  connection = await mysql.createConnection(connectionOptions())
  stage = 'inspect'
  const existed = await tableExists(connection)
  if (!existed) {
    for (const statement of statements) {
      stage = 'apply'
      await connection.query(statement)
      applied += 1
    }
  }
  stage = 'verify'
  const present = await tableExists(connection)
  if (!present) throw new Error('verify:table-absent')
  process.stdout.write(`${JSON.stringify({
    event: 'kserve_settlement_migration',
    table: TABLE,
    existedBefore: existed,
    statementsApplied: applied,
    present,
    // Applying it twice must be a no-op, not an error: an operator who is
    // unsure whether it ran can simply run it again.
    outcome: existed ? 'already-present' : 'created',
  }, null, 2)}\n`)
} catch (error) {
  const code = error instanceof Error ? error.message : 'unknown'
  process.stderr.write(`${JSON.stringify({
    event: 'kserve_settlement_migration_failed',
    stage,
    statementsApplied: applied,
    code: /^[a-z_-]+:[a-z_-]+$/.test(code) ? code : 'unexpected',
  })}\n`)
  process.exitCode = 1
} finally {
  if (connection) await connection.end()
}
