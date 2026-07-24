// Pre-fetch guard for vendor recording URLs.
//
// Because evidence is now VENDOR-HOSTED and we REFETCH KServe URLs repeatedly (see
// verifyEvidenceUrl.ts trade-off note), this guard runs before every fetch: HTTPS
// only, host on the approved allowlist, and no loopback / private / link-local
// targets (basic SSRF defense). Deeper defenses (DNS-rebinding, redirect pinning)
// belong in the fetch adapter (redirect: 'error') and network egress controls.

export interface UrlSafety {
  safe: boolean
  reason?: string
}

const PRIVATE_IPV4: RegExp[] = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\./,
]

export function isSafeVendorUrl(rawUrl: string, allowedHosts: string[]): UrlSafety {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { safe: false, reason: 'unparseable_url' }
  }
  if (url.protocol !== 'https:') return { safe: false, reason: 'not_https' }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return { safe: false, reason: 'loopback' }
  if (PRIVATE_IPV4.some((re) => re.test(host))) return { safe: false, reason: 'private_ip' }
  if (host === '::1' || host.startsWith('fe80:') || host.startsWith('fc') || host.startsWith('fd')) {
    return { safe: false, reason: 'private_ipv6' }
  }

  const allowed = allowedHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()),
  )
  if (!allowed) return { safe: false, reason: 'host_not_allowlisted' }

  return { safe: true }
}
