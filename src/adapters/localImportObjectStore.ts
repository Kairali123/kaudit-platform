import { mkdir, open } from 'node:fs/promises'
import path from 'node:path'
import type { ImportObjectStore } from '../imports/objectStore.ts'
import { safeImportExtension } from '../imports/objectStore.ts'
import { sha256Hex } from '../lib/hash.ts'

export function createLocalImportObjectStore(root: string): ImportObjectStore {
  const resolvedRoot = path.resolve(root)
  return {
    storageBoundary:
      'Uploads are stored under the Kaudit-owned private import root and indexed in SQL. KCRM files are never read.',

    async preserve(input) {
      const sha256 = sha256Hex(input.bytes)
      const directory = path.resolve(resolvedRoot, sha256.slice(0, 2))
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const objectKey =
        `${sha256.slice(0, 2)}/${sha256}${safeImportExtension(input.filename)}`
      const target = path.resolve(resolvedRoot, objectKey)
      if (!target.startsWith(`${resolvedRoot}${path.sep}`)) {
        throw new Error('Upload storage path escaped its configured root')
      }
      try {
        const file = await open(target, 'wx', 0o600)
        try {
          await file.writeFile(input.bytes)
          await file.sync()
        } finally {
          await file.close()
        }
      } catch (error) {
        if (
          !error ||
          typeof error !== 'object' ||
          !('code' in error) ||
          error.code !== 'EEXIST'
        ) {
          throw error
        }
      }
      return {
        objectBucket: 'kaudit-imports-local',
        objectKey,
        sha256,
      }
    },
  }
}
