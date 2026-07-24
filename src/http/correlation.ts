import { randomUUID } from 'node:crypto'

const SAFE_CORRELATION = /^[A-Za-z0-9._:-]{8,120}$/

export function correlationId(
  incoming: string | string[] | undefined,
): string {
  const value = Array.isArray(incoming) ? incoming[0] : incoming
  return value && SAFE_CORRELATION.test(value)
    ? value
    : randomUUID()
}
