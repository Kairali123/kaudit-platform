import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Pool } from 'mysql2/promise'
import {
  categoryCallsSql,
  categoryTotalsRowsSql,
  categoryTotalsSql,
  createMysqlBillingCategoryAnalysisRepository,
  durationGapMs,
  toCategoryCallRow,
  toCategoryTotalsRow,
} from './mysqlBillingCategoryAnalysis.ts'

/**
 * Category-analysis read model.
 *
 * Two layers are covered without contacting any real database:
 *
 *   1. the statements themselves, executed by the in-process SQLite engine over
 *      synthetic tables, so the per-category aggregation, the duration
 *      semantics, supersession, and the one-row-per-call joins are proven
 *      rather than asserted as text; and
 *   2. the row mapping, through a recording fake pool.
 *
 * Every fixture here is SYNTHETIC. No real call, task id, transcript, amount,
 * invoice, recording, or secret appears in this file, and no external source
 * table is created, read, written, or locked.
 */

// ---------------------------------------------------------------------------
// Synthetic database
// ---------------------------------------------------------------------------

/**
 * One recording artifact and the evidence attached to IT. Used by the fixtures
 * that have to say which artifact a transcript or an analysis belongs to; the
 * simple fields below build a single-artifact call for everything else.
 */
interface SyntheticArtifact {
  id: string
  isFinal?: boolean
  sourceUrl?: string | null
  /** Completed, classified media analyses on this artifact. */
  analyses?: {
    id: string
    decodedDurationMs?: number | null
    conversationEndMs?: number | null
    createdAt: string
  }[]
  /** Completed transcripts on this artifact. */
  transcripts?: { id: string; createdAt: string }[]
}

/** One task reference row, with the internal id the platform ranks on. */
interface SyntheticTaskReference {
  id: number
  externalId: string
}

interface SyntheticCall {
  id: string
  category: string | null
  billingPeriodDate: string
  startedAt?: string | null
  endedAt?: string | null
  /** Vendor-asserted final billed minutes, or null for none recorded. */
  billedMinutes?: string | null
  /** Latest completed media analysis, or null when the call is unaudited. */
  decodedDurationMs?: number | null
  conversationEndMs?: number | null
  transcriptCompleted?: boolean
  recordingUrl?: string | null
  taskReference?: string | null
  /** Several task references, in insertion order, with explicit ids. */
  taskReferences?: SyntheticTaskReference[]
  /**
   * Explicit artifacts. When present these REPLACE the single default
   * artifact, so a fixture can attach evidence to a chosen artifact.
   */
  artifacts?: SyntheticArtifact[]
}

interface SyntheticCalculation {
  id: string
  callId: string
  status: string
  totalAmount: string
  calculatedAt: string
  supersedesCalculationId?: string | null
}

const SCHEMA = `
  CREATE TABLE kaudit_call (
    id TEXT PRIMARY KEY,
    logical_call_key TEXT NOT NULL,
    canonical_outcome_code TEXT,
    billing_period_date TEXT,
    source_started_at TEXT,
    source_ended_at TEXT
  );
  CREATE TABLE kaudit_call_artifact (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    is_final INTEGER NOT NULL DEFAULT 1,
    source_url TEXT
  );
  CREATE TABLE kaudit_media_analysis (
    id TEXT PRIMARY KEY,
    call_artifact_id TEXT NOT NULL,
    status TEXT NOT NULL,
    classification_status TEXT NOT NULL,
    decoded_duration_ms INTEGER,
    conversation_end_ms INTEGER,
    created_at TEXT
  );
  CREATE TABLE kaudit_transcript (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    call_artifact_id TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at TEXT
  );
  CREATE TABLE kaudit_provider_cost (
    call_id TEXT NOT NULL,
    provider_sku TEXT NOT NULL,
    minutes_decimal TEXT,
    is_final INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE kaudit_billing_calculation (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    status TEXT NOT NULL,
    total_amount TEXT,
    calculated_at TEXT,
    supersedes_calculation_id TEXT
  );
  CREATE TABLE kaudit_call_external_reference (
    id INTEGER PRIMARY KEY,
    call_id TEXT NOT NULL,
    reference_type TEXT NOT NULL,
    external_id TEXT NOT NULL
  );
`

/**
 * The artifacts a call carries. A fixture that states them explicitly gets
 * exactly those; every other fixture gets the default shape — one final
 * recording artifact holding an older and a newer completed analysis and two
 * completed transcripts, all on that SAME artifact, so the ranking and the
 * one-row-per-call joins are exercised by every test that does not care.
 */
