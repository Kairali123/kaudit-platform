import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CallAuditOutputError,
  CONTENT_AUDIT_OUTPUT_KEYS,
  ISSUE_FLAGS,
  MAX_FEEDBACK_LENGTH,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
  validateContentAuditOutput,
} from './modelOutput.ts'
import { CALL_AUDIT_METRIC_CODES } from './rubric.ts'
import type { MetricScore } from './types.ts'

const CONTENT = { eligibility: 'content_auditable' } as const

/** Captures the thrown validation error; assert.throws does not return it. */
function expectOutputError(run: () => unknown, message?: string): CallAuditOutputError {
  try {
    run()
  } catch (error) {
    assert.ok(
      error instanceof CallAuditOutputError,
      message ?? 'expected a CallAuditOutputError',
    )
    return error as CallAuditOutputError
  }
  assert.fail(message ?? 'expected a CallAuditOutputError to be thrown')
}


function scores(
  fill: MetricScore,
  overrides: Record<string, MetricScore> = {},
): Array<{ metric: string; score: MetricScore }> {
  return CALL_AUDIT_METRIC_CODES.map((metric) => ({
    metric,
    score: Object.hasOwn(overrides, metric) ? overrides[metric] : fill,
  }))
}

/** Synthetic model output only — no real customer data anywhere. */
function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    managementSummary: 'Caller asked about a resort stay and wants a callback.',
    kserveFeedback: 'Agent skipped confirming the preferred travel window.',
    improvementFeedback: 'Confirm dates before closing the call.',
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Happy path and derived fields
// ---------------------------------------------------------------------------

test('accepts a well-formed content-audit output', () => {
  const validated = validateContentAuditOutput(output(), CONTENT)
  assert.equal(validated.callConnected, true)
  assert.equal(validated.intent, 'WARM')
  assert.equal(validated.detailedOutcome, 'Individual Resort Booking')
  assert.equal(validated.qualification, 'QUALIFIED')
  assert.equal(validated.nextAction, 'SCHEDULE_BOOKING')
  assert.equal(validated.confidence, 0.82)
  assert.deepEqual([...validated.issueFlags], ['WEAK_NEXT_STEP'])
  assert.equal(validated.metricScores.length, 8)
})

test('derives the grouped outcome rather than accepting one', () => {
  const validated = validateContentAuditOutput(output(), CONTENT)
  assert.equal(validated.groupedOutcome, 'RESORT_HEALING')

  assert.equal(
    validateContentAuditOutput(
      output({ detailedOutcome: 'Duplicate Lead' }),
      CONTENT,
    ).groupedOutcome,
    'EXISTING_DUPLICATE_DNC',
  )
})

test('derives the overall score rather than accepting one', () => {
  assert.equal(
    validateContentAuditOutput(output(), CONTENT).overallScore,
    '80.000',
  )
  assert.equal(
    validateContentAuditOutput(
      output({ metricScores: scores(5) }),
      CONTENT,
    ).overallScore,
    '100.000',
  )
})

test('rejects a model that tries to supply the derived fields', () => {
  for (const field of ['groupedOutcome', 'overallScore']) {
    const error = expectOutputError(
      () =>
        validateContentAuditOutput(
          output({ [field]: field === 'overallScore' ? '99.999' : 'OTHER' }),
          CONTENT,
        ),
    )
    assert.equal(error.field, field)
  }
})

test('metric scores are returned in the canonical rubric order', () => {
  const shuffled = scores(3).reverse()
  const validated = validateContentAuditOutput(
    output({ metricScores: shuffled }),
    CONTENT,
  )
  assert.deepEqual(
    validated.metricScores.map((entry) => entry.metric),
    [...CALL_AUDIT_METRIC_CODES],
  )
})

// ---------------------------------------------------------------------------
// Object shape
// ---------------------------------------------------------------------------

test('rejects a non-object model value', () => {
  for (const value of [null, undefined, 'output', 42, true, []]) {
    const error = expectOutputError(
      () => validateContentAuditOutput(value, CONTENT),
    )
    assert.equal(error.field, 'root')
  }
})

test('rejects any unknown top-level key', () => {
  for (const key of ['reasoning', 'notes', 'transcript', 'rawResponse', '__proto__x']) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output({ [key]: 'x' }), CONTENT),
    )
    assert.equal(error.field, key)
  }
})

