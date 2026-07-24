import type { BackfillCandidate, BackfillRepo, RawStore } from '../backfill/ports.ts'

export class InMemoryRawStore implements RawStore {
  private readonly docs = new Map<string, unknown>()
  set(bucket: string, key: string, doc: unknown): void {
    this.docs.set(`${bucket}/${key}`, doc)
  }
  async readJson(bucket: string, key: string): Promise<unknown | null> {
    const k = `${bucket}/${key}`
    return this.docs.has(k) ? (this.docs.get(k) ?? null) : null
  }
}

export class InMemoryBackfillRepo implements BackfillRepo {
  candidates: BackfillCandidate[]
  readonly updates: { id: string; s3Url: string }[] = []
  readonly issues: { id: string; code: string; detail: string }[] = []
  constructor(candidates: BackfillCandidate[]) {
    this.candidates = candidates
  }
  async listCandidates(limit: number): Promise<BackfillCandidate[]> {
    return this.candidates.slice(0, limit)
  }
  async setSourceUrl(id: string, s3Url: string): Promise<void> {
    this.updates.push({ id, s3Url })
    const c = this.candidates.find((x) => x.evidenceObjectId === id)
    if (c) c.existingSourceUrl = s3Url
  }
  async recordIssue(id: string, code: string, detail: string): Promise<void> {
    this.issues.push({ id, code, detail })
  }
}
