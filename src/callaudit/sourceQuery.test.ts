import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CallAuditSourceQueryError,
  MAX_SOURCE_BATCH_SIZE,
  nextSourceCandidateCursor,
  validateSourceCandidateQuery,
  type SourceCandidateCursor,
} from './sourceQuery.ts'
import {
  CALL_AUDIT_SOURCE_TABLE,
  type InternalSourceCandidate,
} from './sourceTypes.ts'

/**
 * Boundaries are UTC-naive source values. Scheduling is what converts an
 * Asia/Kolkata calendar period into these; this module never does.
 */
const VALID = {
  periodStart: '2026-08-01 00:00:00',
  periodEndExclusive: '2026-09-01 00:00:00',
  batchSize: 100,
}

test('accepts a well-formed half-open period', () => {
  const validated = validateSourceCandidateQuery(VALID)
  assert.equal(validated.periodStart, '2026-08-01 00:00:00.000000')
  assert.equal(validated.periodEndExclusive, '2026-09-01 00:00:00.000000')
  assert.equal(validated.batchSize, 100)
  assert.equal(validated.cursor, null)
})

test('normalizes the T separator and fractional seconds', () => {
  const validated = validateSourceCandidateQuery({
    ...VALID,
    periodStart: '2026-08-01T00:00:00.5',
  })
  assert.equal(validated.periodStart, '2026-08-01 00:00:00.500000')
})

test('rejects a period that is empty or inverted', () => {
  assert.throws(
    () =>
      validateSourceCandidateQuery({
        ...VALID,
        periodEndExclusive: VALID.periodStart,
      }),
    CallAuditSourceQueryError,
  )
  assert.throws(
    () =>
      validateSourceCandidateQuery({
        ...VALID,
        periodStart: '2026-09-01 00:00:00',
        periodEndExclusive: '2026-08-01 00:00:00',
      }),
    CallAuditSourceQueryError,
  )
})

// ---------------------------------------------------------------------------
// Timezone semantics
// ---------------------------------------------------------------------------

test('rejects a boundary carrying a timezone rather than converting it', () => {
  // An IST wall-clock string is NOT a source boundary: the source stores
  // UTC-naive values, so accepting these would silently shift the period.
  for (const periodStart of [
    '2026-08-01T00:00:00Z',
    '2026-08-01T00:00:00+05:30',
    '2026-08-01 00:00:00 IST',
    '2026-08-01T00:00:00-08:00',
    '2026-08-01',
    '01-08-2026 00:00:00',
    'now',
    '',
    '   ',
  ]) {
    assert.throws(
      () => validateSourceCandidateQuery({ ...VALID, periodStart }),
      CallAuditSourceQueryError,
      `${periodStart} must be rejected`,
    )
  }
})

test('rejects a non-string boundary', () => {
  for (const periodStart of [null, undefined, 20260801, {}, []]) {
    assert.throws(
      () =>
        validateSourceCandidateQuery({
          ...VALID,
          periodStart: periodStart as unknown as string,
        }),
      CallAuditSourceQueryError,
    )
  }
})

// ---------------------------------------------------------------------------
// Strict Gregorian validation
// ---------------------------------------------------------------------------

test('rejects an impossible date instead of rolling it forward', () => {
  // Date.parse would turn 2026-02-30 into 2 March and silently audit the
  // wrong period, so every component is checked explicitly.
  for (const periodStart of [
    '2026-02-30 00:00:00',
    '2026-02-29 00:00:00',
    '2026-04-31 00:00:00',
    '2026-06-31 00:00:00',
    '2026-09-31 00:00:00',
    '2026-11-31 00:00:00',
    '2026-13-01 00:00:00',
    '2026-00-01 00:00:00',
    '2026-01-32 00:00:00',
    '2026-01-00 00:00:00',
  ]) {
    assert.throws(
      () => validateSourceCandidateQuery({ ...VALID, periodStart }),
      CallAuditSourceQueryError,
      `${periodStart} must be rejected`,
    )
  }
})

test('rejects an impossible time of day', () => {
  for (const periodStart of [
    '2026-08-01 24:00:00',
    '2026-08-01 25:00:00',
    '2026-08-01 00:60:00',
    '2026-08-01 00:00:60',
    '2026-08-01 99:99:99',
  ]) {
    assert.throws(
      () => validateSourceCandidateQuery({ ...VALID, periodStart }),
      CallAuditSourceQueryError,
      `${periodStart} must be rejected`,
    )
  }
})

