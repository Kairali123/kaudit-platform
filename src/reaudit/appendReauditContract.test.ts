import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

const workerCli = await readFile(
  new URL('../cli/run-reaudit-worker.ts', import.meta.url),
  'utf8',
)
const writer = await readFile(
  new URL('../adapters/mysqlReauditWriteRepo.ts', import.meta.url),
  'utf8',
)

test('append re-audit is scope-bound and explicitly armed', () => {
  assert.match(workerCli, /appendReauditValue !== 'APPEND'/)
  assert.match(workerCli, /appendReaudit && !taskIds/)
  assert.match(workerCli, /allowPreviouslyClassified: appendReaudit/)
  assert.match(workerCli, /allowCompletedReaudit: appendReaudit/)
})

test('calls already completed under the deployed ruleset are excluded', () => {
  assert.match(
    workerCli,
    /includePreviouslyClassified: appendReaudit/,
  )
  assert.match(
    writer,
    /c\.outcome_taxonomy_version = \?/,
  )
})

test('append re-audit keeps a prior success current when the new attempt fails', () => {
  const failureBranch = writer.slice(
    writer.indexOf("result.outcome !== 'projected'"),
    writer.indexOf('const analysis = result.analysis'),
  )
  assert.match(
    failureBranch,
    /if \(allowCompletedReaudit\)[\s\S]*return 'terminal_failure'/,
  )
  assert.doesNotMatch(
    failureBranch.slice(
      failureBranch.indexOf('if (allowCompletedReaudit)'),
      failureBranch.indexOf("return 'terminal_failure'") + 25,
    ),
    /UPDATE kaudit_call(?:_artifact)?/,
  )
})

test('a successful append re-audit advances the latest-run pointer', () => {
  assert.match(writer, /latest_audit_run_id = \?/)
  assert.match(writer, /outcome_taxonomy_version = \?/)
})
