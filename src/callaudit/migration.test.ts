import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { buildRuleActivation } from './ruleActivation.ts'

/**
 * Schema-contract test for migrations/0008_call_audit_foundation.sql.
 *
 * It reads the migration as text — no database connection, ever — and pins the
 * contracts that later tasks depend on: the six tables, their privacy
 * boundary, idempotency and foreign-key essentials, and the guarantee that the
 * external source table is never written. Assertions target individual columns
 * and keys rather than whole-file snapshots, so formatting stays free to change.
 */

const MIGRATION_PATH = fileURLToPath(
  new URL('../../migrations/0008_call_audit_foundation.sql', import.meta.url),
)

const SOURCE_TABLE = 'ai_voice_leads_received'

const CALL_AUDIT_TABLES = [
  'kaudit_call_audit_rule_version',
  'kaudit_call_audit_run',
  'kaudit_call_audit_source_ref',
  'kaudit_call_audit_result',
  'kaudit_call_audit_metric_score',
  'kaudit_call_audit_usage_event',
] as const

const sql = readFileSync(MIGRATION_PATH, 'utf8')

/** The migration with every `--` comment line removed. */
const executableSql = sql
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('--'))
  .join('\n')

/** Body of one CREATE TABLE statement, without its trailing table options. */
function createTableBody(table: string): string {
  const start = executableSql.indexOf('CREATE TABLE `' + table + '` (')
  assert.notEqual(start, -1, `migration does not create ${table}`)
  const end = executableSql.indexOf('\n) ENGINE=', start)
  assert.notEqual(end, -1, `no table options found for ${table}`)
  return executableSql.slice(start, end)
}

/** Full CREATE TABLE statement including its table options line. */
function createTableStatement(table: string): string {
  const start = executableSql.indexOf('CREATE TABLE `' + table + '` (')
  assert.notEqual(start, -1, `migration does not create ${table}`)
  const end = executableSql.indexOf(';', executableSql.indexOf('\n) ENGINE=', start))
  return executableSql.slice(start, end)
}

/** True when the table defines a column with exactly this name. */
function hasColumn(table: string, column: string): boolean {
  return new RegExp('^\\s+`' + column + '`\\s+\\S', 'm').test(
    createTableBody(table),
  )
}

function assertColumn(table: string, column: string, definition?: RegExp) {
  assert.ok(hasColumn(table, column), `${table} is missing column ${column}`)
  if (definition) {
    const body = createTableBody(table)
    const line = body
      .split('\n')
      .find((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
    assert.ok(line, `${table}.${column} definition not found`)
    assert.match(line, definition)
  }
}

const bodies = new Map(
  CALL_AUDIT_TABLES.map((table) => [table, createTableBody(table)]),
)

function body(table: (typeof CALL_AUDIT_TABLES)[number]): string {
  return bodies.get(table) as string
}

// ---------------------------------------------------------------------------
// Migration shape and expand-only guarantees
// ---------------------------------------------------------------------------

test('creates exactly the six call-audit tables and nothing else', () => {
  const created = [...executableSql.matchAll(/CREATE TABLE\s+`([a-z0-9_]+)`/gi)]
    .map((match) => match[1])
    .sort()
  assert.deepEqual(created, [...CALL_AUDIT_TABLES].sort())
})

test('is expand only: no data statements and no destructive DDL', () => {
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+`?[a-z0-9_]+`?\s+SET\b/i,
    /\bDELETE\s+FROM\b/i,
    /\bTRUNCATE\b/i,
    /\bDROP\s+(TABLE|COLUMN|DATABASE|INDEX)\b/i,
    /\bRENAME\s+TABLE\b/i,
    /\bREPLACE\s+INTO\b/i,
  ]) {
    assert.equal(
      forbidden.test(executableSql),
      false,
      `migration contains forbidden statement ${forbidden}`,
    )
  }
})

test('every DDL target is one of the six new tables', () => {
  const targets = [
    ...executableSql.matchAll(/(?:CREATE|ALTER)\s+TABLE\s+`([a-z0-9_]+)`/gi),
  ].map((match) => match[1])
  assert.ok(targets.length >= CALL_AUDIT_TABLES.length)
  for (const target of targets) {
    assert.ok(
      (CALL_AUDIT_TABLES as readonly string[]).includes(target),
      `migration targets unexpected table ${target}`,
    )
  }
})

test('does not modify migration 0007 territory or any pre-existing table', () => {
  for (const preExisting of [
    'kaudit_ai_usage_event',
    'kaudit_billing_calculation',
    'kaudit_automated_decision',
    'kaudit_call',
    'kaudit_audit_run',
    'kaudit_evidence_object',
  ]) {
    assert.equal(
      new RegExp('(?:CREATE|ALTER|DROP)\\s+TABLE\\s+`' + preExisting + '`').test(
        executableSql,
      ),
      false,
      `migration performs DDL on pre-existing table ${preExisting}`,
    )
  }
})

// ---------------------------------------------------------------------------
// The external source table stays read-only
// ---------------------------------------------------------------------------

test('never creates, alters, or writes the external source table', () => {
  assert.equal(
    new RegExp(
      '(?:CREATE|ALTER|DROP|TRUNCATE|RENAME)\\s+TABLE\\s+`?' +
        SOURCE_TABLE +
        '`?',
      'i',
    ).test(executableSql),
    false,
    `migration performs DDL on ${SOURCE_TABLE}`,
  )

  // The source table may only ever appear inside a string literal (a default
  // value and a documentation comment). Once literals are blanked out, an
  // occurrence would mean it is used as an identifier or statement target.
  const withoutLiterals = executableSql.replace(/'[^']*'/g, "''")
  assert.equal(
    withoutLiterals.includes(SOURCE_TABLE),
    false,
    `${SOURCE_TABLE} is used as an identifier or statement target`,
  )
  assert.equal(
    new RegExp('`' + SOURCE_TABLE + '`').test(executableSql),
    false,
    `${SOURCE_TABLE} is referenced as a quoted identifier`,
  )
})

test('never foreign-keys to the external source table', () => {
  assert.equal(
    new RegExp('REFERENCES\\s+`?' + SOURCE_TABLE + '`?', 'i').test(
      executableSql,
    ),
    false,
  )
  const references = [
    ...executableSql.matchAll(/REFERENCES\s+`([a-z0-9_]+)`/gi),
  ].map((match) => match[1])
  assert.ok(references.length > 0, 'migration declares no foreign keys')
  for (const referenced of references) {
    assert.ok(
      (CALL_AUDIT_TABLES as readonly string[]).includes(referenced),
      `foreign key references table outside the six: ${referenced}`,
    )
  }
})

