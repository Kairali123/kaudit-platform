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
  maxSensitivityTier: string
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
  authority: 'provisional' | 'authoritative'
  billing: {
    tiles: Tile[]
    rateCardLabel: string
    rateCardApproved: boolean
    rateCardApprovalLabel: string
    calculationsAuthoritative: boolean
    calculationAuthorityLabel: string
    reconciliationStatus: string
  }
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
  authority: 'provisional' | 'authoritative'
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
