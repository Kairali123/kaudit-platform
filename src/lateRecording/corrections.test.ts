import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  canonicalizeLateRecordingUrl,
  canonicalUrlSha256,
  fixed8,
  LateRecordingError,
  lateRecordingBatchDigest,
  lateRecordingCorrectionTotals,
  lateRecordingId,
  MAX_LATE_RECORDING_ROWS,
  parseLateRecordingCsv,
  parseLateRecordingSubmission,
  proposedFinanceAdjustment,
  safeLateRecordingFailureCode,
  sourceFileSha256,
  sumFixed8,
} from './corrections.ts'

/**
 * Every fixture in this file is SYNTHETIC. No real task id, recording, bucket,
 * amount, invoice, or secret appears here, and nothing in this suite opens a
 * connection or contacts a provider.
 */

const HOSTS = ['cdr-storage-recs.s3.ap-south-1.amazonaws.com']
const OBJECT_URL =
  'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/synthetic-a.ogg'

function csv(...lines: string[]): Buffer {
  return Buffer.from(
    ['Task ID,Recording URL', ...lines].join('\n'),
    'utf8',
  )
}

// ---------------------------------------------------------------------------
// The uploaded file
// ---------------------------------------------------------------------------

test('a two-column upload is read row by row, numbered as the sheet shows', () => {
  const parsed = parseLateRecordingCsv(
    csv(`T-SYNTH-1,${OBJECT_URL}`, `T-SYNTH-2,${OBJECT_URL}`),
  )
  assert.deepEqual(parsed.rejections, [])
  assert.deepEqual(
    parsed.rows.map((row) => [row.rowNumber, row.taskId]),
    [
      [2, 'T-SYNTH-1'],
      [3, 'T-SYNTH-2'],
    ],
  )
})

test('a bad row is a bounded rejection, never a failed file', () => {
  const parsed = parseLateRecordingCsv(
    csv(
      `,${OBJECT_URL}`,
      'T-SYNTH-1,',
      `T-SYNTH-2,${OBJECT_URL}`,
      `T-SYNTH-2,${OBJECT_URL}`,
    ),
  )
  assert.deepEqual(parsed.rejections, [
    { rowNumber: 2, code: 'TASK_ID_REQUIRED' },
    { rowNumber: 3, code: 'RECORDING_URL_REQUIRED' },
    { rowNumber: 5, code: 'TASK_ID_DUPLICATE' },
  ])
  // The first occurrence of a repeated task stays valid.
  assert.deepEqual(
    parsed.rows.map((row) => row.taskId),
    ['T-SYNTH-2'],
  )
})

test('missing columns, an empty file, and an oversized batch are refused whole', () => {
  assert.throws(
    () => parseLateRecordingCsv(Buffer.from('Task ID\nT-SYNTH-1', 'utf8')),
    (error: LateRecordingError) =>
      error.code === 'LATE_RECORDING_CSV_HEADERS_INVALID',
  )
  assert.throws(
    () => parseLateRecordingCsv(csv()),
    (error: LateRecordingError) => error.code === 'LATE_RECORDING_CSV_EMPTY',
  )
  const tooMany = csv(
    ...Array.from(
      { length: MAX_LATE_RECORDING_ROWS + 1 },
      (_value, index) => `T-SYNTH-${index},${OBJECT_URL}`,
    ),
  )
  assert.throws(
    () => parseLateRecordingCsv(tooMany),
    (error: LateRecordingError) =>
      error.code === 'LATE_RECORDING_BATCH_TOO_LARGE',
  )
})

test('exactly the bounded batch size is accepted', () => {
  const parsed = parseLateRecordingCsv(
    csv(
      ...Array.from(
        { length: MAX_LATE_RECORDING_ROWS },
        (_value, index) => `T-SYNTH-${index},${OBJECT_URL}`,
      ),
    ),
  )
  assert.equal(parsed.rows.length, MAX_LATE_RECORDING_ROWS)
})

// ---------------------------------------------------------------------------
// URL canonicalization and privacy
// ---------------------------------------------------------------------------

test('a signed URL is stored as the stable object URL with the signing query gone', () => {
  const signed = `${OBJECT_URL}?X-Amz-Algorithm=SYNTHETIC&X-Amz-Signature=deadbeef`
  const result = canonicalizeLateRecordingUrl(signed, HOSTS)
  assert.deepEqual(result, { canonicalUrl: OBJECT_URL })
})