test('references the source row logically, by table name and row id', () => {
  assertColumn('kaudit_call_audit_source_ref', 'source_table', /varchar\(64\)/)
  assertColumn('kaudit_call_audit_source_ref', 'source_row_id', /bigint/)
  assert.match(
    body('kaudit_call_audit_source_ref'),
    new RegExp("DEFAULT '" + SOURCE_TABLE + "'"),
  )
})

// ---------------------------------------------------------------------------
// Source references are append-only and revision aware
// ---------------------------------------------------------------------------

test('the source reference carries a non-null canonical revision hash', () => {
  assertColumn(
    'kaudit_call_audit_source_ref',
    'source_revision_sha256',
    /char\(64\) NOT NULL/,
  )
})

test('uniqueness is per source row revision, not per source row', () => {
  const table = 'kaudit_call_audit_source_ref'
  assert.match(
    body(table),
    /UNIQUE KEY `uq_call_audit_source_ref_revision`\s*\(`source_table`, `source_row_id`, `source_revision_sha256`\)/,
  )

  // The row-only unique key would pin a source row to a single reference
  // forever, so a transcript arriving later could never gain a new revision.
  const uniqueKeys = [...body(table).matchAll(/UNIQUE KEY `\w+`\s*\(([^)]*)\)/g)]
    .map((match) => match[1].replace(/\s+/g, ' ').trim())
  assert.equal(
    uniqueKeys.includes('`source_table`, `source_row_id`'),
    false,
    'source references must not be unique by source row alone',
  )
  for (const key of uniqueKeys) {
    if (key.includes('`source_row_id`')) {
      assert.match(
        key,
        /`source_revision_sha256`/,
        `unique key over source_row_id must include the revision hash: ${key}`,
      )
    }
  }
})

test('a lookup index begins with source table and source row id', () => {
  const lookup = body('kaudit_call_audit_source_ref').match(
    /\n\s+KEY `idx_call_audit_source_ref_row`\s*\(([^)]*)\)/,
  )
  assert.ok(lookup, 'missing the source-row lookup index')
  assert.match(lookup[1].replace(/\s+/g, ' ').trim(), /^`source_table`, `source_row_id`/)
})

test('the source reference keeps its own idempotency key', () => {
  assertColumn(
    'kaudit_call_audit_source_ref',
    'source_ref_idempotency_key',
    /varchar\(191\) NOT NULL/,
  )
  assert.match(
    body('kaudit_call_audit_source_ref'),
    /UNIQUE KEY `uq_call_audit_source_ref_idempotency`\s*\(`source_ref_idempotency_key`\)/,
  )
})

test('the source reference is never edited after insertion', () => {
  const table = 'kaudit_call_audit_source_ref'
  assert.equal(
    hasColumn(table, 'updated_at'),
    false,
    'an immutable source reference must not carry updated_at',
  )
  assert.equal(
    /ON UPDATE/i.test(body(table)),
    false,
    'the source reference must declare no ON UPDATE behaviour',
  )
  assertColumn(table, 'created_at', /datetime\(6\) NOT NULL/)
})

test('documents revision reuse versus new-revision insertion', () => {
  assert.match(sql, /UNCHANGED revision is REUSED/)
  assert.match(sql, /CHANGED source revision INSERTS A NEW ROW/)
  assert.match(
    createTableStatement('kaudit_call_audit_source_ref'),
    /COMMENT='Append-only revision-aware pointer to ai_voice_leads_received/,
  )
})

// ---------------------------------------------------------------------------
// Privacy boundary on the source reference
// ---------------------------------------------------------------------------

test('the source reference persists no customer or raw-content column', () => {
  const forbidden = [
    'lead_id',
    'client_name',
    'customer_name',
    'mobile',
    'mobile_number',
    'phone',
    'phone_number',
    'email',
    'email_address',
    'transcription_view_url',
    'transcript',
    'transcript_text',
    'recording_url',
    'customer_context',
    'context',
    'notes',
    'note',
    'summary',
    'summary_text',
    'address',
  ]
  for (const column of forbidden) {
    assert.equal(
      hasColumn('kaudit_call_audit_source_ref', column),
      false,
      `kaudit_call_audit_source_ref must not persist ${column}`,
    )
  }
})

test('no call-audit table persists a forbidden raw-content column', () => {
  for (const table of CALL_AUDIT_TABLES) {
    for (const column of [
      'lead_id',
      'client_name',
      'mobile',
      'email',
      'transcription_view_url',
      'transcript',
    ]) {
      assert.equal(
        hasColumn(table, column),
        false,
        `${table} must not persist ${column}`,
      )
    }
  }
})

test('keeps only the approved Task ID plus hashes of sensitive source values', () => {
  assertColumn('kaudit_call_audit_source_ref', 'task_id', /varchar\(191\)/)
  assertColumn('kaudit_call_audit_source_ref', 'lead_id_sha256', /char\(64\)/)
  assertColumn(
    'kaudit_call_audit_source_ref',
    'transcript_sha256',
    /char\(64\) DEFAULT NULL/,
  )
  assertColumn('kaudit_call_audit_source_ref', 'has_transcript', /tinyint\(1\)/)
})

