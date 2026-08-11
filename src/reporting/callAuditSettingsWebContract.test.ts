import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import {
  ADMIN_EDITABLE_FIELDS,
  CALL_AUDIT_RULE_TEST_ROUTE,
  CALL_AUDIT_SETTINGS_PAGE_ROUTE,
  CALL_AUDIT_SETTINGS_ROUTE,
  CALL_AUDIT_SETTINGS_TITLE,
} from '../callaudit/adminSettings.ts'

/**
 * Static contract for the ADMIN Call Audit rule settings screen, the companion
 * to callAuditWebContract.test.ts which covers the sanitized report.
 *
 * The two screens have opposite allowances and so cannot share one scan: this
 * page is the one place prompts and model settings are legitimately named. What
 * it may never carry is evidence — a transcript, a source row, a lead identity,
 * a stored model payload, provider error prose — or anything about money, which
 * belongs to the separate Billing Audit module. The project has no browser test
 * runner, so this pins what a render test would otherwise catch: the wiring,
 * the admin-only reachability, the absence of forbidden fields, and the layout
 * rules that keep a twelve-column table from taking the page sideways with it.
 */

const WEB_ROOT = path.resolve(import.meta.dirname, '../../apps/web/src')
const REPO_ROOT = path.resolve(import.meta.dirname, '../..')

async function webSource(relative: string): Promise<string> {
  return readFile(path.join(WEB_ROOT, relative), 'utf8')
}