function artifactsOf(call: SyntheticCall): SyntheticArtifact[] {
  if (call.artifacts) return call.artifacts
  return [
    {
      id: `artifact-${call.id}`,
      sourceUrl: call.recordingUrl ?? null,
      analyses:
        call.conversationEndMs === undefined
          ? []
          : [
              // The older analysis is inserted first so the ranking has to
              // prefer the newer one rather than whichever row the engine
              // happens to reach.
              {
                id: `media-old-${call.id}`,
                decodedDurationMs: 999_000,
                conversationEndMs: 999_000,
                createdAt: '2026-08-01 00:00:00',
              },
              {
                id: `media-${call.id}`,
                decodedDurationMs: call.decodedDurationMs ?? null,
                conversationEndMs: call.conversationEndMs,
                createdAt: '2026-08-02 00:00:00',
              },
            ],
      transcripts:
        call.transcriptCompleted === false
          ? []
          : // Two completed transcripts: the relation must still yield one row
            // per call, or every aggregate would double-count.
            ['a', 'b'].map((suffix) => ({
              id: `transcript-${suffix}-${call.id}`,
              createdAt: '2026-08-02 00:00:00',
            })),
    },
  ]
}

/** The task-reference rows a call carries, in insertion order. */
function taskReferencesOf(
  call: SyntheticCall,
  nextId: () => number,
): SyntheticTaskReference[] {
  if (call.taskReferences) return call.taskReferences
  return call.taskReference
    ? [{ id: nextId(), externalId: call.taskReference }]
    : []
}

function synthetic(fixture: {
  calls: SyntheticCall[]
  calculations?: SyntheticCalculation[]
}): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  let referenceId = 0
  const nextReferenceId = () => (referenceId += 1)
  for (const call of fixture.calls) {
    db.prepare(
      `INSERT INTO kaudit_call
         (id, logical_call_key, canonical_outcome_code,
          billing_period_date, source_started_at, source_ended_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      call.id,
      `synthetic-key:${call.id}`,
      call.category,
      call.billingPeriodDate,
      call.startedAt ?? null,
      call.endedAt ?? null,
    )
    for (const artifact of artifactsOf(call)) {
      db.prepare(
        `INSERT INTO kaudit_call_artifact
           (id, call_id, artifact_type, is_final, source_url)
         VALUES (?, ?, 'recording', ?, ?)`,
      ).run(
        artifact.id,
        call.id,
        artifact.isFinal === false ? 0 : 1,
        artifact.sourceUrl ?? null,
      )
      for (const analysis of artifact.analyses ?? []) {
        db.prepare(
          `INSERT INTO kaudit_media_analysis
             (id, call_artifact_id, status, classification_status,
              decoded_duration_ms, conversation_end_ms, created_at)
           VALUES (?, ?, 'completed', 'completed', ?, ?, ?)`,
        ).run(
          analysis.id,
          artifact.id,
          analysis.decodedDurationMs ?? null,
          analysis.conversationEndMs ?? null,
          analysis.createdAt,
        )
      }
      for (const transcript of artifact.transcripts ?? []) {
        db.prepare(
          `INSERT INTO kaudit_transcript
             (id, call_id, call_artifact_id, status, created_at)
           VALUES (?, ?, ?, 'completed', ?)`,
        ).run(transcript.id, call.id, artifact.id, transcript.createdAt)
      }
    }
    if (call.billedMinutes != null) {
      db.prepare(
        `INSERT INTO kaudit_provider_cost
           (call_id, provider_sku, minutes_decimal, is_final)
         VALUES (?, 'vendor_asserted_billed_minutes', ?, 1)`,
      ).run(call.id, call.billedMinutes)
    }
    for (const reference of taskReferencesOf(call, nextReferenceId)) {
      db.prepare(
        `INSERT INTO kaudit_call_external_reference
           (id, call_id, reference_type, external_id)
         VALUES (?, ?, 'task_id', ?)`,
      ).run(reference.id, call.id, reference.externalId)
    }
  }
  for (const calculation of fixture.calculations ?? []) {
    db.prepare(
      `INSERT INTO kaudit_billing_calculation
         (id, call_id, status, total_amount, calculated_at,
          supersedes_calculation_id)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      calculation.id,
      calculation.callId,
      calculation.status,
      calculation.totalAmount,
      calculation.calculatedAt,
      calculation.supersedesCalculationId ?? null,
    )
  }
  return db
}

