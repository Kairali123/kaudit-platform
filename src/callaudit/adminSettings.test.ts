import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  applicationConfigSha256,
  buildCallAuditSettings,
  naiveUtcTimestamp,
  parseCallAuditSettingsCreate,
  parseCallAuditSettingsQuery,
  toCreateResultDto,
  toRuleVersionDto,
  CallAuditSettingsQueryError,
  CallAuditSettingsRequestError,
  CALL_AUDIT_SETTINGS_PAGE_ROUTE,
  CALL_AUDIT_SETTINGS_ROUTE,
  DEFAULT_RUN_LIMIT,
  DEFAULT_VERSION_LIMIT,
  MAX_RUN_LIMIT,
  MAX_VERSION_LIMIT,
  type CallAuditRuleVersionDetailRecord,
  type CallAuditRuleVersionRecord,
  type CallAuditRunSummaryRecord,
  type CallAuditSettingsReadPort,
} from './adminSettings.ts'
import { CallAuditRuleError, RULE_CONTRACT_VERSION } from './ruleContract.ts'
import { buildRuleActivation } from './ruleActivation.ts'

/**
 * The admin settings read model and create request.
 *
 * Every fixture below is synthetic and administrator-authored: there is no
 * transcript, lead identifier, phone, email, URL, provider response, or money
 * value anywhere in this file, and none of the shapes under test has a place to
 * put one.
 */

const SYNTHETIC_PROMPT =
  'Assess each conversation against the approved rubric. Report only the ' +
  'structured fields the output schema defines. Never invent facts.'

function versionRecord(
  overrides: Partial<CallAuditRuleVersionRecord> = {},
): CallAuditRuleVersionRecord {
  const snapshot = buildRuleActivation({
    versionLabel: 'call-audit/2026.08.1',
    businessPrompt: SYNTHETIC_PROMPT,
    modelProvider: 'synthetic-provider',
    modelName: 'synthetic-model',
    modelVersion: '2026-08-01',
    temperature: '0.200',
  })
  return {
    ruleVersionId: 'crv_synthetic0001',
    versionLabel: snapshot.versionLabel,
    status: 'draft',
    promptSha256: snapshot.promptSha256,
    modelProvider: snapshot.modelProvider,
    modelName: snapshot.modelName,
    modelVersion: snapshot.modelVersion,
    temperature: snapshot.temperature,
    ruleContractVersion: snapshot.ruleContractVersion,
    outputSchemaVersion: snapshot.outputSchemaVersion,
    taxonomyVersion: snapshot.taxonomyVersion,
    scoringConfigVersion: snapshot.scoringConfigVersion,
    configSha256: snapshot.configSha256,
    changeReason: 'Initial draft of the approved guidance.',
    createdBy: 'usr_admin_0001',
    createdAt: '2026-08-01 09:00:00.000000',
    activatedBy: null,
    activatedAt: null,
    retiredBy: null,
    retiredAt: null,
    ...overrides,
  }
}

function runRecord(
  overrides: Partial<CallAuditRunSummaryRecord> = {},
): CallAuditRunSummaryRecord {
  return {
    runId: 'crn_synthetic0001',
    ruleVersionId: 'crv_synthetic0001',
    runType: 'monthly',
    status: 'completed',
    periodStart: '2026-07-01 00:00:00.000000',
    periodEndExclusive: '2026-08-01 00:00:00.000000',
    periodTimezone: 'Asia/Kolkata',
    totalCandidates: 40,
    processedCount: 40,
    succeededCount: 38,
    failedCount: 2,
    skippedCount: 0,
    errorCode: null,
    startedAt: '2026-08-01 01:00:00.000000',
    finishedAt: '2026-08-01 01:22:00.000000',
    ...overrides,
  }
}

interface RecordedRead {
  method: string
  argument: unknown
}