/** Everything a browser could render: comments are dropped before scanning. */
function renderable(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * Word-boundary patterns. Model and prompt fields are deliberately absent here:
 * they are this screen's subject. Everything below is evidence or money.
 *
 * The rule test lab is the one admitted transcript on this page, and it is
 * admitted in one direction only: an administrator types a transient value into
 * component state and it is POSTed once. Nothing may READ a transcript back —
 * no stored field, no server-returned text, no rendered result string — so the
 * pattern below still forbids every dotted or stored form of it, and the
 * dedicated tests further down pin where the one permitted value may travel.
 */
const FORBIDDEN_SETTINGS_PATTERNS: Array<[string, RegExp]> = [
  [
    'a read-back or stored transcript',
    /\.transcript\b|\btranscriptText\b|\bfullTranscript\b|\bstoredTranscript\b/,
  ],
  ['lead identity', /\bleadId\b|\blead_id\b/],
  ['source row reference', /\bsourceRowId\b|\bsourceRefId\b|\bsourceTable\b/],
  ['source recording or URL', /\bsourceUrl\b|\brecordingUrl\b|\baudioUrl\b/],
  ['external source table', /ai_voice_leads_received/],
  ['caller or customer identity', /\bphoneNumber\b|\bcustomerName\b|\bcallerName\b/],
  ['raw model payload', /\bresultJson\b|\bresultSha\b|\brawResponse\b/],
  ['provider error prose', /\berrorDetail\b|\bproviderMessage\b/],
  ['money symbol', /₹|\bINR\b|\bUSD\b/],
  [
    'money terminology',
    /\bamount\b|\binvoice\b|\bprice\b|\brate\b|\bcost\b|\bspend\b|\bbillable\b/i,
  ],
]

test('the settings page reads only the admin settings routes', async () => {
  const page = await webSource('pages/CallAuditSettingsPage.tsx')
  assert.ok(
    page.includes(CALL_AUDIT_SETTINGS_ROUTE),
    'the page must call the admin settings route',
  )
  // Exactly two APIs are reachable from this page: the settings surface and
  // the admin test lab that lives under it. Nothing else, in either order.
  const routes = page.match(/\/api\/v1\/[a-z0-9/-]+/g) ?? []
  assert.deepEqual(
    [...new Set(routes)].sort(),
    [CALL_AUDIT_RULE_TEST_ROUTE, CALL_AUDIT_SETTINGS_ROUTE].sort(),
  )
  // Every field the server treats as administrator-owned has an input.
  for (const field of ADMIN_EDITABLE_FIELDS) {
    assert.ok(page.includes(`'${field}'`), `${field} needs a form field`)
  }
})

test('the rule test lab posts to the test route and only ever POSTs', async () => {
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))
  assert.match(
    page,
    new RegExp(`const TEST_ROUTE = '${CALL_AUDIT_RULE_TEST_ROUTE}'`),
    'the test lab must name the admin test route exactly',
  )

  // A mutation, not a query: `useQuery` would need a key, and the only thing
  // that distinguishes one test from another is the submitted text itself.
  assert.match(page, /const runTest = useMutation\(\{/)
  assert.match(page, /postJson<CallAuditRuleTestResponse>\(\s*TEST_ROUTE,/)

  // The test route is never read. `getJson` is the settings load and nothing
  // else, so a GET carrying the submitted text cannot exist.
  const reads = [...page.matchAll(/getJson<[^>]+>\(\s*([A-Za-z_$][\w$]*)/g)]
  assert.ok(reads.length > 0, 'the settings load must be found')
  for (const read of reads) {
    assert.notEqual(read[1], 'TEST_ROUTE', 'the test route must not be read')
  }
})

/** Sinks that would outlive the one request, in any shape. */
const PERSISTENCE_SINKS = [
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'document.cookie',
  'navigator.clipboard',
  'console.',
]

test('the transient transcript stays in component state and one request body', async () => {
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))

  // Held in component state, and sent by name in the request body. These two
  // are the whole permitted life of the value.
  assert.match(page, /const \[labTranscript, setLabTranscript\] = useState\(''\)/)
  assert.match(page, /transcript: labTranscript,/)

  // Nothing on this page may outlive the request, for any value.
  for (const sink of PERSISTENCE_SINKS) {
    assert.equal(
      page.includes(sink),
      false,
      `${sink} must not be reachable from the settings page`,
    )
  }

  // Every react-query cache key on the page is a literal plus the version id
  // read from the URL. A key derived from the submitted text would put it in
  // the cache and keep it alive across navigations.
  const keys = page.match(/queryKey: \[[^\]]*\]/g) ?? []
  assert.ok(keys.length > 0, 'the settings query key must be found')
  for (const key of keys) {
    assert.match(key, /'call-audit-settings'/)
    assert.equal(
      /lab/i.test(key),
      false,
      'no cache key may be derived from the test lab',
    )
  }

  // The URL is written for one thing only: which prompt is expanded.
  const params = page.match(/next\.set\(([^,]+),/g) ?? []
  assert.ok(params.length > 0, 'the search-param write must be found')
  for (const param of params) {
    assert.match(param, /next\.set\('detail',/)
  }

  // And no element carries it in a tooltip, where it would sit in the DOM.
  assert.equal(
    /title=\{lab/.test(page),
    false,
    'the submitted text must not be placed in a title attribute',
  )

  // A clear affordance drops the text and everything derived from it.
  assert.match(page, /function clearTest\(\) \{/)
  for (const cleared of [
    "setLabTranscript('')",
    'setLabResult(null)',
    'runTest.reset()',
  ]) {
    assert.ok(page.includes(cleared), `clearTest must run ${cleared}`)
  }
})

/**
 * Slices the rule test lab's mutation, from its declaration to the clear
 * helper that follows it. Everything the lab sends is built inside this block.
 */
function labMutation(page: string): string {
  const start = page.indexOf('const runTest = useMutation({')
  const end = page.indexOf('function clearTest()')
  assert.ok(start >= 0 && end > start, 'the lab mutation must be found')
  return page.slice(start, end)
}

test('an unreadable lab duration is refused, never sent as "unknown"', async () => {
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))

  // The defect this test exists for: `Number('abc')` is NaN, `JSON.stringify`
  // writes NaN as `null`, and `null` is what a deliberately blank field means.
  // A bare conversion of the raw input would make the two indistinguishable and
  // silently test a context the administrator did not ask for.
  assert.equal(
    /Number\(\s*labDuration\s*\)/.test(page),
    false,
    'the raw duration input must never be converted directly',
  )

  // In any spelling: no lab state may be handed to `Number` at all. The one
  // conversion that exists runs on text already proven to be digits, and its
  // result is re-checked as a finite integer in range.
  const converted = [
    ...page.matchAll(/\bNumber\(\s*([A-Za-z_$][\w$.]*)/g),
  ].map((match) => match[1] as string)
  assert.ok(converted.length > 0, 'the duration parser must be found')
  for (const argument of converted) {
    assert.equal(
      /^lab/.test(argument),
      false,
      `Number(${argument}) converts an unvalidated lab input`,
    )
  }
  assert.match(page, /function readLabDuration\(value: string\): LabDuration/)
  assert.match(page, /const DURATION_DIGITS = \/\^\\d\{1,\d+\}\$\//)
  assert.match(page, /!Number\.isSafeInteger\(seconds\)/)
  assert.match(page, /seconds > MAX_DURATION_SECONDS/)

  // Blank stays a first-class answer, and is the ONLY input that yields null.
  assert.match(page, /if \(!text\) return \{ ok: true, seconds: null \}/)

  // The parser returns a discriminated result, so a rejected value has no
  // numeric field at all for a request body to read by mistake.
  assert.match(
    page,
    /type LabDuration =\s*\|\s*\{ ok: true; seconds: number \| null \}\s*\|\s*\{ ok: false; message: string \}/,
  )

  // The body is built from the parsed value, and the mutation re-checks rather
  // than trusting the disabled button.
  const mutation = labMutation(page)
  assert.match(mutation, /const duration = readLabDuration\(labDuration\)/)
  assert.match(mutation, /if \(!duration\.ok\) throw new Error\(duration\.message\)/)
  assert.match(mutation, /durationSeconds: duration\.seconds,/)
  assert.equal(
    /labDuration/.test(mutation.slice(mutation.indexOf('postJson'))),
    false,
    'the request body must not read the raw duration input',
  )
})

test('an invalid duration blocks the lab and says so on the field', async () => {
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))

  // One derived error drives the field, the run button, and the hint, so the
  // three cannot disagree about whether the form is submittable.
  assert.match(page, /const labDurationError = useMemo\(/)
  assert.match(page, /return parsed\.ok \? null : parsed\.message/)

  const blocked = page.slice(
    page.indexOf('const labBlocked ='),
    page.indexOf('function submit('),
  )
  assert.ok(blocked.length > 0, 'the lab blocking rule must be found')
  assert.match(
    blocked,
    /labDurationError !== null/,
    'an invalid duration must block the test run',
  )

  // Run test is disabled by that same rule.
  assert.match(
    page,
    /type="submit"\s*className="primary-action"\s*disabled=\{labBlocked\}/,
  )

  // And the reason is written on the field itself, not left to a tooltip or to
  // a rejection that only arrives after a request.
  assert.match(page, /aria-invalid=\{labDurationError !== null\}/)
  assert.match(page, /\{labDurationError \?\? 'Whole seconds\. Blank means unknown\.'\}/)
  assert.match(page, /Fix the duration above to enable the test/)
})

test('nothing claims the submitted text is cleared unless the code clears it', async () => {
  // Comments included: a stale comment about where evidence goes is exactly
  // what this guard is for, so the scan must be able to see them.
  const page = await webSource('pages/CallAuditSettingsPage.tsx')

  // The submitted text survives a successful test — only the explicit Clear
  // action or unmounting drops it.
  const mutation = labMutation(page)
  const clearsOnSuccess = /onSuccess[\s\S]*setLabTranscript\(''\)/.test(mutation)
  assert.equal(
    clearsOnSuccess,
    false,
    'if the lab starts clearing on success, update the claims below with it',
  )

  // So no comment or copy may promise otherwise. Each phrase below asserted a
  // lifetime the code does not implement.
  for (const claim of [
    /sent once, and cleared/,
    /for the length of one POST/,
    /held in\s+memory for one model call/i,
    /Held in this form\s+only, for one request/i,
  ]) {
    assert.equal(
      claim.test(page),
      false,
      'the page must not claim the submitted text is cleared automatically',
    )
  }

  // What it says instead is the boundary that is actually enforced: where the
  // value may travel, and what does clear it.
  assert.match(page, /It is NOT cleared on success/)
  assert.match(page, /"Clear transcript and result" is used or the screen unmounts/)
  // JSX wraps prose across lines, so the copy is matched loosely on whitespace.
  assert.match(
    page,
    /stays in\s+this form until you clear it or leave the screen/,
  )
  assert.match(page, /Held in this form\s+only, until you clear it or leave\./)
})

test('the test readout can only render the sanitized server result', async () => {
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))
  const start = page.indexOf('function RuleTestReadout(')
  const end = page.indexOf('export function CallAuditSettingsPage(')
  assert.ok(start >= 0 && end > start, 'the readout component must be found')
  const readout = page.slice(start, end)

  // One prop, and it is the server's sanitized DTO. The submitted text is not
  // merely unrendered here — it is out of scope, so it cannot be rendered.
  assert.match(readout, /\{ result \}: \{ result: CallAuditRuleTestResult \}/)
  assert.equal(
    /\blab(?:Transcript|Language|Duration|Version|Result)\b/.test(readout),
    false,
    'no page state may be read inside the readout',
  )

  // The coded and countable fields it does show.
  for (const field of [
    'metadata.transcriptCharacterCount',
    'metadata.transcriptLineCount',
    'output.groupedOutcome',
    'output.qualification',
    'output.nextAction',
    'output.confidence',
    'output.overallScore',
    'output.metricScores',
    'output.issueFlags',
    'feedbackLengths',
    'failure.errorCode',
    'usage.inputTokens',
    'usage.totalTokens',
  ]) {
    assert.ok(readout.includes(field), `the readout must show ${field}`)
  }

  // The three narrative fields exist only as lengths, everywhere on the page.
  for (const prose of [
    /\bmanagementSummary\b/,
    /\bkserveFeedback\b/,
    /\bimprovementFeedback\b/,
  ]) {
    assert.equal(
      prose.test(page),
      false,
      'model prose must reach the page only as a character count',
    )
  }
  for (const length of [
    'managementSummaryCharacterCount',
    'kserveFeedbackCharacterCount',
    'improvementFeedbackCharacterCount',
  ]) {
    assert.ok(readout.includes(length), `${length} is the only permitted form`)
  }

  // A failure states its bounded code and says the prose is deliberately gone.
  assert.match(readout, /No provider message is available here, by design/)
})

test('the test lab states its empty and unavailable cases', async () => {
  const page = await webSource('pages/CallAuditSettingsPage.tsx')
  // Nothing run yet, and no version to run against.
  assert.match(page, /No test has been run on this screen/)
  assert.match(page, /No rule version exists yet, so there is nothing to test/)
  assert.match(page, /Paste or type text above to enable the test/)

  // A 503 reads as "not configured", never as an audit that happened. The
  // wording comes from ApiError, so the server owns the sentence.
  assert.match(page, /runTest\.error instanceof ApiError &&\s*runTest\.error\.status === 503/)
  assert.match(page, /Nothing was sent to a model and nothing was audited/)
  assert.ok(page.includes('{runTest.error.message}'))
})

test('the test lab carries its own responsive rules and no nested card', async () => {
  const styles = await webSource('styles.css')
  assert.match(styles, /\.cas-lab-form \{/)
  assert.match(styles, /\.cas-lab-result \{/)

  // The dense input row collapses at both narrow breakpoints.
  for (const width of ['1050px', '760px']) {
    const block = styles.slice(styles.indexOf(`@media (max-width: ${width})`))
    assert.ok(
      block.includes('.cas-lab-form { grid-template-columns'),
      `the lab form needs an override at ${width}`,
    )
  }

  // The readout is one flat panel: the blocks inside it carry no border or
  // background of their own, so nothing reads as a card within a card.
  const block = styles.slice(
    styles.indexOf('.cas-lab-block {'),
    styles.indexOf('.cas-lab-block h3 {'),
  )
  assert.ok(block.length > 0, 'the readout block rule must be found')
  assert.equal(/border|background/.test(block), false)

  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))
  assert.equal(
    /className="cas-card[^"]*"[\s\S]{0,400}className="cas-lab/.test(page),
    false,
    'the test lab must not be nested inside a version card',
  )
})

