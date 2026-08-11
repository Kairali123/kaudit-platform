import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MAX_SCANNABLE_BYTES,
  detectInText,
  formatSecretScanOutput,
  isForbiddenSecretFilename,
  isSafeRepositoryPath,
  runSecretScan,
} from './releaseSecretScan.ts'

// Synthetic fixtures only. Secret-shaped strings are assembled at runtime so
// this test file never itself carries a token the scanner would flag.
const SYNTHETIC_AWS_KEY = 'AKIA' + 'QRSTUVWXYZ012345'
const SYNTHETIC_API_KEY = 'sk-' + 'synthetic0000000000000000test'
const SYNTHETIC_DB_URI = 'my' + 'sql://demo:demo0pass@db.invalid:3306/demo'
const SYNTHETIC_PRIVATE_KEY = '-----BEGIN ' + 'PRIVATE KEY-----\nc3ludGhldGlj\n'

function git(repo: string, args: string[]): void {
  execFileSync('git', args, { cwd: repo, stdio: ['ignore', 'ignore', 'ignore'] })
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'kaudit-secret-scan-'))
  git(repo, ['init', '-q', '-b', 'main'])
  git(repo, ['config', 'user.email', 'test@example.invalid'])
  git(repo, ['config', 'user.name', 'Test'])
  git(repo, ['config', 'commit.gpgsign', 'false'])
  return repo
}

function commitAll(repo: string): void {
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-q', '-m', 'fixture', '--no-verify'])
}

function withRepo(run: (repo: string) => void): void {
  const repo = makeRepo()
  try {
    run(repo)
  } finally {
    rmSync(repo, { recursive: true, force: true })
  }
}

test('tracked clean file passes', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'clean.ts'), 'export const value = 1\n')
    commitAll(repo)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.findings, [])
    assert.deepEqual(report.unscannable, [])
    assert.ok(report.scannedPaths.includes('clean.ts'))
    assert.equal(formatSecretScanOutput(report).exitCode, 0)
  })
})

test('modified tracked file with a synthetic secret is detected in the worktree', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'config.ts'), 'export const value = 1\n')
    commitAll(repo)
    // Worktree-only modification: never committed, so git grep on HEAD would miss it.
    writeFileSync(join(repo, 'config.ts'), `export const key = '${SYNTHETIC_AWS_KEY}'\n`)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'findings')
    assert.equal(report.findings.length, 1)
    assert.equal(report.findings[0]?.code, 'AWS_ACCESS_KEY_ID')
    assert.equal(report.findings[0]?.file, 'config.ts')
    assert.equal(report.findings[0]?.line, 1)
  })
})

test('untracked nonignored file with a synthetic secret is detected', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'kept.ts'), 'export const value = 1\n')
    commitAll(repo)
    mkdirSync(join(repo, 'drafts'))
    writeFileSync(join(repo, 'drafts', 'note.ts'), `const uri = '${SYNTHETIC_DB_URI}'\n`)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'findings')
    assert.deepEqual(
      report.findings.map((f) => [f.code, f.file]),
      [['DB_URI_CREDENTIALS', 'drafts/note.ts']],
    )
  })
})

test('gitignored file is excluded from scanning', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, '.gitignore'), 'secrets-out/\n')
    writeFileSync(join(repo, 'kept.ts'), 'export const value = 1\n')
    commitAll(repo)
    mkdirSync(join(repo, 'secrets-out'))
    writeFileSync(join(repo, 'secrets-out', 'dump.txt'), `${SYNTHETIC_API_KEY}\n`)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'passed')
    assert.ok(!report.scannedPaths.some((p) => p.startsWith('secrets-out/')))
    assert.ok(!report.unscannable.some((u) => u.file.startsWith('secrets-out/')))
  })
})

test('forbidden filenames are rejected while .env.example stays allowed', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, '.env.example'), 'KAUDIT_DB_HOST=localhost\n')
    writeFileSync(join(repo, '.env'), 'KAUDIT_DB_HOST=localhost\n')
    writeFileSync(join(repo, 'server.key'), 'placeholder\n')
    commitAll(repo)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'forbidden')
    assert.deepEqual([...report.forbiddenFiles].sort(), ['.env', 'server.key'])
    assert.ok(!report.forbiddenFiles.includes('.env.example'))
    assert.equal(formatSecretScanOutput(report).exitCode, 1)
  })

  assert.equal(isForbiddenSecretFilename('.env'), true)
  assert.equal(isForbiddenSecretFilename('config/.env.local'), true)
  assert.equal(isForbiddenSecretFilename('certs/client.p12'), true)
  assert.equal(isForbiddenSecretFilename('certs/client.pfx'), true)
  assert.equal(isForbiddenSecretFilename('certs/key.pem'), true)
  assert.equal(isForbiddenSecretFilename('.env.example'), false)
  assert.equal(isForbiddenSecretFilename('docs/.env.sample'), false)
})

