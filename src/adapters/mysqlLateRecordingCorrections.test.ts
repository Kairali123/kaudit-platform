import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Pool } from 'mysql2/promise'
import {
  commitLateRecordingBatch,
  createMysqlLateRecordingCandidateRepository,
  finalizeLateRecordingBatch,
  listLateRecordingCorrectionFacts,
  listUnfinishedLateRecordingBatchIds,
  prepareLateRecordingBatch,
  previewLateRecordingBatch,
  readLateRecordingBatchProgress,
  readVerifiedMonthTotal,
  settleLateRecordingItem,
} from './mysqlLateRecordingCorrections.ts'
import { LateRecordingError } from '../lateRecording/corrections.ts'
import {
  canonicalUrlSha256,
  lateRecordingBatchDigest,
} from '../lateRecording/corrections.ts'

/**
 * Contract for the late-recording adapter, proved through a RECORDING FAKE
 * POOL. Every statement this module would run is captured and asserted on;
 * nothing here contacts a real database.
 *
 * Every fixture is SYNTHETIC. No real task id, call, recording, bucket,
 * amount, or invoice appears in this file.
 */

const PERIOD = {
  month: '2026-06',
  label: 'June 2026',
  start: '2026-06-01',
  end: '2026-06-30',
}
const OBJECT_URL =
  'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/synthetic-a.ogg'
const BATCH_ID = 'lrb_00000000-0000-4000-8000-000000000000'

interface Executed {
  sql: string
  parameters: unknown[]
}

interface Fixture {
  pool: Pool
  executed: Executed[]
  find(pattern: RegExp): Executed | undefined
  all(pattern: RegExp): Executed[]
}

/**
 * A fake pool that answers each statement from a pattern table.
 *
 * Matching on the statement itself rather than on call order keeps the tests
 * readable when the adapter adds a probe, and makes each fixture state which
 * question it is answering.
 */
function fakePool(
  answers: Array<[RegExp, unknown[] | { affectedRows: number }]> = [],
): Fixture {
  const executed: Executed[] = []
  const answer = (sql: string): unknown => {
    for (const [pattern, rows] of answers) {
      if (pattern.test(sql)) return rows
    }
    return []
  }
  const run = async (sql: string, parameters: unknown[] = []) => {
    executed.push({ sql, parameters })
    return [answer(sql), []] as never
  }
  const connection = {
    execute: run,
    query: run,
    beginTransaction: async () => undefined,
    commit: async () => undefined,
    rollback: async () => undefined,
    release: () => undefined,
  }
  const pool = {
    execute: run,
    query: run,
    getConnection: async () => connection,
  } as unknown as Pool
  return {
    pool,
    executed,
    find: (pattern) => executed.find((item) => pattern.test(item.sql)),
    all: (pattern) => executed.filter((item) => pattern.test(item.sql)),
  }
}

const rateCardUsable: [RegExp, unknown[]] = [
  /FROM kaudit_rate_card_version card/,
  [{ id: 'synthetic-rate-card' }],
]

function row(overrides: Record<string, unknown> = {}) {
  return {
    task_reference: 'T-SYNTH-1',
    call_id: 'synthetic-call-1',
    artifact_id: 'synthetic-artifact-1',
    source_url: null,
    evidence_sha256: null,
    invoice_present: 1,
    audit_completed: 0,
    live_calculation_id: 'synthetic-calc-1',
    live_calculation_basis: 'no_recording_zero',
    live_total_amount: '0.00000000',
    ...overrides,
  }
}

const uploadedRow = {
  rowNumber: 2,
  taskId: 'T-SYNTH-1',
  submittedUrl: OBJECT_URL,
  canonicalUrl: OBJECT_URL,
}

// ---------------------------------------------------------------------------
// Preview writes nothing
// ---------------------------------------------------------------------------

test('a preview runs SELECTs only and opens no transaction', async () => {
  const fixture = fakePool([rateCardUsable, [/task_reference/, [row()]]])
  const preview = await previewLateRecordingBatch(fixture.pool, {
    period: PERIOD,
    rows: [uploadedRow],
    carriedRejections: [],
  })
  assert.equal(preview.acceptedCount, 1)
  assert.equal(preview.billMonth, '2026-06')
  for (const statement of fixture.executed) {
    assert.match(statement.sql.trimStart(), /^(?:SELECT|WITH)/i)
  }
  assert.doesNotMatch(
    fixture.executed.map((item) => item.sql).join('\n'),
    /INSERT|UPDATE|DELETE|GET_LOCK/i,
  )
  const rateCard = fixture.find(/FROM kaudit_rate_card_version card/) as Executed
  assert.match(rateCard.sql, /card\.effective_from <= \?/)
  assert.match(rateCard.sql, /card\.effective_to IS NULL OR card\.effective_to >= \?/)
  assert.match(String(rateCard.parameters[0]), /^[a-f0-9]{64}$/)
  assert.deepEqual(rateCard.parameters.slice(1), ['2026-06-01', '2026-06-30'])
})

