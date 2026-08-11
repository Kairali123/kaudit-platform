import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALL_AUDIT_RULE_TEST_BOUNDARY,
  CallAuditRuleTestError,
  runCallAuditRuleTest,
  type CallAuditRuleTestResult,
} from './ruleTestLab.ts'
import { buildRuleActivation } from './ruleActivation.ts'
import { CallAuditRuleError } from './ruleContract.ts'
import { CALL_AUDIT_RUBRIC } from './rubric.ts'
import {
  CallAuditModelRequestError,
  CONTENT_AUDIT_ERROR_CODES,
  createContentAuditModelAdapter,
  MAX_TRANSCRIPT_LENGTH,
  type ContentAuditModelRequest,
  type ContentAuditModelResult,
  type ContentAuditUsageFacts,
} from '../adapters/openaiCallAuditModel.ts'

const MODULE_SOURCE = readFileSync(
  new URL('./ruleTestLab.ts', import.meta.url),
  'utf8',
)

// ---------------------------------------------------------------------------
// Synthetic fixtures. No real transcript, lead, or contact detail appears here.
// ---------------------------------------------------------------------------

/** A distinctive synthetic string, so a leak is unmistakable in an assertion. */
const TRANSCRIPT = [
  'SYNTHETIC-TRANSCRIPT-MARKER-7b31',
  'Saanvi: greeted the caller and offered to explain the programme.',
  'Caller: asked what a stay would involve.',
].join('\n')

const ACTIVATION = buildRuleActivation({
  versionLabel: 'v-lab-1',
  businessPrompt:
    'SYNTHETIC-BUSINESS-PROMPT-MARKER-2d47: weigh discovery highly.',
  modelProvider: 'openai',
  modelName: 'gpt-test-mini',
  modelVersion: 'gpt-test-mini-2026-01-01',
  temperature: '0.200',
})

function usageFacts(): ContentAuditUsageFacts {
  return {
    provider: 'openai',
    modelName: 'gpt-test-mini',
    modelVersion: 'gpt-test-mini-2026-01-01',
    requestId: 'req_synthetic_lab_1',
    inputTokens: '1200',
    outputTokens: '340',
    totalTokens: '1540',
    latencyMs: '125',
  }
}

function validatedOutput() {
  return {
    callConnected: true,
    customerSpoke: true,
    meaningfulConversation: true,
    intent: 'WARM',
    detailedOutcome: 'Treatment Package for Resort',
    qualification: 'QUALIFIED',
    nextAction: 'SEND_DETAILS_EMAIL',
    confidence: 0.75,
    metricScores: CALL_AUDIT_RUBRIC.map((metric) => ({
      metric: metric.code,
      score: 4,
    })),
    issueFlags: ['WEAK_NEXT_STEP'],
    managementSummary:
      'SYNTHETIC-SUMMARY-MARKER-51ac: the caller asked for written details.',
    kserveFeedback: 'SYNTHETIC-FEEDBACK-MARKER-51ac: confirm the next channel.',
    improvementFeedback: 'SYNTHETIC-IMPROVEMENT-MARKER-51ac: state the step.',
  }
}

/** Drives the port from a canned outcome and records what it was asked. */
function fakeModel(outcome: ContentAuditModelResult | { throws: unknown }) {
  const requests: ContentAuditModelRequest[] = []
  return {
    requests,
    model: {
      async auditTranscript(request: ContentAuditModelRequest) {
        requests.push(request)
        if ('throws' in outcome) {
          throw outcome.throws
        }
        return outcome
      },
    },
  }
}

/**
 * Produces a genuinely validated output by running the real adapter over a fake
 * client, rather than hand-building a `ValidatedContentAuditOutput`: the
 * projection is then asserted against a shape a validator actually approved,
 * including the two application-derived fields.
 */
