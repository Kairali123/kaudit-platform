import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REAUDIT_ENGINE_VERSION,
  auditOneCall,
  mergeTranscriptSegments,
  projectVerifiedCharge,
  repairClassification,
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

test('engine version identifies the classification repair', () => {
  assert.equal(REAUDIT_ENGINE_VERSION, 'kairali-independent-reaudit/2.6.5')
})

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

test('classification bounds ASR segment overrun to decoded recording duration', () => {
  const raw = reviewedClassification({
    proposed: 'OK',
    customerSpoke: true,
    signals: {
      counterpartyType: 'human',
      agentHandling: 'normal',
      conversationOutcome: 'successful',
      durationOutcome: 'appropriate',
    },
  })
  const result = validateClassification(
    raw,
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
      { number: 2, startMs: 1_100, endMs: 3_010, text: 'Synthetic customer reply' },
    ],
    3_000,
  )

  assert.equal(result.lastMeaningfulCustomerExchangeMs, 3_000)
  assert.equal(result.lastVerifiedInteractionMs, 3_000)
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

test('classification intersects business-relevant blocks with customer blocks', () => {
  const raw: ModelClassification = {
    model: {
      provider: 'openai',
      name: 'synthetic-classifier',
      version: 'synthetic-v1',
    },
    category: 'JUNK_CALL',
    confidence: '0.90000000',
    customerBlockNumbers: [2],
    unclearBlockNumbers: [],
    businessRelevantCustomerBlockNumbers: [1, 2],
    customerSpoke: true,
    lastMeaningfulCustomerExchangeMs: 2_000,
    remarks: 'Synthetic inconsistent business relevance.',
    disputeRecommended: false,
  }
  const result = validateClassification(
    raw,
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
      { number: 2, startMs: 1_100, endMs: 2_000, text: 'Synthetic customer reply' },
    ],
    3_000,
  )

  assert.deepEqual(result.businessRelevantCustomerBlockNumbers, [2])
  assert.equal(result.lastBusinessRelevantCustomerExchangeMs, 2_000)
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

test('unsupported voicemail evidence is corrected to user silence', () => {
  const raw = reviewedClassification({
    proposed: 'VOICEMAIL',
    signals: {
      counterpartyType: 'voicemail',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      voicemailEvidence: 'fixed_greeting',
    },
  })
  raw.voicemailEvidenceBlockNumbers = [1]
  raw.remarks =
    'Synthetic hallucinated voicemail rationale based only on non-response.'

  const result = validateClassification(
    raw,
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent intro' },
      { number: 2, startMs: 2_000, endMs: 3_000, text: 'Synthetic agent prompt' },
    ],
    5_000,
  )

  assert.equal(result.category, 'USER_SILENCE')
  assert.equal(
    result.remarks,
    'Agent speech was identified, but no customer or affirmative voicemail evidence was identified; this is user silence.',
  )
})

test('voicemail remains voicemail when an evidence block is identified', () => {
  const raw = reviewedClassification({
    proposed: 'VOICEMAIL',
    signals: {
      counterpartyType: 'voicemail',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      voicemailEvidence: 'leave_message_request',
    },
  })
  raw.voicemailEvidenceBlockNumbers = [1]

  const result = validateClassification(
    raw,
    [
      {
        number: 1,
        startMs: 0,
        endMs: 1_000,
        text: 'Synthetic mailbox asks for a message',
      },
    ],
    2_000,
  )

  assert.equal(result.category, 'VOICEMAIL')
  assert.deepEqual(result.voicemailEvidenceBlockNumbers, [1])
})

test('a fixed recording-complete notice is affirmative voicemail evidence', () => {
  const raw = reviewedClassification({
    proposed: 'AGENT_FAILURE',
    signals: {
      counterpartyType: 'voicemail',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      voicemailEvidence: 'recording_notice',
    },
  })
  raw.voicemailEvidenceBlockNumbers = [1]

  const result = validateClassification(
    raw,
    [
      {
        number: 1,
        startMs: 0,
        endMs: 1_000,
        text: 'Synthetic system notice: recording completed; you may hang up.',
      },
    ],
    2_000,
  )

  assert.equal(result.category, 'VOICEMAIL')
})

test('post-stop behavior separates agent failure, excess duration, and a normal close', () => {
  const blocks = [
    { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
    { number: 2, startMs: 1_100, endMs: 2_000, text: 'Synthetic customer deferral' },
    { number: 3, startMs: 2_100, endMs: 3_000, text: 'Synthetic agent response' },
  ]
  const base: ClassificationDecisionSignals = {
    counterpartyType: 'human',
    agentHandling: 'normal',
    conversationOutcome: 'no_outcome',
    durationOutcome: 'appropriate',
    stopIntent: 'callback_or_defer',
    successfulOutcome: 'none',
  }
  const cases: Array<{
    behavior: NonNullable<ClassificationDecisionSignals['postStopBehavior']>
    expected: ModelClassification['category']
  }> = [
    { behavior: 'continued_sales_flow', expected: 'AGENT_FAILURE' },
    { behavior: 'administrative_extension', expected: 'TIME_DURATION' },
    { behavior: 'appropriate_close', expected: 'CONNECT_NOT_FRUITFUL' },
  ]

  for (const item of cases) {
    const result = validateClassification(
      reviewedClassification({
        proposed: 'CONNECT_NOT_FRUITFUL',
        customerSpoke: true,
        signals: { ...base, postStopBehavior: item.behavior },
      }),
      blocks,
      4_000,
    )
    assert.equal(result.category, item.expected)
  }
})

test('an appropriate close outranks an erroneous generic duration signal', () => {
  const result = validateClassification(
    reviewedClassification({
      proposed: 'TIME_DURATION',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'normal',
        conversationOutcome: 'no_outcome',
        durationOutcome: 'ended_too_early',
        stopIntent: 'callback_or_defer',
        postStopBehavior: 'appropriate_close',
        successfulOutcome: 'none',
      },
    }),
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
      { number: 2, startMs: 1_100, endMs: 2_000, text: 'Synthetic customer deferral' },
      { number: 3, startMs: 2_100, endMs: 3_000, text: 'Synthetic agent close' },
    ],
    4_000,
  )

  assert.equal(result.category, 'CONNECT_NOT_FRUITFUL')
})

