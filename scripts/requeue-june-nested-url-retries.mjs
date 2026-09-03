import mysql from 'mysql2/promise'

const EXPECTED_ROWS = 19
const PERIOD_START = '2026-06-01'
const PERIOD_END = '2026-07-01'
const CONFIRMATION = 'REQUEUE_JUNE_NESTED_URL_RETRIES'

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
  }
}

let connection
let stage = 'confirmation'
let matched = 0
let updated = 0
try {
  if (process.env.KAUDIT_NESTED_URL_REQUEUE_CONFIRM !== CONFIRMATION) {
    throw new Error('confirmation:required')
  }

  stage = 'connect'
  connection = await mysql.createConnection(connectionOptions())
  stage = 'lock'
  await connection.beginTransaction()
  const [rows] = await connection.execute(
    `SELECT ca.id
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
      WHERE c.billing_period_date >= ?
        AND c.billing_period_date < ?
        AND ca.artifact_type = 'recording'
        AND ca.is_final = 1
        AND ca.audio_processing_status = 'exhausted'
        AND ca.audio_attempt_count = 8
        AND ca.audio_last_error = 'proxy_signed_url_missing'
        AND NOT EXISTS (
          SELECT 1
          FROM kaudit_audit_run run
          WHERE run.call_id = c.id
            AND run.status = 'completed'
        )
      ORDER BY ca.id
      FOR UPDATE`,
    [PERIOD_START, PERIOD_END],
  )
  matched = rows.length
  if (matched !== EXPECTED_ROWS) throw new Error('unexpected:row-count')

  stage = 'update'
  const ids = rows.map((row) => row.id)
  const placeholders = ids.map(() => '?').join(', ')
  const [result] = await connection.execute(
    `UPDATE kaudit_call_artifact
        SET audio_processing_status = 'fetch_failed',
            audio_attempt_count = 7,
            audio_next_attempt_at = NULL
      WHERE id IN (${placeholders})
        AND audio_processing_status = 'exhausted'
        AND audio_attempt_count = 8
        AND audio_last_error = 'proxy_signed_url_missing'`,
    ids,
  )
  updated = Number(result.affectedRows || 0)
  if (updated !== EXPECTED_ROWS) throw new Error('unexpected:update-count')

  stage = 'commit'
  await connection.commit()
  console.log(JSON.stringify({
    operation: 'june-nested-url-requeue',
    result: 'applied',
    matched,
    updated,
  }))
} catch {
  if (connection) await connection.rollback().catch(() => undefined)
  console.error(JSON.stringify({
    operation: 'june-nested-url-requeue',
    result: 'failed',
    stage,
    matched,
    updated,
  }))
  process.exitCode = 1
} finally {
  if (connection) await connection.end().catch(() => undefined)
}