const PERIOD_FILTERS = [
  'c.canonical_outcome_code IS NOT NULL',
  'c.billing_period_date BETWEEN ? AND ?',
]
const PERIOD_PARAMS = ['2026-08-01', '2026-08-31']

function totalsOf(fixture: Parameters<typeof synthetic>[0]) {
  const db = synthetic(fixture)
  try {
    return db
      .prepare(categoryTotalsSql(categoryTotalsRowsSql(PERIOD_FILTERS)))
      .all(...PERIOD_PARAMS)
      .map((row) =>
        toCategoryTotalsRow(row as Parameters<typeof toCategoryTotalsRow>[0]),
      )
  } finally {
    db.close()
  }
}

function callsOf(
  fixture: Parameters<typeof synthetic>[0],
  options: { category?: string; limit?: number; offset?: number } = {},
) {
  const db = synthetic(fixture)
  try {
    const filters = [...PERIOD_FILTERS]
    const params: unknown[] = [...PERIOD_PARAMS]
    if (options.category) {
      filters.push('c.canonical_outcome_code = ?')
      params.push(options.category)
    }
    return db
      .prepare(categoryCallsSql(filters))
      .all(
        ...(params as string[]),
        options.limit ?? 25,
        options.offset ?? 0,
      )
      .map((row) =>
        toCategoryCallRow(row as Parameters<typeof toCategoryCallRow>[0]),
      )
  } finally {
    db.close()
  }
}

/** Two audited minutes billed, two audited minutes measured, no gap. */
const AUDITED_CALL: SyntheticCall = {
  id: 'call-synthetic-1',
  category: 'PRODUCT_ENQUIRY',
  billingPeriodDate: '2026-08-01',
  startedAt: '2026-08-04 09:15:00',
  endedAt: '2026-08-04 09:18:10',
  billedMinutes: '3.00000000',
  decodedDurationMs: 190_000,
  conversationEndMs: 61_000,
  recordingUrl: 'https://synthetic.invalid/recording',
  taskReference: 'SYNTHETIC-TASK-1',
}

// ---------------------------------------------------------------------------
// Per-category aggregation
// ---------------------------------------------------------------------------

test('each category reports its own audited count and both charges', () => {
  const totals = totalsOf({
    calls: [
      AUDITED_CALL,
      {
        ...AUDITED_CALL,
        id: 'call-synthetic-2',
        taskReference: 'SYNTHETIC-TASK-2',
      },
      {
        ...AUDITED_CALL,
        id: 'call-synthetic-3',
        category: 'NOT_CONNECTED',
        billedMinutes: '1.00000000',
        taskReference: 'SYNTHETIC-TASK-3',
      },
    ],
    calculations: [
      {
        id: 'calc-1',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '28.50000000',
        calculatedAt: '2026-08-05 00:00:00',
      },
    ],
  })

  assert.deepEqual(
    totals.map((row) => row.category),
    ['NOT_CONNECTED', 'PRODUCT_ENQUIRY'],
  )
  const enquiry = totals[1]
  assert.equal(enquiry.auditedCallCount, 2)
  assert.equal(enquiry.kservePricedCalls, 2)
  assert.equal(Number(enquiry.kserveChargeInr), 57)
  // Only the call with a current final calculation releases auditor money.
  assert.equal(enquiry.auditorFinalPricedCalls, 1)
  assert.equal(enquiry.auditorUnfinalizedCalls, 1)
  assert.equal(Number(enquiry.auditorFinalChargeInr), 28.5)
  const notConnected = totals[0]
  assert.equal(notConnected.auditedCallCount, 1)
  assert.equal(Number(notConnected.auditorFinalChargeInr), 0)
  assert.equal(notConnected.auditorUnfinalizedCalls, 1)
})

test('a superseded or draft calculation releases no auditor money', () => {
  const totals = totalsOf({
    calls: [AUDITED_CALL],
    calculations: [
      {
        id: 'calc-superseded',
        callId: 'call-synthetic-1',
        status: 'final',
        totalAmount: '99.00000000',
        calculatedAt: '2026-08-05 00:00:00',
      },
      {
        id: 'calc-draft',
        callId: 'call-synthetic-1',
        status: 'draft',
        totalAmount: '77.00000000',
        calculatedAt: '2026-08-06 00:00:00',
        supersedesCalculationId: 'calc-superseded',
      },
    ],
  })
  assert.equal(totals[0].auditorFinalPricedCalls, 0)
  assert.equal(totals[0].auditorUnfinalizedCalls, 1)
  assert.equal(Number(totals[0].auditorFinalChargeInr), 0)
})

