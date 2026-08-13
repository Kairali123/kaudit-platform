import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  createMysqlCallAuditSourceReader,
  SOURCE_CANDIDATE_SQL,
  SOURCE_CANDIDATE_SQL_AFTER_CURSOR,
  SOURCE_CHANGED_CANDIDATE_SQL,
} from './mysqlCallAuditSource.ts'
import { CallAuditSourceQueryError } from '../callaudit/sourceQuery.ts'
import {
  CallAuditSourceRowError,
  SOURCE_CATEGORICAL_FIELDS,
} from '../callaudit/sourceTypes.ts'

const BOTH_QUERIES = [
  ['first page', SOURCE_CANDIDATE_SQL],
  ['after cursor', SOURCE_CANDIDATE_SQL_AFTER_CURSOR],
] as const

const ALL_QUERIES = [
  ...BOTH_QUERIES,
  ['changed rows', SOURCE_CHANGED_CANDIDATE_SQL] as const,
]

/** Captures SQL and parameters; no database is ever contacted. */
function recordingPool(rows: unknown[] = []) {
  const calls: Array<{ sql: string; parameters: unknown[] }> = []
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      return [rows]
    },
  } as unknown as Pool
  return { pool, calls }
}

/** Synthetic row shaped like the source table; no real customer data. */
function syntheticRow(overrides: Record<string, unknown> = {}) {
  return {
    source_row_id: '4021',
    lead_id: 'LEAD-2026-000123',
    transcription: 'Saanvi: hello?',
    source_updated_at: '2026-08-01 09:20:00',
    call_started_at: '2026-08-01 09:15:00',
    call_ended_at: '2026-08-01 09:16:24',
    call_duration_sec: '00:01:24',
    effective_call_time: '2026-08-01 09:15:00',
    company_by_kserve: 'Kairali',
    company: 'Kairali Ayurvedic Group',
    data_source: 'website_form',
    verified_source: 'verified_web',
    service_category: 'panchakarma',
    call_type: 'outbound',
    call_status: 'connected',
    call_end_reason: 'customer_hangup',
    final_call_status: 'completed',
    ai_call_category: 'information_request',
    customer_engagement_level: 'engaged',
    interest_level: 'high',
    call_outcome: 'callback_requested',
    lead_status: 'qualified',
    final_lead_outcome: 'followup_scheduled',
    calculated_qualification_status: 'qualified',
    followup_required: 'yes',
    ...overrides,
  }
}

const QUERY = {
  periodStart: '2026-08-01 00:00:00',
  periodEndExclusive: '2026-09-01 00:00:00',
  batchSize: 250,
}

// ---------------------------------------------------------------------------
// Read-only guarantees
// ---------------------------------------------------------------------------

test('the source queries are SELECT only', () => {
  for (const [label, sql] of ALL_QUERIES) {
    assert.match(sql.trimStart(), /^SELECT\s/, `${label} must start with SELECT`)
    for (const forbidden of [
      /\bINSERT\b/i,
      /\bUPDATE\b/i,
      /\bDELETE\b/i,
      /\bREPLACE\b/i,
      /\bALTER\b/i,
      /\bCREATE\b/i,
      /\bDROP\b/i,
      /\bTRUNCATE\b/i,
      /\bRENAME\b/i,
      /\bGRANT\b/i,
      /\bLOCK\b/i,
      /\bUNLOCK\b/i,
      /\bFOR\s+UPDATE\b/i,
      /\bLOCK\s+IN\s+SHARE\s+MODE\b/i,
      /\bINTO\s+OUTFILE\b/i,
    ]) {
      assert.equal(
        forbidden.test(sql),
        false,
        `${label} contains a forbidden statement ${forbidden}`,
      )
    }
  }
})

