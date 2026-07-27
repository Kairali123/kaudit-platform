import type { FetchResult, UrlFetcher } from '../storage/ports.ts'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

// Fetches recording bytes through the unpod.ai proxy.
//
// OBSERVED BEHAVIOR (verified 2026-07-24 against a live sample):
//   GET {proxyBase}?url={s3ObjectUrl}  →  200, content-type audio/ogg, ~33 KB,
//   streams the audio bytes DIRECTLY (redirects=0; no JSON, no signed-URL to follow,
//   no second request). So one GET yields the bytes to hash.
//
// The proxy is re-called FRESH on every verification — we store only the stable S3
// object URL (in `source_url`), never a resolved/expiring signed URL.
//
// SSRF posture (defense in depth):
//   • the row-controlled value (the S3 object URL) is constrained by the allowlist
//     guard in the verification core (isSafeVendorUrl);
//   • the egress host (the proxy) is fixed config, not row-controlled;
//   • redirect:'error' stops the proxy from bouncing us to an unexpected host;
//   • a 200 whose content-type is not audio/* is rejected as a wrong/error body.
export function createProxyResolvingFetcher(
  proxyBase: string,
  opts: { maxBytes?: number; fetchImpl?: typeof fetch } = {},
): UrlFetcher {
  const base = proxyBase.trim()
  if (!base.startsWith('https://')) {
    throw new Error('KAUDIT_UNPOD_PROXY_BASE must be an https:// URL')
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES
  const doFetch = opts.fetchImpl ?? fetch

  return {
    async fetch(s3ObjectUrl: string): Promise<FetchResult> {
      if (!s3ObjectUrl.startsWith('https://')) {
        return { ok: false, status: null, error: 'source_url is not https' }
      }
      // Built fresh each call. The nested URL is passed raw in the query, matching
      // the observed working request.
      const proxyUrl = `${base}${base.includes('?') ? '&' : '?'}url=${s3ObjectUrl}`
      try {
        const res = await doFetch(proxyUrl, {
          redirect: 'error',
          signal: AbortSignal.timeout(120_000),
        })
        if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }

        const contentType = (res.headers.get('content-type') || '').toLowerCase()
        if (!contentType.startsWith('audio/')) {
          return { ok: false, status: res.status, error: `non_audio_response type=${contentType || 'none'}` }
        }

        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.byteLength > maxBytes) {
          return { ok: false, status: res.status, error: `too_large ${bytes.byteLength}B` }
        }
        if (bytes.byteLength === 0) {
          return { ok: false, status: res.status, error: 'empty_body' }
        }
        return { ok: true, status: res.status, bytes, contentType }
      } catch (err) {
        return { ok: false, status: null, error: String((err as Error)?.message || err) }
      }
    },
  }
}
