// Pure view-model for the read-only monitoring dashboard. Aggregate counts only —
// no per-call rows, no PII, no health content, and deliberately no billing/financial
// or findings-quality figures (those are non-authoritative pending D-03 + calibration).

export interface RawMetrics {
  calls: number | null
  recordingArtifacts: number | null
  withSourceUrl: number | null
  withBaseline: number | null // sha256 baseline recorded (verify EXECUTE)
  everVerified: number | null // last_verified_at set
  evidenceObjects: number | null
  ingestionBatches: number | null
  ingestionCompleted: number | null
  users: number | null
  findings: { action: string; n: number }[] // audit-log integrity anomalies
  generatedAt: string
}

export type TileStatus = 'good' | 'warn' | 'neutral' | 'pending'

export interface Tile {
  label: string
  value: string
  sub?: string
  status: TileStatus
}

export interface DashboardView {
  generatedAt: string
  reachable: boolean
  caveat: string
  tiles: Tile[]
  findings: { action: string; n: number }[]
}

function fmt(n: number | null): string {
  return n == null ? '—' : n.toLocaleString('en-IN')
}
function pctOf(a: number | null, b: number | null): string | undefined {
  if (a == null || b == null || b === 0) return undefined
  return `${((a / b) * 100).toFixed(1)}% of ${fmt(b)}`
}

export function buildDashboard(m: RawMetrics): DashboardView {
  const findingsTotal = m.findings.reduce((s, f) => s + f.n, 0)
  const reachable = m.calls != null

  const tiles: Tile[] = [
    { label: 'Calls ingested', value: fmt(m.calls), status: 'neutral' },
    {
      label: 'Recordings referenced',
      value: fmt(m.withSourceUrl),
      sub: m.withSourceUrl == null ? 'pending migration 0002 + backfill' : pctOf(m.withSourceUrl, m.recordingArtifacts),
      status: m.withSourceUrl == null ? 'pending' : m.withSourceUrl > 0 ? 'good' : 'neutral',
    },
    {
      label: 'Integrity baselines recorded',
      value: fmt(m.withBaseline),
      sub: m.withBaseline == null ? 'pending verify EXECUTE' : 'sha256 baselines',
      status: m.withBaseline == null ? 'pending' : m.withBaseline > 0 ? 'good' : 'neutral',
    },
    {
      label: 'Recordings verified reachable',
      value: fmt(m.everVerified),
      sub: 'last successful verify',
      status: m.everVerified == null ? 'pending' : 'neutral',
    },
    { label: 'Evidence objects', value: fmt(m.evidenceObjects), status: 'neutral' },
    {
      label: 'Ingestion batches',
      value: fmt(m.ingestionCompleted),
      sub: m.ingestionBatches != null ? `of ${fmt(m.ingestionBatches)} total` : undefined,
      status: 'neutral',
    },
    {
      label: 'Users provisioned',
      value: fmt(m.users),
      sub: m.users == null ? 'pending migration 0003 + seed' : undefined,
      status: m.users == null ? 'pending' : 'neutral',
    },
    {
      label: 'Integrity findings',
      value: reachable ? String(findingsTotal) : '—',
      sub: findingsTotal > 0 ? 'anomalies — see below' : reachable ? 'none detected' : undefined,
      status: !reachable ? 'pending' : findingsTotal > 0 ? 'warn' : 'good',
    },
  ]

  return {
    generatedAt: m.generatedAt,
    reachable,
    caveat:
      'Read-only monitoring — evidence integrity & ingestion only. Billing, findings-quality, and financial figures are intentionally excluded (non-authoritative pending rate-card publication, verified recalculation, and calibration). No customer or health content is shown.',
    tiles,
    findings: m.findings,
  }
}
