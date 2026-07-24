import type {
  EvidenceRow,
  VerifyOptions,
  VerifyResult,
  VerifySummary,
} from '../domain/types.ts'
import type { EvidenceRepo, UrlFetcher } from './ports.ts'
import { isSafeVendorUrl } from '../security/urlSafety.ts'
import { sha256Hex } from '../lib/hash.ts'

// ─────────────────────────────────────────────────────────────────────────────
// CONSCIOUS TRADE-OFF — cost-driven, made knowingly by leadership (2026-07-24).
//
// Recordings are referenced by their KServe URL and are NOT copied into
// independent Kairali-controlled storage. Evidence therefore lives on the
// VENDOR's own infrastructure. This overrides:
//   • ADR-018 ("Kairali controls the first durable evidence copy"),
//   • the launch-gate rule that a supplier must not be the sole custodian of the
//     evidence used to verify its own invoice, and
//   • the "no long-lived recording URLs in the DB" rule (the URL is stored,
//     server-side only, to enable refetch).
//
// The sha256 gate below is our ONLY safeguard, and it can only detect alteration
// WHILE the URL still resolves. If KServe expires/deletes a recording we keep a
// hash but cannot reproduce the bytes — weak dispute evidence against a
// counterparty. Recorded as D-13 in the architecture package. See
// docs/W3_STORAGE_MIGRATION.md.
// ─────────────────────────────────────────────────────────────────────────────

export interface VerifyPorts {
  fetcher: UrlFetcher
  repo: EvidenceRepo
  allowedHosts: string[]
  now: () => string
}

export async function verifyEvidenceUrl(
  row: EvidenceRow,
  ports: VerifyPorts,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const { fetcher, repo, allowedHosts, now } = ports

  if (!row.sourceUrl) {
    if (!opts.dryRun) await repo.recordIssue(row.id, 'no_url', 'evidence row has no source URL')
    return { id: row.id, outcome: 'no_url' }
  }

  const safety = isSafeVendorUrl(row.sourceUrl, allowedHosts)
  if (!safety.safe) {
    if (!opts.dryRun) await repo.recordIssue(row.id, 'unsafe_url', safety.reason ?? 'unsafe')
    return { id: row.id, outcome: 'unsafe_url' }
  }

  const res = await fetcher.fetch(row.sourceUrl)
  if (!res.ok) {
    if (!opts.dryRun) {
      await repo.recordIssue(row.id, 'source_missing', `fetch failed status=${res.status} ${res.error}`)
    }
    return { id: row.id, outcome: 'source_missing', httpStatus: res.status }
  }

  const fetchedSha = sha256Hex(res.bytes)

  // Ingestion: the first successful fetch establishes the baseline hash.
  if (!row.sha256) {
    if (!opts.dryRun) await repo.recordHash(row.id, fetchedSha, now())
    return { id: row.id, outcome: 'hash_recorded', fetchedSha }
  }

  // Re-verification: the vendor-hosted bytes must still match the baseline.
  if (fetchedSha === row.sha256) {
    if (!opts.dryRun) await repo.recordVerified(row.id, now())
    return { id: row.id, outcome: 'verified', recordedSha: row.sha256, fetchedSha }
  }

  if (!opts.dryRun) {
    await repo.recordIssue(row.id, 'evidence_altered', `recorded ${row.sha256} now ${fetchedSha}`)
  }
  return { id: row.id, outcome: 'evidence_altered', recordedSha: row.sha256, fetchedSha }
}

export async function verifyEvidenceBatch(
  rows: EvidenceRow[],
  ports: VerifyPorts,
  opts: VerifyOptions,
): Promise<VerifySummary> {
  const results: VerifyResult[] = []
  for (const row of rows) results.push(await verifyEvidenceUrl(row, ports, opts))
  const c = (o: string): number => results.filter((r) => r.outcome === o).length
  return {
    total: results.length,
    hashRecorded: c('hash_recorded'),
    verified: c('verified'),
    evidenceAltered: c('evidence_altered'),
    sourceMissing: c('source_missing'),
    unsafeUrl: c('unsafe_url'),
    noUrl: c('no_url'),
    results,
  }
}
