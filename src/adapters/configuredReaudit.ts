import type { ReauditAi } from '../reaudit/types.ts'
import { createElevenLabsReaudit } from './elevenLabsReaudit.ts'
import { createOpenAiReaudit } from './openaiReaudit.ts'

export type ReauditTranscriptionProvider = 'elevenlabs' | 'openai'

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

export function configuredTranscriptionProvider(
  env: NodeJS.ProcessEnv,
): ReauditTranscriptionProvider {
  const value = (
    env.KAUDIT_TRANSCRIPTION_PROVIDER?.trim() || 'elevenlabs'
  ).toLowerCase()
  if (value === 'elevenlabs' || value === 'openai') return value
  throw new Error(
    'KAUDIT_TRANSCRIPTION_PROVIDER must be elevenlabs or openai',
  )
}

export function createConfiguredReauditAi(
  env: NodeJS.ProcessEnv,
): ReauditAi {
  const openAiApiKey = required(env, 'OPENAI_API_KEY')
  if (configuredTranscriptionProvider(env) === 'openai') {
    return createOpenAiReaudit(openAiApiKey)
  }
  return createElevenLabsReaudit(
    openAiApiKey,
    required(env, 'ELEVENLABS_API_KEY'),
    {
      enableLogging:
        env.KAUDIT_ELEVENLABS_ENABLE_LOGGING?.trim().toLowerCase() === 'true',
    },
  )
}
