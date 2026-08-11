import { readFileSync } from 'node:fs'
import {
  evaluateVercelReleasePreflight,
  formatPreflightReport,
  type PreflightReport,
  type VercelPreflightInput,
} from '../vercel/releasePreflight.ts'

/**
 * `npm run vercel:preflight` — validates the environment for the Vercel web/API
 * production candidate and exits 0 only if it holds.
 *
 * Validation only, and usable in CI for that reason: it opens no pool, contacts
 * nothing, starts no listener, writes nothing, and changes no variable. It also
 * loads no `.env` file — the variables are whatever the shell or the CI job
 * exports, so what is checked is exactly what a deployment would receive.
 *
 * The one file it reads is this repository's own manifest, for `engines.node`.
 * That keeps the supported Node runtime a single contract instead of a constant
 * that drifts from `package.json`.
 *
 * It cannot speak to a Vercel account, project link, Git remote, migration
 * state, database reachability, or preview routing. Those need network or
 * mutable CLI state and remain operator checks in
 * `docs/runbooks/VERCEL_DEPLOYMENT.md`.
 *
 * ## Output discipline
 *
 * The command's whole output is **one** JSON line on stdout, and its exit code.
 * That holds for startup too. Reading the manifest, parsing it, reaching into
 * its shape, evaluating, and formatting are all failures that can happen before
 * a report exists, and an escaping throw would put a raw message, a path, and a
 * stack on stderr — the one thing this command promises never to print. So they
 * are bounded here instead: any such failure becomes the fixed
 * {@link PREFLIGHT_STARTUP_FAILURE_LINE} and a nonzero exit.
 *
 * Nothing about a thrown value is read on that path — not its message, name,
 * stack, cause, or value. The line is a constant, so no future edit can widen it
 * into output by accident.
 *
 * ## Structure
 *
 * The work lives in {@link runVercelPreflightCli}, which takes its manifest
 * reader, environment, evaluator, formatter, and output as arguments so the
 * startup contract can be tested without touching the repository manifest or a
 * real stream. The process is only touched under `import.meta.main`, so
 * importing this module runs the command nowhere.
 */

/**
 * The single line printed when startup itself fails.
 *
 * It is a fixed string with the same key shape as a normal failure. `checks: 0`
 * is the honest count: nothing was evaluated. The code is narrow and belongs to
 * this command rather than to the evaluator's own vocabulary, because no check
 * reached a verdict — the manifest, the evaluator, or the formatter did not get
 * that far.
 */
export const PREFLIGHT_STARTUP_FAILURE_LINE = JSON.stringify({
  preflight: 'vercel-release',
  result: 'fail',
  checks: 0,
  errors: [{ code: 'PREFLIGHT_STARTUP_FAILED', variables: [] }],
})

/** Everything the command touches outside itself, so a test can supply it. */
export interface PreflightCliDependencies {
  /** Returns the repository manifest as text. May throw; that is bounded. */
  readManifest: () => string
  /** Read only; never mutated. */
  env: NodeJS.ProcessEnv
  nodeVersion: string
  evaluate: (input: VercelPreflightInput) => PreflightReport
  format: (report: PreflightReport) => string
  /** Receives exactly one already-terminated line, at most once per run. */
  write: (line: string) => void
}

/** The real dependencies: this repository's manifest, this process, stdout. */
export function defaultPreflightCliDependencies(): PreflightCliDependencies {
  return {
    readManifest: () =>
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    env: process.env,
    nodeVersion: process.versions.node,
    evaluate: evaluateVercelReleasePreflight,
    format: formatPreflightReport,
    write: (line) => {
      process.stdout.write(line)
    },
  }
}

/**
 * Runs the command and returns the exit code. Never throws.
 *
 * The line is decided first and written second, so exactly one write happens on
 * every path: a startup failure cannot append a second line after a partial one.
 */
export function runVercelPreflightCli(
  dependencies: PreflightCliDependencies = defaultPreflightCliDependencies(),
): number {
  let line = PREFLIGHT_STARTUP_FAILURE_LINE
  let ok = false

  try {
    const manifest = JSON.parse(dependencies.readManifest()) as {
      engines?: { node?: string }
    }
    const report = dependencies.evaluate({
      env: dependencies.env,
      nodeVersion: dependencies.nodeVersion,
      engineNodeRange: manifest.engines?.node ?? '',
    })
    const formatted = dependencies.format(report)
    const passed = report.ok === true
    // Assigned only once every step above has succeeded, so a half-built report
    // can never reach the output.
    line = formatted
    ok = passed
  } catch {
    // Deliberately empty and deliberately opaque: the thrown value is not read,
    // and the fixed line with the exit code is the entire report.
  }

  try {
    dependencies.write(`${line}\n`)
  } catch {
    // The stream itself failed, so there is nowhere left to say so. The exit
    // code carries the failure alone.
    ok = false
  }

  return ok ? 0 : 1
}

if (import.meta.main) process.exitCode = runVercelPreflightCli()