function readPort(
  reads: RecordedRead[],
  options: {
    versions?: CallAuditRuleVersionRecord[]
    active?: CallAuditRuleVersionRecord | null
    detail?: CallAuditRuleVersionDetailRecord | null
    runs?: CallAuditRunSummaryRecord[]
  } = {},
): CallAuditSettingsReadPort {
  return {
    async listRuleVersions(limit) {
      reads.push({ method: 'listRuleVersions', argument: limit })
      return options.versions ?? [versionRecord()]
    },
    async getActiveRuleVersion() {
      reads.push({ method: 'getActiveRuleVersion', argument: null })
      return options.active ?? null
    },
    async getRuleVersionDetail(ruleVersionId) {
      reads.push({ method: 'getRuleVersionDetail', argument: ruleVersionId })
      return options.detail ?? null
    },
    async listRecentRuns(limit) {
      reads.push({ method: 'listRecentRuns', argument: limit })
      return options.runs ?? [runRecord()]
    },
  }
}

function params(query: string): URLSearchParams {
  return new URLSearchParams(query)
}

// ---------------------------------------------------------------------------
// Route identity
// ---------------------------------------------------------------------------

test('the settings surface is its own specific route, not the report route', () => {
  assert.equal(CALL_AUDIT_SETTINGS_ROUTE, '/api/v1/call-audit/settings')
  assert.equal(CALL_AUDIT_SETTINGS_PAGE_ROUTE, '/call-audit/settings')
})

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

test('an absent query defaults to metadata only, with no detail read', () => {
  const query = parseCallAuditSettingsQuery(params(''))
  assert.equal(query.versionLimit, DEFAULT_VERSION_LIMIT)
  assert.equal(query.runLimit, DEFAULT_RUN_LIMIT)
  assert.equal(query.detailRuleVersionId, null)
})

test('list bounds and the detail id grammar are enforced', () => {
  for (const query of [
    `versions=${MAX_VERSION_LIMIT + 1}`,
    'versions=0',
    'versions=2.5',
    `runs=${MAX_RUN_LIMIT + 1}`,
    'runs=-1',
    'detail=crv_0001%20OR%201%3D1',
    "detail=';DROP TABLE",
  ]) {
    assert.throws(
      () => parseCallAuditSettingsQuery(params(query)),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditSettingsQueryError)
        assert.equal(error.code, 'INVALID_CALL_AUDIT_SETTINGS_QUERY')
        assert.equal(error.status, 400)
        return true
      },
      query,
    )
  }
})

test('an explicit detail id is the only way a prompt is ever read', async () => {
  const reads: RecordedRead[] = []
  await buildCallAuditSettings(
    readPort(reads),
    parseCallAuditSettingsQuery(params('')),
  )
  assert.equal(
    reads.some((read) => read.method === 'getRuleVersionDetail'),
    false,
  )

  const detailReads: RecordedRead[] = []
  const detail: CallAuditRuleVersionDetailRecord = {
    ...versionRecord(),
    businessPrompt: SYNTHETIC_PROMPT,
  }
  const dto = await buildCallAuditSettings(
    readPort(detailReads, { detail }),
    parseCallAuditSettingsQuery(params('detail=crv_synthetic0001')),
  )
  assert.equal(
    detailReads.find((read) => read.method === 'getRuleVersionDetail')
      ?.argument,
    'crv_synthetic0001',
  )
  assert.equal(dto.detail?.businessPrompt, SYNTHETIC_PROMPT)
  assert.equal(dto.detail?.businessPromptLength, SYNTHETIC_PROMPT.length)
})

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

test('the read model reports lifecycle, contract identity, and hashes', async () => {
  const active = versionRecord({
    ruleVersionId: 'crv_synthetic0002',
    versionLabel: 'call-audit/2026.08.2',
    status: 'active',
    activatedBy: 'usr_admin_0002',
    activatedAt: '2026-08-02 10:00:00.000000',
  })
  const dto = await buildCallAuditSettings(
    readPort([], { active, versions: [active, versionRecord()] }),
    parseCallAuditSettingsQuery(params('')),
    new Date('2026-08-05T00:00:00.000Z'),
  )
  assert.equal(dto.title, 'Call Audit Rule Settings')
  assert.equal(dto.generatedAt, '2026-08-05T00:00:00.000Z')
  assert.equal(dto.activeVersion?.versionLabel, 'call-audit/2026.08.2')
  assert.equal(dto.activeVersion?.statusLabel, 'Active')
  assert.equal(dto.activeVersion?.isActive, true)
  assert.equal(dto.activeVersion?.temperature, '0.200')
  assert.equal(dto.activeVersion?.matchesApplicationContract, true)
  assert.equal(dto.versions[1]?.statusLabel, 'Draft')
  assert.equal(dto.versionCount, 2)
  assert.equal(dto.contract.ruleContractVersion, RULE_CONTRACT_VERSION)
  assert.equal(dto.contract.configSha256, applicationConfigSha256())
  assert.equal(dto.contract.temperatureDecimals, 3)
  // A live contract means a create may not also activate: activation appends a
  // new snapshot and is refused while another version is active.
  assert.equal(dto.activationAvailable, false)
})

