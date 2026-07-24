// A call whose recording needs its stable S3 object URL written into `source_url`.
export interface BackfillCandidate {
  evidenceObjectId: string // the recording evidence_object row to set source_url on
  callId: string
  logicalCallKey: string // taskId used to key into the raw export document
  rawBucket: string
  rawKey: string
  existingSourceUrl: string | null
}

// Reads a raw KServe export document (JSON) from wherever raw evidence is stored.
export interface RawStore {
  readJson(bucket: string, key: string): Promise<unknown | null>
}

export interface BackfillRepo {
  listCandidates(limit: number): Promise<BackfillCandidate[]>
  setSourceUrl(evidenceObjectId: string, s3Url: string): Promise<void>
  recordIssue(evidenceObjectId: string, code: string, detail: string): Promise<void>
}
