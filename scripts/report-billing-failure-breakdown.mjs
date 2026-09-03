import mysql from 'mysql2/promise'

const FAILURE_CODES = [
  'SOURCE_MISSING',
  'EVIDENCE_ALTERED',
  'UNSAFE_SOURCE_URL',
  'TRANSCRIPTION_FAILED',
  'CLASSIFICATION_FAILED',
  'SPEND_STATE_UNKNOWN',
]

const CLASSIFICATION_CODES = [
  'CLASSIFICATION_MODEL_FAILED',
  'CLASSIFICATION_VALIDATION_FAILED',
  'CLASSIFICATION_OUTPUT_UNRECOVERABLE',
  'AUDIT_PROCESSOR_FAILED',
]

const WORKER_ERROR_CODES = [
  'BILLING_AUDIT_BATCH_FAILED_DB_CONNECTION_LIMIT',
  'BILLING_AUDIT_BATCH_FAILED_DB_CONNECTION_TIMEOUT',
  'BILLING_AUDIT_BATCH_FAILED_DB_LOCK_TIMEOUT',
  'BILLING_AUDIT_BATCH_FAILED_DB_DEADLOCK',
  'BILLING_AUDIT_BATCH_FAILED_DB_CONSTRAINT',
  'BILLING_AUDIT_BATCH_FAILED_DB_UNKNOWN',
  'BILLING_AUDIT_BATCH_FAILED_WORKER_LOCK_BUSY',
  'BILLING_AUDIT_BATCH_FAILED_WORKER_LIFECYCLE',
  'BILLING_AUDIT_LOCK_BUSY',
]

const FETCH_ERROR_CATEGORIES = [
  'HTTP_400',
  'HTTP_401',
  'HTTP_403',
  'HTTP_404',
  'HTTP_408',
  'HTTP_429',
  'HTTP_OTHER_4XX',
  'HTTP_5XX',
  'NON_AUDIO_APPLICATION_JSON',
  'NON_AUDIO_TEXT_HTML',
  'NON_AUDIO_TEXT_PLAIN',
  'NON_AUDIO_NO_TYPE',
  'NON_AUDIO_OTHER',
  'EMPTY_BODY',
  'TOO_LARGE',
  'TIMEOUT',
  'NETWORK_FAILURE',
  'NOT_APPLICABLE',
  'OTHER_FETCH_FAILURE',
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
    connectTimeout: 10_000,
  }
}

function allowlisted(value, allowed, fallback) {
  return allowed.includes(String(value)) ? String(value) : fallback
}

function number(value) {
  return Number(value || 0)
}

