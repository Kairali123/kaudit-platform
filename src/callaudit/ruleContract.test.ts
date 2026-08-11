import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  CallAuditRuleError,
  MAX_BUSINESS_PROMPT_LENGTH,
  MAX_MODEL_NAME_LENGTH,
  MAX_MODEL_PROVIDER_LENGTH,
  MAX_MODEL_VERSION_LENGTH,
  MAX_VERSION_LABEL_LENGTH,
  normalizeTemperature,
  OUTPUT_SCHEMA_VERSION,
  RULE_CONTRACT_VERSION,
  SCORING_CONFIG_VERSION,
  TAXONOMY_VERSION,
  validateRuleDraft,
} from './ruleContract.ts'

/** Synthetic administrator draft; no real prompt or customer data. */
function draft(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    versionLabel: 'call-audit/2026.08.1',
    businessPrompt: 'Focus on discovery quality and confirming the next step.',
    modelProvider: 'openai',
    modelName: 'gpt-4o-mini',
    modelVersion: 'gpt-4o-mini-2024-07-18',
    temperature: '0.2',
    ...overrides,
  }
}

function expectRuleError(run: () => unknown, message?: string): CallAuditRuleError {
  try {
    run()
  } catch (error) {
    assert.ok(error instanceof CallAuditRuleError, message ?? 'expected a rule error')
    return error as CallAuditRuleError
  }
  assert.fail(message ?? 'expected a CallAuditRuleError to be thrown')
}

// ---------------------------------------------------------------------------
// Version constants
// ---------------------------------------------------------------------------

test('exposes stable version identities owned by the application', () => {
  // The taxonomy replacement was a breaking locked-contract change, so the
  // contract, schema, and taxonomy identities moved to 2.0.0. Scoring stayed
  // at 1.0.0 because the metric arithmetic did not change.
  assert.equal(RULE_CONTRACT_VERSION, 'call-audit-contract/2.0.0')
  assert.equal(OUTPUT_SCHEMA_VERSION, 'call-audit-output/2.0.0')
  assert.equal(TAXONOMY_VERSION, 'call-audit-taxonomy/2.0.0')
  assert.equal(SCORING_CONFIG_VERSION, 'call-audit-scoring/1.0.0')
  for (const version of [
    RULE_CONTRACT_VERSION,
    OUTPUT_SCHEMA_VERSION,
    TAXONOMY_VERSION,
    SCORING_CONFIG_VERSION,
  ]) {
    // The columns are varchar(40).
    assert.ok(version.length <= 40, `${version} exceeds the column width`)
  }
})

test('a draft cannot override a version identity', () => {
  const validated = validateRuleDraft(
    draft({ outputSchemaVersion: 'attacker/9', taxonomyVersion: 'attacker/9' }),
  )
  assert.equal('outputSchemaVersion' in validated, false)
  assert.equal('taxonomyVersion' in validated, false)
})

// ---------------------------------------------------------------------------
// Draft validation
// ---------------------------------------------------------------------------

test('accepts and trims a well-formed draft', () => {
  const validated = validateRuleDraft(
    draft({
      versionLabel: '  call-audit/2026.08.1  ',
      businessPrompt: '  Focus on discovery quality.  ',
    }),
  )
  assert.equal(validated.versionLabel, 'call-audit/2026.08.1')
  assert.equal(validated.businessPrompt, 'Focus on discovery quality.')
  assert.equal(validated.modelProvider, 'openai')
  assert.equal(validated.modelName, 'gpt-4o-mini')
  assert.equal(validated.modelVersion, 'gpt-4o-mini-2024-07-18')
  assert.equal(validated.temperature, '0.200')
})

test('rejects a non-object draft', () => {
  for (const value of [null, undefined, 'draft', 42, []]) {
    const error = expectRuleError(() => validateRuleDraft(value))
    assert.equal(error.field, 'root')
  }
})

