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
  const fetchRequests: Array<{
    url: string
    headers: Record<string, string>
    payload: Record<string, unknown>
  }> = []
  const context = vm.createContext({
    console,
    UrlFetchApp: {
      fetch: (url: string, params: {
        headers: Record<string, string>
        payload: Record<string, unknown>
      }) => {
        fetchRequests.push({ url, headers: params.headers, payload: params.payload })
        return {
          getResponseCode: () => 200,
          getContentText: () => JSON.stringify({
            text: 'synthetic',
            language_code: 'hin',
            words: [
              { type: 'word', start: 0, end: 0.4, text: 'synthetic' },
              { type: 'spacing', text: ' ' },
              { type: 'word', start: 0.5, end: 1, text: 'call' },
            ],
          }),
        }
      },
    },
  })
  vm.runInContext(
    `${source}\nglobalThis.__billAuditTest = { validateRecordingUrl_, ensureSheetCapacity_, transcribe_, decodedAudioDurationSeconds_, recordedDurationMs_, billingDecision_, categoryChargeDecision_, roundKserveDuration_, evaluateConsensus_, dataRowCount_, auditResultHeaders_, billingHeaders_, canonicalRuleRows_ };`,
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
    transcribe_: (apiKey: string, model: string, blob: object, audioBytes?: number[]) => {
      language: string
      model: string
      provider: string
      duration_seconds: number
      segments: Array<{ text: string; start_seconds: number; end_seconds: number }>
    }
    decodedAudioDurationSeconds_: (blob: object) => number
    recordedDurationMs_: (transcript: Record<string, unknown>) => number
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
  return { functions, fetchRequests, source }
}

function syntheticWav(durationSeconds = 2) {
  const sampleRate = 8_000
  const channels = 1
  const bitsPerSample = 16
  const dataSize = durationSeconds * sampleRate * channels * (bitsPerSample / 8)
  const bytes = Buffer.alloc(44 + dataSize)
  bytes.write('RIFF', 0)
  bytes.writeUInt32LE(36 + dataSize, 4)
  bytes.write('WAVE', 8)
  bytes.write('fmt ', 12)
  bytes.writeUInt32LE(16, 16)
  bytes.writeUInt16LE(1, 20)
  bytes.writeUInt16LE(channels, 22)
  bytes.writeUInt32LE(sampleRate, 24)
  bytes.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28)
  bytes.writeUInt16LE(channels * (bitsPerSample / 8), 32)
  bytes.writeUInt16LE(bitsPerSample, 34)
  bytes.write('data', 36)
  bytes.writeUInt32LE(dataSize, 40)
  return {
    getBytes: () => Array.from(bytes),
    getContentType: () => 'audio/wav',
  }
}

