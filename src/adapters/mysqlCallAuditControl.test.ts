import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { Pool } from 'mysql2/promise'
import {
  buildRuleVersionId,
  buildRunId,
  CALL_AUDIT_CONTROL_SQL,
  CallAuditControlConflictError,
  CallAuditControlError,
  CallAuditControlTransitionError,
  createMysqlCallAuditControlRepository,
  validateRunRequest,
  ZERO_RUN_COUNTERS,
  type CallAuditRuleVersionLifecycle,
  type CallAuditRunCounters,
  type CallAuditRunRequest,
} from './mysqlCallAuditControl.ts'
import {
  buildRuleActivation,
  type CallAuditRuleActivation,
} from '../callaudit/ruleActivation.ts'

// ---------------------------------------------------------------------------
// Recording fake connection / pool. No database is ever contacted.
// ---------------------------------------------------------------------------

interface Call {
  sql: string
  parameters: unknown[]
  /** Which executor ran it: a lifecycle write must use the connection. */
  via: 'pool' | 'connection'
}

interface RowRule {
  /** Every substring must appear in the statement for the rule to apply. */
  match: string | string[]
  rows: unknown[]
  /**
   * Number of leading matching reads that return nothing first. Models a lost
   * race: the row only becomes visible after a concurrent writer committed it.
   */
  skip?: number
}

interface FakePoolOptions {
  rows?: RowRule[]
  /** Throw when a statement matching this substring executes. */
  failOn?: { match: string; error: Error }
}

function matches(sql: string, match: string | string[]): boolean {
  const parts = Array.isArray(match) ? match : [match]
  return parts.every((part) => sql.includes(part))
}

function fakePool(options: FakePoolOptions = {}) {
  const calls: Call[] = []
  const transaction: string[] = []
  const reads = new Map<RowRule, number>()
  let released = 0

  function executor(via: 'pool' | 'connection') {
    return async function execute(sql: string, parameters: unknown[] = []) {
      calls.push({ sql, parameters, via })
      if (options.failOn && sql.includes(options.failOn.match)) {
        throw options.failOn.error
      }
      const configured = options.rows?.find((entry) =>
        matches(sql, entry.match),
      )
      if (!configured) {
        return [[]]
      }
      const seen = reads.get(configured) ?? 0
      reads.set(configured, seen + 1)
      return [seen < (configured.skip ?? 0) ? [] : configured.rows]
    }
  }

  const connection = {
    execute: executor('connection'),
    async beginTransaction() {
      transaction.push('begin')
    },
    async commit() {
      transaction.push('commit')
    },
    async rollback() {
      transaction.push('rollback')
    },
    release() {
      released += 1
    },
  }

  const pool = {
    execute: executor('pool'),
    async getConnection() {
      return connection
    },
  } as unknown as Pool

  return {
    pool,
    calls,
    transaction,
    get released() {
      return released
    },
    find(match: string) {
      return calls.find((call) => call.sql.includes(match))
    },
    all(match: string) {
      return calls.filter((call) => call.sql.includes(match))
    },
  }
}

function duplicateEntry(): Error {
  return Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY' })
}

// ---------------------------------------------------------------------------
// Synthetic fixtures. Administrator-authored prompt text only: no customer
// content, no transcript, no PII, no lead identifier anywhere in this file.
// ---------------------------------------------------------------------------

const SYNTHETIC_PROMPT =
  'Assess each transcript against the approved rubric. Report only the ' +
  'structured fields defined by the output schema. Never invent facts.'

function activation(
  overrides: Partial<{
    versionLabel: string
    businessPrompt: string
    modelProvider: string
    modelName: string
    modelVersion: string
    temperature: string
  }> = {},
): CallAuditRuleActivation {
  return buildRuleActivation({
    versionLabel: 'call-audit/2026.08.1',
    businessPrompt: SYNTHETIC_PROMPT,
    modelProvider: 'synthetic-provider',
    modelName: 'synthetic-model',
    modelVersion: '2026-08-01',
    temperature: '0.200',
    ...overrides,
  })
}

const DRAFT_LIFECYCLE: CallAuditRuleVersionLifecycle = {
  status: 'draft',
  createdBy: 'usr_admin_0001',
  changeReason: 'Initial draft of the approved rubric guidance.',
}

const ACTIVE_LIFECYCLE: CallAuditRuleVersionLifecycle = {
  status: 'active',
  createdBy: 'usr_admin_0001',
  activatedBy: 'usr_admin_0002',
  activatedAt: '2026-08-01 09:00:00.000000',
  changeReason: 'Approved for live auditing.',
}

function ruleVersionRow(
  snapshot: CallAuditRuleActivation,
  lifecycle: CallAuditRuleVersionLifecycle,
  overrides: Record<string, unknown> = {},
) {
  return {
    id: buildRuleVersionId(snapshot),
    version_label: snapshot.versionLabel,
    status: lifecycle.status,
    business_prompt: snapshot.businessPrompt,
    prompt_sha256: snapshot.promptSha256,
    model_provider: snapshot.modelProvider,
    model_name: snapshot.modelName,
    model_version: snapshot.modelVersion,
    temperature: snapshot.temperature,
    rule_contract_version: snapshot.ruleContractVersion,
    output_schema_version: snapshot.outputSchemaVersion,
    taxonomy_version: snapshot.taxonomyVersion,
    scoring_config_version: snapshot.scoringConfigVersion,
    scoring_config_json: snapshot.scoringConfigJson,
    config_sha256: snapshot.configSha256,
    change_reason: lifecycle.changeReason ?? null,
    created_by: lifecycle.createdBy ?? null,
    activated_by: lifecycle.activatedBy ?? null,
    activated_at: lifecycle.activatedAt ?? null,
    retired_by: lifecycle.retiredBy ?? null,
    retired_at: lifecycle.retiredAt ?? null,
    ...overrides,
  }
}

const RULE_VERSION_ID = 'crv_000000000000000000000000000000000a'