test('enforces the migration 0008 column widths', () => {
  const cases: Array<[string, number]> = [
    ['versionLabel', MAX_VERSION_LABEL_LENGTH],
    ['modelProvider', MAX_MODEL_PROVIDER_LENGTH],
    ['modelName', MAX_MODEL_NAME_LENGTH],
    ['modelVersion', MAX_MODEL_VERSION_LENGTH],
  ]
  for (const [field, maxLength] of cases) {
    assert.equal(
      (validateRuleDraft(draft({ [field]: 'a'.repeat(maxLength) })) as unknown as Record<
        string,
        unknown
      >)[field],
      'a'.repeat(maxLength),
    )
    const error = expectRuleError(
      () => validateRuleDraft(draft({ [field]: 'a'.repeat(maxLength + 1) })),
      `${field} must enforce ${maxLength}`,
    )
    assert.equal(error.field, field)
  }
  assert.deepEqual(
    [
      MAX_VERSION_LABEL_LENGTH,
      MAX_MODEL_PROVIDER_LENGTH,
      MAX_MODEL_NAME_LENGTH,
      MAX_MODEL_VERSION_LENGTH,
    ],
    [80, 80, 100, 100],
  )
})

test('rejects blank or non-string identifiers', () => {
  for (const field of [
    'versionLabel',
    'modelProvider',
    'modelName',
    'modelVersion',
    'businessPrompt',
  ]) {
    for (const value of ['', '   ', '\t\n', 42, null, undefined, {}, []]) {
      const error = expectRuleError(
        () => validateRuleDraft(draft({ [field]: value })),
        `${field}=${JSON.stringify(value)} must be rejected`,
      )
      assert.equal(error.field, field)
    }
  }
})

test('rejects control characters in identifiers and settings', () => {
  for (const field of [
    'versionLabel',
    'modelProvider',
    'modelName',
    'modelVersion',
  ]) {
    for (const value of [
      'call\u0000audit',
      'call\u001baudit',
      'call\naudit',
      'call\taudit',
      'call\u007faudit',
    ]) {
      const error = expectRuleError(
        () => validateRuleDraft(draft({ [field]: value })),
        `${field} must reject control characters`,
      )
      assert.equal(error.field, field)
    }
  }
})

// ---------------------------------------------------------------------------
// Business prompt
// ---------------------------------------------------------------------------

test('bounds the business prompt and documents the maximum', () => {
  assert.equal(MAX_BUSINESS_PROMPT_LENGTH, 20_000)
  assert.equal(
    validateRuleDraft(
      draft({ businessPrompt: 'x'.repeat(MAX_BUSINESS_PROMPT_LENGTH) }),
    ).businessPrompt.length,
    MAX_BUSINESS_PROMPT_LENGTH,
  )
  const error = expectRuleError(() =>
    validateRuleDraft(
      draft({ businessPrompt: 'x'.repeat(MAX_BUSINESS_PROMPT_LENGTH + 1) }),
    ),
  )
  assert.equal(error.field, 'businessPrompt')
})

test('the business prompt keeps newlines and tabs but rejects other controls', () => {
  const multiline = 'Line one.\n\tIndented line two.\nLine three.'
  assert.equal(
    validateRuleDraft(draft({ businessPrompt: multiline })).businessPrompt,
    multiline,
  )
  for (const value of [
    'Guidance\u0000here',
    'Guidance\u0007here',
    'Guidance\u001bhere',
    'Guidance\u009fhere',
  ]) {
    const error = expectRuleError(() =>
      validateRuleDraft(draft({ businessPrompt: value })),
    )
    assert.equal(error.field, 'businessPrompt')
  }
})

// ---------------------------------------------------------------------------
// Temperature
// ---------------------------------------------------------------------------

test('normalizes an accepted temperature to exactly three decimals', () => {
  const cases: Array<[string, string]> = [
    ['0', '0.000'],
    ['0.0', '0.000'],
    ['0.00', '0.000'],
    ['0.000', '0.000'],
    ['0.2', '0.200'],
    ['0.25', '0.250'],
    ['0.125', '0.125'],
    ['1', '1.000'],
    ['1.5', '1.500'],
    ['2', '2.000'],
    ['2.0', '2.000'],
    ['2.000', '2.000'],
    ['  0.7  ', '0.700'],
  ]
  for (const [input, expected] of cases) {
    assert.equal(normalizeTemperature(input), expected, `${input} -> ${expected}`)
    assert.equal(
      validateRuleDraft(draft({ temperature: input })).temperature,
      expected,
    )
  }
})

test('every normalized temperature has exactly three decimal places', () => {
  for (const input of ['0', '0.5', '1.25', '2']) {
    assert.match(normalizeTemperature(input), /^\d\.\d{3}$/)
  }
})

