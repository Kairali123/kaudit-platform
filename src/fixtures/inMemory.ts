import type { EvidenceRow } from '../domain/types.ts'
import type { EvidenceRepo, FetchResult, UrlFetcher } from '../storage/ports.ts'

// Synthetic, in-memory fakes for testing the verification core with no DB,
// no network, and no real evidence bytes.

export class InMemoryFetcher implements UrlFetcher {
  private readonly responses = new Map<string, FetchResult>()
  readonly calls: string[] = []
  set(url: string, result: FetchResult): void {
    this.responses.set(url, result)
  }
  async fetch(url: string): Promise<FetchResult> {
    this.calls.push(url)
    return this.responses.get(url) ?? { ok: false, status: 404, error: 'not found' }
  }
}

export class InMemoryVerifyRepo implements EvidenceRepo {
  rows: EvidenceRow[]
  readonly hashes: { id: string; sha256: string; at: string }[] = []
  readonly verified: { id: string; at: string }[] = []
  readonly issues: { id: string; code: string; detail: string }[] = []
  constructor(rows: EvidenceRow[]) {
    this.rows = rows
  }
  async listForVerification(limit: number): Promise<EvidenceRow[]> {
    return this.rows.slice(0, limit)
  }
  async recordHash(id: string, sha256: string, at: string): Promise<void> {
    this.hashes.push({ id, sha256, at })
    const row = this.rows.find((r) => r.id === id)
    if (row) {
      row.sha256 = sha256
      row.lastVerifiedAt = at
    }
  }
  async recordVerified(id: string, at: string): Promise<void> {
    this.verified.push({ id, at })
    const row = this.rows.find((r) => r.id === id)
    if (row) row.lastVerifiedAt = at
  }
  async recordIssue(id: string, code: string, detail: string): Promise<void> {
    this.issues.push({ id, code, detail })
  }
}
