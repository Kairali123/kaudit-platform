import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  OIDC_BIND_ENV,
  OIDC_BIND_EXECUTE_MODE,
} from '../identity/oidcBinding.ts'

/**
 * Static contract for the one-shot OIDC binding CLI.
 *
 * It is static for the reason the other entry-point contracts are: this module
 * opens a connection pool and runs at import time, so importing it from a test
 * would reach a database. What matters about an entry point is the ORDER and the
 * SHAPE of the decisions it makes once, and both are readable from the source.
 * The behaviour it delegates to is tested for real in `identity/oidcBinding.test.ts`
 * and `adapters/mysqlOidcBinding.test.ts`, against no database at all.
 *
 * Six invariants are under guard:
 *
 *   1. dry-run is the default and only the exact word EXECUTE writes;
 *   2. inputs are explicit, named, and validated before a pool exists;
 *   3. the supplied issuer must equal the configured one, byte for byte, and
 *      that check also happens before a pool exists;
 *   4. TLS comes from the accepted resolver, so production cannot fall back to
 *      plaintext and no CA content is ever read here;
 *   5. the connection is released and the pool closed on every path;
 *   6. nothing printed can carry a supplied value, and no thrown value is read.
 */

const CLI_URL = new URL('./run-oidc-bind.ts', import.meta.url)
const CLI_SOURCE = readFileSync(CLI_URL, 'utf8')
const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }
const ENV_EXAMPLE = readFileSync(
  new URL('../../.env.example', import.meta.url),
  'utf8',
)
const RUNBOOK = readFileSync(
  new URL('../../docs/runbooks/ADMIN_ACCESS.md', import.meta.url),
  'utf8',
)
const GITIGNORE = readFileSync(
  new URL('../../.gitignore', import.meta.url),
  'utf8',
)

/**
 * The binding section of the runbook, on its own.
 *
 * The assertions below are about what THIS command tells an operator to do; the
 * grant workflow above it in the same file is a separate, accepted procedure and
 * is not under guard here.
 */
const BINDING_RUNBOOK = (() => {
  const start = RUNBOOK.indexOf('## Bind an administrator')
  assert.notEqual(start, -1, 'the runbook must document the binding command')
  const end = RUNBOOK.indexOf('\n## ', start + 1)
  return RUNBOOK.slice(start, end === -1 ? RUNBOOK.length : end)
})()

/** Every fenced shell block in the binding section. */
const BINDING_SHELL_BLOCKS = [
  ...BINDING_RUNBOOK.matchAll(/```(?:bash|sh|shell|console)\n([\s\S]*?)```/g),
].map((match) => match[1])

/** Comments explain the rules; only executable text can enforce them. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const CLI_CODE = code(CLI_SOURCE)

/** The body of a named function declaration, by brace matching. */
function functionBody(name: string): string {
  const start = CLI_CODE.indexOf(`function ${name}(`)
  assert.notEqual(start, -1, `run-oidc-bind.ts must declare ${name}`)
  const open = CLI_CODE.indexOf('{', start)
  let depth = 0
  for (let index = open; index < CLI_CODE.length; index += 1) {
    const character = CLI_CODE[index]
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return CLI_CODE.slice(open, index + 1)
    }
  }
  assert.fail(`${name} is unbalanced`)
}

const MAIN = functionBody('main')

function positionInMain(needle: string): number {
  const at = MAIN.indexOf(needle)
  assert.notEqual(at, -1, `main must contain ${needle}`)
  return at
}

// ---------------------------------------------------------------------------
// 1. The execute gate
// ---------------------------------------------------------------------------

