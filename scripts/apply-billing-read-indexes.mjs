import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'

const INDEXES = [
  ['kaudit_call', 'idx_call_billing_period_id', ['billing_period_date', 'id'], ['A', 'A'], 'ADD KEY `idx_call_billing_period_id` (`billing_period_date`, `id`)'],
  ['kaudit_billing_calculation', 'idx_billing_calc_supersedes', ['supersedes_calculation_id'], ['A'], 'ADD KEY `idx_billing_calc_supersedes` (`supersedes_calculation_id`)'],
  ['kaudit_call', 'idx_call_period_category_started', ['billing_period_date', 'canonical_outcome_code', 'source_started_at', 'id'], ['A', 'A', 'A', 'A'], 'ADD KEY `idx_call_period_category_started` (`billing_period_date`, `canonical_outcome_code`, `source_started_at`, `id`)'],
  ['kaudit_call_artifact', 'idx_call_artifact_call_recording_final', ['call_id', 'artifact_type', 'is_final'], ['A', 'A', 'A'], 'ADD KEY `idx_call_artifact_call_recording_final` (`call_id`, `artifact_type`, `is_final`)'],
  ['kaudit_provider_cost', 'idx_provider_cost_call_sku_final', ['call_id', 'provider_sku', 'is_final'], ['A', 'A', 'A'], 'ADD KEY `idx_provider_cost_call_sku_final` (`call_id`, `provider_sku`, `is_final`)'],
  ['kaudit_media_analysis', 'idx_media_analysis_artifact_classified_latest', ['call_artifact_id', 'status', 'classification_status', 'created_at', 'id'], ['A', 'A', 'A', 'D', 'D'], 'ADD KEY `idx_media_analysis_artifact_classified_latest` (`call_artifact_id`, `status`, `classification_status`, `created_at` DESC, `id` DESC)'],
  ['kaudit_transcript', 'idx_transcript_artifact_status_call', ['call_artifact_id', 'status', 'call_id'], ['A', 'A', 'A'], 'ADD KEY `idx_transcript_artifact_status_call` (`call_artifact_id`, `status`, `call_id`)'],
  ['kaudit_call_external_reference', 'idx_call_reference_call_type_first', ['call_id', 'reference_type', 'id'], ['A', 'A', 'A'], 'ADD KEY `idx_call_reference_call_type_first` (`call_id`, `reference_type`, `id`)'],
  ['kaudit_audit_finding', 'idx_audit_finding_call_code_latest', ['call_id', 'finding_code', 'created_at', 'id'], ['A', 'A', 'D', 'D'], 'ADD KEY `idx_audit_finding_call_code_latest` (`call_id`, `finding_code`, `created_at` DESC, `id` DESC)'],
  ['kaudit_audit_run', 'idx_audit_run_call_engine_status', ['call_id', 'engine_version', 'status'], ['A', 'A', 'A'], 'ADD KEY `idx_audit_run_call_engine_status` (`call_id`, `engine_version`, `status`)'],
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
  }
}

async function currentIndexes(connection) {
  const tables = [...new Set(INDEXES.map(([table]) => table))]
  const placeholders = tables.map(() => '?').join(', ')
  const [rows] = await connection.query(
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION
       FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (${placeholders})
      ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    tables,
  )
  const result = new Map()
  for (const row of rows) {
    const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`
    const columns = result.get(key) ?? []
    columns.push([String(row.COLUMN_NAME), String(row.COLLATION ?? 'A')])
    result.set(key, columns)
  }
  return result
}

function matches(actual, columns, directions) {
  return columns.every(
    (column, index) =>
      actual[index]?.[0] === column &&
      actual[index]?.[1] === directions[index],
  )
}

function satisfied(indexes, specification) {
  const [table, name, columns, directions] = specification
  const named = indexes.get(`${table}.${name}`)
  if (named && !matches(named, columns, directions)) {
    throw new Error('unexpected:named-index-shape')
  }
  return [...indexes.entries()].some(
    ([key, actual]) => key.startsWith(`${table}.`) &&
      matches(actual, columns, directions),
  )
}

let connection
let stage = 'confirmation'
let applied = 0
try {
  if (process.env.KAUDIT_MIGRATION_CONFIRM !== 'APPLY_BILLING_READ_INDEXES') {
    throw new Error('confirmation:required')
  }
  stage = 'connect'
  connection = await mysql.createConnection(connectionOptions())
  stage = 'inspect'
  let indexes = await currentIndexes(connection)
  for (const specification of INDEXES) {
    if (satisfied(indexes, specification)) continue
    const [table, , , , definition] = specification
    stage = 'apply-index'
    await connection.query(
      `ALTER TABLE \`${table}\` ${definition}, ALGORITHM=INPLACE, LOCK=NONE`,
    )
    applied += 1
    stage = 'verify-index'
    indexes = await currentIndexes(connection)
    if (!satisfied(indexes, specification)) {
      throw new Error('unexpected:index-verification')
    }
  }
  console.log(JSON.stringify({
    migration: 'billing-read-indexes',
    result: applied === 0 ? 'already-applied' : 'applied',
    applied,
  }))
} catch {
  console.error(JSON.stringify({
    migration: 'billing-read-indexes',
    result: 'failed',
    stage,
    applied,
  }))
  process.exitCode = 1
} finally {
  if (connection) await connection.end().catch(() => undefined)
}
