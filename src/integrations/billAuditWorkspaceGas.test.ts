import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

async function loadFunctions() {
  const source = await readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../integrations/google-apps-script/bill-audit-workspace.gs',
    ),
    'utf8',
  )
  const fetchPayloads: Array<Record<string, unknown>> = []
  const context = vm.createContext({
    console,
    UrlFetchApp: {
      fetch: (_url: string, params: { payload: Record<string, unknown> }) => {
        fetchPayloads.push(params.payload)
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            text: 'synthetic',
            language: 'hi',
            segments: [{ start: 0, end: 1, speaker: 'A', text: 'synthetic' }],
          }),
        }
      },
    },
  })
  vm.runInContext(
    `${source}\nglobalThis.__billAuditTest = { validateRecordingUrl_, ensureSheetCapacity_, transcribe_, billingDecision_, categoryChargeDecision_, roundKserveDuration_, evaluateConsensus_, dataRowCount_, auditResultHeaders_, billingHeaders_, canonicalRuleRows_ };`,
    context,
  )
  const functions = context.__billAuditTest as {
    validateRecordingUrl_: (value: string) => void
    ensureSheetCapacity_: (
      sheet: {
        getMaxRows: () => number
        getMaxColumns: () => number
        insertRowsAfter: (after: number, count: number) => void
        insertColumnsAfter: (after: number, count: number) => void
      },
      row: number,
      column: number,
    ) => void
    transcribe_: (apiKey: string, model: string, blob: object, guidance: string) => {
      language: string
      model: string
    }
    billingDecision_: (result: Record<string, unknown>, recordedDurationMs: number) => {
      charge: { policyCode: string; serviceEndMs: number; graceMs: number; adjustedChargeableDurationMs: number }
      rounded: { billableDurationMs: number; billableMinutes: number; amountPaise: number; ruleCode: string }
    }
    categoryChargeDecision_: (result: Record<string, unknown>, recordedDurationMs: number) => {
      policyCode: string; serviceEndMs: number; graceMs: number; adjustedChargeableDurationMs: number
    }
    roundKserveDuration_: (durationMs: number) => {
      billableDurationMs: number; billableMinutes: number; amountPaise: number; ruleCode: string
    }
    evaluateConsensus_: (results: Array<Record<string, unknown>>, durationMs: number) => {
      status: string; reasons: string[]; billableDurationMs: number | null
    }
    dataRowCount_: (sheet: object) => number
    auditResultHeaders_: () => string[]
    billingHeaders_: () => string[]
    canonicalRuleRows_: () => unknown[][]
  }
  return { functions, fetchPayloads }
}

test('accepts the Unpod signed-URL endpoint used by KServe recordings', async () => {
  const { functions } = await loadFunctions()
  assert.doesNotThrow(() => functions.validateRecordingUrl_(
    'https://unpod.ai/api/v1/media/download-signed-url/?url=https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/synthetic.ogg',
  ))
  assert.doesNotThrow(() => functions.validateRecordingUrl_(
    'https://media.unpod.ai/path/to/recording',
  ))
})

test('rejects non-HTTPS, deceptive and non-Unpod recording hosts', async () => {
  const { functions } = await loadFunctions()
  for (const value of [
    'http://unpod.ai/recording',
    'https://unpod.ai.example.test/recording',
    'https://unpod.ai@example.test/recording',
    'https://example.test/recording',
    'not-a-url',
  ]) {
    assert.throws(() => functions.validateRecordingUrl_(value))
  }
})

test('grows output sheets in chunks before writes exceed their grids', async () => {
  const { functions } = await loadFunctions()
  let rows = 1000
  let columns = 23
  const insertedRows: Array<[number, number]> = []
  const insertedColumns: Array<[number, number]> = []
  const sheet = {
    getMaxRows: () => rows,
    getMaxColumns: () => columns,
    insertRowsAfter: (after: number, count: number) => {
      insertedRows.push([after, count])
      rows += count
    },
    insertColumnsAfter: (after: number, count: number) => {
      insertedColumns.push([after, count])
      columns += count
    },
  }

  functions.ensureSheetCapacity_(sheet, 1001, 25)

  assert.deepEqual(insertedRows, [[1000, 1000]])
  assert.deepEqual(insertedColumns, [[23, 2]])
  assert.equal(rows, 2000)
  assert.equal(columns, 25)
})

