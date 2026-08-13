import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ConfigurationError } from '../config/runtime.ts'
import {
  AuditWorkerDispatchError,
  createGitHubActionsAuditWorkerDispatcher,
} from './dispatcher.ts'

const configured = {
  KAUDIT_GITHUB_WORKER_ENABLED: 'true',
  KAUDIT_GITHUB_WORKER_REPOSITORY: 'synthetic-owner/synthetic-repository',
  KAUDIT_GITHUB_WORKER_REF: 'main',
  KAUDIT_GITHUB_WORKER_TOKEN: 'synthetic-token-value',
}

test('GitHub dispatch is deny-by-default', () => {
  assert.equal(createGitHubActionsAuditWorkerDispatcher({}), undefined)
  assert.equal(
    createGitHubActionsAuditWorkerDispatcher({
      ...configured,
      KAUDIT_GITHUB_WORKER_ENABLED: 'false',
    }),
    undefined,
  )
})

test('dispatch sends only the closed audit system and configured ref', async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = []
  const dispatcher = createGitHubActionsAuditWorkerDispatcher(
    configured,
    (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), init })
      return new Response(null, { status: 204 })
    }) as typeof fetch,
  )
  await dispatcher?.dispatch('call')

  assert.equal(requests.length, 1)
  assert.match(requests[0]?.url ?? '', /\/audit-worker\.yml\/dispatches$/)
  assert.deepEqual(JSON.parse(String(requests[0]?.init?.body)), {
    ref: 'main',
    inputs: { system: 'call' },
  })
  assert.equal(
    (requests[0]?.init?.headers as Record<string, string>).authorization,
    'Bearer synthetic-token-value',
  )
})

test('invalid enabled configuration fails without echoing any value', () => {
  const sensitive = 'sensitive-value-that-must-not-appear'
  assert.throws(
    () =>
      createGitHubActionsAuditWorkerDispatcher({
        ...configured,
        KAUDIT_GITHUB_WORKER_REPOSITORY: sensitive,
      }),
    (error: Error) => {
      assert.ok(error instanceof ConfigurationError)
      assert.equal(error.message.includes(sensitive), false)
      assert.equal(error.message.includes(configured.KAUDIT_GITHUB_WORKER_TOKEN), false)
      return true
    },
  )
})

test('provider failures become one bounded error and provider prose is discarded', async () => {
  const providerProse = 'private provider response text'
  const dispatcher = createGitHubActionsAuditWorkerDispatcher(
    configured,
    (async () => new Response(providerProse, { status: 403 })) as typeof fetch,
  )

  await assert.rejects(
    () => dispatcher!.dispatch('billing'),
    (error: Error) => {
      assert.ok(error instanceof AuditWorkerDispatchError)
      assert.equal(error.code, 'AUDIT_WORKER_DISPATCH_FAILED')
      assert.equal(error.message.includes(providerProse), false)
      assert.equal(error.message.includes(configured.KAUDIT_GITHUB_WORKER_TOKEN), false)
      return true
    },
  )
})
