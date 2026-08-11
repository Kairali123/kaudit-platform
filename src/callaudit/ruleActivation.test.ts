import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  buildRuleActivation,
  buildScoringConfigDocument,
  businessPromptSha256,
} from './ruleActivation.ts'
import {
  CallAuditRuleError,
  OUTPUT_SCHEMA_VERSION,
  RULE_CONTRACT_VERSION,
  SCORING_CONFIG_VERSION,
  TAXONOMY_VERSION,
} from './ruleContract.ts'
import { CALL_AUDIT_RUBRIC } from './rubric.ts'
import { DETAILED_OUTCOME_DEFINITIONS } from './outcomes.ts'

const BUSINESS_PROMPT = 'Focus on discovery quality and confirming a next step.'

/** Synthetic draft only; no real prompt, model key, or customer data. */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versionLabel: 'call-audit/2026.08.1',
    businessPrompt: BUSINESS_PROMPT,
    modelProvider: 'openai',
    modelName: 'gpt-4o-mini',
    modelVersion: 'gpt-4o-mini-2024-07-18',
    temperature: '0.2',
    ...overrides,
  }
}

const sha256 = (value: string) =>
  createHash('sha256').update(value).digest('hex')

// ---------------------------------------------------------------------------
// Snapshot shape
// ---------------------------------------------------------------------------

test('builds a snapshot matching the migration 0008 rule-version columns', () => {
  const activation = buildRuleActivation(draft())
  assert.deepEqual(Object.keys(activation).sort(), [
    'businessPrompt',
    'configSha256',
    'modelName',
    'modelProvider',
    'modelVersion',
    'outputSchemaVersion',
    'promptSha256',
    'ruleContractVersion',
    'scoringConfigJson',
    'scoringConfigVersion',
    'taxonomyVersion',
    'temperature',
    'versionLabel',
  ])
  assert.equal(activation.versionLabel, 'call-audit/2026.08.1')
  assert.equal(activation.businessPrompt, BUSINESS_PROMPT)
  assert.equal(activation.temperature, '0.200')
  assert.equal(activation.outputSchemaVersion, OUTPUT_SCHEMA_VERSION)
  assert.equal(activation.taxonomyVersion, TAXONOMY_VERSION)
  assert.equal(activation.scoringConfigVersion, SCORING_CONFIG_VERSION)
  assert.equal(activation.ruleContractVersion, RULE_CONTRACT_VERSION)
})

test('generates no id, actor, timestamp, or lifecycle status', () => {
  const activation = buildRuleActivation(draft()) as unknown as Record<string, unknown>
  for (const field of [
    'id',
    'status',
    'createdAt',
    'createdBy',
    'activatedAt',
    'activatedBy',
    'retiredAt',
    'retiredBy',
    'updatedAt',
  ]) {
    assert.equal(field in activation, false, `${field} must not be generated here`)
  }
})

test('validates the draft before building anything', () => {
  for (const bad of [
    draft({ versionLabel: '' }),
    draft({ businessPrompt: '   ' }),
    draft({ temperature: '2.5' }),
    draft({ temperature: 0.2 }),
    draft({ modelName: 'a'.repeat(101) }),
  ]) {
    assert.throws(() => buildRuleActivation(bad), CallAuditRuleError)
  }
})

// ---------------------------------------------------------------------------
// Prompt hash
// ---------------------------------------------------------------------------

test('promptSha256 hashes the exact accepted prompt bytes', () => {
  const activation = buildRuleActivation(draft())
  assert.equal(activation.promptSha256, sha256(BUSINESS_PROMPT))
  assert.equal(activation.promptSha256, businessPromptSha256(BUSINESS_PROMPT))
  assert.match(activation.promptSha256, /^[0-9a-f]{64}$/)

  // The accepted prompt is the trimmed one, so the hash covers what is stored.
  const padded = buildRuleActivation(
    draft({ businessPrompt: `  ${BUSINESS_PROMPT}  ` }),
  )
  assert.equal(padded.businessPrompt, BUSINESS_PROMPT)
  assert.equal(padded.promptSha256, activation.promptSha256)
})

test('any prompt change changes promptSha256', () => {
  const baseline = buildRuleActivation(draft()).promptSha256
  for (const businessPrompt of [
    `${BUSINESS_PROMPT}.`,
    `${BUSINESS_PROMPT} `.trim() + ' Also confirm budget.',
    BUSINESS_PROMPT.replace('discovery', 'Discovery'),
    BUSINESS_PROMPT.replace('.', '!'),
  ]) {
    assert.notEqual(
      buildRuleActivation(draft({ businessPrompt })).promptSha256,
      baseline,
      `${businessPrompt} must produce a new prompt hash`,
    )
  }
})

