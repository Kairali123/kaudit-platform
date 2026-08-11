export const HTML_SECURITY_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; img-src 'self' data:; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export const STATIC_SECURITY_HEADERS = {
  ...HTML_SECURITY_HEADERS,
  'cache-control': 'public, max-age=31536000, immutable',
} as const

export const JSON_SECURITY_HEADERS = {
  ...HTML_SECURITY_HEADERS,
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'",
} as const