function runRequest(
  overrides: Partial<CallAuditRunRequest> = {},
): CallAuditRunRequest {
  return {
    ruleVersionId: RULE_VERSION_ID,
    runType: 'daily',
    periodStart: '2026-08-01 00:00:00',
    periodEndExclusive: '2026-08-02 00:00:00',
    periodTimezone: 'Asia/Kolkata',
    idempotencyKey: 'call-audit-run:daily:2026-08-01',
    correlationId: 'corr-0001',
    triggeredBy: null,
    scheduledAt: '2026-08-02 00:05:00',
    ...overrides,
  }
}

const COUNTERS: CallAuditRunCounters = {
  totalCandidates: 120,
  processedCount: 120,
  succeededCount: 110,
  failedCount: 4,
  skippedCount: 6,
  contentAuditableCount: 100,
  operationalOnlyCount: 20,
}

function runRow(
  overrides: Record<string, unknown> = {},
  request: CallAuditRunRequest = runRequest(),
) {
  const validated = validateRunRequest(request)
  return {
    id: buildRunId(validated),
    rule_version_id: validated.ruleVersionId,
    run_type: validated.runType,
    period_start: validated.periodStart,
    period_end_exclusive: validated.periodEndExclusive,
    period_timezone: validated.periodTimezone,
    status: 'pending',
    total_candidates: 0,
    processed_count: 0,
    succeeded_count: 0,
    failed_count: 0,
    skipped_count: 0,
    content_auditable_count: 0,
    operational_only_count: 0,
    correlation_id: validated.correlationId,
    idempotency_key: validated.idempotencyKey,
    triggered_by: validated.triggeredBy,
    error_code: null,
    scheduled_at: validated.scheduledAt,
    started_at: null,
    finished_at: null,
    ...overrides,
  }
}

const RULE_VERSION_MATCH = 'OR `version_label` = ?'
const RUN_BY_KEY_MATCH = 'WHERE `idempotency_key` = ?'
const RUN_BY_ID_MATCH = ['`kaudit_call_audit_run`', 'WHERE `id` = ?']

const ALL_SQL = Object.values(CALL_AUDIT_CONTROL_SQL)
const MODULE_SOURCE = readFileSync(
  new URL('./mysqlCallAuditControl.ts', import.meta.url),
  'utf8',
)

