import mysql from 'mysql2/promise'

const EXPECTED_ROWS = 19
const PERIOD_START = '2026-06-01'
const PERIOD_END = '2026-07-01'
const CONFIRMATION = 'RESET_JUNE_SIGNED_URL_RETRIES'

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
  if (process.env.KAUDIT_RETRY_REPAIR_CONFIRM !== CONFIRMATION) {
    throw new Error('confirmation:required')
  }

  stage = 'connect'
  connection = await mysql.createConnection(connectionOptions())
  stage = 'lock'
  await connection.beginTransaction()
  const [rows] = await connection.execute(
    `SELECT ca.id,
            CASE
              WHEN ca.audio_next_attempt_at IS NULL
                OR ca.audio_next_attempt_at <= UTC_TIMESTAMP(6)
              THEN 1 ELSE 0
            END AS ready
       FROM kaudit_call_artifact ca
       JOIN kaudit_call c ON c.id = ca.call_id
      WHERE c.billing_period_date >= ?
        AND c.billing_period_date < ?
        AND ca.artifact_type = 'recording'
        AND ca.is_final = 1
        AND ca.audio_processing_status = 'fetch_failed'
        AND COALESCE(ca.audio_attempt_count, 0) < 8
        AND ca.audio_last_error LIKE 'non_audio_response type=application/json%'
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

  const ready = rows.filter((row) => Number(row.ready) === 1).length
  if (ready === EXPECTED_ROWS) {
    stage = 'already-ready'
    await connection.commit()
    console.log(JSON.stringify({
      operation: 'june-signed-url-retry-repair',
      result: 'already-ready',
      matched,
      updated,
    }))
  } else {
    if (ready !== 0) throw new Error('unexpected:partial-state')
    stage = 'update'
    const ids = rows.map((row) => row.id)
    const placeholders = ids.map(() => '?').join(', ')
    const [result] = await connection.execute(
      `UPDATE kaudit_call_artifact
          SET audio_next_attempt_at = NULL
        WHERE id IN (${placeholders})
          AND audio_processing_status = 'fetch_failed'
          AND COALESCE(audio_attempt_count, 0) < 8
          AND audio_last_error LIKE 'non_audio_response type=application/json%'
          AND audio_next_attempt_at > UTC_TIMESTAMP(6)`,
      ids,
    )
    updated = Number(result.affectedRows || 0)
    if (updated !== EXPECTED_ROWS) throw new Error('unexpected:update-count')

    stage = 'commit'
    await connection.commit()
    console.log(JSON.stringify({
      operation: 'june-signed-url-retry-repair',
      result: 'applied',
      matched,
      updated,
    }))
  }
} catch {
  if (connection) await connection.rollback().catch(() => undefined)
  console.error(JSON.stringify({
    operation: 'june-signed-url-retry-repair',
    result: 'failed',
    stage,
    matched,
    updated,
  }))
  process.exitCode = 1
} finally {
  if (connection) await connection.end().catch(() => undefined)
}