test('the mode is compared byte-exactly to EXECUTE, with no trim or case folding', () => {
  assert.match(
    MAIN,
    /const execute = process\.env\[OIDC_BIND_ENV\.mode\] === OIDC_BIND_EXECUTE_MODE/,
  )
  // The text between the environment read and the constant is the comparison
  // and nothing else: a `?.trim()` or a `??` reintroduced here would arm a write
  // on ` EXECUTE `, and would lengthen this span.
  const read = MAIN.indexOf('process.env[OIDC_BIND_ENV.mode]')
  const constant = MAIN.indexOf('OIDC_BIND_EXECUTE_MODE', read)
  assert.equal(
    MAIN.slice(read, constant + 'OIDC_BIND_EXECUTE_MODE'.length),
    'process.env[OIDC_BIND_ENV.mode] === OIDC_BIND_EXECUTE_MODE',
  )
  assert.equal([...CLI_CODE.matchAll(/OIDC_BIND_ENV\.mode/g)].length, 1)
  assert.equal(/OIDC_BIND_ENV\.mode[^\n]*trim/.test(CLI_CODE), false)
  assert.equal(/toLowerCase|toUpperCase/.test(CLI_CODE), false)
})

test('the gate word is never restated as a literal in the entry point', () => {
  // One definition, imported. A second copy is how the two drift apart.
  assert.equal(CLI_CODE.includes(`'${OIDC_BIND_EXECUTE_MODE}'`), false)
  assert.match(
    CLI_CODE,
    /import \{[\s\S]*?OIDC_BIND_EXECUTE_MODE,?[\s\S]*?\} from '\.\.\/identity\/oidcBinding\.ts'/,
  )
})

test('execute reaches the transaction as an explicit, defaulted-off flag', () => {
  assert.match(MAIN, /\{ execute \}/)
  // Nothing else in the file can turn writing on.
  assert.equal([...CLI_CODE.matchAll(/execute/g)].length >= 2, true)
  assert.equal(/execute\s*=\s*true/.test(CLI_CODE), false)
})

// ---------------------------------------------------------------------------
// 2. Named, explicit, validated inputs
// ---------------------------------------------------------------------------

test('the three operator values are named environment variables', () => {
  for (const name of [
    'KAUDIT_OIDC_BIND_MODE',
    'KAUDIT_OIDC_BIND_EMAIL',
    'KAUDIT_OIDC_BIND_ISSUER',
    'KAUDIT_OIDC_BIND_SUBJECT',
  ]) {
    assert.ok(
      Object.values(OIDC_BIND_ENV).includes(name as never),
      `${name} must be one of the declared inputs`,
    )
  }
  for (const field of ['email', 'issuer', 'subject'] as const) {
    assert.match(
      MAIN,
      new RegExp(`${field}: process\\.env\\[OIDC_BIND_ENV\\.${field}\\]`),
      `${field} must be read from its own named variable`,
    )
  }
})

