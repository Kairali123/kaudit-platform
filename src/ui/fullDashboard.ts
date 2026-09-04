import { buildDashboard, type RawMetrics, type Tile } from './metrics.ts'
import { formatMoney, subtract, trendWithDeadband, type Trend } from './decimal.ts'
import type { SnapshotCadence } from './periods.ts'
import {
  assessBillingCycleReadiness,
  type BillingCycleCounts,
  type BillingCycleStatus,
} from '../billing/cycleReadiness.ts'

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
  /** Where the claim came from, so the tile can say rather than imply. */
  claimedSubtotalBasis?: 'reconciled' | 'vendor_invoice' | 'unavailable'
  verifiedSubtotal: string | null
  netVariance: string | null
  cycle: RawBillingCycle
}

export interface RawBillingCycle extends BillingCycleCounts {
  calculatedTotal: string | null
  billableMinutes: string | null
  currency: string
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
  cycle: ReturnType<typeof assessBillingCycleReadiness>
  cycleStatusLabel: string
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
  code:
    | 'access'
    | 'rate-card'
    | 'calibration'
    | 'audit-cycle'
    | 'reporting'
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

export function buildBillingView(
  b: RawBillingMetrics,
  options: { calibrationComplete?: boolean } = {},
): BillingView {
  const rateCardApproved =
    b.rateCardStatus === 'published' && Boolean(b.rateCardApprovedBy) && Boolean(b.rateCardApprovedAt)
  const cycle = assessBillingCycleReadiness({
    ...b.cycle,
    rateCardApproved,
    calibrationComplete: options.calibrationComplete === true,
  })
  const calculationsAuthoritative = cycle.billGenerated
  const authorityCoverageLabel =
    cycle.finalCalculationCalls == null
      ? `authority telemetry unavailable for ${fmtCount(cycle.totalCalls)} cycle calls`
      : `${fmtCount(cycle.finalCalculationCalls)} of ` +
        `${fmtCount(cycle.totalCalls)} cycle calculations are authoritative`
  const pendingStatusLabel: Record<BillingCycleStatus, string> = {
    no_data: 'No billing cycle data',
    audit_pending: 'Audit pending',
    calibration_pending: 'Calibration pending',
    rate_card_pending: 'Rate card pending',
    calculation_pending: 'Final calculation pending',
    ready: 'Ready',
  }
  const cyclePeriod =
    cycle.periodStart && cycle.periodEnd
      ? `${cycle.periodStart} — ${cycle.periodEnd}`
      : 'No cycle loaded'
  const billingTiles: Tile[] = cycle.billGenerated
    ? [
    {
      label: 'Verified bill',
      value: formatMoney(b.cycle.calculatedTotal, b.cycle.currency),
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
      // The claim and the agreement to it are different facts, so the tile
      // names which one it is showing instead of leaving the reader to assume.
      sub: b.reconciliationStatus
        ? `reconciliation: ${b.reconciliationStatus}`
        : b.claimedSubtotalBasis === 'vendor_invoice'
          ? 'vendor invoice — reconciliation not started'
          : 'no vendor invoice recorded',
      status: b.claimedSubtotal == null ? 'pending' : 'warn',
    },
    {
      label: 'Variance identified',
      value: formatMoney(
        b.netVariance ?? subtract(b.claimedSubtotal, b.verifiedSubtotal ?? b.calculatedTotal),
        b.currency,
      ),
      sub: b.netVariance != null
        ? 'identified — not recovered savings'
        : 'claim minus verified — not a closed reconciliation',
      status: 'warn',
    },
    {
      label: 'Billable minutes',
      value:
        b.cycle.billableMinutes == null
          ? '—'
          : Number(b.cycle.billableMinutes).toLocaleString('en-IN', {
              maximumFractionDigits: 1,
            }),
      sub: calculationsAuthoritative
        ? 'approved, independently traced calculations'
        : 'contains legacy/provisional calculation basis',
      status: b.cycle.billableMinutes == null ? 'pending' : 'good',
    },
      ]
    : [
        {
          label: 'Verified bill',
          value: pendingStatusLabel[cycle.status],
          sub: 'No Kairali bill is released before cycle completion',
          status: 'pending',
        },
        {
          label: 'Billing cycle',
          value: cyclePeriod,
          sub: `${fmtCount(cycle.totalCalls)} calls loaded`,
          status: cycle.totalCalls > 0 ? 'neutral' : 'pending',
        },
        {
          label: 'Audit resolved',
          value: `${fmtCount(cycle.resolvedAuditCalls)} / ${fmtCount(cycle.totalCalls)}`,
          sub: `${cycle.auditCoveragePercent}% complete`,
          status: cycle.auditPendingCalls === 0 ? 'good' : 'warn',
        },
        {
          label: 'Audit pending',
          value: fmtCount(cycle.auditPendingCalls),
          sub:
            `${fmtCount(cycle.recordingAvailableCalls)} recording URLs · ` +
            `${fmtCount(cycle.processingFailureCalls)} processing failures`,
          status: cycle.auditPendingCalls > 0 ? 'warn' : 'good',
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
      ? 'All cycle calculations are final, traced, and use an approved basis'
      : cycle.finalCalculationCalls == null ||
          cycle.unresolvedDecisionCalls == null
        ? 'Migration 0006 authority telemetry is not available in this database'
        : `${fmtCount(cycle.completedAuditCalls)} V2 audited; ` +
          `${fmtCount(cycle.acceptedAsBilledCalls)} accepted as billed; ` +
          `${fmtCount(cycle.unresolvedDecisionCalls)} unresolved decisions`,
    reconciliationStatus: b.reconciliationStatus ?? 'not started',
    cycle,
    cycleStatusLabel: pendingStatusLabel[cycle.status],
  }
}

export function buildRevenueSnapshots(
  raw: RawRevenueSnapshot[],
  options: { releaseVerifiedValues?: boolean } = {},
): RevenueSnapshotView[] {
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
      verified:
        options.releaseVerifiedValues === false
          ? 'Audit pending'
          : formatMoney(s.verified, s.currency),
      vendorClaimed: formatMoney(s.vendorClaimed, s.currency),
      variance:
        options.releaseVerifiedValues === false
          ? 'Audit pending'
          : formatMoney(variance, s.currency),
      varianceRaw:
        options.releaseVerifiedValues === false ? null : variance,
      basisLabel:
        s.vendorClaimedBasis === 'invoiced'
          ? 'invoice subtotal (pre-tax)'
          : s.vendorClaimedBasis === 'provider_claimed_no_invoice'
            ? 'provider-asserted usage; no invoice'
            : 'claim unavailable',
      trend:
        options.releaseVerifiedValues === false
          ? 'unknown'
          : snapshotTrend,
      trendLabel:
        options.releaseVerifiedValues === false
          ? 'available after audit'
          : trendLabel,
      ...(priorVariance == null && s.priorVerified == null ? {} : {}),
    }
  })
}

export function buildFullDashboard(
  raw: RawFullDashboard,
  options: {
    accessControlEnforced?: boolean
    calibrationComplete?: boolean
  } = {},
): FullDashboardView {
  const monitor = buildDashboard(raw.monitor)
  const q = raw.quality
  const totalCalls = raw.monitor.calls
  const b = raw.billing
  const billing = buildBillingView(b, {
    calibrationComplete: options.calibrationComplete,
  })

  return {
    generatedAt: raw.generatedAt,
    accessControlEnforced: options.accessControlEnforced === true,
    overviewTiles: monitor.tiles,
    integrityFindings: monitor.findings,
    quality: buildQualityView(q, totalCalls),
    billing,
    snapshots: buildRevenueSnapshots(raw.snapshots, {
      releaseVerifiedValues: billing.cycle.billGenerated,
    }),
  }
}