let connection
try {
  connection = await mysql.createConnection(connectionOptions())

  const [workerRows] = await connection.query(
    `SELECT desired_state, observed_state, last_error_code,
            processed_total, failed_total
       FROM kaudit_audit_worker_control
      WHERE audit_system = 'billing'`,
  )
  const [failureRows] = await connection.query(
    `SELECT finding.finding_code AS code,
            COUNT(DISTINCT run.id) AS lifetime,
            COUNT(DISTINCT CASE
              WHEN run.started_at >= UTC_TIMESTAMP(6) - INTERVAL 24 HOUR
              THEN run.id END) AS last_24_hours,
            COUNT(DISTINCT CASE
              WHEN run.started_at >= UTC_TIMESTAMP(6) - INTERVAL 7 DAY
              THEN run.id END) AS last_7_days
       FROM kaudit_audit_run run
       JOIN kaudit_audit_finding finding
         ON finding.audit_run_id = run.id
      WHERE run.status = 'failed'
        AND finding.finding_code IN (
          'SOURCE_MISSING', 'EVIDENCE_ALTERED', 'UNSAFE_SOURCE_URL',
          'TRANSCRIPTION_FAILED', 'CLASSIFICATION_FAILED',
          'SPEND_STATE_UNKNOWN'
        )
      GROUP BY finding.finding_code
      ORDER BY lifetime DESC, code`,
  )
  const [classificationRows] = await connection.query(
    `SELECT CASE JSON_UNQUOTE(
              JSON_EXTRACT(finding.signal_values_json, '$.errorCode')
            )
              WHEN 'CLASSIFICATION_MODEL_FAILED'
                THEN 'CLASSIFICATION_MODEL_FAILED'
              WHEN 'CLASSIFICATION_VALIDATION_FAILED'
                THEN 'CLASSIFICATION_VALIDATION_FAILED'
              WHEN 'CLASSIFICATION_OUTPUT_UNRECOVERABLE'
                THEN 'CLASSIFICATION_OUTPUT_UNRECOVERABLE'
              WHEN 'AUDIT_PROCESSOR_FAILED'
                THEN 'AUDIT_PROCESSOR_FAILED'
              ELSE 'OTHER_CLASSIFICATION_FAILURE'
            END AS code,
            COUNT(DISTINCT run.id) AS lifetime,
            COUNT(DISTINCT CASE
              WHEN run.started_at >= UTC_TIMESTAMP(6) - INTERVAL 24 HOUR
              THEN run.id END) AS last_24_hours,
            COUNT(DISTINCT CASE
              WHEN run.started_at >= UTC_TIMESTAMP(6) - INTERVAL 7 DAY
              THEN run.id END) AS last_7_days
       FROM kaudit_audit_run run
       JOIN kaudit_audit_finding finding
         ON finding.audit_run_id = run.id
      WHERE run.status = 'failed'
        AND finding.finding_code = 'CLASSIFICATION_FAILED'
      GROUP BY code
      ORDER BY lifetime DESC, code`,
  )
  const [artifactRows] = await connection.query(
    `SELECT audio_processing_status AS status,
            CASE
              WHEN audio_attempt_count <= 1 THEN '1'
              WHEN audio_attempt_count <= 3 THEN '2-3'
              WHEN audio_attempt_count <= 7 THEN '4-7'
              ELSE '8+'
            END AS attempt_bucket,
            CASE
              WHEN audio_processing_status <> 'fetch_failed'
                THEN 'NOT_APPLICABLE'
              WHEN audio_last_error = 'HTTP 400' THEN 'HTTP_400'
              WHEN audio_last_error = 'HTTP 401' THEN 'HTTP_401'
              WHEN audio_last_error = 'HTTP 403' THEN 'HTTP_403'
              WHEN audio_last_error = 'HTTP 404' THEN 'HTTP_404'
              WHEN audio_last_error = 'HTTP 408' THEN 'HTTP_408'
              WHEN audio_last_error = 'HTTP 429' THEN 'HTTP_429'
              WHEN audio_last_error REGEXP '^HTTP 4[0-9][0-9]$'
                THEN 'HTTP_OTHER_4XX'
              WHEN audio_last_error REGEXP '^HTTP 5[0-9][0-9]$'
                THEN 'HTTP_5XX'
              WHEN audio_last_error LIKE 'non_audio_response type=application/json%'
                THEN 'NON_AUDIO_APPLICATION_JSON'
              WHEN audio_last_error LIKE 'non_audio_response type=text/html%'
                THEN 'NON_AUDIO_TEXT_HTML'
              WHEN audio_last_error LIKE 'non_audio_response type=text/plain%'
                THEN 'NON_AUDIO_TEXT_PLAIN'
              WHEN audio_last_error = 'non_audio_response type=none'
                THEN 'NON_AUDIO_NO_TYPE'
              WHEN audio_last_error LIKE 'non_audio_response%'
                THEN 'NON_AUDIO_OTHER'
              WHEN audio_last_error = 'empty_body' THEN 'EMPTY_BODY'
              WHEN audio_last_error LIKE 'too_large %' THEN 'TOO_LARGE'
              WHEN LOWER(COALESCE(audio_last_error, '')) LIKE '%timeout%'
                OR LOWER(COALESCE(audio_last_error, '')) LIKE '%timed out%'
                OR LOWER(COALESCE(audio_last_error, '')) LIKE '%aborted%'
                THEN 'TIMEOUT'
              WHEN LOWER(COALESCE(audio_last_error, '')) LIKE '%fetch failed%'
                OR LOWER(COALESCE(audio_last_error, '')) LIKE '%network%'
                OR LOWER(COALESCE(audio_last_error, '')) LIKE '%connection%'
                THEN 'NETWORK_FAILURE'
              ELSE 'OTHER_FETCH_FAILURE'
            END AS fetch_error_category,
            COUNT(DISTINCT call_id) AS calls
       FROM kaudit_call_artifact
      WHERE artifact_type = 'recording'
        AND is_final = 1
        AND audio_processing_status IN (
          'fetch_failed', 'transcribe_failed', 'classify_failed', 'exhausted'
        )
      GROUP BY audio_processing_status, attempt_bucket, fetch_error_category
      ORDER BY audio_processing_status, attempt_bucket, fetch_error_category`,
  )
  const [manualRows] = await connection.query(
    `SELECT status,
            CASE
              WHEN last_error_code IS NULL THEN 'NONE'
              WHEN last_error_code = 'CLASSIFICATION_MODEL_FAILED'
                THEN 'CLASSIFICATION_MODEL_FAILED'
              WHEN last_error_code = 'CLASSIFICATION_VALIDATION_FAILED'
                THEN 'CLASSIFICATION_VALIDATION_FAILED'
              WHEN last_error_code = 'CLASSIFICATION_OUTPUT_UNRECOVERABLE'
                THEN 'CLASSIFICATION_OUTPUT_UNRECOVERABLE'
              WHEN last_error_code = 'AUDIT_PROCESSOR_FAILED'
                THEN 'AUDIT_PROCESSOR_FAILED'
              WHEN last_error_code = 'TRANSCRIPTION_FAILED'
                THEN 'TRANSCRIPTION_FAILED'
              WHEN last_error_code = 'SOURCE_MISSING' THEN 'SOURCE_MISSING'
              WHEN last_error_code = 'EVIDENCE_ALTERED'
                THEN 'EVIDENCE_ALTERED'
              WHEN last_error_code = 'UNSAFE_SOURCE_URL'
                THEN 'UNSAFE_SOURCE_URL'
              WHEN last_error_code = 'SPEND_STATE_UNKNOWN'
                THEN 'SPEND_STATE_UNKNOWN'
              WHEN last_error_code = 'AUDIT_SPEND_STATE_UNKNOWN'
                THEN 'AUDIT_SPEND_STATE_UNKNOWN'
              ELSE 'OTHER_FAILURE'
            END AS code,
            COUNT(*) AS items
       FROM kaudit_billing_reaudit_item
      GROUP BY status, code
      ORDER BY items DESC, status, code`,
  )

  const worker = workerRows[0]
  console.log(JSON.stringify({
    operation: 'billing-failure-breakdown',
    result: 'ok',
    worker: worker
      ? {
          desiredState: allowlisted(
            worker.desired_state,
            ['running', 'paused'],
            'unknown',
          ),
          observedState: allowlisted(
            worker.observed_state,
            ['idle', 'running', 'pausing', 'paused', 'faulted'],
            'unknown',
          ),
          lastErrorCode: worker.last_error_code == null
            ? 'NONE'
            : allowlisted(
                worker.last_error_code,
                WORKER_ERROR_CODES,
                'OTHER_FAILURE',
              ),
          processedTotal: number(worker.processed_total),
          failedTotal: number(worker.failed_total),
        }
      : null,
    failureFamilies: failureRows.map((row) => ({
      code: allowlisted(row.code, FAILURE_CODES, 'OTHER_FAILURE'),
      lifetime: number(row.lifetime),
      last24Hours: number(row.last_24_hours),
      last7Days: number(row.last_7_days),
    })),
    classificationFailures: classificationRows.map((row) => ({
      code: allowlisted(
        row.code,
        [...CLASSIFICATION_CODES, 'OTHER_CLASSIFICATION_FAILURE'],
        'OTHER_CLASSIFICATION_FAILURE',
      ),
      lifetime: number(row.lifetime),
      last24Hours: number(row.last_24_hours),
      last7Days: number(row.last_7_days),
    })),
    currentArtifactFailures: artifactRows.map((row) => ({
      status: allowlisted(
        row.status,
        ['fetch_failed', 'transcribe_failed', 'classify_failed', 'exhausted'],
        'other_failure',
      ),
      attemptBucket: allowlisted(
        row.attempt_bucket,
        ['1', '2-3', '4-7', '8+'],
        'other',
      ),
      fetchErrorCategory: allowlisted(
        row.fetch_error_category,
        FETCH_ERROR_CATEGORIES,
        'OTHER_FETCH_FAILURE',
      ),
      calls: number(row.calls),
    })),
    manualReaudits: manualRows.map((row) => ({
      status: allowlisted(
        row.status,
        ['queued', 'processing', 'completed', 'skipped', 'failed'],
        'unknown',
      ),
      code: allowlisted(
        row.code,
        [
          ...CLASSIFICATION_CODES,
          ...FAILURE_CODES,
          'AUDIT_SPEND_STATE_UNKNOWN',
          'NONE',
          'OTHER_FAILURE',
        ],
        'OTHER_FAILURE',
      ),
      items: number(row.items),
    })),
  }))
} catch {
  console.error(JSON.stringify({
    operation: 'billing-failure-breakdown',
    result: 'failed',
  }))
  process.exitCode = 1
} finally {
  if (connection) await connection.end().catch(() => undefined)
}