test('rejects a missing required key', () => {
  for (const key of CONTENT_AUDIT_OUTPUT_KEYS) {
    const incomplete = output()
    delete incomplete[key]
    const error = expectOutputError(
      () => validateContentAuditOutput(incomplete, CONTENT),
      `${key} must be required`,
    )
    assert.equal(error.field, key)
  }
})

// ---------------------------------------------------------------------------
// Enum and scalar validation
// ---------------------------------------------------------------------------

test('requires booleans for the three call facts', () => {
  for (const field of [
    'callConnected',
    'customerSpoke',
    'meaningfulConversation',
  ]) {
    for (const value of ['true', 1, 0, null, {}]) {
      assert.throws(
        () => validateContentAuditOutput(output({ [field]: value }), CONTENT),
        CallAuditOutputError,
      )
    }
  }
})

test('accepts every approved enum value', () => {
  for (const intent of ['HIGH', 'WARM', 'LOW', 'NONE']) {
    const value = validateContentAuditOutput(
      output(
        intent === 'NONE'
          ? { intent, qualification: 'NOT_APPLICABLE' }
          : { intent },
      ),
      CONTENT,
    )
    assert.equal(value.intent, intent)
  }
  for (const qualification of QUALIFICATIONS) {
    assert.equal(
      validateContentAuditOutput(output({ qualification }), CONTENT)
        .qualification,
      qualification,
    )
  }
  for (const nextAction of NEXT_ACTION_CODES) {
    assert.equal(
      validateContentAuditOutput(output({ nextAction }), CONTENT).nextAction,
      nextAction,
    )
  }
})

test('rejects an unknown enum value', () => {
  const cases: Array<[string, unknown]> = [
    ['intent', 'MEDIUM'],
    ['intent', 'warm'],
    ['intent', null],
    ['qualification', 'MAYBE'],
    ['qualification', 'qualified'],
    ['nextAction', 'CALL_BACK'],
    ['nextAction', ''],
    ['detailedOutcome', 'Unknown Outcome'],
    ['detailedOutcome', 'not connected'],
  ]
  for (const [field, value] of cases) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output({ [field]: value }), CONTENT),
      `${field}=${String(value)} must be rejected`,
    )
    assert.equal(error.field, field)
  }
})

test('accepts confidence across the closed unit interval', () => {
  for (const confidence of [0, 0.5, 1, 0.00000001, 0.99999999]) {
    assert.equal(
      validateContentAuditOutput(output({ confidence }), CONTENT).confidence,
      confidence,
    )
  }
})

test('rejects confidence outside 0 through 1 or non-finite', () => {
  for (const confidence of [
    -0.0001,
    1.0001,
    2,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    '0.5',
    null,
  ]) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output({ confidence }), CONTENT),
      `${String(confidence)} must be rejected`,
    )
    assert.equal(error.field, 'confidence')
  }
})

// ---------------------------------------------------------------------------
// Issue flags
// ---------------------------------------------------------------------------

test('accepts an empty or full set of approved flags', () => {
  assert.deepEqual(
    [...validateContentAuditOutput(output({ issueFlags: [] }), CONTENT).issueFlags],
    [],
  )
  assert.equal(
    validateContentAuditOutput(output({ issueFlags: [...ISSUE_FLAGS] }), CONTENT)
      .issueFlags.length,
    ISSUE_FLAGS.length,
  )
})

test('rejects duplicate, unknown, or malformed flags', () => {
  for (const issueFlags of [
    ['WEAK_NEXT_STEP', 'WEAK_NEXT_STEP'],
    ['NOT_A_FLAG'],
    ['weak_next_step'],
    [null],
    [123],
    'WEAK_NEXT_STEP',
    { flag: 'WEAK_NEXT_STEP' },
    [...ISSUE_FLAGS, 'WEAK_NEXT_STEP'],
  ]) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output({ issueFlags }), CONTENT),
      `${JSON.stringify(issueFlags)} must be rejected`,
    )
    assert.equal(error.field, 'issueFlags')
  }
})

// ---------------------------------------------------------------------------
// Metric scores
// ---------------------------------------------------------------------------

