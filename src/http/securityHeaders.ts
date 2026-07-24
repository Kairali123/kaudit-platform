export const HTML_SECURITY_HEADERS = {
  'cache-control': 'no-store, max-age=0',
  'content-security-policy':
    "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'; object-src 'none'",
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy':
    'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
} as const

export const JSON_SECURITY_HEADERS = {
  ...HTML_SECURITY_HEADERS,
  'content-security-policy':
    "default-src 'none'; frame-ancestors 'none'",
} as const
