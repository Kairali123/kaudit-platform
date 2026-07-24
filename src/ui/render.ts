import type { DashboardView, Tile } from './metrics.ts'

// Renders the monitoring view to a self-contained HTML page (inline CSS, no external
// requests, theme-aware). Status is shown with a label + dot (never colour alone).

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

const STATUS_LABEL: Record<Tile['status'], string> = {
  good: 'ok',
  warn: 'attention',
  neutral: '',
  pending: 'pending',
}

function tileHtml(t: Tile): string {
  const badge = t.status === 'neutral' ? '' : `<span class="badge ${t.status}"><span class="dot"></span>${STATUS_LABEL[t.status]}</span>`
  const sub = t.sub ? `<div class="sub">${esc(t.sub)}</div>` : ''
  return `<div class="tile">
    <div class="tile-head"><span class="label">${esc(t.label)}</span>${badge}</div>
    <div class="value">${esc(t.value)}</div>
    ${sub}
  </div>`
}

export function renderDashboard(view: DashboardView): string {
  const tiles = view.tiles.map(tileHtml).join('\n')
  const findings = view.findings.length
    ? `<section class="findings"><h2>Integrity findings (audit log)</h2><table>
        <thead><tr><th>Finding</th><th>Count</th></tr></thead>
        <tbody>${view.findings
          .map((f) => `<tr><td>${esc(f.action)}</td><td class="num">${f.n.toLocaleString('en-IN')}</td></tr>`)
          .join('')}</tbody></table></section>`
    : ''
  const conn = view.reachable ? '' : `<div class="warnbar">Database not reachable — showing what is available. Check the connection / migrations.</div>`

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Kairali Audit — Monitoring</title>
<style>
  :root{--bg:#f7f8fa;--surface:#fff;--ink:#1a1f2b;--muted:#5b6472;--line:#e5e8ee;
    --good:#1f8a4c;--warn:#b9770e;--pending:#5b6472;--accent:#2c5cc5}
  @media (prefers-color-scheme:dark){:root{--bg:#0f1218;--surface:#161b24;--ink:#e8ecf3;
    --muted:#9aa4b2;--line:#242b36;--good:#3fbf74;--warn:#e0a23a;--pending:#9aa4b2;--accent:#6f9bff}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--ink);
    font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
  .wrap{max-width:1040px;margin:0 auto;padding:28px 20px 48px}
  header h1{font-size:20px;margin:0 0 2px} header .as-of{color:var(--muted);font-size:13px}
  .caveat{margin:16px 0;padding:12px 14px;border-left:3px solid var(--accent);
    background:color-mix(in srgb,var(--accent) 8%,var(--surface));border-radius:6px;
    color:var(--muted);font-size:13.5px}
  .warnbar{margin:12px 0;padding:10px 14px;border-radius:6px;font-size:13.5px;
    background:color-mix(in srgb,var(--warn) 14%,var(--surface));color:var(--ink)}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:14px;margin-top:8px}
  .tile{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:16px 16px 14px}
  .tile-head{display:flex;justify-content:space-between;align-items:center;gap:8px}
  .label{color:var(--muted);font-size:13px;font-weight:500}
  .value{font-size:30px;font-weight:650;letter-spacing:-.5px;margin-top:6px}
  .sub{color:var(--muted);font-size:12.5px;margin-top:4px}
  .badge{display:inline-flex;align-items:center;gap:5px;font-size:11.5px;font-weight:600;
    text-transform:uppercase;letter-spacing:.03em}
  .badge .dot{width:8px;height:8px;border-radius:50%}
  .badge.good{color:var(--good)} .badge.good .dot{background:var(--good)}
  .badge.warn{color:var(--warn)} .badge.warn .dot{background:var(--warn)}
  .badge.pending{color:var(--pending)} .badge.pending .dot{background:var(--pending)}
  .findings{margin-top:28px} .findings h2{font-size:15px;margin:0 0 8px}
  table{width:100%;border-collapse:collapse;background:var(--surface);
    border:1px solid var(--line);border-radius:10px;overflow:hidden}
  th,td{text-align:left;padding:9px 14px;border-bottom:1px solid var(--line);font-size:13.5px}
  th{color:var(--muted);font-weight:600} tr:last-child td{border-bottom:none}
  td.num{text-align:right;font-variant-numeric:tabular-nums}
  footer{margin-top:32px;color:var(--muted);font-size:12px}
</style></head>
<body><div class="wrap">
  <header>
    <h1>Kairali Voice Audit — Monitoring</h1>
    <div class="as-of">As of ${esc(view.generatedAt)}</div>
  </header>
  ${conn}
  <div class="caveat">${esc(view.caveat)}</div>
  <div class="grid">${tiles}</div>
  ${findings}
  <footer>Read-only status view. Aggregate counts only — no customer, phone, transcript, or health content. Refresh the page to update.</footer>
</div></body></html>`
}