async function realValidatedOutput() {
  const adapter = createContentAuditModelAdapter({
    client: {
      async createChatCompletion() {
        return {
          choices: [{ message: { content: JSON.stringify(validatedOutput()) } }],
        }
      },
    },
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(result.status, 'succeeded')
  if (result.status !== 'succeeded') throw new Error('fixture did not validate')
  return result.output
}

// ---------------------------------------------------------------------------
// Success
// ---------------------------------------------------------------------------

test('a succeeded test returns the inspectable output and safe usage facts', async () => {
  const output = await realValidatedOutput()
  const { model } = fakeModel({ status: 'succeeded', output, usage: usageFacts() })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    model,
  })

  assert.equal(result.status, 'succeeded')
  if (result.status !== 'succeeded') return
  assert.equal(result.output.intent, 'WARM')
  assert.equal(result.output.detailedOutcome, 'Treatment Package for Resort')
  // Both are application-derived, and survive the projection unchanged.
  assert.equal(result.output.groupedOutcome, 'RESORT_HEALING')
  assert.equal(result.output.overallScore, '80.000')
  assert.equal(result.output.qualification, 'QUALIFIED')
  assert.equal(result.output.nextAction, 'SEND_DETAILS_EMAIL')
  assert.equal(result.output.confidence, 0.75)
  assert.deepEqual(result.output.issueFlags, ['WEAK_NEXT_STEP'])
  assert.equal(result.output.metricScores.length, CALL_AUDIT_RUBRIC.length)
  assert.deepEqual(result.usage, usageFacts())
})

test('the free-text feedback is reported as lengths, never as text', async () => {
  const output = await realValidatedOutput()
  const { model } = fakeModel({ status: 'succeeded', output, usage: usageFacts() })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    model,
  })
  assert.equal(result.status, 'succeeded')
  if (result.status !== 'succeeded') return
  assert.deepEqual(result.output.feedbackLengths, {
    managementSummaryCharacterCount: output.managementSummary.length,
    kserveFeedbackCharacterCount: output.kserveFeedback.length,
    improvementFeedbackCharacterCount: output.improvementFeedback.length,
  })
  const serialized = JSON.stringify(result)
  for (const marker of [
    'SYNTHETIC-SUMMARY-MARKER',
    'SYNTHETIC-FEEDBACK-MARKER',
    'SYNTHETIC-IMPROVEMENT-MARKER',
  ]) {
    assert.equal(
      serialized.includes(marker),
      false,
      'model prose derived from the transcript must not be returned',
    )
  }
})

test('metadata identifies the version and the text without revealing content', async () => {
  const output = await realValidatedOutput()
  const { model } = fakeModel({ status: 'succeeded', output, usage: usageFacts() })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    context: { language: 'hi', durationSeconds: 96 },
    model,
  })
  assert.deepEqual(result.metadata, {
    versionLabel: 'v-lab-1',
    modelProvider: 'openai',
    modelName: 'gpt-test-mini',
    modelVersion: 'gpt-test-mini-2026-01-01',
    // The fixed three-decimal string the administrator approved, not a float.
    temperature: '0.200',
    transcriptCharacterCount: TRANSCRIPT.length,
    transcriptLineCount: 3,
    context: { language: 'hi', durationSeconds: 96 },
  })
})

// ---------------------------------------------------------------------------
// The port is called once, with the transcript and only safe context
// ---------------------------------------------------------------------------

test('the port is called exactly once with the transcript and safe context', async () => {
  const output = await realValidatedOutput()
  const { model, requests } = fakeModel({
    status: 'succeeded',
    output,
    usage: usageFacts(),
  })
  await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    context: { language: 'hi', durationSeconds: 96 },
    model,
  })
  assert.equal(requests.length, 1)
  const sent = requests[0]
  assert.equal(sent?.transcript, TRANSCRIPT)
  assert.equal(sent?.activation, ACTIVATION)
  assert.deepEqual(sent?.context, { language: 'hi', durationSeconds: 96 })
})

test('omitted context is sent as unknown rather than invented', async () => {
  const output = await realValidatedOutput()
  const { model, requests } = fakeModel({
    status: 'succeeded',
    output,
    usage: usageFacts(),
  })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    model,
  })
  assert.deepEqual(requests[0]?.context, {
    language: null,
    durationSeconds: null,
  })
  assert.deepEqual(result.metadata.context, {
    language: null,
    durationSeconds: null,
  })
})