test('the Task ID and lead hash are nullable and must never become mandatory', () => {
  // extractTaskId returns null for a null, blank, or empty-final-segment lead
  // ID, and a blank lead ID has no hash. Requiring either would make those
  // rows unstorable.
  for (const column of ['task_id', 'lead_id_sha256']) {
    assertColumn('kaudit_call_audit_source_ref', column, /DEFAULT NULL/)
    const line = body('kaudit_call_audit_source_ref')
      .split('\n')
      .find((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
    assert.ok(line)
    assert.equal(
      /NOT NULL/.test(line),
      false,
      `${column} must stay nullable; extractTaskId can legitimately yield none`,
    )
  }
})

test('a row with no Task ID stays auditable through row id and revision', () => {
  const table = 'kaudit_call_audit_source_ref'
  assertColumn(table, 'source_row_id', /bigint NOT NULL/)
  assertColumn(table, 'source_revision_sha256', /char\(64\) NOT NULL/)
  // Neither identifying column depends on the Task ID or the lead hash.
  assert.match(
    body(table),
    /UNIQUE KEY `uq_call_audit_source_ref_revision`/,
  )
  for (const column of ['task_id', 'lead_id_sha256']) {
    assert.equal(
      new RegExp(
        'UNIQUE KEY `\\w+`\\s*\\([^)]*`' + column + '`',
      ).test(body(table)),
      false,
      `${column} must not participate in a unique key while nullable`,
    )
  }
})

// ---------------------------------------------------------------------------
// Table 1 — rule versions
// ---------------------------------------------------------------------------

test('rule versions persist the locked contract identity explicitly', () => {
  assertColumn(
    'kaudit_call_audit_rule_version',
    'rule_contract_version',
    /varchar\(40\) NOT NULL/,
  )
  const line = body('kaudit_call_audit_rule_version')
    .split('\n')
    .find((candidate) => candidate.includes('not only inside scoring_config_json'))
  assert.ok(line, 'rule_contract_version must document why it is a column')
})

test('every accepted activation-snapshot field has a rule-version column', () => {
  // Ties Task 5 to this schema: the snapshot is what a writer will persist, so
  // a field with no column would be silently dropped.
  const snapshot = buildRuleActivation({
    versionLabel: 'call-audit/2026.08.1',
    businessPrompt: 'Synthetic guidance for the contract test.',
    modelProvider: 'openai',
    modelName: 'gpt-4o-mini',
    modelVersion: 'gpt-4o-mini-2024-07-18',
    temperature: '0.2',
  })
  for (const field of Object.keys(snapshot)) {
    const column = field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
    assert.ok(
      hasColumn('kaudit_call_audit_rule_version', column),
      `activation field ${field} has no ${column} column`,
    )
  }
})

test('rule versions carry lifecycle, prompt, model, and hash contracts', () => {
  const table = 'kaudit_call_audit_rule_version'
  assertColumn(table, 'id', /varchar\(40\) NOT NULL/)
  assertColumn(table, 'version_label', /varchar\(80\) NOT NULL/)
  assertColumn(table, 'status', /varchar\(20\) NOT NULL DEFAULT 'draft'/)
  assertColumn(table, 'business_prompt', /longtext NOT NULL/)
  assertColumn(table, 'prompt_sha256', /char\(64\) NOT NULL/)
  assertColumn(table, 'config_sha256', /char\(64\) NOT NULL/)
  assertColumn(table, 'model_provider')
  assertColumn(table, 'model_name')
  assertColumn(table, 'model_version')
  assertColumn(table, 'output_schema_version')
  assertColumn(table, 'taxonomy_version')
  assertColumn(table, 'scoring_config_version')
  for (const column of [
    'created_by',
    'created_at',
    'activated_by',
    'activated_at',
    'retired_by',
    'retired_at',
    'updated_at',
  ]) {
    assertColumn(table, column)
  }
})

test('rule version temperature is fixed precision, never a float', () => {
  assertColumn(
    'kaudit_call_audit_rule_version',
    'temperature',
    /decimal\(4,3\) NOT NULL/,
  )
  assert.equal(/`temperature`\s+(float|double)/i.test(sql), false)
})

test('rule version lifecycle allows exactly draft, active, and retired', () => {
  assert.match(
    body('kaudit_call_audit_rule_version'),
    /CHECK \(`status` IN \('draft', 'active', 'retired'\)\)/,
  )
})

test('rule version identity is unique', () => {
  assert.match(
    body('kaudit_call_audit_rule_version'),
    /UNIQUE KEY `uq_call_audit_rule_version_label` \(`version_label`\)/,
  )
})

// ---------------------------------------------------------------------------
// Table 2 — runs
// ---------------------------------------------------------------------------

test('runs validate every supported operation type', () => {
  const check = body('kaudit_call_audit_run')
  for (const runType of [
    'daily',
    'monthly',
    'quarterly',
    'yearly',
    'manual',
    'test',
    'backfill',
  ]) {
    assert.match(check, new RegExp("'" + runType + "'"))
  }
  assert.match(check, /CHECK \(`run_type` IN \(/)
  assertColumn('kaudit_call_audit_run', 'run_type', /varchar\(20\) NOT NULL/)
})

test('runs store an exact half-open period in Asia/Kolkata', () => {
  const table = 'kaudit_call_audit_run'
  assertColumn(table, 'period_start', /datetime\(6\) NOT NULL/)
  assertColumn(table, 'period_end_exclusive', /datetime\(6\) NOT NULL/)
  assertColumn(
    table,
    'period_timezone',
    /varchar\(64\) NOT NULL DEFAULT 'Asia\/Kolkata'/,
  )
  assert.match(
    body(table),
    /CHECK \(`period_end_exclusive` > `period_start`\)/,
  )
})

test('runs track status, progress counts, and lifecycle timestamps', () => {
  const table = 'kaudit_call_audit_run'
  assertColumn(table, 'status', /varchar\(30\) NOT NULL DEFAULT 'pending'/)
  for (const counter of [
    'total_candidates',
    'processed_count',
    'succeeded_count',
    'failed_count',
    'skipped_count',
    'content_auditable_count',
    'operational_only_count',
  ]) {
    assertColumn(table, counter, /int NOT NULL DEFAULT 0/)
  }
  for (const stamp of [
    'scheduled_at',
    'started_at',
    'finished_at',
    'created_at',
    'updated_at',
  ]) {
    assertColumn(table, stamp, /datetime\(6\)/)
  }
})

test('runs carry correlation, idempotency, and the rule version reference', () => {
  const table = 'kaudit_call_audit_run'
  assertColumn(table, 'correlation_id', /varchar\(120\)/)
  assertColumn(table, 'idempotency_key', /varchar\(191\) NOT NULL/)
  assertColumn(table, 'rule_version_id', /varchar\(40\) NOT NULL/)
  assert.match(
    body(table),
    /UNIQUE KEY `uq_call_audit_run_idempotency` \(`idempotency_key`\)/,
  )
  assert.match(
    executableSql,
    /CONSTRAINT `fk_call_audit_run_rule_version`\s+FOREIGN KEY \(`rule_version_id`\)\s+REFERENCES `kaudit_call_audit_rule_version` \(`id`\)/,
  )
})

// ---------------------------------------------------------------------------
// Table 4 — results
// ---------------------------------------------------------------------------

test('results reference run, source reference, and rule version', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'run_id', /varchar\(40\) NOT NULL/)
  assertColumn(table, 'source_ref_id', /varchar\(40\) NOT NULL/)
  assertColumn(table, 'rule_version_id', /varchar\(40\) NOT NULL/)
  assert.match(
    executableSql,
    /CONSTRAINT `fk_call_audit_result_source_ref`\s+FOREIGN KEY \(`source_ref_id`\)\s+REFERENCES `kaudit_call_audit_source_ref` \(`id`\)/,
  )
})

// ---------------------------------------------------------------------------
// Composite provenance: ids must belong together, not merely exist
// ---------------------------------------------------------------------------

test('the run exposes a composite parent key of id and rule version', () => {
  assert.match(
    body('kaudit_call_audit_run'),
    /UNIQUE KEY `uq_call_audit_run_provenance` \(`id`, `rule_version_id`\)/,
  )
})

test('a result is pinned to its run AND that run exact rule version', () => {
  assert.match(
    executableSql,
    /CONSTRAINT `fk_call_audit_result_run_rule`\s+FOREIGN KEY \(`run_id`, `rule_version_id`\)\s+REFERENCES `kaudit_call_audit_run` \(`id`, `rule_version_id`\)/,
  )
})

test('no single-column result FK re-admits a run/rule mismatch', () => {
  // A result -> run FK on run_id alone, or a result -> rule_version FK on
  // rule_version_id alone, would each be satisfied by a result naming run A
  // and rule B. Neither may exist.
  assert.equal(
    /FOREIGN KEY \(`run_id`\)\s+REFERENCES `kaudit_call_audit_run`/.test(
      executableSql,
    ),
    false,
    'a single-column result -> run foreign key must not exist',
  )
  assert.equal(
    /CONSTRAINT `fk_call_audit_result_rule_version`/.test(executableSql),
    false,
    'a single-column result -> rule_version foreign key must not exist',
  )
})

test('the result exposes a composite parent key for its whole triple', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /UNIQUE KEY `uq_call_audit_result_provenance`\s*\(`id`, `run_id`, `rule_version_id`\)/,
  )
})

