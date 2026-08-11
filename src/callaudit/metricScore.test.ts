import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isMetricScore, parseMetricScore } from './metricScore.ts'
import {
  METRIC_SCORE_NOT_APPLICABLE,
  type MetricScore,
} from './types.ts'

test('accepts the integers 1 through 5', () => {
  for (const value of [1, 2, 3, 4, 5]) {
    assert.ok(isMetricScore(value))
    assert.equal(parseMetricScore(value), value)
  }
})

test('accepts NA for a metric that does not apply', () => {
  assert.ok(isMetricScore(METRIC_SCORE_NOT_APPLICABLE))
  assert.equal(parseMetricScore('NA'), 'NA')
  assert.equal(parseMetricScore(' na '), 'NA')
  assert.equal(parseMetricScore('Na'), 'NA')
})

test('parses digit strings into numeric scores', () => {
  assert.equal(parseMetricScore('3'), 3)
  assert.equal(parseMetricScore(' 5 '), 5)
  assert.equal(typeof parseMetricScore('3'), 'number')
})

test('rejects out-of-range and non-integer scores', () => {
  for (const value of [0, 6, -1, 1.5, 4.9, Number.NaN, Infinity, -Infinity]) {
    assert.equal(isMetricScore(value), false)
    assert.equal(parseMetricScore(value), null)
  }
  assert.equal(parseMetricScore('0'), null)
  assert.equal(parseMetricScore('6'), null)
  assert.equal(parseMetricScore('3.0'), null)
  assert.equal(parseMetricScore('+3'), null)
  assert.equal(parseMetricScore('03'), null)
})

test('never coerces blanks, booleans, or free text into a score', () => {
  for (const value of [null, undefined, '', '  ', true, false, {}, [], [3]]) {
    assert.equal(isMetricScore(value), false)
    assert.equal(parseMetricScore(value), null)
  }
  assert.equal(parseMetricScore('n/a'), null)
  assert.equal(parseMetricScore('not applicable'), null)
  assert.equal(parseMetricScore('good'), null)
})

test('a parsed score is usable wherever a MetricScore is required', () => {
  const parsed = parseMetricScore('4')
  assert.notEqual(parsed, null)
  const score: MetricScore = parsed ?? 'NA'
  assert.equal(score, 4)
})
