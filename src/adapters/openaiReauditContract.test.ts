import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CONSENSUS_REVIEWER_OUTPUT_SCHEMA,
  CONSENSUS_REVIEWER_PROMPT,
} from './openaiConsensus.ts'
import {
  REAUDIT_CLASSIFIER_OUTPUT_SCHEMA,
  REAUDIT_CLASSIFIER_PROMPT,
  REAUDIT_DECISION_SIGNAL_RULES,
  REAUDIT_KAIRALI_REFERENCE_RULES,
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
    assert.match(
      prompt,
      /absence of a[\s\S]+human reply are NEVER voicemail evidence/,
    )
  }
})

test('primary and consensus classifiers share Kairali-reviewed precedence', () => {
  for (const prompt of [
    REAUDIT_CLASSIFIER_PROMPT,
    CONSENSUS_REVIEWER_PROMPT,
  ]) {
    assert.ok(prompt.includes(REAUDIT_KAIRALI_REFERENCE_RULES))
    assert.ok(prompt.includes(REAUDIT_DECISION_SIGNAL_RULES))
    assert.match(prompt, /one-way voicemail greeting is VOICEMAIL/)
    assert.match(prompt, /Any human reply[\s\S]+USER_SILENCE is not allowed/)
    assert.match(prompt, /AGENT_FAILURE[\s\S]+outranks CONNECT_NOT_FRUITFUL/)
    assert.match(prompt, /Wrong number is not JUNK_CALL/)
    assert.match(
      prompt,
      /INCORRECT_CALL_DURATION[\s\S]+vendor-versus-recording[\s\S]+TIME_DURATION/,
    )
    assert.match(prompt, /Do not invent a defect/)
    assert.match(prompt, /Continued qualification or sales[\s\S]+AGENT_FAILURE/)
    assert.match(prompt, /administrative contact details[\s\S]+TIME_DURATION/)
    assert.match(prompt, /later callback or deferral[\s\S]+does not erase/)
    assert.match(
      prompt,
      /observable facts[\s\S]+decision signals[\s\S]+nearest plausible alternative/,
    )
    assert.match(prompt, /deterministic engine corrects the proposed[\s\S]+category/)
    assert.match(prompt, /Do\s+not quote transcript text/)
  }
})

test('classifier schemas leave customer timing to the deterministic engine', () => {
  for (const output of [
    REAUDIT_CLASSIFIER_OUTPUT_SCHEMA,
    CONSENSUS_REVIEWER_OUTPUT_SCHEMA,
  ]) {
    assert.ok('customer_block_numbers' in output.schema.properties)
    assert.ok(!('customer_spoke' in output.schema.properties))
    assert.ok(
      !('last_meaningful_customer_exchange_sec' in output.schema.properties),
    )
  }
})

test('classifier schemas require reviewed decision evidence before category resolution', () => {
  for (const output of [
    REAUDIT_CLASSIFIER_OUTPUT_SCHEMA,
    CONSENSUS_REVIEWER_OUTPUT_SCHEMA,
  ]) {
    for (const field of [
      'counterparty_type',
      'agent_handling',
      'conversation_outcome',
      'duration_outcome',
      'stop_intent',
      'post_stop_behavior',
      'successful_outcome',
      'voicemail_evidence',
      'voicemail_evidence_block_numbers',
    ]) {
      assert.ok(field in output.schema.properties)
      assert.ok((output.schema.required as readonly string[]).includes(field))
    }
  }
})
