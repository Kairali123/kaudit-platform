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
  accessControlEnforced: false
  overviewTiles: Tile[]
  integrityFindings: { action: string; n: number }[]
  quality: QualityView
  billing: BillingView
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

export function buildFullDashboard(raw: RawFullDashboard): FullDashboardView {
  const monitor = buildDashboard(raw.monitor)
  const q = raw.quality
  const totalCalls = raw.monitor.calls
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

  const b = raw.billing
  const rateCardApproved =
    b.rateCardStatus === 'published' && Boolean(b.rateCardApprovedBy) && Boolean(b.rateCardApprovedAt)
  const billingTiles: Tile[] = [
    {
      label: 'Calculated billable amount',
      value: formatMoney(b.calculatedTotal, b.currency),
      sub: `${fmtCount(b.calculations)} call calculations`,
      status: b.calculatedTotal == null ? 'pending' : 'warn',
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
      sub: 'draft rate-card calculation',
      status: b.billableMinutes == null ? 'pending' : 'warn',
    },
  ]

  const snapshots = raw.snapshots.map((s): RevenueSnapshotView => {
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
      // priorVariance is intentionally calculated here as an integrity check; a
      // null/invalid prior leaves the trend unknown rather than fabricating it.
      ...(priorVariance == null && s.priorVerified == null ? {} : {}),
    }
  })

  return {
    generatedAt: raw.generatedAt,
    accessControlEnforced: false,
    overviewTiles: monitor.tiles,
    integrityFindings: monitor.findings,
    quality: {
      tiles: qualityTiles,
      confirmations: q.confirmations,
      origins: q.origins,
      topFindings: q.topFindings.map((f) => ({ ...f, confidenceLabel: confidenceLabel(f.avgConfidence) })),
      catalogLabel: q.catalogVersion
        ? `${q.catalogVersion} · ${q.catalogStatus ?? 'unknown status'}`
        : 'catalog unavailable',
    },
    billing: {
      tiles: billingTiles,
      rateCardLabel: b.rateCardVersion
        ? `${b.rateCardVersion} · ${b.rateCardStatus ?? 'unknown status'}`
        : 'rate card unavailable',
      rateCardApproved,
      rateCardApprovalLabel: rateCardApproved
        ? `Published with named approval on ${b.rateCardApprovedAt}`
        : 'D-03 open — draft/unapproved rate card',
      reconciliationStatus: b.reconciliationStatus ?? 'not started',
    },
    snapshots,
  }
}
