import { readFileSync } from 'node:fs'
import mysql from 'mysql2/promise'
import { collectBilling } from '../src/adapters/mysqlFullDashboard.ts'
import {
  boundedSelect,
  databaseEngine,
} from '../src/adapters/mysqlReadTimeout.ts'
import { isSafeDatabaseDriverCode } from '../src/adapters/mysqlPoolAcquisition.ts'

const EXPECTED_INDEXES = [
  ['kaudit_call', 'idx_call_billing_period_id', ['billing_period_date', 'id']],
  ['kaudit_billing_calculation', 'idx_billing_calc_supersedes', ['supersedes_calculation_id']],
  ['kaudit_call', 'idx_call_period_category_started', ['billing_period_date', 'canonical_outcome_code', 'source_started_at', 'id']],
  ['kaudit_call_artifact', 'idx_call_artifact_call_recording_final', ['call_id', 'artifact_type', 'is_final']],
  ['kaudit_provider_cost', 'idx_provider_cost_call_sku_final', ['call_id', 'provider_sku', 'is_final']],
  ['kaudit_media_analysis', 'idx_media_analysis_artifact_classified_latest', ['call_artifact_id', 'status', 'classification_status', 'created_at', 'id'], ['A', 'A', 'A', 'D', 'D']],
  ['kaudit_transcript', 'idx_transcript_artifact_status_call', ['call_artifact_id', 'status', 'call_id']],
  ['kaudit_call_external_reference', 'idx_call_reference_call_type_first', ['call_id', 'reference_type', 'id']],
  ['kaudit_audit_finding', 'idx_audit_finding_call_code_latest', ['call_id', 'finding_code', 'created_at', 'id'], ['A', 'A', 'D', 'D']],
  ['kaudit_audit_run', 'idx_audit_run_call_engine_status', ['call_id', 'engine_version', 'status']],
]

