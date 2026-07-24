import type { BackfillCandidate, BackfillRepo, RawStore } from './ports.ts'
import { normalizeRecordingUrl } from './normalizeRecordingUrl.ts'

// Populates `source_url` on recording call_artifact rows by reading the per-call raw
// KServe file ({root}/raw/{batchUUID}/{taskId}.json), extracting the recording URL, and
// normalizing it to the stable S3 object URL. Every unresolved case is a recorded
// finding — never a silent skip.

export type BackfillOutcome =
  | 'backfilled'
  | 'already_present'
  | 'raw_missing'
  | 'call_not_in_export'
  | 'no_recording_url'
  | 'unrecognized_url'

export interface BackfillResult {
  id: string
  outcome: BackfillOutcome
  s3Url?: string
  reason?: string
}

export interface BackfillOptions {
  dryRun: boolean
  allowedHosts: string[]
}

export interface BackfillPorts {
  rawStore: RawStore
  repo: BackfillRepo
}

export interface BackfillSummary {
  total: number
  backfilled: number
  alreadyPresent: number
  rawMissing: number
  callNotInExport: number
  noRecordingUrl: number
  unrecognizedUrl: number
  results: BackfillResult[]
}

// Robust to both observed shapes: a flat per-call record { …, recordingUrl } or a
// taskId-keyed wrapper { "<taskId>": { …, recordingUrl } }.
function pickCallRecord(doc: unknown, key: string): Record<string, unknown> | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null
  const anyDoc = doc as Record<string, unknown>
  const keyed = anyDoc[key]
  if (keyed && typeof keyed === 'object' && !Array.isArray(keyed)) {
    return keyed as Record<string, unknown> // taskId-keyed wrapper
  }
  return anyDoc // per-call file: the document itself is the call record
}

export async function backfillSourceUrl(
  c: BackfillCandidate,
  ports: BackfillPorts,
  opts: BackfillOptions,
): Promise<BackfillResult> {
  if (c.existingSourceUrl) {
    return { id: c.callArtifactId, outcome: 'already_present' }
  }

  const doc = await ports.rawStore.readByTaskId(c.logicalCallKey)
  if (doc == null) {
    if (!opts.dryRun) await ports.repo.recordIssue(c.callArtifactId, 'raw_missing', `taskId ${c.logicalCallKey}`)
    return { id: c.callArtifactId, outcome: 'raw_missing' }
  }

  const rec = pickCallRecord(doc, c.logicalCallKey)
  if (!rec) {
    if (!opts.dryRun) await ports.repo.recordIssue(c.callArtifactId, 'call_not_in_export', c.logicalCallKey)
    return { id: c.callArtifactId, outcome: 'call_not_in_export' }
  }

  const rawUrl = typeof rec.recordingUrl === 'string' && rec.recordingUrl.length ? rec.recordingUrl : null
  if (!rawUrl) {
    if (!opts.dryRun) await ports.repo.recordIssue(c.callArtifactId, 'no_recording_url', c.logicalCallKey)
    return { id: c.callArtifactId, outcome: 'no_recording_url' }
  }

  const norm = normalizeRecordingUrl(rawUrl, opts.allowedHosts)
  if (!norm.ok || !norm.s3Url) {
    if (!opts.dryRun) await ports.repo.recordIssue(c.callArtifactId, 'unrecognized_url', norm.reason ?? 'unknown')
    return { id: c.callArtifactId, outcome: 'unrecognized_url', reason: norm.reason }
  }

  if (!opts.dryRun) await ports.repo.setSourceUrl(c.callArtifactId, norm.s3Url)
  return { id: c.callArtifactId, outcome: 'backfilled', s3Url: norm.s3Url }
}

export async function backfillBatch(
  candidates: BackfillCandidate[],
  ports: BackfillPorts,
  opts: BackfillOptions,
): Promise<BackfillSummary> {
  const results: BackfillResult[] = []
  for (const c of candidates) results.push(await backfillSourceUrl(c, ports, opts))
  const n = (o: string): number => results.filter((r) => r.outcome === o).length
  return {
    total: results.length,
    backfilled: n('backfilled'),
    alreadyPresent: n('already_present'),
    rawMissing: n('raw_missing'),
    callNotInExport: n('call_not_in_export'),
    noRecordingUrl: n('no_recording_url'),
    unrecognizedUrl: n('unrecognized_url'),
    results,
  }
}
