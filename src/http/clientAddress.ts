import type { IncomingMessage } from 'node:http'

function clean(value: string | undefined): string | null {
  if (!value) return null
  const candidate = value.trim().slice(0, 64)
  return /^[0-9a-fA-F:.]{2,64}$/.test(candidate)
    ? candidate
    : null
}

export function clientAddress(
  request: IncomingMessage,
  trustProxy: boolean,
): string | null {
  if (trustProxy) {
    const raw = request.headers['x-forwarded-for']
    const first = (
      Array.isArray(raw) ? raw[0] : raw
    )?.split(',')[0]
    const forwarded = clean(first)
    if (forwarded) return forwarded
  }
  return clean(request.socket.remoteAddress)
}
