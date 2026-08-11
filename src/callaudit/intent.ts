import { CALL_INTENTS, type CallIntent } from './types.ts'

export function isCallIntent(value: unknown): value is CallIntent {
  return (
    typeof value === 'string' &&
    (CALL_INTENTS as readonly string[]).includes(value)
  )
}

/**
 * Normalizes an untrusted value into an explicit intent.
 *
 * Returns null when the intent is unknown or absent. Absence is never read as
 * WARM: WARM is an explicit value that the source must state.
 */
export function parseCallIntent(value: unknown): CallIntent | null {
  if (typeof value !== 'string') {
    return null
  }
  const normalized = value.trim().toUpperCase()
  return isCallIntent(normalized) ? normalized : null
}
