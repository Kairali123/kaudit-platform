import { buildDashboard, type RawMetrics, type Tile } from './metrics.ts'
import { formatMoney, subtract, trendWithDeadband, type Trend } from './decimal.ts'
import type { SnapshotCadence } from './periods.ts'

export interface CountRow {
  label: string
  n: number
}

export interface FindingRow {
  code: string
  n: number
  avgConfidence: string | null
}

export interface RawQualityMetrics {
  auditRuns: number | null
  analyzedCalls: number | null
  totalFindings: number | null
  callsWithFindings: number | null
  avgConfidence: string | null
  catalogVersion: string | null
  catalogStatus: string | null
  confirmations: CountRow[]
  origins: CountRow[]
  topFindings: FindingRow[]
}

export interface RawBillingMetrics {
  calculations: number | null
  authoritativeCalculations: number | null
  independentFinalCalculations: number | null
  unresolvedAutomatedDecisions: number | null
  calculatedTotal: string | null
  billableMinutes: string | null
  currency: string
  rateCardVersion: string | null
  rateCardStatus: string | null
  rateCardApprovedBy: string | null
  rateCardApprovedAt: string | null
  reconciliationStatus: string | null
  claimedSubtotal: string | null
  verifiedSubtotal: string | null
  netVariance: string | null
}

export interface RawRevenueSnapshot {
  cadence: SnapshotCadence
  label: string
  start: string
  end: string
  currency: string
  verified: string | null
  vendorClaimed: string | null
  vendorClaimedBasis: 'invoiced' | 'provider_claimed_no_invoice' | 'unavailable'
  priorVerified: string | null
  priorVendorClaimed: string | null
}

export interface RawFullDashboard {
  generatedAt: string
  monitor: RawMetrics
  quality: RawQualityMetrics
  billing: RawBillingMetrics
  snapshots: RawRevenueSnapshot[]
}

export interface QualityView {
  tiles: Tile[]
  confirmations: CountRow[]
  origins: CountRow[]
  topFindings: (FindingRow & { confidenceLabel: string })[]
  catalogLabel: string
}

export interface BillingView {
  tiles: Tile[]
  rateCardLabel: string
  rateCardApproved: boolean
  rateCardApprovalLabel: string
  calculationsAuthoritative: boolean
  calculationAuthorityLabel: string
  reconciliationStatus: string
}

export interface RevenueSnapshotView {
  cadence: SnapshotCadence
  label: string
  period: string
  verified: string
  vendorClaimed: string
  variance: string
  varianceRaw: string | null
  basisLabel: string
  trend: Trend
  trendLabel: string
}

export interface FullDashboardView {
  generatedAt: string
  accessControlEnforced: boolean
  overviewTiles: Tile[]
  integrityFindings: { action: string; n: number }[]
  quality: QualityView
  billing: BillingView
  snapshots: RevenueSnapshotView[]
}

export interface ReleaseGateView {
  code: 'access' | 'rate-card' | 'calibration' | 'k2-k3' | 'reporting'
  label: string
  detail: string
  status: 'ready' | 'blocked' | 'pending'
}

export interface OverviewPageView {
  generatedAt: string
  tiles: Tile[]
  gates: ReleaseGateView[]
}

export interface EvidencePageView {
  generatedAt: string
  tiles: Tile[]
  integrityFindings: { action: string; n: number }[]
}

export interface FindingsPageView {
  generatedAt: string
  authority: 'uncalibrated' | 'calibrated'
  quality: QualityView
}

export interface BillingPageView {
  generatedAt: string
  authority: 'provisional' | 'authoritative'
  billing: BillingView
}

export interface ReportsPageView {
  generatedAt: string
  authority: 'provisional' | 'authoritative'
  snapshots: RevenueSnapshotView[]
}

function fmtCount(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-IN')
}
function fmtPct(n: number | null, denominator: number | null): string {
  if (n == null || denominator == null || denominator === 0) return '—'
  return `${((n / denominator) * 100).toFixed(1)}%`
}
function confidenceLabel(value: string | null): string {
  if (value == null) return '—'
  const n = Number(value)
  return Number.isFinite(n) ? `${(n * 100).toFixed(1)}%` : '—'
}

export function buildQualityView(q: RawQualityMetrics, totalCalls: number | null): QualityView {
  const qualityTiles: Tile[] = [
    {
      label: 'Calls analyzed',
      value: fmtCount(q.analyzedCalls),
      sub: `${fmtPct(q.analyzedCalls, totalCalls)} of all calls`,
      status: q.analyzedCalls == null ? 'pending' : 'neutral',
    },
    {
      label: 'Findings generated',
      value: fmtCount(q.totalFindings),
      sub: q.callsWithFindings == null ? undefined : `${fmtCount(q.callsWithFindings)} affected calls`,
      status: q.totalFindings == null ? 'pending' : q.totalFindings > 0 ? 'warn' : 'good',
    },
    {
      label: 'Average model confidence',
      value: confidenceLabel(q.avgConfidence),
      sub: 'self-reported; not calibrated accuracy',
      status: q.avgConfidence == null ? 'pending' : 'warn',
    },
    {
      label: 'Audit runs',
      value: fmtCount(q.auditRuns),
      sub: 'automated analysis executions',
      status: q.auditRuns == null ? 'pending' : 'neutral',
    },
  ]
  return {
    tiles: qualityTiles,
    confirmations: q.confirmations,
    origins: q.origins,
    topFindings: q.topFindings.map((f) => ({ ...f, confidenceLabel: confidenceLabel(f.avgConfidence) })),
    catalogLabel: q.catalogVersion
      ? `${q.catalogVersion} · ${q.catalogStatus ?? 'unknown status'}`
      : 'catalog unavailable',
  }
}