test('every result foreign key references a call-audit parent tuple', () => {
  // Each REFERENCES clause must name a parent column list, and the composite
  // ones must list exactly the tuple they pin.
  const references = [
    ...executableSql.matchAll(
      /FOREIGN KEY \(([^)]*)\)\s+REFERENCES `([a-z0-9_]+)` \(([^)]*)\)/g,
    ),
  ]
  assert.ok(references.length >= 4)
  for (const [, child, parent, parentColumns] of references) {
    assert.ok(
      (CALL_AUDIT_TABLES as readonly string[]).includes(parent),
      `foreign key references ${parent}, outside the six`,
    )
    assert.equal(
      child.split(',').length,
      parentColumns.split(',').length,
      `arity mismatch between (${child}) and ${parent}(${parentColumns})`,
    )
  }
})

test('results record eligibility and explicit four-value intent', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'processing_status', /varchar\(30\) NOT NULL/)
  assertColumn(table, 'eligibility', /varchar\(30\) NOT NULL/)
  assertColumn(table, 'ineligibility_reason')
  assertColumn(table, 'intent', /varchar\(10\)/)
  assertColumn(table, 'intent_confidence', /decimal\(9,8\)/)
  assert.match(
    body(table),
    /CHECK \(`eligibility` IN \('content_auditable', 'operational_only'\)\)/,
  )
  assert.match(
    body(table),
    /CHECK \(`intent` IS NULL OR `intent` IN \('HIGH', 'WARM', 'LOW', 'NONE'\)\)/,
  )
})

test('a NULL intent is documented as undetermined, never as WARM', () => {
  const line = body('kaudit_call_audit_result')
    .split('\n')
    .find((candidate) => candidate.includes('NEVER read as WARM'))
  assert.ok(line, 'intent column must document that NULL is not WARM')
})

test('results keep detailed and grouped outcomes independent', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'detailed_outcome', /varchar\(80\)/)
  assertColumn(table, 'grouped_outcome', /varchar\(80\)/)
  assertColumn(table, 'qualification_label')
  assertColumn(table, 'next_action_code', /varchar\(80\)/)
})

test('the overall score is a nullable fixed-precision weighted percentage', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'overall_score', /decimal\(6,3\) DEFAULT NULL/)
  assert.equal(/`overall_score`\s+(float|double)/i.test(sql), false)

  // The placeholder wording is gone: the contract is approved.
  assert.equal(
    body(table).includes('PLACEHOLDER'),
    false,
    'overall_score must no longer be described as a placeholder',
  )
  assert.equal(
    body(table).includes('not computed yet'),
    false,
    'overall_score must no longer claim scoring is unimplemented',
  )

  const comment = body(table)
    .split('\n')
    .find((candidate) => candidate.includes('Weighted percentage'))
  assert.ok(comment, 'overall_score must document its range and NULL meaning')
  assert.match(comment, /0\.000-100\.000/)
  assert.match(comment, /NULL is never 0\.000/)

  assert.match(
    body(table),
    /CHECK \(\s*`overall_score` IS NULL\s*OR \(`overall_score` >= 0\.000 AND `overall_score` <= 100\.000\)\s*\)/,
  )
})

test('the scoring method identity is stored beside the score', () => {
  assertColumn(
    'kaudit_call_audit_result',
    'overall_score_method',
    /varchar\(60\) DEFAULT NULL/,
  )
  const comment = body('kaudit_call_audit_result')
    .split('\n')
    .find((candidate) => candidate.includes('Stable identity of the scoring method'))
  assert.ok(comment, 'overall_score_method must be a stable method identity')
})