test('repeated customer greetings with no agent response override junk', () => {
  const raw = reviewedClassification({
    proposed: 'JUNK_CALL',
    signals: {
      counterpartyType: 'human',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      junkEvidence: 'none',
    },
  })
  raw.customerBlockNumbers = []
  raw.junkEvidenceBlockNumbers = [1]

  const result = validateClassification(
    raw,
    [{ number: 1, startMs: 0, endMs: 4_000, text: 'Hello, hello, hello!' }],
    5_000,
  )

  assert.deepEqual(result.customerBlockNumbers, [1])
  assert.deepEqual(result.junkEvidenceBlockNumbers, [])
  assert.equal(result.category, 'AGENT_FAILURE')
})

test('a standalone language preference is human speech, not AI to AI', () => {
  const raw = reviewedClassification({
    proposed: 'AI_TO_AI',
    signals: {
      counterpartyType: 'interactive_automation',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      automationEvidence: 'screening_prompt',
    },
  })
  raw.customerBlockNumbers = []
  raw.automationEvidenceBlockNumbers = [2]

  const result = validateClassification(
    raw,
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
      { number: 2, startMs: 1_100, endMs: 2_000, text: 'English, Tamil' },
      { number: 3, startMs: 2_100, endMs: 3_000, text: 'Synthetic agent close' },
    ],
    4_000,
  )

  assert.deepEqual(result.customerBlockNumbers, [2])
  assert.deepEqual(result.automationEvidenceBlockNumbers, [])
  assert.equal(result.decisionSignals?.counterpartyType, 'human')
  assert.equal(result.category, 'CONNECT_NOT_FRUITFUL')
})

test('AI to AI requires a supported automation block and an agent exchange', () => {
  const raw = reviewedClassification({
    proposed: 'AI_TO_AI',
    signals: {
      counterpartyType: 'interactive_automation',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      automationEvidence: 'virtual_assistant_disclosure',
    },
  })
  raw.automationEvidenceBlockNumbers = [2]

  const result = validateClassification(
    raw,
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
      {
        number: 2,
        startMs: 1_100,
        endMs: 2_000,
        text: 'This is an automated assistant. Please state your name.',
      },
    ],
    3_000,
  )

  assert.equal(result.category, 'AI_TO_AI')
  assert.deepEqual(result.automationEvidenceBlockNumbers, [2])
})

test('junk calls require a supported test, spam, or illegitimate-purpose block', () => {
  const raw = reviewedClassification({
    proposed: 'JUNK_CALL',
    customerSpoke: true,
    signals: {
      counterpartyType: 'human',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      junkEvidence: 'test_call',
    },
  })
  raw.junkEvidenceBlockNumbers = [2]

  const result = validateClassification(
    raw,
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
      { number: 2, startMs: 1_100, endMs: 2_000, text: 'This is a test call.' },
    ],
    3_000,
  )

  assert.equal(result.category, 'JUNK_CALL')
  assert.deepEqual(result.junkEvidenceBlockNumbers, [2])
})

