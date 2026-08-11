import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  assessCall,
  classifyEligibility,
  hasAuditableTranscript,
} from './eligibility.ts'
import type { MetricScoreEntry } from './types.ts'

const scores: readonly MetricScoreEntry[] = [
  { metric: 'greeting', score: 4 },
  { metric: 'objection_handling', score: 'NA' },
]

test('a non-blank transcript is content auditable', () => {
  assert.deepEqual(classifyEligibility('Saanvi: hello?'), {
    eligibility: 'content_auditable',
  })
  assert.deepEqual(classifyEligibility('  ok  '), {
    eligibility: 'content_auditable',
  })
  assert.deepEqual(classifyEligibility('0'), {
    eligibility: 'content_auditable',
  })
})

test('a missing or whitespace-only transcript is operational only', () => {
  for (const transcript of [null, undefined, '', ' ', '\t', '\n', ' \t\n ']) {
    assert.deepEqual(classifyEligibility(transcript), {
      eligibility: 'operational_only',
      reason: 'missing_transcript',
    })
  }
})

test('reports transcript presence without inspecting its content', () => {
  assert.equal(hasAuditableTranscript('hello'), true)
  assert.equal(hasAuditableTranscript('   '), false)
  assert.equal(hasAuditableTranscript(null), false)
  assert.equal(hasAuditableTranscript(undefined), false)
})

test('an operational-only call never carries quality scores', () => {
  for (const transcript of [null, undefined, '', '   ']) {
    const assessment = assessCall({ transcript, intent: 'HIGH', scores })
    assert.deepEqual(assessment, {
      eligibility: 'operational_only',
      reason: 'missing_transcript',
    })
    assert.equal('scores' in assessment, false)
    assert.equal('intent' in assessment, false)
  }
})

test('a content-auditable call carries intent and scores', () => {
  const assessment = assessCall({
    transcript: 'Saanvi: hello?',
    intent: 'WARM',
    scores,
  })
  assert.equal(assessment.eligibility, 'content_auditable')
  assert.equal(
    assessment.eligibility === 'content_auditable'
      ? assessment.intent
      : null,
    'WARM',
  )
  assert.deepEqual(
    assessment.eligibility === 'content_auditable'
      ? assessment.scores
      : null,
    scores,
  )
})

test('classification is deterministic and does not mutate its input', () => {
  const transcript = 'Saanvi: hello?'
  const input = { transcript, intent: 'LOW', scores: [...scores] } as const
  assert.deepEqual(assessCall(input), assessCall(input))
  assert.deepEqual([...input.scores], [...scores])
  assert.equal(transcript, 'Saanvi: hello?')
})
