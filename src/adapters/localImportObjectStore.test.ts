import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalImportObjectStore } from './localImportObjectStore.ts'
import { sha256Hex } from '../lib/hash.ts'

test('local import store writes uploads by content hash under the configured root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'kaudit-import-store-'))
  const store = createLocalImportObjectStore(root)
  const bytes = Buffer.from('Task ID,Duration\nsynthetic-task,42\n')
  const sha256 = sha256Hex(bytes)

  const first = await store.preserve({
    bytes,
    filename: '../unsafe monthly usage.csv',
    mediaType: 'text/csv',
  })
  const second = await store.preserve({
    bytes,
    filename: 'renamed.csv',
    mediaType: 'text/csv',
  })

  assert.deepEqual(first, {
    objectBucket: 'kaudit-imports-local',
    objectKey: `${sha256.slice(0, 2)}/${sha256}.csv`,
    sha256,
  })
  assert.equal(second.objectKey, first.objectKey)
  assert.equal(await readFile(join(root, first.objectKey), 'utf8'), bytes.toString())
  const mode = (await stat(join(root, first.objectKey))).mode & 0o777
  assert.equal(mode, 0o600)
})
