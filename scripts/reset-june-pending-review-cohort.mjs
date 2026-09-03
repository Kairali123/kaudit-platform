import mysql from 'mysql2/promise'

const EXPECTED_ROWS = 278
const PERIOD_START = '2026-06-01'
const PERIOD_END = '2026-07-01'
const CONFIRMATION = 'RESET_JUNE_278_PENDING_REVIEWS'
const S3_PREFIX =
  'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/'

const EXPECTED_STATES = new Map([
  ['exhausted|4|CLASSIFICATION_OUTPUT_UNRECOVERABLE', 240],
  ['exhausted|8|proxy_signed_url_missing', 19],
  ['exhausted|4|TRANSCRIPTION_FAILED', 8],
  ['exhausted|8|non_audio_response type=application/json', 7],
  ['exhausted|3|TRANSCRIPTION_FAILED', 1],
  ['exhausted|5|CLASSIFICATION_OUTPUT_UNRECOVERABLE', 1],
  ['exhausted|8|AUDIT_SPEND_STATE_UNKNOWN', 1],
  ['exhausted|8|CLASSIFICATION_FAILED', 1],
])

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
    connectTimeout: 10_000,
  }
}

function stateKey(row) {
  return `${row.audio_processing_status}|${Number(row.audio_attempt_count || 0)}|${row.audio_last_error}`
}

let connection
let lockAcquired = false
let stage = 'confirmation'
let matched = 0
let artifactsUpdated = 0
let callsUpdated = 0
try {
  if (process.env.KAUDIT_JUNE_PENDING_RESET_CONFIRM !== CONFIRMATION) {
    throw new Error('confirmation:required')
  }
  stage = 'connect'
  connection = await mysql.createConnection(connectionOptions())
  stage = 'worker-lock'
  const [lockRows] = await connection.query(
    `SELECT GET_LOCK('kaudit-independent-reaudit-v2', 0) AS acquired`,
  )
  lockAcquired = Number(lockRows[0]?.acquired) === 1
  if (!lockAcquired) throw new Error('worker:active')

  stage = 'select'
  await connection.beginTransaction()
  const [rows] = await connection.execute(
    `SELECT ca.id AS artifact_id, c.id AS call_id, ca.source_url,
            ca.audio_processing_status, ca.audio_attempt_count,
            ca.audio_last_error
       FROM kaudit_call c
       JOIN kaudit_call_artifact ca ON ca.call_id = c.id
      WHERE c.billing_period_date >= ?
        AND c.billing_period_date < ?
        AND ca.artifact_type = 'recording'
        AND ca.is_final = 1
        AND ca.source_url IS NOT NULL
        AND NOT (
          c.canonical_outcome_code IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM kaudit_media_analysis ma
            WHERE ma.call_artifact_id = ca.id
              AND ma.status = 'completed'
              AND ma.classification_status = 'completed'
          )
          AND EXISTS (
            SELECT 1 FROM kaudit_transcript transcript
            WHERE transcript.call_artifact_id = ca.id
              AND transcript.status = 'completed'
          )
        )
      ORDER BY ca.id
      FOR UPDATE`,
    [PERIOD_START, PERIOD_END],
  )
  matched = rows.length
  if (matched !== EXPECTED_ROWS) throw new Error('unexpected:row-count')
  if (new Set(rows.map((row) => row.call_id)).size !== EXPECTED_ROWS) {
    throw new Error('unexpected:duplicate-call')
  }
  if (rows.some((row) => !String(row.source_url).startsWith(S3_PREFIX))) {
    throw new Error('unexpected:source-url')
  }
  const actualStates = new Map()
  for (const row of rows) {
    const key = stateKey(row)
    actualStates.set(key, (actualStates.get(key) || 0) + 1)
  }
  if (
    actualStates.size !== EXPECTED_STATES.size ||
    [...EXPECTED_STATES].some(([key, count]) => actualStates.get(key) !== count)
  ) {
    throw new Error('unexpected:state-distribution')
  }

  stage = 'update-artifacts'
  const artifactIds = rows.map((row) => row.artifact_id)
  const artifactPlaceholders = artifactIds.map(() => '?').join(', ')
  const [artifactResult] = await connection.execute(
    `UPDATE kaudit_call_artifact
        SET audio_processing_status = 'pending',
            audio_attempt_count = 0,
            audio_last_attempt_at = NULL,
            audio_next_attempt_at = NULL,
            audio_last_error = NULL
      WHERE id IN (${artifactPlaceholders})
        AND audio_processing_status = 'exhausted'`,
    artifactIds,
  )
  artifactsUpdated = Number(artifactResult.affectedRows || 0)
  if (artifactsUpdated !== EXPECTED_ROWS) {
    throw new Error('unexpected:artifact-update-count')
  }

  stage = 'update-calls'
  const callIds = rows.map((row) => row.call_id)
  const callPlaceholders = callIds.map(() => '?').join(', ')
  const [callResult] = await connection.execute(
    `UPDATE kaudit_call
        SET processing_status = 'pending', updated_at = UTC_TIMESTAMP(6)
      WHERE id IN (${callPlaceholders})`,
    callIds,
  )
  callsUpdated = Number(callResult.affectedRows || 0)
  if (callsUpdated !== EXPECTED_ROWS) {
    throw new Error('unexpected:call-update-count')
  }

  stage = 'commit'
  await connection.commit()
  console.log(JSON.stringify({
    operation: 'june-pending-review-reset',
    result: 'applied',
    matched,
    artifactsUpdated,
    callsUpdated,
    sourceUrlsChanged: 0,
  }))
} catch {
  if (connection) await connection.rollback().catch(() => undefined)
  console.error(JSON.stringify({
    operation: 'june-pending-review-reset',
    result: 'failed',
    stage,
    matched,
    artifactsUpdated,
    callsUpdated,
  }))
  process.exitCode = 1
} finally {
  if (connection && lockAcquired) {
    await connection.query(
      `SELECT RELEASE_LOCK('kaudit-independent-reaudit-v2')`,
    ).catch(() => undefined)
  }
  if (connection) await connection.end().catch(() => undefined)
}