test('rejects unknown metrics, duplicates, and wrong entry counts', () => {
  for (const metricScores of [
    scores(4).slice(0, 7),
    [...scores(4), { metric: 'PROFESSIONALISM', score: 3 }],
    scores(4).map((entry, index) =>
      index === 0 ? { metric: 'PROFESSIONALISM', score: 3 } : entry,
    ),
    scores(4).map((entry, index) =>
      index === 0 ? { metric: 'AUDIO_VOLUME', score: 3 } : entry,
    ),
    scores(4, { PROFESSIONALISM: 0 as MetricScore }),
    scores(4, { PROFESSIONALISM: 6 as MetricScore }),
    scores(4, { PROFESSIONALISM: 3.5 as MetricScore }),
    scores(4, { PROFESSIONALISM: '4' as unknown as MetricScore }),
    'scores',
    null,
  ]) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output({ metricScores }), CONTENT),
    )
    assert.equal(error.field, 'metricScores')
  }
})

test('allows NA only on the two optional metrics when the customer spoke', () => {
  for (const metric of ['PRODUCT_SERVICE_KNOWLEDGE', 'OBJECTION_CALLBACK_HANDLING']) {
    const validated = validateContentAuditOutput(
      output({ metricScores: scores(4, { [metric]: 'NA' }) }),
      CONTENT,
    )
    assert.equal(
      validated.metricScores.find((entry) => entry.metric === metric)?.score,
      'NA',
    )
  }
  for (const metric of [
    'CUSTOMER_UNDERSTANDING',
    'COMMUNICATION_CLARITY',
    'CLOSING_NEXT_STEP',
    'PROFESSIONALISM',
    'QUALIFICATION_COMPLETENESS',
    'COMPLIANCE_PRIVACY',
  ]) {
    const error = expectOutputError(
      () =>
        validateContentAuditOutput(
          output({ metricScores: scores(4, { [metric]: 'NA' }) }),
          CONTENT,
        ),
      `${metric} must not be NA when the customer spoke`,
    )
    assert.equal(error.field, 'metricScores')
  }
})

// ---------------------------------------------------------------------------
// Semantic consistency
// ---------------------------------------------------------------------------

const SILENT = {
  callConnected: true,
  customerSpoke: false,
  meaningfulConversation: false,
  intent: 'NONE',
  qualification: 'NOT_APPLICABLE',
  detailedOutcome: 'No Answer',
  nextAction: 'CALLBACK',
  metricScores: scores('NA'),
  issueFlags: ['NO_CUSTOMER_SPEECH'],
}

test('a silent call validates and carries no overall score', () => {
  const validated = validateContentAuditOutput(output(SILENT), CONTENT)
  assert.equal(validated.customerSpoke, false)
  assert.equal(validated.meaningfulConversation, false)
  assert.equal(validated.intent, 'NONE')
  assert.equal(validated.qualification, 'NOT_APPLICABLE')
  assert.equal(validated.overallScore, null)
  assert.equal(validated.groupedOutcome, 'NOT_CONNECTED')
})

// ---------------------------------------------------------------------------
// Call connection implies the speech that can follow from it
// ---------------------------------------------------------------------------

test('an unconnected call cannot have carried customer speech', () => {
  const error = expectOutputError(() =>
    validateContentAuditOutput(
      output({ callConnected: false, customerSpoke: true }),
      CONTENT,
    ),
  )
  assert.equal(error.field, 'customerSpoke')
  assert.equal(error.message, 'customerSpoke: must be false when the call did not connect')
})

test('an unconnected call is rejected even when it looks like a real conversation', () => {
  // The exact record the finding described: contradictory, yet otherwise
  // complete enough to flow into reports and aggregates unchallenged.
  const error = expectOutputError(() =>
    validateContentAuditOutput(
      output({
        callConnected: false,
        customerSpoke: true,
        meaningfulConversation: true,
        intent: 'HIGH',
        qualification: 'QUALIFIED',
        detailedOutcome: 'Individual Resort Booking',
        nextAction: 'SCHEDULE_BOOKING',
        confidence: 0.97,
        metricScores: scores(5),
        issueFlags: [],
      }),
      CONTENT,
    ),
  )
  assert.equal(error.field, 'customerSpoke')
})

test('an unconnected call is rejected across every contradictory shape', () => {
  for (const overrides of [
    { callConnected: false, customerSpoke: true },
    { callConnected: false, customerSpoke: true, meaningfulConversation: false },
    {
      callConnected: false,
      customerSpoke: true,
      intent: 'NONE',
      qualification: 'NOT_APPLICABLE',
      meaningfulConversation: false,
      metricScores: scores('NA'),
    },
    {
      callConnected: false,
      customerSpoke: true,
      metricScores: scores(1),
    },
  ]) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output(overrides), CONTENT),
      `${JSON.stringify(overrides)} must be rejected`,
    )
    assert.equal(error.field, 'customerSpoke')
  }
})

