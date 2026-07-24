// A recording (kaudit_call_artifact) that needs its stable S3 object URL written into
// `source_url`. Driven by "the raw export has a recordingUrl", NOT by any pre-existing
// evidence_object or the old fetch_status.
export interface BackfillCandidate {
  callArtifactId: string // the recording call_artifact row to set source_url on
  callId: string
  logicalCallKey: string // taskId (e.g. "T…") — the raw file is {logicalCallKey}.json
  existingSourceUrl: string | null
}

// Reads the raw KServe record for a call by its taskId (= logical_call_key). The
// on-disk layout is one file per call: {root}/raw/{batchUUID}/{taskId}.json.
export interface RawStore {
  readByTaskId(taskId: string): Promise<unknown | null>
}

export interface BackfillRepo {
  listCandidates(limit: number): Promise<BackfillCandidate[]>
  setSourceUrl(callArtifactId: string, s3Url: string): Promise<void>
  recordIssue(callArtifactId: string, code: string, detail: string): Promise<void>
}