/**
 * The declared navigation groups, keyed by group id. Slicing the source is
 * blunt, but it is the only way to assert structure in a project with no
 * browser test runner, and structure is exactly what is at stake here.
 */
function navigationGroups(shell: string): Map<string, string> {
  const start = shell.indexOf('const NAVIGATION_GROUPS')
  assert.ok(start >= 0, 'the shell must declare NAVIGATION_GROUPS')
  // The predicate below the list bounds the block, so JSX ids never leak in.
  const block = shell.slice(
    start,
    shell.indexOf('function billMonthAppliesToPath'),
  )
  const marks = [...block.matchAll(/id: '([a-z-]+)'/g)]
  assert.ok(marks.length >= 2, 'navigation must be grouped, not a flat list')
  return new Map(
    marks.map((mark, index) => [
      mark[1] as string,
      block.slice(mark.index, marks[index + 1]?.index ?? block.length),
    ]),
  )
}

test('Call Audit navigation is a group of its own, separate from Billing Audit', async () => {
  const shell = renderable(await webSource('components/AppShell.tsx'))
  const groups = navigationGroups(shell)
  const billing = groups.get('billing-audit')
  const callAudit = groups.get('call-audit')
  assert.ok(billing, 'Billing Audit needs its own navigation group')
  assert.ok(callAudit, 'Call Audit needs its own navigation group')

  // Each group is visibly labelled as the system it belongs to.
  assert.match(billing, /label: 'Billing Audit'/)
  assert.match(callAudit, /label: 'Call Audit'/)

  // The modules do not bleed into each other's section. A Call Audit link in
  // the Billing group is the flat-list regression this test exists to stop.
  assert.equal(billing.includes('/call-audit'), false)
  for (const route of ['/billing', '/reports', '/operations', '/evidence']) {
    assert.ok(billing.includes(route), `${route} belongs to Billing Audit`)
    assert.equal(
      callAudit.includes(route),
      false,
      `${route} must not appear in the Call Audit group`,
    )
  }
  // Billing Audit keeps its own admin destinations rather than a shared block.
  for (const route of ['/imports/new', '/audits']) {
    assert.ok(billing.includes(route), `${route} belongs to Billing Audit`)
  }

  // And the groups are rendered as labelled sections, not concatenated away.
  assert.match(shell, /NAVIGATION_GROUPS\.map\(\(group\) =>/)
  assert.match(shell, /className="nav-group"/)
  assert.match(shell, /aria-labelledby=\{`nav-group-\$\{group\.id\}`\}/)
  assert.match(shell, /className="nav-group-label"/)

  const styles = await webSource('styles.css')
  // A rule between the blocks is what makes the separation visible.
  assert.match(styles, /\.nav-group \+ \.nav-group \{[^}]*border-top/)
  assert.match(styles, /\.nav-group-label \{/)
})

test('the settings page is routed and reachable only from admin navigation', async () => {
  const app = await webSource('App.tsx')
  assert.match(app, /path="call-audit\/settings"/)
  assert.match(app, /CallAuditSettingsPage/)

  const shell = renderable(await webSource('components/AppShell.tsx'))
  const callAudit = navigationGroups(shell).get('call-audit')
  assert.ok(callAudit, 'Call Audit needs its own navigation group')

  // Rule administration carries prompts and model settings: admin-flagged, and
  // the flag is what the render filter drops for everyone else.
  const settings = callAudit.slice(
    callAudit.indexOf(`to: '${CALL_AUDIT_SETTINGS_PAGE_ROUTE}'`),
  )
  assert.ok(settings.length > 0, 'the settings nav item must be found')
  assert.match(settings, /admin: true/)

  // Sanitized reporting stays visible to every logged-in user.
  const report = callAudit.slice(
    callAudit.indexOf("{ to: '/call-audit',"),
    callAudit.indexOf(`to: '${CALL_AUDIT_SETTINGS_PAGE_ROUTE}'`),
  )
  assert.ok(report.length > 0, 'the report nav item must be found')
  assert.equal(report.includes('admin'), false)
  // Without `end`, the report link would match the settings child route and
  // both nav items would read as active at once.
  assert.match(report, /end: true/)

  // Admin items are filtered out of the render, never merely styled away.
  assert.match(shell, /group\.items\.filter\(\s*\(item\) => !item\.admin \|\| isAdmin,?\s*\)/)
  assert.match(shell, /const isAdmin = profile\?\.roles\.includes\('admin'\) === true/)
})

test('no bill month is stamped onto Call Audit routes', async () => {
  const shell = renderable(await webSource('components/AppShell.tsx'))
  // One predicate drives the topbar control, the URL defaulting effect, and
  // the nav links, so the chrome and the address bar cannot disagree.
  assert.match(
    shell,
    /function billMonthAppliesToPath\(pathname: string\): boolean/,
  )
  assert.match(shell, /return !pathname\.startsWith\('\/call-audit'\)/)
  assert.match(shell, /if \(!billMonthAppliesToPath\(pathname\)\) return target/)
  assert.match(shell, /monthIsAvailable \|\| !billMonthInScope/)

  // And the page itself never reads or renders a bill month.
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))
  for (const pattern of [/\bmonth\b/i, /billingPeriod/i]) {
    assert.equal(
      pattern.test(page),
      false,
      'Billing Audit month semantics must not reach this page',
    )
  }
})

