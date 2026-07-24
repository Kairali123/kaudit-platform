import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyEvidenceUrl, verifyEvidenceBatch, type VerifyPorts } from './verifyEvidenceUrl.ts'
import { InMemoryFetcher, InMemoryVerifyRepo } from '../fixtures/inMemory.ts'
import { sha256Hex } from '../lib/hash.ts'
import type { EvidenceRow } from '../domain/types.ts'

const ALLOW = ['recordings.kserve.co.in']
const NOW = (): string => '2026-07-24T00:00:00.000Z'
const URL_OK = 'https://recordings.kserve.co.in/call-1.ogg'

function row(id: string, url: string | null, sha: string | null): EvidenceRow {
  return { id, sourceUrl: url, sha256: sha, sizeBytes: null, lastVerifiedAt: null }
}
function ports(fetcher: InMemoryFetcher, repo: InMemoryVerifyRepo): VerifyPorts {
  return { fetcher, repo, allowedHosts: ALLOW, now: NOW }
}

test('first fetch records the baseline hash (ingestion)', async () => {
  const bytes = Buffer.from('kserve-audio')
  const r = row('e1', URL_OK, null)
  const fetcher = new InMemoryFetcher()
  fetcher.set(URL_OK, { ok: true, status: 200, bytes })
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: false })

  assert.equal(res.outcome, 'hash_recorded')
  assert.equal(repo.hashes[0]?.sha256, sha256Hex(bytes))
})

test('re-verify passes when vendor bytes still match the baseline', async () => {
  const bytes = Buffer.from('kserve-audio')
  const r = row('e2', URL_OK, sha256Hex(bytes))
  const fetcher = new InMemoryFetcher()
  fetcher.set(URL_OK, { ok: true, status: 200, bytes })
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: false })

  assert.equal(res.outcome, 'verified')
  assert.equal(repo.verified.length, 1)
  assert.equal(repo.issues.length, 0)
})

test('altered vendor bytes are detected as a finding (not a silent pass)', async () => {
  const original = Buffer.from('kserve-audio')
  const tampered = Buffer.from('kserve-audio-EDITED')
  const r = row('e3', URL_OK, sha256Hex(original))
  const fetcher = new InMemoryFetcher()
  fetcher.set(URL_OK, { ok: true, status: 200, bytes: tampered })
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: false })

  assert.equal(res.outcome, 'evidence_altered')
  assert.equal(repo.issues[0]?.code, 'evidence_altered')
  assert.equal(repo.verified.length, 0)
})

test('expired / 404 URL is a source_missing finding', async () => {
  const r = row('e4', URL_OK, sha256Hex(Buffer.from('x')))
  const fetcher = new InMemoryFetcher()
  fetcher.set(URL_OK, { ok: false, status: 404, error: 'expired' })
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: false })

  assert.equal(res.outcome, 'source_missing')
  assert.equal(res.httpStatus, 404)
  assert.equal(repo.issues[0]?.code, 'source_missing')
})

test('unsafe URL is rejected before any fetch', async () => {
  const r = row('e5', 'https://10.0.0.5/secret.ogg', null)
  const fetcher = new InMemoryFetcher()
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: false })

  assert.equal(res.outcome, 'unsafe_url')
  assert.equal(fetcher.calls.length, 0) // never fetched
  assert.equal(repo.issues[0]?.code, 'unsafe_url')
})

test('row with no URL is a finding', async () => {
  const r = row('e6', null, null)
  const fetcher = new InMemoryFetcher()
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: false })

  assert.equal(res.outcome, 'no_url')
})

test('dry-run detects alteration but writes nothing', async () => {
  const original = Buffer.from('kserve-audio')
  const r = row('e7', URL_OK, sha256Hex(original))
  const fetcher = new InMemoryFetcher()
  fetcher.set(URL_OK, { ok: true, status: 200, bytes: Buffer.from('EDITED') })
  const repo = new InMemoryVerifyRepo([r])

  const res = await verifyEvidenceUrl(r, ports(fetcher, repo), { dryRun: true })

  assert.equal(res.outcome, 'evidence_altered')
  assert.equal(repo.issues.length, 0)
  assert.equal(repo.verified.length, 0)
})

test('batch summary counts outcomes', async () => {
  const bytes = Buffer.from('a')
  const r1 = row('b1', URL_OK, null) // → hash_recorded
  const r2 = row('b2', null, null) // → no_url
  const fetcher = new InMemoryFetcher()
  fetcher.set(URL_OK, { ok: true, status: 200, bytes })
  const repo = new InMemoryVerifyRepo([r1, r2])

  const s = await verifyEvidenceBatch([r1, r2], ports(fetcher, repo), { dryRun: false })

  assert.equal(s.total, 2)
  assert.equal(s.hashRecorded, 1)
  assert.equal(s.noUrl, 1)
})