function syntheticOpusOgg(durationSeconds = 2) {
  const preSkip = 312
  const page = (sequence: number, granule: number, body: Buffer) => {
    const bytes = Buffer.alloc(28 + body.length)
    bytes.write('OggS', 0)
    bytes.writeUInt8(sequence === 0 ? 2 : 4, 5)
    bytes.writeUInt32LE(granule >>> 0, 6)
    bytes.writeUInt32LE(Math.floor(granule / 0x1_0000_0000), 10)
    bytes.writeUInt32LE(1, 14)
    bytes.writeUInt32LE(sequence, 18)
    bytes.writeUInt8(1, 26)
    bytes.writeUInt8(body.length, 27)
    body.copy(bytes, 28)
    return bytes
  }
  const opusHead = Buffer.alloc(19)
  opusHead.write('OpusHead', 0)
  opusHead.writeUInt8(1, 8)
  opusHead.writeUInt8(1, 9)
  opusHead.writeUInt16LE(preSkip, 10)
  opusHead.writeUInt32LE(48_000, 12)
  const endGranule = preSkip + durationSeconds * 48_000
  const bytes = Buffer.concat([
    page(0, 0, opusHead),
    page(1, endGranule, Buffer.from([0])),
  ])
  return {
    getBytes: () => Array.from(bytes),
    getContentType: () => 'audio/ogg',
  }
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

test('workspace upgrade preserves completed audits and accepts their approval states', async () => {
  const { source } = await loadFunctions()
  const upgrade = source.match(/function upgradeWorkspace\(\) \{[\s\S]*?\n\}\n\nfunction upsertSetting_/)?.[0]
  assert.ok(upgrade)
  assert.match(upgrade, /'NOT_REVIEWED','APPROVED','REJECTED','BLOCKED','SUPERSEDED_REAUDIT_REQUIRED'/)
  assert.doesNotMatch(upgrade, /row\[3\]\s*=\s*BILL_AUDIT\.queueStates\.pending/)
  assert.doesNotMatch(upgrade, /row\[14\]\s*=\s*'SUPERSEDED_REAUDIT_REQUIRED'/)
  assert.match(upgrade, /showUiAlertIfAvailable_/)
})

test('upgrade repair restores only rows backed by three completed evidence tables', async () => {
  const { source } = await loadFunctions()
  const repair = source.match(/function restoreCompletedAuditsAfterUpgrade\(\) \{[\s\S]*?\n\}\n\nfunction upsertSetting_/)?.[0]
  assert.ok(repair)
  assert.match(repair, /String\(row\[9\] \|\| ''\) !== 'REAUDIT_REQUIRED'/)
  assert.match(repair, /monthlyRow\[16\].*BILL_AUDIT\.queueStates\.completed/)
  assert.match(repair, /!completedResults\[taskId\] \|\| !billingByTask\[taskId\]/)
  assert.match(repair, /row\[3\] = BILL_AUDIT\.queueStates\.completed/)
  assert.match(repair, /row\[9\] = 'BILLING_CALCULATED'/)
})

test('selected-row audit is isolated from the pending queue', async () => {
  const { source } = await loadFunctions()
  const selectedRunner = source.match(/function runSelectedAuditRow\(\) \{[\s\S]*?\n\}\n\nfunction auditQueueItem_/)?.[0]
  assert.ok(selectedRunner)
  assert.match(selectedRunner, /activeRange\.getNumRows\(\) !== 1/)
  assert.match(selectedRunner, /queueSheet\.getRange\(rowNumber, 1, 1, 13\)/)
  assert.match(selectedRunner, /auditQueueItem_\(queueRow/)
  assert.doesNotMatch(selectedRunner, /runAuditBatch\(/)
  assert.doesNotMatch(selectedRunner, /scheduleContinuation_\(/)
})

test('sends Scribe v2 audio with Creator-plan provider logging enabled', async () => {
  const { functions, fetchRequests } = await loadFunctions()
  const blob = syntheticWav()

  const result = functions.transcribe_('synthetic-elevenlabs-key', 'scribe_v2', blob)

  assert.equal(fetchRequests.length, 1)
  assert.equal(fetchRequests[0].url, 'https://api.elevenlabs.io/v1/speech-to-text?enable_logging=true')
  assert.equal(fetchRequests[0].headers['xi-api-key'], 'synthetic-elevenlabs-key')
  assert.equal(fetchRequests[0].payload.model_id, 'scribe_v2')
  assert.equal(fetchRequests[0].payload.file, blob)
  assert.equal(fetchRequests[0].payload.timestamps_granularity, 'word')
  assert.equal(fetchRequests[0].payload.diarize, 'false')
  assert.equal('prompt' in fetchRequests[0].payload, false)
  assert.equal(result.provider, 'elevenlabs')
  assert.equal(result.language, 'hin')
  assert.equal(result.model, 'scribe_v2')
  assert.equal(result.duration_seconds, 2)
  assert.equal(result.segments[0].text, 'synthetic call')
})

test('uses decoded source duration instead of the final transcript timestamp', async () => {
  const { functions } = await loadFunctions()
  const durationSeconds = functions.decodedAudioDurationSeconds_(syntheticWav(2))
  assert.equal(durationSeconds, 2)
  assert.equal(functions.recordedDurationMs_({
    duration_seconds: durationSeconds,
    segments: [{ start_seconds: 0, end_seconds: 1, text: 'synthetic' }],
  }), 2_000)
})

test('decodes the full duration of the OGG/Opus format used by call recordings', async () => {
  const { functions } = await loadFunctions()
  assert.equal(functions.decodedAudioDurationSeconds_(syntheticOpusOgg(2)), 2)
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