test('a proxy-wrapped URL is unwrapped to the same canonical object URL', () => {
  const wrapped = `https://proxy.invalid/fetch?url=${encodeURIComponent(
    `${OBJECT_URL}?X-Amz-Signature=deadbeef`,
  )}`
  const result = canonicalizeLateRecordingUrl(wrapped, HOSTS)
  assert.deepEqual(result, { canonicalUrl: OBJECT_URL })
})

test('signed, wrapped and plain forms of one recording are ONE identity', () => {
  const forms = [
    OBJECT_URL,
    `${OBJECT_URL}?X-Amz-Signature=aaa`,
    `https://proxy.invalid/fetch?url=${encodeURIComponent(OBJECT_URL)}`,
  ]
  const hashes = new Set(
    forms.map((form) => {
      const result = canonicalizeLateRecordingUrl(form, HOSTS)
      assert.ok('canonicalUrl' in result)
      return canonicalUrlSha256(result.canonicalUrl)
    }),
  )
  // A re-uploaded spreadsheet with a fresh signature is a REPLAY, not a
  // conflict, and this is the property that makes that true.
  assert.equal(hashes.size, 1)
})

test('a non-HTTPS, unknown-host, or unreadable URL is its own bounded code', () => {
  assert.deepEqual(
    canonicalizeLateRecordingUrl(
      'http://cdr-storage-recs.s3.ap-south-1.amazonaws.com/a.ogg',
      HOSTS,
    ),
    { code: 'URL_NOT_HTTPS' },
  )
  assert.deepEqual(
    canonicalizeLateRecordingUrl('https://elsewhere.invalid/a.ogg', HOSTS),
    { code: 'URL_NOT_ALLOWLISTED' },
  )
  assert.deepEqual(canonicalizeLateRecordingUrl('not a url', HOSTS), {
    code: 'URL_UNPARSEABLE',
  })
  // An empty allowlist refuses everything rather than trusting anything.
  assert.deepEqual(canonicalizeLateRecordingUrl(OBJECT_URL, []), {
    code: 'URL_NOT_ALLOWLISTED',
  })
})

test('nothing this module returns contains a URL', () => {
  const digest = lateRecordingBatchDigest({
    billMonth: '2026-06',
    items: [
      { taskId: 'T-SYNTH-1', canonicalUrlSha256: canonicalUrlSha256(OBJECT_URL) },
    ],
  })
  const published = JSON.stringify({
    digest,
    hash: canonicalUrlSha256(OBJECT_URL),
    fileHash: sourceFileSha256(csv(`T-SYNTH-1,${OBJECT_URL}`)),
    id: lateRecordingId('lrb'),
    failure: safeLateRecordingFailureCode('https://leak.invalid/a.ogg'),
  })
  assert.doesNotMatch(published, /https?:/)
  assert.doesNotMatch(published, /amazonaws/)
  assert.match(digest, /^[a-f0-9]{64}$/)
})

// ---------------------------------------------------------------------------
// Identity and retry safety
// ---------------------------------------------------------------------------

test('a reordered resubmission is the same batch; a changed one is not', () => {
  const a = { taskId: 'T-SYNTH-1', canonicalUrlSha256: 'a'.repeat(64) }
  const b = { taskId: 'T-SYNTH-2', canonicalUrlSha256: 'b'.repeat(64) }
  assert.equal(
    lateRecordingBatchDigest({ billMonth: '2026-06', items: [a, b] }),
    lateRecordingBatchDigest({ billMonth: '2026-06', items: [b, a] }),
  )
  assert.notEqual(
    lateRecordingBatchDigest({ billMonth: '2026-06', items: [a, b] }),
    lateRecordingBatchDigest({ billMonth: '2026-06', items: [a] }),
  )
  // Re-pointing one task at a different recording is a different batch.
  assert.notEqual(
    lateRecordingBatchDigest({ billMonth: '2026-06', items: [a, b] }),
    lateRecordingBatchDigest({
      billMonth: '2026-06',
      items: [a, { ...b, canonicalUrlSha256: 'c'.repeat(64) }],
    }),
  )
  // And the same selection against a different month is a different batch.
  assert.notEqual(
    lateRecordingBatchDigest({ billMonth: '2026-06', items: [a, b] }),
    lateRecordingBatchDigest({ billMonth: '2026-07', items: [a, b] }),
  )
})

