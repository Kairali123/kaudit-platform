import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { RawStore } from '../backfill/ports.ts'

// Reads per-call raw KServe files from the local dump. Layout (confirmed 2026-07-24):
//   {KAUDIT_SOURCE_RAW_ROOT}/raw/{batchUUID}/{taskId}.json   — one file per call.
// The taskId (= logical_call_key, e.g. "T…") is the filename stem, so we look up
// {taskId}.json across the batch-UUID subfolders. Anything not found → null → the
// backfill records `raw_missing` (a finding, never a silent skip).
export function createLocalRawStore(): RawStore {
  const root = process.env.KAUDIT_SOURCE_RAW_ROOT?.trim()
  let batchDirsCache: string[] | null = null

  async function batchDirs(): Promise<string[]> {
    if (batchDirsCache) return batchDirsCache
    if (!root) return (batchDirsCache = [])
    try {
      const rawDir = path.join(root, 'raw')
      const entries = await readdir(rawDir, { withFileTypes: true })
      batchDirsCache = entries.filter((e) => e.isDirectory()).map((e) => path.join(rawDir, e.name))
    } catch {
      batchDirsCache = []
    }
    return batchDirsCache
  }

  return {
    async readByTaskId(taskId: string): Promise<unknown | null> {
      if (!root || !taskId || taskId.includes('/') || taskId.includes('..')) return null
      for (const dir of await batchDirs()) {
        try {
          const text = await readFile(path.join(dir, `${taskId}.json`), 'utf8')
          return JSON.parse(text)
        } catch {
          // not in this batch folder (or unreadable) — try the next
        }
      }
      return null
    },
  }
}
