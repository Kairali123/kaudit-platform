import fs from 'node:fs/promises'
import mysql from 'mysql2/promise'

const MIGRATION_PATH = new URL('../migrations/0017_billing_spend_lease.sql', import.meta.url)
const TABLE = 'kaudit_billing_spend_lease'
const PREREQUISITE_TABLE = 'kaudit_billing_reaudit_item'
const EXPECTED_COLUMNS = new Map([
  ['id', ['varchar(64)', 'NO']],
  ['call_id', ['char(36)', 'NO']],
  ['artifact_id', ['char(36)', 'NO']],
  ['manual_item_id', ['varchar(40)', 'YES']],
  ['status', ["enum('active','completed','released','expired')", 'NO']],
  ['attempt_count', ['int unsigned', 'NO']],
  ['worker_id', ['varchar(80)', 'NO']],
  ['claimed_at', ['datetime(6)', 'NO']],
  ['lease_expires_at', ['datetime(6)', 'NO']],
  ['staged_result_json', ['json', 'YES']],
  ['staged_at', ['datetime(6)', 'YES']],
  ['settled_at', ['datetime(6)', 'YES']],
  ['created_at', ['datetime(6)', 'NO']],
])
const EXPECTED_INDEXES = new Map([
  ['PRIMARY', ['id']],
  ['idx_billing_spend_lease_call', ['call_id', 'status']],
  ['idx_billing_spend_lease_manual_item', ['manual_item_id', 'status']],
  ['idx_billing_spend_lease_expiry', ['status', 'lease_expires_at']],
])

function columnTypeMatches(name, actual, expected) {
  if (name === 'attempt_count') {
    return /^int(?:\(\d+\))? unsigned$/.test(actual)
  }
  if (name === 'staged_result_json') {
    return actual === 'json' || actual === 'longtext'
  }
  return actual === expected
}

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

  const port = Number(required('DB_PORT'))
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('invalid:DB_PORT')
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
    port,
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ...(ssl ? { ssl } : {}),
    connectTimeout: 10_000,
    multipleStatements: true,
  }
}

async function tableNames(connection) {
  const [rows] = await connection.execute(
    `SELECT TABLE_NAME
       FROM information_schema.TABLES
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?, ?)
      ORDER BY TABLE_NAME`,
    [PREREQUISITE_TABLE, TABLE],
  )
  return new Set(rows.map((row) => row.TABLE_NAME))
}

