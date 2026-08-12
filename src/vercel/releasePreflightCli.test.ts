import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import {
  PREFLIGHT_STARTUP_FAILURE_LINE,
  runVercelPreflightCli,
  type PreflightCliDependencies,
} from '../cli/run-vercel-preflight.ts'
import {
  evaluateVercelReleasePreflight,
  formatPreflightReport,
  type PreflightReport,
} from './releasePreflight.ts'

/**
 * The startup contract of `npm run vercel:preflight`.
 *
 * The evaluator's own rules are covered in `releasePreflight.test.ts`. What is
 * under test here is everything that happens *before* a report exists — reading
 * the manifest, parsing it, reaching into its shape, evaluating, formatting,
 * writing — because each of those can throw, and an escaping throw would put a
 * message, a path, and a stack on stderr from a command whose entire contract is
 * one safe JSON line.
 *
 * Every fixture is synthetic. No manifest on disk is read, written, or altered:
 * the manifest reader is injected, and the two child-process cases below inject
 * a throwing reader rather than damaging `package.json`. Nothing here is a real
 * host, credential, certificate, or key.
 */

/** Synthetic; not a certificate, and never handed to a TLS stack. */
const SYNTHETIC_CA_PEM = [
  '-----BEGIN CERTIFICATE-----',
  'c3ludGhldGljLWZpeHR1cmUtbm90LWEtY2VydGlmaWNhdGU=',
  '-----END CERTIFICATE-----',
].join('\n')

const SYNTHETIC_MANIFEST = JSON.stringify({ engines: { node: '24.x' } })

/** A marker that must never appear in output, whatever throws carries it. */
const MARKER = 'synthetic-startup-failure-detail'

function productionEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    KAUDIT_AUTH_MODE: 'oidc',
    KAUDIT_TRUST_PROXY: 'true',
    DB_HOST: 'db.invalid.test',
    DB_NAME: 'kaudit',
    DB_USER: 'kaudit_web',
    DB_PASSWORD: 'synthetic-fixture-password',
    DB_SSL_CA_PEM: SYNTHETIC_CA_PEM,
    KAUDIT_OIDC_ISSUER: 'https://identity.invalid.test/',
    KAUDIT_OIDC_AUDIENCE: 'kaudit-web',
    KAUDIT_OIDC_JWKS_URI: 'https://identity.invalid.test/.well-known/jwks.json',
  }
}

interface Run {
  status: number
  lines: string[]
  output: string
}

/** Runs the command with injected dependencies and collects what it wrote. */
function run(overrides: Partial<PreflightCliDependencies> = {}): Run {
  const written: string[] = []
  const status = runVercelPreflightCli({
    readManifest: () => SYNTHETIC_MANIFEST,
    env: productionEnv(),
    nodeVersion: '24.3.0',
    evaluate: evaluateVercelReleasePreflight,
    format: formatPreflightReport,
    write: (line) => {
      written.push(line)
    },
    ...overrides,
  })
  return { status, lines: written, output: written.join('') }
}

