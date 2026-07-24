import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { SourceReader } from '../storage/ports.ts'

// Reads bytes from the CURRENT (pre-migration) store:
//   'kaudit-local' → local MinIO (S3 API) at KAUDIT_SOURCE_MINIO_ENDPOINT
//   'local-disk'   → filesystem under KAUDIT_SOURCE_LOCAL_ROOT
//
// NOTE: the exact 'local-disk' key→path convention must be confirmed against the
// live store during dry-run. Unresolved paths return null → the migration records
// 'source_missing' (an honest finding, never a silent skip).
export function createLocalSourceReader(): SourceReader {
  const localRoot = process.env.KAUDIT_SOURCE_LOCAL_ROOT?.trim()
  const minioEndpoint = process.env.KAUDIT_SOURCE_MINIO_ENDPOINT?.trim()
  const minio = minioEndpoint
    ? new S3Client({
        region: 'ap-south-1',
        endpoint: minioEndpoint,
        forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.KAUDIT_SOURCE_MINIO_ACCESS_KEY_ID?.trim() || 'kaudit-local',
          secretAccessKey: process.env.KAUDIT_SOURCE_MINIO_SECRET_ACCESS_KEY?.trim() || '',
        },
      })
    : null

  return {
    async read(bucket: string, key: string): Promise<Buffer | null> {
      if (bucket === 'kaudit-local') {
        if (!minio) return null
        try {
          const res = await minio.send(new GetObjectCommand({ Bucket: 'kaudit-local', Key: key }))
          if (!res.Body) return null
          return Buffer.from(await res.Body.transformToByteArray())
        } catch {
          return null
        }
      }
      if (bucket === 'local-disk') {
        if (!localRoot) return null
        const safe = key.replace(/^\/+/, '')
        if (!safe || safe.includes('..')) return null
        try {
          return await readFile(path.join(localRoot, safe))
        } catch {
          return null
        }
      }
      return null
    },
  }
}