export function buildBillingView(b: RawBillingMetrics): BillingView {
  const rateCardApproved =
    b.rateCardStatus === 'published' && Boolean(b.rateCardApprovedBy) && Boolean(b.rateCardApprovedAt)
  const calculationsAuthoritative =
    rateCardApproved &&
    b.calculations != null &&
    b.calculations > 0 &&
    b.authoritativeCalculations === b.calculations &&
    b.unresolvedAutomatedDecisions === 0
  const authorityCoverageLabel =
    b.authoritativeCalculations == null
      ? `authority telemetry unavailable for ${fmtCount(b.calculations)} current calculations`
      : `${fmtCount(b.authoritativeCalculations)} of ` +
        `${fmtCount(b.calculations)} current calculations are authoritative`
  const billingTiles: Tile[] = [
    {
      label: 'Current calculated amount',
      value: formatMoney(b.calculatedTotal, b.currency),
      sub: authorityCoverageLabel,
      status:
        b.calculatedTotal == null
          ? 'pending'
          : calculationsAuthoritative
            ? 'good'
            : 'warn',
    },
    {
      label: 'Invoice / vendor claim',
      value: formatMoney(b.claimedSubtotal, b.currency),
      sub: b.reconciliationStatus ? `reconciliation: ${b.reconciliationStatus}` : 'no reconciliation total',
      status: b.claimedSubtotal == null ? 'pending' : 'warn',
    },
    {
      label: 'Variance identified',
      value: formatMoney(
        b.netVariance ?? subtract(b.claimedSubtotal, b.verifiedSubtotal ?? b.calculatedTotal),
        b.currency,
      ),
      sub: 'identified — not recovered savings',
      status: 'warn',
    },
    {
      label: 'Billable minutes',
      value: b.billableMinutes == null ? '—' : Number(b.billableMinutes).toLocaleString('en-IN', { maximumFractionDigits: 1 }),
      sub: calculationsAuthoritative
        ? 'approved, independently traced calculations'
        : 'contains legacy/provisional calculation basis',
      status: b.billableMinutes == null ? 'pending' : calculationsAuthoritative ? 'good' : 'warn',
    },
  ]
  return {
    tiles: billingTiles,
    rateCardLabel: b.rateCardVersion
      ? `${b.rateCardVersion} · ${b.rateCardStatus ?? 'unknown status'}`
      : 'rate card unavailable',
    rateCardApproved,
    rateCardApprovalLabel: rateCardApproved
      ? `Published with named approval on ${b.rateCardApprovedAt}`
      : 'D-03 interpretation approved; database publication pending',
    calculationsAuthoritative,
    calculationAuthorityLabel: calculationsAuthoritative
      ? 'All current calculations are final, traced, and use an approved basis'
      : b.independentFinalCalculations == null ||
          b.unresolvedAutomatedDecisions == null
        ? 'Migration 0006 authority telemetry is not available in this database'
        : `${fmtCount(b.independentFinalCalculations)} independently verified; ` +
          `${fmtCount(b.unresolvedAutomatedDecisions)} unresolved automated decisions`,
    reconciliationStatus: b.reconciliationStatus ?? 'not started',
  }
}

export function buildRevenueSnapshots(raw: RawRevenueSnapshot[]): RevenueSnapshotView[] {
  return raw.map((s): RevenueSnapshotView => {
    const variance = subtract(s.vendorClaimed, s.verified)
    const priorVariance = subtract(s.priorVendorClaimed, s.priorVerified)
    const snapshotTrend = trendWithDeadband(s.verified, s.priorVerified)
    const trendLabel =
      snapshotTrend === 'up' ? 'up vs prior period'
        : snapshotTrend === 'down' ? 'down vs prior period'
          : snapshotTrend === 'flat' ? 'flat vs prior period'
            : 'no prior comparison'
    return {
      cadence: s.cadence,
      label: s.label,
      period: `${s.start} — ${s.end}`,
      verified: formatMoney(s.verified, s.currency),
      vendorClaimed: formatMoney(s.vendorClaimed, s.currency),
      variance: formatMoney(variance, s.currency),
      varianceRaw: variance,
      basisLabel:
        s.vendorClaimedBasis === 'invoiced'
          ? 'invoice total'
          : s.vendorClaimedBasis === 'provider_claimed_no_invoice'
            ? 'provider-asserted usage; no invoice'
            : 'claim unavailable',
      trend: snapshotTrend,
      trendLabel,
      ...(priorVariance == null && s.priorVerified == null ? {} : {}),
    }
  })
}

export function buildFullDashboard(
  raw: RawFullDashboard,
  options: { accessControlEnforced?: boolean } = {},
): FullDashboardView {
  const monitor = buildDashboard(raw.monitor)
  const q = raw.quality
  const totalCalls = raw.monitor.calls
  const b = raw.billing

  return {
    generatedAt: raw.generatedAt,
    accessControlEnforced: options.accessControlEnforced === true,
    overviewTiles: monitor.tiles,
    integrityFindings: monitor.findings,
    quality: buildQualityView(q, totalCalls),
    billing: buildBillingView(b),
    snapshots: buildRevenueSnapshots(raw.snapshots),
  }
}
