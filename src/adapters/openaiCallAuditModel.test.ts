import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildContentAuditRequest,
  CallAuditModelRequestError,
  CONTENT_AUDIT_ERROR_CODES,
  CONTENT_AUDIT_SCHEMA_NAME,
  createContentAuditModelAdapter,
  MAX_TRANSCRIPT_LENGTH,
  type ActivatedContentAuditModel,
  type ContentAuditChatRequest,
  type ContentAuditChatResponse,
  type ContentAuditModelResult,
} from './openaiCallAuditModel.ts'
import { buildRuleActivation } from '../callaudit/ruleActivation.ts'
import { compileSystemPrompt } from '../callaudit/promptCompiler.ts'
import { buildContentAuditSchema } from '../callaudit/modelSchema.ts'
import { CALL_AUDIT_RUBRIC } from '../callaudit/rubric.ts'

const MODULE_SOURCE = readFileSync(
  new URL('./openaiCallAuditModel.ts', import.meta.url),
  'utf8',
)

// ---------------------------------------------------------------------------
// Synthetic fixtures. No real transcript, lead, or contact detail appears here.
// ---------------------------------------------------------------------------

/** A distinctive synthetic string, so a leak is unmistakable in an assertion. */
const TRANSCRIPT =
  'SYNTHETIC-TRANSCRIPT-MARKER-9f2a: Saanvi greeted the caller and the caller asked about a package.'

const ACTIVATION: ActivatedContentAuditModel = buildRuleActivation({
  versionLabel: 'v-test-1',
  businessPrompt: 'SYNTHETIC-BUSINESS-PROMPT-MARKER-4c81: weigh discovery highly.',
  modelProvider: 'openai',
  modelName: 'gpt-test-mini',
  modelVersion: 'gpt-test-mini-2026-01-01',
  temperature: '0.200',
})

function validModelOutput(): Record<string, unknown> {
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
    managementSummary: 'The caller showed interest and asked for written details.',
    kserveFeedback: 'Discovery was adequate; confirm the follow-up channel.',
    improvementFeedback: 'State the next step explicitly before closing.',
  }
}

interface FakeClientOptions {
  response?: ContentAuditChatResponse
  /** When set, the client throws instead of replying. */
  error?: unknown
}

function fakeClient(options: FakeClientOptions = {}) {
  const requests: ContentAuditChatRequest[] = []
  return {
    requests,
    client: {
      async createChatCompletion(request: ContentAuditChatRequest) {
        requests.push(request)
        if ('error' in options) {
          throw options.error
        }
        return (
          options.response ?? {
            choices: [{ message: { content: JSON.stringify(validModelOutput()) } }],
          }
        )
      },
    },
  }
}

/** A clock that advances a fixed amount per read, so latency is exact. */
function fakeClock(start: number, step: number) {
  let current = start - step
  return () => {
    current += step
    return current
  }
}

function adapterWith(options: FakeClientOptions = {}, step = 125) {
  const fake = fakeClient(options)
  return {
    requests: fake.requests,
    adapter: createContentAuditModelAdapter({
      client: fake.client,
      now: fakeClock(1_000, step),
    }),
  }
}

// ---------------------------------------------------------------------------
// Request building
// ---------------------------------------------------------------------------

test('the request compiles the system prompt from the activated settings', () => {
  const request = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  const systemMessage = request.messages[0]
  assert.equal(systemMessage?.role, 'system')
  assert.equal(
    systemMessage?.content,
    compileSystemPrompt({
      versionLabel: ACTIVATION.versionLabel,
      businessPrompt: ACTIVATION.businessPrompt,
      modelProvider: ACTIVATION.modelProvider,
      modelName: ACTIVATION.modelName,
      modelVersion: ACTIVATION.modelVersion,
      temperature: ACTIVATION.temperature,
    }),
  )
})

test('the request uses the strict structured-output schema', () => {
  const request = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(request.response_format.type, 'json_schema')
  assert.equal(request.response_format.json_schema.strict, true)
  assert.equal(request.response_format.json_schema.name, CONTENT_AUDIT_SCHEMA_NAME)
  assert.deepEqual(
    request.response_format.json_schema.schema,
    buildContentAuditSchema(),
  )
})

test('the request carries the activated model and converted temperature', () => {
  const request = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(request.model, ACTIVATION.modelName)
  assert.equal(request.temperature, 0.2)
  // The authoritative value is still the fixed three-decimal string.
  assert.equal(ACTIVATION.temperature, '0.200')
})

test('the transcript is sent only in the user message', () => {
  const request = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  const userMessages = request.messages.filter(
    (message) => message.role === 'user',
  )
  assert.equal(userMessages.length, 1)
  assert.ok(userMessages[0]?.content.includes(TRANSCRIPT))
  assert.equal(request.messages[0]?.content.includes(TRANSCRIPT), false)
})

test('safe operational context is included and unknown values stay unknown', () => {
  const withContext = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    context: { language: 'hi', durationSeconds: 96 },
  })
  const content = withContext.messages[1]?.content ?? ''
  assert.match(content, /Detected language: hi/)
  assert.match(content, /Recorded duration: 96 seconds/)

  const withoutContext = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  const bare = withoutContext.messages[1]?.content ?? ''
  assert.match(bare, /Detected language: unknown/)
  assert.match(bare, /Recorded duration: unknown/)
})

