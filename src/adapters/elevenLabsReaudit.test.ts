import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createElevenLabsTranscriber,
  decodeAudioDurationMs,
  elevenLabsWordsToSegments,
} from './elevenLabsReaudit.ts'

function syntheticWav(durationSeconds: number): Buffer {
  const sampleRate = 8_000
  const samples = sampleRate * durationSeconds
  const dataSize = samples * 2
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + dataSize, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * 2, 28)
  bytes.writeUInt16LE(2, 32)
  bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(dataSize, 40)
  return bytes
}

test('decodes the full recording duration independently of speech', async () => {
  assert.equal(
    await decodeAudioDurationMs(syntheticWav(2), 'audio/wav'),
    2_000,
  )
})

test('converts timed words and audio events into bounded speech segments', () => {
  assert.deepEqual(
    elevenLabsWordsToSegments([
      { type: 'word', text: 'Hello', start: 0.1, end: 0.4 },
      { type: 'spacing', text: ' ', start: 0.4, end: 0.45 },
      { type: 'word', text: 'there.', start: 0.45, end: 0.9 },
      { type: 'audio_event', text: '(beep)', start: 2, end: 2.2 },
      { type: 'word', text: 'Ignored: bad timing', start: 3, end: 2 },
    ]),
    [
      { startMs: 100, endMs: 900, text: 'Hello there.' },
      { startMs: 2_000, endMs: 2_200, text: '(beep)' },
    ],
  )
})

test('requests Scribe v2 with zero retention and normalizes its response', async () => {
  let inspected = false
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    assert.equal(url.searchParams.get('enable_logging'), 'false')
    assert.equal(init?.method, 'POST')
    assert.deepEqual(init?.headers, { 'xi-api-key': 'synthetic-key' })
    const form = init?.body
    assert.ok(form instanceof FormData)
    assert.equal(form.get('model_id'), 'scribe_v2')
    assert.equal(form.get('timestamps_granularity'), 'word')
    assert.equal(form.get('tag_audio_events'), 'true')
    assert.equal(form.get('diarize'), 'false')
    assert.equal(form.get('no_verbatim'), 'false')
    assert.ok(form.get('file') instanceof Blob)
    inspected = true
    return new Response(JSON.stringify({
      language_code: 'hin',
      text: 'Namaste. (beep)',
      transcription_id: 'synthetic-transcription-id',
      words: [
        { type: 'word', text: 'Namaste.', start: 0.2, end: 0.8 },
        { type: 'audio_event', text: '(beep)', start: 2.1, end: 2.3 },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch

  const transcriber = createElevenLabsTranscriber('synthetic-key', {
    fetchImpl,
    decodeDurationMs: async () => 5_000,
  })
  const result = await transcriber.transcribe(Buffer.from('synthetic-audio'), {
    contentType: 'audio/ogg',
  })

  assert.equal(inspected, true)
  assert.deepEqual(result.model, {
    provider: 'elevenlabs',
    name: 'scribe_v2',
    version: 'scribe_v2',
  })
  assert.equal(result.language, 'hin')
  assert.equal(result.durationMs, 5_000)
  assert.equal(result.speechMs, 600)
  assert.equal(result.usage?.audioSeconds, 5)
  assert.equal(result.usage?.requestId, 'synthetic-transcription-id')
  assert.deepEqual(result.segments, [
    { startMs: 200, endMs: 800, text: 'Namaste.' },
    { startMs: 2_100, endMs: 2_300, text: '(beep)' },
  ])
})

test('provider failures expose only bounded status metadata', async () => {
  const transcriber = createElevenLabsTranscriber('synthetic-key', {
    fetchImpl: (async () => new Response(
      JSON.stringify({ detail: 'sensitive provider prose' }),
      { status: 429 },
    )) as typeof fetch,
    decodeDurationMs: async () => 1_000,
  })
  await assert.rejects(
    transcriber.transcribe(Buffer.from('synthetic-audio'), {
      contentType: 'audio/ogg',
    }),
    (error: unknown) => {
      assert.equal((error as { status?: unknown }).status, 429)
      assert.equal(
        (error as { code?: unknown }).code,
        'rate_limit_exceeded',
      )
      assert.doesNotMatch(String(error), /sensitive provider prose/)
      return true
    },
  )
})
