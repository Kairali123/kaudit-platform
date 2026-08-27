import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createGoogleDriveImportObjectStore } from './googleDriveImportObjectStore.ts'
import { sha256Hex } from '../lib/hash.ts'

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
    },
  })
}

test('Google Drive import store uploads by hash inside a Shared Drive folder', async () => {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const bytes = Buffer.from('%PDF- synthetic invoice bytes')
  const sha256 = sha256Hex(bytes)
  const fetcher: typeof fetch = async (url, init = {}) => {
    const href = url.toString()
    calls.push({ url: href, init })
    if (href === 'https://oauth2.googleapis.com/token') {
      return jsonResponse({ access_token: 'synthetic-access-token', expires_in: 3600 })
    }
    if (href.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return jsonResponse({ files: [] })
    }
    if (
      href ===
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true&fields=id'
    ) {
      return new Response(null, {
        status: 200,
        headers: {
          location:
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_1',
        },
      })
    }
    if (
      href ===
      'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_1'
    ) {
      return jsonResponse({ id: 'file_0123456789' })
    }
    throw new Error(`unexpected fetch ${href}`)
  }

  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
      rootFolderId: 'folder_0123456789',
    },
    fetcher,
    () => 1_000,
  )
  const preserved = await store.preserve({
    bytes,
    filename: '../July invoice.PDF',
    mediaType: 'application/pdf',
  })

  assert.deepEqual(preserved, {
    objectBucket: 'kaudit-imports-google-drive',
    objectKey: 'file_0123456789',
    sha256,
  })
  assert.equal(
    calls.some((call) => call.url === 'https://www.googleapis.com/drive/v3/files'),
    false,
  )
  const list = calls.find((call) => call.url.startsWith('https://www.googleapis.com/drive/v3/files?'))
  assert.ok(list)
  const listUrl = new URL(list.url)
  assert.equal(listUrl.searchParams.get('corpora'), 'drive')
  assert.equal(listUrl.searchParams.get('driveId'), 'shared_drive_0123456789')
  assert.equal(listUrl.searchParams.get('includeItemsFromAllDrives'), 'true')
  assert.equal(listUrl.searchParams.get('supportsAllDrives'), 'true')
  assert.match(
    listUrl.searchParams.get('q') ?? '',
    /'folder_0123456789' in parents/,
  )
  const session = calls.find((call) =>
    call.url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable'),
  )
  assert.ok(session)
  assert.equal(session.init.headers && (session.init.headers as Record<string, string>)['x-upload-content-type'], 'application/pdf')
  assert.deepEqual(JSON.parse(String(session.init.body)), {
    name: `${sha256}.pdf`,
    parents: ['folder_0123456789'],
    appProperties: { kauditSha256: sha256 },
  })
})

test('Google Drive import store reuses an existing hash match without uploading', async () => {
  const uploaded: string[] = []
  const bytes = Buffer.from('Task ID,Duration\nsynthetic-task,42\n')
  const sha256 = sha256Hex(bytes)
  const fetcher: typeof fetch = async (url, init = {}) => {
    const href = url.toString()
    if (href === 'https://oauth2.googleapis.com/token') {
      return jsonResponse({ access_token: 'synthetic-access-token', expires_in: 3600 })
    }
    if (href.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      const parsed = new URL(href)
      const query = parsed.searchParams.get('q') ?? ''
      return query.includes('kauditSha256')
        ? jsonResponse({ files: [{ id: 'file_existing_0123456789' }] })
        : jsonResponse({ files: [{ id: 'folder_0123456789' }] })
    }
    uploaded.push(href)
    return jsonResponse({})
  }

  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
    },
    fetcher,
  )
  const preserved = await store.preserve({
    bytes,
    filename: 'usage.csv',
    mediaType: 'text/csv',
  })

  assert.deepEqual(preserved, {
    objectBucket: 'kaudit-imports-google-drive',
    objectKey: 'file_existing_0123456789',
    sha256,
  })
  assert.deepEqual(uploaded, [])
})

