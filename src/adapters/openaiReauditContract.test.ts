import assert from 'node:assert/strict'
import test from 'node:test'
import { CONSENSUS_REVIEWER_PROMPT } from './openaiConsensus.ts'
import {
  REAUDIT_CLASSIFIER_PROMPT,
  REAUDIT_SPEAKER_ATTRIBUTION_RULES,
} from './openaiReaudit.ts'

test('primary and consensus classifiers share speaker-attribution guardrails', () => {
  for (const prompt of [
    REAUDIT_CLASSIFIER_PROMPT,
    CONSENSUS_REVIEWER_PROMPT,
  ]) {
    assert.ok(prompt.includes(REAUDIT_SPEAKER_ATTRIBUTION_RULES))
    assert.match(
      prompt,
      /Long or continuous speech is NOT evidence that the speaker is\s+Saanvi/,
    )
    assert.match(
      prompt,
      /Never use USER_SILENCE when the customer speaks but Saanvi is\s+silent/,
    )
    assert.match(
      prompt,
      /use AGENT_FAILURE by default/,
    )
    assert.match(
      prompt,
      /Absence of an agent response by itself is not network evidence/,
    )
    assert.match(
      prompt,
      /answering-machine greeting is VOICEMAIL/,
    )
  }
})