test('billed minutes and the grace-adjusted audited duration define the gap', () => {
  const totals = totalsOf({ calls: [AUDITED_CALL] })
  // 3 billed minutes = 180000 ms; the audit measured 121000 ms after the
  // one-minute wrap-up grace, so the vendor billed 59000 ms more.
  assert.equal(totals[0].kserveChargeTimeMs, 180_000)
  assert.equal(totals[0].aiAuditedDurationMs, 121_000)
  assert.equal(totals[0].gapMs, 59_000)
  assert.equal(totals[0].comparableCalls, 1)
})

test('a duration nobody recorded stays null instead of becoming a zero', () => {
  const totals = totalsOf({
    calls: [
      {
        ...AUDITED_CALL,
        billedMinutes: null,
        conversationEndMs: null,
        decodedDurationMs: 190_000,
      },
    ],
  })
  const row = totals[0]
  assert.equal(row.auditedCallCount, 1)
  assert.equal(row.kserveChargeTimeMs, null)
  assert.equal(row.aiAuditedDurationMs, null)
  assert.equal(row.gapMs, null)
  assert.equal(row.comparableCalls, 0)
  assert.equal(row.kservePricedCalls, 0)
  assert.equal(row.aiAuditedDurationCalls, 0)
})

test('a call is counted once however many transcripts or costs it carries', () => {
  const totals = totalsOf({
    calls: [{ ...AUDITED_CALL }],
  })
  assert.equal(totals[0].auditedCallCount, 1)
  assert.equal(totals[0].kservePricedCalls, 1)
})

test('an unaudited or untranscribed call is outside the analysis', () => {
  const totals = totalsOf({
    calls: [
      { ...AUDITED_CALL, id: 'call-no-media', conversationEndMs: undefined },
      {
        ...AUDITED_CALL,
        id: 'call-no-transcript',
        transcriptCompleted: false,
      },
      { ...AUDITED_CALL, id: 'call-no-category', category: null },
      {
        ...AUDITED_CALL,
        id: 'call-other-month',
        billingPeriodDate: '2026-07-01',
      },
      AUDITED_CALL,
    ],
  })
  assert.equal(totals.length, 1)
  assert.equal(totals[0].auditedCallCount, 1)
})

/**
 * The audited invariant is per ARTIFACT. A call whose media analysis completed
 * on one final recording and whose transcript completed on another has never
 * had one recording audited end to end, so it is not audited at all — and its
 * unmatched analysis must not supply an "audited duration" for a recording no
 * transcript ever covered.
 */
const SPLIT_EVIDENCE_CALL: SyntheticCall = {
  ...AUDITED_CALL,
  id: 'call-split-evidence',
  artifacts: [
    {
      id: 'artifact-split-media',
      sourceUrl: 'https://synthetic.invalid/recording',
      analyses: [
        {
          id: 'media-split-a',
          decodedDurationMs: 190_000,
          conversationEndMs: 61_000,
          createdAt: '2026-08-02 00:00:00',
        },
      ],
      transcripts: [],
    },
    {
      id: 'artifact-split-transcript',
      sourceUrl: 'https://synthetic.invalid/recording',
      analyses: [],
      transcripts: [
        { id: 'transcript-split-b', createdAt: '2026-08-02 00:00:00' },
      ],
    },
  ],
}

test('media on one artifact and a transcript on another is not audited', () => {
  assert.deepEqual(totalsOf({ calls: [SPLIT_EVIDENCE_CALL] }), [])
  assert.deepEqual(callsOf({ calls: [SPLIT_EVIDENCE_CALL] }), [])
})

test('split evidence is excluded while a whole evidence set still counts', () => {
  const totals = totalsOf({ calls: [SPLIT_EVIDENCE_CALL, AUDITED_CALL] })
  assert.equal(totals.length, 1)
  assert.equal(totals[0].auditedCallCount, 1)
  assert.deepEqual(
    callsOf({ calls: [SPLIT_EVIDENCE_CALL, AUDITED_CALL] }).map(
      (row) => row.callReference,
    ),
    ['SYNTHETIC-TASK-1'],
  )
})

