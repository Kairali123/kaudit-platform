import { test } from 'node:test'
import assert from 'node:assert/strict'
import { auditOneCall } from './core.ts'
import type {
  ReauditAi,
  ReauditCandidate,
  TranscriptCacheKey,
  TranscriptCachePort,
  TranscriptionResult,
} from './types.ts'

/**
 * Transcription is 93% of what an audit costs, and a classification failure
 * used to discard the transcript entirely -- the failure path persists only a
 * failed audit run -- so every retry paid Whisper again for identical audio.
 *
 * These tests are about money, not caching: what must never happen is paying
 * twice for the same bytes, and what must never happen in the other direction
 * is reusing a transcript for audio that is not the same.
 */

const AUDIO = Buffer.from('the same audio bytes, every time')

const TRANSCRIPT: TranscriptionResult = {
  model: { provider: 'openai', name: 'whisper-1', version: 'whisper-1' },
  language: 'english',
  durationMs: 92_000,
  speechMs: 61_000,
  text: 'hello, I would like to ask about the treatment',
  segments: [
    { startMs: 1_000, endMs: 30_000, text: 'hello' },
    { startMs: 30_000, endMs: 61_000, text: 'I would like to ask about the treatment' },
  ],
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    audioSeconds: 92,
    requestId: 'req_first_attempt',
  },
}

const CANDIDATE: ReauditCandidate = {
  callId: 'call-1',
  artifactId: 'artifact-1',
  sourceUrl: 'https://recordings.kserve.example/call-1.ogg',
  connectedDurationMs: 90_000,
} as unknown as ReauditCandidate

function fetcher() {
  return {
    async fetch() {
      return {
        ok: true as const,
        status: 200,
        bytes: AUDIO,
        contentType: 'audio/ogg',
      }
    },
  }
}

function countingAi(classify: () => Promise<never> | Promise<object>): {
  ai: ReauditAi
  transcriptions: () => number
} {
  let transcriptions = 0
  const ai = {
    transcriptionModel: {
      provider: 'openai',
      name: 'whisper-1',
      version: 'whisper-1',
    },
    async transcribe() {
      transcriptions += 1
      return TRANSCRIPT
    },
    classify,
  } as unknown as ReauditAi
  return { ai, transcriptions: () => transcriptions }
}

function memoryCache(): TranscriptCachePort & { size: () => number } {
  const store = new Map<string, TranscriptionResult>()
  const id = (key: TranscriptCacheKey): string =>
    `${key.evidenceSha256}:${key.provider}:${key.modelName}:${key.modelVersion}`
  return {
    async read(key) {
      return store.get(id(key)) ?? null
    },
    async write(key, transcript) {
      store.set(id(key), transcript)
    },
    async purgeExpired() {
      return 0
    },
    size: () => store.size,
  }
}

const ALLOWED = ['recordings.kserve.example']

test('a classification failure still leaves the transcript reusable', async () => {
  // The exact case that was costing money: classification fails, the audit
  // returns a failure, and the transcript that was paid for survives.
  const cache = memoryCache()
  const failing = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  const first = await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: failing.ai,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })
  assert.equal(first.outcome, 'classification_failed')
  assert.equal(failing.transcriptions(), 1)
  assert.equal(cache.size(), 1, 'the paid-for transcript was kept')
})

test('the retry after a classification failure does not transcribe again', async () => {
  const cache = memoryCache()
  const failing = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: failing.ai,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })

  const retry = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: retry.ai,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })
  assert.equal(retry.transcriptions(), 0, 'the same audio was not re-paid for')
})

test('different audio is never served another recording’s transcript', async () => {
  // The key is the hash of the bytes. This is the failure that would matter:
  // billing a call from words spoken in a different call.
  const cache = memoryCache()
  const first = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: first.ai,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })

  const other = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: {
      async fetch() {
        return {
          ok: true as const,
          status: 200,
          bytes: Buffer.from('a completely different recording'),
          contentType: 'audio/ogg',
        }
      },
    },
    ai: other.ai,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })
  assert.equal(other.transcriptions(), 1, 'different bytes were transcribed')
  assert.equal(cache.size(), 2)
})

test('a transcript from a different model is not reused', async () => {
  const cache = memoryCache()
  const first = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: first.ai,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })

  const newerModel = {
    transcriptionModel: {
      provider: 'openai',
      name: 'gpt-4o-mini-transcribe',
      version: 'gpt-4o-mini-transcribe',
    },
    async transcribe() {
      return TRANSCRIPT
    },
    async classify() {
      throw new Error('classification did not validate')
    },
  } as unknown as ReauditAi
  let reused = true
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: {
      ...newerModel,
      async transcribe() {
        reused = false
        return TRANSCRIPT
      },
    } as unknown as ReauditAi,
    allowedHosts: ALLOWED,
    transcriptCache: cache,
  })
  assert.equal(
    reused,
    false,
    'switching models must not keep serving the old one’s words',
  )
})

test('with no cache at all, every attempt transcribes exactly as before', async () => {
  const failing = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: failing.ai,
    allowedHosts: ALLOWED,
  })
  await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: failing.ai,
    allowedHosts: ALLOWED,
  })
  assert.equal(failing.transcriptions(), 2)
})

test('a cache that throws costs a transcription, never the audit', async () => {
  // A cost optimisation must never be able to break the thing it optimises.
  // A port that misbehaves is treated as a miss, not allowed to propagate.
  const broken = {
    async read() {
      throw new Error('cache unavailable')
    },
    async write() {
      throw new Error('cache unavailable')
    },
    async purgeExpired() {
      return 0
    },
  } as unknown as TranscriptCachePort
  const failing = countingAi(async () => {
    throw new Error('classification did not validate')
  })
  const result = await auditOneCall({
    candidate: CANDIDATE,
    fetcher: fetcher(),
    ai: failing.ai,
    allowedHosts: ALLOWED,
    transcriptCache: broken,
  })
  // The audit reached its own conclusion despite the cache being unusable.
  assert.equal(result.outcome, 'classification_failed')
  assert.equal(failing.transcriptions(), 1)
})