test('does not send the unsupported prompt field to the diarization model', async () => {
  const { functions, fetchPayloads } = await loadFunctions()

  functions.transcribe_('synthetic-key', 'gpt-4o-transcribe-diarize', {}, 'guidance')

  assert.equal(fetchPayloads.length, 1)
  assert.equal(fetchPayloads[0].model, 'gpt-4o-transcribe-diarize')
  assert.equal(fetchPayloads[0].response_format, 'diarized_json')
  assert.equal(fetchPayloads[0].chunking_strategy, 'auto')
  assert.equal('prompt' in fetchPayloads[0], false)
})

test('keeps prompt guidance for whisper transcription', async () => {
  const { functions, fetchPayloads } = await loadFunctions()

  const result = functions.transcribe_('synthetic-key', 'whisper-1', {}, 'guidance')

  assert.equal(fetchPayloads.length, 1)
  assert.equal(fetchPayloads[0].prompt, 'guidance')
  assert.equal(fetchPayloads[0].response_format, 'verbose_json')
  assert.equal(result.language, 'hi')
  assert.equal(result.model, 'whisper-1')
})

test('locks the canonical output shapes and all twelve categories', async () => {
  const { functions } = await loadFunctions()
  assert.equal(functions.auditResultHeaders_().length, 43)
  assert.equal(functions.billingHeaders_().length, 24)
  const categories = functions.canonicalRuleRows_().map((row) => row[1])
  assert.deepEqual(Array.from(categories), [
    'TIME_DURATION', 'AGENT_FAILURE', 'CONNECT_NOT_FRUITFUL', 'INACTIVE_CALL',
    'INCORRECT_CALL_DURATION', 'AI_CONVERSATION_HANDLING', 'VOICEMAIL',
    'AI_TO_AI', 'NETWORK_FAILURE_TELECOM', 'USER_SILENCE', 'JUNK_CALL', 'OK',
  ])
})

test('charges agent failure only for an exact mid-conversation failure', async () => {
  const { functions } = await loadFunctions()

  const mid = functions.billingDecision_({
    category_code: 'AGENT_FAILURE',
    agent_failure_mode: 'mid_conversation',
    meaningful_service_before_failure: true,
    failure_start_ms: 70_000,
  }, 120_000)
  assert.deepEqual({ ...mid.charge }, {
    policyCode: 'AGENT_FAILURE_MID_CONVERSATION_PLUS_30S',
    serviceEndMs: 70_000,
    graceMs: 30_000,
    adjustedChargeableDurationMs: 100_000,
  })
  assert.equal(mid.rounded.billableMinutes, 2)
  assert.equal(mid.rounded.amountPaise, 1900)

  for (const result of [
    { category_code: 'AGENT_FAILURE', agent_failure_mode: 'start' },
    { category_code: 'AGENT_FAILURE', agent_failure_mode: 'mid_conversation', meaningful_service_before_failure: false, failure_start_ms: 70_000 },
    { category_code: 'AGENT_FAILURE', agent_failure_mode: 'mid_conversation', meaningful_service_before_failure: true, failure_start_ms: 0 },
  ]) {
    assert.equal(functions.billingDecision_(result, 120_000).rounded.amountPaise, 0)
  }
})

