import { test } from 'node:test'
import assert from 'node:assert/strict'
import { migrateEvidenceObject, migrateEvidenceBatch } from './migrateEvidenceStorage.ts'
import { InMemorySource, InMemoryDurableTarget, InMemoryRepo } from '../fixtures/inMemory.ts'
import { sha256Hex } from '../lib/hash.ts'
import type { EvidenceRow } from '../domain/types.ts'

const DURABLE = 'kaudit-durable-apsouth1'

function rowFor(id: string, bucket: string, key: string, body: Buffer): EvidenceRow {
  return {
    id,
    objectBucket: bucket,
    objectKey: key,
    sha256: sha256Hex(body),
    sizeBytes: body.length,
    objectVersionId: null,
  }
}

test('migrates a matching object and updates the row', async () => {
  const body = Buffer.from('synthetic-recording-bytes')
  const row = rowFor('eo1', 'kaudit-local', 'recordings/eo1/x.ogg', body)
  const source = new InMemorySource()
  source.set('kaudit-local', row.objectKey, body)
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([row])

  const res = await migrateEvidenceObject(row, { source, target, repo }, { dryRun: false })

  assert.equal(res.outcome, 'migrated')
  assert.equal(res.versionId, 'v1')
  assert.equal(row.objectBucket, DURABLE)
  assert.equal(target.puts.length, 1)
  assert.equal(repo.issues.length, 0)
})

test('hash mismatch is quarantined and NOT written to durable', async () => {
  const body = Buffer.from('real-bytes')
  const row = rowFor('eo2', 'local-disk', 'raw/eo2.json', body)
  // Source returns different bytes than the hash recorded at ingestion.
  const source = new InMemorySource()
  source.set('local-disk', row.objectKey, Buffer.from('TAMPERED'))
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([row])

  const res = await migrateEvidenceObject(row, { source, target, repo }, { dryRun: false })

  assert.equal(res.outcome, 'hash_mismatch')
  assert.equal(target.puts.length, 0)
  assert.equal(repo.issues[0]?.code, 'hash_mismatch')
  assert.equal(row.objectBucket, 'local-disk') // unchanged — not migrated
})

test('missing source bytes is flagged, not fatal', async () => {
  const body = Buffer.from('gone')
  const row = rowFor('eo3', 'local-disk', 'raw/missing.json', body)
  const source = new InMemorySource() // nothing set
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([row])

  const res = await migrateEvidenceObject(row, { source, target, repo }, { dryRun: false })

  assert.equal(res.outcome, 'source_missing')
  assert.equal(repo.issues[0]?.code, 'source_missing')
})

test('already-durable row is skipped (idempotent)', async () => {
  const body = Buffer.from('x')
  const row = rowFor('eo4', DURABLE, 'recordings/eo4/x.ogg', body)
  const source = new InMemorySource()
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([row])

  const res = await migrateEvidenceObject(row, { source, target, repo }, { dryRun: false })

  assert.equal(res.outcome, 'skipped_already_durable')
  assert.equal(target.puts.length, 0)
})

test('re-running after a completed migration does not duplicate the upload', async () => {
  const body = Buffer.from('resume-me')
  const row = rowFor('eo5', 'kaudit-local', 'recordings/eo5/x.ogg', body)
  const source = new InMemorySource()
  source.set('kaudit-local', row.objectKey, body)
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([row])

  await migrateEvidenceObject(row, { source, target, repo }, { dryRun: false })
  const res2 = await migrateEvidenceObject(row, { source, target, repo }, { dryRun: false })

  assert.equal(res2.outcome, 'skipped_already_durable')
  assert.equal(target.puts.length, 1) // still exactly one upload
})

test('dry-run writes nothing but reports would_migrate', async () => {
  const body = Buffer.from('dry')
  const row = rowFor('eo6', 'kaudit-local', 'recordings/eo6/x.ogg', body)
  const source = new InMemorySource()
  source.set('kaudit-local', row.objectKey, body)
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([row])

  const summary = await migrateEvidenceBatch([row], { source, target, repo }, { dryRun: true })

  assert.equal(summary.total, 1)
  assert.equal(summary.wouldMigrate, 1)
  assert.equal(target.puts.length, 0)
  assert.equal(repo.issues.length, 0)
  assert.equal(row.objectBucket, 'kaudit-local') // unchanged
})

test('batch summary counts each outcome', async () => {
  const good = Buffer.from('good')
  const rowGood = rowFor('b1', 'kaudit-local', 'recordings/b1/x.ogg', good)
  const rowMissing = rowFor('b2', 'local-disk', 'raw/b2.json', Buffer.from('x'))
  const rowDurable = rowFor('b3', DURABLE, 'recordings/b3/x.ogg', Buffer.from('y'))
  const source = new InMemorySource()
  source.set('kaudit-local', rowGood.objectKey, good)
  const target = new InMemoryDurableTarget(DURABLE)
  const repo = new InMemoryRepo([rowGood, rowMissing, rowDurable])

  const summary = await migrateEvidenceBatch(
    [rowGood, rowMissing, rowDurable],
    { source, target, repo },
    { dryRun: false },
  )

  assert.equal(summary.total, 3)
  assert.equal(summary.migrated, 1)
  assert.equal(summary.sourceMissing, 1)
  assert.equal(summary.skippedAlreadyDurable, 1)
})
