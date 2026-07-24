import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { RawStore } from '../backfill/ports.ts'

// Reads raw KServe export JSON from the current store. Raw exports were written to
// local-disk / local MinIO by the existing ingestion (`.data/kaudit-evidence/raw/...`).
//
// NOTE: the exact bucket/key → path convention must be confirmed against the live store
// during a dry-run. Anything that doesn't resolve or doesn't parse returns null → the
// backfill records `raw_missing` (an honest finding, never a silent skip).
export function createLocalRawStore(): RawStore {
  const root = process.env.KAUDIT_SOURCE_RAW_ROOT?.trim()
  return {
    async readJson(_bucket: string, key: string): Promise<unknown | null> {
      if (!root) return null
      const safe = key.replace(/^\/+/, '')
      if (!safe || safe.includes('..')) return null
      try {
        const text = await readFile(path.join(root, safe), 'utf8')
        return JSON.parse(text)
      } catch {
        return null
      }
    },
  }
}