test('ports every category endpoint and grace rule from KAudit', async () => {
  const { functions } = await loadFunctions()
  const duration = 180_000
  const fixtures: Array<[Record<string, unknown>, string, number, number]> = [
    [{ category_code: 'OK', last_customer_exchange_ms: 40_000 }, 'STANDARD_CUSTOMER_PLUS_GRACE', 60_000, 100_000],
    [{ category_code: 'CONNECT_NOT_FRUITFUL', last_customer_exchange_ms: 40_000 }, 'STANDARD_CUSTOMER_PLUS_GRACE', 60_000, 100_000],
    [{ category_code: 'TIME_DURATION', last_customer_exchange_ms: 40_000 }, 'STANDARD_CUSTOMER_PLUS_GRACE', 60_000, 100_000],
    [{ category_code: 'USER_SILENCE', last_agent_exchange_ms: 20_000 }, 'USER_SILENCE_AGENT_PLUS_GRACE', 60_000, 80_000],
    [{ category_code: 'VOICEMAIL', last_agent_exchange_ms: 10_000, last_voicemail_exchange_ms: 25_000 }, 'VOICEMAIL_SERVICE_PLUS_30S', 30_000, 55_000],
    [{ category_code: 'AI_TO_AI' }, 'AI_TO_AI_GRACE_ONLY', 60_000, 60_000],
    [{ category_code: 'JUNK_CALL', last_business_customer_exchange_ms: 15_000 }, 'JUNK_BUSINESS_INTERACTION_PLUS_GRACE', 60_000, 75_000],
    [{ category_code: 'INCORRECT_CALL_DURATION', last_verified_interaction_ms: 35_000 }, 'VERIFIED_INTERACTION_PLUS_GRACE', 60_000, 95_000],
    [{ category_code: 'INACTIVE_CALL' }, 'MANAGEMENT_ZERO_CATEGORY', 0, 0],
    [{ category_code: 'AI_CONVERSATION_HANDLING' }, 'MANAGEMENT_ZERO_CATEGORY', 0, 0],
    [{ category_code: 'NETWORK_FAILURE_TELECOM' }, 'MANAGEMENT_ZERO_CATEGORY', 0, 0],
  ]
  for (const [input, code, grace, adjusted] of fixtures) {
    const decision = functions.categoryChargeDecision_(input, duration)
    assert.equal(decision.policyCode, code)
    assert.equal(decision.graceMs, grace)
    assert.equal(decision.adjustedChargeableDurationMs, adjusted)
  }
})

test('uses the locked half-minute flat and whole-minute ceiling', async () => {
  const { functions } = await loadFunctions()
  const fixtures: Array<[number, number, number, string]> = [
    [0, 0, 0, 'ZERO_DURATION_NOT_BILLED'],
    [1, 0.5, 475, 'SHORT_CALL_FLAT'],
    [29_999, 0.5, 475, 'SHORT_CALL_FLAT'],
    [30_000, 1, 950, 'PER_MINUTE_CEIL'],
    [60_000, 1, 950, 'PER_MINUTE_CEIL'],
    [60_001, 2, 1900, 'PER_MINUTE_CEIL'],
    [120_001, 3, 2850, 'PER_MINUTE_CEIL'],
  ]
  for (const [ms, minutes, paise, rule] of fixtures) {
    const rounded = functions.roundKserveDuration_(ms)
    assert.equal(rounded.billableMinutes, minutes)
    assert.equal(rounded.amountPaise, paise)
    assert.equal(rounded.ruleCode, rule)
  }
})

test('consensus includes category, customer speech and rounded duration', async () => {
  const { functions } = await loadFunctions()
  const base = {
    category_code: 'OK', customer_spoke: true, confidence: 0.9,
    last_customer_exchange_ms: 20_000,
  }
  assert.equal(functions.evaluateConsensus_([base, { ...base, confidence: 0.85 }], 120_000).status, 'accepted')
  const durationConflict = functions.evaluateConsensus_([
    base,
    { ...base, last_customer_exchange_ms: 70_000 },
  ], 180_000)
  assert.equal(durationConflict.status, 'unresolved')
  assert.equal(durationConflict.reasons.includes('BILLABLE_DURATION_DISAGREEMENT'), true)
})

test('counts real Task-ID rows instead of prefilled formulas in other columns', async () => {
  const { functions } = await loadFunctions()
  const sheet = {
    getMaxRows: () => 2000,
    getRange: (row: number, column: number, rowCount: number, columnCount: number) => {
      assert.equal(row, 5)
      assert.equal(column, 1)
      assert.equal(rowCount, 1996)
      assert.equal(columnCount, 1)
      return {
        createTextFinder: (pattern: string) => {
          assert.equal(pattern, '.+')
          return {
            useRegularExpression: (enabled: boolean) => {
              assert.equal(enabled, true)
              return { findPrevious: () => ({ getRow: () => 9 }) }
            },
          }
        },
      }
    },
  }

  assert.equal(functions.dataRowCount_(sheet), 5)
})
