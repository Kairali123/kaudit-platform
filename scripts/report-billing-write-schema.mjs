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
  // Read by the settlement card on every billing page load. A migration that
  // was never applied looks identical to a slow query from the browser: both
  // arrive as "settlement could not be read".
  'kaudit_kserve_monthly_settlement',
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
        AND TABLE_NAME IN (?, ?, ?, ?)
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
  /**
   * Presence is reported separately from shape. A table with no varchar column
   * would otherwise be indistinguishable from a table that does not exist, and
   * those two call for opposite responses.
   */
  const [present] = await connection.query(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?, ?, ?, ?)`,
    TABLES,
  )
  const existing = new Set(present.map((row) => row.TABLE_NAME))
  /**
   * Index shapes, so a read that is slow because nothing indexes its join can
   * be told apart from one that is slow for any other reason -- and so an
   * index migration that refuses on a name collision can say what it collided
   * with instead of being renamed around.
   */
  const [indexRows] = await connection.query(
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?, ?, ?, ?)
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    TABLES,
  )
  const indexes = {}
  for (const row of indexRows) {
    const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`
    indexes[key] ??= []
    indexes[key].push(
      `${row.COLUMN_NAME}${row.COLLATION === 'D' ? ' DESC' : ''}`,
    )
  }
  process.stdout.write(`${JSON.stringify({
    event: 'billing_write_schema',
    indexes,
    tablesPresent: Object.fromEntries(
      TABLES.map((table) => [table, existing.has(table)]),
    ),
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