test('an invalid caller input throws a typed error naming only the field', () => {
  for (const transcript of ['   ', 'x'.repeat(MAX_TRANSCRIPT_LENGTH + 1)]) {
    assert.throws(
      () => buildContentAuditRequest({ activation: ACTIVATION, transcript }),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditModelRequestError)
        assert.equal(error.code, 'INVALID_CALL_AUDIT_MODEL_REQUEST')
        assert.equal(error.field, 'transcript')
        return true
      },
    )
  }
  assert.throws(
    () =>
      buildContentAuditRequest({
        activation: { ...ACTIVATION, temperature: '9.999' },
        transcript: TRANSCRIPT,
      }),
    /temperature/,
  )
  assert.throws(
    () =>
      buildContentAuditRequest({
        activation: ACTIVATION,
        transcript: TRANSCRIPT,
        context: { durationSeconds: -1 },
      }),
    /durationSeconds/,
  )
})

test('an oversized transcript error never quotes the transcript', () => {
  const oversized = `${TRANSCRIPT}${'x'.repeat(MAX_TRANSCRIPT_LENGTH)}`
  try {
    buildContentAuditRequest({ activation: ACTIVATION, transcript: oversized })
    assert.fail('expected a rejection')
  } catch (error) {
    assert.ok(error instanceof CallAuditModelRequestError)
    assert.equal(error.message.includes('SYNTHETIC-TRANSCRIPT-MARKER'), false)
    assert.equal(String((error as Error).stack).includes(TRANSCRIPT), false)
  }
})

// ---------------------------------------------------------------------------
// Success path
// ---------------------------------------------------------------------------

test('a valid reply returns validated output with derived fields', async () => {
  const { adapter } = adapterWith({
    response: {
      choices: [{ message: { content: JSON.stringify(validModelOutput()) } }],
      usage: { prompt_tokens: 1200, completion_tokens: 340, total_tokens: 1540 },
      _request_id: 'req_synthetic_1',
    },
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(result.status, 'succeeded')
  if (result.status !== 'succeeded') return
  assert.equal(result.output.detailedOutcome, 'Treatment Package for Resort')
  // Both are application-derived, never taken from the model.
  assert.equal(result.output.groupedOutcome, 'RESORT_HEALING')
  assert.equal(result.output.overallScore, '80.000')
  assert.equal(result.usage.provider, 'openai')
  assert.equal(result.usage.modelName, 'gpt-test-mini')
  assert.equal(result.usage.modelVersion, 'gpt-test-mini-2026-01-01')
  assert.equal(result.usage.requestId, 'req_synthetic_1')
  assert.deepEqual(
    [result.usage.inputTokens, result.usage.outputTokens, result.usage.totalTokens],
    ['1200', '340', '1540'],
  )
  assert.equal(result.usage.latencyMs, '125')
})

test('the grouped outcome and overall score are recomputed, not trusted', async () => {
  const { adapter } = adapterWith({
    response: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...validModelOutput(),
              groupedOutcome: 'Contacted',
              overallScore: '100.000',
            }),
          },
        },
      ],
    },
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  // A model that volunteered either field is rejected outright, so neither
  // value can reach a result.
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.invalidOutput)
})