test('task resolution is bounded to the selected month on both sides', async () => {
  const fixture = fakePool([rateCardUsable, [/task_reference/, [row()]]])
  await previewLateRecordingBatch(fixture.pool, {
    period: PERIOD,
    rows: [uploadedRow],
    carriedRejections: [],
  })
  const resolution = fixture.find(/task_reference/) as Executed
  // Both halves of the UNION carry the month predicate; a Task ID that exists
  // in another month resolves to nothing rather than being corrected here.
  assert.equal(
    resolution.sql.match(/billing_period_date BETWEEN \? AND \?/g)?.length,
    2,
  )
  assert.match(resolution.sql, /kaudit_call_external_reference/)
  assert.match(resolution.sql, /artifact_type = 'recording'/)
  assert.match(resolution.sql, /supersedes_calculation_id = live\.id/)
  assert.deepEqual(resolution.parameters, [
    '2026-06-01',
    '2026-06-30',
    'T-SYNTH-1',
    'T-SYNTH-1',
    '2026-06-01',
    '2026-06-30',
  ])
})

test('a preview with nothing resolvable accepts nothing', async () => {
  const fixture = fakePool([rateCardUsable])
  const preview = await previewLateRecordingBatch(fixture.pool, {
    period: PERIOD,
    rows: [uploadedRow],
    carriedRejections: [
      { rowNumber: 3, outcome: 'rejected', code: 'URL_NOT_ALLOWLISTED' },
    ],
  })
  assert.equal(preview.acceptedCount, 0)
  assert.equal(preview.rejectedCount, 2)
  assert.deepEqual(preview.rejectionCounts, {
    TASK_NOT_FOUND: 1,
    URL_NOT_ALLOWLISTED: 1,
  })
})

// ---------------------------------------------------------------------------
// Commit: the one-way evidence transition
// ---------------------------------------------------------------------------

test('a commit attaches the canonical URL only to an EMPTY artifact', async () => {
  const fixture = fakePool([
    rateCardUsable,
    [/task_reference/, [row()]],
    [/GET_LOCK/, [{ acquired: 1 }]],
    [/UPDATE kaudit_call_artifact/, { affectedRows: 1 }],
  ])
  const receipt = await commitLateRecordingBatch(fixture.pool, {
    period: PERIOD,
    rows: [uploadedRow],
    carriedRejections: [],
    sourceFileSha256: 'f'.repeat(64),
    idempotencyKey: 'lr-0123456789abcdef',
    requestedByUserId: 'synthetic-user',
    correlationId: 'synthetic-correlation',
    requestedAt: new Date(0),
  })
  assert.equal(receipt.outcome, 'accepted')
  assert.match(receipt.batchId as string, /^lrb_/)

  const attach = fixture.find(/UPDATE kaudit_call_artifact/) as Executed
  // THE guarantee: this statement can only ever fire on an artifact that has
  // no evidence behind it at all.
  assert.match(attach.sql, /source_url IS NULL AND sha256 IS NULL/)
  assert.match(attach.sql, /artifact_type = 'recording' AND is_final = 1/)
  assert.match(attach.sql, /audio_processing_status = 'pending'/)
  assert.match(attach.sql, /audio_attempt_count = 0/)
  assert.match(attach.sql, /audio_next_attempt_at = NULL/)
  assert.match(attach.sql, /audio_last_error = NULL/)
  assert.equal(attach.parameters[0], OBJECT_URL)

  const batch = fixture.find(/INSERT INTO kaudit_late_recording_batch/) as Executed
  assert.match(batch.sql, /rate_card_version_id/)
  assert.equal(batch.parameters[10], 'synthetic-rate-card')

  const item = fixture.find(/INSERT INTO kaudit_late_recording_item/) as Executed
  // The item stores the HASH of the canonical URL, never the URL.
  assert.ok(!item.parameters.some((value) => String(value).includes('http')))
  assert.match(String(item.parameters[6]), /^[a-f0-9]{64}$/)
  assert.equal(item.parameters[7], '0.00000000')
  assert.equal(item.parameters[8], 'synthetic-calc-1')
})