test('the schema never claims to calculate the score itself', () => {
  const table = 'kaudit_call_audit_result'
  // The range check guards the stored value; it must not try to reproduce the
  // weighting rule, which the application owns.
  assert.equal(/sum\(/i.test(body(table).replace(/^\s*--.*$/gm, '')), false)
  // The rationale lives in a leading SQL comment, so search the raw file.
  const note = sql
    .split('\n')
    .find((candidate) => candidate.includes('CALCULATED BY THE APPLICATION'))
  assert.ok(note, 'the score must be documented as application-calculated')
})

test('the three reportable call-state facts are nullable booleans', () => {
  const table = 'kaudit_call_audit_result'
  for (const column of [
    'call_connected',
    'customer_spoke',
    'meaningful_conversation',
  ]) {
    assertColumn(table, column, /tinyint\(1\) DEFAULT NULL/)
    assert.equal(
      new RegExp('`' + column + '`[^,]*NOT NULL').test(body(table)),
      false,
      column + ' must stay nullable so a failed result invents no fact',
    )
  }
  assert.match(
    body(table),
    /CHECK \(`call_connected` IS NULL OR `call_connected` IN \(0, 1\)\)/,
  )
  assert.match(
    body(table),
    /CHECK \(`customer_spoke` IS NULL OR `customer_spoke` IN \(0, 1\)\)/,
  )
  assert.match(body(table), /`meaningful_conversation` IN \(0, 1\)/)
})

test('coded result labels are constrained to the approved values', () => {
  const table = 'kaudit_call_audit_result'
  const check = body(table)
  for (const value of [
    'QUALIFIED',
    'NON_QUALIFIED',
    'UNCERTAIN',
    'NOT_APPLICABLE',
  ]) {
    assert.match(check, new RegExp("'" + value + "'"))
  }
  assert.match(check, /CHECK \(\s*`qualification_label` IS NULL/)

  for (const code of [
    'NONE',
    'CALLBACK',
    'SEND_DETAILS_EMAIL',
    'ASSIGN_TO_MR',
    'EXPERT_FOLLOWUP',
    'DOCTOR_CONSULTATION',
    'SCHEDULE_BOOKING',
    'DO_NOT_CALL',
    'REVERIFY',
    'TECHNICAL_RETRY',
    'LANGUAGE_CALLBACK',
    'OTHER',
  ]) {
    assert.match(check, new RegExp("'" + code + "'"), code + ' missing')
  }
  assert.match(check, /CHECK \(\s*`next_action_code` IS NULL/)

  assert.match(
    check,
    /`kserve_comparison_label` IN \('match', 'mismatch', 'not_comparable'\)/,
  )
  assert.match(
    check,
    /`mismatch_severity` IN \('none', 'low', 'medium', 'high'\)/,
  )
})

test('the stale service_label column is gone', () => {
  // Not in the approved model output, narrower than the source service_category,
  // and no deterministic service taxonomy has been approved.
  for (const table of CALL_AUDIT_TABLES) {
    assert.equal(
      hasColumn(table, 'service_label'),
      false,
      `${table} must not carry service_label`,
    )
  }
})

test('issue flags are stored as validated coded JSON', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'issue_flags_json', /longtext/)
  const comment = body(table)
    .split('\n')
    .find((candidate) => candidate.includes('APPROVED CODED issue flags'))
  assert.ok(comment, 'issue_flags_json must forbid prose')
  assert.match(comment, /never prose/)
  assert.match(
    body(table),
    /CHECK \(`issue_flags_json` IS NULL OR json_valid\(`issue_flags_json`\)\)/,
  )
  assert.match(
    executableSql,
    /MODIFY COLUMN `issue_flags_json` longtext\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_bin/,
  )
})

test('improvement feedback carries the same sanitized contract', () => {
  const table = 'kaudit_call_audit_result'
  for (const column of [
    'management_feedback',
    'kserve_feedback',
    'improvement_feedback',
  ]) {
    assertColumn(table, column, /varchar\(2000\) DEFAULT NULL/)
    const index = body(table)
      .split('\n')
      .findIndex((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
    assert.match(body(table).split('\n')[index + 1], /Sanitized/)
  }
})

test('a score and its method identity stand or fall together', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /CHECK \(\s*\(`overall_score` IS NULL AND `overall_score_method` IS NULL\)\s*OR \(`overall_score` IS NOT NULL AND `overall_score_method` IS NOT NULL\)\s*\)/,
  )
})

test('structured result JSON and its hash stand or fall together', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /CHECK \(\s*\(`result_json` IS NULL AND `result_sha256` IS NULL\)\s*OR \(`result_json` IS NOT NULL AND `result_sha256` IS NOT NULL\)\s*\)/,
  )
})

test('an unconnected call can never record customer speech', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /CHECK \(NOT \(`call_connected` = 0 AND `customer_spoke` = 1\)\)/,
  )
})

test('a silent call can never record a meaningful conversation', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /CHECK \(NOT \(`customer_spoke` = 0 AND `meaningful_conversation` = 1\)\)/,
  )
})

test('an operational-only result can never carry a score', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /`eligibility` = 'operational_only'\s*AND \(\s*`overall_score` IS NOT NULL\s*OR `overall_score_method` IS NOT NULL\s*\)/,
  )
})

test('the ineligibility reason is closed to the one approved value', () => {
  assert.match(
    body('kaudit_call_audit_result'),
    /CHECK \(\s*`ineligibility_reason` IS NULL\s*OR `ineligibility_reason` = 'missing_transcript'\s*\)/,
  )
})

test('the intra-row checks do not overconstrain a pending row', () => {
  // A pending row leaves every optional value NULL. NULL comparisons yield
  // UNKNOWN, which a CHECK accepts, so none of these can block the lifecycle.
  const table = 'kaudit_call_audit_result'
  for (const column of [
    'overall_score',
    'overall_score_method',
    'result_json',
    'result_sha256',
    'call_connected',
    'customer_spoke',
    'meaningful_conversation',
    'ineligibility_reason',
  ]) {
    assertColumn(table, column)
    // The definition may wrap, so match across it rather than one line.
    // DEFAULT NULL proves nullability: NOT NULL DEFAULT NULL is invalid SQL.
    assert.match(
      body(table),
      new RegExp('`' + column + '`[\\s\\S]{0,140}?DEFAULT NULL'),
      `${column} must be nullable so a pending row can omit it`,
    )
  }
  // Only the always-known facts are NOT NULL.
  assertColumn(table, 'processing_status', /NOT NULL/)
  assertColumn(table, 'eligibility', /varchar\(30\) NOT NULL/)
})

test('the result table documents its terminal-state lifecycle', () => {
  const statement = createTableStatement('kaudit_call_audit_result')
  assert.match(statement, /pending -> exactly one terminal state/)
  assert.match(statement, /IMMUTABLE once terminal/)
  assert.match(statement, /NEW run and a NEW row, never a rewrite/)
})

test('results hold KServe comparison, sanitized feedback, and error metadata', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'kserve_reported_outcome')
  assertColumn(table, 'kserve_comparison_label')
  assertColumn(table, 'mismatch_severity')
  assertColumn(table, 'management_feedback')
  assertColumn(table, 'kserve_feedback')
  assertColumn(table, 'error_code', /varchar\(80\)/)
  assertColumn(table, 'error_detail')
  for (const column of ['management_feedback', 'kserve_feedback']) {
    const line = body(table)
      .split('\n')
      .findIndex((candidate) =>
        candidate.trimStart().startsWith('`' + column + '`'),
      )
    const comment = body(table).split('\n')[line + 1]
    assert.match(comment, /Sanitized/)
  }
})

test('results store structured JSON that is validated and hashed', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'result_json', /longtext/)
  assertColumn(table, 'result_sha256', /char\(64\)/)
  assert.match(body(table), /CHECK \(`result_json` IS NULL OR json_valid\(`result_json`\)\)/)
})

test('results are idempotent and indexed for run and report reads', () => {
  const table = 'kaudit_call_audit_result'
  assertColumn(table, 'idempotency_key', /varchar\(191\) NOT NULL/)
  assert.match(
    body(table),
    /UNIQUE KEY `uq_call_audit_result_idempotency` \(`idempotency_key`\)/,
  )
  assert.match(body(table), /KEY `idx_call_audit_result_run` \(`run_id`, `processing_status`\)/)
  assert.match(body(table), /KEY `idx_call_audit_result_report`/)
  assert.match(body(table), /KEY `idx_call_audit_result_history` \(`source_ref_id`, `created_at`\)/)
})

test('the result table documents append-only history', () => {
  assert.match(
    createTableStatement('kaudit_call_audit_result'),
    /COMMENT='APPEND-ONLY history/,
  )
})

