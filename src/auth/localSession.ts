import {
  createHmac,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto'

interface SessionPayload {
  v: 1
  email: string
  exp: number
}

function encoded(value: Buffer | string): string {
  return Buffer.from(value).toString('base64url')
}

function decoded(value: string): Buffer {
  return Buffer.from(value, 'base64url')
}

function signature(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url')
}

export function createLocalPasswordHash(
  password: string,
  salt = randomBytes(16),
): string {
  if (!password || password.length > 512) {
    throw new Error('Local password must contain 1 to 512 characters')
  }
  const digest = scryptSync(password, salt, 32)
  return `scrypt$${encoded(salt)}$${encoded(digest)}`
}

export function verifyLocalPassword(
  password: string,
  storedHash: string,
): boolean {
  if (!password || password.length > 512) return false
  const [algorithm, saltValue, digestValue, extra] =
    storedHash.split('$')
  if (
    algorithm !== 'scrypt' ||
    !saltValue ||
    !digestValue ||
    extra != null
  ) {
    return false
  }
  try {
    const expected = decoded(digestValue)
    if (expected.byteLength !== 32) return false
    const actual = scryptSync(password, decoded(saltValue), 32)
    return timingSafeEqual(actual, expected)
  } catch {
    return false
  }
}

export function issueLocalSession(
  email: string,
  secret: string,
  ttlSeconds: number,
  now = new Date(),
): string {
  const payload: SessionPayload = {
    v: 1,
    email: email.toLowerCase(),
    exp: Math.floor(now.getTime() / 1000) + ttlSeconds,
  }
  const body = encoded(JSON.stringify(payload))
  return `${body}.${signature(body, secret)}`
}

export function verifyLocalSession(
  token: string | null,
  secret: string,
  expectedEmail: string,
  now = new Date(),
): string | null {
  if (!token || token.length > 4096) return null
  const [body, suppliedSignature, extra] = token.split('.')
  if (!body || !suppliedSignature || extra != null) return null
  const expectedSignature = signature(body, secret)
  const supplied = Buffer.from(suppliedSignature)
  const expected = Buffer.from(expectedSignature)
  if (
    supplied.byteLength !== expected.byteLength ||
    !timingSafeEqual(supplied, expected)
  ) {
    return null
  }
  try {
    const payload = JSON.parse(
      decoded(body).toString('utf8'),
    ) as Partial<SessionPayload>
    const nowSeconds = Math.floor(now.getTime() / 1000)
    if (
      payload.v !== 1 ||
      typeof payload.email !== 'string' ||
      payload.email.toLowerCase() !== expectedEmail.toLowerCase() ||
      typeof payload.exp !== 'number' ||
      !Number.isInteger(payload.exp) ||
      payload.exp <= nowSeconds
    ) {
      return null
    }
    return payload.email.toLowerCase()
  } catch {
    return null
  }
}

export function localSessionCookie(
  name: string,
  token: string,
  ttlSeconds: number,
): string {
  return `${name}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ttlSeconds}`
}

export function clearLocalSessionCookie(name: string): string {
  return `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`
}