test('Google Drive import store scopes to the Shared Drive root when no folder is configured', async () => {
  const bytes = Buffer.from('Task ID,Duration\nsynthetic-task,42\n')
  const sha256 = sha256Hex(bytes)
  const calls: string[] = []
  const fetcher: typeof fetch = async (url) => {
    const href = url.toString()
    calls.push(href)
    if (href === 'https://oauth2.googleapis.com/token') {
      return jsonResponse({ access_token: 'synthetic-access-token', expires_in: 3600 })
    }
    if (href.startsWith('https://www.googleapis.com/drive/v3/files?')) {
      return jsonResponse({ files: [{ id: 'file_existing_0123456789' }] })
    }
    throw new Error(`unexpected fetch ${href}`)
  }

  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
    },
    fetcher,
  )
  const preserved = await store.preserve({
    bytes,
    filename: 'usage.csv',
    mediaType: 'text/csv',
  })

  assert.equal(preserved.sha256, sha256)
  const listUrl = new URL(calls.find((call) => call.startsWith('https://www.googleapis.com/drive/v3/files?')) as string)
  assert.match(
    listUrl.searchParams.get('q') ?? '',
    /'shared_drive_0123456789' in parents/,
  )
})

test('Google Drive import store rejects incomplete Shared Drive configuration', () => {
  assert.throws(
    () =>
      createGoogleDriveImportObjectStore({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
        sharedDriveId: '',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOOGLE_DRIVE_IMPORT_CONFIGURATION_FAILED',
  )
})

test('Google Drive import store distinguishes token failures without provider prose', async () => {
  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
    },
    async () => jsonResponse(
      { error: 'synthetic-provider-detail' },
      { status: 400 },
    ),
  )

  await assert.rejects(
    () => store.preserve({
      bytes: Buffer.from('synthetic bytes'),
      filename: 'usage.csv',
      mediaType: 'text/csv',
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOOGLE_DRIVE_IMPORT_TOKEN_FAILED' &&
      !error.message.includes('synthetic-provider-detail'),
  )
})

test('Google Drive import store discards malformed provider IDs', async () => {
  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
    },
    async (url) => {
      const href = url.toString()
      if (href === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'synthetic-access-token', expires_in: 3600 })
      }
      if (href.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        return jsonResponse({ files: [{ id: 'bad id with spaces' }] })
      }
      throw new Error(`unexpected fetch ${href}`)
    },
  )

  await assert.rejects(
    () =>
      store.preserve({
        bytes: Buffer.from('Task ID,Duration\nsynthetic-task,42\n'),
        filename: 'usage.csv',
        mediaType: 'text/csv',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOOGLE_DRIVE_IMPORT_LOOKUP_FAILED',
  )
})

test('Google Drive import store rejects unsafe resumable upload URLs', async () => {
  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
    },
    async (url) => {
      const href = url.toString()
      if (href === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({ access_token: 'synthetic-access-token', expires_in: 3600 })
      }
      if (href.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        return jsonResponse({ files: [] })
      }
      if (href.startsWith('https://www.googleapis.com/upload/drive/v3/files?')) {
        return new Response(null, {
          status: 200,
          headers: {
            location: 'https://attacker.invalid/upload/drive/v3/files?upload_id=session_1',
          },
        })
      }
      throw new Error(`unexpected fetch ${href}`)
    },
  )

  await assert.rejects(
    () =>
      store.preserve({
        bytes: Buffer.from('%PDF- synthetic invoice bytes'),
        filename: 'invoice.pdf',
        mediaType: 'application/pdf',
      }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOOGLE_DRIVE_IMPORT_UPLOAD_SESSION_FAILED',
  )
})

test('Google Drive import store distinguishes failed upload bytes', async () => {
  const store = createGoogleDriveImportObjectStore(
    {
      clientId: 'client-id',
      clientSecret: 'client-secret',
      refreshToken: 'refresh-token',
      sharedDriveId: 'shared_drive_0123456789',
    },
    async (url) => {
      const href = url.toString()
      if (href === 'https://oauth2.googleapis.com/token') {
        return jsonResponse({
          access_token: 'synthetic-access-token',
          expires_in: 3600,
        })
      }
      if (href.startsWith('https://www.googleapis.com/drive/v3/files?')) {
        return jsonResponse({ files: [] })
      }
      if (href.startsWith(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&supportsAllDrives=true',
      )) {
        return new Response(null, {
          status: 200,
          headers: {
            location:
              'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session_2',
          },
        })
      }
      return jsonResponse(
        { error: 'synthetic-provider-detail' },
        { status: 403 },
      )
    },
  )

  await assert.rejects(
    () => store.preserve({
      bytes: Buffer.from('synthetic bytes'),
      filename: 'usage.csv',
      mediaType: 'text/csv',
    }),
    (error: unknown) =>
      error instanceof Error &&
      'code' in error &&
      error.code === 'GOOGLE_DRIVE_IMPORT_UPLOAD_FAILED' &&
      !error.message.includes('synthetic-provider-detail'),
  )
})