test('finding output carries codes and paths but never the secret text', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'leak.ts'), `const a = '${SYNTHETIC_API_KEY}'\n`)
    writeFileSync(join(repo, 'pem.txt'), SYNTHETIC_PRIVATE_KEY)
    commitAll(repo)

    const report = runSecretScan(repo)
    const output = formatSecretScanOutput(report)
    assert.equal(output.exitCode, 1)
    assert.equal(output.stdout, '')
    assert.ok(output.stderr.includes('API_SECRET_KEY leak.ts:1'))
    assert.ok(output.stderr.includes('PRIVATE_KEY_BLOCK pem.txt:1'))
    for (const secret of [SYNTHETIC_API_KEY, SYNTHETIC_PRIVATE_KEY.trim(), 'c3ludGhldGlj']) {
      assert.ok(!output.stderr.includes(secret))
      assert.ok(!output.stdout.includes(secret))
    }
    assert.ok(!output.stderr.includes('const a ='))
  })
})

test('a symlink candidate fails the gate and its external target is never read', () => {
  const outside = mkdtempSync(join(tmpdir(), 'kaudit-secret-outside-'))
  try {
    const externalFile = join(outside, 'target.txt')
    writeFileSync(externalFile, `${SYNTHETIC_AWS_KEY}\n`)
    withRepo((repo) => {
      writeFileSync(join(repo, 'kept.ts'), 'export const value = 1\n')
      symlinkSync(externalFile, join(repo, 'link.txt'))
      mkdirSync(join(outside, 'nested'))
      writeFileSync(join(outside, 'nested', 'deep.txt'), `${SYNTHETIC_AWS_KEY}\n`)
      symlinkSync(join(outside, 'nested'), join(repo, 'nested'))
      commitAll(repo)

      const report = runSecretScan(repo)
      // A link is never a passing skip: it fails closed, with a stable code.
      assert.equal(report.status, 'unscannable')
      assert.deepEqual(report.findings, [])
      assert.deepEqual(
        [...report.unscannable].map((u) => [u.code, u.file]).sort(),
        [
          ['SYMLINK_CANDIDATE', 'link.txt'],
          // Git lists the linked directory itself; it is rejected as a unit,
          // so nothing beneath it is ever enumerated or opened.
          ['SYMLINK_CANDIDATE', 'nested'],
        ],
      )
      // Neither the link nor anything behind it was opened as scanned content.
      assert.ok(!report.scannedPaths.includes('link.txt'))
      assert.ok(!report.scannedPaths.some((p) => p.startsWith('nested/')))
      assert.ok(report.scannedPaths.includes('kept.ts'))

      const output = formatSecretScanOutput(report)
      assert.equal(output.exitCode, 1)
      assert.equal(output.stdout, '')
      assert.ok(output.stderr.includes('SYMLINK_CANDIDATE link.txt'))
      // The external target's content and location stay out of the output.
      assert.ok(!output.stderr.includes(SYNTHETIC_AWS_KEY))
      assert.ok(!output.stderr.includes(outside))
    })
    // The external file survived the scan untouched.
    assert.equal(readFileSync(externalFile, 'utf8'), `${SYNTHETIC_AWS_KEY}\n`)
  } finally {
    rmSync(outside, { recursive: true, force: true })
  }
})

test('a control-character candidate path fails closed and is never echoed', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'kept.ts'), 'export const value = 1\n')
    // Newline, carriage return, tab and ESC in one untracked filename: every
    // one of these could forge or hide a line of CI output if echoed.
    const hostileName = 'evil\nSECRET_SCAN_OK\r\tname\u001b[31m.txt'
    writeFileSync(join(repo, hostileName), 'export const value = 2\n')
    commitAll(repo)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'unsafe-path')
    assert.equal(report.errorCode, 'UNSAFE_CANDIDATE_PATH')
    assert.deepEqual(report.findings, [])
    assert.deepEqual(report.scannedPaths, [])

    const output = formatSecretScanOutput(report)
    assert.equal(output.exitCode, 1)
    assert.equal(output.stdout, '')
    assert.equal(
      output.stderr,
      'UNSAFE_CANDIDATE_PATH: a release candidate path cannot be safely reported; scan failed closed.\n',
    )
    // No fragment of the hostile name, and no control character, reaches output.
    assert.ok(!output.stderr.includes('evil'))
    assert.ok(!output.stderr.includes('SECRET_SCAN_OK'))
    assert.equal(/[\u0000-\u001f\u007f-\u009f]/.test(output.stderr.trimEnd()), false)
  })
})

test('an unreadable Git inventory yields a bounded fixed error output', () => {
  const notARepo = mkdtempSync(join(tmpdir(), 'kaudit-secret-nogit-'))
  try {
    const report = runSecretScan(join(notARepo, 'missing-subdir'))
    assert.equal(report.status, 'error')
    assert.equal(report.errorCode, 'SECRET_SCAN_ERROR')
    assert.deepEqual(report.findings, [])

    const output = formatSecretScanOutput(report)
    assert.equal(output.exitCode, 1)
    assert.equal(output.stdout, '')
    assert.equal(output.stderr, 'SECRET_SCAN_ERROR: secret scan could not complete.\n')
    assert.ok(!output.stderr.includes(notARepo))
    assert.ok(!output.stderr.includes('fatal'))
  } finally {
    rmSync(notARepo, { recursive: true, force: true })
  }
})

