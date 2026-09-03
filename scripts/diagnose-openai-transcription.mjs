import OpenAI, { toFile } from 'openai'

const apiKey = process.env.OPENAI_API_KEY?.trim()
if (!apiKey) throw new Error('missing:OPENAI_API_KEY')

function syntheticSilenceWav() {
  const sampleRate = 8_000
  const dataSize = sampleRate * 2
  const wav = Buffer.alloc(44 + dataSize)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + dataSize, 4)
  wav.write('WAVE', 8)
  wav.write('fmt ', 12)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate * 2, 28)
  wav.writeUInt16LE(2, 32)
  wav.writeUInt16LE(16, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(dataSize, 40)
  return wav
}

const client = new OpenAI({ apiKey, maxRetries: 0, timeout: 30_000 })

try {
  const response = await client.audio.transcriptions.create({
    file: await toFile(syntheticSilenceWav(), 'synthetic-silence.wav', {
      type: 'audio/wav',
    }),
    model: 'whisper-1',
    response_format: 'json',
  })
  process.stdout.write(`${JSON.stringify({
    diagnostic: 'openai_transcription',
    ok: true,
    status: 200,
    requestId: response?._request_id ?? null,
  })}\n`)
} catch (error) {
  const shaped = error && typeof error === 'object' ? error : {}
  process.stdout.write(`${JSON.stringify({
    diagnostic: 'openai_transcription',
    ok: false,
    name: String(shaped.name ?? ''),
    status: Number(shaped.status ?? 0) || null,
    code: shaped.code == null ? null : String(shaped.code),
    type: shaped.type == null ? null : String(shaped.type),
    param: shaped.param == null ? null : String(shaped.param),
    message: String(shaped.message ?? '').slice(0, 500),
    requestId: shaped.request_id == null
      ? null
      : String(shaped.request_id),
  })}\n`)
  process.exitCode = 1
}