test('an extra context property never reaches the port', async () => {
  const output = await realValidatedOutput()
  const { model, requests } = fakeModel({
    status: 'succeeded',
    output,
    usage: usageFacts(),
  })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    // A surface that attached identity to the context is rejected by the type
    // system; the cast proves the runtime drops it as well.
    context: {
      language: 'hi',
      durationSeconds: 96,
      leadId: 'SYNTHETIC-LEAD-MARKER-0001',
      mobile: '+10000000000',
    } as never,
    model,
  })
  assert.deepEqual(Object.keys(requests[0]?.context ?? {}).sort(), [
    'durationSeconds',
    'language',
  ])
  assert.equal(
    JSON.stringify(result).includes('SYNTHETIC-LEAD-MARKER'),
    false,
  )
})

// ---------------------------------------------------------------------------
// Refused and failed are returned, not thrown
// ---------------------------------------------------------------------------

test('a refusal is returned as a coded outcome carrying no provider prose', async () => {
  const { model } = fakeModel({
    status: 'refused',
    failure: {
      kind: 'refusal',
      errorCode: CONTENT_AUDIT_ERROR_CODES.refused,
    },
    usage: usageFacts(),
  })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    model,
  })
  assert.equal(result.status, 'refused')
  if (result.status !== 'refused') return
  assert.equal(result.failure.kind, 'refusal')
  assert.equal(result.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.refused)
  assert.deepEqual(Object.keys(result.failure).sort(), ['errorCode', 'kind'])
  // Usage facts are still reported for a refused attempt.
  assert.equal(result.usage.latencyMs, '125')
})

test('an invalid output and a transport failure stay distinct failures', async () => {
  for (const kind of ['invalid_output', 'transport'] as const) {
    const errorCode =
      kind === 'invalid_output'
        ? CONTENT_AUDIT_ERROR_CODES.invalidOutput
        : CONTENT_AUDIT_ERROR_CODES.requestFailed
    const { model } = fakeModel({
      status: 'failed',
      failure: { kind, errorCode },
      usage: usageFacts(),
    })
    const result = await runCallAuditRuleTest({
      activation: ACTIVATION,
      transcript: TRANSCRIPT,
      model,
    })
    assert.equal(result.status, 'failed')
    if (result.status !== 'failed') return
    assert.equal(result.failure.kind, kind)
    assert.equal(result.failure.errorCode, errorCode)
    assert.deepEqual(result.usage, usageFacts())
  }
})

test('a thrown port becomes a coded transport failure with no usage facts', async () => {
  const { model } = fakeModel({
    throws: new Error(
      `provider rejected request body: ${TRANSCRIPT} (key sk-synthetic-abc)`,
    ),
  })
  const result = await runCallAuditRuleTest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    model,
  })
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.failure.kind, 'transport')
  assert.equal(result.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.requestFailed)
  // Null rather than an invented zero: a throw measured nothing.
  assert.equal(result.usage, null)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('SYNTHETIC-TRANSCRIPT-MARKER'), false)
  assert.equal(serialized.includes('sk-synthetic'), false)
  assert.equal(serialized.includes('provider rejected'), false)
  // Metadata still explains what was tested.
  assert.equal(result.metadata.versionLabel, 'v-lab-1')
})

test('every emitted failure code is a safe bounded machine code', async () => {
  for (const errorCode of Object.values(CONTENT_AUDIT_ERROR_CODES)) {
    assert.match(errorCode, /^[A-Z][A-Z0-9_]*$/)
    assert.ok(errorCode.length <= 80)
  }
})

// ---------------------------------------------------------------------------
// Caller-side input errors throw, and never quote what was submitted
// ---------------------------------------------------------------------------

test('a missing or unusable port throws a typed field-named error', async () => {
  await assert.rejects(
    () =>
      runCallAuditRuleTest({
        activation: ACTIVATION,
        transcript: TRANSCRIPT,
      } as never),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditRuleTestError)
      assert.equal(error.code, 'INVALID_CALL_AUDIT_RULE_TEST')
      assert.equal(error.field, 'model')
      return true
    },
  )
  await assert.rejects(
    () =>
      runCallAuditRuleTest({
        activation: ACTIVATION,
        transcript: TRANSCRIPT,
        model: { auditTranscript: 'not a function' } as never,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditRuleTestError)
      assert.equal(error.field, 'model.auditTranscript')
      return true
    },
  )
  await assert.rejects(() => runCallAuditRuleTest(null as never), /request/)
})

