import type {
  FullDashboardView,
  RevenueSnapshotView,
} from './fullDashboard.ts'
import type { Tile } from './metrics.ts'

function esc(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  )
}

const STATUS_LABEL: Record<Tile['status'], string> = {
  good: 'ready',
  warn: 'attention',
  neutral: 'live',
  pending: 'pending',
}

function tile(t: Tile): string {
  return `<article class="metric-card ${t.status}">
    <div class="metric-top">
      <span class="eyebrow">${esc(t.label)}</span>
      <span class="state ${t.status}"><span class="state-dot"></span>${STATUS_LABEL[t.status]}</span>
    </div>
    <strong class="metric-value">${esc(t.value)}</strong>
    ${t.sub ? `<span class="metric-note">${esc(t.sub)}</span>` : ''}
  </article>`
}

function snapshotCard(s: RevenueSnapshotView): string {
  const arrow = s.trend === 'up' ? '↑' : s.trend === 'down' ? '↓' : s.trend === 'flat' ? '→' : '–'
  const varianceClass =
    s.varianceRaw == null ? 'muted'
      : s.varianceRaw.startsWith('-') ? 'negative'
        : s.varianceRaw === '0' ? 'muted' : 'positive'
  return `<article class="snapshot-card">
    <div class="snapshot-title">
      <div><span class="cadence">${esc(s.cadence)}</span><h3>${esc(s.label)}</h3></div>
      <span class="trend ${s.trend}" aria-label="${esc(s.trendLabel)}">${arrow} ${esc(s.trendLabel)}</span>
    </div>
    <div class="period">${esc(s.period)}</div>
    <dl class="snapshot-values">
      <div><dt>Verified billable</dt><dd>${esc(s.verified)}</dd></div>
      <div><dt>Vendor claim</dt><dd>${esc(s.vendorClaimed)}</dd><small>${esc(s.basisLabel)}</small></div>
      <div class="variance"><dt>Variance identified</dt><dd class="${varianceClass}">${esc(s.variance)}</dd><small>identified, not recovered</small></div>
    </dl>
  </article>`
}

function countTable(
  title: string,
  rows: { label: string; n: number }[],
): string {
  if (!rows.length) return `<div class="empty">No ${esc(title.toLowerCase())} data available.</div>`
  return `<div class="table-card"><h3>${esc(title)}</h3><table>
    <thead><tr><th>State</th><th class="num">Count</th></tr></thead>
    <tbody>${rows
      .map((r) => `<tr><td><span class="code">${esc(r.label)}</span></td><td class="num">${r.n.toLocaleString('en-IN')}</td></tr>`)
      .join('')}</tbody>
  </table></div>`
}

