import { execFileSync, spawnSync } from 'node:child_process'

const tracked = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {
  encoding: 'utf8',
  },
)
  .split('\0')
  .filter(Boolean)
const forbiddenTracked = tracked.filter((file) =>
  /(^|\/)(\.env|\.env\.local)$|\.pem$|\.key$|\.p12$|\.pfx$/i.test(
    file,
  ),
)
if (forbiddenTracked.length) {
  process.stderr.write(
    `Forbidden secret-bearing files are tracked:\n${forbiddenTracked.join('\n')}\n`,
  )
  process.exit(1)
}

const patterns = [
  'BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY',
  'AKIA[0-9A-Z]{16}',
  'sk-[A-Za-z0-9_-]{20,}',
  'mysql://[^[:space:]]+:[^[:space:]]+@',
]
const scan = spawnSync(
  'git',
  ['grep', '-nIE', patterns.join('|'), '--', ...tracked],
  { encoding: 'utf8' },
)
if (scan.status === 0 && scan.stdout.trim()) {
  process.stderr.write(
    `Potential secret material found:\n${scan.stdout}`,
  )
  process.exit(1)
}
if (scan.status !== 0 && scan.status !== 1) {
  process.stderr.write(
    `Secret scan failed to run: ${scan.stderr || 'unknown error'}\n`,
  )
  process.exit(1)
}
process.stdout.write(
  `Secret scan passed (${tracked.length} tracked files checked).\n`,
)