test('an artifact that changed under the preview becomes a conflict, not an overwrite', async () => {
  const fixture = fakePool([
    rateCardUsable,
    [/task_reference/, [row()]],
    [/GET_LOCK/, [{ acquired: 1 }]],
    // Zero rows matched: something attached a recording between preview and
    // commit, so the predicate refused rather than overwriting it.
    [/UPDATE kaudit_call_artifact/, { affectedRows: 0 }],
  ])
  const receipt = await commitLateRecordingBatch(fixture.pool, {
    period: PERIOD,
    rows: [uploadedRow],
    carriedRejections: [],
    sourceFileSha256: 'f'.repeat(64),
    idempotencyKey: 'lr-0123456789abcdef',
    requestedByUserId: 'synthetic-user',
    correlationId: 'synthetic-correlation',
    requestedAt: new Date(0),
  })
  assert.equal(receipt.outcome, 'nothing_to_do')
  assert.equal(receipt.batchId, null)
  assert.deepEqual(receipt.decisions, [
    {
      rowNumber: 2,
      outcome: 'rejected',
      code: 'RECORDING_URL_ALREADY_PRESENT',
    },
  ])
  assert.equal(fixture.find(/INSERT INTO kaudit_late_recording_batch/), undefined)
})

test('a changed selection cannot reuse an earlier retry key', async () => {
  const fixture = fakePool([
    rateCardUsable,
    [/task_reference/, [row()]],
    [/GET_LOCK/, [{ acquired: 1 }]],
    [
      /FROM kaudit_late_recording_batch\s+WHERE idempotency_key/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          // The digest the same selection produces; asserted by replaying it.
          request_digest: 'placeholder',
          status: 'running',
          submitted_count: 1,
          accepted_count: 1,
          rejected_count: 0,
          corrected_count: 0,
          failed_count: 0,
        },
      ],
    ],
  ])
  await assert.rejects(
    () =>
      commitLateRecordingBatch(fixture.pool, {
        period: PERIOD,
        rows: [uploadedRow],
        carriedRejections: [],
        sourceFileSha256: 'f'.repeat(64),
        idempotencyKey: 'lr-0123456789abcdef',
        requestedByUserId: 'synthetic-user',
        correlationId: 'synthetic-correlation',
        requestedAt: new Date(0),
      }),
    (error: LateRecordingError) =>
      error.code === 'LATE_RECORDING_REQUEST_CONFLICT' && error.status === 409,
  )
  // A conflicting retry key writes nothing at all.
  assert.equal(fixture.find(/UPDATE kaudit_call_artifact/), undefined)
  assert.equal(fixture.find(/INSERT INTO/), undefined)
})

test('the same normalized request replays after the call state has advanced', async () => {
  const digest = lateRecordingBatchDigest({
    billMonth: PERIOD.month,
    items: [
      {
        taskId: uploadedRow.taskId,
        canonicalUrlSha256: canonicalUrlSha256(OBJECT_URL),
      },
    ],
  })
  const fixture = fakePool([
    rateCardUsable,
    [
      /task_reference/,
      [
        row({
          source_url: OBJECT_URL,
          evidence_sha256: 'a'.repeat(64),
          audit_completed: 1,
          live_calculation_basis: 'independent_category_service_end',
        }),
      ],
    ],
    [/GET_LOCK/, [{ acquired: 1 }]],
    [
      /FROM kaudit_late_recording_batch\s+WHERE idempotency_key/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          request_digest: digest,
          status: 'running',
          submitted_count: 1,
          accepted_count: 1,
          rejected_count: 0,
          corrected_count: 0,
          failed_count: 0,
        },
      ],
    ],
  ])
  const receipt = await commitLateRecordingBatch(fixture.pool, {
    period: PERIOD,
    rows: [uploadedRow],
    carriedRejections: [],
    sourceFileSha256: 'f'.repeat(64),
    idempotencyKey: 'lr-0123456789abcdef',
    requestedByUserId: 'synthetic-user',
    correlationId: 'synthetic-correlation',
    requestedAt: new Date(0),
  })
  assert.equal(receipt.outcome, 'replayed')
  assert.equal(receipt.batchId, BATCH_ID)
  assert.equal(fixture.find(/UPDATE kaudit_call_artifact/), undefined)
  assert.equal(fixture.find(/INSERT INTO/), undefined)
})