test('the source reference table documents read-only source behavior', () => {
  assert.match(
    createTableStatement('kaudit_call_audit_source_ref'),
    /pointer to ai_voice_leads_received/,
  )
  assert.match(
    body('kaudit_call_audit_source_ref'),
    /External READ-ONLY source; never written, altered, or FK-referenced/,
  )
})

test('the source reference keeps the operational facts', () => {
  const table = 'kaudit_call_audit_source_ref'
  assertColumn(table, 'source_updated_at', /datetime\(6\)/)
  assertColumn(table, 'call_started_at', /datetime\(6\)/)
  assertColumn(table, 'call_ended_at', /datetime\(6\)/)
  assertColumn(table, 'call_duration_seconds', /int/)
})

// ---------------------------------------------------------------------------
// The deterministic source event time
// ---------------------------------------------------------------------------

test('the source reference persists a required effective call time', () => {
  assertColumn(
    'kaudit_call_audit_source_ref',
    'effective_call_at',
    /datetime\(6\) NOT NULL/,
  )
  const comment = body('kaudit_call_audit_source_ref')
    .split('\n')
    .find((line) => line.includes('Deterministic source event time'))
  assert.ok(comment, 'effective_call_at must document what it is')
  assert.match(comment, /COALESCE\(call_start_time, date_time, timestamp\)/)
})

test('period and report indexes lead with effective_call_at', () => {
  const table = 'kaudit_call_audit_source_ref'
  assert.match(
    body(table),
    /KEY `idx_call_audit_source_ref_period` \(`effective_call_at`\)/,
  )
  assert.match(
    body(table),
    /KEY `idx_call_audit_source_ref_report`\s*\(`effective_call_at`, `company`\(64\), `service_category`\(64\)\)/,
  )
  assert.match(
    body(table),
    /KEY `idx_call_audit_source_ref_eligibility`\s*\(`has_transcript`, `effective_call_at`\)/,
  )
})

test('no index uses the nullable call_started_at as its time column', () => {
  // call_start_time is null for many real calls; an index keyed on it would
  // silently drop those calls from every period-scoped report.
  const keys = [
    ...body('kaudit_call_audit_source_ref').matchAll(
      /(?:UNIQUE )?KEY `(\w+)`\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g,
    ),
  ]
  assert.ok(keys.length > 0)
  for (const [, name, definition] of keys) {
    assert.equal(
      definition.includes('`call_started_at`'),
      false,
      `index ${name} must use effective_call_at, not call_started_at`,
    )
  }
})

test('call_started_at is documented as unfit for period selection', () => {
  const line = body('kaudit_call_audit_source_ref')
    .split('\n')
    .find((candidate) => candidate.includes('never the basis for period'))
  assert.ok(line, 'call_started_at must warn against period selection')
})

// ---------------------------------------------------------------------------
// Source-aligned reporting snapshot
// ---------------------------------------------------------------------------

/** Exact widths from ai_voice_leads_received; a narrower type would truncate. */
const SOURCE_ALIGNED_COLUMNS: ReadonlyArray<readonly [string, number]> = [
  ['company_by_kserve', 255],
  ['company', 255],
  ['data_source', 350],
  ['verified_source', 300],
  ['service_category', 300],
  ['call_type', 200],
  ['call_status', 200],
  ['call_end_reason', 255],
  ['final_call_status', 300],
  ['ai_call_category', 1000],
  ['customer_engagement_level', 300],
  ['interest_level', 200],
  ['call_outcome', 255],
  ['lead_status', 300],
  ['final_lead_outcome', 300],
  ['calculated_qualification_status', 300],
  ['followup_required', 300],
]

test('reporting columns are source aligned at exact widths', () => {
  for (const [column, width] of SOURCE_ALIGNED_COLUMNS) {
    assertColumn(
      'kaudit_call_audit_source_ref',
      column,
      new RegExp('varchar\\(' + width + '\\) DEFAULT NULL'),
    )
  }
})

test('the obsolete shortened reporting columns are gone', () => {
  for (const column of [
    'source_channel',
    'service_code',
    'company_code',
    'language_code',
  ]) {
    assert.equal(
      hasColumn('kaudit_call_audit_source_ref', column),
      false,
      `${column} was replaced by a source-aligned column and must not remain`,
    )
  }
})

test('no reporting column is narrower than its source column', () => {
  const table = 'kaudit_call_audit_source_ref'
  for (const [column, width] of SOURCE_ALIGNED_COLUMNS) {
    const line = body(table)
      .split('\n')
      .find((candidate) => candidate.trimStart().startsWith('`' + column + '`'))
    assert.ok(line, `${column} not declared`)
    const declared = line.match(/varchar\((\d+)\)/)
    assert.ok(declared, `${column} must be a varchar`)
    assert.ok(
      Number(declared[1]) >= width,
      `${column} is varchar(${declared[1]}), narrower than the source ${width}`,
    )
  }
})

test('the reporting snapshot holds no source free text', () => {
  for (const column of [
    'ai_call_summary',
    'customer_intent',
    'next_action_required',
    'notes',
    'subject',
    'customer_context',
    'additional_notes',
    'response',
    'remarks',
    'comments',
    'description',
  ]) {
    assert.equal(
      hasColumn('kaudit_call_audit_source_ref', column),
      false,
      `${column} is source free text and must never be persisted`,
    )
  }
})

test('report indexes use the corrected columns and stay within InnoDB limits', () => {
  const table = 'kaudit_call_audit_source_ref'
  assert.match(
    body(table),
    /KEY `idx_call_audit_source_ref_report`\s*\(`effective_call_at`, `company`\(64\), `service_category`\(64\)\)/,
  )
  assert.match(
    body(table),
    /KEY `idx_call_audit_source_ref_status`\s*\(`final_call_status`\(64\), `effective_call_at`\)/,
  )
  assert.match(
    body(table),
    /KEY `idx_call_audit_source_ref_outcome`\s*\(`final_lead_outcome`\(64\), `effective_call_at`\)/,
  )

  // utf8mb4 costs 4 bytes per character and InnoDB caps an index key at 3072
  // bytes, so every indexed string part must be prefixed or short enough.
  const widths = new Map(SOURCE_ALIGNED_COLUMNS)
  const keyDefinitions = [
    ...body(table).matchAll(/(?:UNIQUE )?KEY `\w+`\s*\(([^)]*(?:\([^)]*\)[^)]*)*)\)/g),
  ]
  assert.ok(keyDefinitions.length > 0)
  for (const [, definition] of keyDefinitions) {
    let bytes = 0
    for (const part of definition.split(',')) {
      const named = part.match(/`(\w+)`(?:\((\d+)\))?/)
      if (!named) continue
      const [, column, prefix] = named
      if (prefix) {
        bytes += Number(prefix) * 4
        continue
      }
      const declared = widths.get(column)
      if (declared) {
        bytes += declared * 4
      } else if (column === 'source_table') {
        bytes += 64 * 4
      } else if (column === 'task_id' || column.endsWith('idempotency_key')) {
        bytes += 191 * 4
      } else if (column.endsWith('sha256')) {
        bytes += 64 * 4
      } else {
        bytes += 8
      }
    }
    assert.ok(
      bytes <= 3072,
      `index (${definition.replace(/\s+/g, ' ')}) needs ${bytes} bytes, over the 3072-byte limit`,
    )
  }
})

