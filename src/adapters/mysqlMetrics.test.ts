import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import type { Pool } from 'mysql2/promise'
import type { BillingMonthScope } from '../reporting/billingMonth.ts'
import {
  collectMetrics,
  coverageSql,
  legacyCoverageSql,
  toCoverageCounts,
} from './mysqlMetrics.ts'

/**
 * The shared coverage read behind the monitoring dashboard.
 *
 * Two layers are covered without contacting any real database:
 *
 *   1. the statement itself, executed by the in-process SQLite engine over
 *      synthetic tables, so the one-row-per-call and one-row-per-artifact
 *      semantics and the month scoping are proven rather than asserted as
 *      text; and
 *   2. the adapter's own wiring, through a recording fake pool that pins how
 *      many statements one dashboard refresh costs.
 *
 * Every fixture here is SYNTHETIC. No real call, recording, URL, hash, amount
 * or secret appears in this file, and no external source table is created,
 * read, written, or locked.
 */

// ---------------------------------------------------------------------------
// Synthetic database
// ---------------------------------------------------------------------------

interface SyntheticArtifact {
  id: string
  /** 'recording' unless a fixture is proving another type is ignored. */
  type?: string
  sourceUrl?: string | null
  sha256?: string | null
  lastVerifiedAt?: string | null
}

interface SyntheticCall {
  id: string
  billingPeriodDate: string
  artifacts?: SyntheticArtifact[]
}

const SCHEMA = `
  CREATE TABLE kaudit_call (
    id TEXT PRIMARY KEY,
    billing_period_date TEXT
  );
  CREATE TABLE kaudit_call_artifact (
    id TEXT PRIMARY KEY,
    call_id TEXT NOT NULL,
    artifact_type TEXT NOT NULL,
    source_url TEXT,
    sha256 TEXT,
    last_verified_at TEXT
  );
`