test('an unconnected, silent call is accepted and carries no score', () => {
  const validated = validateContentAuditOutput(
    output({ ...SILENT, callConnected: false, detailedOutcome: 'Not Connected' }),
    CONTENT,
  )
  assert.equal(validated.callConnected, false)
  assert.equal(validated.customerSpoke, false)
  assert.equal(validated.meaningfulConversation, false)
  assert.equal(validated.intent, 'NONE')
  assert.equal(validated.qualification, 'NOT_APPLICABLE')
  assert.equal(validated.overallScore, null)
  assert.equal(validated.groupedOutcome, 'NOT_CONNECTED')
  for (const entry of validated.metricScores) {
    assert.equal(entry.score, 'NA')
  }
})

test('a connected call with no customer speech remains valid', () => {
  const validated = validateContentAuditOutput(
    output({ ...SILENT, callConnected: true }),
    CONTENT,
  )
  assert.equal(validated.callConnected, true)
  assert.equal(validated.customerSpoke, false)
  assert.equal(validated.overallScore, null)
})

test('a connected call that was spoken on is unaffected by the new rule', () => {
  const validated = validateContentAuditOutput(
    output({ callConnected: true, customerSpoke: true }),
    CONTENT,
  )
  assert.equal(validated.callConnected, true)
  assert.equal(validated.customerSpoke, true)
  assert.equal(validated.overallScore, '80.000')
})

test('the connection rule error stays typed and echoes no untrusted value', () => {
  const secret = 'Saanvi: hello Ms Synthetic, is 9876543210 still your number?'
  try {
    validateContentAuditOutput(
      output({
        callConnected: false,
        customerSpoke: true,
        managementSummary: 'Lead confirmed interest.',
        kserveFeedback: 'Agent closed well.',
        improvementFeedback: secret.replace(/\d/g, 'x'),
      }),
      CONTENT,
    )
    assert.fail('expected a validation error')
  } catch (error) {
    assert.ok(error instanceof CallAuditOutputError)
    assert.equal(error.code, 'INVALID_CALL_AUDIT_OUTPUT')
    assert.equal(error.field, 'customerSpoke')
    const text = `${error.message}\n${error.stack ?? ''}`
    assert.equal(text.includes('Saanvi'), false)
    assert.equal(text.includes('Ms Synthetic'), false)
    assert.equal(text.includes('Lead confirmed interest.'), false)
  }
})

test('a silent call cannot claim a meaningful conversation', () => {
  const error = expectOutputError(
    () =>
      validateContentAuditOutput(
        output({ ...SILENT, meaningfulConversation: true }),
        CONTENT,
      ),
  )
  assert.equal(error.field, 'meaningfulConversation')
})

test('a silent call cannot carry an intent other than NONE', () => {
  for (const intent of ['HIGH', 'WARM', 'LOW']) {
    const error = expectOutputError(
      () => validateContentAuditOutput(output({ ...SILENT, intent }), CONTENT),
      `${intent} must be rejected for a silent call`,
    )
    assert.equal(error.field, 'intent')
  }
})

test('a silent call cannot be qualified', () => {
  for (const qualification of ['QUALIFIED', 'NON_QUALIFIED', 'UNCERTAIN']) {
    const error = expectOutputError(
      () =>
        validateContentAuditOutput(
          output({ ...SILENT, qualification }),
          CONTENT,
        ),
    )
    assert.equal(error.field, 'qualification')
  }
})

test('a silent call cannot carry any numeric metric score', () => {
  const error = expectOutputError(
    () =>
      validateContentAuditOutput(
        output({
          ...SILENT,
          metricScores: scores('NA', { PROFESSIONALISM: 4 }),
        }),
        CONTENT,
      ),
  )
  assert.equal(error.field, 'metricScores')
})

test('an operational-only call is never accepted by this validator', () => {
  const error = expectOutputError(
    () =>
      validateContentAuditOutput(output(), { eligibility: 'operational_only' }),
  )
  assert.equal(error.field, 'eligibility')

  // Not even when the model volunteered a complete, internally consistent set.
  assert.throws(
    () =>
      validateContentAuditOutput(output(SILENT), {
        eligibility: 'operational_only',
      }),
    CallAuditOutputError,
  )
})

