import mysql from 'mysql2/promise'

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

let connection
try {
  connection = await mysql.createConnection(connectionOptions())
  const [rows] = await connection.query(
    `SELECT item.status, COALESCE(item.last_error_code, 'NONE') AS error_code,
            COUNT(*) AS item_count
       FROM kaudit_billing_reaudit_item item
      WHERE item.request_id = (
              SELECT request.id
                FROM kaudit_billing_reaudit_request request
               ORDER BY request.requested_at DESC, request.id DESC
               LIMIT 1
            )
      GROUP BY item.status, COALESCE(item.last_error_code, 'NONE')
      ORDER BY item.status, error_code`,
  )
  const [findingRows] = await connection.query(
    `SELECT finding.finding_code, COUNT(*) AS finding_count
       FROM kaudit_billing_reaudit_item item
       JOIN kaudit_audit_run audit_run
         ON audit_run.call_id = item.call_id
        AND audit_run.status = 'failed'
        AND audit_run.started_at >= item.started_at
       JOIN kaudit_audit_finding finding
         ON finding.audit_run_id = audit_run.id
        AND finding.call_id = item.call_id
        AND finding.finding_code IN (
              'SOURCE_MISSING', 'EVIDENCE_ALTERED', 'UNSAFE_SOURCE_URL',
              'TRANSCRIPTION_FAILED', 'CLASSIFICATION_FAILED'
            )
      WHERE item.request_id = (
              SELECT request.id
                FROM kaudit_billing_reaudit_request request
               ORDER BY request.requested_at DESC, request.id DESC
               LIMIT 1
            )
      GROUP BY finding.finding_code
      ORDER BY finding.finding_code`,
  )
  console.log(JSON.stringify({
    operation: 'billing-reaudit-health',
    result: 'ok',
    groups: rows.map((row) => ({
      status: row.status,
      errorCode: row.error_code,
      count: Number(row.item_count),
    })),
    failureKinds: findingRows.map((row) => ({
      code: row.finding_code,
      count: Number(row.finding_count),
    })),
  }))
} catch {
  console.error(JSON.stringify({
    operation: 'billing-reaudit-health',
    result: 'failed',
  }))
  process.exitCode = 1
} finally {
  if (connection) await connection.end().catch(() => undefined)
}
