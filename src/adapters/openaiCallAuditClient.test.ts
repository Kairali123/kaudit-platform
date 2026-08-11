import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CALL_AUDIT_MODEL_MAX_RETRIES,
  CALL_AUDIT_MODEL_TIMEOUT_MS,
  createOpenAiCallAuditModel,
  createOpenAiContentAuditChatClient,
  type OpenAiCallAuditClientInit,
  type OpenAiChatCompletionsClient,
} from './openaiCallAuditClient.ts'
import {
  buildContentAuditRequest,
  CONTENT_AUDIT_ERROR_CODES,
  type ActivatedContentAuditModel,
  type ContentAuditChatRequest,
  type ContentAuditChatResponse,
} from './openaiCallAuditModel.ts'
import { buildRuleActivation } from '../callaudit/ruleActivation.ts'
import { CALL_AUDIT_RUBRIC } from '../callaudit/rubric.ts'

/**
 * The SDK edge, driven entirely through the injected constructor seam. No test
 * here builds a real OpenAI client, reads an environment variable, or opens a
 * socket; a fake records what the factory constructed and what body reached
 * `chat.completions.create`.
 */

const MODULE_SOURCE = readFileSync(
  new URL('./openaiCallAuditClient.ts', import.meta.url),
  'utf8',
)

/**
 * Executable text only. The module's comments legitimately NAME the wire-format
 * concerns they explain are absent, so the re-implementation scan below reads
 * this rather than the prose.
 */
const MODULE_CODE = MODULE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(
  /^\s*\/\/.*$/gm,
  '',
)

// ---------------------------------------------------------------------------
// Synthetic fixtures. No real transcript, key, lead, or contact detail here.
// ---------------------------------------------------------------------------

const TRANSCRIPT =
  'SYNTHETIC-TRANSCRIPT-MARKER-7d31: Saanvi greeted the caller and the caller asked about a package.'

/** Padded so the factory's trim is observable, and obviously not a real key. */
const API_KEY = '  SYNTHETIC-API-KEY-MARKER-b40e  '
const TRIMMED_API_KEY = 'SYNTHETIC-API-KEY-MARKER-b40e'

