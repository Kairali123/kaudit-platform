import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

/**
 * Static contract for the one-shot Call Audit batch CLI.
 *
 * It is static for the same reason the secure-dashboard startup contract is:
 * `run-call-audit-batch.ts` is an entry point that opens a connection pool and
 * invokes the run at module scope, so importing it from a test would reach a
 * database and a paid provider. What matters about an entry point is the ORDER
 * and the SHAPE of the decisions it makes once, and both are readable from the
 * source without executing it.
 *
 * Four invariants are under guard:
 *
 *   1. the execute gate is deny-by-default, exact, and comes FIRST — before a
 *      pool, a credential read, a model client, or the orchestrator;
 *   2. every input that decides which calls get audited is named and required,
 *      with no minted idempotency key and no inferred boundary;
 *   3. the five accepted adapters, the active rule detail, and the real model
 *      factory are what reach `runCallAuditBatch`;
 *   4. nothing printed can carry content — the summary line is an explicit
 *      allowlist and no thrown value is ever read.
 */

const CLI_URL = new URL('./run-call-audit-batch.ts', import.meta.url)
const CLI_SOURCE = readFileSync(CLI_URL, 'utf8')
const PACKAGE_JSON = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { scripts: Record<string, string> }

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
  assert.notEqual(start, -1, `run-call-audit-batch.ts must declare ${name}`)
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

/** Position within `main`, so an import line never stands in for a call site. */
function positionInMain(needle: string): number {
  const at = MAIN.indexOf(needle)
  assert.notEqual(at, -1, `main must contain ${needle}`)
  return at
}

// ---------------------------------------------------------------------------
// 1. The execute gate
// ---------------------------------------------------------------------------

