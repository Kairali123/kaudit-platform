import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  auditOneCall,
  mergeTranscriptSegments,
  projectVerifiedCharge,
  validateClassification,
} from './core.ts'
import type {
  ClassificationDecisionSignals,
  ModelClassification,
  ReauditAnalysis,
  ReauditCandidate,
  ReauditAi,
} from './types.ts'

function reviewedClassification(options: {
  proposed: ModelClassification['category']
  signals: ClassificationDecisionSignals
  customerSpoke?: boolean
}): ModelClassification {
  return {
    model: {
      provider: 'openai',
      name: 'synthetic-classifier',
      version: 'synthetic-v1',
    },
    category: options.proposed,
    confidence: '0.90000000',
    customerBlockNumbers: options.customerSpoke ? [2] : [],
    unclearBlockNumbers: [],
    customerSpoke: options.customerSpoke ?? false,
    lastMeaningfulCustomerExchangeMs: options.customerSpoke ? 2_000 : null,
    remarks: 'Synthetic evidence-based rationale.',
    disputeRecommended: false,
    decisionSignals: options.signals,
  }
}

const candidate: ReauditCandidate = {
  callId: 'synthetic-call',
  artifactId: 'synthetic-artifact',
  sourceUrl:
    'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/synthetic.ogg',
  baselineSha256: null,
  claimedDurationMs: 125_000,
  connectedDurationMs: 120_000,
  vendorBilledMinutes: '2.00000000',
}

test('merges fragments using the approved pause, duration, and character limits', () => {
  const blocks = mergeTranscriptSegments([
    { startMs: 0, endMs: 500, text: 'Hello' },
    { startMs: 700, endMs: 1_000, text: 'there' },
    { startMs: 2_000, endMs: 2_300, text: 'Reply' },
  ])
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0]?.text, 'Hello there')
  assert.equal(blocks[1]?.number, 2)
})

test('classification derives the conversation end from customer blocks', () => {
  const raw: ModelClassification = {
    model: {
      provider: 'openai',
      name: 'synthetic-classifier',
      version: 'synthetic-v1',
    },
    category: 'OK',
    confidence: '0.90000000',
    customerBlockNumbers: [1],
    unclearBlockNumbers: [],
    customerSpoke: false,
    lastMeaningfulCustomerExchangeMs: 5_000,
    remarks: 'Synthetic',
    disputeRecommended: false,
  }
  const result = validateClassification(
    raw,
    [{ number: 1, startMs: 0, endMs: 1_234, text: 'Synthetic' }],
    4_000,
  )
  assert.equal(result.customerSpoke, true)
  assert.equal(result.lastMeaningfulCustomerExchangeMs, 1_234)
})

test('classification validation rejects user silence when customer speech exists', () => {
  const raw: ModelClassification = {
    model: {
      provider: 'openai',
      name: 'synthetic-classifier',
      version: 'synthetic-v1',
    },
    category: 'USER_SILENCE',
    confidence: '0.90000000',
    customerBlockNumbers: [1, 2],
    unclearBlockNumbers: [],
    customerSpoke: true,
    lastMeaningfulCustomerExchangeMs: 4_000,
    remarks: 'Synthetic customer speaks while the agent is absent.',
    disputeRecommended: true,
  }
  assert.throws(
    () =>
      validateClassification(
        raw,
        [
          { number: 1, startMs: 0, endMs: 2_000, text: 'Synthetic request' },
          { number: 2, startMs: 2_500, endMs: 4_000, text: 'Hello?' },
        ],
        5_000,
      ),
    /User-silence result cannot contain customer speech/,
  )
})

test('classification validation rejects user silence without identified agent speech', () => {
  const raw: ModelClassification = {
    model: {
      provider: 'openai',
      name: 'synthetic-classifier',
      version: 'synthetic-v1',
    },
    category: 'USER_SILENCE',
    confidence: '0.90000000',
    customerBlockNumbers: [],
    unclearBlockNumbers: [1],
    customerSpoke: false,
    lastMeaningfulCustomerExchangeMs: null,
    remarks: 'Synthetic ambiguous speech.',
    disputeRecommended: true,
  }
  assert.throws(
    () =>
      validateClassification(
        raw,
        [{ number: 1, startMs: 0, endMs: 2_000, text: 'Hello?' }],
        3_000,
      ),
    /requires positively identified agent speech/,
  )
})