/** The whole safe-output contract for a startup failure, asserted at once. */
function assertBoundedStartupFailure(result: Run): void {
  assert.equal(result.status, 1)
  assert.deepEqual(result.lines, [`${PREFLIGHT_STARTUP_FAILURE_LINE}\n`])
  assert.equal(result.output.includes(MARKER), false)
  assert.equal(/stack|Error|at |\//.test(result.output), false)
  const parsed = JSON.parse(result.output) as Record<string, unknown>
  assert.deepEqual(Object.keys(parsed), ['preflight', 'result', 'checks', 'errors'])
}

// ---------------------------------------------------------------------------
// The normal paths are unchanged
// ---------------------------------------------------------------------------

test('a passing environment writes the pass line and exits zero', () => {
  const result = run()
  assert.equal(result.status, 0)
  assert.deepEqual(result.lines, [
    '{"preflight":"vercel-release","result":"pass","checks":13,"optionalFeatures":[]}\n',
  ])
})

test('a failing environment writes the evaluator report and exits nonzero', () => {
  const env = productionEnv()
  delete env.DB_SSL_CA_PEM
  const result = run({ env })
  assert.equal(result.status, 1)
  assert.equal(result.lines.length, 1)
  const parsed = JSON.parse(result.output) as {
    result: string
    checks: number
    errors: Array<{ code: string }>
  }
  assert.equal(parsed.result, 'fail')
  assert.equal(parsed.checks, 13)
  // The evaluator's own verdict, forwarded whole: the missing CA, and the
  // accepted parser refusing the same environment for the same reason.
  assert.deepEqual(
    parsed.errors.map((entry) => entry.code),
    ['DB_CA_SOURCE_MISSING', 'RUNTIME_CONFIG_INVALID'],
  )
})

test('the engine contract comes from the manifest the reader returns', () => {
  const result = run({ readManifest: () => JSON.stringify({ engines: { node: '22.x' } }) })
  assert.equal(result.status, 1)
  assert.match(result.output, /NODE_RUNTIME_UNSUPPORTED/)
})

test('the manifest is read exactly once, and only through the injected reader', () => {
  let reads = 0
  const result = run({
    readManifest: () => {
      reads += 1
      return SYNTHETIC_MANIFEST
    },
  })
  assert.equal(reads, 1)
  assert.equal(result.status, 0)
})

// ---------------------------------------------------------------------------
// Startup failures are bounded to one fixed line
// ---------------------------------------------------------------------------

test('the startup failure line is a fixed, safe, single JSON object', () => {
  assert.equal(
    PREFLIGHT_STARTUP_FAILURE_LINE,
    '{"preflight":"vercel-release","result":"fail","checks":0,"errors":[{"code":"PREFLIGHT_STARTUP_FAILED","variables":[]}]}',
  )
  assert.equal(PREFLIGHT_STARTUP_FAILURE_LINE.includes('\n'), false)
})

test('an unreadable manifest is bounded to one safe line', () => {
  assertBoundedStartupFailure(
    run({
      readManifest: () => {
        // What `readFileSync` throws for a missing or unreadable file: an error
        // whose message and stack carry the path.
        throw Object.assign(new Error(`ENOENT: no such file, open ${MARKER}`), {
          code: 'ENOENT',
          path: MARKER,
        })
      },
    }),
  )
})

test('a malformed manifest is bounded to one safe line', () => {
  for (const text of ['', '{', 'not json', `{"engines": ${MARKER}}`]) {
    assertBoundedStartupFailure(run({ readManifest: () => text }))
  }
})

test('a manifest whose shape throws on access is bounded to one safe line', () => {
  // `JSON.parse('null')` succeeds, and reaching into the result then throws —
  // a shape failure rather than a parse failure, and equally unbounded if the
  // startup were left at module scope.
  assertBoundedStartupFailure(run({ readManifest: () => 'null' }))
})

test('a manifest with no engines field is evaluated, not crashed on', () => {
  // Absent is a reportable condition, not a startup failure: the evaluator has
  // a code for it.
  const result = run({ readManifest: () => '{}' })
  assert.equal(result.status, 1)
  assert.match(result.output, /NODE_ENGINE_CONTRACT_UNREADABLE/)
})

test('an evaluator that throws cannot leak what it threw', () => {
  assertBoundedStartupFailure(
    run({
      evaluate: () => {
        throw new Error(MARKER)
      },
    }),
  )
})

test('an evaluator that throws a non-error value is bounded too', () => {
  for (const thrown of [MARKER, { detail: MARKER }, null, undefined]) {
    assertBoundedStartupFailure(
      run({
        evaluate: () => {
          throw thrown
        },
      }),
    )
  }
})

test('a formatter that throws cannot leak what it threw', () => {
  assertBoundedStartupFailure(
    run({
      format: () => {
        throw new Error(MARKER)
      },
    }),
  )
})

test('a report whose ok cannot be read is a startup failure, not a pass', () => {
  const hostile = new Proxy(
    { checks: 0, findings: [], optionalFeatures: [] } as unknown as PreflightReport,
    {
      get(target, property) {
        if (property === 'ok') throw new Error(MARKER)
        return Reflect.get(target, property)
      },
    },
  )
  assertBoundedStartupFailure(run({ evaluate: () => hostile, format: () => '{}' }))
})

test('a report is never trusted to be passing unless it says so', () => {
  const result = run({
    evaluate: () =>
      ({ ok: 'yes', checks: 0, findings: [], optionalFeatures: [] }) as unknown as PreflightReport,
    format: () => '{"preflight":"vercel-release","result":"fail","checks":0,"errors":[]}',
  })
  assert.equal(result.status, 1)
})

test('a failing output stream still exits nonzero and writes nothing twice', () => {
  const attempts: string[] = []
  const status = runVercelPreflightCli({
    readManifest: () => SYNTHETIC_MANIFEST,
    env: productionEnv(),
    nodeVersion: '24.3.0',
    evaluate: evaluateVercelReleasePreflight,
    format: formatPreflightReport,
    write: (line) => {
      attempts.push(line)
      throw new Error(MARKER)
    },
  })
  assert.equal(status, 1)
  assert.equal(attempts.length, 1)
})

test('exactly one write happens on every path', () => {
  const paths: Array<Partial<PreflightCliDependencies>> = [
    {},
    { readManifest: () => 'not json' },
    {
      evaluate: () => {
        throw new Error(MARKER)
      },
    },
    {
      format: () => {
        throw new Error(MARKER)
      },
    },
  ]
  for (const overrides of paths) {
    assert.equal(run(overrides).lines.length, 1)
  }
})

// ---------------------------------------------------------------------------
// The command touches no stream of its own
// ---------------------------------------------------------------------------

test('a bounded failure writes to neither stdout nor stderr directly', () => {
  const realOut = process.stdout.write
  const realErr = process.stderr.write
  let direct = 0
  const count = (): boolean => {
    direct += 1
    return true
  }
  process.stdout.write = count as typeof process.stdout.write
  process.stderr.write = count as typeof process.stderr.write
  try {
    run({
      readManifest: () => {
        throw new Error(MARKER)
      },
    })
  } finally {
    process.stdout.write = realOut
    process.stderr.write = realErr
  }
  assert.equal(direct, 0)
})

// ---------------------------------------------------------------------------
// The same guarantees in a real process
// ---------------------------------------------------------------------------

const CLI_HREF = new URL('../cli/run-vercel-preflight.ts', import.meta.url).href

/** Runs a synthetic ESM entry in a child process. Writes no file anywhere. */
function runChild(script: string): {
  status: number | null
  stdout: string
  stderr: string
} {
  const child = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', script],
    { encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } },
  )
  return {
    status: child.status,
    stdout: child.stdout ?? '',
    stderr: child.stderr ?? '',
  }
}