test('the mode is compared byte-exactly to EXECUTE, with no trim or case folding', () => {
  assert.match(CLI_CODE, /mode: 'KAUDIT_CALL_AUDIT_BATCH_MODE'/)
  assert.match(CLI_CODE, /const EXECUTE_MODE = 'EXECUTE'/)
  assert.match(MAIN, /if \(process\.env\[ENV\.mode\] !== EXECUTE_MODE\) \{/)

  // The decisive check: the text BETWEEN the environment read and the constant
  // is the comparison and nothing else. Reintroducing `?.trim()`, a `??`, a
  // `||`, or a normaliser on the mode read lengthens this span and fails here,
  // because a trimmed gate would arm a paid run on ` EXECUTE `.
  const read = MAIN.indexOf('process.env[ENV.mode]')
  assert.notEqual(read, -1, 'main must read the mode from the environment')
  const constant = MAIN.indexOf('EXECUTE_MODE', read)
  assert.equal(
    MAIN.slice(read, constant + 'EXECUTE_MODE'.length),
    'process.env[ENV.mode] !== EXECUTE_MODE',
    'the raw mode value must be compared to EXECUTE_MODE untouched',
  )

  // And nowhere else: the mode is read exactly once, and no line in the file
  // pairs it with a trim or pairs a trim with the gate constant.
  assert.equal([...CLI_CODE.matchAll(/process\.env\[ENV\.mode\]/g)].length, 1)
  assert.equal(/ENV\.mode[^\n]*trim/.test(CLI_CODE), false)
  assert.equal(/trim\(\)[^\n]*EXECUTE_MODE/.test(CLI_CODE), false)

  // Case folding would accept `execute`, and a fallback would let an unset
  // variable stand in for consent. Neither exists anywhere in the file.
  assert.equal(/toLowerCase/.test(CLI_CODE), false)
  assert.equal(/toUpperCase/.test(CLI_CODE), false)
})

test('only the arming gate is untrimmed; the other inputs still trim', () => {
  // The correction is about consent, not about tolerating operator whitespace
  // everywhere. A period boundary or an idempotency key copied out of a ticket
  // may still arrive padded, and each of those readers keeps its trim.
  assert.match(functionBody('requiredText'), /process\.env\[name\]\?\.trim\(\)/)
  assert.match(functionBody('optionalText'), /process\.env\[name\]\?\.trim\(\)/)
  assert.match(
    functionBody('optionalPositiveInteger'),
    /process\.env\[name\]\?\.trim\(\)/,
  )
  assert.match(MAIN, /process\.env\[ENV\.apiKey\]\?\.trim\(\)/)
})

test('a mode that is not EXECUTE throws before anything is built', () => {
  const gate = positionInMain('!== EXECUTE_MODE')
  for (const later of [
    'createOpenAiCallAuditModel(',
    'runCallAuditBatch(',
    'mysql.createPool(',
    'loadRuntimeConfig(',
    'process.env[ENV.apiKey]',
  ]) {
    assert.ok(
      gate < positionInMain(later),
      `the execute gate must precede ${later}`,
    )
  }
})

test('the gate has no escape hatch', () => {
  // Exactly one comparison arms the run, and the refusal is unconditional.
  const gateBlock = MAIN.slice(
    positionInMain('!== EXECUTE_MODE'),
    positionInMain('!== EXECUTE_MODE') + 200,
  )
  assert.match(gateBlock, /throw new CallAuditBatchCliError\(\s*BATCH_CLI_ERROR_CODES\.modeNotExecute/)
  assert.equal([...MAIN.matchAll(/EXECUTE_MODE/g)].length, 1)
})

test('the credential is required only after the gate and the active rule', () => {
  const key = positionInMain('process.env[ENV.apiKey]')
  assert.ok(positionInMain('!== EXECUTE_MODE') < key)
  assert.ok(positionInMain('getActiveRuleVersion()') < key)
  assert.ok(positionInMain('getRuleVersionDetail(') < key)
  // And the model client is built only after the credential check.
  assert.ok(key < positionInMain('createOpenAiCallAuditModel('))
})

test('a missing active rule version or detail stops the run', () => {
  assert.match(MAIN, /if \(!active\) \{[\s\S]{0,120}noActiveRule/)
  assert.match(MAIN, /if \(!detail\) \{[\s\S]{0,140}activeRuleDetailMissing/)
})

// ---------------------------------------------------------------------------
// 2. Named, explicit inputs
// ---------------------------------------------------------------------------

test('every period, source, and run input is a named environment variable', () => {
  for (const name of [
    'KAUDIT_CALL_AUDIT_BATCH_MODE',
    'KAUDIT_CALL_AUDIT_RUN_TYPE',
    'KAUDIT_CALL_AUDIT_PERIOD_START',
    'KAUDIT_CALL_AUDIT_PERIOD_END_EXCLUSIVE',
    'KAUDIT_CALL_AUDIT_PERIOD_TIMEZONE',
    'KAUDIT_CALL_AUDIT_SOURCE_START',
    'KAUDIT_CALL_AUDIT_SOURCE_END_EXCLUSIVE',
    'KAUDIT_CALL_AUDIT_IDEMPOTENCY_KEY',
    'KAUDIT_CALL_AUDIT_BATCH_SIZE',
    'KAUDIT_CALL_AUDIT_MAX_PAGES',
    'KAUDIT_CALL_AUDIT_MAX_CANDIDATES',
    'KAUDIT_CALL_AUDIT_CORRELATION_ID',
    'KAUDIT_CALL_AUDIT_TRIGGERED_BY',
  ]) {
    assert.ok(CLI_CODE.includes(`'${name}'`), `${name} must be read by name`)
  }
})

test('the calendar period and the source window are both required', () => {
  for (const field of [
    'ENV.periodStart',
    'ENV.periodEndExclusive',
    'ENV.windowStart',
    'ENV.windowEndExclusive',
  ]) {
    assert.match(
      MAIN,
      new RegExp(`requiredText\\(${field.replace('.', '\\.')}\\)`),
      `${field} must be required, not defaulted`,
    )
  }
  // The two are passed separately: the source window is never derived from the
  // calendar period, because that conversion is scheduling.
  assert.match(MAIN, /sourceWindow: \{\s*periodStart: windowStart,\s*periodEndExclusive: windowEndExclusive,/)
})

test('the idempotency key is required and never minted', () => {
  assert.match(MAIN, /requiredText\(ENV\.idempotencyKey\)/)
  // No generator of any kind: a fresh key on every invocation would create a
  // second paid run over a period that already has one.
  assert.equal(/randomUUID|randomBytes|Math\.random|crypto/.test(CLI_CODE), false)
})

test('the run type is checked against the control repository vocabulary', () => {
  assert.match(
    CLI_CODE,
    /import \{[\s\S]*?RUN_TYPES,[\s\S]*?\} from '\.\.\/adapters\/mysqlCallAuditControl\.ts'/,
  )
  assert.match(functionBody('requiredRunType'), /RUN_TYPES as readonly string\[\]\)\.includes\(value\)/)
  // The vocabulary itself is not restated here.
  for (const word of ['manual', 'backfill', 'quarterly', 'yearly']) {
    assert.equal(
      CLI_CODE.includes(`'${word}'`),
      false,
      `the run type ${word} must come from RUN_TYPES, not a local copy`,
    )
  }
})

test('the period timezone defaults to the control repository default', () => {
  assert.match(
    CLI_CODE,
    /import \{[\s\S]*?DEFAULT_PERIOD_TIMEZONE,[\s\S]*?\} from '\.\.\/adapters\/mysqlCallAuditControl\.ts'/,
  )
  assert.match(MAIN, /optionalText\(ENV\.periodTimezone\) \?\? DEFAULT_PERIOD_TIMEZONE/)
  assert.equal(
    CLI_CODE.includes("'Asia/Kolkata'"),
    false,
    'the default zone must be imported, not restated',
  )
})

test('the optional limits parse as positive integers only', () => {
  const parser = functionBody('optionalPositiveInteger')
  assert.match(parser, /\/\^\[1-9\]\[0-9\]\*\$\//)
  assert.match(parser, /Number\.isSafeInteger/)
  assert.match(parser, /BATCH_CLI_ERROR_CODES\.invalidInput/)
  // A small default keeps the first page of a mistaken run cheap.
  const fallback = CLI_CODE.match(/const DEFAULT_BATCH_SIZE = (\d+)/)
  assert.ok(fallback)
  assert.ok(Number(fallback[1]) <= 50)
})

// ---------------------------------------------------------------------------
// 3. The wiring
// ---------------------------------------------------------------------------

test('the five accepted adapters are imported from their accepted modules', () => {
  for (const [factory, module] of [
    ['createMysqlCallAuditControlRepository', '../adapters/mysqlCallAuditControl.ts'],
    ['createMysqlCallAuditPersistenceRepository', '../adapters/mysqlCallAuditPersistence.ts'],
    ['createMysqlCallAuditSourceReader', '../adapters/mysqlCallAuditSource.ts'],
    ['createMysqlCallAuditSettingsRepository', '../adapters/mysqlCallAuditSettings.ts'],
    ['createOpenAiCallAuditModel', '../adapters/openaiCallAuditClient.ts'],
  ] as const) {
    assert.ok(
      CLI_CODE.includes(factory),
      `${factory} must be wired by the CLI`,
    )
    assert.ok(
      CLI_CODE.includes(`'${module}'`),
      `${factory} must come from ${module}`,
    )
  }
})

test('one pool is created and every repository shares it', () => {
  assert.equal([...CLI_CODE.matchAll(/mysql\.createPool\(/g)].length, 1)
  assert.match(CLI_CODE, /import \{ loadRuntimeConfig \} from '\.\.\/config\/runtime\.ts'/)
  assert.match(MAIN, /host: config\.database\.host/)
  assert.match(MAIN, /ssl,/)
  assert.match(MAIN, /decimalNumbers: false/)
  for (const factory of [
    'createMysqlCallAuditControlRepository',
    'createMysqlCallAuditPersistenceRepository',
    'createMysqlCallAuditSourceReader',
    'createMysqlCallAuditSettingsRepository',
  ]) {
    assert.match(MAIN, new RegExp(`${factory}\\(pool\\)`))
  }
})

test('the orchestrator receives the repositories, the model, and the active rule', () => {
  const call = MAIN.slice(positionInMain('runCallAuditBatch({'))
  assert.match(call, /control: createMysqlCallAuditControlRepository\(pool\)/)
  assert.match(call, /source: createMysqlCallAuditSourceReader\(pool\)/)
  assert.match(call, /persistence: createMysqlCallAuditPersistenceRepository\(pool\)/)
  assert.match(call, /\bmodel,/)
  // Provenance is composite: the run row and the results must cite one contract.
  assert.match(call, /ruleVersionId: detail\.ruleVersionId,/)
  assert.match(call, /activation,/)
  assert.match(call, /timestamps: \{ now: utcNaiveNow \}/)
})

test('the activation is built only from stored active-rule fields', () => {
  const activation = MAIN.slice(
    positionInMain('const activation: ActivatedContentAuditModel = {'),
    positionInMain('let model'),
  )
  for (const field of [
    'versionLabel',
    'businessPrompt',
    'modelProvider',
    'modelName',
    'modelVersion',
    'temperature',
  ]) {
    assert.match(
      activation,
      new RegExp(`${field}: detail\\.${field},`),
      `${field} must come from the stored active rule version`,
    )
  }
  // No literal model, temperature, or instruction text is invented here.
  assert.equal(/gpt-|temperature: '/.test(activation), false)
})

test('the model is constructed at exactly one call site', () => {
  assert.equal(
    [...MAIN.matchAll(/createOpenAiCallAuditModel\(/g)].length,
    1,
  )
  assert.match(MAIN, /createOpenAiCallAuditModel\(apiKey\)/)
})

test('the pool is always closed', () => {
  assert.match(MAIN, /\} finally \{[\s\S]{0,200}await pool\.end\(\)/)
})

// ---------------------------------------------------------------------------
// 4. Privacy of everything printed
// ---------------------------------------------------------------------------

test('the summary line is an explicit allowlist, not a spread', () => {
  const line = functionBody('safeSummaryLine')
  for (const field of [
    'runId',
    'runCreateOutcome',
    'terminalStatus',
    'failureCode',
    'stopReason',
    'pagesRead',
    'candidatesSelected',
    'candidatesProcessed',
    'counts',
  ]) {
    assert.ok(line.includes(`${field}:`), `${field} must be reported`)
  }
  // A spread would let a future summary field reach stdout unreviewed.
  assert.equal(/\.\.\./.test(line), false)
})

test('nothing content-bearing appears in the printed summary', () => {
  const line = functionBody('safeSummaryLine')
  for (const forbidden of [
    /transcript/i,
    /prompt/i,
    /\braw\b/i,
    /provider/i,
    /\blead\b/i,
    /\btask\b/i,
    /\bsource\b/i,
    /url/i,
    /phone/i,
    /email/i,
    /amount|money|price|invoice|charge|rupee|inr/i,
  ]) {
    assert.equal(
      forbidden.test(line),
      false,
      `the summary line must not carry ${forbidden}`,
    )
  }
})

test('no thrown value is ever read, formatted, or logged', () => {
  // Only two typed shapes are recognised, and only their bounded code and field
  // name are taken. Everything else collapses to one opaque code.
  const chooser = functionBody('safeFailureCode')
  assert.match(chooser, /instanceof CallAuditBatchCliError/)
  assert.match(chooser, /instanceof CallAuditBatchRunError/)
  assert.match(chooser, /BATCH_CLI_ERROR_CODES\.unexpected/)

  for (const forbidden of [
    /console\./,
    /String\(\s*error/,
    /error\.message/,
    /error\.stack/,
    /JSON\.stringify\(\s*error/,
    /util\.inspect/,
    /\$\{error/,
  ]) {
    assert.equal(
      forbidden.test(CLI_CODE),
      false,
      `the CLI must not do ${forbidden}`,
    )
  }
})

test('every catch in the entry point discards its value', () => {
  // `catch {` with no binding: nothing about a driver, repository, or provider
  // fault is knowable after it, so nothing about it can be printed.
  assert.equal(/catch\s*\(/.test(CLI_CODE), false)
  assert.ok([...CLI_CODE.matchAll(/\} catch \{/g)].length >= 3)
})

test('the failure line prints a bounded code and at most an input name', () => {
  const handler = CLI_CODE.slice(CLI_CODE.indexOf('(error: unknown) => {'))
  assert.match(handler, /safeFailureCode\(error\)/)
  assert.match(handler, /field=\$\{field\}/)
  assert.match(handler, /process\.exitCode = 1/)
})

test('a settled-but-failed run still exits nonzero', () => {
  assert.match(
    CLI_CODE,
    /process\.exitCode = summary\.terminalStatus === 'completed' \? 0 : 1/,
  )
})

test('the error codes are bounded uppercase machine codes', () => {
  const table = CLI_CODE.slice(
    CLI_CODE.indexOf('const BATCH_CLI_ERROR_CODES'),
    CLI_CODE.indexOf('} as const', CLI_CODE.indexOf('const BATCH_CLI_ERROR_CODES')),
  )
  const codes = [...table.matchAll(/'([^']+)'/g)].map((match) => match[1])
  assert.ok(codes.length >= 8)
  for (const value of codes) {
    assert.match(value, /^[A-Z][A-Z0-9_]*$/)
  }
})

// ---------------------------------------------------------------------------
// 5. Scope: one shot, nothing else
// ---------------------------------------------------------------------------

test('the CLI adds no scheduler, watch loop, server, or report', () => {
  for (const forbidden of [
    /setInterval/,
    /setTimeout/,
    /cron/i,
    /\bwatch\b/i,
    /createServer/,
    /nodemailer|sendMail|smtp/i,
    /writeFile/,
  ]) {
    assert.equal(
      forbidden.test(CLI_CODE),
      false,
      `a one-shot CLI must not involve ${forbidden}`,
    )
  }
  // One invocation of the orchestrator, called once, with no loop around it.
  assert.equal([...CLI_CODE.matchAll(/runCallAuditBatch\(/g)].length, 1)
  assert.equal(/\bfor \(|\bwhile \(/.test(MAIN), false)
})

test('the CLI writes nothing to the external source table', () => {
  assert.equal(/ai_voice_leads_received/.test(CLI_CODE), false)
  assert.equal(/INSERT|UPDATE|DELETE|ALTER/.test(CLI_CODE), false)
})

test('the CLI touches no billing money', () => {
  assert.equal(/billing|invoice|amount|price|money/i.test(CLI_CODE), false)
})

// ---------------------------------------------------------------------------
// 6. It is runnable and it is tested
// ---------------------------------------------------------------------------

test('package.json exposes the one-shot script with the env-file flags', () => {
  const script = PACKAGE_JSON.scripts['callaudit:batch']
  assert.ok(script, 'package.json must define callaudit:batch')
  assert.match(script, /src\/cli\/run-call-audit-batch\.ts$/)
  assert.match(script, /--env-file-if-exists=\.env\b/)
  assert.match(script, /--env-file-if-exists=\.env\.local\b/)
  assert.match(script, /--env-file-if-exists=\$HOME\/\.kcrm-audit\/\.env\.local/)
  // The gate is not baked into the script: arming a paid run is a deliberate
  // act at the command line, not something `npm run` decides.
  assert.equal(/KAUDIT_CALL_AUDIT_BATCH_MODE/.test(script), false)
})

test('test:callaudit runs this contract', () => {
  assert.match(
    PACKAGE_JSON.scripts['test:callaudit'],
    /src\/cli\/runCallAuditBatchCli\.test\.ts/,
  )
})
