import { execFileSync } from 'node:child_process'
import { closeSync, fstatSync, lstatSync, openSync, readSync, constants } from 'node:fs'
import { join } from 'node:path'

/**
 * Release-gate secret scan over the full Git candidate set: tracked files plus
 * untracked files that `.gitignore` does not exclude.
 *
 * Safety rules baked into this module:
 * - worktree content is read directly (so modified tracked files and untracked
 *   files are covered, unlike `git grep`);
 * - symbolic links are never followed, at any path segment, and never count as
 *   a passing skip — a link is an unscannable candidate that fails the gate;
 * - the gate fails closed: a candidate that cannot be read in full is reported
 *   as unscannable rather than treated as clean;
 * - findings never carry the matched text — only a stable detector code, the
 *   repository-relative path, and a line number;
 * - a candidate path that cannot be rendered safely on one line is never
 *   echoed; it collapses to a single fixed code;
 * - operational failures collapse to a single fixed code, never a message,
 *   stack, child-process stderr, or absolute path.
 */

/** Stable detector codes. Bounded set; values are part of the CI contract. */
export type DetectorCode =
  | 'PRIVATE_KEY_BLOCK'
  | 'AWS_ACCESS_KEY_ID'
  | 'API_SECRET_KEY'
  | 'DB_URI_CREDENTIALS'

/** Stable reasons a candidate could not be scanned in full. Bounded set. */
export type UnscannableCode =
  | 'SYMLINK_CANDIDATE'
  | 'NON_REGULAR_FILE'
  | 'UNREADABLE_FILE'
  | 'OVERSIZED_FILE'

export type SecretFinding = {
  readonly code: DetectorCode
  readonly file: string
  readonly line: number
}

export type UnscannableCandidate = {
  readonly code: UnscannableCode
  readonly file: string
}

export type SecretScanStatus =
  | 'passed'
  | 'forbidden'
  | 'findings'
  | 'unscannable'
  | 'unsafe-path'
  | 'error'

export type SecretScanErrorCode = 'SECRET_SCAN_ERROR' | 'UNSAFE_CANDIDATE_PATH'

export type SecretScanReport = {
  readonly status: SecretScanStatus
  /** Fixed code; present only for the 'error' and 'unsafe-path' statuses. */
  readonly errorCode?: SecretScanErrorCode
  readonly findings: readonly SecretFinding[]
  readonly forbiddenFiles: readonly string[]
  /** Repository-relative paths whose full stored bytes were read and scanned. */
  readonly scannedPaths: readonly string[]
  /** Candidates that could not be scanned in full. Any entry fails the gate. */
  readonly unscannable: readonly UnscannableCandidate[]
}

const DETECTORS: ReadonlyArray<{ code: DetectorCode; pattern: RegExp }> = [
  { code: 'PRIVATE_KEY_BLOCK', pattern: /BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY/ },
  { code: 'AWS_ACCESS_KEY_ID', pattern: /AKIA[0-9A-Z]{16}/ },
  { code: 'API_SECRET_KEY', pattern: /sk-[A-Za-z0-9_-]{20,}/ },
  { code: 'DB_URI_CREDENTIALS', pattern: /mysql:\/\/[^\s/@]+:[^\s/@]+@/ },
]

/** Filenames that must never appear in the release candidate set at all. */
const FORBIDDEN_FILENAME = /(^|\/)(\.env|\.env\.local)$|\.(pem|key|p12|pfx)$/i

/** Explicit escape hatch for committed, secret-free templates. */
const ALLOWED_TEMPLATE = /(^|\/)\.env\.(example|sample|template)$/i

/**
 * Characters that make a path unsafe to print as one line of CI output, or
 * unsafe to trust as a round-tripped name: C0 controls (including NUL, tab,
 * newline, carriage return and ESC), DEL, C1 controls, the Unicode line and
 * paragraph separators, and the replacement character left behind by a lossy
 * decode of a non-UTF-8 name.
 */
const UNSAFE_PATH_CHARS = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\ufffd]/
/** A lone surrogate cannot be re-encoded to the byte sequence Git gave us. */
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/

/** Bounds keeping a repository scan deterministic and cheap. */
const MAX_PATH_CHARS = 4096
export const MAX_SCANNABLE_BYTES = 4 * 1024 * 1024
const MAX_FINDINGS = 100
const MAX_UNSCANNABLE = 100

class OperationalScanError extends Error {}

export function isForbiddenSecretFilename(file: string): boolean {
  if (ALLOWED_TEMPLATE.test(file)) return false
  return FORBIDDEN_FILENAME.test(file)
}

