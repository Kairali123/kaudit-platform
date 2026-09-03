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

test('follows a same-object signed URL returned by the proxy as JSON', async () => {
  const audio = Buffer.from('OggS-signed-audio-bytes')
  const signedUrl = `${S3URL}?X-Amz-Signature=synthetic`
  const calledUrls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    calledUrls.push(url)
    if (calledUrls.length === 1) {
      return new Response(JSON.stringify({ data: { signed_url: signedUrl } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(audio, {
      status: 200,
      headers: { 'content-type': 'audio/ogg' },
    })
  }) as typeof fetch
  const fetcher = createProxyResolvingFetcher(PROXY, { fetchImpl })

  const result = await fetcher.fetch(S3URL)

  assert.equal(result.ok, true)
  if (result.ok) assert.deepEqual(result.bytes, audio)
  assert.deepEqual(calledUrls, [`${PROXY}?url=${S3URL}`, signedUrl])
})

test('accepts common top-level signed URL field names', async () => {
  for (const field of ['url', 'signedUrl', 'download_url']) {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify({ [field]: `${S3URL}?token=x` }), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        })
      }
      return new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/mpeg' },
      })
    }) as typeof fetch

    const result = await createProxyResolvingFetcher(PROXY, {
      fetchImpl,
    }).fetch(S3URL)
    assert.equal(result.ok, true, field)
  }
})

test('finds a signed URL in a string, array, or unfamiliar nested field', async () => {
  const signedUrl = `${S3URL}?X-Amz-Signature=synthetic`
  const payloads = [
    signedUrl,
    [null, { value: signedUrl }],
    { result: { media: { temporaryDownload: signedUrl } } },
  ]
  for (const payload of payloads) {
    let calls = 0
    const fetchImpl = (async () => {
      calls += 1
      if (calls === 1) {
        return new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }
      return new Response(Buffer.from('audio'), {
        status: 200,
        headers: { 'content-type': 'audio/ogg' },
      })
    }) as typeof fetch

    const result = await createProxyResolvingFetcher(PROXY, {
      fetchImpl,
    }).fetch(S3URL)
    assert.equal(result.ok, true)
  }
})

test('prefers a signed match when the JSON also echoes the stable URL', async () => {
  const signedUrl = `${S3URL}?X-Amz-Signature=synthetic`
  const calledUrls: string[] = []
  const fetchImpl = (async (input: unknown) => {
    calledUrls.push(String(input))
    if (calledUrls.length === 1) {
      return new Response(JSON.stringify({ source: S3URL, value: signedUrl }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    return new Response(Buffer.from('audio'), {
      status: 200,
      headers: { 'content-type': 'audio/ogg' },
    })
  }) as typeof fetch

  const result = await createProxyResolvingFetcher(PROXY, {
    fetchImpl,
  }).fetch(S3URL)

  assert.equal(result.ok, true)
  assert.equal(calledUrls[1], signedUrl)
})

test('rejects a signed URL for a different host or object', async () => {
  for (const signedUrl of [
    'https://example.com/call_x.ogg?token=x',
    `${new URL(S3URL).origin}/different.ogg?token=x`,
  ]) {
    const fetcher = createProxyResolvingFetcher(PROXY, {
      fetchImpl: fakeFetch(
        new Response(JSON.stringify({ url: signedUrl }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    })

    const result = await fetcher.fetch(S3URL)
    assert.equal(result.ok, false)
    if (!result.ok) assert.equal(result.error, 'proxy_signed_url_rejected')
  }
})

test('rejects malformed or unsupported proxy JSON', async () => {
  for (const body of ['not-json', JSON.stringify({ data: { expires: 60 } })]) {
    const fetcher = createProxyResolvingFetcher(PROXY, {
      fetchImpl: fakeFetch(
        new Response(body, {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    })

    const result = await fetcher.fetch(S3URL)
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /^proxy_(json_invalid|signed_url_missing)$/)
  }
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