test('importing the command does not run it', () => {
  const child = runChild(
    `await import(${JSON.stringify(CLI_HREF)})\nprocess.stdout.write('imported')`,
  )
  assert.equal(child.status, 0)
  // Nothing but the sentinel: no report line, no read of the real manifest.
  assert.equal(child.stdout, 'imported')
  assert.equal(child.stderr, '')
})

test('a startup failure in a real process prints one line, no stack, nonzero', () => {
  const child = runChild(
    [
      `const cli = await import(${JSON.stringify(CLI_HREF)})`,
      'process.exitCode = cli.runVercelPreflightCli({',
      `  readManifest: () => { throw new Error(${JSON.stringify(MARKER)}) },`,
      '  env: {},',
      "  nodeVersion: '24.3.0',",
      '  evaluate: () => { throw new Error("unreachable") },',
      '  format: () => { throw new Error("unreachable") },',
      '  write: (line) => process.stdout.write(line),',
      '})',
    ].join('\n'),
  )
  assert.notEqual(child.status, 0)
  assert.equal(child.stdout, `${PREFLIGHT_STARTUP_FAILURE_LINE}\n`)
  // The whole point: Node printed no exception, no stack, no path.
  assert.equal(child.stderr, '')
  assert.equal(child.stdout.includes(MARKER), false)
})
