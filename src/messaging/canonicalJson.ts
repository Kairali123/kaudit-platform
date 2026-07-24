import { sha256Hex } from '../lib/hash.ts'

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

function canonical(value: JsonValue): string {
  if (value === null || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Canonical JSON rejects non-finite numbers')
    }
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0,
  )
  return `{${entries
    .map(
      ([key, item]) =>
        `${JSON.stringify(key)}:${canonical(item)}`,
    )
    .join(',')}}`
}

export function canonicalJson(value: JsonValue): string {
  return canonical(value)
}

export function canonicalJsonSha256(value: JsonValue): string {
  return sha256Hex(canonicalJson(value))
}
