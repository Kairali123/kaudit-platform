import type { FetchResult, UrlFetcher } from '../storage/ports.ts'

const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

// Fetches vendor recording bytes for hashing. The URL is assumed to have already
// passed isSafeVendorUrl() in the verification core; this adapter adds:
//  - redirect: 'error'  → prevents redirect-based SSRF bypass past the allowlist
//  - a size cap and a timeout.
export function createHttpUrlFetcher(maxBytes = DEFAULT_MAX_BYTES): UrlFetcher {
  return {
    async fetch(url: string): Promise<FetchResult> {
      try {
        const res = await fetch(url, {
          redirect: 'error',
          signal: AbortSignal.timeout(30_000),
        })
        if (!res.ok) return { ok: false, status: res.status, error: `HTTP ${res.status}` }
        const buf = Buffer.from(await res.arrayBuffer())
        if (buf.byteLength > maxBytes) {
          return { ok: false, status: res.status, error: `too_large ${buf.byteLength}B` }
        }
        return { ok: true, status: res.status, bytes: buf }
      } catch (err) {
        return { ok: false, status: null, error: String((err as Error)?.message || err) }
      }
    },
  }
}
