import type { EvidenceRow } from '../domain/types.ts'
import type { DurableTarget, EvidenceRepo, SourceReader } from '../storage/ports.ts'

// Synthetic, in-memory fakes for testing the migration core with no DB, no cloud,
// and no real evidence bytes.

export class InMemorySource implements SourceReader {
  private readonly objects = new Map<string, Buffer>()
  set(bucket: string, key: string, body: Buffer): void {
    this.objects.set(`${bucket}/${key}`, body)
  }
  async read(bucket: string, key: string): Promise<Buffer | null> {
    return this.objects.get(`${bucket}/${key}`) ?? null
  }
}

export class InMemoryDurableTarget implements DurableTarget {
  readonly bucket: string
  readonly puts: { key: string; sha256: string }[] = []
  private readonly store = new Map<string, { versionId: string }>()
  private seq = 0
  constructor(bucket: string) {
    this.bucket = bucket
  }
  async has(key: string): Promise<{ present: boolean; versionId: string | null }> {
    const hit = this.store.get(key)
    return { present: !!hit, versionId: hit?.versionId ?? null }
  }
  async put(key: string, _body: Buffer, sha256: string): Promise<{ versionId: string | null }> {
    this.seq += 1
    const versionId = `v${this.seq}`
    this.store.set(key, { versionId })
    this.puts.push({ key, sha256 })
    return { versionId }
  }
}

export class InMemoryRepo implements EvidenceRepo {
  rows: EvidenceRow[]
  readonly issues: { id: string; code: string; detail: string }[] = []
  constructor(rows: EvidenceRow[]) {
    this.rows = rows
  }
  async listCandidates(limit: number): Promise<EvidenceRow[]> {
    return this.rows.slice(0, limit)
  }
  async updateLocation(id: string, bucket: string, key: string, versionId: string | null): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (row) {
      row.objectBucket = bucket
      row.objectKey = key
      row.objectVersionId = versionId
    }
  }
  async recordIssue(id: string, code: string, detail: string): Promise<void> {
    this.issues.push({ id, code, detail })
  }
}
