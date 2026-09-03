import mysql from 'mysql2/promise'

/**
 * Read-only column widths for the tables a cycle-close fallback writes.
 *
 * The base billing schema predates this repository's migrations, so the widths
 * are not knowable from source. Without them, a value that overflows its column
 * is only discovered one failed write at a time — and the accepted-as-billed
 * path writes several long bounded codes, so that is a retry loop rather than a
 * diagnosis.
 *
 * This reports the shape only: column name, type, and maximum length. It reads
 * no row, no amount, no identifier, and no customer data, and it writes nothing.
 */

/** Exactly the tables `persistVerifiedBillingRecords` inserts into. */
const TABLES = [
  'kaudit_billing_calculation',
  'kaudit_billing_component_result',
  'kaudit_automated_decision',
]

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
  let ssl
  if (tlsMode === 'required') {
    const ca = required('DB_SSL_CA_PEM').replaceAll('\\n', '\n')
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) {
      throw new Error('invalid:DB_SSL_CA_PEM')
    }
    ssl = { ca, rejectUnauthorized: true, verifyIdentity: true }
  } else if (process.env.DB_SSL_CA_PEM?.trim()) {
    throw new Error('conflict:DB_SSL_CA_PEM')
  }
  return {
    host: required('DB_HOST'),
    port: Number(required('DB_PORT')),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ...(ssl ? { ssl } : {}),
    connectTimeout: 30_000,
  }
}

let connection
try {
  connection = await mysql.createConnection(connectionOptions())
  const [rows] = await connection.query(
    `SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE,
            CHARACTER_MAXIMUM_LENGTH, IS_NULLABLE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?, ?, ?)
        AND DATA_TYPE IN ('varchar', 'char')
      ORDER BY TABLE_NAME, COLUMN_NAME`,
    TABLES,
  )
  const byTable = {}
  for (const row of rows) {
    byTable[row.TABLE_NAME] ??= {}
    byTable[row.TABLE_NAME][row.COLUMN_NAME] = {
      type: row.DATA_TYPE,
      maxLength: Number(row.CHARACTER_MAXIMUM_LENGTH),
      nullable: row.IS_NULLABLE === 'YES',
    }
  }
  process.stdout.write(`${JSON.stringify({
    event: 'billing_write_schema',
    tables: byTable,
    note: 'Column shapes only. No row, amount, or identifier was read.',
  }, null, 2)}\n`)
} catch (error) {
  const code = error instanceof Error ? error.message : 'unknown'
  process.stderr.write(`${JSON.stringify({
    event: 'billing_write_schema_failed',
    code: /^[a-z_]+:[a-z_]+$/.test(code) ? code : 'unexpected',
  })}\n`)
  process.exitCode = 1
} finally {
  if (connection) await connection.end()
}
