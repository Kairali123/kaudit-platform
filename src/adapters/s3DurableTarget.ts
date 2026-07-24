import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3'
import type { DurableTarget } from '../storage/ports.ts'

// Real durable target: versioned, Object-Lock (WORM), KMS-encrypted S3-compatible
// bucket in the India region.
//
// PRECONDITION (infrastructure, not code): the bucket MUST be created with
// Versioning + Object Lock enabled. This adapter sets per-object retention and
// server-side encryption; it cannot enable bucket-level Object Lock retroactively.
export function createS3DurableTarget(): DurableTarget {
  const bucket = req('KAUDIT_DURABLE_BUCKET')
  const client = new S3Client({
    region: process.env.KAUDIT_DURABLE_REGION?.trim() || 'ap-south-1',
    endpoint: process.env.KAUDIT_DURABLE_ENDPOINT?.trim() || undefined,
    forcePathStyle: !!process.env.KAUDIT_DURABLE_ENDPOINT?.trim(),
  })
  const kmsKeyId = process.env.KAUDIT_DURABLE_KMS_KEY_ID?.trim()
  const lockMode = (process.env.KAUDIT_OBJECT_LOCK_MODE?.trim() || 'GOVERNANCE') as
    | 'GOVERNANCE'
    | 'COMPLIANCE'
  const retainDays = Number(process.env.KAUDIT_OBJECT_LOCK_RETAIN_DAYS || '3650')

  return {
    bucket,
    async has(key: string): Promise<{ present: boolean; versionId: string | null }> {
      try {
        const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
        return { present: true, versionId: head.VersionId ?? null }
      } catch {
        return { present: false, versionId: null }
      }
    },
    async put(
      key: string,
      body: Buffer,
      sha256: string,
      metadata: Record<string, string>,
    ): Promise<{ versionId: string | null }> {
      const res = await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ChecksumSHA256: Buffer.from(sha256, 'hex').toString('base64'),
          ContentType: metadata.contentType || 'application/octet-stream',
          Metadata: { ...metadata, sha256 },
          ObjectLockMode: lockMode,
          ObjectLockRetainUntilDate: new Date(Date.now() + retainDays * 86_400_000),
          ...(kmsKeyId
            ? { ServerSideEncryption: 'aws:kms', SSEKMSKeyId: kmsKeyId }
            : { ServerSideEncryption: 'AES256' }),
        }),
      )
      return { versionId: res.VersionId ?? null }
    },
  }
}

function req(name: string): string {
  const v = process.env[name]?.trim()
  if (!v) throw new Error(`${name} is required`)
  return v
}