test('classification clears redundant customer facts when no customer block exists', () => {
  const raw: ModelClassification = {
    model: {
      provider: 'openai',
      name: 'synthetic-classifier',
      version: 'synthetic-v1',
    },
    category: 'AGENT_FAILURE',
    confidence: '0.90000000',
    customerBlockNumbers: [],
    unclearBlockNumbers: [],
    customerSpoke: true,
    lastMeaningfulCustomerExchangeMs: 2_000,
    remarks: 'Synthetic inconsistent role assignment.',
    disputeRecommended: true,
  }
  const result = validateClassification(
    raw,
    [{ number: 1, startMs: 0, endMs: 2_000, text: 'Synthetic request' }],
    3_000,
  )
  assert.equal(result.customerSpoke, false)
  assert.equal(result.lastMeaningfulCustomerExchangeMs, null)
})

test('reviewed decision signals correct the quality-team disagreement patterns', () => {
  const agentOnly = [
    { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent speech' },
  ]
  const twoWay = [
    { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent speech' },
    { number: 2, startMs: 1_200, endMs: 2_000, text: 'Synthetic reply' },
  ]
  const cases: Array<{
    proposed: ModelClassification['category']
    expected: ModelClassification['category']
    signals: ClassificationDecisionSignals
    customerSpoke: boolean
  }> = [
    {
      proposed: 'INCORRECT_CALL_DURATION',
      expected: 'TIME_DURATION',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'unclear',
        conversationOutcome: 'unclear',
        durationOutcome: 'ended_too_early',
      },
    },
    {
      proposed: 'INCORRECT_CALL_DURATION',
      expected: 'USER_SILENCE',
      customerSpoke: false,
      signals: {
        counterpartyType: 'no_response',
        agentHandling: 'normal',
        conversationOutcome: 'no_outcome',
        durationOutcome: 'appropriate',
      },
    },
    {
      proposed: 'INCORRECT_CALL_DURATION',
      expected: 'VOICEMAIL',
      customerSpoke: false,
      signals: {
        counterpartyType: 'voicemail',
        agentHandling: 'normal',
        conversationOutcome: 'no_outcome',
        durationOutcome: 'appropriate',
      },
    },
    {
      proposed: 'CONNECT_NOT_FRUITFUL',
      expected: 'TIME_DURATION',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'unclear',
        conversationOutcome: 'unclear',
        durationOutcome: 'continued_without_value',
      },
    },
    {
      proposed: 'CONNECT_NOT_FRUITFUL',
      expected: 'TIME_DURATION',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'unclear',
        conversationOutcome: 'unclear',
        durationOutcome: 'ended_too_early',
      },
    },
    {
      proposed: 'CONNECT_NOT_FRUITFUL',
      expected: 'OK',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'normal',
        conversationOutcome: 'successful',
        durationOutcome: 'appropriate',
      },
    },
    {
      proposed: 'CONNECT_NOT_FRUITFUL',
      expected: 'AGENT_FAILURE',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'failed',
        conversationOutcome: 'no_outcome',
        durationOutcome: 'continued_without_value',
      },
    },
    {
      proposed: 'AGENT_FAILURE',
      expected: 'VOICEMAIL',
      customerSpoke: false,
      signals: {
        counterpartyType: 'voicemail',
        agentHandling: 'normal',
        conversationOutcome: 'no_outcome',
        durationOutcome: 'appropriate',
      },
    },
    {
      proposed: 'VOICEMAIL',
      expected: 'USER_SILENCE',
      customerSpoke: false,
      signals: {
        counterpartyType: 'no_response',
        agentHandling: 'normal',
        conversationOutcome: 'no_outcome',
        durationOutcome: 'appropriate',
      },
    },
  ]

  for (const item of cases) {
    const result = validateClassification(
      reviewedClassification(item),
      item.customerSpoke ? twoWay : agentOnly,
      3_000,
      { durationMismatch: false },
    )
    assert.equal(result.category, item.expected)
    assert.equal(result.remarks, 'Synthetic evidence-based rationale.')
  }
})