test('a commit that cannot take the serialization lock refuses cleanly', async () => {
  const fixture = fakePool([[/GET_LOCK/, [{ acquired: 0 }]]])
  await assert.rejects(
    () =>
      commitLateRecordingBatch(fixture.pool, {
        period: PERIOD,
        rows: [uploadedRow],
        carriedRejections: [],
        sourceFileSha256: 'f'.repeat(64),
        idempotencyKey: 'lr-0123456789abcdef',
        requestedByUserId: 'synthetic-user',
        correlationId: 'synthetic-correlation',
        requestedAt: new Date(0),
      }),
    (error: LateRecordingError) => error.code === 'LATE_RECORDING_BUSY',
  )
  assert.equal(fixture.find(/UPDATE kaudit_call_artifact/), undefined)
})

// ---------------------------------------------------------------------------
// The worker's scope
// ---------------------------------------------------------------------------

test('candidate selection is an exact join to ONE batch and includes due audit retries', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_item item\s+JOIN kaudit_call_artifact/,
      [
        {
          item_id: 'lri_1',
          batch_id: BATCH_ID,
          call_id: 'synthetic-call-1',
          artifact_id: 'synthetic-artifact-1',
          source_url: OBJECT_URL,
          evidence_sha256: null,
        },
      ],
    ],
    [/UPDATE kaudit_late_recording_item/, { affectedRows: 1 }],
  ])
  const candidates = await createMysqlLateRecordingCandidateRepository(
    fixture.pool,
    { batchId: BATCH_ID },
  ).listCandidates({ limit: 5, includePreviouslyClassified: false })

  const claim = fixture.find(
    /FROM kaudit_late_recording_item item\s+JOIN kaudit_call_artifact/,
  ) as Executed
  assert.match(claim.sql, /WHERE item\.batch_id = \?/)
  assert.match(claim.sql, /item\.state = 'accepted'/)
  assert.deepEqual(claim.parameters, [BATCH_ID])
  // No month and no eligibility sweep: a run physically cannot
  // reach a call the administrator did not upload.
  assert.doesNotMatch(claim.sql, /billing_period_date/)
  assert.match(claim.sql, /audio_processing_status/)
  assert.match(claim.sql, /audio_next_attempt_at <= current_timestamp/)
  assert.match(claim.sql, /item\.attempt_count = 1/)

  assert.equal(candidates.length, 1)
  assert.equal(candidates[0]?.callId, 'synthetic-call-1')
  // The URL reaches the fetcher through the candidate and nowhere else.
  assert.equal(candidates[0]?.sourceUrl, OBJECT_URL)
})

test('a claim that loses its race is dropped rather than audited twice', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_item item\s+JOIN kaudit_call_artifact/,
      [
        {
          item_id: 'lri_1',
          batch_id: BATCH_ID,
          call_id: 'synthetic-call-1',
          artifact_id: 'synthetic-artifact-1',
          source_url: OBJECT_URL,
          evidence_sha256: null,
        },
      ],
    ],
    [/UPDATE kaudit_late_recording_item/, { affectedRows: 0 }],
  ])
  const candidates = await createMysqlLateRecordingCandidateRepository(
    fixture.pool,
    { batchId: BATCH_ID },
  ).listCandidates({ limit: 5, includePreviouslyClassified: false })
  assert.deepEqual(candidates, [])
})

test('a due artifact retry resumes the same item without incrementing its claim', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_item item\s+JOIN kaudit_call_artifact/,
      [
        {
          item_id: 'lri_retry',
          batch_id: BATCH_ID,
          call_id: 'synthetic-call-retry',
          artifact_id: 'synthetic-artifact-retry',
          source_url: OBJECT_URL,
          evidence_sha256: null,
          item_state: 'auditing',
        },
      ],
    ],
  ])
  const candidates = await createMysqlLateRecordingCandidateRepository(
    fixture.pool,
    { batchId: BATCH_ID },
  ).listCandidates({ limit: 5, includePreviouslyClassified: false })
  assert.equal(candidates[0]?.callId, 'synthetic-call-retry')
  assert.equal(fixture.find(/SET state = 'auditing'/), undefined)
  const claim = fixture.find(/item\.state = 'auditing'/) as Executed
  assert.match(claim.sql, /NOT EXISTS \([\s\S]*status = 'completed'/)
  assert.match(claim.sql, /audio_next_attempt_at <= current_timestamp/)
})

