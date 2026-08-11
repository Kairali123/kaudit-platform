import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  buildContentAuditResult,
  buildFailedResult,
  buildMetricScoreId,
  buildOperationalOnlyResult,
  buildResultId,
  buildResultIdempotencyKey,
  buildUsageEventId,
  buildUsageEventRecord,
  CallAuditRecordError,
  compareKserveOutcome,
  CONFIDENCE_DECIMALS,
  MAX_ATTEMPT_NUMBER,
  MAX_ERROR_CODE_LENGTH,
  MAX_ID_LENGTH,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_REQUEST_ID_LENGTH,
  MAX_SIGNED_BIGINT,
  normalizeConfidence,
  RESULT_DOCUMENT_VERSION,
  type CallAuditResultIdentity,
  type FailedResultInput,
} from './resultRecords.ts'
import { validateContentAuditOutput } from './modelOutput.ts'
import { CALL_AUDIT_RUBRIC } from './rubric.ts'
import { OVERALL_SCORE_METHOD } from './overallScore.ts'
import {
  groupForDetailedOutcome,
  isNoContactOutcome,
  NO_CONTACT_OUTCOMES,
} from './outcomes.ts'

import type { MetricScore } from './types.ts'

/** The two compliance-sensitive vendor labels, spelled exactly. */
const OUTREACH_STOPPED = 'Outreach Stopped' as const
const DNC_OUTCOME = "DNC Client : Don't Call Furthur" as const

const IDENTITY: CallAuditResultIdentity = {
  runId: 'run-0001',
  sourceRefId: 'src-0001',
  ruleVersionId: 'rule-0001',
}

const AUDITED_AT = '2026-08-01 09:20:00.000000'

function expectRecordError(
  run: () => unknown,
  message?: string,
): CallAuditRecordError {
  try {
    run()
  } catch (error) {
    assert.ok(
      error instanceof CallAuditRecordError,
      message ?? 'expected a CallAuditRecordError',
    )
    return error as CallAuditRecordError
  }
  assert.fail(message ?? 'expected a CallAuditRecordError to be thrown')
}

function scores(
  fill: MetricScore,
  overrides: Record<string, MetricScore> = {},
): Array<{ metric: string; score: MetricScore }> {
  return CALL_AUDIT_RUBRIC.map((metric) => ({
    metric: metric.code,
    score: Object.hasOwn(overrides, metric.code)
      ? overrides[metric.code]
      : fill,
  }))
}

/** Synthetic model output only — never real customer data. */
function modelOutput(overrides: Record<string, unknown> = {}) {
  return validateContentAuditOutput(
    {
      callConnected: true,
      customerSpoke: true,
      meaningfulConversation: true,
      intent: 'WARM',
      detailedOutcome: 'Individual Resort Booking',
      qualification: 'QUALIFIED',
      nextAction: 'SCHEDULE_BOOKING',
      confidence: 0.82,
      metricScores: scores(4),
      issueFlags: ['WEAK_NEXT_STEP'],
      managementSummary: 'Caller asked about a resort stay.',
      kserveFeedback: 'Agent did not confirm the travel window.',
      improvementFeedback: 'Confirm dates before closing.',
      ...overrides,
    },
    { eligibility: 'content_auditable' },
  )
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// Deterministic identity and idempotency
// ---------------------------------------------------------------------------

test('a result id is deterministic, prefixed, and within varchar(40)', () => {
  const id = buildResultId(IDENTITY)
  assert.equal(id, buildResultId({ ...IDENTITY }))
  assert.ok(id.startsWith('car_'))
  assert.equal(id.length, MAX_ID_LENGTH)
  assert.match(id, /^car_[0-9a-f]{36}$/)
})

test('the idempotency key is the exact identity tuple, within varchar(191)', () => {
  const key = buildResultIdempotencyKey(IDENTITY)
  assert.equal(key, buildResultIdempotencyKey({ ...IDENTITY }))
  assert.ok(key.startsWith('call-audit-result:'))
  assert.ok(key.length <= MAX_IDEMPOTENCY_KEY_LENGTH)
  assert.match(key, /^call-audit-result:[0-9a-f]{64}$/)
})

test('any change to the identity tuple changes the id and key', () => {
  const baseline = buildResultId(IDENTITY)
  const baselineKey = buildResultIdempotencyKey(IDENTITY)
  for (const override of [
    { runId: 'run-0002' },
    { sourceRefId: 'src-0002' },
    { ruleVersionId: 'rule-0002' },
  ]) {
    const changed = { ...IDENTITY, ...override }
    assert.notEqual(buildResultId(changed), baseline)
    assert.notEqual(buildResultIdempotencyKey(changed), baselineKey)
  }
})

test('metric ids are distinct per metric and stable per input', () => {
  const ids = CALL_AUDIT_RUBRIC.map((metric) =>
    buildMetricScoreId(IDENTITY, metric.code),
  )
  assert.equal(new Set(ids).size, CALL_AUDIT_RUBRIC.length)
  for (const id of ids) {
    assert.match(id, /^cam_[0-9a-f]{36}$/)
    assert.equal(id.length, MAX_ID_LENGTH)
  }
  assert.equal(
    buildMetricScoreId(IDENTITY, 'PROFESSIONALISM'),
    buildMetricScoreId({ ...IDENTITY }, 'PROFESSIONALISM'),
  )
})

test('usage ids are distinct per attempt number and stable per input', () => {
  const ids = [1, 2, 3, 10, 99].map((attempt) =>
    buildUsageEventId(IDENTITY, attempt),
  )
  assert.equal(new Set(ids).size, 5)
  for (const id of ids) {
    assert.match(id, /^cau_[0-9a-f]{36}$/)
    assert.equal(id.length, MAX_ID_LENGTH)
  }
  assert.equal(buildUsageEventId(IDENTITY, 2), buildUsageEventId(IDENTITY, 2))
})

test('result, metric, and usage ids never collide with each other', () => {
  const all = [
    buildResultId(IDENTITY),
    ...CALL_AUDIT_RUBRIC.map((m) => buildMetricScoreId(IDENTITY, m.code)),
    ...[1, 2, 3].map((n) => buildUsageEventId(IDENTITY, n)),
  ]
  assert.equal(new Set(all).size, all.length)
})

test('identifiers are validated and errors echo no submitted value', () => {
  const secret = 'Saanvi: hello Ms Synthetic, is 9876543210 still your number?'
  for (const override of [
    { runId: '' },
    { runId: '   ' },
    { runId: secret.repeat(2) },
    { sourceRefId: 42 as unknown as string },
    { ruleVersionId: null as unknown as string },
    { runId: 'run\u0000id' },
  ]) {
    const error = expectRecordError(() =>
      buildContentAuditResult({
        identity: { ...IDENTITY, ...override },
        output: modelOutput(),
        auditedAt: AUDITED_AT,
      }),
    )
    assert.equal(error.code, 'INVALID_CALL_AUDIT_RECORD')
    const text = `${error.message}\n${error.stack ?? ''}`
    assert.equal(text.includes('Saanvi'), false)
    assert.equal(text.includes('9876543210'), false)
  }
})

// ---------------------------------------------------------------------------
// Succeeded content result
// ---------------------------------------------------------------------------

test('a content result maps every persisted column', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.processingStatus, 'succeeded')
  assert.equal(result.eligibility, 'content_auditable')
  assert.equal(result.ineligibilityReason, null)
  assert.equal(result.callConnected, true)
  assert.equal(result.customerSpoke, true)
  assert.equal(result.meaningfulConversation, true)
  assert.equal(result.intent, 'WARM')
  assert.equal(result.detailedOutcome, 'Individual Resort Booking')
  assert.equal(result.groupedOutcome, 'RESORT_HEALING')
  assert.equal(result.qualificationLabel, 'QUALIFIED')
  assert.equal(result.nextActionCode, 'SCHEDULE_BOOKING')
  assert.equal(result.overallScore, '80.000')
  assert.equal(result.overallScoreMethod, OVERALL_SCORE_METHOD)
  assert.equal(result.errorCode, null)
  assert.equal(result.errorDetail, null)
  assert.equal(result.auditedAt, AUDITED_AT)
  assert.equal(result.runId, IDENTITY.runId)
  assert.equal(result.sourceRefId, IDENTITY.sourceRefId)
  assert.equal(result.ruleVersionId, IDENTITY.ruleVersionId)
})

