export interface EvidenceRow {
  id: string
  objectBucket: string
  objectKey: string
  sha256: string
  sizeBytes: number | null
  objectVersionId: string | null
}

export type MigrationOutcome =
  | 'migrated'
  | 'skipped_already_durable'
  | 'would_migrate'
  | 'source_missing'
  | 'hash_mismatch'

export interface RowResult {
  id: string
  outcome: MigrationOutcome
  versionId?: string | null
  expectedSha?: string
  actualSha?: string
}

export interface MigrationOptions {
  dryRun: boolean
}

export interface MigrationSummary {
  total: number
  migrated: number
  skippedAlreadyDurable: number
  wouldMigrate: number
  sourceMissing: number
  hashMismatch: number
  results: RowResult[]
}
