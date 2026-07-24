// Normalizes whatever recording URL is found in a raw KServe export into the STABLE
// S3 object URL that `source_url` should hold (the value the unpod.ai proxy fetcher
// passes as `?url=`).
//
// Handles the three shapes the raw payload might contain:
//   • a plain S3 object URL            → strip any query, keep origin+path
//   • a SIGNED S3 URL (…?X-Amz-…=…)    → strip the signing query → stable object URL
//   • a proxy-wrapped URL (…?url=<s3>) → unwrap the inner url and normalize that
// Anything whose final host is not on the S3 allowlist is rejected (never stored).

export interface NormalizeResult {
  ok: boolean
  s3Url?: string
  reason?: string
}

export function normalizeRecordingUrl(
  raw: string,
  allowedHosts: string[],
  depth = 0,
): NormalizeResult {
  if (depth > 2) return { ok: false, reason: 'too_many_wrappers' }

  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'unparseable' }
  }

  // Unwrap a proxy wrapper FIRST (…?url=<inner>), regardless of the outer host, so the
  // result is always the canonical inner S3 object URL — even if the proxy host itself is
  // on the allowlist. (Plain/signed S3 URLs carry X-Amz-* params, never `url`.)
  const inner = u.searchParams.get('url')
  if (inner) return normalizeRecordingUrl(inner, allowedHosts, depth + 1)

  const host = u.hostname.toLowerCase()
  const isAllowedS3 = allowedHosts.some(
    (h) => host === h.toLowerCase() || host.endsWith('.' + h.toLowerCase()),
  )
  if (isAllowedS3) {
    if (u.protocol !== 'https:') return { ok: false, reason: 'not_https' }
    if (!u.pathname || u.pathname === '/') return { ok: false, reason: 'empty_path' }
    // Strip the query string → drop any signing token, keep the stable object URL.
    return { ok: true, s3Url: `${u.origin}${u.pathname}` }
  }

  return { ok: false, reason: 'unrecognized_host' }
}