test('the grouped outcome is the application-derived one', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({ detailedOutcome: 'Duplicate Lead' }),
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.detailedOutcome, 'Duplicate Lead')
  assert.equal(result.groupedOutcome, 'EXISTING_DUPLICATE_DNC')
  assert.equal(
    result.groupedOutcome,
    groupForDetailedOutcome('Duplicate Lead'),
  )
})

test('the record carries no forbidden content field', () => {
  const { result, metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  for (const forbidden of [
    'transcript',
    'transcription',
    'leadId',
    'lead_id',
    'taskId',
    'task_id',
    'clientName',
    'mobile',
    'phone',
    'email',
    'url',
    'recordingUrl',
    'prompt',
    'systemPrompt',
    'rawResponse',
    'refusalText',
    'errorMessage',
    'errorPayload',
    'cost',
    'amount',
    'price',
    'currency',
    'createdAt',
    'updatedAt',
  ]) {
    assert.equal(
      forbidden in result,
      false,
      `the result record must not carry ${forbidden}`,
    )
  }
  for (const record of metricScores) {
    for (const forbidden of ['rationale', 'confidence', 'createdAt']) {
      assert.equal(forbidden in record, false)
    }
  }
})

test('issue flags are canonical JSON of approved codes only', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({
      issueFlags: ['WEAK_NEXT_STEP', 'DNC_RISK', 'WEAK_DISCOVERY'],
    }),
    auditedAt: AUDITED_AT,
  })
  // Sorted, so an equivalent set always canonicalizes identically.
  assert.equal(
    result.issueFlagsJson,
    '["DNC_RISK","WEAK_DISCOVERY","WEAK_NEXT_STEP"]',
  )
  const parsed = JSON.parse(result.issueFlagsJson as string) as string[]
  for (const flag of parsed) {
    assert.match(flag, /^[A-Z][A-Z_]*$/)
  }
})

test('an empty flag set persists as an empty canonical array', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({ issueFlags: [] }),
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.issueFlagsJson, '[]')
})

// ---------------------------------------------------------------------------
// Metric rows
// ---------------------------------------------------------------------------

test('exactly eight metric rows are returned in canonical rubric order', () => {
  const { result, metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  assert.equal(metricScores.length, 8)
  assert.deepEqual(
    metricScores.map((entry) => entry.metricCode),
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
  )
  for (const record of metricScores) {
    assert.equal(record.resultId, result.id)
  }
})

test('canonical order holds even when the caller supplies another order', () => {
  const shuffled = validateContentAuditOutput(
    {
      callConnected: true,
      customerSpoke: true,
      meaningfulConversation: true,
      intent: 'LOW',
      detailedOutcome: 'Junk',
      qualification: 'NON_QUALIFIED',
      nextAction: 'NONE',
      confidence: 0.4,
      metricScores: scores(3).reverse(),
      issueFlags: [],
      managementSummary: 'x',
      kserveFeedback: 'y',
      improvementFeedback: 'z',
    },
    { eligibility: 'content_auditable' },
  )
  const { metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: shuffled,
    auditedAt: AUDITED_AT,
  })
  assert.deepEqual(
    metricScores.map((entry) => entry.metricCode),
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
  )
})

test('a numeric score maps to score_value with the NA flag false', () => {
  const { metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({ metricScores: scores(5) }),
    auditedAt: AUDITED_AT,
  })
  for (const record of metricScores) {
    assert.equal(record.scoreValue, 5)
    assert.equal(record.isNotApplicable, false)
  }
})

test('NA maps to a null score value and never to zero', () => {
  const { metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({
      metricScores: scores(4, { PRODUCT_SERVICE_KNOWLEDGE: 'NA' }),
    }),
    auditedAt: AUDITED_AT,
  })
  const na = metricScores.find(
    (entry) => entry.metricCode === 'PRODUCT_SERVICE_KNOWLEDGE',
  )
  assert.equal(na?.scoreValue, null)
  assert.notEqual(na?.scoreValue, 0)
  assert.equal(na?.isNotApplicable, true)
  for (const record of metricScores) {
    if (record.metricCode === 'PRODUCT_SERVICE_KNOWLEDGE') continue
    assert.equal(record.isNotApplicable, false)
    assert.equal(record.scoreValue, 4)
  }
})