test('the bill month predicate cannot be shadowed by the state it derives', async () => {
  const shell = renderable(await webSource('components/AppShell.tsx'))
  const declared = shell.match(/function (\w+)\(pathname: string\): boolean/)
  assert.ok(declared, 'the shell must declare one path predicate')
  const helper = declared[1] as string

  // `const billMonthApplies = billMonthApplies(path)` type-checks and then
  // throws `Cannot access '...' before initialization` at runtime: the const
  // shadows the hoisted function inside its own initializer. TypeScript will
  // not catch it, so the guard is that no binding reuses the helper's name.
  const bound = [
    ...shell.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g),
  ].map((match) => match[1])
  assert.equal(
    bound.includes(helper),
    false,
    `${helper} must not also be bound as a variable`,
  )

  // The derived per-render answer has a distinct name of its own...
  const derived = shell.match(
    /const (\w+) = (\w+)\(location\.pathname\)/,
  )
  assert.ok(derived, 'the shell must derive the current-path answer once')
  assert.equal(derived[2], helper, 'the derivation must call the helper')
  assert.notEqual(
    derived[1],
    helper,
    'the derived const must not reuse the helper name',
  )

  // ...and the link builder calls the helper, not that per-render const, since
  // it answers for an arbitrary target path rather than the current one.
  const routePath = shell.slice(
    shell.indexOf('const withMonth = (target: string): string =>'),
    shell.indexOf('routePath: withMonth'),
  )
  assert.ok(routePath.length > 0, 'the link builder must be found')
  assert.ok(
    routePath.includes(`${helper}(pathname)`),
    'the link builder must call the helper on the target path',
  )
  assert.equal(
    routePath.includes(derived[1] as string),
    false,
    'the link builder must not read the current-path const',
  )
})