test('the subject is read, never derived from the email', () => {
  // No transformation of any kind between the email and the subject.
  assert.equal(/subject[^\n]*email|email[^\n]*subject/.test(MAIN), false)
  assert.equal(/split\('@'\)|indexOf\('@'\)|replace\(/.test(CLI_CODE), false)
})

test('validation happens before a pool, a connection, or a transaction exists', () => {
  const validated = positionInMain('normalizeOidcBinding(')
  for (const later of [
    'loadRuntimeConfig(',
    'resolveDatabaseTls(',
    'mysql.createPool(',
    'pool.getConnection(',
    'bindOidcIdentity(',
  ]) {
    assert.ok(
      validated < positionInMain(later),
      `input validation must precede ${later}`,
    )
  }
})

test('the CLI restates no validation rule of its own', () => {
  // The policy lives in `identity/oidcBinding.ts`; a second copy here would be a
  // second policy.
  assert.equal(/kairali/i.test(CLI_CODE), false)
  assert.equal(/https:/.test(CLI_CODE.replace(/from '[^']*'/g, '')), false)
  assert.equal([...CLI_CODE.matchAll(/normalizeOidcBinding\(/g)].length, 1)
})

// ---------------------------------------------------------------------------
// 3. The supplied issuer must be this deployment's issuer
// ---------------------------------------------------------------------------

test('the run must be OIDC-configured and the issuers must match exactly', () => {
  assert.match(MAIN, /config\.auth\.mode !== 'oidc'/)
  assert.match(MAIN, /config\.auth\.issuer !== request\.issuer/)
  // One condition, one outcome: either fault stops the command the same way.
  assert.match(
    MAIN,
    /if \(\s*config\.auth\.mode !== 'oidc' \|\| config\.auth\.issuer !== request\.issuer\s*\) \{\s*throw new OidcBindCliError\(BIND_CLI_ERROR_CODES\.issuerMismatch\)\s*\}/,
  )
})

test('the issuer check precedes the pool, the connection, and the transaction', () => {
  // It needs configuration, so it cannot be as early as input validation — but
  // it must still cost nothing more than reading configuration.
  const checked = positionInMain('config.auth.issuer !== request.issuer')
  assert.ok(positionInMain('loadRuntimeConfig(') < checked)
  for (const later of [
    'mysql.createPool(',
    'pool.getConnection(',
    'bindOidcIdentity(',
  ]) {
    assert.ok(
      checked < positionInMain(later),
      `the issuer check must precede ${later}`,
    )
  }
})

test('the comparison is byte-for-byte, on both sides', () => {
  // `!==` on the raw strings. Any normalization of either side — a trim, a case
  // fold, a URL round trip — would let a binding that login can never match pass
  // this gate.
  for (const forbidden of [
    /config\.auth\.issuer[^\n]*(trim|toLowerCase|toUpperCase|normalize|replace|startsWith|includes)/,
    /request\.issuer[^\n]*(trim|toLowerCase|toUpperCase|normalize|replace|startsWith|includes)/,
    /new URL\(/,
    /config\.auth\.issuer\s*==[^=]/,
  ]) {
    assert.equal(
      forbidden.test(CLI_CODE),
      false,
      `the issuer comparison must not involve ${forbidden}`,
    )
  }
})

test('the binding issuer is supplied, never derived from configuration', () => {
  // Keeping it explicit is the point: a request filled in from configuration
  // would agree with configuration by construction and prove nothing.
  assert.match(MAIN, /issuer: process\.env\[OIDC_BIND_ENV\.issuer\]/)
  for (const forbidden of [
    /issuer:\s*config\./,
    /config\.auth\.issuer\s*(\?\?|\|\|)/,
    /request\.issuer\s*=/,
    /issuer:\s*[^\n]*\?\?/,
  ]) {
    assert.equal(
      forbidden.test(CLI_CODE),
      false,
      `the binding issuer must not be derived: ${forbidden}`,
    )
  }
  assert.equal([...CLI_CODE.matchAll(/config\.auth\.issuer/g)].length, 1)
})

test('a mismatch stops with a fixed bounded code carrying no value', () => {
  assert.match(CLI_CODE, /issuerMismatch: 'OIDC_BIND_ISSUER_MISMATCH'/)
  // Every stop code is chosen from the table, never built from a value.
  const constructions = [...CLI_CODE.matchAll(/new OidcBindCliError\(([^)]*)\)/g)]
  assert.ok(constructions.length >= 3)
  for (const [, argument] of constructions) {
    assert.match(argument, /^BIND_CLI_ERROR_CODES\.[a-zA-Z]+$/)
  }
})

test('neither the configured nor the supplied issuer can reach any output', () => {
  const handler = CLI_CODE.slice(CLI_CODE.indexOf('(error: unknown) => {'))
  const outputs = {
    summary: functionBody('safeSummaryLine'),
    code: functionBody('safeFailureCode'),
    field: functionBody('safeFailureField'),
    handler,
  }
  for (const [name, region] of Object.entries(outputs)) {
    for (const forbidden of [/issuer/i, /config\./, /request\./, /process\.env/]) {
      assert.equal(
        forbidden.test(region),
        false,
        `${name} must not be able to carry ${forbidden}`,
      )
    }
  }
  // The failure path prints the code and, at most, an input NAME.
  assert.match(
    CLI_CODE,
    /`\[oidc-bind\] stopped \$\{safeFailureCode\(error\)\}\$\{[\s\S]*?field \? ` field=\$\{field\}` : ''/,
  )
})

// ---------------------------------------------------------------------------
// 4. Transport security
// ---------------------------------------------------------------------------

test('TLS comes from the accepted resolver, supporting both CA sources', () => {
  assert.match(
    CLI_CODE,
    /import \{ resolveDatabaseTls \} from '\.\.\/runtime\/databaseTls\.ts'/,
  )
  assert.match(MAIN, /ssl = resolveDatabaseTls\(config, process\.env\)/)
  assert.match(MAIN, /\bssl,/)
  // Production must not silently degrade: the resolver throws rather than
  // returning undefined, and this file adds no `?? undefined` around it.
  assert.equal(/resolveDatabaseTls\([^)]*\)\s*(\?\?|\|\|)/.test(CLI_CODE), false)
  // No CA is read, parsed, defaulted, or logged here.
  assert.equal(/readFileSync|DB_SSL_CA_PEM|DB_SSL_CA_FILE|BEGIN CERT/.test(CLI_CODE), false)
  assert.equal(/rejectUnauthorized/.test(CLI_CODE), false)
})

test('exactly one pool is created, from validated runtime configuration', () => {
  assert.equal([...CLI_CODE.matchAll(/mysql\.createPool\(/g)].length, 1)
  assert.match(
    CLI_CODE,
    /import \{ loadRuntimeConfig \} from '\.\.\/config\/runtime\.ts'/,
  )
  for (const field of ['host', 'port', 'database', 'user', 'password']) {
    assert.match(
      MAIN,
      new RegExp(`${field}: config\\.database\\.`),
      `${field} must come from runtime configuration`,
    )
  }
})

// ---------------------------------------------------------------------------
// 5. Resource cleanup
// ---------------------------------------------------------------------------

test('the connection is released and the pool closed on every path', () => {
  assert.match(MAIN, /\} finally \{[\s\S]{0,200}connection\.release\(\)/)
  assert.match(MAIN, /\} finally \{[\s\S]{0,120}await pool\.end\(\)/)
  // Release is nested inside the pool's finally, so the pool never waits on a
  // connection that is still checked out.
  assert.ok(positionInMain('connection.release()') < positionInMain('await pool.end()'))
  // A connection that was never acquired is never released.
  assert.match(MAIN, /connection = await pool\.getConnection\(\)/)
  assert.match(MAIN, /connectionUnavailable/)
})

test('the command is one shot: no loop, watch, schedule, server, or file write', () => {
  for (const forbidden of [
    /setInterval/,
    /setTimeout/,
    /cron/i,
    /\bwatch\b/i,
    /createServer/,
    /nodemailer|sendMail|smtp/i,
    /writeFile/,
    /\bfor \(|\bwhile \(/,
  ]) {
    assert.equal(
      forbidden.test(CLI_CODE),
      false,
      `a one-shot command must not involve ${forbidden}`,
    )
  }
  assert.equal([...CLI_CODE.matchAll(/bindOidcIdentity\(/g)].length, 1)
})

test('the CLI issues no SQL of its own and touches no source table', () => {
  assert.equal(/SELECT|INSERT|UPDATE|DELETE|ALTER/.test(CLI_CODE), false)
  assert.equal(/ai_voice_leads_received/.test(CLI_CODE), false)
  // And nothing about granting, tiers, billing, reports, or deployment. The
  // summary reports whether the account holds a role; it never changes one.
  for (const forbidden of [
    /kaudit_user_role/,
    /grant/i,
    /sensitivity|max_sensitivity|K3/,
    /billing|invoice|amount/i,
    /transcript|report/i,
    /vercel/i,
  ]) {
    assert.equal(
      forbidden.test(CLI_CODE),
      false,
      `binding must not involve ${forbidden}`,
    )
  }
})

// ---------------------------------------------------------------------------
// 6. Privacy of everything printed
// ---------------------------------------------------------------------------

test('the summary line is a fixed allowlist, not a spread', () => {
  const line = functionBody('safeSummaryLine')
  for (const field of [
    'command',
    'mode',
    'outcome',
    'refusalCode',
    'userFound',
    'userActive',
    'userHasRole',
    'bindingWritten',
    'auditMode',
  ]) {
    assert.ok(line.includes(`${field}:`), `${field} must be reported`)
  }
  assert.equal(/\.\.\./.test(line), false)
})

test('no supplied value and no database identifier can reach stdout', () => {
  const line = functionBody('safeSummaryLine')
  for (const forbidden of [
    /email/i,
    /issuer/i,
    /subject/i,
    /\buserId\b/i,
    /\bid\b/,
    /request\./,
    /process\.env/,
    /hash/i,
  ]) {
    assert.equal(
      forbidden.test(line),
      false,
      `the summary line must not carry ${forbidden}`,
    )
  }
  // One line, one writer.
  assert.equal([...CLI_CODE.matchAll(/process\.stdout\.write\(/g)].length, 1)
  assert.match(CLI_CODE, /process\.stdout\.write\(safeSummaryLine\(result\)\)/)
})

test('no thrown value is ever read, formatted, or logged', () => {
  const chooser = functionBody('safeFailureCode')
  assert.match(chooser, /instanceof OidcBindingInputError/)
  assert.match(chooser, /instanceof OidcBindingWriteError/)
  assert.match(chooser, /instanceof OidcBindCliError/)
  assert.match(chooser, /BIND_CLI_ERROR_CODES\.unexpected/)

  for (const forbidden of [
    /console\./,
    /String\(\s*error/,
    /error\.message/,
    /error\.stack/,
    /JSON\.stringify\(\s*error/,
    /util\.inspect/,
    /\$\{error/,
  ]) {
    assert.equal(forbidden.test(CLI_CODE), false, `the CLI must not do ${forbidden}`)
  }
})

test('every catch discards its value except the two that select a code', () => {
  // Exactly two bindings exist, both in the failure reporters, and both only
  // pass the value to `instanceof` checks.
  const bindings = [...CLI_CODE.matchAll(/catch\s*\(/g)]
  assert.equal(bindings.length, 0, 'no catch block may bind the thrown value')
  assert.ok([...CLI_CODE.matchAll(/\} catch \{/g)].length >= 2)
})

test('the failure line prints one bounded code and at most an input name', () => {
  const handler = CLI_CODE.slice(CLI_CODE.indexOf('(error: unknown) => {'))
  assert.match(handler, /safeFailureCode\(error\)/)
  assert.match(handler, /field=\$\{field\}/)
  assert.match(handler, /process\.exitCode = 1/)
  assert.equal([...CLI_CODE.matchAll(/process\.stderr\.write\(/g)].length, 1)
})

test('a refusal exits nonzero and an idempotent no-op does not', () => {
  assert.match(
    CLI_CODE,
    /process\.exitCode = result\.outcome === 'refused' \? 1 : 0/,
  )
})

test('the CLI error codes are bounded uppercase machine codes', () => {
  const table = CLI_CODE.slice(
    CLI_CODE.indexOf('const BIND_CLI_ERROR_CODES'),
    CLI_CODE.indexOf('} as const', CLI_CODE.indexOf('const BIND_CLI_ERROR_CODES')),
  )
  const codes = [...table.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.ok(codes.length >= 3)
  for (const value of codes) assert.match(value, /^[A-Z][A-Z0-9_]*$/)
})

// ---------------------------------------------------------------------------
// 7. It is runnable, documented, and tested
// ---------------------------------------------------------------------------

test('package.json exposes the one-shot script with the env-file flags', () => {
  const script = PACKAGE_JSON.scripts['w1:bind-oidc']
  assert.ok(script, 'package.json must define w1:bind-oidc')
  assert.match(script, /src\/cli\/run-oidc-bind\.ts$/)
  assert.match(script, /--env-file-if-exists=\.env\b/)
  assert.match(script, /--env-file-if-exists=\.env\.local\b/)
  // The gate is not baked into the script: arming a write is a deliberate act at
  // the command line, not something `npm run` decides.
  assert.equal(script.includes(OIDC_BIND_ENV.mode), false)
})

test('the script loads this repository ignored env files and nothing else', () => {
  const script = PACKAGE_JSON.scripts['w1:bind-oidc']
  // Exactly two sources, both repository-relative, in this order. A command that
  // binds a production identity must take its inputs from files this repository
  // owns and ignores — not from a path outside the checkout, whose contents no
  // review of this repository can see.
  const loaded = [...script.matchAll(/--env-file(?:-if-exists)?=(\S+)/g)].map(
    (match) => match[1],
  )
  assert.deepEqual(loaded, ['.env', '.env.local'])
  for (const file of loaded) {
    assert.ok(
      GITIGNORE.split('\n').includes(file),
      `${file} must be gitignored`,
    )
  }
})

test('the script names no path outside this repository', () => {
  const script = PACKAGE_JSON.scripts['w1:bind-oidc']
  for (const forbidden of [
    /\.kcrm-audit/,
    /kcrm/i,
    /Desktop/i,
    /\$HOME|\$\{HOME\}/,
    /~\//,
    /(^|[\s=])\//,
    /\.\.\//,
  ]) {
    assert.equal(
      forbidden.test(script),
      false,
      `w1:bind-oidc must not reference ${forbidden}`,
    )
  }
})

test('test:w1 runs the binding tests', () => {
  const script = PACKAGE_JSON.scripts['test:w1']
  assert.match(script, /src\/identity\/oidcBinding\.test\.ts/)
  assert.match(script, /src\/adapters\/mysqlOidcBinding\.test\.ts/)
  assert.match(script, /src\/cli\/runOidcBindCli\.test\.ts/)
})

test('the runbook documents the command and where a subject comes from', () => {
  assert.match(RUNBOOK, /w1:bind-oidc/)
  for (const name of Object.values(OIDC_BIND_ENV)) {
    assert.ok(RUNBOOK.includes(name), `the runbook must name ${name}`)
  }
  // The one thing an operator must not do.
  assert.match(RUNBOOK, /never be guessed|never guess/i)
  assert.match(RUNBOOK, /ID token/)
  // And no instruction that would put a token in a log or in the repository.
  assert.equal(/echo \$|cat .*token|console\.log/i.test(RUNBOOK), false)
})

test('the runbook still forbids pasting an ID token anywhere', () => {
  // Moving the three inputs into a file must not cost the warning about the
  // credential they were read from.
  assert.match(BINDING_RUNBOOK, /Do not paste/i)
  assert.match(BINDING_RUNBOOK, /credential/i)
  for (const place of ['shell command', 'log', 'ticket']) {
    assert.ok(
      BINDING_RUNBOOK.includes(place),
      `the token warning must still name a ${place}`,
    )
  }
})

test('no identity value is ever shown on a command line', () => {
  assert.ok(BINDING_SHELL_BLOCKS.length > 0)
  for (const block of BINDING_SHELL_BLOCKS) {
    for (const name of [
      OIDC_BIND_ENV.email,
      OIDC_BIND_ENV.issuer,
      OIDC_BIND_ENV.subject,
    ]) {
      assert.equal(
        block.includes(name),
        false,
        `${name} must not appear in a shell command: the shell records it in ` +
          'history and the process table exposes it while it runs',
      )
    }
    // Nor any other inline export or assignment of an identity.
    assert.equal(/export /.test(block), false)
    assert.equal(/history/.test(block), false)
  }
})

test('the three inputs are directed to the ignored, 0600 env file', () => {
  assert.match(BINDING_RUNBOOK, /\.env\.local/)
  assert.match(BINDING_RUNBOOK, /0600/)
  assert.match(BINDING_RUNBOOK, /gitignore|ignored/i)
  // As empty placeholders in a dotenv block, so nothing here is a value.
  const dotenv = BINDING_RUNBOOK.match(/```dotenv\n([\s\S]*?)```/)?.[1]
  assert.ok(dotenv, 'the binding section must show a dotenv block')
  for (const name of [
    OIDC_BIND_ENV.email,
    OIDC_BIND_ENV.issuer,
    OIDC_BIND_ENV.subject,
  ]) {
    assert.match(
      dotenv,
      new RegExp(`^${name}=\\s*$`, 'm'),
      `${name} belongs in the ignored file, with no value written here`,
    )
  }
  // And the runbook does not point the operator at a file outside the repo.
  for (const forbidden of [/\.kcrm-audit/, /kcrm/i, /Desktop/i, /\$HOME/]) {
    assert.equal(
      forbidden.test(BINDING_RUNBOOK),
      false,
      `the runbook must not reference ${forbidden}`,
    )
  }
})

test('only the execute gate may be given inline, and it is', () => {
  const inline = BINDING_SHELL_BLOCKS.filter((block) =>
    block.includes(OIDC_BIND_ENV.mode),
  )
  assert.equal(inline.length, 1, 'exactly one armed example')
  assert.match(
    inline[0],
    new RegExp(
      `^${OIDC_BIND_ENV.mode}=${OIDC_BIND_EXECUTE_MODE} npm run w1:bind-oidc$`,
      'm',
    ),
  )
  // The dry-run carries nothing at all.
  assert.ok(
    BINDING_SHELL_BLOCKS.some((block) => block.trim() === 'npm run w1:bind-oidc'),
    'the dry-run must be runnable with a bare command',
  )
})

test('the runbook prints no example email address or subject', () => {
  // A realistic-looking example is copied, and a copied identity binds the wrong
  // account. Placeholders only.
  assert.equal(
    /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(BINDING_RUNBOOK),
    false,
    'the binding section must not show an example email address',
  )
  assert.equal(
    /\b\d{8,}\b/.test(BINDING_RUNBOOK),
    false,
    'the binding section must not show an example subject',
  )
})

test('the runbook states the issuer must match the configured one', () => {
  assert.match(BINDING_RUNBOOK, /OIDC_BIND_ISSUER_MISMATCH/)
  assert.match(BINDING_RUNBOOK, /KAUDIT_OIDC_ISSUER/)
})

test('the runbook describes the audit row as claiming no actor', () => {
  assert.match(BINDING_RUNBOOK, /actor columns are null/i)
  assert.match(BINDING_RUNBOOK, /not necessarily the operator/i)
})

test('.env.example names the inputs as placeholders only', () => {
  for (const name of Object.values(OIDC_BIND_ENV)) {
    assert.ok(ENV_EXAMPLE.includes(name), `.env.example must name ${name}`)
  }
  // Placeholders, not values: nothing after the `=` for the three inputs, and
  // the mode is left at its safe default.
  for (const name of [
    OIDC_BIND_ENV.email,
    OIDC_BIND_ENV.issuer,
    OIDC_BIND_ENV.subject,
  ]) {
    assert.match(
      ENV_EXAMPLE,
      new RegExp(`^${name}=\\s*$`, 'm'),
      `${name} must be an empty placeholder`,
    )
  }
  assert.match(ENV_EXAMPLE, new RegExp(`^${OIDC_BIND_ENV.mode}=dry-run$`, 'm'))
})
