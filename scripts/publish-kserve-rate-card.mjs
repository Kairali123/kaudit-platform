import mysql from 'mysql2/promise'
import { KSERVE_RULESET_SHA256, KSERVE_RULESET_VERSION }
  from '../src/billing/kserveRules.ts'

/**
 * Formal publication of a KServe rate card version.
 *
 * Every money write in this platform passes a D-03 gate: the rate card must be
 * `published`, name an approver, carry an approval timestamp, be INR, and be
 * bound to the locked KServe ruleset. That gate is what stops money being
 * written against a card nobody approved, so this command RECORDS an approval
 * that a responsible owner has actually made. It does not relax the gate and it
 * cannot be used to sidestep one.
 *
 * Read-only by default: with no confirmation it reports every rate card version
 * and why each does or does not satisfy the gate, and writes nothing.
 *
 * Publishing requires all three, together:
 *   KAUDIT_RATE_CARD_PUBLISH_CONFIRM=PUBLISH_KSERVE_RATE_CARD
 *   KAUDIT_RATE_CARD_ID=<exact rate card id>
 *   KAUDIT_RATE_CARD_APPROVER=<the person accountable for the decision>
 *
 * There is no default approver. An approval with no name attached is not an
 * approval, and the column feeds the platform's identity sources.
 *
 * An already-published card is never touched: re-approving or re-binding one
 * would silently restate history for every calculation already written against
 * it. Publish a new version instead.
 */

const CONFIRMATION = 'PUBLISH_KSERVE_RATE_CARD'
const APPROVER_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/

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
    // The budget the hosted workers use. Ten seconds is not enough for this
    // host's handshake from a fresh runner.
    connectTimeout: 30_000,
  }
}

/** Gate state per card. Booleans only; no approver value is echoed back. */
function gateState(row) {
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    currency: row.currency,
    approverRecorded: Boolean(row.approved_by),
    approvedAtRecorded: row.approved_at != null,
    rulesetBound: row.ruleset_sha256 != null,
    rulesetMatchesLocked: row.ruleset_sha256 === KSERVE_RULESET_SHA256,
    satisfiesBillingGate:
      row.status === 'published' &&
      Boolean(row.approved_by) &&
      row.approved_at != null &&
      row.currency === 'INR' &&
      row.ruleset_sha256 === KSERVE_RULESET_SHA256,
  }
}

let connection
let stage = 'connect'
let outcome = 'inspected'
let published = null
try {
  const confirmed =
    process.env.KAUDIT_RATE_CARD_PUBLISH_CONFIRM?.trim() === CONFIRMATION
  connection = await mysql.createConnection(connectionOptions())

  stage = 'inventory'
  const [rows] = await connection.query(
    `SELECT id, version, status, currency, ruleset_sha256,
            approved_by, approved_at
       FROM kaudit_rate_card_version
      ORDER BY version, id`,
  )
  const inventory = rows.map(gateState)

  if (confirmed) {
    stage = 'publish'
    const id = required('KAUDIT_RATE_CARD_ID')
    const approver = required('KAUDIT_RATE_CARD_APPROVER')
    if (!APPROVER_PATTERN.test(approver) || approver.length > 190) {
      throw new Error('invalid:KAUDIT_RATE_CARD_APPROVER')
    }
    await connection.beginTransaction()
    try {
      const [locked] = await connection.execute(
        `SELECT id, version, status, currency, ruleset_sha256,
                approved_by, approved_at
           FROM kaudit_rate_card_version
          WHERE id = ? FOR UPDATE`,
        [id],
      )
      const row = locked[0]
      if (!row) throw new Error('absent:rate_card')
      if (row.currency !== 'INR') throw new Error('unsupported:currency')
      if (row.status === 'published') {
        // Not an error and not a no-op to paper over: an already-published
        // card is history that other calculations already reference.
        throw new Error('refused:already_published')
      }
      const [result] = await connection.execute(
        `UPDATE kaudit_rate_card_version
            SET status = 'published',
                approved_by = ?,
                approved_at = current_timestamp(6),
                ruleset_sha256 = ?
          WHERE id = ?
            AND status <> 'published'
            AND currency = 'INR'`,
        [approver, KSERVE_RULESET_SHA256, id],
      )
      if (result.affectedRows !== 1) throw new Error('refused:not_updated')
      const [after] = await connection.execute(
        `SELECT id, version, status, currency, ruleset_sha256,
                approved_by, approved_at
           FROM kaudit_rate_card_version
          WHERE id = ?`,
        [id],
      )
      const state = gateState(after[0])
      if (!state.satisfiesBillingGate) {
        throw new Error('refused:gate_not_satisfied')
      }
      await connection.commit()
      published = state
      outcome = 'published'
    } catch (error) {
      await connection.rollback()
      throw error
    }
  }

  process.stdout.write(`${JSON.stringify({
    event: 'kserve_rate_card_publication',
    outcome,
    lockedRulesetVersion: KSERVE_RULESET_VERSION,
    lockedRulesetSha256: KSERVE_RULESET_SHA256,
    rateCards: inventory,
    published,
    note: confirmed
      ? 'Publication recorded. Money writes against this card are now permitted.'
      : 'Read-only inventory. No rate card was changed.',
  }, null, 2)}\n`)
} catch (error) {
  // Bounded: stage plus one short code. No driver text, no SQL, no value.
  const code = error instanceof Error ? error.message : 'unknown'
  process.stderr.write(`${JSON.stringify({
    event: 'kserve_rate_card_publication_failed',
    stage,
    code: /^[a-z_]+:[a-z_]+$/.test(code) ? code : 'unexpected',
  })}\n`)
  process.exitCode = 1
} finally {
  if (connection) await connection.end()
}