test('the settings UI hard-codes no evidence, identity, or money field', async () => {
  const page = renderable(await webSource('pages/CallAuditSettingsPage.tsx'))
  const api = await webSource('lib/api.ts')
  // Only the settings block of the shared API types: the Billing and import
  // types in the same file legitimately name money.
  const settingsTypes = renderable(
    api.slice(
      api.indexOf('export interface CallAuditRuleVersion {'),
      api.indexOf('export async function postFile'),
    ),
  )
  assert.ok(settingsTypes.length > 0, 'the settings type block must be found')

  for (const [reason, pattern] of FORBIDDEN_SETTINGS_PATTERNS) {
    assert.equal(pattern.test(page), false, `the page must not reference ${reason}`)
    assert.equal(
      pattern.test(settingsTypes),
      false,
      `the settings DTOs must not reference ${reason}`,
    )
  }

  // The prompt is reachable, and is labelled as configuration everywhere it is.
  assert.ok(page.includes('businessPrompt'))
  assert.match(page, /administrator configuration, not call evidence/i)
  assert.match(page, /Administrator configuration, not call evidence/)
  assert.ok(page.includes(CALL_AUDIT_SETTINGS_TITLE))
})

test('every settings surface states its empty case', async () => {
  const page = await webSource('pages/CallAuditSettingsPage.tsx')
  // No active version, no versions, no runs, and no prompt selected — the last
  // of which is a panel that is always rendered rather than simply absent.
  assert.match(page, /Nothing is auditing yet/)
  assert.match(page, /No rule version has been created yet/)
  assert.match(page, /No audit run has been recorded yet/)
  assert.match(page, /No version selected/)
  assert.match(page, /That rule version is not in this list/)
  // A failed refresh over already-loaded data is stated, never silent.
  assert.match(page, /the last refresh\s*\n?\s*failed/)
})

