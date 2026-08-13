import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { CALL_AUDIT_PERSISTENCE_SQL } from '../adapters/mysqlCallAuditPersistence.ts'
import { CALL_AUDIT_SPEND_SKIP_CODE_VALUES } from './spendClaim.ts'

/**
 * Schema-contract test for migrations/0011_call_audit_spend_claim.sql.
 *
 * It reads both migrations as text — no database connection, ever — and pins
 * the guarantee the table exists for: exactly one claim per immutable source
 * revision, forever, with no way to ask for a second one. It also proves the
 * adapter's statements and the migration agree on the columns, so the claim
 * cannot be written by a query the schema does not accept.
 */

const CLAIM_MIGRATION_PATH = fileURLToPath(
  new URL('../../migrations/0011_call_audit_spend_claim.sql', import.meta.url),
)
const FOUNDATION_PATH = fileURLToPath(
  new URL('../../migrations/0008_call_audit_foundation.sql', import.meta.url),
)

const CLAIM_TABLE = 'kaudit_call_audit_spend_claim'
const SOURCE_TABLE = 'ai_voice_leads_received'

const sql = readFileSync(CLAIM_MIGRATION_PATH, 'utf8')
const foundationSql = readFileSync(FOUNDATION_PATH, 'utf8')

/** The migration with every `--` comment line removed. */
function executable(text: string): string {
  return text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('--'))
    .join('\n')
}

const executableSql = executable(sql)

/** Body of the CREATE TABLE statement, without its trailing table options. */
const claimBody = (() => {
  const start = executableSql.indexOf('CREATE TABLE `' + CLAIM_TABLE + '` (')
  assert.notEqual(start, -1, 'the migration does not create the claim table')
  const end = executableSql.indexOf('\n) ENGINE=', start)
  assert.notEqual(end, -1, 'no table options found for the claim table')
  return executableSql.slice(start, end)
})()

// ---------------------------------------------------------------------------
// The exclusion guarantee
// ---------------------------------------------------------------------------

test('the claim table exists and is keyed by the source revision ALONE', () => {
  // This single line is the whole race-free guarantee: InnoDB admits exactly
  // one row per source_ref_id, so of any number of runs reaching the insert
  // concurrently, exactly one commits.
  assert.match(claimBody, /PRIMARY KEY \(`source_ref_id`\)/)
  // Widening the key would give every run its own claim and silently restore
  // duplicate spend, so no composite unique key may include the run.
  assert.equal(/PRIMARY KEY \([^)]*`run_id`/.test(claimBody), false)
  assert.equal(/UNIQUE KEY[^\n]*`run_id`/.test(claimBody), false)
})

test('the claim carries only ids and a timestamp', () => {
  const columns = [...claimBody.matchAll(/^\s+`([a-z0-9_]+)`\s+\S/gm)].map(
    (match) => match[1],
  )
  assert.deepEqual(columns.sort(), [
    'claimed_at',
    'created_at',
    'rule_version_id',
    'run_id',
    'source_ref_id',
  ])
})

test('the claim table holds nothing content-bearing, identifying, or monetary', () => {
  for (const forbidden of [
    /transcript/i,
    /prompt/i,
    /\bresponse\b/i,
    /lead_id/i,
    /task_id/i,
    /\bphone\b|\bmobile\b|\bemail\b|\bname\b/i,
    /\burl\b/i,
    /token/i,
    /latency/i,
    /amount|price|cost|money|invoice|charge|rupee|\binr\b/i,
    /credential|secret|api_key/i,
  ]) {
    assert.equal(
      forbidden.test(claimBody),
      false,
      `the claim table must not define ${forbidden}`,
    )
  }
})

test('there is no force, override, re-audit, expiry, or release column', () => {
  // Default deny is permanent. Each of these would reintroduce duplicate spend
  // by design, so their absence is asserted rather than assumed.
  for (const forbidden of [
    /force/i,
    /override/i,
    /re_?audit/i,
    /bypass/i,
    /allow_/i,
    /expires_at|expiry|ttl/i,
    /released|release_at|revoked/i,
  ]) {
    assert.equal(
      forbidden.test(claimBody),
      false,
      `the claim table must not define ${forbidden}`,
    )
  }
})