// ---------------------------------------------------------------------------
// Table 5 — metric scores
// ---------------------------------------------------------------------------

test('metric scores hang off a result and use a metric code', () => {
  const table = 'kaudit_call_audit_metric_score'
  assertColumn(table, 'result_id', /varchar\(40\) NOT NULL/)
  assertColumn(table, 'metric_code', /varchar\(60\) NOT NULL/)
  assert.match(
    executableSql,
    /CONSTRAINT `fk_call_audit_metric_score_result`\s+FOREIGN KEY \(`result_id`\) REFERENCES `kaudit_call_audit_result` \(`id`\)/,
  )
})

test('a metric score is 1-5 or explicit NA, and NA is never zero', () => {
  const table = 'kaudit_call_audit_metric_score'
  assertColumn(table, 'score_value', /tinyint unsigned DEFAULT NULL/)
  assertColumn(table, 'is_not_applicable', /tinyint\(1\) NOT NULL DEFAULT 0/)
  assert.match(
    body(table),
    /\(`is_not_applicable` = 1 AND `score_value` IS NULL\)/,
  )
  assert.match(
    body(table),
    /\(`is_not_applicable` = 0 AND `score_value` BETWEEN 1 AND 5\)/,
  )
})

test('only one score row exists per result and metric', () => {
  assert.match(
    body('kaudit_call_audit_metric_score'),
    /UNIQUE KEY `uq_call_audit_metric_score_result_metric`\s*\(`result_id`, `metric_code`\)/,
  )
})

test('metric scores carry no unproduced rationale or confidence column', () => {
  // The approved output contract produces neither, so an empty nullable prose
  // column would only invite an unsanitized transcript quote later.
  const table = 'kaudit_call_audit_metric_score'
  assert.equal(hasColumn(table, 'rationale'), false)
  assert.equal(hasColumn(table, 'confidence'), false)
  // The rationale lives in a leading SQL comment, so search the raw file.
  const note = sql
    .split('\n')
    .find((candidate) => candidate.includes('Deliberately no per-metric'))
  assert.ok(note, 'the omission must be documented, not accidental')
})

// ---------------------------------------------------------------------------
// Table 6 — the append-only AI usage ledger
// ---------------------------------------------------------------------------

const USAGE = 'kaudit_call_audit_usage_event'

test('the usage ledger records one row per model request attempt', () => {
  assertColumn(USAGE, 'id', /varchar\(40\) NOT NULL/)
  assertColumn(USAGE, 'result_id', /varchar\(40\) NOT NULL/)
  assertColumn(USAGE, 'run_id', /varchar\(40\) NOT NULL/)
  assertColumn(USAGE, 'rule_version_id', /varchar\(40\) NOT NULL/)
  assertColumn(USAGE, 'attempt_number', /int NOT NULL/)
  assertColumn(USAGE, 'attempt_outcome', /varchar\(20\) NOT NULL/)
  assertColumn(USAGE, 'recorded_at', /datetime\(6\) NOT NULL/)
  assertColumn(USAGE, 'created_at', /datetime\(6\) NOT NULL DEFAULT current_timestamp\(6\)/)
})

test('every attempt outcome is recorded, not only successes', () => {
  assert.match(
    body(USAGE),
    /CHECK \(`attempt_outcome` IN \('succeeded', 'refused', 'failed'\)\)/,
  )
  const statement = createTableStatement(USAGE)
  assert.match(statement, /APPEND-ONLY attempt ledger/)
  assert.match(statement, /including retries, refusals, and failures/)
  assert.match(sql, /would under-report spend and hide reliability/)
})

test('the usage ledger stores provider, model, tokens, and timing', () => {
  assertColumn(USAGE, 'provider_name', /varchar\(80\) NOT NULL/)
  assertColumn(USAGE, 'model_name', /varchar\(100\) NOT NULL/)
  assertColumn(USAGE, 'model_version', /varchar\(100\) NOT NULL/)
  for (const column of ['input_tokens', 'output_tokens', 'total_tokens']) {
    assertColumn(USAGE, column, /bigint DEFAULT NULL/)
  }
  assertColumn(USAGE, 'request_id', /varchar\(120\) DEFAULT NULL/)
  assertColumn(USAGE, 'latency_ms', /bigint DEFAULT NULL/)
  assertColumn(USAGE, 'error_code', /varchar\(80\) DEFAULT NULL/)
})

test('a retried attempt is idempotent per result', () => {
  assert.match(
    body(USAGE),
    /UNIQUE KEY `uq_call_audit_usage_attempt` \(`result_id`, `attempt_number`\)/,
  )
  assert.match(body(USAGE), /CHECK \(`attempt_number` >= 1\)/)
})

test('usage counts and latency can never be negative', () => {
  for (const column of [
    'input_tokens',
    'output_tokens',
    'total_tokens',
    'latency_ms',
  ]) {
    assert.match(
      body(USAGE),
      new RegExp(
        'CHECK \\(`' + column + '` IS NULL OR `' + column + '` >= 0\\)',
      ),
      `${column} must have a non-negative check`,
    )
  }
})

test('the usage ledger is indexed for run and model cost reporting', () => {
  assert.match(
    body(USAGE),
    /KEY `idx_call_audit_usage_run_time` \(`run_id`, `recorded_at`\)/,
  )
  assert.match(
    body(USAGE),
    /KEY `idx_call_audit_usage_model_time`\s*\(`provider_name`, `model_name`, `recorded_at`\)/,
  )
  assert.match(
    body(USAGE),
    /KEY `idx_call_audit_usage_outcome` \(`attempt_outcome`, `recorded_at`\)/,
  )
})

test('a usage event is pinned to its result run and rule as one triple', () => {
  assert.match(
    executableSql,
    /CONSTRAINT `fk_call_audit_usage_provenance`\s+FOREIGN KEY \(`result_id`, `run_id`, `rule_version_id`\)\s+REFERENCES `kaudit_call_audit_result` \(`id`, `run_id`, `rule_version_id`\)/,
  )
})