/** Source with comments and string/identifier literals blanked out. */
const EXECUTABLE_SOURCE = MODULE_SOURCE.split('\n')
  .filter((line) => !line.trimStart().startsWith('*'))
  .filter((line) => !line.trimStart().startsWith('//'))
  .join('\n')
  .replace(/'[^']*'/g, "''")
  .replace(/`[^`]*`/g, '``')

// ---------------------------------------------------------------------------
// SQL safety
// ---------------------------------------------------------------------------

test('every statement is parameterized and uses explicit columns', () => {
  for (const sql of ALL_SQL) {
    assert.equal(/SELECT\s+\*/i.test(sql), false, `SELECT * in: ${sql}`)
    assert.ok(sql.includes('?'), `no placeholder in: ${sql}`)
    // No value is ever concatenated into the statement text.
    assert.equal(/'\s*\+/.test(sql), false, `concatenation in: ${sql}`)
    assert.equal(/\$\{/.test(sql), false, `interpolation in: ${sql}`)
  }
  assert.match(
    CALL_AUDIT_CONTROL_SQL.insertRuleVersion,
    /INSERT INTO `kaudit_call_audit_rule_version`\n\s+\(`id`, `version_label`, `status`, `business_prompt`,/,
  )
  assert.match(
    CALL_AUDIT_CONTROL_SQL.insertRun,
    /INSERT INTO `kaudit_call_audit_run`\n\s+\(`id`, `rule_version_id`, `run_type`,/,
  )
})

test('the insert placeholder count matches the explicit column count', () => {
  for (const sql of [
    CALL_AUDIT_CONTROL_SQL.insertRuleVersion,
    CALL_AUDIT_CONTROL_SQL.insertRun,
  ]) {
    const columns = sql.slice(sql.indexOf('('), sql.indexOf('VALUES'))
    const values = sql.slice(sql.indexOf('VALUES'))
    assert.equal(
      columns.split(',').length,
      values.split(',').length,
      `column/placeholder mismatch in: ${sql}`,
    )
  }
})

test('only the two call-audit control tables are named', () => {
  const targets = new Set<string>()
  for (const sql of ALL_SQL) {
    for (const match of sql.matchAll(
      /(?:INSERT INTO|FROM|UPDATE)\s+`([a-z0-9_]+)`/gi,
    )) {
      targets.add(match[1])
    }
  }
  assert.deepEqual(
    [...targets].sort(),
    ['kaudit_call_audit_rule_version', 'kaudit_call_audit_run'],
  )
})

test('the module never reads, writes, locks, or references the source table', () => {
  assert.equal(
    EXECUTABLE_SOURCE.includes('ai_voice_leads_received'),
    false,
    'the control repository must never name the read-only source table',
  )
  for (const sql of ALL_SQL) {
    assert.equal(sql.includes('ai_voice_leads_received'), false)
    assert.equal(/\bLOCK\s+TABLES\b/i.test(sql), false)
    assert.equal(/\bFOREIGN\s+KEY\b/i.test(sql), false)
  }
})

test('every FOR UPDATE lock is taken on a control table only', () => {
  const locking = ALL_SQL.filter((sql) => /\bFOR\s+UPDATE\b/i.test(sql))
  assert.ok(locking.length > 0, 'lifecycle transitions must lock their row')
  for (const sql of locking) {
    const tables = [...sql.matchAll(/FROM\s+`([a-z0-9_]+)`/gi)].map(
      (match) => match[1],
    )
    assert.deepEqual(
      [...new Set(tables)].sort(),
      tables.includes('kaudit_call_audit_run')
        ? ['kaudit_call_audit_run']
        : ['kaudit_call_audit_rule_version'],
      `unexpected locked table in: ${sql}`,
    )
  }
})

test('no statement updates a rule-version row', () => {
  for (const sql of ALL_SQL) {
    assert.equal(
      /UPDATE\s+`kaudit_call_audit_rule_version`/i.test(sql),
      false,
      `an activated or retired contract must never be edited: ${sql}`,
    )
  }
  // Corrections are new versions, so the writer needs no update path at all.
  const updated = new Set(
    ALL_SQL.flatMap((sql) =>
      [...sql.matchAll(/UPDATE\s+`([a-z0-9_]+)`/gi)].map((match) => match[1]),
    ),
  )
  assert.deepEqual([...updated], ['kaudit_call_audit_run'])
})

test('the adapter uses execute, never query', () => {
  assert.equal(/\bpool\.query\b/.test(MODULE_SOURCE), false)
  assert.equal(/\bconnection\.query\b/.test(MODULE_SOURCE), false)
  assert.match(MODULE_SOURCE, /pool\.execute</)
  assert.match(MODULE_SOURCE, /connection\.execute\(/)
})

test('no statement carries a destructive, private, or money-bearing column', () => {
  for (const sql of ALL_SQL) {
    for (const forbidden of [
      /\bDELETE\b/i,
      /\bTRUNCATE\b/i,
      /\bDROP\b/i,
      /\bALTER\b/i,
      /\bREPLACE\s+INTO\b/i,
      /ON\s+DUPLICATE\s+KEY/i,
      /\btranscript\b/i,
      /\blead_id\b/i,
      /\bmobile\b/i,
      /\bemail\b/i,
      /\burl\b/i,
      /\bcost\b/i,
      /\bamount\b/i,
      /\bprice\b/i,
      /\bcurrency\b/i,
      /\binvoice\b/i,
      /raw_response/i,
      /error_message/i,
    ]) {
      assert.equal(forbidden.test(sql), false, `${forbidden} found in: ${sql}`)
    }
  }
})

test('the only prompt-bearing columns are the administrator-authored pair', () => {
  const promptColumns = new Set<string>()
  for (const sql of ALL_SQL) {
    for (const match of sql.matchAll(/`([a-z0-9_]*prompt[a-z0-9_]*)`/gi)) {
      promptColumns.add(match[1])
    }
  }
  // migration 0008 stores the business prompt deliberately; nothing else here
  // may carry prompt text, and no per-call prompt is ever persisted.
  assert.deepEqual([...promptColumns].sort(), [
    'business_prompt',
    'prompt_sha256',
  ])
})

test('the module imports no billing or money module', () => {
  for (const line of MODULE_SOURCE.split('\n')) {
    if (!line.startsWith('import')) continue
    assert.equal(/billing/i.test(line), false, `billing import: ${line}`)
    assert.equal(/decimal|money/i.test(line), false, `money import: ${line}`)
  }
})

// ---------------------------------------------------------------------------
// Deterministic ids
// ---------------------------------------------------------------------------

test('the rule-version id is deterministic, prefixed, and varchar(40)', () => {
  const id = buildRuleVersionId(activation())
  assert.equal(id, buildRuleVersionId(activation()))
  assert.match(id, /^crv_[0-9a-f]{36}$/)
  assert.equal(id.length, 40)
})

test('the rule-version id moves with every part of its identity tuple', () => {
  const baseline = buildRuleVersionId(activation())
  assert.notEqual(
    baseline,
    buildRuleVersionId(activation({ versionLabel: 'call-audit/2026.08.2' })),
  )
  assert.notEqual(
    baseline,
    buildRuleVersionId(
      activation({ businessPrompt: `${SYNTHETIC_PROMPT} Be concise.` }),
    ),
  )
  const snapshot = activation()
  assert.notEqual(
    baseline,
    buildRuleVersionId({ ...snapshot, configSha256: 'f'.repeat(64) }),
  )
  // The model is NOT part of the identity: swapping a model must not look like
  // a prompt or contract change. It is still compared on replay.
  assert.equal(
    baseline,
    buildRuleVersionId(activation({ modelName: 'other-model' })),
  )
})

test('the run id is deterministic, prefixed, and varchar(40)', () => {
  const id = buildRunId(validateRunRequest(runRequest()))
  assert.equal(id, buildRunId(validateRunRequest(runRequest())))
  assert.match(id, /^crn_[0-9a-f]{36}$/)
  assert.equal(id.length, 40)
})

test('the run id moves with every part of its identity tuple', () => {
  const baseline = buildRunId(validateRunRequest(runRequest()))
  const variants: Array<Partial<CallAuditRunRequest>> = [
    { ruleVersionId: 'crv_000000000000000000000000000000000b' },
    { runType: 'manual' },
    { periodStart: '2026-08-01 00:00:01' },
    { periodEndExclusive: '2026-08-03 00:00:00' },
    { periodTimezone: 'UTC' },
    { idempotencyKey: 'call-audit-run:daily:2026-08-02' },
  ]
  for (const variant of variants) {
    assert.notEqual(
      baseline,
      buildRunId(validateRunRequest(runRequest(variant))),
      `id did not move for ${Object.keys(variant)[0]}`,
    )
  }
  // A fractional-second spelling of the same instant is the same run.
  assert.equal(
    baseline,
    buildRunId(
      validateRunRequest(runRequest({ periodStart: '2026-08-01 00:00:00.0' })),
    ),
  )
})

// ---------------------------------------------------------------------------
// Rule version persistence
// ---------------------------------------------------------------------------

test('a new rule version is inserted transactionally with explicit lifecycle', async () => {
  const db = fakePool()
  const snapshot = activation()
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).saveRuleVersionSnapshot(snapshot, DRAFT_LIFECYCLE)

  assert.deepEqual(result, {
    id: buildRuleVersionId(snapshot),
    outcome: 'inserted',
  })
  assert.deepEqual(db.transaction, ['begin', 'commit'])
  assert.equal(db.released, 1)

  const insert = db.find('INSERT INTO `kaudit_call_audit_rule_version`')
  assert.ok(insert)
  assert.equal(insert.via, 'connection')
  assert.deepEqual(insert.parameters.slice(0, 5), [
    buildRuleVersionId(snapshot),
    'call-audit/2026.08.1',
    'draft',
    SYNTHETIC_PROMPT,
    snapshot.promptSha256,
  ])
  // The lifecycle tail: change reason, creator, and the absent activation.
  assert.deepEqual(insert.parameters.slice(-6), [
    'Initial draft of the approved rubric guidance.',
    'usr_admin_0001',
    null,
    null,
    null,
    null,
  ])
  // The locked read precedes the insert.
  const locked = db.find('FOR UPDATE')
  assert.ok(locked)
  assert.deepEqual(locked.parameters, [
    buildRuleVersionId(snapshot),
    'call-audit/2026.08.1',
  ])
})

test('an identical rule-version snapshot replays without writing', async () => {
  const snapshot = activation()
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(snapshot, DRAFT_LIFECYCLE)],
      },
    ],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).saveRuleVersionSnapshot(snapshot, DRAFT_LIFECYCLE)

  assert.deepEqual(result, {
    id: buildRuleVersionId(snapshot),
    outcome: 'replayed',
  })
  assert.equal(db.all('INSERT INTO').length, 0)
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
})

test('the same version label with a different prompt is a typed conflict', async () => {
  const stored = activation()
  const edited = activation({
    businessPrompt: `${SYNTHETIC_PROMPT} Prefer the shortest accurate label.`,
  })
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(stored, DRAFT_LIFECYCLE)],
      },
    ],
  })
  const repository = createMysqlCallAuditControlRepository(db.pool)

  const error = await repository
    .saveRuleVersionSnapshot(edited, DRAFT_LIFECYCLE)
    .then(
      () => null,
      (thrown: unknown) => thrown,
    )

  assert.ok(error instanceof CallAuditControlConflictError)
  assert.equal(error.entity, 'ruleVersion')
  // The id is derived from the prompt digest, so it is the first divergence.
  assert.equal(error.field, 'id')
  assert.equal(db.all('INSERT INTO').length, 0)
})

test('a conflict message names the column and never echoes the prompt', async () => {
  const stored = activation()
  // Same label AND same prompt digest identity, differing only in the model, so
  // the comparison reaches a column that is not part of the derived id.
  const edited = activation({ modelName: 'other-model' })
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(stored, DRAFT_LIFECYCLE)],
      },
    ],
  })

  const error = await createMysqlCallAuditControlRepository(db.pool)
    .saveRuleVersionSnapshot(edited, DRAFT_LIFECYCLE)
    .then(
      () => null,
      (thrown: unknown) => thrown,
    )

  assert.ok(error instanceof CallAuditControlConflictError)
  assert.equal(error.field, 'model_name')
  assert.equal(error.message.includes(SYNTHETIC_PROMPT), false)
  assert.equal(error.message.includes(stored.promptSha256), false)
  assert.equal(error.message.includes(stored.scoringConfigJson), false)
})

test('a differing business prompt under the same id conflicts on its own column', async () => {
  const snapshot = activation()
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        // A row whose stored prompt no longer matches its own digest: the
        // replay must refuse it rather than treat the digest alone as proof.
        rows: [
          ruleVersionRow(snapshot, DRAFT_LIFECYCLE, {
            business_prompt: 'A different administrator prompt.',
          }),
        ],
      },
    ],
  })

  const error = await createMysqlCallAuditControlRepository(db.pool)
    .saveRuleVersionSnapshot(snapshot, DRAFT_LIFECYCLE)
    .then(
      () => null,
      (thrown: unknown) => thrown,
    )

  assert.ok(error instanceof CallAuditControlConflictError)
  assert.equal(error.field, 'business_prompt')
  assert.equal(error.message.includes(SYNTHETIC_PROMPT), false)
  assert.equal(error.message.includes('A different administrator prompt.'), false)
})

test('a differing lifecycle payload under the same identity is a conflict', async () => {
  const snapshot = activation()
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(snapshot, ACTIVE_LIFECYCLE)],
      },
    ],
  })

  const error = await createMysqlCallAuditControlRepository(db.pool)
    .saveRuleVersionSnapshot(snapshot, DRAFT_LIFECYCLE)
    .then(
      () => null,
      (thrown: unknown) => thrown,
    )

  assert.ok(error instanceof CallAuditControlConflictError)
  assert.equal(error.field, 'status')
})

test('an activated row is never updated in place', async () => {
  const snapshot = activation()
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(snapshot, ACTIVE_LIFECYCLE)],
      },
    ],
  })
  const repository = createMysqlCallAuditControlRepository(db.pool)

  // Replaying the activation is a no-op...
  assert.equal(
    (await repository.saveRuleVersionSnapshot(snapshot, ACTIVE_LIFECYCLE))
      .outcome,
    'replayed',
  )
  // ...and retiring it through this API is refused, not applied.
  await assert.rejects(
    repository.saveRuleVersionSnapshot(snapshot, {
      ...ACTIVE_LIFECYCLE,
      status: 'retired',
      retiredBy: 'usr_admin_0002',
      retiredAt: '2026-09-01 09:00:00.000000',
    }),
    CallAuditControlConflictError,
  )
  assert.equal(db.all('UPDATE ').length, 0)
  assert.equal(db.all('INSERT INTO').length, 0)
})

test('a retired snapshot is stored as a new immutable row', async () => {
  const snapshot = activation()
  const db = fakePool()
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).saveRuleVersionSnapshot(snapshot, {
    status: 'retired',
    createdBy: 'usr_admin_0001',
    activatedBy: 'usr_admin_0002',
    activatedAt: '2026-08-01 09:00:00.000000',
    retiredBy: 'usr_admin_0002',
    retiredAt: '2026-09-01 09:00:00.000000',
  })

  assert.equal(result.outcome, 'inserted')
  const insert = db.find('INSERT INTO `kaudit_call_audit_rule_version`')
  assert.ok(insert)
  assert.equal(insert.parameters[2], 'retired')
  assert.deepEqual(insert.parameters.slice(-2), [
    'usr_admin_0002',
    '2026-09-01 09:00:00.000000',
  ])
  assert.equal(db.all('UPDATE ').length, 0)
})

test('activating a second version while one is active is refused', async () => {
  const db = fakePool({
    rows: [
      {
        match: '`status` = ? AND `id` <> ?',
        rows: [{ id: 'crv_000000000000000000000000000000000c' }],
      },
    ],
  })

  const error = await createMysqlCallAuditControlRepository(db.pool)
    .saveRuleVersionSnapshot(activation(), ACTIVE_LIFECYCLE)
    .then(
      () => null,
      (thrown: unknown) => thrown,
    )

  assert.ok(error instanceof CallAuditControlError)
  assert.equal(error.field, 'status')
  assert.equal(db.all('INSERT INTO').length, 0)
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  // The guard and the insert share one transaction, and it locks only the
  // rule-version table.
  const guard = db.find('`status` = ? AND `id` <> ?')
  assert.ok(guard)
  assert.equal(guard.via, 'connection')
  assert.match(guard.sql, /FROM `kaudit_call_audit_rule_version`/)
})

test('a draft insert takes no active-version guard', async () => {
  const db = fakePool()
  await createMysqlCallAuditControlRepository(db.pool).saveRuleVersionSnapshot(
    activation(),
    DRAFT_LIFECYCLE,
  )
  assert.equal(db.all('`status` = ? AND `id` <> ?').length, 0)
})

test('a lost rule-version insert race reselects and replays', async () => {
  const snapshot = activation()
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_rule_version`',
      error: duplicateEntry(),
    },
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(snapshot, DRAFT_LIFECYCLE)],
        // Invisible on the locked read, committed by the racing writer before
        // the reselect.
        skip: 1,
      },
    ],
  })

  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).saveRuleVersionSnapshot(snapshot, DRAFT_LIFECYCLE)

  assert.deepEqual(result, {
    id: buildRuleVersionId(snapshot),
    outcome: 'replayed',
  })
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  assert.equal(db.released, 1)
  // The reselect runs on the pool, after the transaction's connection is back.
  const reselect = db.all(RULE_VERSION_MATCH).at(-1)
  assert.equal(reselect?.via, 'pool')
})

