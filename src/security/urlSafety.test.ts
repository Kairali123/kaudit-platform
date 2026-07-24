import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isSafeVendorUrl } from './urlSafety.ts'

const ALLOW = ['recordings.kserve.co.in', 'kserve.co.in']

test('https allowlisted host is safe', () => {
  assert.equal(isSafeVendorUrl('https://recordings.kserve.co.in/a/b.ogg', ALLOW).safe, true)
})

test('subdomain of an allowlisted host is safe', () => {
  assert.equal(isSafeVendorUrl('https://cdn.kserve.co.in/x.ogg', ALLOW).safe, true)
})

test('http (non-TLS) is rejected', () => {
  const r = isSafeVendorUrl('http://recordings.kserve.co.in/a.ogg', ALLOW)
  assert.equal(r.safe, false)
  assert.equal(r.reason, 'not_https')
})

test('localhost is rejected', () => {
  assert.equal(isSafeVendorUrl('https://localhost/a.ogg', ALLOW).safe, false)
})

test('loopback and private IPs are rejected', () => {
  assert.equal(isSafeVendorUrl('https://127.0.0.1/a.ogg', ALLOW).safe, false)
  assert.equal(isSafeVendorUrl('https://10.1.2.3/a.ogg', ALLOW).safe, false)
  assert.equal(isSafeVendorUrl('https://192.168.0.5/a.ogg', ALLOW).safe, false)
  assert.equal(isSafeVendorUrl('https://169.254.1.1/a.ogg', ALLOW).safe, false)
})

test('ipv6 loopback is rejected', () => {
  assert.equal(isSafeVendorUrl('https://[::1]/a.ogg', ALLOW).safe, false)
})

test('non-allowlisted host is rejected', () => {
  const r = isSafeVendorUrl('https://evil.example.com/a.ogg', ALLOW)
  assert.equal(r.safe, false)
  assert.equal(r.reason, 'host_not_allowlisted')
})