async function verifySchema(connection, setStage, setDetail) {
  setStage('verify-columns')
  const [columns] = await connection.execute(
    `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
       FROM information_schema.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [TABLE],
  )
  const actualColumns = new Map(columns.map((row) => [row.COLUMN_NAME, row]))
  const missing = []
  const mismatched = []
  for (const row of columns) {
    const expected = EXPECTED_COLUMNS.get(row.COLUMN_NAME)
    if (expected && (
      !columnTypeMatches(row.COLUMN_NAME, row.COLUMN_TYPE.toLowerCase(), expected[0]) ||
      row.IS_NULLABLE !== expected[1]
    )) {
      mismatched.push(row.COLUMN_NAME)
    }
  }
  for (const name of EXPECTED_COLUMNS.keys()) {
    if (!actualColumns.has(name)) missing.push(name)
  }
  const unexpectedCount = columns.length - (EXPECTED_COLUMNS.size - missing.length)
  if (missing.length || mismatched.length || unexpectedCount !== 0) {
    setDetail({ reason: 'shape', missing, mismatched, unexpectedCount })
    throw new Error('unexpected:columns')
  }

  setStage('verify-indexes')
  const [indexes] = await connection.execute(
    `SELECT INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
      ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [TABLE],
  )
  const actualIndexes = new Map()
  for (const row of indexes) {
    const columns = actualIndexes.get(row.INDEX_NAME) ?? []
    columns.push(row.COLUMN_NAME)
    actualIndexes.set(row.INDEX_NAME, columns)
  }
  for (const [name, expectedColumns] of EXPECTED_INDEXES) {
    if (
      JSON.stringify(actualIndexes.get(name)) !== JSON.stringify(expectedColumns)
    ) {
      throw new Error('unexpected:indexes')
    }
  }

  setStage('verify-constraints')
  const [constraints] = await connection.execute(
    `SELECT CONSTRAINT_NAME, CONSTRAINT_TYPE
       FROM information_schema.TABLE_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?`,
    [TABLE],
  )
  const actualConstraints = new Map(
    constraints.map((row) => [row.CONSTRAINT_NAME, row.CONSTRAINT_TYPE]),
  )
  if (
    actualConstraints.get('PRIMARY') !== 'PRIMARY KEY' ||
    actualConstraints.get('chk_billing_spend_lease_attempts') !== 'CHECK' ||
    actualConstraints.get('fk_billing_spend_lease_manual_item') !== 'FOREIGN KEY'
  ) {
    throw new Error('unexpected:constraints')
  }

  setStage('verify-foreign-key')
  const [foreignKeys] = await connection.execute(
    `SELECT COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
       FROM information_schema.KEY_COLUMN_USAGE
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND TABLE_NAME = ?
        AND CONSTRAINT_NAME = 'fk_billing_spend_lease_manual_item'`,
    [TABLE],
  )
  if (
    foreignKeys.length !== 1 ||
    foreignKeys[0].COLUMN_NAME !== 'manual_item_id' ||
    foreignKeys[0].REFERENCED_TABLE_NAME !== PREREQUISITE_TABLE ||
    foreignKeys[0].REFERENCED_COLUMN_NAME !== 'id'
  ) {
    throw new Error('unexpected:foreign-key')
  }

  setStage('verify-check')
  const [checks] = await connection.execute(
    `SELECT CHECK_CLAUSE
       FROM information_schema.CHECK_CONSTRAINTS
      WHERE CONSTRAINT_SCHEMA = DATABASE()
        AND CONSTRAINT_NAME = 'chk_billing_spend_lease_attempts'`,
  )
  const checkClause = String(checks[0]?.CHECK_CLAUSE ?? '')
    .replaceAll('`', '')
    .replaceAll(' ', '')
    .replaceAll('(', '')
    .replaceAll(')', '')
  if (checks.length !== 1 || checkClause !== 'attempt_count=1') {
    throw new Error('unexpected:check-clause')
  }

  const stagedResultType = actualColumns
    .get('staged_result_json')
    ?.COLUMN_TYPE.toLowerCase()
  if (stagedResultType === 'longtext') {
    const [jsonChecks] = await connection.execute(
      `SELECT CHECK_CLAUSE
         FROM information_schema.CHECK_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE()
          AND TABLE_NAME = ?`,
      [TABLE],
    )
    const hasJsonCheck = jsonChecks.some((row) => (
      String(row.CHECK_CLAUSE ?? '')
        .toLowerCase()
        .replaceAll('`', '')
        .replaceAll(' ', '')
        .replaceAll('(', '')
        .replaceAll(')', '') === 'json_validstaged_result_json'
    ))
    if (!hasJsonCheck) {
      throw new Error('unexpected:json-check')
    }
  }
}

let connection
let stage = 'confirmation'
let detail
try {
  if (process.env.KAUDIT_MIGRATION_CONFIRM !== 'APPLY_0017') {
    throw new Error('confirmation:required')
  }

  stage = 'connect'
  connection = await mysql.createConnection(connectionOptions())
  stage = 'prerequisite'
  const before = await tableNames(connection)
  if (!before.has(PREREQUISITE_TABLE)) {
    throw new Error('missing:prerequisite')
  }

  let result = 'already-applied'
  if (!before.has(TABLE)) {
    stage = 'apply'
    const migration = await fs.readFile(MIGRATION_PATH, 'utf8')
    await connection.query(migration)
    result = 'applied-empty'
  }

  await verifySchema(
    connection,
    (nextStage) => {
      stage = nextStage
    },
    (nextDetail) => {
      detail = nextDetail
    },
  )
  if (result === 'applied-empty') {
    stage = 'verify-empty'
    const [rows] = await connection.query(
      'SELECT COUNT(*) AS row_count FROM kaudit_billing_spend_lease',
    )
    if (Number(rows[0].row_count) !== 0) {
      throw new Error('unexpected:nonempty')
    }
  }
  console.log(JSON.stringify({ migration: '0017', result }))
} catch {
  console.error(JSON.stringify({
    migration: '0017',
    result: 'failed',
    stage,
    ...(detail ? { detail } : {}),
  }))
  process.exitCode = 1
} finally {
  if (connection) {
    await connection.end().catch(() => undefined)
  }
}