const ACTIVATION: ActivatedContentAuditModel = buildRuleActivation({
  versionLabel: 'v-client-1',
  businessPrompt:
    'SYNTHETIC-BUSINESS-PROMPT-MARKER-2e77: weigh discovery highly.',
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

interface FakeSdkOptions {
  response?: ContentAuditChatResponse
  /** When present, `create` throws instead of replying. */
  error?: unknown
}

/**
 * Stands in for the SDK constructor. Records the init it was handed and every
 * body that reached `chat.completions.create`, by reference.
 */
function fakeSdk(options: FakeSdkOptions = {}) {
  const constructions: OpenAiCallAuditClientInit[] = []
  const requests: ContentAuditChatRequest[] = []
  return {
    constructions,
    requests,
    createClient(init: OpenAiCallAuditClientInit): OpenAiChatCompletionsClient {
      constructions.push(init)
      return {
        chat: {
          completions: {
            async create(request: ContentAuditChatRequest) {
              requests.push(request)
              if ('error' in options) {
                throw options.error
              }
              return (
                options.response ?? {
                  choices: [
                    { message: { content: JSON.stringify(validModelOutput()) } },
                  ],
                }
              )
            },
          },
        },
      }
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

function modelWith(options: FakeSdkOptions = {}, step = 125) {
  const sdk = fakeSdk(options)
  return {
    constructions: sdk.constructions,
    requests: sdk.requests,
    model: createOpenAiCallAuditModel(API_KEY, {
      createClient: sdk.createClient,
      now: fakeClock(1_000, step),
    }),
  }
}

// ---------------------------------------------------------------------------
// Construction
// ---------------------------------------------------------------------------

test('the factory requires a nonblank key and never echoes the value', () => {
  for (const blank of ['', '   ', '\t\n']) {
    assert.throws(
      () => createOpenAiCallAuditModel(blank, { createClient: fakeSdk().createClient }),
      (error: unknown) => {
        assert.ok(error instanceof Error)
        assert.match(error.message, /nonblank/i)
        return true
      },
    )
  }
})

test('a blank key fails before any client is constructed', () => {
  const sdk = fakeSdk()
  assert.throws(() =>
    createOpenAiCallAuditModel('   ', { createClient: sdk.createClient }),
  )
  assert.deepEqual(sdk.constructions, [])
})

test('a rejected key never reaches the error message', () => {
  const secret = 'SYNTHETIC-REJECTED-KEY-MARKER-c19f'
  try {
    // Only whitespace is blank, so a nonblank secret cannot reach this path;
    // the guard is asserted with a value that is blank AFTER trimming and the
    // message is checked to carry no input at all.
    createOpenAiCallAuditModel(' ', { createClient: fakeSdk().createClient })
    assert.fail('expected a blank key to be rejected')
  } catch (error) {
    assert.ok(error instanceof Error)
    assert.equal(error.message.includes(secret), false)
    assert.equal(error.message.includes('Bearer'), false)
  }
})

test('the client is constructed with the trimmed key and pinned limits', async () => {
  const built = modelWith()
  await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(built.constructions.length, 1)
  assert.deepEqual(built.constructions[0], {
    apiKey: TRIMMED_API_KEY,
    maxRetries: CALL_AUDIT_MODEL_MAX_RETRIES,
    timeout: CALL_AUDIT_MODEL_TIMEOUT_MS,
  })
})

test('the pinned limits are conservative: no SDK retry, a bounded timeout', () => {
  // A retry would resend the transcript to a paid provider behind the adapter's
  // documented one-request contract and inflate the latency it reports.
  assert.equal(CALL_AUDIT_MODEL_MAX_RETRIES, 0)
  assert.ok(Number.isSafeInteger(CALL_AUDIT_MODEL_TIMEOUT_MS))
  assert.ok(CALL_AUDIT_MODEL_TIMEOUT_MS > 0)
  assert.ok(CALL_AUDIT_MODEL_TIMEOUT_MS <= 120_000)
})

test('the client is constructed once and reused across attempts', async () => {
  const built = modelWith()
  await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  assert.equal(built.constructions.length, 1)
  assert.equal(built.requests.length, 2)
})

// ---------------------------------------------------------------------------
// Request forwarding
// ---------------------------------------------------------------------------

test('the exact request body built by the pure module is forwarded unchanged', async () => {
  const built = modelWith()
  await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
    context: { language: 'hi', durationSeconds: 92 },
  })

  assert.equal(built.requests.length, 1)
  const forwarded = built.requests[0]
  assert.ok(forwarded)
  // Byte-for-byte the body the tested builder produces: this layer adds,
  // removes, and rewrites nothing on the way to the SDK.
  assert.deepEqual(
    forwarded,
    buildContentAuditRequest({
      activation: ACTIVATION,
      transcript: TRANSCRIPT,
      context: { language: 'hi', durationSeconds: 92 },
    }),
  )
})

test('the wrapper forwards the very same object, not a copy', async () => {
  const requests: ContentAuditChatRequest[] = []
  const client = createOpenAiContentAuditChatClient({
    chat: {
      completions: {
        async create(request: ContentAuditChatRequest) {
          requests.push(request)
          return { choices: [{ message: { content: '{}' } }] }
        },
      },
    },
  })
  const body = buildContentAuditRequest({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })
  await client.createChatCompletion(body)
  assert.equal(requests.length, 1)
  assert.equal(requests[0], body)
})

test('the transcript reaches the SDK only inside the request body', async () => {
  const built = modelWith()
  const result = await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })

  const forwarded = JSON.stringify(built.requests[0])
  assert.ok(forwarded.includes(TRANSCRIPT))
  // ...and nowhere on the way back out.
  assert.equal(JSON.stringify(result).includes(TRANSCRIPT), false)
  assert.equal(
    JSON.stringify(result).includes(ACTIVATION.businessPrompt),
    false,
  )
})

// ---------------------------------------------------------------------------
// Reply mapping through the sanitized adapter output
// ---------------------------------------------------------------------------

test('an SDK reply maps to validated output with request id and usage facts', async () => {
  const built = modelWith({
    response: {
      choices: [{ message: { content: JSON.stringify(validModelOutput()) } }],
      usage: {
        prompt_tokens: 1_811,
        completion_tokens: 402,
        total_tokens: 2_213,
      },
      _request_id: 'req_SYNTHETIC_9c4d',
    },
  })

  const result = await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })

  assert.equal(result.status, 'succeeded')
  assert.deepEqual(result.usage, {
    provider: 'openai',
    modelName: 'gpt-test-mini',
    modelVersion: 'gpt-test-mini-2026-01-01',
    requestId: 'req_SYNTHETIC_9c4d',
    inputTokens: '1811',
    outputTokens: '402',
    totalTokens: '2213',
    latencyMs: '125',
  })
  if (result.status === 'succeeded') {
    assert.equal(result.output.intent, 'WARM')
  }
})

