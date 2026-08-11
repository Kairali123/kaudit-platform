import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Static contract for the Call Audit rule TEST LAB wiring in the secure
 * dashboard startup.
 *
 * It is static because startup cannot be imported: it builds a connection pool
 * at module scope, so importing it from a test would open a socket. What matters
 * is a decision made once at startup, and this pins that decision's shape.
 *
 * The decision now lives in the shared runtime factory rather than in
 * `run-secure-dashboard.ts`, because the persistent server is no longer the only
 * startup — a Vercel Function boots the same application. One factory is what
 * keeps them from drifting: a second copy of this gate is a second chance to get
 * it wrong, and the copy nobody reviewed is the one that ships armed.
 *
 * The invariant under guard is deny-by-default with TWO independent conditions.
 * `OPENAI_API_KEY` is already set in deployments for unrelated import analysis,
 * so if the key alone armed this, every such deployment would silently gain a
 * paid content-model endpoint nobody opted into. The dedicated flag is the
 * consent; the key is only the means.
 *
 * The second invariant is WHERE the decision lives. Startup owns dependency
 * construction, so the endpoint stays a pure function of its injected
 * dependencies and keeps its unavailable-before-reading-the-body behaviour.
 * The last tests here fail if that logic ever migrates into the server module,
 * or is duplicated into an entry point.
 */

const CLI_SOURCE = readFileSync(
  new URL('../runtime/dashboardRuntime.ts', import.meta.url),
  'utf8',
)
const ENTRY_SOURCES = [
  '../cli/run-secure-dashboard.ts',
  '../vercel/dashboardFunction.ts',
  '../../api/index.ts',
].map((relative) => readFileSync(new URL(relative, import.meta.url), 'utf8'))
const SERVER_SOURCE = readFileSync(
  new URL('../http/enterpriseDashboardServer.ts', import.meta.url),
  'utf8',
)
const ENV_EXAMPLE = readFileSync(
  new URL('../../.env.example', import.meta.url),
  'utf8',
)

/** Comments explain the rule; only executable text can enforce it. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CLI_CODE = code(CLI_SOURCE)

/**
 * Extracts one `const` declaration inside the factory: the rest of its line plus
 * every more-deeply-indented continuation line beneath it.
 */
function declaration(name: string): string {
  const match = CLI_CODE.match(
    new RegExp(
      `^  const ${name} =((?:[^\\n]*\\n)(?:[ \\t]{3,}[^\\n]*\\n)*)`,
      'm',
    ),
  )
  assert.ok(match, `dashboardRuntime.ts must declare ${name}`)
  return match[1] as string
}

/** The object literal handed to the server factory. */
function serverDependencies(): string {
  const match = CLI_CODE.match(
    /createEnterpriseDashboardServer\(\{([\s\S]*?)\n\s*\}\)/,
  )
  assert.ok(
    match,
    'dashboardRuntime.ts must call createEnterpriseDashboardServer',
  )
  return match[1] as string
}

// ---------------------------------------------------------------------------
// The wiring exists
// ---------------------------------------------------------------------------

test('the startup imports the OpenAI-backed Call Audit model factory', () => {
  assert.match(
    CLI_CODE,
    /import \{ createOpenAiCallAuditModel \} from '\.\.\/adapters\/openaiCallAuditClient\.ts'/,
  )
})

test('every entry point reaches this gate through the shared factory', () => {
  for (const source of ENTRY_SOURCES) {
    const entry = code(source)
    assert.equal(
      /createOpenAiCallAuditModel/.test(entry),
      false,
      'an entry point that builds its own model has its own gate to get wrong',
    )
    assert.equal(
      /KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED/.test(entry),
      false,
    )
    assert.equal(/OPENAI_API_KEY/.test(entry), false)
  }
  // Both startups build their dependencies here and differ only in the two
  // documented options.
  for (const source of ENTRY_SOURCES.slice(0, 2)) {
    assert.match(code(source), /createDashboardRuntime/)
  }
})

test('the server factory receives callAuditRuleTestModel', () => {
  assert.match(serverDependencies(), /^\s*callAuditRuleTestModel,?\s*$/m)
})

