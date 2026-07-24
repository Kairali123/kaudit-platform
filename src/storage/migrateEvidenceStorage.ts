import type {
  EvidenceRow,
  MigrationOptions,
  MigrationSummary,
  RowResult,
} from '../domain/types.ts'
import type { DurableTarget, EvidenceRepo, SourceReader } from './ports.ts'
import { sha256Hex } from '../lib/hash.ts'

export interface MigrationPorts {
  source: SourceReader
  target: DurableTarget
  repo: EvidenceRepo
}

/**
 * Migrate one evidence object from the current store to durable storage.
 *
 * Guarantees:
 *  - Integrity gate: the source bytes must hash-match the sha256 recorded at
 *    ingestion; a mismatch is quarantined and NOT written to durable storage.
 *  - Idempotent / resume-safe: a row already on the durable bucket is skipped;
 *    an object already present on the target is not re-uploaded.
 *  - Missing source bytes are recorded as a finding, never silently dropped.
 */
export async function migrateEvidenceObject(
  row: EvidenceRow,
  ports: MigrationPorts,
  opts: MigrationOptions,
): Promise<RowResult> {
  const { source, target, repo } = ports

  // Already on the durable target → nothing to do (idempotent).
  if (row.objectBucket === target.bucket) {
    return { id: row.id, outcome: 'skipped_already_durable', versionId: row.objectVersionId }
  }

  const bytes = await source.read(row.objectBucket, row.objectKey)
  if (!bytes) {
    if (!opts.dryRun) {
      await repo.recordIssue(row.id, 'source_missing', `No bytes at ${row.objectBucket}/${row.objectKey}`)
    }
    return { id: row.id, outcome: 'source_missing' }
  }

  // Integrity gate.
  const actualSha = sha256Hex(bytes)
  if (actualSha !== row.sha256) {
    if (!opts.dryRun) {
      await repo.recordIssue(row.id, 'hash_mismatch', `expected ${row.sha256} got ${actualSha}`)
    }
    return { id: row.id, outcome: 'hash_mismatch', expectedSha: row.sha256, actualSha }
  }

  if (opts.dryRun) {
    return { id: row.id, outcome: 'would_migrate' }
  }

  // Resume-safe: reuse an already-uploaded object if a prior run was interrupted
  // between put() and updateLocation().
  const existing = await target.has(row.objectKey, row.sha256)
  let versionId = existing.versionId
  if (!existing.present) {
    const put = await target.put(row.objectKey, bytes, row.sha256, { evidenceObjectId: row.id })
    versionId = put.versionId
  }

  await repo.updateLocation(row.id, target.bucket, row.objectKey, versionId)
  return { id: row.id, outcome: 'migrated', versionId }
}

export async function migrateEvidenceBatch(
  rows: EvidenceRow[],
  ports: MigrationPorts,
  opts: MigrationOptions,
): Promise<MigrationSummary> {
  const results: RowResult[] = []
  for (const row of rows) {
    results.push(await migrateEvidenceObject(row, ports, opts))
  }
  const count = (o: string): number => results.filter((r) => r.outcome === o).length
  return {
    total: results.length,
    migrated: count('migrated'),
    skippedAlreadyDurable: count('skipped_already_durable'),
    wouldMigrate: count('would_migrate'),
    sourceMissing: count('source_missing'),
    hashMismatch: count('hash_mismatch'),
    results,
  }
}
