import { test } from 'node:test'
import assert from 'node:assert/strict'
import { backfillSourceUrl, backfillBatch } from './backfillSourceUrl.ts'
import { InMemoryRawStore, InMemoryBackfillRepo } from '../fixtures/inMemoryBackfill.ts'
import type { BackfillCandidate } from './ports.ts'

const S3_HOSTS = ['cdr-storage-recs.s3.ap-south-1.amazonaws.com']
const OBJ = 'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/high-call-recordings/call_x.ogg'

function candidate(over: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    evidenceObjectId: 'eo1',
    callId: 'c1',
    logicalCallKey: 'task-123',
    rawBucket: 'local-disk',
    rawKey: 'raw/export-1.json',
    existingSourceUrl: null,
    ...over,
  }
}
function opts(dryRun = false) {
  return { dryRun, allowedHosts: S3_HOSTS }
}

test('backfills source_url from a taskId-keyed export (plain S3 URL)', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { 'task-123': { recordingUrl: OBJ } })
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())

  assert.equal(res.outcome, 'backfilled')
  assert.equal(res.s3Url, OBJ)
  assert.equal(repo.updates[0]?.s3Url, OBJ)
})

test('normalizes a proxy-wrapped recordingUrl to the inner S3 URL', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', {
    'task-123': { recordingUrl: `https://unpod.ai/api/v1/media/download-signed-url/?url=${OBJ}` },
  })
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())

  assert.equal(res.outcome, 'backfilled')
  assert.equal(res.s3Url, OBJ)
})

test('handles a single-record export that carries recordingUrl at the top level', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { recordingUrl: OBJ, foo: 'bar' })
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())
  assert.equal(res.outcome, 'backfilled')
})

test('already-present source_url is skipped', async () => {
  const c = candidate({ existingSourceUrl: OBJ })
  const raw = new InMemoryRawStore()
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())
  assert.equal(res.outcome, 'already_present')
  assert.equal(repo.updates.length, 0)
})

test('missing raw export is a finding', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore() // nothing set
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())
  assert.equal(res.outcome, 'raw_missing')
  assert.equal(repo.issues[0]?.code, 'raw_missing')
})

test('call absent from the export is a finding', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { 'some-other-task': { recordingUrl: OBJ } })
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())
  assert.equal(res.outcome, 'call_not_in_export')
})

test('call present but no recordingUrl is a finding', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { 'task-123': { status: 'completed' } })
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())
  assert.equal(res.outcome, 'no_recording_url')
})

test('unrecognized recording host is a finding, not stored', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { 'task-123': { recordingUrl: 'https://evil.example.com/x.ogg' } })
  const repo = new InMemoryBackfillRepo([c])

  const res = await backfillSourceUrl(c, { rawStore: raw, repo }, opts())
  assert.equal(res.outcome, 'unrecognized_url')
  assert.equal(repo.updates.length, 0)
  assert.equal(repo.issues[0]?.code, 'unrecognized_url')
})

test('dry-run resolves the URL but writes nothing', async () => {
  const c = candidate()
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { 'task-123': { recordingUrl: OBJ } })
  const repo = new InMemoryBackfillRepo([c])

  const summary = await backfillBatch([c], { rawStore: raw, repo }, opts(true))
  assert.equal(summary.backfilled, 1)
  assert.equal(repo.updates.length, 0)
  assert.equal(repo.issues.length, 0)
})

test('batch summary counts each outcome', async () => {
  const good = candidate({ evidenceObjectId: 'g' })
  const missing = candidate({ evidenceObjectId: 'm', rawKey: 'raw/missing.json' })
  const raw = new InMemoryRawStore()
  raw.set('local-disk', 'raw/export-1.json', { 'task-123': { recordingUrl: OBJ } })
  const repo = new InMemoryBackfillRepo([good, missing])

  const summary = await backfillBatch([good, missing], { rawStore: raw, repo }, opts())
  assert.equal(summary.total, 2)
  assert.equal(summary.backfilled, 1)
  assert.equal(summary.rawMissing, 1)
})