test('a submission needs a real month and a bounded retry key', () => {
  assert.deepEqual(
    parseLateRecordingSubmission({
      month: ' 2026-06 ',
      idempotencyKey: 'lr-0123456789abcdef',
    }),
    { billMonth: '2026-06', idempotencyKey: 'lr-0123456789abcdef' },
  )
  for (const invalid of [
    { month: '2026-13', idempotencyKey: 'lr-0123456789abcdef' },
    { month: '2026-6', idempotencyKey: 'lr-0123456789abcdef' },
    { month: undefined, idempotencyKey: 'lr-0123456789abcdef' },
    { month: '2026-06', idempotencyKey: 'short' },
    { month: '2026-06', idempotencyKey: 'has spaces in it here' },
  ]) {
    assert.throws(
      () => parseLateRecordingSubmission(invalid),
      LateRecordingError,
    )
  }
})

test('a failure code is bounded, and anything else becomes one fixed code', () => {
  assert.equal(
    safeLateRecordingFailureCode('LATE_RECORDING_EVIDENCE_MANIFEST_MISSING'),
    'LATE_RECORDING_EVIDENCE_MANIFEST_MISSING',
  )
  for (const unsafe of [
    'select * from kaudit_call',
    `fetch failed for ${OBJECT_URL}`,
    null,
    42,
  ]) {
    assert.equal(
      safeLateRecordingFailureCode(unsafe),
      'LATE_RECORDING_ITEM_FAILED',
    )
  }
})

// ---------------------------------------------------------------------------
// Fixed-precision money
// ---------------------------------------------------------------------------

test('correction totals are scale-8 and never pass through a float', () => {
  const totals = lateRecordingCorrectionTotals({
    previousVerifiedTotal: '0',
    revisedVerifiedTotal: '9.50000001',
    correctedCount: 1,
  })
  assert.deepEqual(totals, {
    previousVerifiedTotal: '0.00000000',
    revisedVerifiedTotal: '9.50000001',
    deltaAmount: '9.50000001',
    correctedCount: 1,
  })
})

test('a delta that reduces the bill keeps its sign', () => {
  const totals = lateRecordingCorrectionTotals({
    previousVerifiedTotal: '100.00000000',
    revisedVerifiedTotal: '90.50000000',
    correctedCount: 2,
  })
  assert.equal(totals.deltaAmount, '-9.50000000')
})

test('the eighth decimal place survives a large month total', () => {
  // A float would lose this; scaled BigInt arithmetic does not.
  const totals = lateRecordingCorrectionTotals({
    previousVerifiedTotal: '123456789.00000000',
    revisedVerifiedTotal: '123456789.00000001',
    correctedCount: 1,
  })
  assert.equal(totals.deltaAmount, '0.00000001')
})

test('summing amounts is exact at scale 8', () => {
  assert.equal(
    sumFixed8(['0.10000000', '0.20000000', '0.00000001']),
    '0.30000001',
  )
  assert.equal(sumFixed8([]), '0.00000000')
  assert.equal(fixed8('9.5'), '9.50000000')
  assert.throws(() => fixed8('nine point five'), TypeError)
  assert.throws(
    () =>
      lateRecordingCorrectionTotals({
        previousVerifiedTotal: '0',
        revisedVerifiedTotal: '1',
        correctedCount: -1,
      }),
    TypeError,
  )
})

test('the finance adjustment is proposed, never applied', () => {
  const proposal = proposedFinanceAdjustment({
    previousVerifiedTotal: '100.00000000',
    revisedVerifiedTotal: '140.00000000',
    actualPaidAmount: '150.00000000',
  })
  assert.deepEqual(proposal, {
    deltaAmount: '40.00000000',
    // Variance keeps the platform's orientation: paid minus payable.
    revisedVariance: '10.00000000',
    settlementAction: 'proposed_finance_adjustment',
  })
})

test('with nothing recorded as paid, the variance is unknown and never zero', () => {
  const proposal = proposedFinanceAdjustment({
    previousVerifiedTotal: '100.00000000',
    revisedVerifiedTotal: '140.00000000',
    actualPaidAmount: null,
  })
  assert.equal(proposal.revisedVariance, null)
  assert.equal(proposal.settlementAction, 'no_settlement_recorded')
})
