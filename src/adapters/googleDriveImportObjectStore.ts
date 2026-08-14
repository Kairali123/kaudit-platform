import type { ImportObjectStore } from '../imports/objectStore.ts'
import { safeImportExtension } from '../imports/objectStore.ts'
import { sha256Hex } from '../lib/hash.ts'

const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files'
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files'
const FILE_HASH_KEY = 'kauditSha256'
const REQUEST_TIMEOUT_MS = 20_000
const UPLOAD_TIMEOUT_MS = 60_000

interface GoogleDriveConfig {
  clientId: string
  clientSecret: string
  refreshToken: string
  sharedDriveId: string
  rootFolderId?: string | null
}

interface AccessToken {
  value: string
  expiresAt: number
}

export class GoogleDriveImportStorageError extends Error {
  readonly code = 'GOOGLE_DRIVE_IMPORT_STORAGE_FAILED'

  constructor() {
    super('Import storage is unavailable')
  }
}

function configured(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength && !/[\s\u0000-\u001f]/.test(value)
}

function parseId(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{10,200}$/.test(value)
    ? value
    : null
}

function configuredId(value: string | null | undefined): string | null {
  if (!value) return null
  return parseId(value.trim())
}

async function safeJson(response: Response): Promise<Record<string, unknown>> {
  try {
    const value = await response.json()
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {}
  } catch {
    return {}
  }
}

function resumableUrl(value: string | null): string | null {
  if (!value || value.length > 4096) return null
  try {
    const url = new URL(value)
    if (
      url.protocol !== 'https:' ||
      !['www.googleapis.com', 'upload.googleapis.com'].includes(url.hostname) ||
      !url.pathname.startsWith('/upload/drive/v3/files')
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

export function createGoogleDriveImportObjectStore(
  input: GoogleDriveConfig,
  fetcher: typeof fetch = fetch,
  now: () => number = Date.now,
): ImportObjectStore {
  const config = {
    clientId: input.clientId.trim(),
    clientSecret: input.clientSecret.trim(),
    refreshToken: input.refreshToken.trim(),
    sharedDriveId: configuredId(input.sharedDriveId),
    parentId: configuredId(input.rootFolderId ?? null),
  }
  if (
    !configured(config.clientId, 512) ||
    !configured(config.clientSecret, 4096) ||
    !configured(config.refreshToken, 4096) ||
    !config.sharedDriveId
  ) {
    throw new GoogleDriveImportStorageError()
  }
  const sharedDriveId = config.sharedDriveId
  const parentId = config.parentId ?? sharedDriveId

  let cachedToken: AccessToken | null = null

  async function accessToken(): Promise<string> {
    if (cachedToken && cachedToken.expiresAt - now() > 60_000) {
      return cachedToken.value
    }
    const body = new URLSearchParams({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: config.refreshToken,
      grant_type: 'refresh_token',
    })
    let response: Response
    try {
      response = await fetcher(TOKEN_URL, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
      })
    } catch {
      throw new GoogleDriveImportStorageError()
    }
    const data = await safeJson(response)
    const value = typeof data.access_token === 'string'
      ? data.access_token.trim()
      : ''
    const expiresIn = Number(data.expires_in)
    if (
      !response.ok ||
      !configured(value, 4096) ||
      !Number.isFinite(expiresIn) ||
      expiresIn < 60 ||
      expiresIn > 86_400
    ) {
      throw new GoogleDriveImportStorageError()
    }
    cachedToken = {
      value,
      expiresAt: now() + Math.floor(expiresIn * 1000),
    }
    return value
  }

  async function driveJson(
    url: URL | string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const token = await accessToken()
    let response: Response
    try {
      response = await fetcher(url, {
        ...init,
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...init.headers,
        },
      })
    } catch {
      throw new GoogleDriveImportStorageError()
    }
    const data = await safeJson(response)
    if (!response.ok) throw new GoogleDriveImportStorageError()
    return data
  }

  async function listOne(query: string): Promise<string | null> {
    const url = new URL(DRIVE_FILES_URL)
    url.searchParams.set('q', query)
    url.searchParams.set('spaces', 'drive')
    url.searchParams.set('corpora', 'drive')
    url.searchParams.set('driveId', sharedDriveId)
    url.searchParams.set('includeItemsFromAllDrives', 'true')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('pageSize', '2')
    url.searchParams.set('fields', 'files(id)')
    url.searchParams.set('orderBy', 'createdTime')
    const data = await driveJson(url)
    const files = Array.isArray(data.files) ? data.files : []
    for (const file of files.slice(0, 2)) {
      if (file && typeof file === 'object') {
        const id = parseId((file as Record<string, unknown>).id)
        if (!id) throw new GoogleDriveImportStorageError()
        return id
      }
    }
    return null
  }

  async function existingFile(parentId: string, sha256: string) {
    return listOne(
      `'${parentId}' in parents and trashed = false and ` +
      `appProperties has { key='${FILE_HASH_KEY}' and value='${sha256}' }`,
    )
  }

  async function upload(
    parentId: string,
    sha256: string,
    extension: string,
    mediaType: string,
    bytes: Buffer,
  ): Promise<string> {
    const token = await accessToken()
    const url = new URL(DRIVE_UPLOAD_URL)
    url.searchParams.set('uploadType', 'resumable')
    url.searchParams.set('supportsAllDrives', 'true')
    url.searchParams.set('fields', 'id')
    let session: Response
    try {
      session = await fetcher(url, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          'x-upload-content-length': String(bytes.byteLength),
          'x-upload-content-type': mediaType,
        },
        body: JSON.stringify({
          name: `${sha256}${extension}`,
          parents: [parentId],
          appProperties: { [FILE_HASH_KEY]: sha256 },
        }),
      })
    } catch {
      throw new GoogleDriveImportStorageError()
    }
    const location = resumableUrl(session.headers.get('location'))
    if (!session.ok || !location) throw new GoogleDriveImportStorageError()
    let stored: Response
    try {
      stored = await fetcher(location, {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS),
        headers: {
          'content-length': String(bytes.byteLength),
          'content-type': mediaType,
        },
        body: new Uint8Array(bytes),
      })
    } catch {
      throw new GoogleDriveImportStorageError()
    }
    const data = await safeJson(stored)
    const id = parseId(data.id)
    if (!stored.ok || !id) throw new GoogleDriveImportStorageError()
    return id
  }

  return {
    storageBoundary:
      'Uploads are content-addressed in the configured Kaudit Google Shared Drive boundary and indexed in SQL. KCRM files are never read.',

    async preserve(request) {
      const sha256 = sha256Hex(request.bytes)
      const existing = await existingFile(parentId, sha256)
      const objectKey = existing ?? await upload(
        parentId,
        sha256,
        safeImportExtension(request.filename),
        request.mediaType,
        request.bytes,
      )
      return {
        objectBucket: 'kaudit-imports-google-drive',
        objectKey,
        sha256,
      }
    },
  }
}