test('an all-NA silent call has no score and therefore no method', () => {
  const silent = validateContentAuditOutput(
    {
      callConnected: true,
      customerSpoke: false,
      meaningfulConversation: false,
      intent: 'NONE',
      detailedOutcome: 'No Answer',
      qualification: 'NOT_APPLICABLE',
      nextAction: 'CALLBACK',
      confidence: 0.9,
      metricScores: scores('NA'),
      issueFlags: ['NO_CUSTOMER_SPEECH'],
      managementSummary: 'No customer speech was present.',
      kserveFeedback: '',
      improvementFeedback: '',
    },
    { eligibility: 'content_auditable' },
  )
  const { result, metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: silent,
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.overallScore, null)
  assert.equal(result.overallScoreMethod, null)
  assert.equal(result.customerSpoke, false)
  assert.equal(result.intent, 'NONE')
  assert.equal(metricScores.length, 8)
  for (const record of metricScores) {
    assert.equal(record.isNotApplicable, true)
    assert.equal(record.scoreValue, null)
  }
})

// ---------------------------------------------------------------------------
// Confidence
// ---------------------------------------------------------------------------

test('confidence normalizes to exactly eight decimal places', () => {
  assert.equal(CONFIDENCE_DECIMALS, 8)
  const cases: Array<[number, string]> = [
    [0, '0.00000000'],
    [1, '1.00000000'],
    [0.5, '0.50000000'],
    [0.82, '0.82000000'],
    [0.123456789, '0.12345679'],
    [0.00000001, '0.00000001'],
    [0.999999995, '1.00000000'],
  ]
  for (const [value, expected] of cases) {
    assert.equal(normalizeConfidence(value), expected, `${value}`)
    assert.match(normalizeConfidence(value), /^[01]\.\d{8}$/)
  }
})

test('the persisted confidence comes from the validated output', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput({ confidence: 0.075 }),
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.intentConfidence, '0.07500000')
})

test('confidence rejects non-finite and out-of-range values', () => {
  for (const value of [
    -0.0001,
    1.0001,
    2,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '0.5',
    null,
    undefined,
  ]) {
    const error = expectRecordError(
      () => normalizeConfidence(value),
      `${String(value)} must be rejected`,
    )
    assert.equal(error.field, 'confidence')
  }
})

// ---------------------------------------------------------------------------
// KServe outcome comparison
// ---------------------------------------------------------------------------

test('an exactly equal approved label is a match with no severity', () => {
  const comparison = compareKserveOutcome(
    'Individual Resort Booking',
    'Individual Resort Booking',
  )
  assert.deepEqual(comparison, {
    kserveReportedOutcome: 'Individual Resort Booking',
    kserveComparisonLabel: 'match',
    mismatchSeverity: 'none',
  })
})

test('different approved labels in the same group are a low mismatch', () => {
  const comparison = compareKserveOutcome(
    'Individual Resort Booking',
    'Group Resort Booking',
  )
  assert.equal(comparison.kserveComparisonLabel, 'mismatch')
  assert.equal(comparison.mismatchSeverity, 'low')
  assert.equal(
    groupForDetailedOutcome('Individual Resort Booking'),
    groupForDetailedOutcome('Group Resort Booking'),
  )
})

test('different approved groups are a medium mismatch', () => {
  const comparison = compareKserveOutcome(
    'Individual Resort Booking',
    'Jobs Enquiry',
  )
  assert.equal(comparison.kserveComparisonLabel, 'mismatch')
  assert.equal(comparison.mismatchSeverity, 'medium')
  assert.notEqual(
    groupForDetailedOutcome('Individual Resort Booking'),
    groupForDetailedOutcome('Jobs Enquiry'),
  )
})

test('the comparison uses the exact vendor no-contact labels', () => {
  assert.deepEqual([...NO_CONTACT_OUTCOMES], [OUTREACH_STOPPED, DNC_OUTCOME])
  assert.equal(DNC_OUTCOME, "DNC Client : Don't Call Furthur")
  assert.ok(isNoContactOutcome(OUTREACH_STOPPED))
  assert.ok(isNoContactOutcome(DNC_OUTCOME))
})

test('either no-contact outcome is high severity from either side', () => {
  for (const noContact of NO_CONTACT_OUTCOMES) {
    const audited = compareKserveOutcome(noContact, 'Duplicate Lead')
    assert.equal(audited.kserveComparisonLabel, 'mismatch')
    assert.equal(audited.mismatchSeverity, 'high', `audited ${noContact}`)

    const reported = compareKserveOutcome('Duplicate Lead', noContact)
    assert.equal(reported.kserveComparisonLabel, 'mismatch')
    assert.equal(reported.mismatchSeverity, 'high', `reported ${noContact}`)
  }
})

test('no-contact precedence beats grouping in both directions', () => {
  for (const noContact of NO_CONTACT_OUTCOMES) {
    // Duplicate Lead shares EXISTING_DUPLICATE_DNC with both no-contact
    // labels, so the group rule alone would say low. Compliance outranks it.
    assert.equal(
      groupForDetailedOutcome(noContact),
      groupForDetailedOutcome('Duplicate Lead'),
    )
    assert.equal(
      compareKserveOutcome(noContact, 'Duplicate Lead').mismatchSeverity,
      'high',
    )
    // Across groups it is still high, not medium.
    assert.equal(
      compareKserveOutcome(noContact, 'Jobs Enquiry').mismatchSeverity,
      'high',
    )
    assert.equal(
      compareKserveOutcome('Jobs Enquiry', noContact).mismatchSeverity,
      'high',
    )
  }
})

test('each no-contact label is pinned by name, not by iterating the set', () => {
  // Iterating NO_CONTACT_OUTCOMES alone would silently lose coverage if a
  // member were dropped, so both labels are named literally here. Duplicate
  // Lead shares their group, so without precedence each would be only 'low'.
  assert.equal(
    groupForDetailedOutcome(OUTREACH_STOPPED),
    groupForDetailedOutcome('Duplicate Lead'),
  )
  assert.equal(
    compareKserveOutcome(OUTREACH_STOPPED, 'Duplicate Lead').mismatchSeverity,
    'high',
  )
  assert.equal(
    compareKserveOutcome('Duplicate Lead', OUTREACH_STOPPED).mismatchSeverity,
    'high',
  )
  assert.equal(
    compareKserveOutcome(DNC_OUTCOME, 'Duplicate Lead').mismatchSeverity,
    'high',
  )
  assert.equal(
    compareKserveOutcome('Duplicate Lead', DNC_OUTCOME).mismatchSeverity,
    'high',
  )
})

test('the two no-contact labels disagreeing with each other is high', () => {
  assert.equal(
    compareKserveOutcome(OUTREACH_STOPPED, DNC_OUTCOME).mismatchSeverity,
    'high',
  )
  assert.equal(
    compareKserveOutcome(DNC_OUTCOME, OUTREACH_STOPPED).mismatchSeverity,
    'high',
  )
})

