import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  CALL_AUDIT_REPORT_ROUTE,
  CALL_AUDIT_REPORT_TITLE,
  MAX_RESULT_LIMIT,
} from './callAuditReport.ts'

/**
 * Static contract between the sanitized reporting API and the web page that
 * renders it. The project has no browser test runner, so this pins the parts a
 * render test would otherwise catch: the page is wired to the read-only route,
 * it is reachable from the app shell, and nothing forbidden is hard-coded into
 * the UI — neither an identity or content field nor billing-money language,
 * which belongs to the separate Billing Audit module.
 */

const WEB_ROOT = path.resolve(
  import.meta.dirname,
  '../../apps/web/src',
)

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

/** Word-boundary patterns, so 'accurate' is not read as a rate. */
const FORBIDDEN_UI_PATTERNS: Array<[string, RegExp]> = [
  ['raw transcript field', /\.transcript\b/],
  ['lead identity', /\bleadId\b|\blead_id\b/],
  ['identity hash', /sha256/i],
  ['source URL', /\bsourceUrl\b|\brecordingUrl\b/],
  ['source row id', /\bsourceRowId\b|\bsourceRefId\b/],
  ['raw model payload', /\bresultJson\b|\bresultSha\b/],
  ['prompt or scoring config', /\bbusinessPrompt\b|\bscoringConfig\b/],
  ['model settings', /\bmodelName\b|\bmodelVersion\b|\bproviderName\b|\btemperature\b/],
  ['provider error prose', /\berrorDetail\b/],
  ['money symbol', /₹|\bINR\b|\bUSD\b/],
  ['money terminology', /\bamount\b|\binvoice\b|\bprice\b|\brate\b|\bcost\b|\bspend\b|\bbilling\b|\bbillable\b/i],
]

test('the call audit page reads only the sanitized reporting route', async () => {
  const page = await webSource('pages/CallAuditReportPage.tsx')
  assert.ok(
    page.includes(CALL_AUDIT_REPORT_ROUTE),
    'the page must call the read-only reporting route',
  )
  assert.ok(page.includes(CALL_AUDIT_REPORT_TITLE))
  assert.ok(page.includes('Saanvi'))
  // Every cadence control the report requires.
  for (const cadence of ['daily', 'monthly', 'quarterly', 'yearly']) {
    assert.ok(page.includes(`'${cadence}'`), cadence)
  }
  // The drilldown bound mirrors the server bound rather than inventing one.
  assert.ok(page.includes(String(MAX_RESULT_LIMIT)))
  // No other API is reachable from this page.
  const routes = page.match(/\/api\/v1\/[a-z0-9/-]+/g) ?? []
  assert.deepEqual([...new Set(routes)], [CALL_AUDIT_REPORT_ROUTE])
})

/** Everything a browser could render: comments are dropped before scanning. */
function renderable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

test('the call audit UI hard-codes no identity, content, or money field', async () => {
  for (const file of [
    'pages/CallAuditReportPage.tsx',
    'lib/api.ts',
  ]) {
    const source = await webSource(file)
    // Only the Call Audit block of the shared API types: the Billing and import
    // types in the same file legitimately name money.
    const block =
      file === 'lib/api.ts'
        ? source.slice(
            source.indexOf('export type CallAuditCadence'),
            source.indexOf('export class ApiError'),
          )
        : source
    const scoped = renderable(block)
    for (const [reason, pattern] of FORBIDDEN_UI_PATTERNS) {
      assert.equal(
        pattern.test(scoped),
        false,
        `${file} must not reference ${reason}`,
      )
    }
    // The presence signal is allowed; the transcript itself never is.
    assert.ok(scoped.includes('hasTranscript'))
  }
})

test('the call audit page is routed and reachable from the app shell', async () => {
  const app = await webSource('App.tsx')
  assert.match(app, /path="call-audit"/)
  assert.match(app, /CallAuditReportPage/)
  const shell = await webSource('components/AppShell.tsx')
  assert.match(shell, /to: '\/call-audit', label: '[^']+', icon: \w+, end: true/)
  // The report item carries no `admin` flag: sanitized reporting is aggregate
  // and anonymous, so it is reachable by every logged-in user. The structural
  // grouping this depends on is pinned in callAuditSettingsWebContract.test.ts.
  const reportItem = shell.slice(
    shell.indexOf("{ to: '/call-audit',"),
    shell.indexOf("to: '/call-audit/settings'"),
  )
  assert.ok(reportItem.length > 0, 'the report nav item must be found')
  assert.equal(reportItem.includes('admin'), false)
})

test('the call audit page carries its own scoped styling', async () => {
  const styles = await webSource('styles.css')
  assert.match(styles, /\.callaudit \{/)
  assert.match(styles, /--ca-accent:/)
  // Responsive rules exist for the dense report surfaces.
  for (const selector of ['.ca-sections', '.ca-controls', '.ca-basis']) {
    assert.ok(
      styles.split(selector).length > 2,
      `${selector} needs a responsive override`,
    )
  }
})