test('accepts the leap day in a leap year', () => {
  const validated = validateSourceCandidateQuery({
    periodStart: '2024-02-29 00:00:00',
    periodEndExclusive: '2024-03-01 00:00:00',
    batchSize: 10,
  })
  assert.equal(validated.periodStart, '2024-02-29 00:00:00.000000')

  // Century rule: 2000 is a leap year, 1900 and 2100 are not.
  assert.equal(
    validateSourceCandidateQuery({
      ...VALID,
      periodStart: '2000-02-29 00:00:00',
      periodEndExclusive: '2000-03-01 00:00:00',
    }).periodStart,
    '2000-02-29 00:00:00.000000',
  )
  for (const periodStart of ['1900-02-29 00:00:00', '2100-02-29 00:00:00']) {
    assert.throws(
      () =>
        validateSourceCandidateQuery({
          ...VALID,
          periodStart,
          periodEndExclusive: '2200-01-01 00:00:00',
        }),
      CallAuditSourceQueryError,
      `${periodStart} must be rejected`,
    )
  }
})

test('accepts the boundary values of each time component', () => {
  const validated = validateSourceCandidateQuery({
    periodStart: '2026-01-01 00:00:00',
    periodEndExclusive: '2026-12-31 23:59:59.999999',
    batchSize: 1,
  })
  assert.equal(validated.periodEndExclusive, '2026-12-31 23:59:59.999999')
})

test('accepts one to six fractional digits and rejects seven', () => {
  for (const fraction of ['1', '12', '123', '1234', '12345', '123456']) {
    const validated = validateSourceCandidateQuery({
      ...VALID,
      periodStart: `2026-08-01 00:00:00.${fraction}`,
    })
    assert.equal(validated.periodStart.length, '2026-08-01 00:00:00.000000'.length)
  }
  assert.throws(
    () =>
      validateSourceCandidateQuery({
        ...VALID,
        periodStart: '2026-08-01 00:00:00.1234567',
      }),
    CallAuditSourceQueryError,
  )
})

// ---------------------------------------------------------------------------
// Batch size
// ---------------------------------------------------------------------------

test('bounds the batch size', () => {
  assert.equal(
    validateSourceCandidateQuery({ ...VALID, batchSize: 1 }).batchSize,
    1,
  )
  assert.equal(
    validateSourceCandidateQuery({
      ...VALID,
      batchSize: MAX_SOURCE_BATCH_SIZE,
    }).batchSize,
    MAX_SOURCE_BATCH_SIZE,
  )
  for (const batchSize of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    MAX_SOURCE_BATCH_SIZE + 1,
    '100' as unknown as number,
    null as unknown as number,
  ]) {
    assert.throws(
      () => validateSourceCandidateQuery({ ...VALID, batchSize }),
      CallAuditSourceQueryError,
      `${batchSize} must be rejected`,
    )
  }
})

// ---------------------------------------------------------------------------
// Keyset cursor
// ---------------------------------------------------------------------------

test('validates the keyset cursor', () => {
  const validated = validateSourceCandidateQuery({
    ...VALID,
    cursor: { effectiveCallTime: '2026-08-15 10:00:00', sourceRowId: '42' },
  })
  assert.deepEqual(validated.cursor, {
    effectiveCallTime: '2026-08-15 10:00:00.000000',
    sourceRowId: '42',
  })
})

test('the cursor row id keeps full BIGINT precision', () => {
  const validated = validateSourceCandidateQuery({
    ...VALID,
    cursor: {
      effectiveCallTime: '2026-08-15 10:00:00',
      sourceRowId: '9007199254740993',
    },
  })
  assert.equal(validated.cursor?.sourceRowId, '9007199254740993')

  const maximum = validateSourceCandidateQuery({
    ...VALID,
    cursor: {
      effectiveCallTime: '2026-08-15 10:00:00',
      sourceRowId: '9223372036854775807',
    },
  })
  assert.equal(maximum.cursor?.sourceRowId, '9223372036854775807')
})