test('a no-contact label matching itself is still a plain match', () => {
  for (const noContact of NO_CONTACT_OUTCOMES) {
    const comparison = compareKserveOutcome(noContact, noContact)
    assert.equal(comparison.kserveComparisonLabel, 'match', noContact)
    assert.equal(comparison.mismatchSeverity, 'none', noContact)
    assert.equal(comparison.kserveReportedOutcome, noContact)
  }
})

test('a superseded no-contact spelling is discarded, not escalated', () => {
  for (const superseded of [
    "DNC Client: Don't Call Further",
    "DNC Client : Don't Call Further",
    "DNC Client: Don't Call Furthur",
    'outreach stopped',
  ]) {
    const comparison = compareKserveOutcome('Duplicate Lead', superseded)
    assert.equal(comparison.kserveReportedOutcome, null, superseded)
    assert.equal(comparison.kserveComparisonLabel, 'not_comparable')
    assert.equal(comparison.mismatchSeverity, 'none')
  }
})

test('an unapproved candidate is discarded, never stored', () => {
  for (const candidate of [
    null,
    undefined,
    '',
    '   ',
    'Unknown Outcome',
    'random source free text about the customer',
    42,
    {},
    [],
  ]) {
    assert.deepEqual(
      compareKserveOutcome('Individual Resort Booking', candidate),
      {
        kserveReportedOutcome: null,
        kserveComparisonLabel: 'not_comparable',
        mismatchSeverity: 'none',
      },
      `${String(candidate)} must be discarded`,
    )
  }
})

test('near-miss labels are never trimmed, case folded, or aliased', () => {
  for (const candidate of [
    ' Individual Resort Booking',
    'Individual Resort Booking ',
    'individual resort booking',
    'INDIVIDUAL RESORT BOOKING',
    'Individual  Resort Booking',
    'Individual Resort Bookings',
    'Panchakarma Training',
    'DNC Client: Do not Call Further',
    // Superseded labels from the earlier FYI taxonomy.
    'Assign to MR',
    'Wants Details Over Email',
    'Yoga Training AHV',
    'Not Interested AHV',
    'Treatment Package for Resort AHV',
    'Already Spoken - AHV',
  ]) {
    const comparison = compareKserveOutcome(
      'Individual Resort Booking',
      candidate,
    )
    assert.equal(
      comparison.kserveReportedOutcome,
      null,
      `${candidate} must not be repaired into an approved label`,
    )
    assert.equal(comparison.kserveComparisonLabel, 'not_comparable')
  }
})

test('an approved label with no audited outcome is not comparable', () => {
  const comparison = compareKserveOutcome(null, 'Individual Resort Booking')
  assert.equal(comparison.kserveReportedOutcome, 'Individual Resort Booking')
  assert.equal(comparison.kserveComparisonLabel, 'not_comparable')
  assert.equal(comparison.mismatchSeverity, 'none')
})

test('the content builder persists the comparison it derived', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    kserveReportedOutcome: 'Group Resort Booking',
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.kserveReportedOutcome, 'Group Resort Booking')
  assert.equal(result.kserveComparisonLabel, 'mismatch')
  assert.equal(result.mismatchSeverity, 'low')
})

// ---------------------------------------------------------------------------
// Canonical result document
// ---------------------------------------------------------------------------

test('the result document is canonical, versioned, and hashed', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const document = JSON.parse(result.resultJson as string) as Record<
    string,
    unknown
  >
  assert.equal(document.documentVersion, RESULT_DOCUMENT_VERSION)
  assert.equal(result.resultSha256, sha256(result.resultJson as string))
  assert.match(result.resultSha256 as string, /^[0-9a-f]{64}$/)
  // Canonical JSON sorts object keys, so the bytes replay exactly.
  const keys = Object.keys(document)
  assert.deepEqual(keys, [...keys].sort())
})

test('the document binds feedback by hash and never duplicates the prose', () => {
  const output = modelOutput()
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output,
    auditedAt: AUDITED_AT,
  })
  const json = result.resultJson as string
  const document = JSON.parse(json) as Record<string, unknown>

  assert.equal(
    document.managementFeedbackSha256,
    sha256(output.managementSummary),
  )
  assert.equal(document.kserveFeedbackSha256, sha256(output.kserveFeedback))
  assert.equal(
    document.improvementFeedbackSha256,
    sha256(output.improvementFeedback),
  )
  for (const prose of [
    output.managementSummary,
    output.kserveFeedback,
    output.improvementFeedback,
  ]) {
    assert.equal(json.includes(prose), false, 'prose must not be duplicated')
  }
  // The prose still reaches its own columns.
  assert.equal(result.managementFeedback, output.managementSummary)
  assert.equal(result.kserveFeedback, output.kserveFeedback)
  assert.equal(result.improvementFeedback, output.improvementFeedback)
})

test('the document binds the deterministic score inputs', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  const document = JSON.parse(result.resultJson as string) as Record<
    string,
    unknown
  >
  const metrics = document.metricScores as Array<Record<string, unknown>>
  assert.equal(metrics.length, 8)
  assert.deepEqual(
    metrics.map((entry) => entry.metric),
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
  )
  assert.equal(document.overallScore, '80.000')
  assert.equal(document.overallScoreMethod, OVERALL_SCORE_METHOD)
})

test('changing any score input changes the result hash', () => {
  const baseline = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  }).result.resultSha256
  for (const override of [
    { metricScores: scores(3) },
    { confidence: 0.83 },
    { intent: 'HIGH' as const },
    { detailedOutcome: 'Junk' as const, qualification: 'UNCERTAIN' as const },
    { managementSummary: 'A different sanitized summary.' },
  ]) {
    assert.notEqual(
      buildContentAuditResult({
        identity: IDENTITY,
        output: modelOutput(override),
        auditedAt: AUDITED_AT,
      }).result.resultSha256,
      baseline,
      `${JSON.stringify(Object.keys(override))} must change the hash`,
    )
  }
})