test('duplicate transcripts, analyses and final artifacts yield one call', () => {
  const fixture = {
    calls: [
      {
        ...AUDITED_CALL,
        id: 'call-duplicate-evidence',
        artifacts: [
          {
            id: 'artifact-duplicate-a',
            sourceUrl: 'https://synthetic.invalid/recording',
            analyses: [
              {
                id: 'media-duplicate-a1',
                decodedDurationMs: 999_000,
                conversationEndMs: 999_000,
                createdAt: '2026-08-01 00:00:00',
              },
              {
                id: 'media-duplicate-a2',
                decodedDurationMs: 888_000,
                conversationEndMs: 888_000,
                createdAt: '2026-08-02 00:00:00',
              },
            ],
            transcripts: [
              {
                id: 'transcript-duplicate-a1',
                createdAt: '2026-08-02 00:00:00',
              },
              {
                id: 'transcript-duplicate-a2',
                createdAt: '2026-08-03 00:00:00',
              },
            ],
          },
          {
            id: 'artifact-duplicate-b',
            sourceUrl: 'https://synthetic.invalid/recording',
            analyses: [
              {
                id: 'media-duplicate-b1',
                decodedDurationMs: 190_000,
                conversationEndMs: 61_000,
                createdAt: '2026-08-04 00:00:00',
              },
            ],
            transcripts: [
              {
                id: 'transcript-duplicate-b1',
                createdAt: '2026-08-04 00:00:00',
              },
            ],
          },
        ],
      },
    ],
  }
  const totals = totalsOf(fixture)
  assert.equal(totals.length, 1)
  assert.equal(totals[0].auditedCallCount, 1)
  assert.equal(totals[0].kservePricedCalls, 1)
  assert.equal(totals[0].aiAuditedDurationCalls, 1)
  // One complete evidence set is chosen, not a blend: the newest analysis
  // among the artifacts that also carry a completed transcript.
  assert.equal(totals[0].aiAuditedDurationMs, 121_000)
  const rows = callsOf(fixture)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].aiAuditedDurationMs, 121_000)
})

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

test('a row carries the task reference, stored times, and durations only', () => {
  const [row] = callsOf({ calls: [AUDITED_CALL] })
  assert.equal(row.callReference, 'SYNTHETIC-TASK-1')
  // The stored wall clock is returned as stored: no offset is invented, and no
  // local timezone can move the call onto another call date.
  assert.equal(row.callDate, '2026-08-04')
  assert.equal(row.callStartAt, '2026-08-04 09:15:00')
  assert.equal(row.callEndAt, '2026-08-04 09:18:10')
  assert.equal(row.category, 'PRODUCT_ENQUIRY')
  assert.equal(row.kserveChargeTimeMs, 180_000)
  assert.equal(row.aiAuditedDurationMs, 121_000)
  assert.equal(row.gapMs, 59_000)
  assert.equal(row.recordingAvailable, true)
  // Nothing that identifies evidence or an internal record is on the row.
  for (const forbidden of [
    'callId',
    'id',
    'sourceUrl',
    'recordingUrl',
    'evidenceSha256',
    'transcript',
    'auditorAmount',
  ]) {
    assert.equal(forbidden in row, false, `${forbidden} must not be returned`)
  }
})

test('a driver Date is read back as the same wall clock, not re-zoned', () => {
  const row = toCategoryCallRow({
    call_reference: 'SYNTHETIC-TASK-1',
    // Local components, exactly as the driver builds a naive DATETIME.
    call_started_at: new Date(2026, 7, 4, 23, 45, 10),
    call_ended_at: null,
    billing_period_date: '2026-08-01',
    category: 'PRODUCT_ENQUIRY',
    recording_available: 0,
    kserve_charge_time_ms: null,
    ai_audited_duration_ms: null,
  } as Parameters<typeof toCategoryCallRow>[0])
  assert.equal(row.callStartAt, '2026-08-04 23:45:10')
  assert.equal(row.callDate, '2026-08-04')
  assert.equal(row.callEndAt, null)
})

test('a call with no recording still lists, flagged as having none', () => {
  const [row] = callsOf({
    calls: [{ ...AUDITED_CALL, recordingUrl: null }],
  })
  assert.equal(row.recordingAvailable, false)
})