test('a non-string transcript throws before the port is touched', async () => {
  const output = await realValidatedOutput()
  const { model, requests } = fakeModel({
    status: 'succeeded',
    output,
    usage: usageFacts(),
  })
  await assert.rejects(
    () =>
      runCallAuditRuleTest({
        activation: ACTIVATION,
        transcript: { text: 'SYNTHETIC-TRANSCRIPT-MARKER-7b31' } as never,
        model,
      }),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditRuleTestError)
      assert.equal(error.field, 'transcript')
      return true
    },
  )
  assert.equal(requests.length, 0)
})

test('an invalid rule version throws the contract error and spends nothing', async () => {
  const output = await realValidatedOutput()
  const { model, requests } = fakeModel({
    status: 'succeeded',
    output,
    usage: usageFacts(),
  })
  await assert.rejects(
    () =>
      runCallAuditRuleTest({
        activation: { ...ACTIVATION, temperature: '9.999' },
        transcript: TRANSCRIPT,
        model,
      }),
    (error: unknown) => {
      // The rule contract validator stays authoritative; its error is already
      // typed, field-named, and free of submitted values.
      assert.ok(error instanceof CallAuditRuleError)
      assert.equal(error.field, 'temperature')
      return true
    },
  )
  assert.equal(requests.length, 0)
})

test('transcript bounds are delegated to the adapter, not restated', async () => {
  // The real adapter over a fake client: a rejected transcript never reaches
  // the client, so nothing was spent on it.
  const sent: unknown[] = []
  const adapter = createContentAuditModelAdapter({
    client: {
      async createChatCompletion(request) {
        sent.push(request)
        return { choices: [{ message: { content: '{}' } }] }
      },
    },
  })
  for (const transcript of ['   ', 'x'.repeat(MAX_TRANSCRIPT_LENGTH + 1)]) {
    await assert.rejects(
      () =>
        runCallAuditRuleTest({
          activation: ACTIVATION,
          transcript,
          model: adapter,
        }),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditModelRequestError)
        assert.equal(error.field, 'transcript')
        return true
      },
    )
  }
  assert.equal(sent.length, 0)
  assert.equal(/MAX_TRANSCRIPT_LENGTH/.test(MODULE_SOURCE), false)
})

test('an input error never quotes the submitted transcript', async () => {
  const oversized = `${TRANSCRIPT}${'x'.repeat(MAX_TRANSCRIPT_LENGTH)}`
  const adapter = createContentAuditModelAdapter({
    client: {
      async createChatCompletion() {
        return { choices: [{ message: { content: '{}' } }] }
      },
    },
  })
  try {
    await runCallAuditRuleTest({
      activation: ACTIVATION,
      transcript: oversized,
      model: adapter,
    })
    assert.fail('expected a rejection')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.message.includes('SYNTHETIC-TRANSCRIPT-MARKER'), false)
    assert.equal(String(error.stack).includes('SYNTHETIC-TRANSCRIPT'), false)
  }
})

// ---------------------------------------------------------------------------
// Privacy guards over every outcome
// ---------------------------------------------------------------------------

/** Every key name anywhere in the DTO, so the shape itself can be pinned. */
function keysOf(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) keysOf(entry, found)
    return found
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key)
      keysOf(entry, found)
    }
  }
  return found
}

const FORBIDDEN_KEYS = [
  'transcript',
  'text',
  'prompt',
  'businessPrompt',
  'systemPrompt',
  'response',
  'rawResponse',
  'message',
  'refusal',
  'leadId',
  'lead_id',
  'taskId',
  'callId',
  'sourceRefId',
  'sourceRowId',
  'clientName',
  'name',
  'mobile',
  'phone',
  'email',
  'url',
  'transcriptionViewUrl',
  'recordingUrl',
  'amount',
  'rate',
  'cost',
  'price',
  'currency',
  'invoice',
  'billable',
  'managementSummary',
  'kserveFeedback',
  'improvementFeedback',
]