test('the settings page carries responsive rules for its dense surfaces', async () => {
  const styles = await webSource('styles.css')
  assert.match(styles, /\.casettings \{/)

  // Twelve columns cannot fit a laptop: the table must scroll inside its own
  // box, or the widest row drags the whole document sideways.
  assert.match(
    styles,
    /\.casettings \.cas-history \.table-scroll \{[^}]*overflow-x: auto/,
  )
  assert.match(styles, /\.casettings \.cas-history table \{[^}]*table-layout: fixed/)

  // Unbounded identifiers truncate in place instead of wrapping a column down
  // to one word per line.
  assert.match(styles, /\.cas-trunc \{[^}]*text-overflow: ellipsis/)
  assert.match(styles, /\.cas-reason \{[^}]*-webkit-line-clamp: 3/)

  // The confirmation swap must not move the control under the pointer.
  assert.match(styles, /\.cas-activate \{[^}]*min-width:/)
  assert.match(styles, /\.cas-cancel \{ visibility: hidden; \}/)

  // Each dense grid collapses at both breakpoints.
  for (const selector of ['.cas-form', '.cas-facts']) {
    assert.ok(
      styles.split(`${selector} `).length > 2,
      `${selector} needs a responsive override`,
    )
  }
  for (const width of ['760px', '500px']) {
    const block = styles.slice(styles.indexOf(`@media (max-width: ${width})`))
    assert.ok(
      block.includes('.cas-'),
      `the ${width} breakpoint must adjust a settings surface`,
    )
  }
})

test('the call audit test script still covers the settings modules', async () => {
  const manifest = JSON.parse(
    await readFile(path.join(REPO_ROOT, 'package.json'), 'utf8'),
  ) as { scripts: Record<string, string> }
  const script = manifest.scripts['test:callaudit']
  for (const file of [
    'src/adapters/mysqlCallAuditSettings.test.ts',
    'src/http/enterpriseDashboardServer.callAuditSettings.test.ts',
    'src/reporting/callAuditSettingsWebContract.test.ts',
  ]) {
    assert.ok(script.includes(file), `${file} must run under test:callaudit`)
  }
})