class BillingQueryFailure extends Error {
  constructor(stage, driverCode = null) {
    super('billing-query-failed')
    this.stage = stage
    this.driverCode = driverCode
  }
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing:${name}`)
  return value
}

function selectedPeriod() {
  const month = required('KAUDIT_DIAGNOSTIC_MONTH')
  const match = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) throw new Error('invalid:KAUDIT_DIAGNOSTIC_MONTH')
  const lastDay = new Date(
    Date.UTC(Number(match[1]), Number(match[2]), 0),
  ).getUTCDate()
  return {
    month,
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
    label: month,
  }
}

function connectionOptions() {
  const tlsMode = required('DB_TLS_MODE').toLowerCase()
  if (tlsMode !== 'required' && tlsMode !== 'disabled') {
    throw new Error('invalid:DB_TLS_MODE')
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
    port: Number(required('DB_PORT')),
    database: required('DB_NAME'),
    user: required('DB_USER'),
    password: required('DB_PASSWORD'),
    ...(ssl ? { ssl } : {}),
    connectTimeout: 10_000,
    connectionLimit: 5,
    queueLimit: 24,
    maxIdle: 1,
    idleTimeout: 30_000,
    enableKeepAlive: false,
    decimalNumbers: false,
  }
}

function elapsedBucket(startedAt) {
  const elapsed = Date.now() - startedAt
  if (elapsed < 250) return 'under-250ms'
  if (elapsed < 1_000) return '250ms-1s'
  if (elapsed < 5_000) return '1-5s'
  if (elapsed < 15_000) return '5-15s'
  if (elapsed < 30_000) return '15-30s'
  return '30s-or-more'
}

function queryStage(sql) {
  if (sql.includes('COUNT(*) AS calculations')) return 'summary'
  if (sql.includes('authoritative_calculations')) return 'authority'
  if (sql.includes('FROM kaudit_rate_card_version')) return 'rate-card'
  if (sql.includes('FROM kaudit_reconciliation')) return 'reconciliation'
  if (sql.includes('AS total_calls')) return 'cycle-base'
  if (sql.includes('AS accepted_as_billed_calls')) return 'cycle-final'
  if (sql.includes('AS unresolved_decision_calls')) return 'cycle-unresolved'
  return 'unexpected-query'
}

function safeDriverCode(error) {
  if (typeof error !== 'object' || error === null) return null
  const code = error.code
  return isSafeDatabaseDriverCode(code) ? code : null
}

function safeRuntimeReason(error) {
  if (typeof error !== 'object' || error === null) return null
  const message = error.message
  return typeof message === 'string' &&
    /^(?:missing|invalid|conflict|unsupported):[A-Za-z0-9_-]{1,64}$/.test(message)
    ? message
    : null
}

function indexReport(rows) {
  const columnsByIndex = new Map()
  for (const row of rows) {
    const key = `${row.TABLE_NAME}.${row.INDEX_NAME}`
    const columns = columnsByIndex.get(key) ?? []
    columns.push({
      column: String(row.COLUMN_NAME),
      direction: String(row.COLLATION ?? 'A'),
    })
    columnsByIndex.set(key, columns)
  }
  return EXPECTED_INDEXES.map(([table, name, columns, directions = []]) => {
    const exact = columnsByIndex.get(`${table}.${name}`) ?? []
    const matches = (actual) => columns.every(
      (column, index) =>
        actual[index]?.column === column &&
        actual[index]?.direction === (directions[index] ?? 'A'),
    )
    const named = matches(exact)
    const equivalent = [...columnsByIndex.entries()].some(([key, actual]) =>
      key.startsWith(`${table}.`) &&
      matches(actual),
    )
    return {
      table,
      name,
      present: named,
      equivalent,
    }
  })
}

function planTables(value, result = []) {
  if (Array.isArray(value)) {
    for (const item of value) planTables(item, result)
    return result
  }
  if (value == null || typeof value !== 'object') return result
  if (typeof value.table_name === 'string') {
    result.push({
      table: value.table_name,
      access: typeof value.access_type === 'string' ? value.access_type : null,
      key: typeof value.key === 'string' ? value.key : null,
      rows: typeof value.rows === 'number' ? value.rows : null,
      rowsExaminedPerScan:
        typeof value.rows_examined_per_scan === 'number'
          ? value.rows_examined_per_scan
          : null,
      rowsProducedPerJoin:
        typeof value.rows_produced_per_join === 'number'
          ? value.rows_produced_per_join
          : null,
    })
  }
  for (const nested of Object.values(value)) planTables(nested, result)
  return result
}

let pool
const startedAt = Date.now()
try {
  const period = selectedPeriod()
  pool = mysql.createPool(connectionOptions())
  const [versionRows] = await pool.query('SELECT VERSION() AS version')
  const version = String(versionRows[0]?.version ?? '')
  const detectedEngine = databaseEngine(version)
  if (!detectedEngine) throw new Error('unsupported:database-engine')
  console.log(JSON.stringify({
    operation: 'billing-read-database',
    result: 'ok',
    engine: detectedEngine,
  }))

  const tables = [...new Set(EXPECTED_INDEXES.map(([table]) => table))]
  const placeholders = tables.map(() => '?').join(', ')
  const [indexRows] = await pool.query(
    `SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, COLLATION
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${placeholders})
     ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`,
    tables,
  )
  for (const index of indexReport(indexRows)) {
    console.log(JSON.stringify({
      operation: 'billing-read-index',
      result: index.present
        ? 'present'
        : index.equivalent
          ? 'equivalent'
          : 'missing',
      ...index,
    }))
  }

  const captured = []
  const timings = []
  const pending = new Set()
  const diagnosticPool = new Proxy(pool, {
    get(target, property) {
      if (property === 'query') {
        return async (sql, parameters = []) => {
          const stage = queryStage(sql)
          const queryStartedAt = Date.now()
          captured.push({ stage, sql, parameters })
          try {
            const execution = target.query(
              boundedSelect(sql, detectedEngine, 45),
              parameters,
            )
            pending.add(execution)
            const result = await execution.finally(() => pending.delete(execution))
            timings.push({
              operation: 'billing-read-query',
              result: 'ok',
              stage,
              elapsed: elapsedBucket(queryStartedAt),
            })
            return result
          } catch (error) {
            const driverCode = safeDriverCode(error)
            timings.push({
              operation: 'billing-read-query',
              result: 'failed',
              stage,
              elapsed: elapsedBucket(queryStartedAt),
              driverCode,
            })
            throw new BillingQueryFailure(stage, driverCode)
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })

  let collectionFailure = null
  try {
    await collectBilling(diagnosticPool, period)
  } catch (error) {
    collectionFailure = error
  }
  while (pending.size > 0) {
    await Promise.allSettled([...pending])
  }
  for (const timing of timings) console.log(JSON.stringify(timing))

  for (const query of captured) {
    try {
      const [rows] = await pool.query(
        `EXPLAIN FORMAT=JSON ${query.sql}`,
        query.parameters,
      )
      const rawPlan = rows[0]?.EXPLAIN
      const plan = typeof rawPlan === 'string' ? JSON.parse(rawPlan) : rawPlan
      console.log(JSON.stringify({
        operation: 'billing-read-plan',
        result: 'ok',
        stage: query.stage,
        tables: planTables(plan),
      }))
    } catch {
      console.log(JSON.stringify({
        operation: 'billing-read-plan',
        result: 'unavailable',
        stage: query.stage,
      }))
    }
  }

  const failedTiming = timings.find((timing) => timing.result === 'failed')
  if (failedTiming || collectionFailure) {
    throw new BillingQueryFailure(
      failedTiming?.stage ??
        (collectionFailure instanceof BillingQueryFailure
          ? collectionFailure.stage
          : 'unknown'),
      failedTiming?.driverCode ??
        (collectionFailure instanceof BillingQueryFailure
          ? collectionFailure.driverCode
          : safeDriverCode(collectionFailure)),
    )
  }

  console.log(JSON.stringify({
    operation: 'billing-read-performance',
    result: 'ok',
    queryCount: timings.length,
    elapsed: elapsedBucket(startedAt),
  }))
} catch (error) {
  console.error(JSON.stringify({
    operation: 'billing-read-performance',
    result: 'failed',
    stage: error instanceof BillingQueryFailure ? error.stage : 'runtime',
    reason:
      error instanceof BillingQueryFailure
        ? error.driverCode
        : safeRuntimeReason(error),
    elapsed: elapsedBucket(startedAt),
  }))
  process.exitCode = 1
} finally {
  if (pool) await pool.end().catch(() => undefined)
}