// ---------------------------------------------------------------------------
// Config hash
// ---------------------------------------------------------------------------

test('the activation persists the bumped 2.0.0 contract identities', () => {
  const activation = buildRuleActivation(draft())
  assert.equal(activation.ruleContractVersion, 'call-audit-contract/2.0.0')
  assert.equal(activation.outputSchemaVersion, 'call-audit-output/2.0.0')
  assert.equal(activation.taxonomyVersion, 'call-audit-taxonomy/2.0.0')
  // Metric arithmetic did not change, so scoring stays at 1.0.0.
  assert.equal(activation.scoringConfigVersion, 'call-audit-scoring/1.0.0')

  const parsed = JSON.parse(activation.scoringConfigJson) as Record<
    string,
    unknown
  >
  assert.equal(parsed.ruleContractVersion, 'call-audit-contract/2.0.0')
  assert.equal(parsed.outputSchemaVersion, 'call-audit-output/2.0.0')
  assert.equal(parsed.taxonomyVersion, 'call-audit-taxonomy/2.0.0')
})

test('the config binds all 53 labels with their exact descriptions', () => {
  const parsed = JSON.parse(
    buildRuleActivation(draft()).scoringConfigJson,
  ) as Record<string, unknown>
  const taxonomy = parsed.taxonomy as Record<string, unknown>
  const outcomes = taxonomy.detailedOutcomes as Array<Record<string, string>>

  assert.equal(outcomes.length, 53)
  outcomes.forEach((entry, index) => {
    const definition = DETAILED_OUTCOME_DEFINITIONS[index]
    assert.equal(entry.label, definition.label, `label ${index + 1}`)
    assert.equal(entry.description, definition.description, definition.label)
  })
  // The compliance set is bound too, so widening it is a contract change.
  assert.deepEqual(taxonomy.noContactOutcomes, [
    'Outreach Stopped',
    "DNC Client : Don't Call Furthur",
  ])
  // No superseded label survives anywhere in the locked config.
  for (const superseded of [
    "DNC Client: Don't Call Further",
    'Assign to MR',
    'Wants Details Over Email',
  ]) {
    assert.equal(
      buildRuleActivation(draft()).scoringConfigJson.includes(superseded),
      false,
      `${superseded} must not appear in the config`,
    )
  }
})

test('scoringConfigJson is canonical JSON and configSha256 hashes it', () => {
  const activation = buildRuleActivation(draft())
  assert.match(activation.configSha256, /^[0-9a-f]{64}$/)
  assert.equal(activation.configSha256, sha256(activation.scoringConfigJson))
  const parsed = JSON.parse(activation.scoringConfigJson) as Record<string, unknown>
  assert.equal(parsed.ruleContractVersion, RULE_CONTRACT_VERSION)
  assert.equal(parsed.evidence, 'transcript_only')
})

test('the config document carries the locked contract, not the prompt', () => {
  const activation = buildRuleActivation(draft())
  assert.equal(
    activation.scoringConfigJson.includes(BUSINESS_PROMPT),
    false,
    'the editable prompt must not be inside the config hash',
  )
  assert.equal(activation.scoringConfigJson.includes('businessPrompt'), false)

  const parsed = JSON.parse(activation.scoringConfigJson) as Record<string, unknown>
  const rubric = parsed.rubric as Record<string, unknown>
  assert.equal(rubric.totalWeight, 100)
  assert.equal((rubric.metrics as unknown[]).length, CALL_AUDIT_RUBRIC.length)
  const taxonomy = parsed.taxonomy as Record<string, unknown>
  assert.equal((taxonomy.detailedOutcomes as unknown[]).length, 53)
  assert.ok(parsed.outputSchema)
  const derivation = parsed.derivation as Record<string, unknown>
  assert.equal(derivation.groupedOutcome, 'application_derived_from_detailed_outcome')
  assert.equal(derivation.overallScore, 'application_calculated_weighted_percentage')
})