function synthetic(calls: SyntheticCall[]): DatabaseSync {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  for (const call of calls) {
    db.prepare(
      `INSERT INTO kaudit_call (id, billing_period_date) VALUES (?, ?)`,
    ).run(call.id, call.billingPeriodDate)
    for (const artifact of call.artifacts ?? []) {
      db.prepare(
        `INSERT INTO kaudit_call_artifact
           (id, call_id, artifact_type, source_url, sha256, last_verified_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        artifact.id,
        call.id,
        artifact.type ?? 'recording',
        artifact.sourceUrl ?? null,
        artifact.sha256 ?? null,
        artifact.lastVerifiedAt ?? null,
      )
    }
  }
  return db
}

const AUGUST = ['2026-08-01', '2026-08-31']

const AUGUST_SCOPE: BillingMonthScope = {
  month: '2026-08',
  start: '2026-08-01',
  end: '2026-08-31',
  label: 'August 2026',
}

function coverageOf(calls: SyntheticCall[], scope: 'month' | 'all' = 'month') {
  const db = synthetic(calls)
  try {
    const monthScoped = scope === 'month'
    const row = db
      .prepare(coverageSql(monthScoped))
      .get(...(monthScoped ? AUGUST : []))
    return toCoverageCounts((row ?? null) as Record<string, unknown> | null)
  } finally {
    db.close()
  }
}

/** The same scope read through the five independent fallback statements. */
function legacyCoverageOf(
  calls: SyntheticCall[],
  scope: 'month' | 'all' = 'month',
) {
  const db = synthetic(calls)
  try {
    const monthScoped = scope === 'month'
    const sql = legacyCoverageSql(monthScoped)
    const one = (statement: string) => {
      const row = db.prepare(statement).get(...(monthScoped ? AUGUST : []))
      const value = row ? Object.values(row)[0] : null
      return value == null ? null : Number(value)
    }
    return {
      calls: one(sql.calls),
      recordingArtifacts: one(sql.recordingArtifacts),
      withSourceUrl: one(sql.withSourceUrl),
      withBaseline: one(sql.withBaseline),
      everVerified: one(sql.everVerified),
    }
  } finally {
    db.close()
  }
}

/** Every statement one coverage read can issue, consolidated and fallback. */
function coverageStatements(monthScoped: boolean): string[] {
  return [
    coverageSql(monthScoped),
    ...Object.values(legacyCoverageSql(monthScoped)),
  ]
}

/** One recording, fully covered: backfilled URL, baseline hash, verified. */
const COVERED_CALL: SyntheticCall = {
  id: 'call-synthetic-1',
  billingPeriodDate: '2026-08-01',
  artifacts: [
    {
      id: 'artifact-synthetic-1',
      sourceUrl: 'https://synthetic.invalid/recording',
      sha256: 'synthetic-baseline-hash',
      lastVerifiedAt: '2026-08-05 00:00:00',
    },
  ],
}

// ---------------------------------------------------------------------------
// Aggregate semantics
// ---------------------------------------------------------------------------

test('one statement answers calls and all four artifact counts', () => {
  assert.deepEqual(coverageOf([COVERED_CALL]), {
    calls: 1,
    recordingArtifacts: 1,
    withSourceUrl: 1,
    withBaseline: 1,
    everVerified: 1,
  })
})

test('a call with several recordings is one call and several artifacts', () => {
  const counts = coverageOf([
    {
      id: 'call-multi-artifact',
      billingPeriodDate: '2026-08-04',
      artifacts: [
        {
          id: 'artifact-a',
          sourceUrl: 'https://synthetic.invalid/recording-a',
          sha256: 'synthetic-baseline-a',
          lastVerifiedAt: '2026-08-05 00:00:00',
        },
        // Backfilled but never verified, and carrying no baseline yet.
        { id: 'artifact-b', sourceUrl: 'https://synthetic.invalid/recording-b' },
        // Not backfilled at all.
        { id: 'artifact-c' },
      ],
    },
  ])
  assert.deepEqual(counts, {
    calls: 1,
    recordingArtifacts: 3,
    withSourceUrl: 2,
    withBaseline: 1,
    everVerified: 1,
  })
})

test('a call with no recording still counts as a call', () => {
  assert.deepEqual(
    coverageOf([{ id: 'call-no-recording', billingPeriodDate: '2026-08-02' }]),
    {
      calls: 1,
      recordingArtifacts: 0,
      withSourceUrl: 0,
      withBaseline: 0,
      everVerified: 0,
    },
  )
})

test('an artifact that is not a recording is outside every count', () => {
  const counts = coverageOf([
    {
      id: 'call-other-artifact',
      billingPeriodDate: '2026-08-03',
      artifacts: [
        {
          id: 'artifact-transcript',
          type: 'transcript',
          sourceUrl: 'https://synthetic.invalid/transcript',
          sha256: 'synthetic-baseline-transcript',
          lastVerifiedAt: '2026-08-05 00:00:00',
        },
      ],
    },
  ])
  assert.equal(counts.calls, 1)
  assert.equal(counts.recordingArtifacts, 0)
  assert.equal(counts.withSourceUrl, 0)
})

test('a selected month excludes every call outside it', () => {
  const calls = [
    COVERED_CALL,
    {
      ...COVERED_CALL,
      id: 'call-july',
      billingPeriodDate: '2026-07-20',
      artifacts: [
        {
          id: 'artifact-july',
          sourceUrl: 'https://synthetic.invalid/recording-july',
          sha256: 'synthetic-baseline-july',
          lastVerifiedAt: '2026-07-21 00:00:00',
        },
      ],
    },
    {
      ...COVERED_CALL,
      id: 'call-september',
      billingPeriodDate: '2026-09-01',
      artifacts: [{ id: 'artifact-september' }],
    },
  ]
  assert.deepEqual(coverageOf(calls, 'month'), {
    calls: 1,
    recordingArtifacts: 1,
    withSourceUrl: 1,
    withBaseline: 1,
    everVerified: 1,
  })
  // The all-period read is the same statement without the window.
  assert.deepEqual(coverageOf(calls, 'all'), {
    calls: 3,
    recordingArtifacts: 3,
    withSourceUrl: 2,
    withBaseline: 2,
    everVerified: 2,
  })
})

test('the five fallback statements agree with the consolidated one', () => {
  const calls = [
    COVERED_CALL,
    {
      id: 'call-fallback-multi',
      billingPeriodDate: '2026-08-09',
      artifacts: [
        { id: 'artifact-x', sourceUrl: 'https://synthetic.invalid/recording-x' },
        { id: 'artifact-y', sha256: 'synthetic-baseline-y' },
        // Another type, outside every artifact count on both paths.
        { id: 'artifact-z', type: 'transcript', sha256: 'synthetic-baseline-z' },
      ],
    },
    {
      id: 'call-july-fallback',
      billingPeriodDate: '2026-07-20',
      artifacts: [
        {
          id: 'artifact-july-fallback',
          sourceUrl: 'https://synthetic.invalid/recording-july',
          sha256: 'synthetic-baseline-july',
          lastVerifiedAt: '2026-07-21 00:00:00',
        },
      ],
    },
  ]
  assert.deepEqual(legacyCoverageOf(calls, 'month'), coverageOf(calls, 'month'))
  assert.deepEqual(legacyCoverageOf(calls, 'all'), coverageOf(calls, 'all'))
})

// ---------------------------------------------------------------------------
// Statement shape
// ---------------------------------------------------------------------------

test('the coverage statements are parameterized and read-only', () => {
  for (const sql of coverageStatements(true)) {
    assert.match(sql, /^SELECT/)
    assert.match(sql, /c\.billing_period_date BETWEEN \? AND \?/)
    assert.equal(/INSERT |UPDATE |DELETE |ALTER |FOR UPDATE|LOCK /.test(sql), false)
    // No date, month or identifier is ever inlined into the text.
    assert.equal(/\d{4}-\d{2}-\d{2}/.test(sql), false)
  }
  for (const sql of coverageStatements(false)) {
    assert.equal(sql.includes('?'), false)
    assert.equal(sql.includes('billing_period_date'), false)
  }
})

test('no coverage statement reads outside the two audit tables', () => {
  for (const sql of [...coverageStatements(true), ...coverageStatements(false)]) {
    const tables = [...sql.matchAll(/(?:FROM|JOIN)\s+([a-z0-9_]+)/g)].map(
      (match) => match[1],
    )
    assert.notEqual(tables.length, 0)
    for (const table of tables) {
      assert.ok(
        table === 'kaudit_call' || table === 'kaudit_call_artifact',
        `${table} is not a coverage table`,
      )
    }
  }
})

test('the coverage statements project counts only, never row data', () => {
  for (const sql of coverageStatements(true)) {
    const projection = sql.slice(
      sql.indexOf('SELECT') + 'SELECT'.length,
      sql.indexOf('FROM'),
    )
    for (const expression of projection.split(',')) {
      assert.match(
        expression.trim(),
        /^COUNT\((DISTINCT )?(\*|[a-z0-9_.]+)\)( AS [a-z_]+)?$/,
        `every selected expression must be a count, not ${expression.trim()}`,
      )
    }
    // Nothing identifying, addressable or verifiable leaves as a value.
    for (const forbidden of [
      'source_url AS',
      'sha256 AS',
      'ca.id AS',
      'c.id AS',
      'segment',
      'transcript',
      'raw_json',
      'ai_voice_leads_received',
    ]) {
      assert.equal(sql.includes(forbidden), false, `${forbidden} must not be selected`)
    }
  }
})

// ---------------------------------------------------------------------------
// The adapter's own wiring
// ---------------------------------------------------------------------------

/** A pool that records statements and answers each one with `rows`. */
function recordingPool(
  rows: (sql: string) => unknown[],
): { pool: Pool; statements: string[]; parameters: unknown[][] } {
  const statements: string[] = []
  const parameters: unknown[][] = []
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      statements.push(sql)
      parameters.push(params)
      return [rows(sql)]
    },
    async execute() {
      throw new Error('the metrics read issues SELECTs only')
    },
  } as unknown as Pool
  return { pool, statements, parameters }
}

const COVERAGE_ROW = {
  calls: 12,
  recording_artifacts: 20,
  with_source_url: 18,
  with_baseline: 9,
  ever_verified: 4,
}

test('a month refresh costs exactly one statement', async () => {
  const { pool, statements, parameters } = recordingPool(() => [COVERAGE_ROW])
  const metrics = await collectMetrics(pool, AUGUST_SCOPE)

  assert.equal(statements.length, 1)
  assert.deepEqual(parameters[0], ['2026-08-01', '2026-08-31'])
  assert.equal(metrics.calls, 12)
  assert.equal(metrics.recordingArtifacts, 20)
  assert.equal(metrics.withSourceUrl, 18)
  assert.equal(metrics.withBaseline, 9)
  assert.equal(metrics.everVerified, 4)
  // Tables that carry no billing month stay pending for a selected month.
  assert.equal(metrics.evidenceObjects, null)
  assert.equal(metrics.ingestionBatches, null)
  assert.equal(metrics.users, null)
  assert.deepEqual(metrics.findings, [])
})

test('an all-period refresh keeps only the reads a month cannot scope', async () => {
  const { pool, statements } = recordingPool((sql) =>
    sql.includes('kaudit_audit_log')
      ? [{ action: 'evidence_synthetic', n: 3 }]
      : sql.includes('kaudit_call_artifact')
        ? [COVERAGE_ROW]
        : [{ n: 7 }],
  )
  const metrics = await collectMetrics(pool)

  // One coverage statement, the four unscopable table counts, and the
  // audit-log grouping — nothing else.
  assert.equal(statements.length, 6)
  assert.equal(
    statements.filter((sql) => sql.includes('kaudit_call_artifact')).length,
    1,
  )
  for (const sql of statements) assert.match(sql, /^SELECT/)
  assert.equal(metrics.calls, 12)
  assert.equal(metrics.evidenceObjects, 7)
  assert.equal(metrics.ingestionCompleted, 7)
  assert.deepEqual(metrics.findings, [{ action: 'evidence_synthetic', n: 3 }])
})

/** Answers each fallback statement with a value only it can produce. */
function fallbackRows(sql: string): unknown[] {
  if (sql.includes('last_verified_at IS NOT NULL')) return [{ n: 4 }]
  if (sql.includes('sha256 IS NOT NULL')) return [{ n: 9 }]
  if (sql.includes('source_url IS NOT NULL')) return [{ n: 18 }]
  if (sql.includes('kaudit_call_artifact')) return [{ n: 20 }]
  return [{ n: 12 }]
}

test('one unavailable column leaves only its own count pending', async () => {
  const { pool, statements, parameters } = recordingPool((sql) => {
    // No source_url before migration 0002: the consolidated read fails, and so
    // does the one fallback statement that names the column.
    if (sql.includes('source_url')) throw new Error('no such column')
    return fallbackRows(sql)
  })
  const metrics = await collectMetrics(pool, AUGUST_SCOPE)

  // The consolidated attempt, then the five independent reads.
  assert.equal(statements.length, 6)
  for (const params of parameters) {
    assert.deepEqual(params, ['2026-08-01', '2026-08-31'])
  }
  assert.equal(metrics.withSourceUrl, null)
  // Every metric that did not need the missing column still reports.
  assert.equal(metrics.calls, 12)
  assert.equal(metrics.recordingArtifacts, 20)
  assert.equal(metrics.withBaseline, 9)
  assert.equal(metrics.everVerified, 4)
})

test('a missing artifact table still reports the call count', async () => {
  const { pool } = recordingPool((sql) => {
    if (sql.includes('kaudit_call_artifact')) {
      throw new Error("table 'kaudit_call_artifact' doesn't exist")
    }
    return fallbackRows(sql)
  })
  const metrics = await collectMetrics(pool, AUGUST_SCOPE)

  // The call count does not read that table, so it must survive.
  assert.equal(metrics.calls, 12)
  assert.equal(metrics.recordingArtifacts, null)
  assert.equal(metrics.withSourceUrl, null)
  assert.equal(metrics.withBaseline, null)
  assert.equal(metrics.everVerified, null)
})

test('an unreachable database leaves every coverage count pending', async () => {
  const { pool } = recordingPool(() => {
    throw new Error('unreachable')
  })
  const metrics = await collectMetrics(pool)
  assert.deepEqual(
    {
      calls: metrics.calls,
      recordingArtifacts: metrics.recordingArtifacts,
      withSourceUrl: metrics.withSourceUrl,
      withBaseline: metrics.withBaseline,
      everVerified: metrics.everVerified,
    },
    {
      calls: null,
      recordingArtifacts: null,
      withSourceUrl: null,
      withBaseline: null,
      everVerified: null,
    },
  )
})