test('binary content is scanned in full rather than silently passed', () => {
  withRepo((repo) => {
    writeFileSync(
      join(repo, 'blob.bin'),
      Buffer.concat([
        Buffer.from([0, 1, 2, 0]),
        Buffer.from(`padding\n${SYNTHETIC_AWS_KEY}\n`),
        Buffer.from([0, 0]),
      ]),
    )
    commitAll(repo)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'findings')
    assert.ok(report.scannedPaths.includes('blob.bin'))
    assert.deepEqual(
      report.findings.map((f) => [f.code, f.file, f.line]),
      [['AWS_ACCESS_KEY_ID', 'blob.bin', 2]],
    )
  })
})

test('an oversized candidate fails closed instead of passing on a prefix', () => {
  withRepo((repo) => {
    writeFileSync(join(repo, 'kept.ts'), 'export const value = 1\n')
    // Larger than the module will read: it cannot be scanned in full, so it
    // must not be counted as clean.
    writeFileSync(join(repo, 'huge.log'), Buffer.alloc(MAX_SCANNABLE_BYTES + 1, 0x61))
    commitAll(repo)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'unscannable')
    assert.deepEqual(report.findings, [])
    assert.deepEqual(
      report.unscannable.map((u) => [u.code, u.file]),
      [['OVERSIZED_FILE', 'huge.log']],
    )
    assert.ok(!report.scannedPaths.includes('huge.log'))

    const output = formatSecretScanOutput(report)
    assert.equal(output.exitCode, 1)
    assert.ok(output.stderr.includes('OVERSIZED_FILE huge.log'))
  })
})

test('a secret past the old per-line cutoff is still detected', () => {
  withRepo((repo) => {
    // One single line: the secret sits well beyond the 4096-character prefix
    // the scanner used to truncate each line to.
    const padded = `const filler = '${'x'.repeat(8000)}${SYNTHETIC_AWS_KEY}'\n`
    writeFileSync(join(repo, 'longline.ts'), padded)
    commitAll(repo)

    const report = runSecretScan(repo)
    assert.equal(report.status, 'findings')
    assert.deepEqual(
      report.findings.map((f) => [f.code, f.file, f.line]),
      [['AWS_ACCESS_KEY_ID', 'longline.ts', 1]],
    )

    const detected = detectInText(`\n\n${padded}`, 'longline.ts')
    assert.deepEqual(
      detected.map((f) => f.line),
      [3],
    )
  })
})

test('unsafe, traversing, or control-character repository paths are rejected', () => {
  assert.equal(isSafeRepositoryPath('src/security/releaseSecretScan.ts'), true)
  assert.equal(isSafeRepositoryPath('../outside.txt'), false)
  assert.equal(isSafeRepositoryPath('src/../../outside.txt'), false)
  assert.equal(isSafeRepositoryPath('/etc/hosts'), false)
  assert.equal(isSafeRepositoryPath('.git/config'), false)
  assert.equal(isSafeRepositoryPath(''), false)
  assert.equal(isSafeRepositoryPath('a\u0000b'), false)
  assert.equal(isSafeRepositoryPath('a\nb.txt'), false)
  assert.equal(isSafeRepositoryPath('a\rb.txt'), false)
  assert.equal(isSafeRepositoryPath('a\tb.txt'), false)
  assert.equal(isSafeRepositoryPath('a\u001b[31mb.txt'), false)
  assert.equal(isSafeRepositoryPath('a\u007fb.txt'), false)
  assert.equal(isSafeRepositoryPath('a\u0085b.txt'), false)
  assert.equal(isSafeRepositoryPath('a\u2028b.txt'), false)
  assert.equal(isSafeRepositoryPath('a\u2029b.txt'), false)
  // A name Git could not decode as UTF-8 cannot be reopened or printed safely.
  assert.equal(isSafeRepositoryPath('a\ufffdb.txt'), false)
  assert.equal(isSafeRepositoryPath('a\ud800b.txt'), false)
  assert.equal(isSafeRepositoryPath('a'.repeat(4097)), false)
})

test('each detector reports at most one bounded finding per file', () => {
  const text = `${SYNTHETIC_AWS_KEY}\n${SYNTHETIC_AWS_KEY}\n${SYNTHETIC_API_KEY}\n`
  const findings = detectInText(text, 'fixture.txt')
  assert.deepEqual(
    findings.map((f) => [f.code, f.line]),
    [
      ['AWS_ACCESS_KEY_ID', 1],
      ['API_SECRET_KEY', 3],
    ],
  )
})