test('no independent usage FK arrangement can allow a mismatched triple', () => {
  // Any of these alone would accept a usage row naming result A while
  // denormalizing run B and rule C, because each id would still resolve.
  for (const forbidden of [
    /CONSTRAINT `fk_call_audit_usage_result`/,
    /CONSTRAINT `fk_call_audit_usage_run`/,
    /CONSTRAINT `fk_call_audit_usage_rule_version`/,
    /FOREIGN KEY \(`result_id`\)\s+REFERENCES `kaudit_call_audit_result` \(`id`\)[^,;]*,?\s*(?=ADD CONSTRAINT `fk_call_audit_usage)/,
  ]) {
    assert.equal(
      forbidden.test(executableSql),
      false,
      `a partial usage foreign key (${forbidden}) must not exist`,
    )
  }

  // The usage table declares exactly one foreign key, and it is the composite.
  const usageSection = executableSql.slice(
    executableSql.indexOf('ALTER TABLE `kaudit_call_audit_usage_event`\n  ADD CONSTRAINT'),
  )
  const usageForeignKeys = [
    ...usageSection.slice(0, usageSection.indexOf(';')).matchAll(/FOREIGN KEY/g),
  ]
  assert.equal(usageForeignKeys.length, 1)
})

test('the usage ledger references only call-audit parents', () => {
  const referenced = [
    ...executableSql.matchAll(/REFERENCES `([a-z0-9_]+)`/g),
  ].map((match) => match[1])
  for (const parent of referenced) {
    assert.ok((CALL_AUDIT_TABLES as readonly string[]).includes(parent))
  }
})

test('the usage ledger stores no prompt, response, or customer content', () => {
  for (const column of [
    'prompt',
    'system_prompt',
    'business_prompt',
    'request_body',
    'response_body',
    'raw_response',
    'response',
    'error_message',
    'error_detail',
    'error_payload',
    'refusal_text',
    'transcript',
    'transcription',
    'lead_id',
    'client_name',
    'mobile',
    'email',
    'task_id',
  ]) {
    assert.equal(
      hasColumn(USAGE, column),
      false,
      `${USAGE} must not store ${column}`,
    )
  }
  const comment = sql
    .split('\n')
    .find((line) => line.includes('refusal text, error payload'))
  assert.ok(comment, 'the privacy prohibition must be documented')
})

test('the usage ledger stores no money and never derives cost', () => {
  for (const column of [
    'cost',
    'cost_amount',
    'amount',
    'amount_paise',
    'price',
    'unit_price',
    'currency',
    'spend',
  ]) {
    assert.equal(
      hasColumn(USAGE, column),
      false,
      `${USAGE} must not store ${column}; cost is derived from a price table`,
    )
  }
  assert.match(sql, /this table stores NO cost/)
  assert.match(sql, /An LLM never decides money/)
})

test('the usage ledger is collation-aligned before its foreign keys', () => {
  const convert = executableSql.indexOf(
    "'ALTER TABLE `kaudit_call_audit_usage_event` '",
  )
  const foreignKey = executableSql.indexOf(
    'CONSTRAINT `fk_call_audit_usage_provenance`',
  )
  assert.notEqual(convert, -1, 'the usage table must be collation-aligned')
  assert.ok(convert < foreignKey, 'conversion must precede its foreign keys')
})

// ---------------------------------------------------------------------------
// Repository-wide conventions
// ---------------------------------------------------------------------------

test('every table follows the InnoDB utf8mb4 convention', () => {
  for (const table of CALL_AUDIT_TABLES) {
    assert.match(
      createTableStatement(table),
      /ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci/,
      `${table} does not follow the engine/charset convention`,
    )
  }
})

test('every table has a varchar(40) id primary key', () => {
  for (const table of CALL_AUDIT_TABLES) {
    assertColumn(table, 'id', /varchar\(40\) NOT NULL/)
    assert.match(body(table), /PRIMARY KEY \(`id`\)/)
  }
})

test('all timestamps use microsecond precision', () => {
  for (const table of CALL_AUDIT_TABLES) {
    const stamps = [...body(table).matchAll(/`(\w+_at)`\s+(\S+)/g)]
    assert.ok(stamps.length > 0, `${table} declares no timestamp column`)
    for (const [, column, type] of stamps) {
      assert.equal(
        type,
        'datetime(6)',
        `${table}.${column} must be datetime(6), found ${type}`,
      )
    }
  }
})

test('inherits the installation collation before adding foreign keys', () => {
  const convertIndex = executableSql.indexOf('CONVERT TO CHARACTER SET')
  const foreignKeyIndex = executableSql.indexOf('ADD CONSTRAINT')
  assert.notEqual(convertIndex, -1)
  assert.notEqual(foreignKeyIndex, -1)
  assert.ok(
    convertIndex < foreignKeyIndex,
    'collation conversion must precede foreign keys',
  )
  assert.match(executableSql, /@kaudit_parent_collation/)
  for (const table of CALL_AUDIT_TABLES) {
    assert.match(
      executableSql,
      new RegExp("'ALTER TABLE `" + table + "` '"),
      `${table} is not collation-aligned`,
    )
  }
})

test('restores byte-exact collation on canonical JSON columns', () => {
  for (const column of ['scoring_config_json', 'result_json']) {
    assert.match(
      executableSql,
      new RegExp(
        'MODIFY COLUMN `' +
          column +
          '` longtext\\s+CHARACTER SET utf8mb4 COLLATE utf8mb4_bin',
      ),
      `${column} must stay utf8mb4_bin after conversion`,
    )
  }
})

test('the scoring config comment admits that it carries rubric weights', () => {
  assert.equal(
    sql.includes('no weights applied yet'),
    false,
    'scoring_config_json does include weights; the stale claim must go',
  )
  const line = body('kaudit_call_audit_rule_version')
    .split('\n')
    .find((candidate) => candidate.includes('rubric metric codes AND weights'))
  assert.ok(line, 'scoring_config_json must state that it carries weights')
})

test('the privacy header does not deny storing the business prompt', () => {
  // business_prompt is stored on purpose; claiming otherwise would be a false
  // privacy assurance that a reviewer could rely on.
  assert.equal(
    sql.includes('No prompt text, raw'),
    false,
    'the header must not claim that no prompt text is stored',
  )
  assert.match(sql, /NO per-call prompt/)
  assert.match(sql, /NO prompt containing customer data is\s*--\s*ever stored/)
  assert.match(sql, /`business_prompt` on a rule version IS\s*--\s*stored deliberately/)
  assertColumn('kaudit_call_audit_rule_version', 'business_prompt', /longtext NOT NULL/)
})

test('documents the forward-fix policy and the privacy prohibition', () => {
  assert.match(sql, /EXPAND ONLY/)
  assert.match(sql, /Forward-fix policy:/)
  assert.match(sql, /Source-table read-only behavior:/)
  assert.match(sql, /Privacy boundary/)
})