test('a version from an older locked contract is reported as drifted', () => {
  const stale = versionRecord({
    configSha256: 'a'.repeat(64),
    ruleContractVersion: 'call-audit-contract/1.0.0',
  })
  const dto = toRuleVersionDto(stale, applicationConfigSha256())
  assert.equal(dto.matchesApplicationContract, false)
})

test('a run summary is joined to its version label without a second read', async () => {
  const dto = await buildCallAuditSettings(
    readPort([], { runs: [runRecord(), runRecord({ runId: 'crn_x', ruleVersionId: 'crv_gone' })] }),
    parseCallAuditSettingsQuery(params('')),
  )
  assert.equal(dto.recentRuns[0]?.ruleVersionLabel, 'call-audit/2026.08.1')
  assert.equal(dto.recentRuns[0]?.statusLabel, 'Completed')
  // A run whose rule version is outside the listed page reports null rather
  // than borrowing the wrong label.
  assert.equal(dto.recentRuns[1]?.ruleVersionLabel, null)
})

test('nothing forbidden can appear in the settings read model', async () => {
  const dto = await buildCallAuditSettings(
    readPort([], {
      active: versionRecord({
        status: 'active',
        activatedAt: '2026-08-02 10:00:00.000000',
      }),
      detail: {
        ...versionRecord(),
        businessPrompt: SYNTHETIC_PROMPT,
      },
    }),
    parseCallAuditSettingsQuery(params('detail=crv_synthetic0001')),
  )
  const keys = new Set<string>()
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) walk(entry)
    } else if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value)) {
        keys.add(key)
        walk(entry)
      }
    }
  }
  walk(dto)
  for (const forbidden of [
    'transcript',
    'transcriptSha256',
    'leadId',
    'leadIdSha256',
    'sourceRowId',
    'sourceRefId',
    'sourceUrl',
    'recordingUrl',
    'resultJson',
    'resultSha256',
    'errorDetail',
    'scoringConfigJson',
    'phone',
    'email',
    'amount',
    'amountInr',
    'currency',
    'price',
    'rate',
    'cost',
    'invoice',
  ]) {
    assert.equal(keys.has(forbidden), false, `key ${forbidden} leaked`)
  }
  assert.equal(
    JSON.stringify(dto).includes('ai_voice_leads_received'),
    false,
  )
})

// ---------------------------------------------------------------------------
// Create request
// ---------------------------------------------------------------------------

const validBody = {
  versionLabel: 'call-audit/2026.09.1',
  businessPrompt: SYNTHETIC_PROMPT,
  modelProvider: 'synthetic-provider',
  modelName: 'synthetic-model',
  modelVersion: '2026-09-01',
  temperature: '0.2',
  changeReason: 'Tightened the coaching guidance.',
}

test('a submitted draft is validated by the existing rule contract', () => {
  const request = parseCallAuditSettingsCreate(validBody, 'usr_admin_0001')
  // Normalized to exactly three decimals by the contract helper, never parsed
  // into a binary float on the way through.
  assert.equal(request.settings.temperature, '0.200')
  assert.equal(request.settings.versionLabel, 'call-audit/2026.09.1')
  assert.equal(request.changeReason, 'Tightened the coaching guidance.')
  assert.equal(request.createdBy, 'usr_admin_0001')
  // Draft unless activation is explicitly requested.
  assert.equal(request.activate, false)
})