test('the reference falls back to the logical key when no task id is stored', () => {
  const [row] = callsOf({
    calls: [{ ...AUDITED_CALL, taskReference: null }],
  })
  assert.equal(row.callReference, 'synthetic-key:call-synthetic-1')
})

test('rows are filtered by category and paged deterministically', () => {
  const calls = [
    { ...AUDITED_CALL, id: 'call-a', startedAt: '2026-08-04 09:00:00', taskReference: 'TASK-A' },
    { ...AUDITED_CALL, id: 'call-b', startedAt: '2026-08-05 09:00:00', taskReference: 'TASK-B' },
    {
      ...AUDITED_CALL,
      id: 'call-c',
      category: 'NOT_CONNECTED',
      startedAt: '2026-08-06 09:00:00',
      taskReference: 'TASK-C',
    },
  ]
  const first = callsOf({ calls }, { category: 'PRODUCT_ENQUIRY', limit: 1 })
  const second = callsOf(
    { calls },
    { category: 'PRODUCT_ENQUIRY', limit: 1, offset: 1 },
  )
  // Newest stored call start first, and the pages neither overlap nor skip.
  assert.deepEqual(
    first.map((row) => row.callReference),
    ['TASK-B'],
  )
  assert.deepEqual(
    second.map((row) => row.callReference),
    ['TASK-A'],
  )
})

test('the task reference is the first by reference id, not the smallest text', () => {
  const [row] = callsOf({
    calls: [
      {
        ...AUDITED_CALL,
        taskReference: null,
        // Insertion order, id order and lexical order all disagree: the row
        // inserted first sorts first lexically but carries the LATER id.
        taskReferences: [
          { id: 20, externalId: 'AA-SYNTHETIC-TASK-LATER' },
          { id: 10, externalId: 'ZZ-SYNTHETIC-TASK-FIRST' },
        ],
      },
    ],
  })
  assert.equal(row.callReference, 'ZZ-SYNTHETIC-TASK-FIRST')
})

/**
 * Paging over rows that tie on everything a reader can see.
 *
 * This test pins the CONTRACT: adjacent pages neither repeat a call nor drop
 * one, and the paged sequence is the same order a single unpaged read returns.
 * The in-process engine happens to resolve this tie by scanning the call table
 * in primary-key order, which is the same order the tie-break asks for, so it
 * cannot by itself demonstrate the shuffling a planner is free to do at a
 * different OFFSET. `the page order ends on a unique key that is never
 * projected` covers that half: it fails outright if the unique tie-break is
 * dropped from the statement.
 */
test('paging stays total when start times and references tie', () => {
  const tied = {
    startedAt: '2026-08-04 09:00:00',
    endedAt: '2026-08-04 09:05:00',
  }
  // Inserted in descending id order, so an ordering that leaned on the scan
  // order rather than on a unique key would return these rows differently.
  const calls: SyntheticCall[] = [
    {
      ...AUDITED_CALL,
      ...tied,
      id: 'call-tied-3',
      // No task reference: the display value falls back to the logical key.
      taskReference: null,
      billedMinutes: '3.00000000',
    },
    {
      ...AUDITED_CALL,
      ...tied,
      id: 'call-tied-2',
      taskReference: 'SYNTHETIC-TASK-TIED',
      billedMinutes: '2.00000000',
    },
    {
      ...AUDITED_CALL,
      ...tied,
      id: 'call-tied-1',
      taskReference: 'SYNTHETIC-TASK-TIED',
      billedMinutes: '1.00000000',
    },
  ]
  const pages = [0, 1, 2].map((offset) =>
    callsOf({ calls }, { category: 'PRODUCT_ENQUIRY', limit: 1, offset }),
  )
  for (const page of pages) assert.equal(page.length, 1)

  // The billed duration is the only thing that tells two tied rows apart, and
  // the pages neither repeat one nor drop one.
  const paged = pages.map((page) => page[0].kserveChargeTimeMs)
  assert.deepEqual(paged, [60_000, 120_000, 180_000])
  assert.equal(new Set(paged).size, 3)

  // Two of the three share a display reference, and the third falls back to a
  // key — the tie-break that made paging total is not on the row.
  assert.deepEqual(
    pages.map((page) => page[0].callReference),
    [
      'SYNTHETIC-TASK-TIED',
      'SYNTHETIC-TASK-TIED',
      'synthetic-key:call-tied-3',
    ],
  )
  for (const page of pages) {
    for (const forbidden of ['id', 'callId', 'call_id']) {
      assert.equal(
        forbidden in page[0],
        false,
        `${forbidden} must not be returned`,
      )
    }
  }

  // A whole page that covers everything agrees with the paged sequence.
  assert.deepEqual(
    callsOf({ calls }, { category: 'PRODUCT_ENQUIRY' }).map(
      (row) => row.kserveChargeTimeMs,
    ),
    paged,
  )
})