test('the document carries no transcript, identifier, or money field', () => {
  const { result } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    kserveReportedOutcome: 'Group Resort Booking',
    auditedAt: AUDITED_AT,
  })
  const json = result.resultJson as string
  for (const forbidden of [
    'transcript',
    'transcription',
    'leadId',
    'lead_id',
    'taskId',
    'task_id',
    'mobile',
    'email',
    'http',
    'www.',
    'prompt',
    'rawResponse',
    'refusal',
    'errorDetail',
    'cost',
    'amount',
    'price',
    'currency',
    'managementFeedback"',
  ]) {
    assert.equal(
      json.includes(forbidden),
      false,
      `resultJson must not contain ${forbidden}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Operational-only result
// ---------------------------------------------------------------------------

test('an operational-only result invents no audit fact and has no metrics', () => {
  const { result, metricScores } = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.processingStatus, 'succeeded')
  assert.equal(result.eligibility, 'operational_only')
  assert.equal(result.ineligibilityReason, 'missing_transcript')
  assert.deepEqual(metricScores, [])
  for (const field of [
    'callConnected',
    'customerSpoke',
    'meaningfulConversation',
    'intent',
    'intentConfidence',
    'detailedOutcome',
    'groupedOutcome',
    'qualificationLabel',
    'nextActionCode',
    'overallScore',
    'overallScoreMethod',
    'managementFeedback',
    'kserveFeedback',
    'improvementFeedback',
    'issueFlagsJson',
    'errorCode',
    'errorDetail',
  ]) {
    assert.equal(
      (result as unknown as Record<string, unknown>)[field],
      null,
      `${field} must be null for an operational-only result`,
    )
  }
})

test('the operational-only document is small, coded, and hashed', () => {
  const { result } = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: AUDITED_AT,
  })
  const document = JSON.parse(result.resultJson as string) as Record<
    string,
    unknown
  >
  assert.equal(document.eligibility, 'operational_only')
  assert.equal(document.ineligibilityReason, 'missing_transcript')
  assert.equal(document.kserveComparisonLabel, 'not_comparable')
  assert.equal(document.mismatchSeverity, 'none')
  assert.equal(document.documentVersion, RESULT_DOCUMENT_VERSION)
  assert.equal(result.resultSha256, sha256(result.resultJson as string))
  // No invented call facts or scores.
  for (const absent of [
    'callConnected',
    'customerSpoke',
    'intent',
    'overallScore',
    'metricScores',
  ]) {
    assert.equal(absent in document, false, `${absent} must not be invented`)
  }
})

test('operational-only keeps an approved KServe label but never compares', () => {
  const kept = buildOperationalOnlyResult({
    identity: IDENTITY,
    kserveReportedOutcome: 'Not Connected',
    auditedAt: AUDITED_AT,
  }).result
  assert.equal(kept.kserveReportedOutcome, 'Not Connected')
  assert.equal(kept.kserveComparisonLabel, 'not_comparable')
  assert.equal(kept.mismatchSeverity, 'none')

  const discarded = buildOperationalOnlyResult({
    identity: IDENTITY,
    kserveReportedOutcome: 'some arbitrary source text',
    auditedAt: AUDITED_AT,
  }).result
  assert.equal(discarded.kserveReportedOutcome, null)
  assert.equal(discarded.kserveComparisonLabel, 'not_comparable')
})

// ---------------------------------------------------------------------------
// Failed result
// ---------------------------------------------------------------------------

test('a failed result carries a safe code and no document', () => {
  const { result, metricScores } = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'content_auditable',
    errorCode: 'MODEL_TIMEOUT',
  })
  assert.equal(result.processingStatus, 'failed')
  assert.equal(result.errorCode, 'MODEL_TIMEOUT')
  assert.equal(result.errorDetail, null)
  assert.equal(result.resultJson, null)
  assert.equal(result.resultSha256, null)
  assert.equal(result.overallScore, null)
  assert.equal(result.overallScoreMethod, null)
  assert.deepEqual(metricScores, [])
})

test('a failed result completed no audit, so it has no audit time', () => {
  const { result } = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'content_auditable',
    errorCode: 'MODEL_TIMEOUT',
  })
  assert.equal(result.auditedAt, null)
  // The input shape does not even offer an audit time to supply.
  assert.equal('auditedAt' in ({} as FailedResultInput), false)
})

test('a failed result keeps eligibility and reason consistent', () => {
  const operational = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'operational_only',
    errorCode: 'MODEL_TIMEOUT',
  }).result
  assert.equal(operational.eligibility, 'operational_only')
  assert.equal(operational.ineligibilityReason, 'missing_transcript')

  const content = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'content_auditable',
    errorCode: 'MODEL_TIMEOUT',
  }).result
  assert.equal(content.eligibility, 'content_auditable')
  assert.equal(content.ineligibilityReason, null)

  // Still no invented audit facts on either branch.
  for (const record of [operational, content]) {
    assert.equal(record.callConnected, null)
    assert.equal(record.customerSpoke, null)
    assert.equal(record.intent, null)
    assert.equal(record.detailedOutcome, null)
    assert.equal(record.overallScore, null)
  }
})

test('succeeded builders still require and persist an audit time', () => {
  assert.equal(
    buildContentAuditResult({
      identity: IDENTITY,
      output: modelOutput(),
      auditedAt: AUDITED_AT,
    }).result.auditedAt,
    AUDITED_AT,
  )
  assert.equal(
    buildOperationalOnlyResult({
      identity: IDENTITY,
      auditedAt: AUDITED_AT,
    }).result.auditedAt,
    AUDITED_AT,
  )
  for (const build of [
    () =>
      buildContentAuditResult({
        identity: IDENTITY,
        output: modelOutput(),
        auditedAt: undefined as unknown as string,
      }),
    () =>
      buildOperationalOnlyResult({
        identity: IDENTITY,
        auditedAt: undefined as unknown as string,
      }),
  ]) {
    assert.equal(expectRecordError(build).field, 'auditedAt')
  }
})

test('a failed result rejects provider prose as an error code', () => {
  for (const errorCode of [
    'Request failed: the transcript mentioned 9876543210',
    'timeout',
    'MODEL timeout',
    'model_timeout',
    '429 Too Many Requests',
    '',
    '   ',
    'A'.repeat(MAX_ERROR_CODE_LENGTH + 1),
    42 as unknown as string,
    null as unknown as string,
  ]) {
    const error = expectRecordError(
      () =>
        buildFailedResult({
          identity: IDENTITY,
          eligibility: 'content_auditable',
          errorCode,
        }),
      `${String(errorCode)} must be rejected`,
    )
    assert.equal(error.field, 'errorCode')
    assert.equal(error.message.includes('9876543210'), false)
    assert.equal(error.message.includes('transcript'), false)
  }
})

test('a failed result accepts a code at the exact column width', () => {
  const code = `E${'A'.repeat(MAX_ERROR_CODE_LENGTH - 1)}`
  assert.equal(code.length, MAX_ERROR_CODE_LENGTH)
  const { result } = buildFailedResult({
    identity: IDENTITY,
    eligibility: 'operational_only',
    errorCode: code,
  })
  assert.equal(result.errorCode, code)
  assert.equal(result.eligibility, 'operational_only')
})

test('a failed result rejects an unapproved eligibility', () => {
  const error = expectRecordError(() =>
    buildFailedResult({
      identity: IDENTITY,
      eligibility: 'human_review' as never,
      errorCode: 'MODEL_TIMEOUT',
    }),
  )
  assert.equal(error.field, 'eligibility')
})

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

test('timestamps are validated and passed through, never generated', () => {
  for (const auditedAt of [
    '2026-08-01 09:20:00.000000',
    '2026-12-31 23:59:59.999999',
    '2026-01-01 00:00:00',
    '2026-08-01T09:20:00',
  ]) {
    const { result } = buildContentAuditResult({
      identity: IDENTITY,
      output: modelOutput(),
      auditedAt,
    })
    // The supplied wall clock is preserved exactly; only the separator is
    // normalized to the SQL form.
    assert.equal(result.auditedAt, auditedAt.replace('T', ' '))
  }
})

test('an impossible timestamp is rejected rather than rolled forward', () => {
  for (const auditedAt of [
    '2026-02-30 00:00:00',
    '2026-02-29 00:00:00',
    '2026-13-01 00:00:00',
    '2026-08-01 24:00:00',
    '2026-08-01 00:60:00',
    '2026-08-01 00:00:60',
    '2026-08-01T00:00:00Z',
    '2026-08-01',
    'now',
    '',
    42 as unknown as string,
  ]) {
    const error = expectRecordError(
      () =>
        buildOperationalOnlyResult({
          identity: IDENTITY,
          auditedAt,
        }),
      `${String(auditedAt)} must be rejected`,
    )
    assert.equal(error.field, 'auditedAt')
  }
})

test('a leap day in a leap year is accepted', () => {
  const { result } = buildOperationalOnlyResult({
    identity: IDENTITY,
    auditedAt: '2024-02-29 12:00:00',
  })
  assert.equal(result.auditedAt, '2024-02-29 12:00:00')
})

// ---------------------------------------------------------------------------
// Usage attempts
// ---------------------------------------------------------------------------

const USAGE_BASE = {
  identity: IDENTITY,
  attemptNumber: 1,
  attemptOutcome: 'succeeded' as const,
  providerName: 'openai',
  modelName: 'gpt-4o-mini',
  modelVersion: 'gpt-4o-mini-2024-07-18',
  recordedAt: '2026-08-01 09:20:01.500000',
}

test('a usage record maps every persisted column', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: '1200',
    outputTokens: '340',
    totalTokens: '1540',
    requestId: 'req-abc',
    latencyMs: 812,
  })
  assert.equal(record.resultId, buildResultId(IDENTITY))
  assert.equal(record.runId, IDENTITY.runId)
  assert.equal(record.ruleVersionId, IDENTITY.ruleVersionId)
  assert.equal(record.attemptNumber, 1)
  assert.equal(record.attemptOutcome, 'succeeded')
  assert.equal(record.providerName, 'openai')
  assert.equal(record.inputTokens, '1200')
  assert.equal(record.outputTokens, '340')
  assert.equal(record.totalTokens, '1540')
  assert.equal(record.requestId, 'req-abc')
  assert.equal(record.latencyMs, '812')
  assert.equal(record.errorCode, null)
  assert.equal(record.recordedAt, USAGE_BASE.recordedAt)
})

test('the usage record carries no prompt, response, or money field', () => {
  const record = buildUsageEventRecord(USAGE_BASE) as unknown as Record<
    string,
    unknown
  >
  for (const forbidden of [
    'prompt',
    'systemPrompt',
    'transcript',
    'rawResponse',
    'responseBody',
    'refusalText',
    'errorMessage',
    'errorDetail',
    'errorPayload',
    'cost',
    'costAmount',
    'amount',
    'price',
    'unitPrice',
    'currency',
    'spend',
    'createdAt',
  ]) {
    assert.equal(forbidden in record, false, `must not carry ${forbidden}`)
  }
})

test('every attempt outcome is recordable', () => {
  assert.equal(
    buildUsageEventRecord(USAGE_BASE).attemptOutcome,
    'succeeded',
  )
  for (const outcome of ['refused', 'failed'] as const) {
    const record = buildUsageEventRecord({
      ...USAGE_BASE,
      attemptOutcome: outcome,
      errorCode: 'PROVIDER_REFUSAL',
    })
    assert.equal(record.attemptOutcome, outcome)
    assert.equal(record.errorCode, 'PROVIDER_REFUSAL')
  }
})

test('outcome and error code must agree', () => {
  const withCode = expectRecordError(() =>
    buildUsageEventRecord({ ...USAGE_BASE, errorCode: 'SOMETHING' }),
  )
  assert.equal(withCode.field, 'errorCode')

  for (const outcome of ['refused', 'failed'] as const) {
    const missing = expectRecordError(() =>
      buildUsageEventRecord({ ...USAGE_BASE, attemptOutcome: outcome }),
    )
    assert.equal(missing.field, 'errorCode')
  }
})

test('a retry produces a distinct deterministic id on the same result', () => {
  const first = buildUsageEventRecord(USAGE_BASE)
  const retry = buildUsageEventRecord({
    ...USAGE_BASE,
    attemptNumber: 2,
    attemptOutcome: 'failed',
    errorCode: 'MODEL_TIMEOUT',
  })
  assert.notEqual(first.id, retry.id)
  assert.equal(first.resultId, retry.resultId)
  assert.equal(retry.id, buildUsageEventId(IDENTITY, 2))
  assert.equal(buildUsageEventRecord(USAGE_BASE).id, first.id)
})

test('the attempt number must be a positive integer', () => {
  for (const attemptNumber of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.MAX_VALUE,
    '1' as unknown as number,
    null as unknown as number,
  ]) {
    const error = expectRecordError(
      () => buildUsageEventRecord({ ...USAGE_BASE, attemptNumber }),
      `${String(attemptNumber)} must be rejected`,
    )
    assert.equal(error.field, 'attemptNumber')
  }
})

test('BIGINT token counts survive losslessly as canonical strings', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: '9007199254740993',
    outputTokens: '9223372036854775807',
    totalTokens: '0',
    latencyMs: '9007199254740993',
  })
  assert.equal(record.inputTokens, '9007199254740993')
  assert.notEqual(record.inputTokens, '9007199254740992')
  assert.equal(record.outputTokens, '9223372036854775807')
  assert.equal(record.totalTokens, '0')
  assert.equal(record.latencyMs, '9007199254740993')
  assert.equal(typeof record.inputTokens, 'string')
})

test('a bigint or safe number is accepted and canonicalized', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: 9007199254740993n,
    outputTokens: 340,
    totalTokens: 0,
    latencyMs: 0,
  })
  assert.equal(record.inputTokens, '9007199254740993')
  assert.equal(record.outputTokens, '340')
  assert.equal(record.totalTokens, '0')
  assert.equal(record.latencyMs, '0')
})

test('an unsafe number is rejected rather than silently rounded', () => {
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'latencyMs']) {
    const error = expectRecordError(() =>
      buildUsageEventRecord({
        ...USAGE_BASE,
        [field]: Number.MAX_SAFE_INTEGER + 2,
      }),
    )
    assert.equal(error.field, field)
    assert.match(error.message, /safe integer/)
  }
})

test('negative and malformed counts are rejected', () => {
  for (const value of [
    -1,
    -1n,
    '-1',
    '+1',
    '1.5',
    '007',
    '1e3',
    'abc',
    '',
    ' 12 34 ',
    {} as unknown as string,
  ]) {
    const error = expectRecordError(
      () => buildUsageEventRecord({ ...USAGE_BASE, inputTokens: value }),
      `${String(value)} must be rejected`,
    )
    assert.equal(error.field, 'inputTokens')
  }
})

test('absent provider counts stay null and are never recomputed', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: '1200',
    outputTokens: '340',
    totalTokens: null,
    requestId: null,
    latencyMs: null,
  })
  assert.equal(record.totalTokens, null)
  assert.notEqual(record.totalTokens, '1540')
  assert.equal(record.requestId, null)
  assert.equal(record.latencyMs, null)

  const omitted = buildUsageEventRecord(USAGE_BASE)
  assert.equal(omitted.inputTokens, null)
  assert.equal(omitted.outputTokens, null)
  assert.equal(omitted.totalTokens, null)
})

test('a provider-reported total is preserved even when it disagrees', () => {
  // Providers occasionally count differently; recomputing would misstate spend.
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: '10',
    outputTokens: '10',
    totalTokens: '25',
  })
  assert.equal(record.totalTokens, '25')
})

test('usage identifiers respect the migration widths', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    requestId: 'r'.repeat(MAX_REQUEST_ID_LENGTH),
  })
  assert.equal(record.requestId?.length, MAX_REQUEST_ID_LENGTH)

  for (const [field, value] of [
    ['requestId', 'r'.repeat(MAX_REQUEST_ID_LENGTH + 1)],
    ['providerName', 'p'.repeat(81)],
    ['modelName', 'm'.repeat(101)],
    ['modelVersion', 'v'.repeat(101)],
  ] as const) {
    const error = expectRecordError(() =>
      buildUsageEventRecord({ ...USAGE_BASE, [field]: value }),
    )
    assert.equal(error.field, field)
  }
})

// ---------------------------------------------------------------------------
// MySQL numeric ceilings
// ---------------------------------------------------------------------------

test('the exported ceilings match the migration 0008 column types', () => {
  assert.equal(MAX_SIGNED_BIGINT, '9223372036854775807')
  assert.equal(MAX_ATTEMPT_NUMBER, 2147483647)
})

test('a count at exactly the signed BIGINT maximum is accepted', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: MAX_SIGNED_BIGINT,
    outputTokens: BigInt(MAX_SIGNED_BIGINT),
    totalTokens: MAX_SIGNED_BIGINT,
    latencyMs: MAX_SIGNED_BIGINT,
  })
  assert.equal(record.inputTokens, MAX_SIGNED_BIGINT)
  assert.equal(record.outputTokens, MAX_SIGNED_BIGINT)
  assert.equal(record.totalTokens, MAX_SIGNED_BIGINT)
  assert.equal(record.latencyMs, MAX_SIGNED_BIGINT)
})

test('a count one above the signed BIGINT maximum is rejected', () => {
  const above = (BigInt(MAX_SIGNED_BIGINT) + 1n).toString()
  for (const field of [
    'inputTokens',
    'outputTokens',
    'totalTokens',
    'latencyMs',
  ]) {
    for (const value of [above, BigInt(above), '99999999999999999999']) {
      const error = expectRecordError(
        () => buildUsageEventRecord({ ...USAGE_BASE, [field]: value }),
        `${field}=${String(value)} must be rejected`,
      )
      assert.equal(error.field, field)
      assert.match(error.message, /signed BIGINT maximum/)
      // The rejected value itself is never echoed.
      assert.equal(error.message.includes(String(value)), false)
    }
  }
})

test('a safe number can never exceed the BIGINT ceiling', () => {
  // Number.MAX_SAFE_INTEGER is far below the ceiling, so the numeric path
  // stays accepted while the string and bigint paths carry the real risk.
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    inputTokens: Number.MAX_SAFE_INTEGER,
  })
  assert.equal(record.inputTokens, '9007199254740991')
  assert.ok(BigInt(record.inputTokens as string) < BigInt(MAX_SIGNED_BIGINT))
})

test('an attempt number at exactly the signed INT maximum is accepted', () => {
  const record = buildUsageEventRecord({
    ...USAGE_BASE,
    attemptNumber: MAX_ATTEMPT_NUMBER,
  })
  assert.equal(record.attemptNumber, MAX_ATTEMPT_NUMBER)
  assert.equal(record.id, buildUsageEventId(IDENTITY, MAX_ATTEMPT_NUMBER))
})

test('an attempt number above the signed INT maximum is rejected', () => {
  for (const attemptNumber of [
    MAX_ATTEMPT_NUMBER + 1,
    MAX_ATTEMPT_NUMBER + 1000,
    Number.MAX_SAFE_INTEGER,
  ]) {
    const viaRecord = expectRecordError(
      () => buildUsageEventRecord({ ...USAGE_BASE, attemptNumber }),
      `${attemptNumber} must be rejected by the record builder`,
    )
    assert.equal(viaRecord.field, 'attemptNumber')

    const viaHelper = expectRecordError(
      () => buildUsageEventId(IDENTITY, attemptNumber),
      `${attemptNumber} must be rejected by the id helper`,
    )
    assert.equal(viaHelper.field, 'attemptNumber')
    assert.match(viaHelper.message, /between 1 and 2147483647/)
  }
})

// ---------------------------------------------------------------------------
// Public identity helpers enforce their own contracts
// ---------------------------------------------------------------------------

const INVALID_IDENTITIES: Array<[string, unknown]> = [
  ['blank runId', { ...IDENTITY, runId: '' }],
  ['whitespace runId', { ...IDENTITY, runId: '   ' }],
  ['oversized runId', { ...IDENTITY, runId: 'r'.repeat(MAX_ID_LENGTH + 1) }],
  ['control character', { ...IDENTITY, sourceRefId: 'src\u0000id' }],
  ['non-string ruleVersionId', { ...IDENTITY, ruleVersionId: 42 }],
  ['missing sourceRefId', { runId: 'run-1', ruleVersionId: 'rule-1' }],
  ['null identity', null],
  ['array identity', []],
  ['string identity', 'run-1'],
]

test('buildResultId validates its identity when called directly', () => {
  for (const [label, identity] of INVALID_IDENTITIES) {
    expectRecordError(
      () => buildResultId(identity as CallAuditResultIdentity),
      `${label} must be rejected`,
    )
  }
})

test('buildResultIdempotencyKey validates its identity when called directly', () => {
  for (const [label, identity] of INVALID_IDENTITIES) {
    expectRecordError(
      () => buildResultIdempotencyKey(identity as CallAuditResultIdentity),
      `${label} must be rejected`,
    )
  }
})

test('buildMetricScoreId validates its identity when called directly', () => {
  for (const [label, identity] of INVALID_IDENTITIES) {
    expectRecordError(
      () =>
        buildMetricScoreId(
          identity as CallAuditResultIdentity,
          'PROFESSIONALISM',
        ),
      `${label} must be rejected`,
    )
  }
})

test('buildUsageEventId validates its identity when called directly', () => {
  for (const [label, identity] of INVALID_IDENTITIES) {
    expectRecordError(
      () => buildUsageEventId(identity as CallAuditResultIdentity, 1),
      `${label} must be rejected`,
    )
  }
})

test('buildMetricScoreId rejects an unapproved runtime metric code', () => {
  for (const metricCode of [
    'AUDIO_VOLUME',
    'professionalism',
    '',
    '   ',
    'UNKNOWN_METRIC',
    42,
    null,
    undefined,
    {},
  ]) {
    const error = expectRecordError(
      () =>
        buildMetricScoreId(
          IDENTITY,
          metricCode as unknown as 'PROFESSIONALISM',
        ),
      `${String(metricCode)} must be rejected`,
    )
    assert.equal(error.field, 'metricCode')
  }
  // Every approved code still works.
  for (const metric of CALL_AUDIT_RUBRIC) {
    assert.match(buildMetricScoreId(IDENTITY, metric.code), /^cam_[0-9a-f]{36}$/)
  }
})

test('buildUsageEventId validates the attempt number when called directly', () => {
  for (const attemptNumber of [
    0,
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '1',
    null,
    undefined,
  ]) {
    const error = expectRecordError(
      () => buildUsageEventId(IDENTITY, attemptNumber as unknown as number),
      `${String(attemptNumber)} must be rejected`,
    )
    assert.equal(error.field, 'attemptNumber')
  }
})

test('direct helper errors never echo the submitted value', () => {
  const secret = 'Saanvi: hello Ms Synthetic, is 9876543210 still your number?'
  const calls: Array<() => unknown> = [
    () => buildResultId({ ...IDENTITY, runId: secret }),
    () => buildResultIdempotencyKey({ ...IDENTITY, sourceRefId: secret }),
    () =>
      buildMetricScoreId(
        { ...IDENTITY, ruleVersionId: secret },
        'PROFESSIONALISM',
      ),
    () =>
      buildMetricScoreId(IDENTITY, secret as unknown as 'PROFESSIONALISM'),
    () => buildUsageEventId({ ...IDENTITY, runId: secret }, 1),
  ]
  for (const call of calls) {
    const error = expectRecordError(call)
    const text = `${error.message}\n${error.stack ?? ''}`
    assert.equal(text.includes('Saanvi'), false)
    assert.equal(text.includes('9876543210'), false)
    assert.equal(text.includes(secret), false)
  }
})

test('valid direct helper calls still agree with the builders', () => {
  const { result, metricScores } = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    auditedAt: AUDITED_AT,
  })
  assert.equal(result.id, buildResultId(IDENTITY))
  assert.equal(result.idempotencyKey, buildResultIdempotencyKey(IDENTITY))
  for (const record of metricScores) {
    assert.equal(record.id, buildMetricScoreId(IDENTITY, record.metricCode))
  }
  assert.equal(
    buildUsageEventRecord(USAGE_BASE).id,
    buildUsageEventId(IDENTITY, 1),
  )
})

// ---------------------------------------------------------------------------
// Purity
// ---------------------------------------------------------------------------

test('builders replay identically for the same logical input', () => {
  const first = buildContentAuditResult({
    identity: IDENTITY,
    output: modelOutput(),
    kserveReportedOutcome: 'Group Resort Booking',
    auditedAt: AUDITED_AT,
  })
  const second = buildContentAuditResult({
    identity: { ...IDENTITY },
    output: modelOutput(),
    kserveReportedOutcome: 'Group Resort Booking',
    auditedAt: AUDITED_AT,
  })
  assert.deepEqual(first, second)
  assert.equal(
    JSON.stringify(first.result),
    JSON.stringify(second.result),
  )
})

test('builders do not mutate their inputs', () => {
  const identity = { ...IDENTITY }
  const identitySnapshot = { ...identity }
  const output = modelOutput()
  const outputSnapshot = JSON.stringify(output)
  const usageInput = { ...USAGE_BASE, inputTokens: '10' as const }
  const usageSnapshot = JSON.stringify(usageInput)

  buildContentAuditResult({ identity, output, auditedAt: AUDITED_AT })
  buildOperationalOnlyResult({ identity, auditedAt: AUDITED_AT })
  buildFailedResult({
    identity,
    eligibility: 'content_auditable',
    errorCode: 'MODEL_TIMEOUT',
  })
  buildUsageEventRecord(usageInput)

  assert.deepEqual(identity, identitySnapshot)
  assert.equal(JSON.stringify(output), outputSnapshot)
  assert.equal(JSON.stringify(usageInput), usageSnapshot)
  assert.deepEqual(
    output.metricScores.map((entry) => entry.metric),
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
  )
})

test('the module reads no clock, randomness, environment, or database', () => {
  const source = readFileSync(
    new URL('./resultRecords.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of [
    /Date\.now/,
    /new Date\(/,
    /randomUUID/,
    /Math\.random/,
    /process\.env/,
    /toLocale/,
    /require\(/,
    /mysql/i,
    /pool\./,
  ]) {
    assert.equal(
      forbidden.test(source),
      false,
      `resultRecords.ts must not use ${forbidden}`,
    )
  }
})
