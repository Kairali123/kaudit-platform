export interface EvidenceRow {
  id: string
  /** KServe vendor-hosted recording URL. Server-only; never sent to browser/exports. */
  sourceUrl: string | null
  /** sha256 of the bytes recorded at the first successful fetch (ingestion baseline). */
  sha256: string | null
  sizeBytes: number | null
  lastVerifiedAt: string | null
}

export type VerifyOutcome =
  | 'hash_recorded' // first successful fetch; baseline hash stored
  | 'verified' // refetch matches the baseline hash
  | 'evidence_altered' // refetch differs from baseline → FINDING
  | 'source_missing' // URL 404 / expired / unreachable → FINDING
  | 'unsafe_url' // URL failed the SSRF/allowlist guard → FINDING
  | 'no_url' // row has no source URL → FINDING

export interface VerifyResult {
  id: string
  outcome: VerifyOutcome
  recordedSha?: string
  fetchedSha?: string
  httpStatus?: number | null
}

export interface VerifyOptions {
  /** If true, fetch + report but write no hashes/verifications/findings. */
  dryRun: boolean
}

export interface VerifySummary {
  total: number
  hashRecorded: number
  verified: number
  evidenceAltered: number
  sourceMissing: number
  unsafeUrl: number
  noUrl: number
  results: VerifyResult[]
}
