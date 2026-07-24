import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeRecordingUrl } from './normalizeRecordingUrl.ts'

const S3 = ['cdr-storage-recs.s3.ap-south-1.amazonaws.com']
const OBJ = 'https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/media/private/high-call-recordings/call_x.ogg'

test('plain S3 object URL is kept as-is', () => {
  const r = normalizeRecordingUrl(OBJ, S3)
  assert.equal(r.ok, true)
  assert.equal(r.s3Url, OBJ)
})

test('signed S3 URL has its signing query stripped to the stable object URL', () => {
  const signed = `${OBJ}?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=deadbeef&X-Amz-Expires=3600`
  const r = normalizeRecordingUrl(signed, S3)
  assert.equal(r.ok, true)
  assert.equal(r.s3Url, OBJ) // no query
})

test('proxy-wrapped URL is unwrapped to the inner S3 object URL', () => {
  const proxied = `https://unpod.ai/api/v1/media/download-signed-url/?url=${OBJ}`
  const r = normalizeRecordingUrl(proxied, S3)
  assert.equal(r.ok, true)
  assert.equal(r.s3Url, OBJ)
})

test('proxy wrapper is unwrapped even when the proxy host is on the allowlist', () => {
  const withProxy = ['unpod.ai', 'cdr-storage-recs.s3.ap-south-1.amazonaws.com']
  const proxied = `https://unpod.ai/api/v1/media/download-signed-url/?url=${OBJ}`
  const r = normalizeRecordingUrl(proxied, withProxy)
  assert.equal(r.ok, true)
  assert.equal(r.s3Url, OBJ) // canonical S3 URL, NOT the bare proxy endpoint
})

test('non-https S3 URL is rejected', () => {
  const r = normalizeRecordingUrl(OBJ.replace('https://', 'http://'), S3)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'not_https')
})

test('S3 host with empty path is rejected', () => {
  const r = normalizeRecordingUrl('https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/', S3)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'empty_path')
})

test('unknown host with no wrapper is rejected', () => {
  const r = normalizeRecordingUrl('https://evil.example.com/x.ogg', S3)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unrecognized_host')
})

test('garbage is unparseable', () => {
  const r = normalizeRecordingUrl('not a url', S3)
  assert.equal(r.ok, false)
  assert.equal(r.reason, 'unparseable')
})
