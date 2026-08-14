import path from 'node:path'

export interface PreservedImportObject {
  objectBucket: string
  objectKey: string
  sha256: string
}

export interface ImportObjectStore {
  readonly storageBoundary: string
  preserve(input: {
    bytes: Buffer
    filename: string
    mediaType: 'text/csv' | 'application/pdf'
  }): Promise<PreservedImportObject>
}

export function safeImportFilename(filename: string): string {
  return path.basename(filename)
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, 120)
}

export function safeImportExtension(filename: string): string {
  return path.extname(safeImportFilename(filename)).toLowerCase().slice(0, 10)
}