test('non-numeric provider counts become null rather than a guess', async () => {
  const { adapter } = adapterWith({
    response: {
      choices: [{ message: { content: JSON.stringify(validModelOutput()) } }],
      usage: { prompt_tokens: 'many', completion_tokens: -5, total_tokens: 1.5 },
    },
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(result.status, 'succeeded')
  assert.deepEqual(
    [
      result.usage.inputTokens,
      result.usage.outputTokens,
      result.usage.totalTokens,
      result.usage.requestId,
    ],
    [null, null, null, null],
  )
})

// ---------------------------------------------------------------------------
// Refusal, invalid output, and transport failure are distinct
// ---------------------------------------------------------------------------

test('a refusal is its own outcome and its text is never returned', async () => {
  const { adapter } = adapterWith({
    response: {
      choices: [
        {
          message: {
            refusal:
              'I cannot help with SYNTHETIC-TRANSCRIPT-MARKER-9f2a content.',
            content: null,
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10 },
    },
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(result.status, 'refused')
  if (result.status !== 'refused') return
  assert.equal(result.failure.kind, 'refusal')
  assert.equal(result.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.refused)
  assert.equal(JSON.stringify(result).includes('cannot help'), false)
  // Usage facts are still captured for a refused attempt.
  assert.equal(result.usage.inputTokens, '10')
  assert.equal(result.usage.latencyMs, '125')
})

test('an empty reply and unparseable content are distinct invalid outputs', async () => {
  const empty = adapterWith({ response: { choices: [{ message: { content: '' } }] } })
  const emptyResult = await empty.adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(emptyResult.status, 'failed')
  if (emptyResult.status !== 'failed') return
  assert.equal(emptyResult.failure.kind, 'invalid_output')
  assert.equal(
    emptyResult.failure.errorCode,
    CONTENT_AUDIT_ERROR_CODES.emptyResponse,
  )

  const broken = adapterWith({
    response: { choices: [{ message: { content: '{ not json' } }] },
  })
  const brokenResult = await broken.adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(brokenResult.status, 'failed')
  if (brokenResult.status !== 'failed') return
  assert.equal(brokenResult.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.notJson)
})

test('output failing the application validator is an invalid output', async () => {
  const { adapter } = adapterWith({
    response: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              ...validModelOutput(),
              // The customer spoke, so a mandatory metric may not be NA.
              metricScores: CALL_AUDIT_RUBRIC.map((metric) => ({
                metric: metric.code,
                score: metric.naAllowedWhenCustomerSpoke ? 4 : 'NA',
              })),
            }),
          },
        },
      ],
    },
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.failure.kind, 'invalid_output')
  assert.equal(result.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.invalidOutput)
})

test('a client throw is a transport failure carrying no provider prose', async () => {
  const { adapter } = adapterWith({
    error: new Error(
      `provider rejected request body: ${TRANSCRIPT} (key sk-synthetic-abc)`,
    ),
  })
  const result = await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(result.status, 'failed')
  if (result.status !== 'failed') return
  assert.equal(result.failure.kind, 'transport')
  assert.equal(result.failure.errorCode, CONTENT_AUDIT_ERROR_CODES.requestFailed)
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('SYNTHETIC-TRANSCRIPT-MARKER'), false)
  assert.equal(serialized.includes('sk-synthetic'), false)
  assert.equal(serialized.includes('provider rejected'), false)
  // Model identity and elapsed time are still recorded for the attempt.
  assert.equal(result.usage.modelName, 'gpt-test-mini')
  assert.equal(result.usage.latencyMs, '125')
  assert.equal(result.usage.requestId, null)
})

test('the adapter sends exactly one request and never retries', async () => {
  const { adapter, requests } = adapterWith({ error: new Error('boom') })
  await adapter.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(requests.length, 1)
})

// ---------------------------------------------------------------------------
// Privacy guards
// ---------------------------------------------------------------------------

function serializeResult(result: ContentAuditModelResult): string {
  return JSON.stringify(result)
}

test('no returned result carries the transcript, prompt, or raw response', async () => {
  const cases: FakeClientOptions[] = [
    {
      response: {
        choices: [{ message: { content: JSON.stringify(validModelOutput()) } }],
      },
    },
    {
      response: {
        choices: [
          { message: { refusal: `refused: ${TRANSCRIPT}`, content: null } },
        ],
      },
    },
    { response: { choices: [{ message: { content: `garbage ${TRANSCRIPT}` } }] } },
    { error: new Error(TRANSCRIPT) },
  ]
  for (const options of cases) {
    const { adapter } = adapterWith(options)
    const result = await adapter.auditTranscript({
      activation: ACTIVATION,
      transcript: TRANSCRIPT,
    })
    const serialized = serializeResult(result)
    assert.equal(
      serialized.includes('SYNTHETIC-TRANSCRIPT-MARKER'),
      false,
      'the transcript must never be returned',
    )
    assert.equal(
      serialized.includes('SYNTHETIC-BUSINESS-PROMPT-MARKER'),
      false,
      'the compiled prompt must never be returned',
    )
    assert.equal(
      serialized.includes('SECTION 2 — LOCKED APPLICATION RULES'),
      false,
      'the compiled prompt must never be returned',
    )
    assert.equal(serialized.includes('garbage'), false)
    assert.equal(serialized.includes('refused:'), false)
  }
})

test('every emitted error code is a safe bounded machine code', () => {
  for (const code of Object.values(CONTENT_AUDIT_ERROR_CODES)) {
    assert.match(code, /^[A-Z][A-Z0-9_]*$/)
    assert.ok(code.length <= 80)
  }
})

test('the module carries no billing, source-table, or CRM dependency', () => {
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
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `openaiCallAuditModel.ts must not reference ${forbidden}`,
    )
  }
})

test('the module never logs or hashes anything', () => {
  for (const forbidden of [
    /console\./,
    /sha256/i,
    /createHash/,
    /process\.env/,
    /require\(/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `openaiCallAuditModel.ts must not use ${forbidden}`,
    )
  }
})

test('the module is independent of worker, API, UI, and persistence layers', () => {
  const imports = [...MODULE_SOURCE.matchAll(/from '([^']+)'/g)].map(
    (match) => match[1] as string,
  )
  assert.deepEqual(imports.sort(), [
    '../callaudit/modelOutput.ts',
    '../callaudit/modelSchema.ts',
    '../callaudit/promptCompiler.ts',
    '../callaudit/ruleActivation.ts',
    '../callaudit/ruleContract.ts',
    '../messaging/canonicalJson.ts',
  ])
})

test('temperature is converted to a number exactly once, at the boundary', () => {
  const conversions = [...MODULE_SOURCE.matchAll(/Number\(temperature\)/g)]
  assert.equal(conversions.length, 1)
  assert.equal(/parseFloat/.test(MODULE_SOURCE), false)
})
