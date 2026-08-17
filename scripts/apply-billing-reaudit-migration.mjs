import fs from 'node:fs/promises'
import mysql from 'mysql2/promise'

const MIGRATION_PATH = new URL('../migrations/0015_billing_reaudit_requests.sql', import.meta.url)
const TABLES = [
  'kaudit_billing_reaudit_item',
  'kaudit_billing_reaudit_request',
]

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) {
    throw new Error(`missing:${name}`)
  }
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
    connectTimeout: 10_000,
    multipleStatements: true,
  }
}

async function existingTables(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?, ?)
      ORDER BY TABLE_NAME`,
    TABLES,
  )
  return rows.map((row) => row.TABLE_NAME)
}

async function verifyEmpty(connection) {
  const [requestRows] = await connection.query(
    'SELECT COUNT(*) AS row_count FROM kaudit_billing_reaudit_request',
  )
  const [itemRows] = await connection.query(
    'SELECT COUNT(*) AS row_count FROM kaudit_billing_reaudit_item',
  )
  if (Number(requestRows[0].row_count) !== 0 || Number(itemRows[0].row_count) !== 0) {
    throw new Error('unexpected:nonempty')
  }
}

let connection
try {
  if (process.env.KAUDIT_MIGRATION_CONFIRM !== 'APPLY_0015') {
    throw new Error('confirmation:required')
  }

  connection = await mysql.createConnection(connectionOptions())
  const before = await existingTables(connection)
  if (before.length === TABLES.length) {
    console.log(JSON.stringify({ migration: '0015', result: 'already-applied' }))
  } else if (before.length !== 0) {
    throw new Error('unexpected:partial-state')
  } else {
    const migration = await fs.readFile(MIGRATION_PATH, 'utf8')
    await connection.query(migration)

    const after = await existingTables(connection)
    if (after.length !== TABLES.length) {
      throw new Error('unexpected:verification')
    }
    await verifyEmpty(connection)
    console.log(JSON.stringify({ migration: '0015', result: 'applied-empty' }))
  }
} catch {
  console.error(JSON.stringify({ migration: '0015', result: 'failed' }))
  process.exitCode = 1
} finally {
  if (connection) {
    await connection.end().catch(() => undefined)
  }
}