test('a completed outcome is not erased by a later deferral', () => {
  const result = validateClassification(
    reviewedClassification({
      proposed: 'CONNECT_NOT_FRUITFUL',
      customerSpoke: true,
      signals: {
        counterpartyType: 'human',
        agentHandling: 'normal',
        conversationOutcome: 'successful',
        durationOutcome: 'appropriate',
        stopIntent: 'callback_or_defer',
        postStopBehavior: 'appropriate_close',
        successfulOutcome: 'handoff_or_transfer',
      },
    }),
    [
      { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent handoff' },
      { number: 2, startMs: 1_100, endMs: 2_000, text: 'Synthetic customer response' },
    ],
    3_000,
  )

  assert.equal(result.category, 'OK')
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
  assert.equal(result.errorCode, 'CLASSIFICATION_MODEL_FAILED')
})

test('transcription quota exhaustion returns a bounded diagnostic code', async () => {
  const throttled = Object.assign(new Error('synthetic provider prose'), {
    status: 429,
    code: 'insufficient_quota',
  })
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
    ai: {
      async transcribe() {
        throw throttled
      },
      async classify() {
        throw new Error('unreachable')
      },
    },
  })

  assert.equal(result.outcome, 'transcription_failed')
  assert.equal(result.errorCode, 'TRANSCRIPTION_PROVIDER_QUOTA_EXHAUSTED')
})

test('classification validation contradictions preserve identified customer speech', async () => {
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
      return {
        ...reviewedClassification({
          proposed: 'USER_SILENCE',
          customerSpoke: true,
          signals: {
            counterpartyType: 'no_response',
            agentHandling: 'normal',
            conversationOutcome: 'no_outcome',
            durationOutcome: 'appropriate',
          },
        }),
        customerBlockNumbers: [1],
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
  assert.equal(result.analysis?.category, 'AGENT_FAILURE')
})

test('classification repair gives customer speech precedence over unclear role guesses', () => {
  const raw = reviewedClassification({
    proposed: 'USER_SILENCE',
    customerSpoke: true,
    signals: {
      counterpartyType: 'no_response',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
    },
  })
  raw.unclearBlockNumbers = [2]
  const blocks = [
    { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
    { number: 2, startMs: 1_100, endMs: 2_000, text: 'Synthetic customer reply' },
  ]

  const repaired = repairClassification(raw, blocks)
  const result = validateClassification(repaired, blocks, 3_000)

  assert.deepEqual(result.customerBlockNumbers, [2])
  assert.deepEqual(result.unclearBlockNumbers, [])
  assert.equal(result.decisionSignals?.counterpartyType, 'human')
  assert.equal(result.category, 'CONNECT_NOT_FRUITFUL')
})

test('classification repair promotes affirmative junk evidence to junk call', () => {
  const raw = reviewedClassification({
    proposed: 'CONNECT_NOT_FRUITFUL',
    customerSpoke: true,
    signals: {
      counterpartyType: 'human',
      agentHandling: 'normal',
      conversationOutcome: 'no_outcome',
      durationOutcome: 'appropriate',
      junkEvidence: 'test_call',
    },
  })
  raw.junkEvidenceBlockNumbers = [2]
  const blocks = [
    { number: 1, startMs: 0, endMs: 1_000, text: 'Synthetic agent prompt' },
    { number: 2, startMs: 1_100, endMs: 2_000, text: 'This is a test call' },
  ]

  const repaired = repairClassification(raw, blocks)
  const result = validateClassification(repaired, blocks, 3_000)

  assert.equal(result.category, 'JUNK_CALL')
  assert.deepEqual(result.junkEvidenceBlockNumbers, [2])
})

test('unrepairable classifier output retains a bounded terminal code', async () => {
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
      return {
        ...reviewedClassification({
          proposed: 'USER_SILENCE',
          signals: {
            counterpartyType: 'no_response',
            agentHandling: 'normal',
            conversationOutcome: 'no_outcome',
            durationOutcome: 'appropriate',
          },
        }),
        confidence: '2.00000000',
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

  assert.equal(result.outcome, 'classification_failed')
  assert.equal(result.errorCode, 'CLASSIFICATION_OUTPUT_UNRECOVERABLE')
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
    chargeableServiceEndMs: 61_000,
    appliedBillingGraceMs: 60_000,
    categoryChargePolicyCode: 'STANDARD_CUSTOMER_PLUS_GRACE',
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
  assert.equal(
    projected.categoryChargePolicyCode,
    'STANDARD_CUSTOMER_PLUS_GRACE',
  )
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
