import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

/**
 * Transport contract for the operator CLIs that build their mysql2 TLS options
 * inline instead of going through `runtime/databaseTls.ts`.
 *
 * It is static for the same reason the individual CLI contracts are: these are
 * entry points that open a connection pool — several at module scope — so
 * importing one from a test would reach a database. What is under guard is the
 * SHAPE of the options object each of them hands the driver, and that is
 * readable from the source without executing it.
 *
 * The invariant: wherever a CA is configured, both flags are fixed true.
 * `rejectUnauthorized` alone proves the peer certificate chains to the
 * configured authority; it does not prove the certificate was issued for the
 * host being dialled, because mysql2 replaces Node's `checkServerIdentity` with
 * a function that returns `undefined` whenever `verifyIdentity` is absent. Any
 * other host holding a certificate from the same authority would satisfy such a
 * connection. Both flags are required for a host-specific leaf certificate to
 * mean what it looks like it means.
 *
 * Nothing here opens a socket, reads a certificate, or touches an environment
 * value: every assertion is made against source text.
 */

const CLI_DIRECTORY = fileURLToPath(new URL('.', import.meta.url))
const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Comments explain the rules; only executable text can enforce them. */
function code(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

function read(filePath: string): string {
  return code(readFileSync(filePath, 'utf8'))
}

/**
 * The object literal containing a given offset, by brace matching outwards.
 *
 * Matching the enclosing literal rather than a fixed window is what makes the
 * pairing assertion meaningful: a `verifyIdentity` sitting in some neighbouring
 * object would not satisfy it.
 */
function enclosingObjectLiteral(source: string, offset: number): string {
  let depth = 0
  let open = -1
  for (let index = offset; index >= 0; index -= 1) {
    const character = source[index]
    if (character === '}') depth += 1
    else if (character === '{') {
      if (depth === 0) {
        open = index
        break
      }
      depth -= 1
    }
  }
  assert.notEqual(open, -1, 'the TLS options must sit in an object literal')
  depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      if (depth === 0) return source.slice(open, index + 1)
    }
  }
  assert.fail('the TLS options object literal is unbalanced')
}

/** Every place a file fixes `rejectUnauthorized` on, as whole literals. */
function tlsConstructions(source: string): string[] {
  return [...source.matchAll(/rejectUnauthorized:\s*true/g)].map((match) =>
    enclosingObjectLiteral(source, match.index as number),
  )
}

/**
 * The operator entry points that still assemble the driver's TLS options
 * themselves. Listing them by name is deliberate: the sweep at the bottom of
 * this file proves the list is complete, so a seventh cannot appear unnoticed.
 */
const INLINE_TLS_CLIS = [
  'run-report-email-worker.ts',
  'run-automated-validation.ts',
  'run-cycle-preview.ts',
  'run-admin-grant.ts',
  'run-call-audit-batch.ts',
] as const

test('run-cycle-close.ts uses the shared TLS resolver for inline or file CA input', () => {
  const source = read(path.join(CLI_DIRECTORY, 'run-cycle-close.ts'))
  assert.match(source, /resolveDatabaseTls\(config, process\.env\)/)
  assert.equal(source.includes('readFileSync('), false)
})

