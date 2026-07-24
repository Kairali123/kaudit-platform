import type { EvidenceRow } from '../domain/types.ts'

// Reads bytes from the CURRENT (pre-migration) store.
export interface SourceReader {
  read(bucket: string, key: string): Promise<Buffer | null>
}

// The durable target: versioned + Object-Lock (WORM) + KMS-encrypted object storage.
export interface DurableTarget {
  readonly bucket: string
  has(key: string, sha256: string): Promise<{ present: boolean; versionId: string | null }>
  put(
    key: string,
    body: Buffer,
    sha256: string,
    metadata: Record<string, string>,
  ): Promise<{ versionId: string | null }>
}

// Reads candidate rows and updates evidence-object location / records issues.
export interface EvidenceRepo {
  listCandidates(limit: number): Promise<EvidenceRow[]>
  updateLocation(id: string, bucket: string, key: string, versionId: string | null): Promise<void>
  recordIssue(id: string, code: string, detail: string): Promise<void>
}
