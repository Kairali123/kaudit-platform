import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'

const source = await readFile(
  new URL('../../apps/web/src/lib/api.ts', import.meta.url),
  'utf8',
)
const compiled = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.ESNext,
    target: ts.ScriptTarget.ES2022,
  },
}).outputText
const api = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`
) as {
  ApiError: new (...args: any[]) => Error & {
    status: number
    correlationId: string | null
  }
  getJson: <T>(path: string) => Promise<T>
}
const { ApiError, getJson } = api

async function withFetch(
  response: Response,
  run: () => Promise<void>,
): Promise<void> {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => response
  try {
    await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('an HTML gateway timeout becomes a distinguishable ApiError', async () => {
  await withFetch(
    new Response('<html>gateway timeout</html>', {
      status: 504,
      headers: { 'content-type': 'text/html' },
    }),
    async () => {
      await assert.rejects(
        getJson('/api/v1/billing?month=2026-05'),
        (error) => {
          assert.ok(error instanceof ApiError)
          assert.equal(error.status, 504)
          assert.equal(error.message, 'The request timed out. Try again.')
          assert.match(error.correlationId ?? '', /^[0-9a-f-]{36}$/)
          assert.equal(error.message.includes('gateway timeout'), false)
          return true
        },
      )
    },
  )
})

test('another unparseable failure retains the privacy-safe fallback', async () => {
  await withFetch(
    new Response('private provider prose', { status: 500 }),
    async () => {
      await assert.rejects(getJson('/api/v1/billing'), (error) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 500)
        assert.equal(error.message, 'The request could not be completed.')
        assert.equal(error.message.includes('private provider prose'), false)
        return true
      })
    },
  )
})