test('incorrect-duration category requires the independently verified mismatch', () => {
  const raw = reviewedClassification({
    proposed: 'INCORRECT_CALL_DURATION',
    customerSpoke: true,
    signals: {
      counterpartyType: 'unclear',
      agentHandling: 'unclear',
      conversationOutcome: 'unclear',
      durationOutcome: 'unclear',
    },
  })
  const blocks = [
    { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent speech' },
    { number: 2, startMs: 1_200, endMs: 2_000, text: 'Synthetic reply' },
  ]
  assert.throws(
    () =>
      validateClassification(raw, blocks, 3_000, {
        durationMismatch: false,
      }),
    /requires a verified duration mismatch/,
  )
  assert.equal(
    validateClassification(raw, blocks, 3_000, {
      durationMismatch: true,
    }).category,
    'INCORRECT_CALL_DURATION',
  )
})

test('reviewed counterparty signals must agree with identified customer speech', () => {
  const raw = reviewedClassification({
    proposed: 'OK',
    signals: {
      counterpartyType: 'human',
      agentHandling: 'normal',
      conversationOutcome: 'successful',
      durationOutcome: 'appropriate',
    },
  })
  assert.throws(
    () =>
      validateClassification(
        raw,
        [
          {
            number: 1,
            startMs: 0,
            endMs: 1_000,
            text: 'Synthetic agent speech',
          },
        ],
        2_000,
      ),
    /requires customer speech/,
  )
})

test('classification failure stores a bounded code instead of thrown prose', async () => {
  const ai: ReauditAi = {
    async transcribe() {
      return {
        model: { provider: 'openai', name: 'whisper-1', version: 'whisper-1' },
        language: 'english',
        durationMs: 10_000,
        speechMs: 2_000,
        text: 'Synthetic speech',
        segments: [{ startMs: 0, endMs: 2_000, text: 'Synthetic speech' }],
      }
    },
    async classify() {
      throw new Error('synthetic provider prose that must not be stored')
    },
  }
  const result = await auditOneCall({
    candidate,
    allowedHosts: ['cdr-storage-recs.s3.ap-south-1.amazonaws.com'],
    fetcher: {
      async fetch() {
        return {
          ok: true,
          status: 200,
          bytes: Buffer.from('synthetic-audio'),
          contentType: 'audio/ogg',
        }
      },
    },
    ai,
  })
  assert.equal(result.outcome, 'classification_failed')
  assert.equal(result.errorCode, 'CLASSIFICATION_FAILED')
})

test('projection adds 60-second wrap-up grace and remains uncalibrated', () => {
  const analysis: ReauditAnalysis = {
    category: 'OK',
    confidence: '0.95000000',
    language: 'english',
    recordedDurationMs: 190_000,
    speechDurationMs: 80_000,
    conversationAssessment: 'established',
    lastMeaningfulCustomerExchangeMs: 61_000,
    customerSpeechMs: 20_000,
    agentSpeechMs: 60_000,
    durationMismatch: false,
    evidenceSha256: 'a'.repeat(64),
    remarks: 'Synthetic',
    disputeRecommended: false,
  }
  const projected = projectVerifiedCharge(analysis)
  assert.equal(projected.adjustedChargeableDurationMs, 121_000)
  assert.equal(projected.billableMinutes, '3.00000000')
  assert.equal(projected.amount, '28.50000000')
  assert.equal(projected.authority, 'provisional_uncalibrated')
  assert.equal(projected.oneWayTailAlert, true)
})

test('read-only audit hashes audio, classifies, and projects without a repository', async () => {
  const ai: ReauditAi = {
    async transcribe() {
      return {
        model: { provider: 'openai', name: 'whisper-1', version: 'whisper-1' },
        language: 'english',
        durationMs: 90_000,
        speechMs: 10_000,
        text: 'Synthetic agent. Synthetic customer.',
        segments: [
          { startMs: 0, endMs: 5_000, text: 'Synthetic agent' },
          { startMs: 6_000, endMs: 10_000, text: 'Synthetic customer' },
        ],
      }
    },
    async classify() {
      return {
        model: {
          provider: 'openai',
          name: 'synthetic-classifier',
          version: 'synthetic-v1',
        },
        category: 'OK',
        confidence: '0.90000000',
        customerBlockNumbers: [2],
        unclearBlockNumbers: [],
        customerSpoke: true,
        lastMeaningfulCustomerExchangeMs: 10_000,
        remarks: 'Synthetic',
        disputeRecommended: false,
      }
    },
  }
  const result = await auditOneCall({
    candidate,
    allowedHosts: ['cdr-storage-recs.s3.ap-south-1.amazonaws.com'],
    fetcher: {
      async fetch() {
        return {
          ok: true,
          status: 200,
          bytes: Buffer.from('synthetic-audio'),
          contentType: 'audio/ogg',
        }
      },
    },
    ai,
  })
  assert.equal(result.outcome, 'projected')
  assert.equal(result.analysis?.lastMeaningfulCustomerExchangeMs, 10_000)
  assert.equal(result.projection?.billableMinutes, '2.00000000')
})

test('baseline mismatch stops before OpenAI processing', async () => {
  let calls = 0
  const ai: ReauditAi = {
    async transcribe() {
      calls++
      throw new Error('must not run')
    },
    async classify() {
      throw new Error('must not run')
    },
  }
  const result = await auditOneCall({
    candidate: { ...candidate, baselineSha256: 'f'.repeat(64) },
    allowedHosts: ['cdr-storage-recs.s3.ap-south-1.amazonaws.com'],
    fetcher: {
      async fetch() {
        return { ok: true, status: 200, bytes: Buffer.from('changed') }
      },
    },
    ai,
  })
  assert.equal(result.outcome, 'evidence_altered')
  assert.equal(calls, 0)
})