test('the adapter module issues no write statement anywhere', async () => {
  const source = await import('node:fs')
  const text = source.readFileSync(
    new URL('./mysqlCallAuditSource.ts', import.meta.url),
    'utf8',
  )
  const executable = text
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('*'))
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n')
  for (const forbidden of [
    /\bINSERT\s+INTO\b/i,
    /\bUPDATE\s+`/i,
    /\bDELETE\s+FROM\b/i,
    /\bDROP\s+TABLE\b/i,
    /\bpool\.query\b/,
  ]) {
    assert.equal(
      forbidden.test(executable),
      false,
      `adapter contains ${forbidden}`,
    )
  }
  assert.match(executable, /pool\.execute</)
})

test('never uses SELECT star', () => {
  for (const [label, sql] of BOTH_QUERIES) {
    assert.equal(/SELECT\s+\*/i.test(sql), false, `${label} uses SELECT *`)
    assert.equal(/src\.\*/.test(sql), false, `${label} uses src.*`)
  }
})

test('reads only the external source table', () => {
  for (const [, sql] of ALL_QUERIES) {
    const tables = [...sql.matchAll(/\bFROM\s+`?(\w+)`?/gi)].map((m) => m[1])
    assert.deepEqual(tables, ['ai_voice_leads_received'])
    assert.equal(/\bJOIN\b/i.test(sql), false)
  }
})

test('changed-row polling is keyset ordered, bounded, and parameterized', async () => {
  const { pool, calls } = recordingPool([
    syntheticRow({ source_change_time: '2026-08-01 09:20:00' }),
  ])
  const reader = createMysqlCallAuditSourceReader(pool)
  const rows = await reader.listChangedCandidates({
    changedAfter: {
      changedAt: '2026-08-01 09:19:00',
      sourceRowId: '0',
    },
    changedBeforeExclusive: '2026-08-01 09:21:00',
    batchSize: 25,
  })

  assert.equal(calls[0].sql, SOURCE_CHANGED_CANDIDATE_SQL)
  assert.deepEqual(calls[0].parameters, [
    '2026-08-01 09:19:00.000000',
    '2026-08-01 09:19:00.000000',
    '0',
    '2026-08-01 09:21:00.000000',
    25,
  ])
  assert.match(
    SOURCE_CHANGED_CANDIDATE_SQL,
    /ORDER BY source_change_time ASC, src\.`id` ASC/,
  )
  assert.doesNotMatch(SOURCE_CHANGED_CANDIDATE_SQL, /\bOFFSET\b/i)
  assert.deepEqual(rows[0].cursor, {
    changedAt: '2026-08-01 09:20:00.000000',
    sourceRowId: '4021',
  })
})

// ---------------------------------------------------------------------------
// Column allow-list and privacy
// ---------------------------------------------------------------------------

test('selects exactly the approved columns', () => {
  for (const [label, sql] of BOTH_QUERIES) {
    assert.match(
      sql,
      /CAST\(src\.`id` AS CHAR\) AS source_row_id/,
      `${label} must cast the BIGINT id to CHAR`,
    )
    for (const column of [
      'lead_id',
      'transcription',
      'updated_at',
      'call_start_time',
      'call_end_time',
      'call_duration_sec',
      'date_time',
      'timestamp',
      ...SOURCE_CATEGORICAL_FIELDS,
    ]) {
      assert.match(
        sql,
        new RegExp('src\\.`' + column + '`'),
        `${label} does not select ${column}`,
      )
    }
  }
})

test('never selects PII, URLs, or source free text', () => {
  for (const [label, sql] of ALL_QUERIES) {
    for (const column of [
      'client_name',
      'customer_name',
      'mobile',
      'mobile_number',
      'phone',
      'email',
      'transcription_view_url',
      'ivr_url',
      'recording_url',
      'subject',
      'notes',
      'ai_call_summary',
      'customer_context',
      'customer_intent',
      'next_action_required',
      'additional_notes',
      'response',
      'remarks',
      'feedback_data',
      'address',
      'comments',
    ]) {
      assert.equal(
        new RegExp('`' + column + '`').test(sql),
        false,
        `${label} must not select ${column}`,
      )
    }
  }
})

test('transcription is the only content column selected', () => {
  const selectList = SOURCE_CANDIDATE_SQL.slice(
    0,
    SOURCE_CANDIDATE_SQL.indexOf('FROM'),
  )
  const contentish = [...selectList.matchAll(/src\.`(\w+)`/g)]
    .map((match) => match[1])
    .filter((column) => /summary|intent|context|note|text|body|url/i.test(column))
  assert.deepEqual(contentish, [])
  assert.match(selectList, /src\.`transcription` AS transcription/)
})

// ---------------------------------------------------------------------------
// Period, ordering, and pagination
// ---------------------------------------------------------------------------

test('uses a deterministic effective call time', () => {
  for (const [, sql] of BOTH_QUERIES) {
    assert.match(
      sql,
      /COALESCE\(src\.`call_start_time`, src\.`date_time`, src\.`timestamp`\) AS effective_call_time/,
    )
  }
})

test('the period predicate is half open and parameterized', () => {
  for (const [label, sql] of BOTH_QUERIES) {
    assert.match(
      sql,
      /COALESCE\(src\.`call_start_time`, src\.`date_time`, src\.`timestamp`\) >= \?/,
      `${label} lacks an inclusive start`,
    )
    assert.match(
      sql,
      /COALESCE\(src\.`call_start_time`, src\.`date_time`, src\.`timestamp`\) < \?/,
      `${label} lacks an exclusive end`,
    )
    assert.equal(/<=\s*\?/.test(sql), false, `${label} end must be exclusive`)
  }
})

test('requires a non-null transcript with a non-whitespace character', () => {
  for (const [label, sql] of ALL_QUERIES) {
    assert.match(
      sql,
      /src\.`transcription` IS NOT NULL/,
      `${label} accepts a null transcript`,
    )
    assert.match(
      sql,
      /src\.`transcription` REGEXP '\[\^\[:space:\]\]'/,
      `${label} accepts an empty or whitespace-only transcript`,
    )
  }
})

test('orders deterministically by effective call time then id', () => {
  for (const [label, sql] of BOTH_QUERIES) {
    assert.match(
      sql,
      /ORDER BY effective_call_time ASC, src\.`id` ASC/,
      `${label} is not deterministically ordered`,
    )
  }
})

test('orders and compares on the BIGINT column, never the CHAR alias', () => {
  // Ordering the cast alias would sort lexically, placing id 10 before id 9
  // and making keyset pagination skip rows.
  for (const [label, sql] of BOTH_QUERIES) {
    assert.equal(
      /ORDER BY[^\n]*source_row_id/.test(sql),
      false,
      `${label} must not order by the CHAR alias`,
    )
  }
  assert.match(SOURCE_CANDIDATE_SQL_AFTER_CURSOR, /src\.`id` > \?/)
  assert.equal(
    /CAST\([^)]*\)\s*>\s*\?/.test(SOURCE_CANDIDATE_SQL_AFTER_CURSOR),
    false,
    'the cursor must compare the BIGINT column, not a cast',
  )
})

test('paginates by keyset, never by OFFSET', () => {
  for (const [label, sql] of BOTH_QUERIES) {
    assert.equal(/\bOFFSET\b/i.test(sql), false, `${label} uses OFFSET`)
    assert.equal(/LIMIT\s+\?\s*,/.test(sql), false, `${label} uses LIMIT a,b`)
    assert.match(sql, /LIMIT \?/, `${label} must bound its batch`)
  }
  assert.match(
    SOURCE_CANDIDATE_SQL_AFTER_CURSOR,
    /> \?\s*\n\s*OR \(COALESCE\(src\.`call_start_time`, src\.`date_time`, src\.`timestamp`\) = \? AND src\.`id` > \?\)/,
  )
})

test('every caller value is a placeholder, never concatenated', async () => {
  const { pool, calls } = recordingPool()
  const reader = createMysqlCallAuditSourceReader(pool)
  await reader.listCandidates(QUERY)

  const [first] = calls
  assert.equal(first.sql, SOURCE_CANDIDATE_SQL)
  assert.deepEqual(first.parameters, [
    '2026-08-01 00:00:00.000000',
    '2026-09-01 00:00:00.000000',
    250,
  ])
  assert.equal(first.sql.includes('2026'), false)
  assert.equal(first.sql.includes('250'), false)
  assert.equal((first.sql.match(/\?/g) ?? []).length, first.parameters.length)
})

test('the cursor page binds the cursor as placeholders', async () => {
  const { pool, calls } = recordingPool()
  const reader = createMysqlCallAuditSourceReader(pool)
  await reader.listCandidates({
    ...QUERY,
    cursor: {
      effectiveCallTime: '2026-08-15 10:00:00',
      sourceRowId: '9007199254740993',
    },
  })

  const [first] = calls
  assert.equal(first.sql, SOURCE_CANDIDATE_SQL_AFTER_CURSOR)
  assert.deepEqual(first.parameters, [
    '2026-08-01 00:00:00.000000',
    '2026-09-01 00:00:00.000000',
    '2026-08-15 10:00:00.000000',
    '2026-08-15 10:00:00.000000',
    // Bound as a decimal string so MySQL compares at full BIGINT precision.
    '9007199254740993',
    250,
  ])
  assert.equal((first.sql.match(/\?/g) ?? []).length, first.parameters.length)
})

test('the SQL text is constant across calls', async () => {
  const { pool, calls } = recordingPool()
  const reader = createMysqlCallAuditSourceReader(pool)
  await reader.listCandidates(QUERY)
  await reader.listCandidates({ ...QUERY, batchSize: 1 })
  assert.equal(calls[0].sql, calls[1].sql)
})

// ---------------------------------------------------------------------------
// Validation happens before any query
// ---------------------------------------------------------------------------

test('rejects an invalid query without touching the database', async () => {
  const { pool, calls } = recordingPool()
  const reader = createMysqlCallAuditSourceReader(pool)

  for (const bad of [
    { ...QUERY, batchSize: 0 },
    { ...QUERY, batchSize: 5000 },
    { ...QUERY, periodStart: '2026-08-01T00:00:00Z' },
    { ...QUERY, periodEndExclusive: QUERY.periodStart },
    {
      ...QUERY,
      cursor: { effectiveCallTime: 'nope', sourceRowId: '1' },
    },
    {
      ...QUERY,
      cursor: { effectiveCallTime: '2026-02-30 00:00:00', sourceRowId: '1' },
    },
    {
      // Outside the half-open period.
      ...QUERY,
      cursor: { effectiveCallTime: '2026-09-02 00:00:00', sourceRowId: '1' },
    },
    {
      ...QUERY,
      cursor: {
        effectiveCallTime: '2026-08-15 10:00:00',
        sourceRowId: '9223372036854775808',
      },
    },
  ]) {
    await assert.rejects(
      () => reader.listCandidates(bad),
      CallAuditSourceQueryError,
    )
  }
  assert.equal(calls.length, 0, 'no query may run for an invalid request')
})

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

test('maps rows explicitly into server-internal candidates', async () => {
  const { pool } = recordingPool([syntheticRow()])
  const reader = createMysqlCallAuditSourceReader(pool)
  const [candidate] = await reader.listCandidates(QUERY)

  assert.equal(candidate.sourceTable, 'ai_voice_leads_received')
  assert.equal(candidate.sourceRowId, '4021')
  assert.equal(candidate.leadId, 'LEAD-2026-000123')
  assert.equal(candidate.transcript, 'Saanvi: hello?')
  assert.equal(candidate.effectiveCallTime, '2026-08-01 09:15:00.000000')
  assert.equal(candidate.callStartedAt, '2026-08-01 09:15:00.000000')
  assert.equal(candidate.callEndedAt, '2026-08-01 09:16:24.000000')
  assert.equal(candidate.sourceUpdatedAt, '2026-08-01 09:20:00.000000')
  assert.equal(candidate.callDurationSec, '00:01:24')
  assert.equal(candidate.company, 'Kairali Ayurvedic Group')
  assert.equal(candidate.followup_required, 'yes')
})

test('defensively omits null, empty, and whitespace-only transcripts', async () => {
  for (const transcription of [null, '', ' ', '\t', '\n', ' \t\n ']) {
    const { pool } = recordingPool([syntheticRow({ transcription })])
    const reader = createMysqlCallAuditSourceReader(pool)
    assert.deepEqual(await reader.listCandidates(QUERY), [])
  }
})

test('a later transcript-bearing source revision remains eligible', async () => {
  const calls: Array<{ sql: string; parameters: unknown[] }> = []
  const pages = [
    [
      syntheticRow({
        transcription: '   ',
        source_change_time: '2026-08-01 09:20:00',
      }),
    ],
    [
      syntheticRow({
        transcription: 'Synthetic speaker: follow-up received.',
        source_change_time: '2026-08-01 09:22:00',
      }),
    ],
  ]
  const pool = {
    async execute(sql: string, parameters: unknown[]) {
      calls.push({ sql, parameters })
      return [pages.shift() ?? []]
    },
  } as unknown as Pool
  const reader = createMysqlCallAuditSourceReader(pool)

  const first = await reader.listChangedCandidates({
    changedAfter: { changedAt: '2026-08-01 09:19:00', sourceRowId: '0' },
    changedBeforeExclusive: '2026-08-01 09:21:00',
    batchSize: 25,
  })
  const second = await reader.listChangedCandidates({
    changedAfter: { changedAt: '2026-08-01 09:21:00', sourceRowId: '0' },
    changedBeforeExclusive: '2026-08-01 09:23:00',
    batchSize: 25,
  })

  assert.deepEqual(first, [])
  assert.equal(second.length, 1)
  assert.equal(second[0].candidate.sourceRowId, '4021')
  assert.equal(
    second[0].candidate.transcript,
    'Synthetic speaker: follow-up received.',
  )
  assert.deepEqual(second[0].cursor, {
    changedAt: '2026-08-01 09:22:00.000000',
    sourceRowId: '4021',
  })
  assert.equal(calls[1].parameters[0], '2026-08-01 09:21:00.000000')
})

test('keeps calls whose call_start_time is null', async () => {
  // The real table has these; they must stay auditable through the
  // deterministic effective call time rather than being dropped.
  const { pool } = recordingPool([
    syntheticRow({
      call_started_at: null,
      effective_call_time: '2026-08-01 09:15:00',
    }),
  ])
  const reader = createMysqlCallAuditSourceReader(pool)
  const [candidate] = await reader.listCandidates(QUERY)
  assert.equal(candidate.callStartedAt, null)
  assert.equal(candidate.effectiveCallTime, '2026-08-01 09:15:00.000000')
})

test('preserves a BIGINT source row id beyond Number precision', async () => {
  const { pool } = recordingPool([
    syntheticRow({ source_row_id: '9007199254740993' }),
  ])
  const reader = createMysqlCallAuditSourceReader(pool)
  const [candidate] = await reader.listCandidates(QUERY)
  assert.equal(candidate.sourceRowId, '9007199254740993')
  assert.notEqual(candidate.sourceRowId, '9007199254740992')
  assert.equal(typeof candidate.sourceRowId, 'string')
})

test('rejects a row with no valid effective call time', async () => {
  for (const effective_call_time of [null, '', 'not-a-date']) {
    const { pool } = recordingPool([syntheticRow({ effective_call_time })])
    const reader = createMysqlCallAuditSourceReader(pool)
    await assert.rejects(
      () => reader.listCandidates(QUERY),
      CallAuditSourceRowError,
      `${String(effective_call_time)} must be rejected`,
    )
  }
})

test('carries no field the query did not select', async () => {
  const { pool } = recordingPool([syntheticRow()])
  const reader = createMysqlCallAuditSourceReader(pool)
  const [candidate] = await reader.listCandidates(QUERY)
  for (const forbidden of [
    'client_name',
    'mobile',
    'email',
    'transcription_view_url',
    'ivr_url',
    'notes',
    'ai_call_summary',
  ]) {
    assert.equal(
      forbidden in candidate,
      false,
      `candidate must not carry ${forbidden}`,
    )
  }
})

test('a Date from mysql2 round-trips without a timezone shift', async () => {
  const { pool } = recordingPool([
    syntheticRow({
      // mysql2 builds this in the process timezone; formatting it back with
      // local getters must return the same wall-clock value.
      effective_call_time: new Date(2026, 7, 1, 9, 15, 0, 0),
    }),
  ])
  const reader = createMysqlCallAuditSourceReader(pool)
  const [candidate] = await reader.listCandidates(QUERY)
  assert.equal(candidate.effectiveCallTime, '2026-08-01 09:15:00.000000')
})

test('refuses a source row id that cannot be trusted', async () => {
  for (const source_row_id of [
    '0',
    '-1',
    '007',
    '',
    'abc',
    '9223372036854775808',
    0,
    1.5,
    9007199254740993,
  ]) {
    const { pool } = recordingPool([syntheticRow({ source_row_id })])
    const reader = createMysqlCallAuditSourceReader(pool)
    await assert.rejects(
      () => reader.listCandidates(QUERY),
      CallAuditSourceRowError,
      `${String(source_row_id)} must be rejected`,
    )
  }
})