test('a future artifact retry is deferred instead of being lost', async () => {
  const fixture = fakePool([[/TIMESTAMPDIFF/, [{ due_in_us: 2_500_000 }]]])
  const repository = createMysqlLateRecordingCandidateRepository(fixture.pool, {
    batchId: BATCH_ID,
  })
  assert.equal(await repository.deferredWorkDueInMs?.(), 2_500)
  const due = fixture.find(/TIMESTAMPDIFF/) as Executed
  assert.match(due.sql, /audio_next_attempt_at > current_timestamp/)
  assert.match(due.sql, /item\.state = 'auditing'/)
  assert.deepEqual(due.parameters, [BATCH_ID])
})

test('correction facts are read for one batch and carry the live calculation', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_item item[\s\S]{0,120}JOIN kaudit_call c/,
      [
        {
          item_id: 'lri_1',
          call_id: 'synthetic-call-1',
          task_reference: 'T-SYNTH-1',
          state: 'auditing',
          artifact_id: 'synthetic-artifact-1',
          audio_processing_status: 'completed',
          audio_attempt_count: 1,
          audio_last_error: null,
          audit_run_id: 'synthetic-run-1',
          category: 'OK',
          recorded_duration_ms: 120_000,
          speech_ms: 90_000,
          service_end_ms: 40_000,
          grace_ms: 60_000,
          vendor_billed_minutes: '2.00000000',
          vendor_billed_amount: '19.00000000',
          claimed_duration_ms: 125_000,
          connected_duration_ms: 120_000,
          evidence_object_id: 'synthetic-evidence-1',
          evidence_sha256: 'c'.repeat(64),
          baseline_calculation_id: 'synthetic-calc-1',
          baseline_total_amount: '0.00000000',
          current_calculation_id: 'synthetic-calc-1',
          current_supersedes_calculation_id: null,
          current_rate_card_version_id: 'synthetic-rate-card',
          current_total_amount: '0.00000000',
          bound_rate_card_version_id: 'synthetic-rate-card',
        },
      ],
    ],
  ])
  const facts = await listLateRecordingCorrectionFacts(fixture.pool, BATCH_ID)
  const statement = fixture.find(
    /FROM kaudit_late_recording_item item[\s\S]{0,120}JOIN kaudit_call c/,
  ) as Executed
  assert.match(statement.sql, /WHERE item\.batch_id = \?/)
  assert.deepEqual(statement.parameters, [BATCH_ID])
  assert.equal(facts[0]?.auditCompleted, true)
  assert.equal(facts[0]?.auditExhausted, false)
  assert.equal(facts[0]?.baselineCalculationId, 'synthetic-calc-1')
  assert.equal(facts[0]?.baselineTotalAmount, '0.00000000')
  assert.equal(facts[0]?.persistedRevisedAmount, null)
})

test('correction facts recognize money written before an interrupted item settle', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_item item[\s\S]{0,120}JOIN kaudit_call c/,
      [
        {
          item_id: 'lri_1',
          call_id: 'synthetic-call-1',
          task_reference: 'T-SYNTH-1',
          state: 'auditing',
          artifact_id: 'synthetic-artifact-1',
          audio_processing_status: 'completed',
          audio_attempt_count: 1,
          audio_last_error: null,
          audit_run_id: 'synthetic-run-1',
          category: 'OK',
          recorded_duration_ms: 120_000,
          speech_ms: 90_000,
          service_end_ms: 40_000,
          grace_ms: 60_000,
          vendor_billed_minutes: '2.00000000',
          vendor_billed_amount: '19.00000000',
          claimed_duration_ms: 125_000,
          connected_duration_ms: 120_000,
          evidence_object_id: 'synthetic-evidence-1',
          evidence_sha256: 'c'.repeat(64),
          baseline_calculation_id: 'synthetic-calc-zero',
          baseline_total_amount: '0.00000000',
          current_calculation_id: 'synthetic-calc-revised',
          current_supersedes_calculation_id: 'synthetic-calc-zero',
          current_rate_card_version_id: 'synthetic-rate-card',
          current_total_amount: '19.00000000',
          bound_rate_card_version_id: 'synthetic-rate-card',
        },
      ],
    ],
  ])
  const facts = await listLateRecordingCorrectionFacts(fixture.pool, BATCH_ID)
  assert.equal(facts[0]?.baselineCalculationId, 'synthetic-calc-zero')
  assert.equal(facts[0]?.baselineTotalAmount, '0.00000000')
  assert.equal(facts[0]?.persistedRevisedAmount, '19.00000000')
})