test('a lost rule-version race with a different payload still conflicts', async () => {
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_rule_version`',
      error: duplicateEntry(),
    },
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [ruleVersionRow(activation(), ACTIVE_LIFECYCLE)],
        skip: 1,
      },
    ],
  })

  await assert.rejects(
    createMysqlCallAuditControlRepository(db.pool).saveRuleVersionSnapshot(
      activation(),
      DRAFT_LIFECYCLE,
    ),
    CallAuditControlConflictError,
  )
})

test('two rows matching id and label separately is a label conflict', async () => {
  const snapshot = activation()
  const db = fakePool({
    rows: [
      {
        match: RULE_VERSION_MATCH,
        rows: [
          ruleVersionRow(snapshot, DRAFT_LIFECYCLE),
          ruleVersionRow(snapshot, DRAFT_LIFECYCLE, { id: 'crv_other' }),
        ],
      },
    ],
  })

  const error = await createMysqlCallAuditControlRepository(db.pool)
    .saveRuleVersionSnapshot(snapshot, DRAFT_LIFECYCLE)
    .then(
      () => null,
      (thrown: unknown) => thrown,
    )

  assert.ok(error instanceof CallAuditControlConflictError)
  assert.equal(error.field, 'version_label')
})

// ---------------------------------------------------------------------------
// Rule version and lifecycle validation
// ---------------------------------------------------------------------------

test('a snapshot whose digest does not cover its own prompt is rejected', async () => {
  const db = fakePool()
  const repository = createMysqlCallAuditControlRepository(db.pool)

  await assert.rejects(
    repository.saveRuleVersionSnapshot(
      { ...activation(), promptSha256: 'a'.repeat(64) },
      DRAFT_LIFECYCLE,
    ),
    (error: unknown) =>
      error instanceof CallAuditControlError &&
      error.field === 'promptSha256' &&
      !error.message.includes(SYNTHETIC_PROMPT),
  )
  await assert.rejects(
    repository.saveRuleVersionSnapshot(
      { ...activation(), configSha256: 'b'.repeat(64) },
      DRAFT_LIFECYCLE,
    ),
    (error: unknown) =>
      error instanceof CallAuditControlError &&
      error.field === 'configSha256',
  )
  assert.equal(db.calls.length, 0, 'nothing may run before validation passes')
})

test('incoherent lifecycle metadata is refused before any statement', async () => {
  const db = fakePool()
  const repository = createMysqlCallAuditControlRepository(db.pool)
  const snapshot = activation()

  for (const [lifecycle, field] of [
    [{ status: 'published' }, 'status'],
    [
      { status: 'draft', activatedAt: '2026-08-01 09:00:00' },
      'activatedAt',
    ],
    [{ status: 'active' }, 'activatedAt'],
    [
      {
        status: 'active',
        activatedAt: '2026-08-01 09:00:00',
        retiredAt: '2026-09-01 09:00:00',
      },
      'retiredAt',
    ],
    [
      { status: 'retired', activatedAt: '2026-08-01 09:00:00' },
      'retiredAt',
    ],
    [
      {
        status: 'retired',
        activatedAt: '2026-09-01 09:00:00',
        retiredAt: '2026-08-01 09:00:00',
      },
      'retiredAt',
    ],
    [
      { status: 'draft', createdBy: 'x'.repeat(41) },
      'createdBy',
    ],
  ] as Array<[CallAuditRuleVersionLifecycle, string]>) {
    await assert.rejects(
      repository.saveRuleVersionSnapshot(snapshot, lifecycle),
      (error: unknown) =>
        error instanceof CallAuditControlError && error.field === field,
      `expected ${field} to be rejected`,
    )
  }
  assert.equal(db.calls.length, 0)
})

// ---------------------------------------------------------------------------
// Run creation
// ---------------------------------------------------------------------------

test('a run is created pending over an exact half-open period', async () => {
  const db = fakePool()
  const request = runRequest()
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).createRun(request)

  assert.deepEqual(result, {
    id: buildRunId(validateRunRequest(request)),
    outcome: 'inserted',
  })
  const insert = db.find('INSERT INTO `kaudit_call_audit_run`')
  assert.ok(insert)
  assert.deepEqual(insert.parameters, [
    buildRunId(validateRunRequest(request)),
    RULE_VERSION_ID,
    'daily',
    '2026-08-01 00:00:00.000000',
    '2026-08-02 00:00:00.000000',
    'Asia/Kolkata',
    'pending',
    // Seven explicit counters, all zero at creation.
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    'corr-0001',
    'call-audit-run:daily:2026-08-01',
    null,
    null,
    '2026-08-02 00:05:00.000000',
    null,
    null,
  ])
  // The run carries its rule version, so (id, rule_version_id) is the composite
  // parent key a result later references as one unit.
  assert.equal(insert.parameters[1], RULE_VERSION_ID)
})

test('every run type is accepted', async () => {
  for (const runType of [
    'daily',
    'monthly',
    'quarterly',
    'yearly',
    'manual',
    'test',
    'backfill',
  ] as const) {
    const db = fakePool()
    const result = await createMysqlCallAuditControlRepository(
      db.pool,
    ).createRun(runRequest({ runType, idempotencyKey: `key:${runType}` }))
    assert.equal(result.outcome, 'inserted')
    assert.equal(db.find('INSERT INTO')?.parameters[2], runType)
  }
})

test('an identical run create replays without inserting', async () => {
  const request = runRequest()
  const db = fakePool({
    rows: [{ match: RUN_BY_KEY_MATCH, rows: [runRow()] }],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).createRun(request)

  assert.deepEqual(result, {
    id: buildRunId(validateRunRequest(request)),
    outcome: 'replayed',
  })
  assert.equal(db.all('INSERT INTO').length, 0)
})

test('a run already underway still replays its create', async () => {
  // Status, counters, and timestamps advance after creation, so re-creating a
  // running run must not read as a conflict.
  const db = fakePool({
    rows: [
      {
        match: RUN_BY_KEY_MATCH,
        rows: [
          runRow({
            status: 'running',
            started_at: '2026-08-02 00:06:00.000000',
            processed_count: 42,
          }),
        ],
      },
    ],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).createRun(runRequest())
  assert.equal(result.outcome, 'replayed')
})

test('the same idempotency key over a different payload is a typed conflict', async () => {
  for (const [variant, field] of [
    [{ periodEndExclusive: '2026-08-03 00:00:00' }, 'id'],
    [{ runType: 'manual' as const }, 'id'],
    [{ periodTimezone: 'UTC' }, 'id'],
    [{ correlationId: 'corr-0002' }, 'correlation_id'],
  ] as Array<[Partial<CallAuditRunRequest>, string]>) {
    const db = fakePool({
      rows: [{ match: RUN_BY_KEY_MATCH, rows: [runRow()] }],
    })
    const error = await createMysqlCallAuditControlRepository(db.pool)
      .createRun(runRequest(variant))
      .then(
        () => null,
        (thrown: unknown) => thrown,
      )

    assert.ok(
      error instanceof CallAuditControlConflictError,
      `expected a conflict for ${Object.keys(variant)[0]}`,
    )
    assert.equal(error.entity, 'run')
    assert.equal(error.field, field)
    // The key itself is never echoed back.
    assert.equal(error.message.includes('call-audit-run:daily'), false)
    assert.equal(db.all('INSERT INTO').length, 0)
  }
})

test('a lost run insert race reselects and replays', async () => {
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_run`',
      error: duplicateEntry(),
    },
    rows: [{ match: RUN_BY_KEY_MATCH, rows: [runRow()], skip: 1 }],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).createRun(runRequest())

  assert.equal(result.outcome, 'replayed')
  assert.equal(db.all(RUN_BY_KEY_MATCH).length, 2)
})