// ---------------------------------------------------------------------------
// Sanitized text
// ---------------------------------------------------------------------------

test('accepts bounded sanitized feedback and trims it', () => {
  const validated = validateContentAuditOutput(
    output({ managementSummary: '  Lead wants a callback next week.  ' }),
    CONTENT,
  )
  assert.equal(validated.managementSummary, 'Lead wants a callback next week.')
  assert.equal(
    validateContentAuditOutput(output({ kserveFeedback: '' }), CONTENT)
      .kserveFeedback,
    '',
  )
  assert.equal(
    validateContentAuditOutput(
      output({ improvementFeedback: 'x'.repeat(MAX_FEEDBACK_LENGTH) }),
      CONTENT,
    ).improvementFeedback.length,
    MAX_FEEDBACK_LENGTH,
  )
})

test('rejects unbounded or non-string feedback', () => {
  for (const field of [
    'managementSummary',
    'kserveFeedback',
    'improvementFeedback',
  ]) {
    for (const value of ['x'.repeat(MAX_FEEDBACK_LENGTH + 1), 42, null, {}, []]) {
      const error = expectOutputError(
        () => validateContentAuditOutput(output({ [field]: value }), CONTENT),
      )
      assert.equal(error.field, field)
    }
  }
})

test('rejects feedback carrying contact details, links, or control bytes', () => {
  for (const value of [
    'Send details to caller@example.invalid',
    'See https://vendor.example.invalid/view/1',
    'See www.example.invalid for details',
    'Call back on 9876543210',
    'Reach them at 98765 43210',
    'Broken text',
    'Belltext',
  ]) {
    const error = expectOutputError(
      () =>
        validateContentAuditOutput(
          output({ managementSummary: value }),
          CONTENT,
        ),
      `${JSON.stringify(value)} must be rejected`,
    )
    assert.equal(error.field, 'managementSummary')
  }
})

test('allows ordinary punctuation, newlines, and tabs', () => {
  const text = 'Wants a 5-day package.\nAsked about pricing.\tFollow up.'
  assert.equal(
    validateContentAuditOutput(output({ managementSummary: text }), CONTENT)
      .managementSummary,
    text,
  )
})

// ---------------------------------------------------------------------------
// Safe errors
// ---------------------------------------------------------------------------

test('errors are typed and name only the field and rule', () => {
  try {
    validateContentAuditOutput(output({ intent: 'MEDIUM' }), CONTENT)
    assert.fail('expected a validation error')
  } catch (error) {
    assert.ok(error instanceof CallAuditOutputError)
    assert.equal(error.code, 'INVALID_CALL_AUDIT_OUTPUT')
    assert.equal(error.field, 'intent')
    assert.equal(error.message, 'intent: is not an approved value')
  }
})

test('an error never leaks the untrusted value or the input payload', () => {
  const secret = 'Saanvi: hello Ms Synthetic, is 9876543210 still your number?'
  const cases: Array<Record<string, unknown>> = [
    { managementSummary: secret },
    { kserveFeedback: secret },
    { improvementFeedback: secret },
    { detailedOutcome: secret },
    { intent: secret },
    { transcript: secret },
  ]
  for (const overrides of cases) {
    try {
      validateContentAuditOutput(output(overrides), CONTENT)
      assert.fail(`expected a validation error for ${Object.keys(overrides)[0]}`)
    } catch (error) {
      assert.ok(error instanceof CallAuditOutputError)
      const text = `${error.message}\n${error.stack ?? ''}`
      assert.equal(
        text.includes(secret),
        false,
        'the error must not echo the untrusted value',
      )
      assert.equal(text.includes('9876543210'), false)
      assert.equal(text.includes('Saanvi'), false)
    }
  }
})

test('an oversized field error reports the limit, not the content', () => {
  try {
    validateContentAuditOutput(
      output({ kserveFeedback: 'secret-'.repeat(500) }),
      CONTENT,
    )
    assert.fail('expected a validation error')
  } catch (error) {
    assert.ok(error instanceof CallAuditOutputError)
    assert.equal(error.message.includes('secret-'), false)
    assert.match(error.message, /at most 2000 characters/)
  }
})