test('an exhausted audit the worker would still reclaim is not treated as finished', async () => {
  const base = {
    item_id: 'lri_1',
    call_id: 'synthetic-call-1',
    task_reference: 'T-SYNTH-1',
    state: 'auditing',
    artifact_id: 'synthetic-artifact-1',
    audio_processing_status: 'exhausted',
    audit_run_id: null,
    category: null,
    recorded_duration_ms: null,
    speech_ms: null,
    service_end_ms: null,
    grace_ms: null,
    vendor_billed_minutes: '2.00000000',
    vendor_billed_amount: null,
    claimed_duration_ms: null,
    connected_duration_ms: null,
    evidence_object_id: 'synthetic-evidence-1',
    evidence_sha256: 'c'.repeat(64),
    baseline_calculation_id: 'synthetic-calc-1',
    baseline_total_amount: '0.00000000',
    current_calculation_id: 'synthetic-calc-1',
    current_supersedes_calculation_id: null,
    current_rate_card_version_id: 'synthetic-rate-card',
    current_total_amount: '0.00000000',
    bound_rate_card_version_id: 'synthetic-rate-card',
  }
  const reclaimable = await listLateRecordingCorrectionFacts(
    fakePool([
      [
        /FROM kaudit_late_recording_item item[\s\S]{0,120}JOIN kaudit_call c/,
        [
          {
            ...base,
            audio_last_error: 'CLASSIFICATION_VALIDATION_FAILED',
            audio_attempt_count: 2,
          },
        ],
      ],
    ]).pool,
    BATCH_ID,
  )
  assert.equal(reclaimable[0]?.auditExhausted, false)

  const finished = await listLateRecordingCorrectionFacts(
    fakePool([
      [
        /FROM kaudit_late_recording_item item[\s\S]{0,120}JOIN kaudit_call c/,
        [
          {
            ...base,
            audio_last_error: 'TRANSCRIPTION_FAILED',
            audio_attempt_count: 8,
          },
        ],
      ],
    ]).pool,
    BATCH_ID,
  )
  assert.equal(finished[0]?.auditExhausted, true)
})

// ---------------------------------------------------------------------------
// Settlement, totals and reads
// ---------------------------------------------------------------------------

test('preparing a batch captures its pre-correction month total exactly once', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_batch\s+WHERE id = \?\s+FOR UPDATE/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          request_digest: 'd'.repeat(64),
          status: 'accepted',
          submitted_count: 1,
          accepted_count: 1,
          rejected_count: 0,
          corrected_count: 0,
          failed_count: 0,
          rate_card_version_id: 'synthetic-rate-card',
          baseline_verified_total: null,
          baseline_captured_at: null,
        },
      ],
    ],
    [/AS verified_total/, [{ verified_total: '100.25' }]],
    [/SET baseline_verified_total/, { affectedRows: 1 }],
  ])
  const prepared = await prepareLateRecordingBatch(fixture.pool, {
    batchId: BATCH_ID,
    period: PERIOD,
    at: new Date(0),
  })
  assert.deepEqual(prepared, {
    rateCardVersionId: 'synthetic-rate-card',
    previousVerifiedTotal: '100.25000000',
    finalized: false,
  })
  const capture = fixture.find(/SET baseline_verified_total/) as Executed
  assert.match(capture.sql, /WHERE id = \? AND baseline_verified_total IS NULL/)
  assert.equal(capture.parameters[0], '100.25000000')
})

test('settling an item keeps the batch recoverable until its correction is appended', async () => {
  const fixture = fakePool([
    [/UPDATE kaudit_late_recording_item/, { affectedRows: 1 }],
  ])
  await settleLateRecordingItem(fixture.pool, {
    batchId: BATCH_ID,
    itemId: 'lri_1',
    outcome: 'corrected',
    previousAmount: '0',
    revisedAmount: '9.5',
    supersededCalculationId: 'synthetic-calc-1',
    at: new Date(0),
  })
  const update = fixture.find(/UPDATE kaudit_late_recording_item/) as Executed
  assert.match(update.sql, /state = 'auditing'/)
  assert.equal(update.parameters[3], '0.00000000')
  assert.equal(update.parameters[4], '9.50000000')
  const rollup = fixture.find(
    /UPDATE kaudit_late_recording_batch batch/,
  ) as Executed
  assert.match(rollup.sql, /batch\.status = 'running'/)
  assert.match(rollup.sql, /batch\.completed_at = NULL/)
  assert.doesNotMatch(rollup.sql, /completed_with_failures/)
})

