import mysql from 'mysql2/promise'
import { collectAuditMonitor } from '../src/adapters/mysqlAuditMonitor.ts'

function queryStage(sql) {
  if (sql.includes('COUNT(*) AS total_calls')) return 'summary-core'
  if (sql.includes("engine_version = 'kairali-independent-reaudit")) {
    return 'reaudit-count'
  }
  if (sql.includes('SELECT DISTINCT c.canonical_outcome_code AS value')) {
    return 'categories'
  }
  if (sql.includes("LOWER(COALESCE(t.language, 'unknown')) AS value")) {
    return 'languages'
  }
  if (sql.includes('COUNT(DISTINCT usage_event.audit_run_id)')) {
    return 'usage-summary'
  }
  if (sql.includes('AS auditor_final_charge')) return 'financial-summary'
  if (sql.includes('c.id AS internal_call_id')) return 'audited-page'
  if (sql.includes('pending.processing_status')) return 'pending-page'
  if (sql.includes("'no_recording'")) return 'no-recording-page'
  if (sql.includes('kaudit_billing_reaudit_item')) return 'reaudit-status'
  if (sql.includes('SELECT COUNT(DISTINCT c.id) AS n')) {
    return 'audited-count'
  }
  return 'unexpected-query'
}

class MonitorQueryFailure extends Error {
  constructor(stage) {
    super('monitor-query-failed')
    this.stage = stage
  }
}

function required(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`missing:${name}`)
  return value
}

function period(month) {
  const match = /^(20\d{2})-(0[1-9]|1[0-2])$/.exec(month)
  if (!match) throw new Error('invalid:month')
  const year = Number(match[1])
  const monthNumber = Number(match[2])
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate()
  return {
    start: `${month}-01`,
    end: `${month}-${String(lastDay).padStart(2, '0')}`,
  }
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
    connectionLimit: 2,
    queueLimit: 24,
    maxIdle: 1,
    idleTimeout: 30_000,
    enableKeepAlive: false,
    decimalNumbers: false,
  }
}

function elapsedBucket(startedAt) {
  const elapsed = Date.now() - startedAt
  if (elapsed < 5_000) return 'under-5s'
  if (elapsed < 15_000) return '5-15s'
  if (elapsed < 30_000) return '15-30s'
  return '30s-or-more'
}

let pool
const startedAt = Date.now()
try {
  const selectedPeriod = period(required('KAUDIT_DIAGNOSTIC_MONTH'))
  pool = mysql.createPool(connectionOptions())
  const diagnosticPool = new Proxy(pool, {
    get(target, property) {
      if (property === 'query') {
        return async (...args) => {
          const stage = queryStage(String(args[0]))
          const queryStartedAt = Date.now()
          try {
            const result = await target.query(...args)
            console.log(JSON.stringify({
              operation: 'audit-monitor-query',
              result: 'ok',
              stage,
              elapsed: elapsedBucket(queryStartedAt),
            }))
            return result
          } catch {
            console.error(JSON.stringify({
              operation: 'audit-monitor-query',
              result: 'failed',
              stage,
              elapsed: elapsedBucket(queryStartedAt),
            }))
            throw new MonitorQueryFailure(stage)
          }
        }
      }
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  const query = {
    page: 1,
    pendingPage: 1,
    noRecordingPage: 1,
    pageSize: 25,
    category: null,
    language: null,
    periodStart: selectedPeriod.start,
    periodEnd: selectedPeriod.end,
  }
  const core = await collectAuditMonitor(diagnosticPool, query, 'summary-core')
  await collectAuditMonitor(diagnosticPool, query, 'summary-usage')
  await collectAuditMonitor(diagnosticPool, query, 'summary-financial')
  console.log(JSON.stringify({
    operation: 'audit-monitor-health',
    result: 'ok',
    data: core.summary.totalCalls > 0 ? 'present' : 'absent',
    elapsed: elapsedBucket(startedAt),
  }))
} catch (error) {
  console.error(JSON.stringify({
    operation: 'audit-monitor-health',
    result: 'failed',
    stage: error instanceof MonitorQueryFailure ? error.stage : 'runtime',
    elapsed: elapsedBucket(startedAt),
  }))
  process.exitCode = 1
} finally {
  if (pool) await pool.end().catch(() => undefined)
}