// ---------------------------------------------------------------------------
// Statement shape
// ---------------------------------------------------------------------------

test('the statements never select evidence, prompts, or transcript text', () => {
  const statements = [
    categoryTotalsSql(categoryTotalsRowsSql(PERIOD_FILTERS)),
    categoryCallsSql(PERIOD_FILTERS),
  ]
  for (const sql of statements) {
    for (const forbidden of [
      'source_url AS',
      'sha256',
      'segment',
      'business_prompt',
      'raw_json',
      'ai_voice_leads_received',
    ]) {
      assert.equal(
        sql.includes(forbidden),
        false,
        `${forbidden} must not be selected`,
      )
    }
    // Read-only: nothing here writes, locks, or alters.
    assert.equal(/INSERT |UPDATE |DELETE |ALTER |FOR UPDATE/.test(sql), false)
  }
})

test('no per-row correlated lookup is repeated for every displayed call', () => {
  const sql = categoryCallsSql(PERIOD_FILTERS)
  // Each relation is joined exactly once as a grouped or ranked derived table.
  assert.equal(sql.match(/vendor_asserted_billed_minutes/g)?.length, 1)
  assert.equal(sql.match(/kaudit_call_external_reference/g)?.length, 1)
  assert.equal(sql.match(/kaudit_media_analysis/g)?.length, 1)
  assert.equal(sql.match(/kaudit_transcript/g)?.length, 1)
  assert.equal(sql.match(/kaudit_billing_calculation/g)?.length, 2)
})

test('the page order ends on a unique key that is never projected', () => {
  const sql = categoryCallsSql(PERIOD_FILTERS)
  assert.match(
    sql,
    /ORDER BY call_started_at DESC, call_reference ASC, c\.id ASC/,
  )
  // The tie-break is an ordering key only: no internal id is selected.
  const projection = sql.slice(0, sql.indexOf('FROM kaudit_call c'))
  assert.equal(/\bc\.id\b/.test(projection), false)
  assert.equal(/\sAS\s+(call_)?id\b/i.test(sql), false)
  assert.equal(/\bc\.id\s+AS\s/i.test(sql), false)
})

test('the totals aggregate never synthesizes money from a duration', () => {
  const sql = categoryTotalsSql('SELECT 1 AS category')
  assert.equal(/CEIL\(/.test(sql), false)
  assert.equal(/4\.75/.test(sql), false)
  assert.equal(/adjusted_chargeable/.test(sql), false)
  // The only auditor money in the statement is the stored final amount.
  assert.match(sql, /SUM\(scoped\.auditor_final_amount\)/)
})

// ---------------------------------------------------------------------------
// Gap semantics and the repository's own wiring
// ---------------------------------------------------------------------------

test('the gap keeps its sign and stays null when either side is missing', () => {
  assert.equal(durationGapMs(180_000, 121_000), 59_000)
  assert.equal(durationGapMs(60_000, 121_000), -61_000)
  assert.equal(durationGapMs(null, 121_000), null)
  assert.equal(durationGapMs(180_000, null), null)
})

test('the repository scopes both reads and never mutates', async () => {
  const statements: string[] = []
  const parameters: unknown[][] = []
  const pool = {
    async query(sql: string, params: unknown[]) {
      statements.push(sql)
      parameters.push(params)
      return [[]]
    },
    async execute() {
      throw new Error('the category read model issues SELECTs only')
    },
  } as unknown as Pool
  const repository = createMysqlBillingCategoryAnalysisRepository(pool)
  await repository.listCategoryTotals({
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  })
  await repository.listCalls({
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
    category: 'PRODUCT_ENQUIRY',
    limit: 25,
    offset: 50,
  })

  assert.equal(statements.length, 2)
  for (const sql of statements) assert.match(sql, /^SELECT/)
  assert.deepEqual(parameters[0], ['2026-08-01', '2026-08-31'])
  assert.deepEqual(parameters[1], [
    '2026-08-01',
    '2026-08-31',
    'PRODUCT_ENQUIRY',
    25,
    50,
  ])
})