test('rejects a numeric temperature so no binary float becomes authoritative', () => {
  for (const value of [0, 0.2, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
    const error = expectRuleError(
      () => normalizeTemperature(value),
      `${String(value)} must be rejected`,
    )
    assert.equal(error.field, 'temperature')
    assert.match(error.message, /not a number/)
  }
})

test('rejects signs, exponents, and excess precision', () => {
  for (const value of [
    '+1',
    '+0.5',
    '-0.5',
    '-1',
    '1e0',
    '1E0',
    '1e-3',
    '0.2e1',
    '0.1234',
    '1.0001',
    '.5',
    '1.',
    '01',
    '00.5',
    '1,5',
    '0x1',
    ' 1 . 5 ',
  ]) {
    const error = expectRuleError(
      () => normalizeTemperature(value),
      `${value} must be rejected`,
    )
    assert.equal(error.field, 'temperature')
  }
})

test('rejects NaN-like and blank text', () => {
  for (const value of ['NaN', 'nan', 'Infinity', '-Infinity', 'null', 'undefined', '', '   ', 'warm']) {
    const error = expectRuleError(
      () => normalizeTemperature(value),
      `${value} must be rejected`,
    )
    assert.equal(error.field, 'temperature')
  }
})

test('rejects a temperature outside 0.000 through 2.000', () => {
  for (const value of ['2.001', '2.1', '3', '10', '9.999', '100.000']) {
    const error = expectRuleError(
      () => normalizeTemperature(value),
      `${value} must be rejected`,
    )
    assert.equal(error.field, 'temperature')
    assert.match(error.message, /between 0\.000 and 2\.000/)
  }
})

test('accepts both range boundaries exactly', () => {
  assert.equal(normalizeTemperature('0.000'), '0.000')
  assert.equal(normalizeTemperature('2.000'), '2.000')
  assert.equal(normalizeTemperature('1.999'), '1.999')
})

test('preserves the administrator digits exactly, to the last place', () => {
  // Values with no exact binary representation must round-trip unchanged.
  for (const value of [
    '0.001',
    '0.003',
    '0.007',
    '0.029',
    '0.1',
    '0.3',
    '1.005',
    '1.115',
    '1.999',
  ]) {
    const normalized = normalizeTemperature(value)
    const [whole, fraction = ''] = value.split('.')
    assert.equal(normalized, `${whole}.${fraction.padEnd(3, '0')}`)
  }
})

test('the temperature path performs no floating-point arithmetic', () => {
  // A behavioural test cannot separate BigInt digits from Math.round(x * 1000)
  // across this narrow range, so the prohibition is pinned at the source: no
  // float ever becomes the authority for a stored decimal(4,3).
  const source = readFileSync(
    new URL('./ruleContract.ts', import.meta.url),
    'utf8',
  )
  for (const forbidden of [
    /\bNumber\s*\(/,
    /\bparseFloat\s*\(/,
    /\bparseInt\s*\(/,
    /\bMath\.(round|floor|ceil|trunc)\s*\(/,
    /\btoFixed\s*\(/,
  ]) {
    assert.equal(
      forbidden.test(source),
      false,
      `ruleContract.ts must not use ${forbidden} on a temperature`,
    )
  }
  assert.match(source, /BigInt\(whole\) \* 1000n \+ BigInt\(fraction\)/)
})

// ---------------------------------------------------------------------------
// Safe errors
// ---------------------------------------------------------------------------

test('errors are typed, field-specific, and echo no submitted value', () => {
  const secret =
    'Saanvi: hello Ms Synthetic, is 9876543210 still your number? SECRET-GUIDANCE'
  const cases: Array<Record<string, unknown>> = [
    { businessPrompt: `${secret}\u0000` },
    { businessPrompt: secret.repeat(1000) },
    // Each identifier case violates a different rule, so the messages differ.
    { versionLabel: `${secret}\u0000` },
    { versionLabel: secret.repeat(4) },
    { modelProvider: `${secret}\u001b` },
    { modelName: secret.repeat(4) },
    { modelVersion: `${secret}\u007f` },
    { temperature: `${secret}` },
  ]
  for (const overrides of cases) {
    const error = expectRuleError(() => validateRuleDraft(draft(overrides)))
    assert.equal(error.code, 'INVALID_CALL_AUDIT_RULE_DRAFT')
    const text = `${error.message}\n${error.stack ?? ''}`
    assert.equal(text.includes('SECRET-GUIDANCE'), false)
    assert.equal(text.includes('Saanvi'), false)
    assert.equal(text.includes('9876543210'), false)
  }
})

test('validation is deterministic', () => {
  assert.deepEqual(validateRuleDraft(draft()), validateRuleDraft(draft()))
})
