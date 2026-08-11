import { fileURLToPath } from 'node:url'
import { formatSecretScanOutput, runSecretScan } from '../src/security/releaseSecretScan.ts'

// Scans the full release candidate set (tracked plus untracked/nonignored files)
// from the repository root. Output is code/path only — never matched content.
const repoRoot = fileURLToPath(new URL('..', import.meta.url))

let output
try {
  output = formatSecretScanOutput(runSecretScan(repoRoot))
} catch {
  output = {
    stdout: '',
    stderr: 'SECRET_SCAN_ERROR: secret scan could not complete.\n',
    exitCode: 1,
  }
}

if (output.stdout) process.stdout.write(output.stdout)
if (output.stderr) process.stderr.write(output.stderr)
process.exit(output.exitCode)