test('a lost run race over a different period still conflicts', async () => {
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_run`',
      error: duplicateEntry(),
    },
    rows: [{ match: RUN_BY_KEY_MATCH, rows: [runRow()], skip: 1 }],
  })
  await assert.rejects(
    createMysqlCallAuditControlRepository(db.pool).createRun(
      runRequest({ periodEndExclusive: '2026-08-05 00:00:00' }),
    ),
    CallAuditControlConflictError,
  )
})

test('a non-duplicate insert error is not swallowed', async () => {
  const db = fakePool({
    failOn: {
      match: 'INSERT INTO `kaudit_call_audit_run`',
      error: Object.assign(new Error('no connection'), {
        code: 'ECONNRESET',
      }),
    },
  })
  await assert.rejects(
    createMysqlCallAuditControlRepository(db.pool).createRun(runRequest()),
    /no connection/,
  )
})

// ---------------------------------------------------------------------------
// Run request validation
// ---------------------------------------------------------------------------

test('an invalid run request is refused before any statement', async () => {
  const db = fakePool()
  const repository = createMysqlCallAuditControlRepository(db.pool)

  for (const [variant, field] of [
    [{ runType: 'weekly' }, 'runType'],
    [{ periodStart: '2026-02-30 00:00:00' }, 'periodStart'],
    [{ periodStart: '2026-08-01T00:00:00Z' }, 'periodStart'],
    [{ periodEndExclusive: '2026-08-01 00:00:00' }, 'periodEndExclusive'],
    [{ periodEndExclusive: '2026-07-31 00:00:00' }, 'periodEndExclusive'],
    [{ periodTimezone: 'Asia Kolkata!' }, 'periodTimezone'],
    [{ periodTimezone: 'z'.repeat(65) }, 'periodTimezone'],
    [{ idempotencyKey: '' }, 'idempotencyKey'],
    [{ idempotencyKey: 'k'.repeat(192) }, 'idempotencyKey'],
    [{ correlationId: 'c'.repeat(121) }, 'correlationId'],
    [{ ruleVersionId: 'r'.repeat(41) }, 'ruleVersionId'],
  ] as Array<[Partial<CallAuditRunRequest>, string]>) {
    await assert.rejects(
      repository.createRun(runRequest(variant)),
      (error: unknown) =>
        error instanceof CallAuditControlError && error.field === field,
      `expected ${field} to be rejected`,
    )
  }
  assert.equal(db.calls.length, 0)
})

test('the period timezone is recorded, never converted', async () => {
  const db = fakePool()
  await createMysqlCallAuditControlRepository(db.pool).createRun(
    runRequest({ periodTimezone: 'UTC' }),
  )
  const insert = db.find('INSERT INTO `kaudit_call_audit_run`')
  // The literals are stored exactly as supplied, alongside the zone label.
  assert.equal(insert?.parameters[3], '2026-08-01 00:00:00.000000')
  assert.equal(insert?.parameters[5], 'UTC')
  for (const sql of ALL_SQL) {
    assert.equal(/CONVERT_TZ/i.test(sql), false, `timezone maths in: ${sql}`)
  }
})

// ---------------------------------------------------------------------------
// Run lifecycle
// ---------------------------------------------------------------------------

test('pending -> running is transactional over a locked row', async () => {
  const db = fakePool({ rows: [{ match: RUN_BY_ID_MATCH, rows: [runRow()] }] })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).markRunRunning({
    runId: runRow().id,
    startedAt: '2026-08-02 00:06:00',
  })

  assert.deepEqual(result, {
    id: runRow().id,
    status: 'running',
    outcome: 'updated',
  })
  assert.deepEqual(db.transaction, ['begin', 'commit'])
  assert.equal(db.released, 1)

  const read = db.find('FOR UPDATE')
  assert.ok(read)
  assert.match(read.sql, /FROM `kaudit_call_audit_run`/)
  const update = db.find('UPDATE `kaudit_call_audit_run`')
  assert.ok(update)
  assert.equal(update.via, 'connection')
  // The expected current status is repeated in the WHERE clause.
  assert.deepEqual(update.parameters, [
    'running',
    '2026-08-02 00:06:00.000000',
    runRow().id,
    'pending',
  ])
})

test('claiming an already-running run replays, and re-claiming it conflicts', async () => {
  const started = '2026-08-02 00:06:00.000000'
  const db = fakePool({
    rows: [
      {
        match: RUN_BY_ID_MATCH,
        rows: [runRow({ status: 'running', started_at: started })],
      },
    ],
  })
  const repository = createMysqlCallAuditControlRepository(db.pool)

  const replay = await repository.markRunRunning({
    runId: runRow().id,
    startedAt: started,
  })
  assert.equal(replay.outcome, 'replayed')
  assert.equal(db.all('UPDATE ').length, 0)

  // A second worker claiming the same run with its own start time is refused:
  // the run is already claimed, and the stamp is not overwritten.
  await assert.rejects(
    repository.markRunRunning({
      runId: runRow().id,
      startedAt: '2026-08-02 00:09:00',
    }),
    (error: unknown) =>
      error instanceof CallAuditControlConflictError &&
      error.field === 'started_at',
  )
  assert.equal(db.all('UPDATE ').length, 0)
})

test('counters are written explicitly and only while the run is open', async () => {
  const db = fakePool({
    rows: [{ match: RUN_BY_ID_MATCH, rows: [runRow({ status: 'running' })] }],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).updateRunCounters(runRow().id, COUNTERS)

  assert.deepEqual(result, {
    id: runRow().id,
    status: 'running',
    outcome: 'updated',
  })
  const update = db.find('UPDATE `kaudit_call_audit_run`')
  assert.ok(update)
  assert.match(
    update.sql,
    /SET `total_candidates` = \?, `processed_count` = \?, `succeeded_count` = \?, `failed_count` = \?, `skipped_count` = \?, `content_auditable_count` = \?, `operational_only_count` = \?/,
  )
  assert.deepEqual(update.parameters, [
    120,
    120,
    110,
    4,
    6,
    100,
    20,
    runRow().id,
    'running',
  ])
})

test('unchanged counters replay instead of rewriting', async () => {
  const db = fakePool({
    rows: [
      {
        match: RUN_BY_ID_MATCH,
        rows: [
          runRow({
            status: 'running',
            total_candidates: 120,
            processed_count: 120,
            succeeded_count: 110,
            failed_count: 4,
            skipped_count: 6,
            content_auditable_count: 100,
            operational_only_count: 20,
          }),
        ],
      },
    ],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).updateRunCounters(runRow().id, COUNTERS)
  assert.equal(result.outcome, 'replayed')
  assert.equal(db.all('UPDATE ').length, 0)
})

test('a counter must be a non-negative safe integer within INT range', async () => {
  const db = fakePool({ rows: [{ match: RUN_BY_ID_MATCH, rows: [runRow()] }] })
  const repository = createMysqlCallAuditControlRepository(db.pool)

  for (const [value, field] of [
    [-1, 'counters.totalCandidates'],
    [1.5, 'counters.totalCandidates'],
    [Number.NaN, 'counters.totalCandidates'],
    [2147483648, 'counters.totalCandidates'],
  ] as Array<[number, string]>) {
    await assert.rejects(
      repository.updateRunCounters(runRow().id, {
        ...ZERO_RUN_COUNTERS,
        totalCandidates: value,
      }),
      (error: unknown) =>
        error instanceof CallAuditControlError && error.field === field,
      `expected ${value} to be rejected`,
    )
  }
  await assert.rejects(
    repository.updateRunCounters(runRow().id, {
      ...ZERO_RUN_COUNTERS,
      failedCount: -3,
    }),
    (error: unknown) =>
      error instanceof CallAuditControlError &&
      error.field === 'counters.failedCount',
  )
  assert.equal(db.all('UPDATE ').length, 0)
})

test('running -> completed writes the terminal status and final counters', async () => {
  const db = fakePool({
    rows: [{ match: RUN_BY_ID_MATCH, rows: [runRow({ status: 'running' })] }],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).markRunCompleted({
    runId: runRow().id,
    finishedAt: '2026-08-02 00:40:00',
    counters: COUNTERS,
  })

  assert.deepEqual(result, {
    id: runRow().id,
    status: 'completed',
    outcome: 'updated',
  })
  const update = db.find('UPDATE `kaudit_call_audit_run`')
  assert.ok(update)
  assert.deepEqual(update.parameters, [
    'completed',
    '2026-08-02 00:40:00.000000',
    // A completed run carries no error code.
    null,
    120,
    120,
    110,
    4,
    6,
    100,
    20,
    runRow().id,
    'pending',
    'running',
  ])
  assert.deepEqual(db.transaction, ['begin', 'commit'])
})

test('running -> failed records a safe machine code only', async () => {
  const db = fakePool({
    rows: [{ match: RUN_BY_ID_MATCH, rows: [runRow({ status: 'running' })] }],
  })
  const repository = createMysqlCallAuditControlRepository(db.pool)

  const result = await repository.markRunFailed({
    runId: runRow().id,
    finishedAt: '2026-08-02 00:41:00',
    errorCode: 'MODEL_UNAVAILABLE',
  })
  assert.equal(result.status, 'failed')
  assert.equal(db.find('UPDATE ')?.parameters[2], 'MODEL_UNAVAILABLE')

  // Provider prose can never reach the column.
  await assert.rejects(
    repository.markRunFailed({
      runId: runRow().id,
      finishedAt: '2026-08-02 00:41:00',
      errorCode: 'Request failed: the caller said hello',
    }),
    (error: unknown) =>
      error instanceof CallAuditControlError && error.field === 'errorCode',
  )
})

test('pending -> cancelled is allowed and preserves stored counters', async () => {
  const db = fakePool({
    rows: [
      {
        match: RUN_BY_ID_MATCH,
        rows: [runRow({ total_candidates: 7, processed_count: 3 })],
      },
    ],
  })
  const result = await createMysqlCallAuditControlRepository(
    db.pool,
  ).markRunCancelled({
    runId: runRow().id,
    finishedAt: '2026-08-02 00:42:00',
  })

  assert.equal(result.status, 'cancelled')
  const update = db.find('UPDATE `kaudit_call_audit_run`')
  assert.ok(update)
  // No counters supplied, so the stored progress is rewritten as itself rather
  // than silently zeroed.
  assert.deepEqual(update.parameters.slice(0, 5), [
    'cancelled',
    '2026-08-02 00:42:00.000000',
    null,
    7,
    3,
  ])
})

test('a terminal run cannot be moved to any other state', async () => {
  for (const terminal of ['completed', 'failed', 'cancelled'] as const) {
    const db = fakePool({
      rows: [
        {
          match: RUN_BY_ID_MATCH,
          rows: [
            runRow({
              status: terminal,
              finished_at: '2026-08-02 00:40:00.000000',
              error_code: terminal === 'completed' ? null : 'MODEL_UNAVAILABLE',
            }),
          ],
        },
      ],
    })
    const repository = createMysqlCallAuditControlRepository(db.pool)
    const id = runRow().id

    await assert.rejects(
      repository.markRunRunning({ runId: id, startedAt: '2026-08-03 00:00:00' }),
      (error: unknown) =>
        error instanceof CallAuditControlTransitionError &&
        error.fromStatus === terminal &&
        error.toStatus === 'running',
    )
    await assert.rejects(
      repository.updateRunCounters(id, COUNTERS),
      CallAuditControlTransitionError,
    )
    for (const other of ['completed', 'failed', 'cancelled'] as const) {
      if (other === terminal) continue
      const attempt =
        other === 'completed'
          ? repository.markRunCompleted({
              runId: id,
              finishedAt: '2026-08-03 00:00:00',
              counters: COUNTERS,
            })
          : other === 'failed'
            ? repository.markRunFailed({
                runId: id,
                finishedAt: '2026-08-03 00:00:00',
                errorCode: 'MODEL_UNAVAILABLE',
              })
            : repository.markRunCancelled({
                runId: id,
                finishedAt: '2026-08-03 00:00:00',
              })
      await assert.rejects(attempt, CallAuditControlTransitionError)
    }
    assert.equal(db.all('UPDATE ').length, 0, `${terminal} was mutated`)
  }
})

test('finishing an already-finished run replays, and a changed outcome conflicts', async () => {
  const db = fakePool({
    rows: [
      {
        match: RUN_BY_ID_MATCH,
        rows: [
          runRow({
            status: 'completed',
            finished_at: '2026-08-02 00:40:00.000000',
            total_candidates: 120,
            processed_count: 120,
            succeeded_count: 110,
            failed_count: 4,
            skipped_count: 6,
            content_auditable_count: 100,
            operational_only_count: 20,
          }),
        ],
      },
    ],
  })
  const repository = createMysqlCallAuditControlRepository(db.pool)
  const id = runRow().id

  const replay = await repository.markRunCompleted({
    runId: id,
    finishedAt: '2026-08-02 00:40:00',
    counters: COUNTERS,
  })
  assert.equal(replay.outcome, 'replayed')
  assert.deepEqual(db.transaction, ['begin', 'rollback'])

  await assert.rejects(
    repository.markRunCompleted({
      runId: id,
      finishedAt: '2026-08-02 00:55:00',
      counters: COUNTERS,
    }),
    (error: unknown) =>
      error instanceof CallAuditControlConflictError &&
      error.field === 'finished_at',
  )
  await assert.rejects(
    repository.markRunCompleted({
      runId: id,
      finishedAt: '2026-08-02 00:40:00',
      counters: { ...COUNTERS, succeededCount: 111 },
    }),
    (error: unknown) =>
      error instanceof CallAuditControlConflictError &&
      error.field === 'succeeded_count',
  )
  assert.equal(db.all('UPDATE ').length, 0)
})

test('a lifecycle transition on a missing run is refused', async () => {
  const db = fakePool()
  await assert.rejects(
    createMysqlCallAuditControlRepository(db.pool).markRunRunning({
      runId: 'crn_000000000000000000000000000000000z',
      startedAt: '2026-08-02 00:06:00',
    }),
    (error: unknown) =>
      error instanceof CallAuditControlError && error.field === 'runId',
  )
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  assert.equal(db.released, 1)
})

test('a failing transition rolls back and releases its connection', async () => {
  const db = fakePool({
    rows: [{ match: RUN_BY_ID_MATCH, rows: [runRow()] }],
    failOn: {
      match: 'UPDATE `kaudit_call_audit_run`',
      error: new Error('deadlock'),
    },
  })
  await assert.rejects(
    createMysqlCallAuditControlRepository(db.pool).markRunRunning({
      runId: runRow().id,
      startedAt: '2026-08-02 00:06:00',
    }),
    /deadlock/,
  )
  assert.deepEqual(db.transaction, ['begin', 'rollback'])
  assert.equal(db.released, 1)
})

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

test('no bound parameter carries anything but safe control values', async () => {
  const db = fakePool()
  const repository = createMysqlCallAuditControlRepository(db.pool)
  await repository.saveRuleVersionSnapshot(activation(), DRAFT_LIFECYCLE)
  await repository.createRun(runRequest())

  for (const call of db.calls) {
    for (const parameter of call.parameters) {
      if (typeof parameter !== 'string') continue
      // The administrator prompt and its canonical config document are the only
      // long strings, and neither may contain contact details or a link.
      assert.equal(/@[a-z0-9.-]+\.[a-z]{2,}/i.test(parameter), false)
      assert.equal(/https?:\/\//i.test(parameter), false)
      assert.equal(/\b\d{10,}\b/.test(parameter), false)
    }
  }
})