/**
 * Git paths are repository-relative, forward-slashed, free of control
 * characters, and never traverse out of the repository. Anything else is
 * refused rather than resolved — an unsafe path is never opened and never
 * echoed.
 */
export function isSafeRepositoryPath(file: string): boolean {
  if (file.length === 0 || file.length > MAX_PATH_CHARS) return false
  if (UNSAFE_PATH_CHARS.test(file) || LONE_SURROGATE.test(file)) return false
  if (file.includes('\\')) return false
  if (file.startsWith('/') || /^[A-Za-z]:/.test(file)) return false
  const segments = file.split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return false
  if (segments[0] === '.git') return false
  return true
}

function listCandidatePaths(repoRoot: string): string[] {
  let raw: string
  try {
    raw = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch {
    throw new OperationalScanError()
  }
  return raw.split('\0').filter(Boolean).sort()
}

type CandidateRead =
  | { readonly ok: true; readonly buffer: Buffer }
  | { readonly ok: false; readonly code: UnscannableCode }

/**
 * Verifies that every directory segment leading to the candidate is a real
 * directory rather than a symbolic link, so reading it cannot escape the
 * repository. Returns null when the whole prefix is sound.
 */
function checkDirectorySegments(
  repoRoot: string,
  file: string,
  realDirectories: Set<string>,
): UnscannableCode | null {
  const segments = file.split('/')
  let current = repoRoot
  for (let i = 0; i < segments.length - 1; i += 1) {
    current = join(current, segments[i]!)
    if (realDirectories.has(current)) continue
    let stats
    try {
      stats = lstatSync(current)
    } catch {
      return 'UNREADABLE_FILE'
    }
    if (stats.isSymbolicLink()) return 'SYMLINK_CANDIDATE'
    if (!stats.isDirectory()) return 'NON_REGULAR_FILE'
    realDirectories.add(current)
  }
  return null
}

/**
 * Reads the complete stored bytes of a regular file without following a
 * symbolic link at any segment. A partial read is reported as unreadable
 * rather than passed off as scanned content.
 */
function readCandidate(
  repoRoot: string,
  file: string,
  realDirectories: Set<string>,
): CandidateRead {
  const prefixProblem = checkDirectorySegments(repoRoot, file, realDirectories)
  if (prefixProblem) return { ok: false, code: prefixProblem }

  const fullPath = join(repoRoot, file)
  let link
  try {
    link = lstatSync(fullPath)
  } catch {
    return { ok: false, code: 'UNREADABLE_FILE' }
  }
  // Checked before opening so a link is always reported as a link, never as a
  // platform-dependent open failure.
  if (link.isSymbolicLink()) return { ok: false, code: 'SYMLINK_CANDIDATE' }
  if (!link.isFile()) return { ok: false, code: 'NON_REGULAR_FILE' }

  let fd: number
  try {
    fd = openSync(fullPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
  } catch {
    return { ok: false, code: 'UNREADABLE_FILE' }
  }
  try {
    const stats = fstatSync(fd)
    if (!stats.isFile()) return { ok: false, code: 'NON_REGULAR_FILE' }
    const size = Number(stats.size)
    if (!Number.isSafeInteger(size) || size < 0) return { ok: false, code: 'UNREADABLE_FILE' }
    if (size > MAX_SCANNABLE_BYTES) return { ok: false, code: 'OVERSIZED_FILE' }
    if (size === 0) return { ok: true, buffer: Buffer.alloc(0) }
    const buffer = Buffer.alloc(size)
    let read = 0
    while (read < size) {
      const chunk = readSync(fd, buffer, read, size - read, read)
      if (chunk <= 0) break
      read += chunk
    }
    // Anything short of the whole file would be a prefix, and a prefix must
    // never be reported as fully scanned.
    if (read < size) return { ok: false, code: 'UNREADABLE_FILE' }
    return { ok: true, buffer }
  } catch {
    return { ok: false, code: 'UNREADABLE_FILE' }
  } finally {
    closeSync(fd)
  }
}

/**
 * Byte-faithful decode. Every detector pattern is pure ASCII, and no ASCII
 * byte can appear inside a UTF-8 multi-byte sequence, so latin1 finds exactly
 * the matches a byte scan would — including inside otherwise binary content,
 * with no decoding losses and no need to skip anything.
 */
function decodeForScanning(buffer: Buffer): string {
  return buffer.toString('latin1')
}

function lineNumberAt(text: string, index: number): number {
  let line = 1
  for (let i = 0; i < index; i += 1) {
    if (text.charCodeAt(i) === 10) line += 1
  }
  return line
}

/**
 * Detects at most one finding per detector per file, in detector order. The
 * whole text is searched — there is no per-line cutoff a secret could hide
 * behind — and only the line number of the match is retained.
 */
export function detectInText(text: string, file: string): SecretFinding[] {
  const found: SecretFinding[] = []
  for (const detector of DETECTORS) {
    const match = detector.pattern.exec(text)
    if (!match) continue
    found.push({ code: detector.code, file, line: lineNumberAt(text, match.index) })
  }
  return found
}

function unsafePathReport(): SecretScanReport {
  return {
    status: 'unsafe-path',
    errorCode: 'UNSAFE_CANDIDATE_PATH',
    findings: [],
    forbiddenFiles: [],
    scannedPaths: [],
    unscannable: [],
  }
}

export function runSecretScan(repoRoot: string): SecretScanReport {
  try {
    const candidates = listCandidatePaths(repoRoot)

    // Fail closed before touching the filesystem: an unsafe path cannot be
    // reported, so the run cannot be summarised honestly either.
    if (candidates.some((file) => !isSafeRepositoryPath(file))) return unsafePathReport()

    const forbiddenFiles = candidates.filter(isForbiddenSecretFilename)
    if (forbiddenFiles.length > 0) {
      return {
        status: 'forbidden',
        findings: [],
        forbiddenFiles,
        scannedPaths: [],
        unscannable: [],
      }
    }

    const findings: SecretFinding[] = []
    const scannedPaths: string[] = []
    const unscannable: UnscannableCandidate[] = []
    const realDirectories = new Set<string>()

    for (const file of candidates) {
      const result = readCandidate(repoRoot, file, realDirectories)
      if (!result.ok) {
        unscannable.push({ code: result.code, file })
        continue
      }
      scannedPaths.push(file)
      if (findings.length >= MAX_FINDINGS) continue
      findings.push(...detectInText(decodeForScanning(result.buffer), file))
    }

    const boundedFindings = findings.slice(0, MAX_FINDINGS)
    const boundedUnscannable = unscannable.slice(0, MAX_UNSCANNABLE)
    const status: SecretScanStatus =
      boundedFindings.length > 0 ? 'findings' : boundedUnscannable.length > 0 ? 'unscannable' : 'passed'
    return {
      status,
      findings: boundedFindings,
      forbiddenFiles: [],
      scannedPaths,
      unscannable: boundedUnscannable,
    }
  } catch {
    return {
      status: 'error',
      errorCode: 'SECRET_SCAN_ERROR',
      findings: [],
      forbiddenFiles: [],
      scannedPaths: [],
      unscannable: [],
    }
  }
}

export type SecretScanOutput = {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: 0 | 1
}

/**
 * Renders a report for CI. Emits only stable codes, safe repository-relative
 * paths, line numbers, and counts — never matched text, error detail, or an
 * unsafe path.
 */
export function formatSecretScanOutput(report: SecretScanReport): SecretScanOutput {
  if (report.status === 'error') {
    return {
      stdout: '',
      stderr: 'SECRET_SCAN_ERROR: secret scan could not complete.\n',
      exitCode: 1,
    }
  }
  if (report.status === 'unsafe-path') {
    return {
      stdout: '',
      stderr:
        'UNSAFE_CANDIDATE_PATH: a release candidate path cannot be safely reported; scan failed closed.\n',
      exitCode: 1,
    }
  }

  const sections: string[] = []
  if (report.forbiddenFiles.length > 0) {
    const lines = report.forbiddenFiles.map((file) => `FORBIDDEN_SECRET_FILE ${file}`)
    sections.push(
      `Forbidden secret-bearing files are in the release candidate set:\n${lines.join('\n')}\n`,
    )
  }
  if (report.findings.length > 0) {
    const lines = report.findings.map((f) => `${f.code} ${f.file}:${f.line}`)
    sections.push(`Potential secret material found (values withheld):\n${lines.join('\n')}\n`)
  }
  if (report.unscannable.length > 0) {
    const lines = report.unscannable.map((u) => `${u.code} ${u.file}`)
    sections.push(
      `Release candidates could not be scanned in full (failing closed):\n${lines.join('\n')}\n`,
    )
  }
  if (sections.length > 0) {
    return { stdout: '', stderr: sections.join(''), exitCode: 1 }
  }

  return {
    stdout: `Secret scan passed (${report.scannedPaths.length} candidate repository files scanned in full).\n`,
    stderr: '',
    exitCode: 0,
  }
}