test('rejects a malformed or out-of-range cursor row id', () => {
  for (const sourceRowId of [
    '0',
    '-1',
    '+1',
    '1.5',
    '007',
    '',
    '  ',
    'abc',
    '9223372036854775808',
    '99999999999999999999',
    0 as unknown as string,
    -1 as unknown as string,
    1.5 as unknown as string,
    Number.NaN as unknown as string,
    null as unknown as string,
  ]) {
    assert.throws(
      () =>
        validateSourceCandidateQuery({
          ...VALID,
          cursor: {
            effectiveCallTime: '2026-08-15 10:00:00',
            sourceRowId,
          },
        }),
      CallAuditSourceQueryError,
      `${String(sourceRowId)} must be rejected`,
    )
  }
})

test('rejects a cursor whose time is invalid', () => {
  for (const effectiveCallTime of [
    'nonsense',
    '2026-08-15 10:00:00Z',
    '2026-02-30 10:00:00',
    '2026-08-15 24:00:00',
  ]) {
    assert.throws(
      () =>
        validateSourceCandidateQuery({
          ...VALID,
          cursor: { effectiveCallTime, sourceRowId: '42' },
        }),
      CallAuditSourceQueryError,
      `${effectiveCallTime} must be rejected`,
    )
  }
})

test('rejects a cursor outside the half-open period', () => {
  // Before the start would re-scan rows already audited; at or after the end
  // would page past the period entirely.
  for (const effectiveCallTime of [
    '2026-07-31 23:59:59.999999',
    '2026-07-01 00:00:00',
    '2026-09-01 00:00:00',
    '2026-09-02 00:00:00',
  ]) {
    assert.throws(
      () =>
        validateSourceCandidateQuery({
          ...VALID,
          cursor: { effectiveCallTime, sourceRowId: '42' },
        }),
      CallAuditSourceQueryError,
      `${effectiveCallTime} must be rejected`,
    )
  }
})

test('accepts a cursor at the inclusive start of the period', () => {
  const validated = validateSourceCandidateQuery({
    ...VALID,
    cursor: { effectiveCallTime: VALID.periodStart, sourceRowId: '42' },
  })
  assert.equal(validated.cursor?.effectiveCallTime, '2026-08-01 00:00:00.000000')
})

test('treats an absent cursor as the first page', () => {
  assert.equal(validateSourceCandidateQuery(VALID).cursor, null)
  assert.equal(
    validateSourceCandidateQuery({ ...VALID, cursor: null }).cursor,
    null,
  )
  assert.equal(
    validateSourceCandidateQuery({ ...VALID, cursor: undefined }).cursor,
    null,
  )
})

// ---------------------------------------------------------------------------
// Cursor production
// ---------------------------------------------------------------------------

function candidate(
  sourceRowId: string,
  effectiveCallTime: string,
): InternalSourceCandidate {
  return {
    sourceTable: CALL_AUDIT_SOURCE_TABLE,
    sourceRowId,
    leadId: null,
    transcript: null,
    effectiveCallTime,
    sourceUpdatedAt: null,
    callStartedAt: null,
    callEndedAt: null,
    callDurationSec: null,
    company_by_kserve: null,
    company: null,
    data_source: null,
    verified_source: null,
    service_category: null,
    call_type: null,
    call_status: null,
    call_end_reason: null,
    final_call_status: null,
    ai_call_category: null,
    customer_engagement_level: null,
    interest_level: null,
    call_outcome: null,
    lead_status: null,
    final_lead_outcome: null,
    calculated_qualification_status: null,
    followup_required: null,
  }
}

test('the next cursor comes from the last row of the page', () => {
  const cursor = nextSourceCandidateCursor([
    candidate('1', '2026-08-01 09:00:00.000000'),
    candidate('9007199254740993', '2026-08-01 09:30:00.000000'),
  ])
  assert.deepEqual(cursor, {
    effectiveCallTime: '2026-08-01 09:30:00.000000',
    sourceRowId: '9007199254740993',
  })
})

test('an exhausted page yields no cursor', () => {
  assert.equal(nextSourceCandidateCursor([]), null)
})

test('a produced cursor is accepted back as input', () => {
  const cursor = nextSourceCandidateCursor([
    candidate('9007199254740993', '2026-08-01 09:30:00.000000'),
  ]) as SourceCandidateCursor
  assert.notEqual(cursor, null)
  const validated = validateSourceCandidateQuery({ ...VALID, cursor })
  assert.deepEqual(validated.cursor, cursor)
})
