import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createProxyResolvingFetcher } from './proxyResolvingFetcher.ts'
import { verifyEvidenceUrl } from '../storage/verifyEvidenceUrl.ts'
import { InMemoryVerifyRepo } from '../fixtures/inMemory.ts'
import { sha256Hex } from '../lib/hash.ts'
import type { EvidenceRow } from '../domain/types.ts'

const PROXY = 'https://unpod.ai/api/v1/media/download-signed-url/'
const S3URL =
  'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/high-call-recordings/call_x.ogg'
const S3_HOSTS = ['cdr-storage-recs.s3.ap-south-1.amazonaws.com']

// Fake fetch returning a real Response, capturing the request for assertions.
function fakeFetch(
  response: Response,
  capture?: (url: string, init?: RequestInit) => void,
): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    capture?.(String(input), init)
    return response
  }) as typeof fetch
}

test('constructs the proxy URL and returns audio bytes on 200 (observed behavior)', async () => {
  const audio = Buffer.from('OggS-fake-audio-bytes')
  let calledUrl = ''
  let calledInit: RequestInit | undefined
  const fetchImpl = fakeFetch(
    new Response(audio, { status: 200, headers: { 'content-type': 'audio/ogg' } }),
    (u, i) => {
      calledUrl = u
      calledInit = i
    },
  )
  const fetcher = createProxyResolvingFetcher(PROXY, { fetchImpl })

  const res = await fetcher.fetch(S3URL)

  assert.equal(res.ok, true)
  if (res.ok) assert.deepEqual(res.bytes, audio)
  assert.equal(calledUrl, `${PROXY}?url=${S3URL}`) // fresh, raw nested URL
  assert.equal(calledInit?.redirect, 'error') // no redirect bounce
})

test('404 from the proxy is a fetch failure', async () => {
  const fetchImpl = fakeFetch(new Response('not found', { status: 404 }))
  const fetcher = createProxyResolvingFetcher(PROXY, { fetchImpl })
  const res = await fetcher.fetch(S3URL)
  assert.equal(res.ok, false)
  if (!res.ok) assert.equal(res.status, 404)
})

test('a 200 that is not audio/* is rejected (error page, not evidence)', async () => {
  const fetchImpl = fakeFetch(
    new Response('<html>error</html>', { status: 200, headers: { 'content-type': 'text/html' } }),
  )
  const fetcher = createProxyResolvingFetcher(PROXY, { fetchImpl })
  const res = await fetcher.fetch(S3URL)
  assert.equal(res.ok, false)
  if (!res.ok) assert.match(res.error, /non_audio_response/)
})

test('empty and oversized bodies are rejected', async () => {
  const empty = createProxyResolvingFetcher(PROXY, {
    fetchImpl: fakeFetch(
      new Response(Buffer.alloc(0), { status: 200, headers: { 'content-type': 'audio/ogg' } }),
    ),
  })
  const rEmpty = await empty.fetch(S3URL)
  assert.equal(rEmpty.ok, false)
  if (!rEmpty.ok) assert.match(rEmpty.error, /empty_body/)

  const big = createProxyResolvingFetcher(PROXY, {
    maxBytes: 4,
    fetchImpl: fakeFetch(
      new Response(Buffer.from('way-too-big'), { status: 200, headers: { 'content-type': 'audio/ogg' } }),
    ),
  })
  const rBig = await big.fetch(S3URL)
  assert.equal(rBig.ok, false)
  if (!rBig.ok) assert.match(rBig.error, /too_large/)
})

test('network error is surfaced, not thrown', async () => {
  const fetchImpl = (async () => {
    throw new Error('network down')
  }) as typeof fetch
  const fetcher = createProxyResolvingFetcher(PROXY, { fetchImpl })
  const res = await fetcher.fetch(S3URL)
  assert.equal(res.ok, false)
  if (!res.ok) {
    assert.equal(res.status, null)
    assert.match(res.error, /network down/)
  }
})

test('constructor rejects a non-https proxy base', () => {
  assert.throws(() => createProxyResolvingFetcher('http://unpod.ai/x'), /https/)
})

test('end-to-end via the verification core: baseline hash, then tamper detected', async () => {
  const audio = Buffer.from('real-audio-bytes')
  const row: EvidenceRow = { id: 'x', sourceUrl: S3URL, sha256: null, sizeBytes: null, lastVerifiedAt: null }
  const repo = new InMemoryVerifyRepo([row])
  const now = (): string => '2026-07-24T00:00:00.000Z'

  // First pass: proxy returns the real bytes → baseline hash recorded.
  const okFetcher = createProxyResolvingFetcher(PROXY, {
    fetchImpl: fakeFetch(new Response(audio, { status: 200, headers: { 'content-type': 'audio/ogg' } })),
  })
  const r1 = await verifyEvidenceUrl(row, { fetcher: okFetcher, repo, allowedHosts: S3_HOSTS, now }, { dryRun: false })
  assert.equal(r1.outcome, 'hash_recorded')
  assert.equal(repo.rows[0]?.sha256, sha256Hex(audio))

  // Later pass: proxy returns different bytes → evidence_altered finding.
  const tamperFetcher = createProxyResolvingFetcher(PROXY, {
    fetchImpl: fakeFetch(new Response(Buffer.from('EDITED'), { status: 200, headers: { 'content-type': 'audio/ogg' } })),
  })
  const r2 = await verifyEvidenceUrl(repo.rows[0], { fetcher: tamperFetcher, repo, allowedHosts: S3_HOSTS, now }, { dryRun: false })
  assert.equal(r2.outcome, 'evidence_altered')
  assert.equal(repo.issues[0]?.code, 'evidence_altered')
})
