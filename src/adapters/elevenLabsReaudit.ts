import { parseBuffer } from 'music-metadata'
import type {
  ReauditAi,
  TranscriptSegment,
} from '../reaudit/types.ts'
import { createOpenAiReaudit } from './openaiReaudit.ts'

export const ELEVENLABS_TRANSCRIPTION_MODEL = 'scribe_v2'
export const ELEVENLABS_TRANSCRIPTION_VERSION = 'scribe_v2'
export const ELEVENLABS_SPEECH_TO_TEXT_URL =
  'https://api.elevenlabs.io/v1/speech-to-text'

const SEGMENT_GAP_SECONDS = 1
const SEGMENT_MAX_SECONDS = 15
const SEGMENT_MAX_CHARS = 250

interface ElevenLabsWord {
  text?: unknown
  start?: unknown
  end?: unknown
  type?: unknown
}

interface ElevenLabsResponse {
  language_code?: unknown
  text?: unknown
  words?: ElevenLabsWord[]
  transcription_id?: unknown
}

export interface ElevenLabsTranscriberOptions {
  /** Defaults to global fetch. Exposed for synthetic contract tests. */
  fetchImpl?: typeof fetch
  /**
   * False by default so call content is not retained by the provider. The
   * ElevenLabs account must support zero-retention mode. Enabling provider
   * logging is an explicit governance decision, never an accidental default.
   */
  enableLogging?: boolean
  endpoint?: string
  decodeDurationMs?: (
    bytes: Buffer,
    contentType: string,
  ) => Promise<number>
}

class ElevenLabsTranscriptionError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`ElevenLabs transcription failed: HTTP ${status}`)
    this.status = status
    this.code = code
  }
}

function finiteSeconds(value: unknown): number | null {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function appendToken(existing: string, token: string): string {
  if (!existing) return token
  if (/^[,.;:!?%)\]}]/u.test(token)) return `${existing}${token}`
  if (/^['’]/u.test(token)) return `${existing}${token}`
  return `${existing} ${token}`
}

/** Converts word timestamps into stable utterance-like segments. */
export function elevenLabsWordsToSegments(
  words: ElevenLabsWord[],
): TranscriptSegment[] {
  const result: TranscriptSegment[] = []
  let current: { start: number; end: number; text: string } | null = null

  for (const word of words) {
    const type = String(word.type || '')
    if (type !== 'word' && type !== 'audio_event') continue
    const start = finiteSeconds(word.start)
    const end = finiteSeconds(word.end)
    const token = String(word.text || '').trim()
    if (start == null || end == null || end < start || !token) continue

    const nextText = current ? appendToken(current.text, token) : token
    const split = current != null && (
      start - current.end >= SEGMENT_GAP_SECONDS ||
      end - current.start > SEGMENT_MAX_SECONDS ||
      nextText.length > SEGMENT_MAX_CHARS
    )
    if (!current || split) {
      if (current) {
        result.push({
          startMs: Math.round(current.start * 1_000),
          endMs: Math.round(current.end * 1_000),
          text: current.text,
        })
      }
      current = { start, end, text: token }
    } else {
      current.end = Math.max(current.end, end)
      current.text = nextText
    }
  }

  if (current) {
    result.push({
      startMs: Math.round(current.start * 1_000),
      endMs: Math.round(current.end * 1_000),
      text: current.text,
    })
  }
  return result
}

export async function decodeAudioDurationMs(
  bytes: Buffer,
  contentType: string,
): Promise<number> {
  const metadata = await parseBuffer(bytes, contentType, {
    duration: true,
    skipCovers: true,
  })
  const durationSeconds = Number(metadata.format.duration)
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error('Audio decoder did not return a positive duration')
  }
  return Math.round(durationSeconds * 1_000)
}

function extensionFor(contentType: string): string {
  if (contentType.includes('mpeg') || contentType.includes('mp3')) return 'mp3'
  if (contentType.includes('wav')) return 'wav'
  if (contentType.includes('webm')) return 'webm'
  if (contentType.includes('mp4') || contentType.includes('m4a')) return 'm4a'
  return 'ogg'
}