test('changing the prompt does not change configSha256', () => {
  const first = buildRuleActivation(draft())
  const second = buildRuleActivation(
    draft({ businessPrompt: 'Completely different guidance for auditors.' }),
  )
  assert.notEqual(first.promptSha256, second.promptSha256)
  assert.equal(first.configSha256, second.configSha256)
  assert.equal(first.scoringConfigJson, second.scoringConfigJson)
})

test('model metadata and temperature never masquerade as contract config', () => {
  const baseline = buildRuleActivation(draft())
  for (const overrides of [
    { modelProvider: 'anthropic' },
    { modelName: 'some-other-model' },
    { modelVersion: 'some-other-version' },
    { temperature: '1.750' },
  ]) {
    const changed = buildRuleActivation(draft(overrides))
    assert.equal(
      changed.configSha256,
      baseline.configSha256,
      `${JSON.stringify(overrides)} must not change the config hash`,
    )
    assert.equal(changed.promptSha256, baseline.promptSha256)
  }
  // They remain explicit on the snapshot.
  const swapped = buildRuleActivation(
    draft({ modelName: 'some-other-model', temperature: '1.750' }),
  )
  assert.equal(swapped.modelName, 'some-other-model')
  assert.equal(swapped.temperature, '1.750')

  const serialized = buildRuleActivation(draft()).scoringConfigJson
  for (const leak of ['openai', 'gpt-4o-mini', 'temperature', '0.200']) {
    assert.equal(
      serialized.includes(leak),
      false,
      `${leak} must not be inside the config document`,
    )
  }
})

test('a contract configuration change would change configSha256', () => {
  const baseline = buildRuleActivation(draft()).configSha256
  const document = buildScoringConfigDocument() as Record<string, unknown>

  // Simulate contract drift without touching the accepted modules.
  const mutated = {
    ...document,
    rubric: {
      ...(document.rubric as Record<string, unknown>),
      totalWeight: 99,
    },
  }
  assert.notEqual(sha256(JSON.stringify(mutated)), baseline)

  const taxonomyDrift = {
    ...document,
    taxonomy: {
      ...(document.taxonomy as Record<string, unknown>),
      detailedOutcomes: [...DETAILED_OUTCOME_DEFINITIONS].slice(0, 52),
    },
  }
  assert.notEqual(sha256(JSON.stringify(taxonomyDrift)), baseline)

  // A reworded description must move the hash just as a renamed label does.
  const descriptionDrift = {
    ...document,
    taxonomy: {
      ...(document.taxonomy as Record<string, unknown>),
      detailedOutcomes: DETAILED_OUTCOME_DEFINITIONS.map(
        (definition, index) => ({
          label: definition.label,
          description: index === 0 ? 'reworded' : definition.description,
        }),
      ),
    },
  }
  assert.notEqual(sha256(JSON.stringify(descriptionDrift)), baseline)
})

// ---------------------------------------------------------------------------
// Determinism and privacy
// ---------------------------------------------------------------------------

test('identical input produces byte-identical output and hashes', () => {
  const first = buildRuleActivation(draft())
  const second = buildRuleActivation(draft())
  assert.deepEqual(first, second)
  assert.equal(first.scoringConfigJson, second.scoringConfigJson)
  assert.equal(first.promptSha256, second.promptSha256)
  assert.equal(first.configSha256, second.configSha256)
  assert.equal(JSON.stringify(first), JSON.stringify(second))
})

test('the config document is stable across repeated builds', () => {
  assert.equal(
    JSON.stringify(buildScoringConfigDocument()),
    JSON.stringify(buildScoringConfigDocument()),
  )
})

test('nothing in the snapshot carries customer data', () => {
  const activation = buildRuleActivation(draft())
  const serialized = JSON.stringify(activation)
  for (const leak of ['Caller:', 'Customer:', 'transcript"', '9876543210', '@example']) {
    assert.equal(
      serialized.includes(leak),
      false,
      `the snapshot must not contain ${leak}`,
    )
  }
  // No URL at all now that the schema declares no $schema dialect: the
  // Structured Outputs subset does not include it.
  const urls = serialized.match(/https?:\\?\/\\?\/[^"\\]*/g) ?? []
  assert.deepEqual(urls, [])
  assert.equal(serialized.includes('json-schema.org'), false)
})

test('the two hashes are independent and both are required', () => {
  const activation = buildRuleActivation(draft())
  assert.notEqual(activation.promptSha256, activation.configSha256)
  assert.match(activation.promptSha256, /^[0-9a-f]{64}$/)
  assert.match(activation.configSha256, /^[0-9a-f]{64}$/)
})