test('settling an item that is no longer claimed is a bounded refusal', async () => {
  const fixture = fakePool([
    [/UPDATE kaudit_late_recording_item/, { affectedRows: 0 }],
  ])
  await assert.rejects(
    () =>
      settleLateRecordingItem(fixture.pool, {
        batchId: BATCH_ID,
        itemId: 'lri_1',
        outcome: 'corrected',
        at: new Date(0),
      }),
    (error: LateRecordingError) =>
      error.code === 'LATE_RECORDING_ITEM_STATE_CONFLICT',
  )
})

test('finalization appends one exact correction and terminalizes atomically', async () => {
  const completedAt = new Date('2026-07-01T00:00:00.000Z')
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_batch\s+WHERE id = \?\s+FOR UPDATE/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          request_digest: 'd'.repeat(64),
          status: 'running',
          submitted_count: 1,
          accepted_count: 1,
          rejected_count: 0,
          corrected_count: 1,
          failed_count: 0,
          rate_card_version_id: 'synthetic-rate-card',
          baseline_verified_total: '100.00000000',
          baseline_captured_at: new Date(0),
        },
      ],
    ],
    [
      /SUM\(state IN \('accepted','auditing'\)\)/,
      [
        {
          live_count: 0,
          corrected_count: 1,
          failed_count: 0,
          completed_at: completedAt,
        },
      ],
    ],
  ])
  const result = await finalizeLateRecordingBatch(fixture.pool, {
    batchId: BATCH_ID,
    billMonth: '2026-06',
    revisedVerifiedTotal: '109.5',
    actualPaidAmount: '100',
    revisedVariance: '-9.5',
  })
  assert.equal(result.outcome, 'recorded')
  assert.equal(result.deltaAmount, '9.50000000')
  const insert = fixture.find(
    /INSERT INTO kaudit_late_recording_month_correction/,
  ) as Executed
  assert.doesNotMatch(insert.sql, /IGNORE/)
  assert.equal(insert.parameters.length, 11)
  assert.deepEqual(insert.parameters.slice(1, 10), [
    BATCH_ID,
    '2026-06',
    '100.00000000',
    '109.50000000',
    '9.50000000',
    '100.00000000',
    '-9.50000000',
    1,
    0,
  ])
  assert.equal((insert.parameters[10] as Date).getTime(), completedAt.getTime())
  const terminal = fixture.find(/SET corrected_count = \?, failed_count = \?/) as Executed
  assert.deepEqual(terminal.parameters, [1, 0, 'completed', completedAt, BATCH_ID])
  assert.ok(fixture.executed.indexOf(terminal) > fixture.executed.indexOf(insert))
})

test('finalization leaves a batch running while any item is live', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_batch\s+WHERE id = \?\s+FOR UPDATE/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          request_digest: 'd'.repeat(64),
          status: 'running',
          submitted_count: 1,
          accepted_count: 1,
          rejected_count: 0,
          corrected_count: 0,
          failed_count: 0,
          rate_card_version_id: 'synthetic-rate-card',
          baseline_verified_total: '100.00000000',
          baseline_captured_at: new Date(0),
        },
      ],
    ],
    [
      /SUM\(state IN \('accepted','auditing'\)\)/,
      [{ live_count: 1, corrected_count: 0, failed_count: 0, completed_at: null }],
    ],
  ])
  const result = await finalizeLateRecordingBatch(fixture.pool, {
    batchId: BATCH_ID,
    billMonth: '2026-06',
    revisedVerifiedTotal: '100',
    actualPaidAmount: null,
    revisedVariance: null,
  })
  assert.equal(result.outcome, 'in_flight')
  assert.equal(
    fixture.find(/INSERT INTO kaudit_late_recording_month_correction/),
    undefined,
  )
  assert.equal(fixture.find(/status = \?/), undefined)
})

