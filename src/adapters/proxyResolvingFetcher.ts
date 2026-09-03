import type { FetchResult, UrlFetcher } from '../storage/ports.ts'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
const MAX_PROXY_JSON_BYTES = 64 * 1024

function isSameSourceObject(sourceUrl: string, resolvedUrl: string): boolean {
  try {
    const source = new URL(sourceUrl)
    const resolved = new URL(resolvedUrl)
    return (
      resolved.protocol === 'https:' &&
      resolved.username === '' &&
      resolved.password === '' &&
      resolved.hostname.toLowerCase() === source.hostname.toLowerCase() &&
      resolved.port === source.port &&
      resolved.pathname === source.pathname
    )
  } catch {
    return false
  }
}

function extractSignedUrl(
  payload: unknown,
  sourceUrl: string,
): { url: string | null; sawHttpsUrl: boolean } {
  const matches: string[] = []
  let sawHttpsUrl = false
  let visited = 0

  const visit = (value: unknown, depth: number): void => {
    if (depth > 4 || visited >= 100) return
    visited += 1
    if (typeof value === 'string') {
      const candidate = value.trim()
      if (!candidate.startsWith('https://')) return
      sawHttpsUrl = true
      if (isSameSourceObject(sourceUrl, candidate)) matches.push(candidate)
      return
    }
    if (!value || typeof value !== 'object') return
    for (const nested of Object.values(value)) visit(nested, depth + 1)
  }

  visit(payload, 0)
  return {
    // Prefer a query-bearing match over an echoed stable object URL.
    url: matches.find((value) => new URL(value).search.length > 0)
      ?? matches[0]
      ?? null,
    sawHttpsUrl,
  }
}

// Fetches recording bytes through the unpod.ai proxy.
//
// The proxy has used two response contracts: direct audio bytes, and JSON containing
// a short-lived signed URL. Both are supported without allowing the JSON response
// to redirect fetching to a different object or host.
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
        let audioResponse = res
        if (contentType.startsWith('application/json')) {
          const contentLength = Number(res.headers.get('content-length') || 0)
          if (contentLength > MAX_PROXY_JSON_BYTES) {
            return { ok: false, status: res.status, error: 'proxy_json_too_large' }
          }
          const jsonBytes = Buffer.from(await res.arrayBuffer())
          if (jsonBytes.byteLength > MAX_PROXY_JSON_BYTES) {
            return { ok: false, status: res.status, error: 'proxy_json_too_large' }
          }
          let payload: unknown
          try {
            payload = JSON.parse(jsonBytes.toString('utf8'))
          } catch {
            return { ok: false, status: res.status, error: 'proxy_json_invalid' }
          }
          const extracted = extractSignedUrl(payload, s3ObjectUrl)
          const signedUrl = extracted.url
          if (!signedUrl) {
            return {
              ok: false,
              status: res.status,
              error: extracted.sawHttpsUrl
                ? 'proxy_signed_url_rejected'
                : 'proxy_signed_url_missing',
            }
          }
          audioResponse = await doFetch(signedUrl, {
            redirect: 'error',
            signal: AbortSignal.timeout(120_000),
          })
          if (!audioResponse.ok) {
            return {
              ok: false,
              status: audioResponse.status,
              error: `HTTP ${audioResponse.status}`,
            }
          }
        }

        const audioContentType = (
          audioResponse.headers.get('content-type') || ''
        ).toLowerCase()
        if (!audioContentType.startsWith('audio/')) {
          return {
            ok: false,
            status: audioResponse.status,
            error: `non_audio_response type=${audioContentType || 'none'}`,
          }
        }

        const bytes = Buffer.from(await audioResponse.arrayBuffer())
        if (bytes.byteLength > maxBytes) {
          return { ok: false, status: audioResponse.status, error: `too_large ${bytes.byteLength}B` }
        }
        if (bytes.byteLength === 0) {
          return { ok: false, status: audioResponse.status, error: 'empty_body' }
        }
        return {
          ok: true,
          status: audioResponse.status,
          bytes,
          contentType: audioContentType,
        }
      } catch (err) {
        return { ok: false, status: null, error: String((err as Error)?.message || err) }
      }
    },
  }
}