function requestId(response: Response, body: ElevenLabsResponse): string | null {
  const candidate =
    response.headers.get('request-id') ||
    response.headers.get('x-request-id') ||
    (typeof body.transcription_id === 'string' ? body.transcription_id : null)
  return candidate && candidate.length <= 120 ? candidate : null
}

export function createElevenLabsTranscriber(
  apiKey: string,
  options: ElevenLabsTranscriberOptions = {},
): Pick<ReauditAi, 'transcriptionModel' | 'transcribe'> {
  if (!apiKey.trim()) throw new Error('ELEVENLABS_API_KEY is required')
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = options.endpoint ?? ELEVENLABS_SPEECH_TO_TEXT_URL
  const decodeDuration = options.decodeDurationMs ?? decodeAudioDurationMs
  const enableLogging = options.enableLogging === true

  return {
    transcriptionModel: {
      provider: 'elevenlabs',
      name: ELEVENLABS_TRANSCRIPTION_MODEL,
      version: ELEVENLABS_TRANSCRIPTION_VERSION,
    },
    async transcribe(bytes, transcriptionOptions) {
      // Decode the exact fetched bytes independently. Speech timestamps end at
      // the final detected word and therefore cannot measure trailing silence,
      // which is material to duration disputes and deterministic billing.
      let durationMs: number
      try {
        durationMs = await decodeDuration(bytes, transcriptionOptions.contentType)
      } catch {
        // Not decodable audio (e.g. an error page served as the recording).
        throw Object.assign(new Error('Recording bytes are not decodable audio'), {
          code: 'AUDIO_UNDECODABLE',
        })
      }
      const form = new FormData()
      form.append(
        'file',
        new Blob([Uint8Array.from(bytes)], {
          type: transcriptionOptions.contentType,
        }),
        `call.${extensionFor(transcriptionOptions.contentType)}`,
      )
      form.append('model_id', ELEVENLABS_TRANSCRIPTION_MODEL)
      form.append('timestamps_granularity', 'word')
      form.append('tag_audio_events', 'true')
      form.append('diarize', 'false')
      form.append('no_verbatim', 'false')

      const url = new URL(endpoint)
      url.searchParams.set('enable_logging', String(enableLogging))
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: { 'xi-api-key': apiKey.trim() },
        body: form,
        signal: AbortSignal.timeout(120_000),
      })
      if (!response.ok) {
        throw new ElevenLabsTranscriptionError(
          response.status,
          response.status === 429 ? 'rate_limit_exceeded' : 'provider_error',
        )
      }

      const raw = await response.json() as ElevenLabsResponse
      const words = Array.isArray(raw.words) ? raw.words : []
      const segments = elevenLabsWordsToSegments(words)
      const speechSegments = elevenLabsWordsToSegments(
        words.filter((word) => String(word.type || '') === 'word'),
      )
      return {
        model: {
          provider: 'elevenlabs',
          name: ELEVENLABS_TRANSCRIPTION_MODEL,
          version: ELEVENLABS_TRANSCRIPTION_VERSION,
        },
        language: String(raw.language_code || 'unknown').toLowerCase(),
        durationMs,
        speechMs: speechSegments.reduce(
          (sum, segment) => sum + Math.max(0, segment.endMs - segment.startMs),
          0,
        ),
        text: String(raw.text || segments.map((segment) => segment.text).join(' ')),
        segments,
        usage: {
          inputTokens: null,
          outputTokens: null,
          totalTokens: null,
          audioSeconds: durationMs / 1_000,
          requestId: requestId(response, raw),
        },
      }
    },
  }
}

/** ElevenLabs ASR plus the existing OpenAI structured classifier. */
export function createElevenLabsReaudit(
  openAiApiKey: string,
  elevenLabsApiKey: string,
  options: ElevenLabsTranscriberOptions = {},
): ReauditAi {
  const classifier = createOpenAiReaudit(openAiApiKey)
  const transcriber = createElevenLabsTranscriber(elevenLabsApiKey, options)
  return {
    ...classifier,
    ...transcriber,
  }
}