test('only an explicit boolean true activates', () => {
  assert.equal(
    parseCallAuditSettingsCreate({ ...validBody, activate: true }).activate,
    true,
  )
  assert.equal(
    parseCallAuditSettingsCreate({ ...validBody, activate: false }).activate,
    false,
  )
  assert.throws(
    () => parseCallAuditSettingsCreate({ ...validBody, activate: 'yes' }),
    (error: unknown) => {
      assert.ok(error instanceof CallAuditSettingsRequestError)
      assert.equal(error.field, 'activate')
      return true
    },
  )
})

test('a temperature that is not fixed-precision is refused', () => {
  for (const temperature of [0.2, '0.2001', '2.5', '-0.100', '1e-1', '', ' ']) {
    assert.throws(
      () => parseCallAuditSettingsCreate({ ...validBody, temperature }),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditRuleError)
        assert.equal(error.field, 'temperature')
        return true
      },
      String(temperature),
    )
  }
})

test('a rejected create never echoes the submitted value', () => {
  const secretish = 'DO-NOT-ECHO-THIS-PROMPT'.repeat(2000)
  try {
    parseCallAuditSettingsCreate({
      ...validBody,
      businessPrompt: secretish,
    })
    assert.fail('an over-long prompt must be refused')
  } catch (error) {
    assert.ok(error instanceof CallAuditRuleError)
    assert.equal(error.field, 'businessPrompt')
    assert.equal((error as Error).message.includes('DO-NOT-ECHO'), false)
  }
})

test('a change reason is bounded and control-character free', () => {
  assert.equal(
    parseCallAuditSettingsCreate({ ...validBody, changeReason: '   ' })
      .changeReason,
    null,
  )
  for (const changeReason of ['x'.repeat(501), 'bad reason', 42]) {
    assert.throws(
      () => parseCallAuditSettingsCreate({ ...validBody, changeReason }),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditSettingsRequestError)
        assert.equal(error.field, 'changeReason')
        assert.equal(error.status, 400)
        return true
      },
      String(changeReason),
    )
  }
})

test('a non-object body is refused before any field is read', () => {
  for (const body of [null, undefined, 'draft', 7, []]) {
    assert.throws(
      () => parseCallAuditSettingsCreate(body),
      (error: unknown) => {
        assert.ok(error instanceof CallAuditSettingsRequestError)
        assert.equal(error.field, 'body')
        return true
      },
    )
  }
})

test('an unusable actor id is dropped rather than failing the save', () => {
  assert.equal(parseCallAuditSettingsCreate(validBody, '').createdBy, null)
  assert.equal(
    parseCallAuditSettingsCreate(validBody, 'a'.repeat(41)).createdBy,
    null,
  )
  assert.equal(
    parseCallAuditSettingsCreate(validBody, 'usr admin').createdBy,
    null,
  )
})

// ---------------------------------------------------------------------------
// Timestamps and acknowledgement
// ---------------------------------------------------------------------------

test('an activation stamp is UTC-naive with microsecond precision', () => {
  assert.equal(
    naiveUtcTimestamp(new Date('2026-08-05T14:32:09.123Z')),
    '2026-08-05 14:32:09.123000',
  )
  assert.match(
    naiveUtcTimestamp(),
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{6}$/,
  )
})

test('the create acknowledgement carries status and digests, nothing more', () => {
  const dto = toCreateResultDto({
    ruleVersionId: 'crv_synthetic0003',
    versionLabel: 'call-audit/2026.09.1',
    status: 'active',
    outcome: 'inserted',
    promptSha256: 'b'.repeat(64),
    configSha256: 'c'.repeat(64),
    createdAt: '2026-08-05 14:32:09.123000',
  })
  assert.equal(dto.statusLabel, 'Active')
  assert.equal(dto.activated, true)
  assert.deepEqual(Object.keys(dto).sort(), [
    'activated',
    'configSha256',
    'createdAt',
    'outcome',
    'promptSha256',
    'ruleVersionId',
    'status',
    'statusLabel',
    'versionLabel',
  ])
})