const FORBIDDEN_VALUE_PATTERNS = [
  /SYNTHETIC-TRANSCRIPT-MARKER/,
  /SYNTHETIC-BUSINESS-PROMPT-MARKER/,
  /SYNTHETIC-SUMMARY-MARKER/,
  /SYNTHETIC-FEEDBACK-MARKER/,
  /SYNTHETIC-IMPROVEMENT-MARKER/,
  /SECTION 2 — LOCKED APPLICATION RULES/,
  /\bprice\b/i,
  /\brate\b/i,
  /\bcost\b/i,
  /\bamount\b/i,
  /\bcurrency\b/i,
  /\binvoice\b/i,
  /\bbillable\b/i,
]

test('no outcome carries the transcript, prompt, source identity, or money', async () => {
  const output = await realValidatedOutput()
  const outcomes: (ContentAuditModelResult | { throws: unknown })[] = [
    { status: 'succeeded', output, usage: usageFacts() },
    {
      status: 'refused',
      failure: { kind: 'refusal', errorCode: CONTENT_AUDIT_ERROR_CODES.refused },
      usage: usageFacts(),
    },
    {
      status: 'failed',
      failure: {
        kind: 'invalid_output',
        errorCode: CONTENT_AUDIT_ERROR_CODES.invalidOutput,
      },
      usage: usageFacts(),
    },
    { throws: new Error(`refused: ${TRANSCRIPT}`) },
  ]
  for (const outcome of outcomes) {
    const { model } = fakeModel(outcome)
    const result: CallAuditRuleTestResult = await runCallAuditRuleTest({
      activation: ACTIVATION,
      transcript: TRANSCRIPT,
      context: { language: 'hi', durationSeconds: 96 },
      model,
    })
    const keys = keysOf(result)
    for (const forbidden of FORBIDDEN_KEYS) {
      assert.equal(
        keys.has(forbidden),
        false,
        `the result must not carry a '${forbidden}' field`,
      )
    }
    const serialized = JSON.stringify(result)
    for (const pattern of FORBIDDEN_VALUE_PATTERNS) {
      assert.equal(
        pattern.test(serialized),
        false,
        `the serialized result must not match ${pattern}`,
      )
    }
  }
})

test('the boundary statement promises no storage and no return of the text', () => {
  assert.match(CALL_AUDIT_RULE_TEST_BOUNDARY, /never stored/)
  assert.equal(
    FORBIDDEN_VALUE_PATTERNS.some((pattern) =>
      pattern.test(CALL_AUDIT_RULE_TEST_BOUNDARY),
    ),
    false,
  )
})

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

test('the module imports no billing, source, CRM, or database code', () => {
  const imports = [...MODULE_SOURCE.matchAll(/from '([^']+)'/g)].map(
    (match) => match[1] as string,
  )
  assert.deepEqual(imports.sort(), [
    '../adapters/openaiCallAuditModel.ts',
    './modelOutput.ts',
    './ruleContract.ts',
  ])
})

test('the module carries no billing, source-table, CRM, or SQL vocabulary', () => {
  for (const forbidden of [
    /\bprice\b/i,
    /\brate\b/i,
    /\bcost\b/i,
    /\bamount\b/i,
    /\bcurrency\b/i,
    /\binvoice\b/i,
    /\bbillable\b/i,
    /ai_voice_leads_received/i,
    /\bkcrm\b/i,
    /\bmysql\b/i,
    /\bpool\b/i,
    /\bINSERT\b/,
    /\bSELECT\b/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `ruleTestLab.ts must not reference ${forbidden}`,
    )
  }
})

test('this test file runs under the call audit test script', () => {
  const manifest = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
  ) as { scripts: Record<string, string> }
  const script = manifest.scripts['test:callaudit'] ?? ''
  // The glob is what covers this file; pinning it keeps a future narrowing of
  // the script from silently dropping the module's guards.
  assert.ok(script.includes('src/callaudit/*.test.ts'))
})

test('the module never logs, hashes, or persists the transcript', () => {
  for (const forbidden of [
    /console\./,
    /sha256/i,
    /createHash/,
    /process\.env/,
    /require\(/,
    /\bsave\b/i,
    /\bpersist[a-z]*\(/i,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `ruleTestLab.ts must not use ${forbidden}`,
    )
  }
})