test('a claim is never updated, released, or deleted by this migration', () => {
  assert.equal(/ON UPDATE/i.test(claimBody), false, 'rows are never edited')
  for (const forbidden of [/\bDELETE\b/i, /\bUPDATE\s+`/i, /\bTRUNCATE\b/i]) {
    assert.equal(forbidden.test(executableSql), false)
  }
})

// ---------------------------------------------------------------------------
// Expand-only, and scoped to Call Audit
// ---------------------------------------------------------------------------

test('the migration is expand-only: one CREATE, and no data statement', () => {
  const creates = [...executableSql.matchAll(/CREATE TABLE `([a-z0-9_]+)`/g)]
  assert.deepEqual(
    creates.map((match) => match[1]),
    [CLAIM_TABLE],
  )
  for (const forbidden of [
    /\bINSERT\b/i,
    /\bDROP\b/i,
    /\bRENAME\b/i,
    /MODIFY COLUMN/i,
    /\bCREATE\s+(?:UNIQUE\s+)?INDEX\b/i,
  ]) {
    assert.equal(forbidden.test(executableSql), false, `must not ${forbidden}`)
  }
})

test('the only table altered is the new one', () => {
  const altered = [...executableSql.matchAll(/ALTER TABLE `([a-z0-9_]+)`/g)].map(
    (match) => match[1],
  )
  assert.deepEqual([...new Set(altered)], [CLAIM_TABLE])
})

test('the external source table is never created, altered, written, or referenced', () => {
  // It is an EXTERNAL, READ-ONLY table owned by another system. It may appear
  // in a comment explaining that; it may never appear in a statement.
  assert.equal(executableSql.includes(SOURCE_TABLE), false)
  assert.equal(/\bLOCK\s+TABLES\b/i.test(executableSql), false)
  assert.equal(/FOR\s+UPDATE/i.test(executableSql), false)
})

test('every foreign key points at a Call Audit table, and none at billing', () => {
  const referenced = [
    ...executableSql.matchAll(/REFERENCES\s+`([a-z0-9_]+)`/g),
  ].map((match) => match[1])
  assert.deepEqual(referenced.sort(), [
    'kaudit_call_audit_run',
    'kaudit_call_audit_source_ref',
  ])
  for (const table of referenced) {
    assert.ok(table.startsWith('kaudit_call_audit_'))
  }
  // Call Audit stays separate from Billing Audit: no shared key, no join path.
  assert.equal(/kaudit_billing|kaudit_invoice|kaudit_cycle/i.test(sql), false)
})

test('the composite provenance foreign key matches the parent key 0008 defines', () => {
  // (run_id, rule_version_id) -> run(id, rule_version_id): the same composite
  // style results and usage events already use, so a claim cannot name run A
  // while citing contract B.
  assert.match(
    executableSql,
    /FOREIGN KEY \(`run_id`, `rule_version_id`\)\s*\n?\s*REFERENCES `kaudit_call_audit_run` \(`id`, `rule_version_id`\)/,
  )
  assert.match(
    executable(foundationSql),
    /UNIQUE KEY `uq_call_audit_run_provenance` \(`id`, `rule_version_id`\)/,
  )
})

// ---------------------------------------------------------------------------
// The adapter and the schema agree
// ---------------------------------------------------------------------------

test('the insert names exactly the columns the table defines as required', () => {
  const insert = CALL_AUDIT_PERSISTENCE_SQL.insertSpendClaim
  assert.match(insert, new RegExp('INSERT INTO `' + CLAIM_TABLE + '`'))
  const columns = [...insert.matchAll(/`([a-z0-9_]+)`/g)]
    .map((match) => match[1])
    .filter((name) => name !== CLAIM_TABLE)
  assert.deepEqual(columns, [
    'source_ref_id',
    'run_id',
    'rule_version_id',
    'claimed_at',
  ])
  // `created_at` is database-defaulted and is deliberately not bound.
  for (const column of columns) {
    assert.ok(
      new RegExp('^\\s+`' + column + '`\\s+\\S', 'm').test(claimBody),
      `${column} is bound by the adapter but not defined by the migration`,
    )
  }
})

test('the prior-result probe reads a table 0008 already indexes for it', () => {
  const probe = CALL_AUDIT_PERSISTENCE_SQL.selectPriorResult
  assert.match(probe, /FROM `kaudit_call_audit_result`/)
  assert.match(probe, /`source_ref_id` = \?/)
  // Served by the existing history index; this feature adds no index to 0008.
  assert.match(
    executable(foundationSql),
    /KEY `idx_call_audit_result_history` \(`source_ref_id`, `created_at`\)/,
  )
})

test('the skipped outcome the run records is storable by the existing schema', () => {
  const foundation = executable(foundationSql)
  // `skipped` is already an accepted processing status, so accounting for a
  // suppressed duplicate needs no change to the result table.
  assert.match(foundation, /`processing_status` IN \(\s*\n?\s*'pending', 'succeeded', 'failed', 'skipped'\s*\n?\s*\)/)
  // The reason is stored in `error_code`, which is varchar(80) and takes the
  // uppercase machine-code grammar these codes are written in.
  assert.match(foundation, /`error_code` varchar\(80\) DEFAULT NULL/)
  for (const code of CALL_AUDIT_SPEND_SKIP_CODE_VALUES) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
    assert.ok(code.length <= 80)
  }
  // `ineligibility_reason` still accepts only the one value, so a skipped
  // content-auditable result must leave it NULL rather than invent a reason.
  assert.match(
    foundation,
    /`ineligibility_reason` IS NULL\s*\n?\s*OR `ineligibility_reason` = 'missing_transcript'/,
  )
})

test('no run counter column is added, so the run table is untouched', () => {
  // Duplicate suppression is reported in the safe in-memory summary and, in the
  // database, as a `skipped` result. The seven stored counters are unchanged.
  assert.equal(/kaudit_call_audit_run`?\s*\n?\s*ADD COLUMN/i.test(sql), false)
  assert.equal(/duplicate_\w*_count/i.test(sql), false)
})