test('a missing request id and missing usage map to nulls, not guesses', async () => {
  const built = modelWith({
    response: {
      choices: [{ message: { content: JSON.stringify(validModelOutput()) } }],
    },
  })

  const result = await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })

  assert.equal(result.usage.requestId, null)
  assert.equal(result.usage.inputTokens, null)
  assert.equal(result.usage.outputTokens, null)
  assert.equal(result.usage.totalTokens, null)
})

test('a refusal from the SDK becomes a bounded code, never the refusal text', async () => {
  const refusal = 'SYNTHETIC-REFUSAL-MARKER-51ab: I cannot help with that.'
  const built = modelWith({
    response: {
      choices: [{ message: { content: null, refusal } }],
      usage: { prompt_tokens: 12, completion_tokens: 0, total_tokens: 12 },
      _request_id: 'req_SYNTHETIC_refused',
    },
  })

  const result = await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })

  assert.equal(result.status, 'refused')
  if (result.status === 'refused') {
    assert.deepEqual(result.failure, {
      kind: 'refusal',
      errorCode: CONTENT_AUDIT_ERROR_CODES.refused,
    })
  }
  assert.equal(result.usage.requestId, 'req_SYNTHETIC_refused')
  assert.equal(result.usage.inputTokens, '12')
  assert.equal(JSON.stringify(result).includes(refusal), false)
})

test('an SDK throw becomes a transport failure and drops the provider prose', async () => {
  const prose = `SYNTHETIC-PROVIDER-ERROR-MARKER-6be2 quoting ${TRANSCRIPT}`
  const built = modelWith({ error: new Error(prose) })

  const result = await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.deepEqual(result.failure, {
      kind: 'transport',
      errorCode: CONTENT_AUDIT_ERROR_CODES.requestFailed,
    })
  }
  const serialized = JSON.stringify(result)
  assert.equal(serialized.includes('SYNTHETIC-PROVIDER-ERROR-MARKER-6be2'), false)
  assert.equal(serialized.includes(TRANSCRIPT), false)
  // The attempt is still reportable: identity and latency survive the failure.
  assert.equal(result.usage.provider, 'openai')
  assert.equal(result.usage.latencyMs, '125')
})

test('a malformed SDK reply becomes a bounded invalid-output code', async () => {
  const built = modelWith({
    response: {
      choices: [{ message: { content: 'SYNTHETIC-NOT-JSON-MARKER-ff01' } }],
    },
  })

  const result = await built.model.auditTranscript({
    activation: ACTIVATION,
    transcript: TRANSCRIPT,
  })

  assert.equal(result.status, 'failed')
  if (result.status === 'failed') {
    assert.equal(
      result.failure.errorCode,
      CONTENT_AUDIT_ERROR_CODES.notJson,
    )
  }
  assert.equal(
    JSON.stringify(result).includes('SYNTHETIC-NOT-JSON-MARKER-ff01'),
    false,
  )
})

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

test('the SDK edge reads no environment variable and owns no configuration', () => {
  for (const forbidden of [/process\.env/, /dotenv/, /require\(/]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `openaiCallAuditClient.ts must not use ${forbidden}`,
    )
  }
})

test('the SDK edge never logs or hashes anything', () => {
  for (const forbidden of [
    /console\./,
    /sha256/i,
    /createHash/,
    /process\.stdout/,
    /process\.stderr/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_SOURCE),
      false,
      `openaiCallAuditClient.ts must not use ${forbidden}`,
    )
  }
})

test('the SDK edge carries no billing, source-table, or CRM dependency', () => {
  for (const forbidden of [
    /\bprice\b/i,
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
      `openaiCallAuditClient.ts must not reference ${forbidden}`,
    )
  }
})

test('the SDK edge depends only on the SDK and the pure adapter module', () => {
  const imports = [...MODULE_SOURCE.matchAll(/from '([^']+)'/g)].map(
    (match) => match[1] as string,
  )
  assert.deepEqual(imports.sort(), ['./openaiCallAuditModel.ts', 'openai'])
})

test('the SDK edge does not re-implement the request body or the reply reading', () => {
  // Everything about the wire format stays in the tested pure module. If this
  // file ever grows a schema, a message array, or a JSON.parse, the assertions
  // above stop covering what actually gets sent.
  for (const forbidden of [
    /json_schema/,
    /\bmessages\b/,
    /JSON\.parse/,
    /response_format/,
    /\btemperature\b/,
  ]) {
    assert.equal(
      forbidden.test(MODULE_CODE),
      false,
      `openaiCallAuditClient.ts must not contain ${forbidden}`,
    )
  }
})