for (const fileName of INLINE_TLS_CLIS) {
  const source = read(path.join(CLI_DIRECTORY, fileName))

  test(`${fileName} hands the driver a CA that is verified and an identity that is checked`, () => {
    // One pool per entry point, so one set of TLS options reaches the driver.
    assert.equal(
      [...source.matchAll(/mysql\.createPool\(/g)].length,
      1,
      `${fileName} must create exactly one pool`,
    )
    const constructions = tlsConstructions(source)
    assert.ok(
      constructions.length >= 1,
      `${fileName} must fix its TLS options in source`,
    )
    // Every site that fixes the flags — the literal, and in one file the type
    // that describes it — states the whole posture: a CA, verified, for this
    // host. Those are three parts of one decision, not one plus two options.
    for (const ssl of constructions) {
      assert.match(ssl, /\bca:/)
      assert.match(ssl, /rejectUnauthorized:\s*true/)
      assert.match(
        ssl,
        /verifyIdentity:\s*true/,
        `${fileName} must set verifyIdentity beside rejectUnauthorized`,
      )
    }
  })

  test(`${fileName} fixes both flags on, with no switch that can turn either off`, () => {
    // Exactly `true`, never a variable, a ternary, or an environment lookup.
    assert.equal(/rejectUnauthorized:(?!\s*true\b)/.test(source), false)
    assert.equal(/verifyIdentity:(?!\s*true\b)/.test(source), false)
    // And the two always appear together, at every site in the file.
    assert.equal(
      [...source.matchAll(/verifyIdentity:\s*true/g)].length,
      [...source.matchAll(/rejectUnauthorized:\s*true/g)].length,
    )
    // No variable, in any shape, is read as consent to weaken the handshake.
    for (const forbidden of [
      /VERIFY_IDENTITY/,
      /REJECT_UNAUTHORIZED/,
      /SSL_INSECURE/,
      /NODE_TLS/,
      /checkServerIdentity/,
    ]) {
      assert.equal(
        forbidden.test(source),
        false,
        `${fileName} must not offer ${forbidden} as a way out`,
      )
    }
  })
}

test('run-call-audit-batch.ts declares both flags in the ssl type as well', () => {
  // The one file that types the options separately from the literal. Both flags
  // are fixed in the type too, so dropping one is a compile error rather than a
  // silently weaker handshake.
  const source = read(path.join(CLI_DIRECTORY, 'run-call-audit-batch.ts'))
  const declaration = source.slice(
    source.indexOf('let ssl:'),
    source.indexOf('try {', source.indexOf('let ssl:')),
  )
  assert.ok(declaration, 'the ssl declaration must be typed')
  assert.match(declaration, /ca: string/)
  assert.match(declaration, /rejectUnauthorized: true/)
  assert.match(declaration, /verifyIdentity: true/)
})

test('the Call Audit batch still refuses before the CA read or the pool', () => {
  // The added flag must not have moved anything: the mode gate stays first, and
  // the CA read, the runtime configuration, the pool, the credential, and the
  // model all stay behind it.
  const source = read(path.join(CLI_DIRECTORY, 'run-call-audit-batch.ts'))
  const gate = source.indexOf('!== EXECUTE_MODE')
  assert.notEqual(gate, -1, 'the batch CLI must keep its execute gate')
  for (const later of [
    'loadRuntimeConfig(',
    'readFileSync(',
    'mysql.createPool(',
    'process.env[ENV.apiKey]',
    'createOpenAiCallAuditModel(',
    'runCallAuditBatch(',
  ]) {
    const at = source.indexOf(later, gate)
    assert.notEqual(at, -1, `the batch CLI must still reach ${later}`)
    assert.ok(
      gate < at,
      `the execute gate must precede ${later}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

function typeScriptFiles(directory: string): string[] {
  const found: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...typeScriptFiles(full))
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
      found.push(full)
    }
  }
  return found
}

test('every mysql2 caller in src pairs the two flags', () => {
  // The sweep, so this contract cannot be satisfied by a list that has fallen
  // behind the tree. Scoped to files that import the MySQL driver: an HTTP or
  // SMTP client has its own transport rules and is not this file's business.
  const offenders: string[] = []
  const seen: string[] = []
  for (const filePath of typeScriptFiles(SOURCE_ROOT)) {
    const source = read(filePath)
    if (!/from 'mysql2/.test(source)) continue
    const constructions = tlsConstructions(source)
    if (constructions.length === 0) continue
    seen.push(path.relative(SOURCE_ROOT, filePath))
    for (const ssl of constructions) {
      if (!/verifyIdentity:\s*true/.test(ssl)) {
        offenders.push(path.relative(SOURCE_ROOT, filePath))
      }
    }
  }
  assert.deepEqual(offenders, [], 'these mysql2 TLS options skip the host check')
  // And the named files above are exactly the inline constructions that exist.
  assert.deepEqual(
    seen.sort(),
    INLINE_TLS_CLIS.map((name) => path.join('cli', name)).sort(),
  )
})