export function renderFullDashboard(view: FullDashboardView): string {
  const accessBanner = view.accessControlEnforced
    ? 'AUTHENTICATED · ROLE-CHECKED · AGGREGATE DATA ONLY'
    : 'LOCAL PREVIEW ONLY · ACCESS CONTROL NOT YET ENFORCED (W1) · DO NOT DEPLOY OR DISTRIBUTE'
  const accessGate = view.accessControlEnforced
    ? '<div class="gate good"><strong>Access control enforced</strong><span>OIDC identity and server-side metrics permission are required.</span></div>'
    : '<div class="gate danger"><strong>Access control pending</strong><span>No real auth is enforced yet. Local use by the project team only.</span></div>'
  const accessFooter = view.accessControlEnforced
    ? 'Authenticated aggregate dashboard. Raw call content remains unavailable.'
    : 'Aggregate-only local dashboard. No customer, phone, audio, transcript, or health content is rendered.'
  const topFindings = view.quality.topFindings.length
    ? `<div class="table-card wide"><div class="table-title"><div><h3>Top finding types</h3><p>Aggregate output only—no call content.</p></div><span class="chip">${esc(view.quality.catalogLabel)}</span></div>
        <table><thead><tr><th>Finding code</th><th class="num">Count</th><th class="num">Avg confidence</th></tr></thead>
        <tbody>${view.quality.topFindings
          .map((f) => `<tr><td><span class="code">${esc(f.code)}</span></td><td class="num">${f.n.toLocaleString('en-IN')}</td><td class="num">${esc(f.confidenceLabel)}</td></tr>`)
          .join('')}</tbody></table></div>`
    : '<div class="empty">No finding aggregates available.</div>'

  const integrity = view.integrityFindings.length
    ? `<div class="integrity-list">${view.integrityFindings
        .map((f) => `<div><span>${esc(f.action)}</span><strong>${f.n.toLocaleString('en-IN')}</strong></div>`)
        .join('')}</div>`
    : '<div class="clean-line"><span class="clean-dot"></span>No integrity anomalies logged.</div>'

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Kairali Voice Audit — Control Room</title>
<style>
  :root{
    --navy:#0a1630;--navy2:#102348;--paper:#f3f5f8;--card:#fff;--ink:#142033;
    --muted:#637086;--line:#dfe4eb;--blue:#2457d6;--blue-soft:#eaf0ff;
    --green:#167b4b;--green-soft:#e6f5ed;--amber:#a56408;--amber-soft:#fff3dd;
    --red:#a83737;--red-soft:#fff0f0;--violet:#6b46c1;--shadow:0 1px 2px rgba(10,22,48,.05),0 12px 30px rgba(10,22,48,.05)
  }
  *{box-sizing:border-box}
  html{scroll-behavior:smooth}
  body{margin:0;background:var(--paper);color:var(--ink);font:14px/1.5 Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
  a{color:inherit}
  .security-bar{background:#7f1d1d;color:#fff;padding:9px 22px;text-align:center;font-size:12.5px;font-weight:700;letter-spacing:.01em}
  .shell{min-height:100vh}
  .top{background:linear-gradient(135deg,var(--navy),var(--navy2));color:#fff;padding:24px 26px 92px}
  .top-inner,.main{max-width:1220px;margin:0 auto}
  .brand-row{display:flex;align-items:center;justify-content:space-between;gap:24px}
  .brand{display:flex;align-items:center;gap:11px;font-weight:750;letter-spacing:.01em}
  .brand-mark{width:34px;height:34px;border-radius:9px;background:linear-gradient(145deg,#7ba2ff,#3768dd);display:grid;place-items:center;font-weight:800;box-shadow:inset 0 0 0 1px rgba(255,255,255,.25)}
  nav{display:flex;gap:6px}
  nav a{text-decoration:none;color:#cbd7f1;padding:7px 11px;border-radius:7px;font-size:13px}
  nav a:hover,nav a:focus-visible{background:rgba(255,255,255,.1);color:#fff;outline:none}
  .hero{display:flex;justify-content:space-between;align-items:flex-end;gap:30px;margin-top:42px}
  .hero p{margin:0 0 7px;color:#9fb2da;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.12em}
  .hero h1{margin:0;max-width:720px;font-size:34px;line-height:1.13;letter-spacing:-.035em}
  .hero-meta{text-align:right;color:#b9c8e5;font-size:12px;white-space:nowrap}
  .main{margin-top:-54px;padding:0 22px 70px}
  .gate-grid{display:grid;grid-template-columns:1.2fr 1fr 1fr;gap:12px;margin-bottom:18px}
  .gate{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;box-shadow:var(--shadow)}
  .gate strong{display:block;font-size:12px;margin-bottom:3px}.gate span{color:var(--muted);font-size:12.5px}
  .gate.danger{border-top:3px solid var(--red)}.gate.warn{border-top:3px solid var(--amber)}.gate.good{border-top:3px solid var(--green)}
  section{scroll-margin-top:18px;margin-top:26px}
  .section-heading{display:flex;justify-content:space-between;align-items:flex-end;gap:18px;margin-bottom:12px}
  .section-heading h2{font-size:20px;letter-spacing:-.02em;margin:0}.section-heading p{margin:3px 0 0;color:var(--muted)}
  .status-pill,.chip{display:inline-flex;align-items:center;border-radius:999px;padding:5px 9px;font-size:11.5px;font-weight:700;white-space:nowrap}
  .status-pill.provisional{background:var(--amber-soft);color:var(--amber)}.status-pill.uncalibrated{background:#f1ebff;color:var(--violet)}
  .metric-grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}
  .metric-card{min-height:132px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:15px 16px;box-shadow:var(--shadow)}
  .metric-card.warn{border-bottom:3px solid #dfae5e}.metric-card.good{border-bottom:3px solid #4fa879}.metric-card.pending{border-bottom:3px solid #9aa4b2}
  .metric-top{display:flex;justify-content:space-between;align-items:center;gap:9px}.eyebrow{color:var(--muted);font-size:12.5px;font-weight:650}
  .metric-value{display:block;font-size:27px;line-height:1.1;letter-spacing:-.035em;margin:18px 0 5px;font-variant-numeric:tabular-nums}
  .metric-note{display:block;color:var(--muted);font-size:11.5px}
  .state{display:inline-flex;align-items:center;gap:5px;text-transform:uppercase;letter-spacing:.05em;font-size:9.5px;font-weight:800;color:var(--muted)}
  .state-dot{width:6px;height:6px;border-radius:50%;background:#94a0b2}.state.good{color:var(--green)}.state.good .state-dot{background:var(--green)}
  .state.warn{color:var(--amber)}.state.warn .state-dot{background:var(--amber)}
  .state.pending{color:var(--muted)}
  .notice{display:flex;gap:12px;align-items:flex-start;margin-bottom:12px;padding:13px 15px;border-radius:11px;border:1px solid}
  .notice strong{display:block;margin-bottom:2px}.notice p{margin:0;font-size:12.5px}
  .notice.warn{background:var(--amber-soft);border-color:#efd19a;color:#714500}.notice.violet{background:#f5f0ff;border-color:#d9c9ff;color:#54369b}
  .notice .icon{font-size:17px;line-height:1}
  .two-col{display:grid;grid-template-columns:1.45fr .8fr;gap:12px;margin-top:12px}.side-stack{display:grid;gap:12px}
  .table-card,.panel{background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden;box-shadow:var(--shadow)}
  .table-card h3,.panel h3{font-size:13px;margin:0;padding:14px 15px 8px}.table-title{display:flex;justify-content:space-between;align-items:center;padding:14px 15px 8px}
  .table-title h3{padding:0}.table-title p{margin:2px 0 0;color:var(--muted);font-size:11.5px}.chip{background:#edf1f7;color:#58667c}
  table{width:100%;border-collapse:collapse}th,td{padding:9px 15px;border-top:1px solid var(--line);text-align:left;font-size:12.5px}
  th{color:var(--muted);font-weight:650;background:#fafbfc}.num{text-align:right;font-variant-numeric:tabular-nums}.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11.5px}
  .billing-meta{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px;color:var(--muted);font-size:12px}.billing-meta span{background:#e9edf3;padding:6px 9px;border-radius:7px}
  .snapshot-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}
  .snapshot-card{background:var(--card);border:1px solid var(--line);border-radius:13px;padding:17px;box-shadow:var(--shadow)}
  .snapshot-title{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.cadence{text-transform:uppercase;letter-spacing:.1em;font-size:10px;color:var(--blue);font-weight:800}
  .snapshot-title h3{margin:2px 0 0;font-size:16px}.period{color:var(--muted);font-size:11.5px;margin:4px 0 16px}
  .trend{font-size:11px;font-weight:750;border-radius:999px;padding:5px 8px;white-space:nowrap;background:#edf1f7;color:#657087}
  .trend.up{background:var(--green-soft);color:var(--green)}.trend.down{background:var(--red-soft);color:var(--red)}
  .snapshot-values{margin:0;display:grid;grid-template-columns:repeat(3,1fr);gap:10px}.snapshot-values div{border-left:1px solid var(--line);padding-left:11px}.snapshot-values div:first-child{border:0;padding-left:0}
  dt{color:var(--muted);font-size:10.5px}dd{margin:5px 0 0;font-size:16px;font-weight:750;font-variant-numeric:tabular-nums}.snapshot-values small{display:block;color:var(--muted);font-size:9.5px;margin-top:2px}
  .positive{color:var(--red)}.negative{color:var(--green)}.muted{color:var(--muted)}
  .integrity{margin-top:12px;padding:14px 15px}.integrity h3{padding:0;margin-bottom:8px}.clean-line{display:flex;align-items:center;gap:8px;color:var(--green);font-size:12.5px}.clean-dot{width:8px;height:8px;border-radius:50%;background:var(--green)}
  .integrity-list{display:grid;gap:6px}.integrity-list div{display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid var(--line);font-size:12px}.integrity-list div:first-child{border:0}
  .empty{padding:22px;background:var(--card);border:1px dashed var(--line);border-radius:12px;color:var(--muted)}
  footer{border-top:1px solid var(--line);margin-top:32px;padding-top:16px;color:var(--muted);font-size:11.5px;display:flex;justify-content:space-between;gap:20px}
  @media(max-width:900px){.metric-grid{grid-template-columns:repeat(2,1fr)}.gate-grid{grid-template-columns:1fr}.two-col{grid-template-columns:1fr}.snapshot-values{grid-template-columns:1fr}.snapshot-values div{border-left:0;border-top:1px solid var(--line);padding:9px 0 0}.snapshot-values div:first-child{border-top:0;padding-top:0}}
  @media(max-width:620px){.top{padding:18px 18px 82px}.main{padding:0 14px 50px}.brand-row{align-items:flex-start}.brand-row nav{display:none}.hero{align-items:flex-start;flex-direction:column;margin-top:32px}.hero h1{font-size:28px}.hero-meta{text-align:left}.metric-grid,.snapshot-grid{grid-template-columns:1fr}.section-heading{align-items:flex-start;flex-direction:column}.snapshot-title{flex-direction:column}.security-bar{text-align:left;padding:9px 14px}footer{flex-direction:column}}
</style></head>
<body>
  <div class="security-bar">${accessBanner}</div>
  <div class="shell">
    <header class="top"><div class="top-inner">
      <div class="brand-row">
        <div class="brand"><span class="brand-mark">K</span>Kairali Voice Audit</div>
        <nav aria-label="Dashboard sections">
          <a href="#overview">Overview</a><a href="#findings">Findings</a><a href="#billing">Billing</a><a href="#reports">Reports</a>
        </nav>
      </div>
      <div class="hero">
        <div><p>Independent audit control room</p><h1>Evidence, quality signals, and billing—without exposing call content.</h1></div>
        <div class="hero-meta">Generated ${esc(view.generatedAt)}<br>Aggregate data only</div>
      </div>
    </div></header>
    <main class="main">
      <div class="gate-grid" aria-label="Data status">
        ${accessGate}
        <div class="gate warn"><strong>Billing is provisional</strong><span>D-03 open: rate card is draft/unapproved.</span></div>
        <div class="gate warn"><strong>Findings are uncalibrated</strong><span>Confidence is not measured accuracy.</span></div>
      </div>

      <section id="overview">
        <div class="section-heading"><div><h2>Calls & evidence</h2><p>Current ingestion and evidence-integrity posture.</p></div><span class="status-pill provisional">live aggregates</span></div>
        <div class="metric-grid">${view.overviewTiles.map(tile).join('')}</div>
        <div class="panel integrity"><h3>Integrity event summary</h3>${integrity}</div>
      </section>

      <section id="findings">
        <div class="section-heading"><div><h2>Findings & quality</h2><p>Automated signals across analyzed calls.</p></div><span class="status-pill uncalibrated">uncalibrated</span></div>
        <div class="notice violet"><span class="icon">◇</span><div><strong>Accuracy has not been measured.</strong><p>These findings and confidence scores are model/rule output—not validated truth. Do not use them as a final safety or billing decision until calibration is complete.</p></div></div>
        <div class="metric-grid">${view.quality.tiles.map(tile).join('')}</div>
        <div class="two-col">${topFindings}<div class="side-stack">
          ${countTable('Confirmation state', view.quality.confirmations)}
          ${countTable('Finding origin', view.quality.origins)}
        </div></div>
      </section>

      <section id="billing">
        <div class="section-heading"><div><h2>Billing & revenue</h2><p>Current independent calculation and reconciliation position.</p></div><span class="status-pill provisional">provisional · D-03</span></div>
        <div class="notice warn"><span class="icon">!</span><div><strong>Pending formal rate-card approval.</strong><p>All monetary figures below were calculated against a draft rate card and are non-authoritative. “Variance identified” is not money recovered or saved.</p></div></div>
        <div class="metric-grid">${view.billing.tiles.map(tile).join('')}</div>
        <div class="billing-meta">
          <span>Rate card: ${esc(view.billing.rateCardLabel)}</span>
          <span>Approval: ${esc(view.billing.rateCardApprovalLabel)}</span>
          <span>Reconciliation: ${esc(view.billing.reconciliationStatus)}</span>
        </div>
      </section>

      <section id="reports">
        <div class="section-heading"><div><h2>Revenue snapshots</h2><p>D-12 headline view · weekly, monthly, fiscal quarterly, and fiscal yearly.</p></div><span class="status-pill provisional">provisional</span></div>
        <div class="notice warn"><span class="icon">!</span><div><strong>Live projections—not approved management snapshots.</strong><p>Periods use ISO Mon–Sun weeks and the Indian Apr–Mar fiscal calendar. Amounts stay provisional until D-03 and calibration clear.</p></div></div>
        <div class="snapshot-grid">${view.snapshots.map(snapshotCard).join('')}</div>
      </section>

      <footer><span>${accessFooter}</span><span>Refresh to update · billing/findings gates remain enforced</span></footer>
    </main>
  </div>
</body></html>`
}
