import type { EvidenceRow } from '../domain/types.ts'

export interface FetchOk {
  ok: true
  status: number
  bytes: Buffer
}
export interface FetchFail {
  ok: false
  status: number | null
  error: string
}
export type FetchResult = FetchOk | FetchFail

// Fetches vendor-hosted recording bytes (for hashing). Assumes the URL has already
// passed the SSRF/allowlist guard in the verification core.
export interface UrlFetcher {
  fetch(url: string): Promise<FetchResult>
}

// Reads evidence rows for verification and records baseline hashes, successful
// verifications, and findings.
export interface EvidenceRepo {
  listForVerification(limit: number): Promise<EvidenceRow[]>
  recordHash(id: string, sha256: string, verifiedAt: string): Promise<void>
  recordVerified(id: string, verifiedAt: string): Promise<void>
  recordIssue(id: string, code: string, detail: string): Promise<void>
}