test('an identical finalization replays the immutable correction', async () => {
  const completedAt = new Date('2026-07-01T00:00:00.000Z')
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_batch\s+WHERE id = \?\s+FOR UPDATE/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          request_digest: 'd'.repeat(64),
          status: 'completed',
          submitted_count: 1,
          accepted_count: 1,
          rejected_count: 0,
          corrected_count: 1,
          failed_count: 0,
          rate_card_version_id: 'synthetic-rate-card',
          baseline_verified_total: '100.00000000',
          baseline_captured_at: new Date(0),
        },
      ],
    ],
    [
      /SUM\(state IN \('accepted','auditing'\)\)/,
      [{ live_count: 0, corrected_count: 1, failed_count: 0, completed_at: completedAt }],
    ],
    [
      /FROM kaudit_late_recording_month_correction\s+WHERE batch_id = \?\s+FOR UPDATE/,
      [
        {
          bill_month: '2026-06',
          currency: 'INR',
          previous_verified_total: '100.00000000',
          revised_verified_total: '109.50000000',
          delta_amount: '9.50000000',
          actual_paid_amount: '100.00000000',
          revised_variance: '-9.50000000',
          corrected_count: 1,
          failed_count: 0,
          completed_at: completedAt,
        },
      ],
    ],
  ])
  const result = await finalizeLateRecordingBatch(fixture.pool, {
    batchId: BATCH_ID,
    billMonth: '2026-06',
    revisedVerifiedTotal: '109.5',
    actualPaidAmount: '100',
    revisedVariance: '-9.5',
  })
  assert.equal(result.outcome, 'replayed')
  assert.equal(
    fixture.find(/INSERT INTO kaudit_late_recording_month_correction/),
    undefined,
  )
})

test('the month total counts live final calculations only', async () => {
  const fixture = fakePool([
    [/verified_total/, [{ verified_total: '1234.5' }]],
  ])
  const total = await readVerifiedMonthTotal(fixture.pool, PERIOD)
  assert.equal(total, '1234.50000000')
  const statement = fixture.find(/verified_total/) as Executed
  assert.match(statement.sql, /calculation\.status = 'final'/)
  assert.match(statement.sql, /supersedes_calculation_id = calculation\.id/)
  assert.deepEqual(statement.parameters, ['2026-06-01', '2026-06-30'])
})

test('an empty month is zero rather than absent', async () => {
  const fixture = fakePool([[/verified_total/, [{ verified_total: null }]]])
  assert.equal(await readVerifiedMonthTotal(fixture.pool, PERIOD), '0.00000000')
})

test('the progress read returns task references and money, never a URL or an id', async () => {
  const fixture = fakePool([
    [
      /FROM kaudit_late_recording_batch\s+WHERE id/,
      [
        {
          id: BATCH_ID,
          bill_month: '2026-06',
          request_digest: 'd'.repeat(64),
          status: 'completed',
          submitted_count: 3,
          accepted_count: 2,
          rejected_count: 1,
          corrected_count: 2,
          failed_count: 0,
        },
      ],
    ],
    [
      /FROM kaudit_late_recording_item\s+WHERE batch_id/,
      [
        {
          task_reference: 'T-SYNTH-1',
          row_number: 2,
          state: 'corrected',
          previous_amount: '0.00000000',
          revised_amount: '9.50000000',
          last_error_code: null,
          completed_at: new Date(0),
        },
      ],
    ],
    [
      /FROM kaudit_late_recording_month_correction/,
      [
        {
          previous_verified_total: '100',
          revised_verified_total: '109.5',
          delta_amount: '9.5',
        },
      ],
    ],
  ])
  const progress = await readLateRecordingBatchProgress(fixture.pool, BATCH_ID)
  assert.equal(progress?.completed, 1)
  assert.equal(progress?.finalized, true)
  assert.equal(progress?.totalAdjustment, '9.50000000')
  assert.equal(progress?.previousVerifiedTotal, '100.00000000')
  assert.equal(progress?.items[0]?.taskReference, 'T-SYNTH-1')
  const published = JSON.stringify(progress)
  assert.doesNotMatch(published, /https?:/)
  assert.doesNotMatch(published, /synthetic-call|synthetic-artifact|lri_/)
})

test('an unknown batch reports nothing rather than failing', async () => {
  const fixture = fakePool()
  assert.equal(
    await readLateRecordingBatchProgress(fixture.pool, BATCH_ID),
    null,
  )
})

test('recovery includes every batch that still lacks its immutable correction', async () => {
  const fixture = fakePool([
    [/FROM kaudit_late_recording_batch batch/, [{ id: BATCH_ID }]],
  ])
  assert.deepEqual(
    await listUnfinishedLateRecordingBatchIds(fixture.pool),
    [BATCH_ID],
  )
  const statement = fixture.find(/FROM kaudit_late_recording_batch batch/) as Executed
  assert.match(
    statement.sql,
    /NOT EXISTS \([\s\S]*kaudit_late_recording_month_correction/,
  )
  assert.doesNotMatch(statement.sql, /batch\.status IN/)
  assert.doesNotMatch(statement.sql, /item\.state IN/)
})
