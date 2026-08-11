import {
  METRIC_SCORE_NOT_APPLICABLE,
  type MetricScore,
  type MetricScoreValue,
} from './types.ts'

const METRIC_SCORE_VALUES: readonly MetricScoreValue[] = [1, 2, 3, 4, 5]

export function isMetricScore(value: unknown): value is MetricScore {
  if (value === METRIC_SCORE_NOT_APPLICABLE) {
    return true
  }
  return (
    typeof value === 'number' &&
    (METRIC_SCORE_VALUES as readonly number[]).includes(value)
  )
}

/**
 * Normalizes an untrusted value into a metric score: an integer 1–5, or NA.
 * Returns null for anything else — fractions, out-of-range integers, blanks,
 * booleans, and non-numeric text are never coerced into a score.
 */
export function parseMetricScore(value: unknown): MetricScore | null {
  if (typeof value === 'number') {
    return isMetricScore(value) ? value : null
  }
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  if (!trimmed) {
    return null
  }
  if (trimmed.toUpperCase() === METRIC_SCORE_NOT_APPLICABLE) {
    return METRIC_SCORE_NOT_APPLICABLE
  }
  if (!/^[1-5]$/.test(trimmed)) {
    return null
  }
  return Number(trimmed) as MetricScoreValue
}
