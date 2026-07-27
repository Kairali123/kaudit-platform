export type TileStatus = 'good' | 'warn' | 'neutral' | 'pending'

export interface Tile {
  label: string
  value: string
  sub?: string
  status: TileStatus
}

export interface Gate {
  code: string
  label: string
  detail: string
  status: 'ready' | 'blocked' | 'pending'
}

export interface Profile {
  id: string
  email: string
  roles: string[]
  permissions: string[]
  authMode: string
  accessControlEnforced: boolean
  contentAccess: string
}

export interface AuthConfig {
  mode: 'oidc' | 'local' | 'preview'
  providerLabel: string
  loginUrl: string | null
  logoutUrl: string | null
  accessControlEnforced: boolean
  passwordLoginSupported: false
}

export interface OverviewData {
  generatedAt: string
  tiles: Tile[]
  gates: Gate[]
}

export interface EvidenceData {
  generatedAt: string
  tiles: Tile[]
  integrityFindings: Array<{ action: string; n: number }>
}

export interface QualityData {
  generatedAt: string
  authority: 'uncalibrated' | 'calibrated'
  quality: {
    tiles: Tile[]
    confirmations: Array<{ label: string; n: number }>
    origins: Array<{ label: string; n: number }>
    topFindings: Array<{
      code: string
      n: number
      avgConfidence: string | null
      confidenceLabel: string
    }>
    catalogLabel: string
  }
}

export interface BillingData {
  generatedAt: string
  authority: 'audit_pending' | 'authoritative'
  billing: {
    tiles: Tile[]
    rateCardLabel: string
    rateCardApproved: boolean
    rateCardApprovalLabel: string
    calculationsAuthoritative: boolean
    calculationAuthorityLabel: string
    reconciliationStatus: string
    cycleStatusLabel: string
    cycle: BillingCycle
  }
}

export interface BillingCycle {
  periodStart: string | null
  periodEnd: string | null
  totalCalls: number
  recordingAvailableCalls: number
  completedAuditCalls: number
  acceptedAsBilledCalls: number
  finalCalculationCalls: number | null
  unresolvedDecisionCalls: number | null
  processingFailureCalls: number
  resolvedAuditCalls: number
  auditPendingCalls: number
  auditCoveragePercent: string
  rateCardApproved: boolean
  calibrationComplete: boolean
  status:
    | 'no_data'
    | 'audit_pending'
    | 'calibration_pending'
    | 'rate_card_pending'
    | 'calculation_pending'
    | 'ready'
  billGenerated: boolean
}

export interface Snapshot {
  cadence: 'weekly' | 'monthly' | 'quarterly' | 'yearly'
  label: string
  period: string
  verified: string
  vendorClaimed: string
  variance: string
  varianceRaw: string | null
  basisLabel: string
  trend: 'up' | 'down' | 'flat' | 'unknown'
  trendLabel: string
}

export interface ReportsData {
  generatedAt: string
  authority: 'audit_pending' | 'provisional' | 'authoritative'
  billingCycle: BillingCycle
  snapshots: Snapshot[]
}

export interface StatusCount {
  status: string
  count: number
}

export interface OperationsData {
  generatedAt: string
  outbox: StatusCount[]
  inbox: StatusCount[]
  jobs: StatusCount[]
  idempotency: StatusCount[]
  auditEvents: number | null
  auditChainConfigured: boolean | null
}

export interface AuditMonitorRow {
  callReference: string
  billingPeriodDate: string | null
  category: string
  outcomeTaxonomyVersion: string | null
  confidence: string | null
  confirmationStatus: string
  language: string
  asrProvider: string | null
  asrModel: string | null
  asrModelVersion: string | null
  auditEngineVersion: string | null
  recordedDurationMs: number | null
  speechDurationMs: number | null
  conversationEndMs: number | null
  graceAdjustedDurationMs: number | null
  vendorConnectedDurationMs: number | null
  varianceDurationMs: number | null
  evidenceHashRecorded: boolean
  lastEvidenceVerifiedAt: string | null
  auditedAt: string | null
}

export interface AuditMonitorData {
  generatedAt: string
  summary: {
    totalCalls: number
    aiAuditedCalls: number
    auditCoveragePercent: string
    recordingAvailableCalls: number
    pendingEligibleCalls: number
    noRecordingCalls: number
    processingFailureCalls: number
    reauditV2Calls: number
  }
  rows: AuditMonitorRow[]
  pagination: {
    page: number
    pageSize: number
    totalRows: number
    totalPages: number
  }
  filters: {
    category: string | null
    language: string | null
    availableCategories: string[]
    availableLanguages: string[]
  }
  authority: 'uncalibrated'
  contentBoundary: string
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly correlationId: string | null,
  ) {
    super(message)
  }
}

export async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: { accept: 'application/json' },
  })
  const correlationId = response.headers.get('x-correlation-id')
  if (!response.ok) {
    let message = 'The request could not be completed.'
    try {
      const problem = (await response.json()) as { title?: string }
      message = problem.title || message
    } catch {
      // The server intentionally returns a generic client-safe error.
    }
    throw new ApiError(message, response.status, correlationId)
  }
  return response.json() as Promise<T>
}

export interface ImportStatus {
  enabled: boolean
  storageBoundary: string
  recentBatches: Array<{
    id: string
    type: string
    periodStart: string | null
    periodEnd: string | null
    status: string
    received: number
    accepted: number
    rejected: number
    duplicates: number
    startedAt: string
  }>
  recentInvoices: Array<{
    id: string
    invoiceNumber: string
    periodStart: string
    periodEnd: string
    totalAmount: string
    status: string
  }>
}

export interface ImportResult {
  outcome: 'imported' | 'duplicate'
  referenceId: string
  received: number
  accepted: number
  duplicates: number
  auditJobsQueued: number
  missingRecordingUrls: number
}

export async function postFile<T>(
  path: string,
  file: File,
  metadata: Record<string, string>,
): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    credentials: 'same-origin',
    headers: {
      accept: 'application/json',
      'content-type': file.type || 'application/octet-stream',
      'x-kaudit-filename': file.name,
      ...Object.fromEntries(
        Object.entries(metadata).map(([name, value]) => [
          `x-kaudit-${name}`,
          value,
        ]),
      ),
    },
    body: file,
  })
  const correlationId = response.headers.get('x-correlation-id')
  if (!response.ok) {
    let message = 'The upload could not be completed.'
    try {
      const problem = (await response.json()) as { title?: string }
      message = problem.title || message
    } catch {
      // Keep the privacy-safe fallback.
    }
    throw new ApiError(message, response.status, correlationId)
  }
  return response.json() as Promise<T>
}
