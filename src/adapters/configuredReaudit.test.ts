import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configuredTranscriptionProvider,
  createConfiguredReauditAi,
} from './configuredReaudit.ts'

test('ElevenLabs is the default re-audit transcription provider', () => {
  const ai = createConfiguredReauditAi({
    OPENAI_API_KEY: 'synthetic-openai-key',
    ELEVENLABS_API_KEY: 'synthetic-elevenlabs-key',
  })
  assert.equal(configuredTranscriptionProvider({}), 'elevenlabs')
  assert.deepEqual(ai.transcriptionModel, {
    provider: 'elevenlabs',
    name: 'scribe_v2',
    version: 'scribe_v2',
  })
})

test('Whisper remains an explicit supervised rollback', () => {
  const ai = createConfiguredReauditAi({
    KAUDIT_TRANSCRIPTION_PROVIDER: 'openai',
    OPENAI_API_KEY: 'synthetic-openai-key',
  })
  assert.deepEqual(ai.transcriptionModel, {
    provider: 'openai',
    name: 'whisper-1',
    version: 'whisper-1',
  })
})

test('invalid provider and missing ElevenLabs credentials fail closed', () => {
  assert.throws(
    () => configuredTranscriptionProvider({
      KAUDIT_TRANSCRIPTION_PROVIDER: 'automatic',
    }),
    /must be elevenlabs or openai/,
  )
  assert.throws(
    () => createConfiguredReauditAi({
      OPENAI_API_KEY: 'synthetic-openai-key',
    }),
    /ELEVENLABS_API_KEY is required/,
  )
})