test('the model is built by the factory, at exactly one call site', () => {
  const callSites = [...CLI_CODE.matchAll(/createOpenAiCallAuditModel\(/g)]
  assert.equal(callSites.length, 1)
})

// ---------------------------------------------------------------------------
// The flag is the consent, and it is deny-by-default
// ---------------------------------------------------------------------------

test('the flag is read from KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED and compared to "true"', () => {
  const enabled = declaration('callAuditRuleTestEnabled')
  assert.match(enabled, /\benv\.KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED/)
  assert.match(enabled, /\?\.trim\(\)/)
  assert.match(enabled, /\.toLowerCase\(\)/)
  // An explicit positive equality: an absent, blank, or any other value is
  // false, so the endpoint stays unavailable unless someone opted in by name.
  assert.match(enabled, /===\s*'true'/)
  assert.equal(/!==/.test(enabled), false)
})

test('the API key is trimmed and required nonblank', () => {
  const key = declaration('callAuditRuleTestApiKey')
  assert.match(key, /\benv\.OPENAI_API_KEY\?\.trim\(\)/)
  // A blank key falls back to a falsy value rather than reaching the factory
  // as whitespace.
  assert.match(key, /\|\|\s*''/)
})

test('the model expression requires BOTH the flag and the key', () => {
  const model = declaration('callAuditRuleTestModel')
  assert.match(
    model,
    /callAuditRuleTestEnabled\s*&&\s*callAuditRuleTestApiKey/,
  )
  assert.match(model, /\?\s*createOpenAiCallAuditModel\(callAuditRuleTestApiKey\)/)
  // The other branch leaves the dependency absent, which is what preserves the
  // endpoint's 503 before it reads a body or fetches a prompt.
  assert.match(model, /:\s*undefined/)
})

test('OPENAI_API_KEY alone does not enable the rule test lab', () => {
  const model = declaration('callAuditRuleTestModel')
  // No disjunction anywhere in the decision: the key can never substitute for
  // the flag, and neither condition has an escape hatch.
  assert.equal(/\|\|/.test(model), false)
  assert.equal(/\?\?/.test(model), false)
  // The factory call is reachable only through the conjunction above.
  const guard = model.slice(0, model.indexOf('createOpenAiCallAuditModel'))
  assert.match(guard, /callAuditRuleTestEnabled/)
  assert.match(guard, /callAuditRuleTestApiKey/)
})

test('the flag alone does not enable it either', () => {
  const model = declaration('callAuditRuleTestModel')
  const guard = model.slice(0, model.indexOf('createOpenAiCallAuditModel'))
  // Both operands sit in the same conjunction, so dropping either one leaves
  // the dependency undefined.
  assert.match(
    guard.replace(/\s+/g, ' '),
    /callAuditRuleTestEnabled && callAuditRuleTestApiKey \?/,
  )
})

// ---------------------------------------------------------------------------
// Startup owns the decision; the endpoint does not
// ---------------------------------------------------------------------------

test('the server module reads neither the flag nor the key', () => {
  assert.equal(
    /KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED/.test(SERVER_SOURCE),
    false,
    'the rule test flag must be read at startup, not inside the server',
  )
  assert.equal(
    /OPENAI_API_KEY/.test(SERVER_SOURCE),
    false,
    'the server must not reach for a provider credential',
  )
})

test('the server module constructs no provider client of its own', () => {
  assert.equal(/createOpenAiCallAuditModel/.test(SERVER_SOURCE), false)
  assert.equal(/from 'openai'/.test(SERVER_SOURCE), false)
})

// ---------------------------------------------------------------------------
// The opt-in is documented and off by default
// ---------------------------------------------------------------------------

test('.env.example documents the flag and defaults it to false', () => {
  assert.match(ENV_EXAMPLE, /^KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED=false$/m)
  const settings = [
    ...ENV_EXAMPLE.matchAll(/^KAUDIT_CALL_AUDIT_RULE_TEST_ENABLED=(.*)$/gm),
  ]
  assert.equal(settings.length, 1)
})

// ---------------------------------------------------------------------------
// Scope: this wiring stays narrow
// ---------------------------------------------------------------------------

test('the startup adds no Call Audit worker, schedule, or test-run persistence', () => {
  const model = declaration('callAuditRuleTestModel')
  for (const forbidden of [
    /setInterval/,
    /setTimeout/,
    /cron/i,
    /worker/i,
    /\bpool\b/,
    /insert/i,
  ]) {
    assert.equal(
      forbidden.test(model),
      false,
      `the rule test wiring must not involve ${forbidden}`,
    )
  }
})
