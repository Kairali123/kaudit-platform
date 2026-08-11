import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  buildContentAuditSchema,
  CONTENT_AUDIT_JSON_SCHEMA,
  SCHEMA_FORBIDDEN_FIELDS,
  STRUCTURED_OUTPUT_FORBIDDEN_KEYWORDS,
} from './modelSchema.ts'
import {
  CallAuditOutputError,
  validateContentAuditOutput,
} from './modelOutput.ts'
import {
  CONTENT_AUDIT_OUTPUT_KEYS,
  ISSUE_FLAGS,
  MAX_FEEDBACK_LENGTH,
  NEXT_ACTION_CODES,
  QUALIFICATIONS,
} from './modelOutput.ts'
import type { MetricScore } from './types.ts'
import { DETAILED_OUTCOMES } from './outcomes.ts'
import { CALL_AUDIT_RUBRIC } from './rubric.ts'
import { CALL_INTENTS } from './types.ts'

type Json = Record<string, unknown>

const schema = CONTENT_AUDIT_JSON_SCHEMA as Json
const properties = schema.properties as Json

function property(name: string): Json {
  return properties[name] as Json
}

/** Every object node in the schema, for blanket strictness assertions. */
function objectNodes(node: unknown, found: Json[] = []): Json[] {
  if (!node || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const item of node) objectNodes(item, found)
    return found
  }
  const record = node as Json
  if (record.type === 'object') found.push(record)
  for (const value of Object.values(record)) objectNodes(value, found)
  return found
}

test('is JSON serializable and stable across builds', () => {
  const first = JSON.stringify(buildContentAuditSchema())
  const second = JSON.stringify(buildContentAuditSchema())
  assert.equal(first, second)
  assert.equal(first, JSON.stringify(CONTENT_AUDIT_JSON_SCHEMA))
  assert.deepEqual(JSON.parse(first), CONTENT_AUDIT_JSON_SCHEMA)
})

test('requires exactly the accepted output fields', () => {
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, [...CONTENT_AUDIT_OUTPUT_KEYS])
  assert.deepEqual(Object.keys(properties), [...CONTENT_AUDIT_OUTPUT_KEYS])
  assert.equal(properties.length, undefined)
})

test('every object node forbids additional properties', () => {
  const nodes = objectNodes(schema)
  // The root plus the single shared metric-entry schema. One reusable item
  // schema replaced the eight position-pinned tuple entries.
  assert.equal(nodes.length, 2)
  for (const node of nodes) {
    assert.equal(
      node.additionalProperties,
      false,
      `an object node allows additional properties: ${JSON.stringify(node).slice(0, 80)}`,
    )
    assert.ok(Array.isArray(node.required), 'every object node must list required keys')
    assert.deepEqual(
      (node.required as string[]).slice().sort(),
      Object.keys(node.properties as Json).sort(),
      'every declared property must be required',
    )
  }
})

test('reuses the exact accepted enum constants', () => {
  assert.deepEqual(property('intent').enum, [...CALL_INTENTS])
  assert.equal(property('intent').type, 'string')
  assert.deepEqual(property('detailedOutcome').enum, [...DETAILED_OUTCOMES])
  assert.deepEqual(property('qualification').enum, [...QUALIFICATIONS])
  assert.deepEqual(property('nextAction').enum, [...NEXT_ACTION_CODES])
  assert.equal((property('detailedOutcome').enum as string[]).length, 53)
  assert.ok(
    (property('detailedOutcome').enum as string[]).includes(
      "DNC Client : Don't Call Furthur",
    ),
  )
})

test('the three call facts are booleans', () => {
  for (const field of [
    'callConnected',
    'customerSpoke',
    'meaningfulConversation',
  ]) {
    assert.equal(property(field).type, 'boolean')
  }
})

test('confidence is a bounded number matching the runtime rule', () => {
  const confidence = property('confidence')
  assert.equal(confidence.type, 'number')
  assert.equal(confidence.minimum, 0)
  assert.equal(confidence.maximum, 1)
})

test('metricScores requires exactly eight entries of one strict item schema', () => {
  const metricScores = property('metricScores')
  assert.equal(metricScores.type, 'array')
  assert.equal(metricScores.minItems, 8)
  assert.equal(metricScores.maxItems, 8)
  assert.equal(metricScores.minItems, CALL_AUDIT_RUBRIC.length)
  assert.equal(metricScores.maxItems, CALL_AUDIT_RUBRIC.length)

  const items = metricScores.items as Json
  assert.equal(items.type, 'object')
  assert.equal(items.additionalProperties, false)
  assert.deepEqual(items.required, ['metric', 'score'])
  assert.deepEqual(Object.keys(items.properties as Json), ['metric', 'score'])
})

test('a metric entry allows only the eight approved metric codes', () => {
  const items = property('metricScores').items as Json
  const metric = (items.properties as Json).metric as Json
  assert.deepEqual(
    metric.enum,
    CALL_AUDIT_RUBRIC.map((entry) => entry.code),
  )
  assert.equal((metric.enum as string[]).length, 8)
  assert.equal(new Set(metric.enum as string[]).size, 8)
  // Position pinning is not expressible in the subset.
  assert.equal(metric.const, undefined)
})

test('the canonical order requirement is carried in the description', () => {
  const description = property('metricScores').description as string
  assert.match(description, /exactly once/)
  assert.match(description, /canonical rubric order/)
  assert.match(description, /Never repeat or omit a metric/)
  for (const metric of CALL_AUDIT_RUBRIC) {
    assert.ok(description.includes(metric.code), `${metric.code} missing`)
  }
})

test('a metric score is an integer 1-5 or the exact string NA', () => {
  const items = property('metricScores').items as Json
  const score = (items.properties as Json).score as Json
  const options = score.anyOf as Json[]
  assert.equal(options.length, 2)
  assert.deepEqual(options[0], { type: 'integer', minimum: 1, maximum: 5 })
  assert.deepEqual(options[1], { type: 'string', enum: ['NA'] })
})

test('issueFlags is a bounded array of approved enum values', () => {
  const issueFlags = property('issueFlags')
  assert.equal(issueFlags.type, 'array')
  assert.equal(issueFlags.minItems, 0)
  assert.equal(issueFlags.maxItems, ISSUE_FLAGS.length)
  assert.deepEqual((issueFlags.items as Json).enum, [...ISSUE_FLAGS])
  // uniqueItems is outside the subset; duplicates are rejected at runtime.
  assert.equal(issueFlags.uniqueItems, undefined)
  assert.match(issueFlags.description as string, /Never repeat a flag/)
})

test('feedback strings carry the accepted maximum length', () => {
  for (const field of [
    'managementSummary',
    'kserveFeedback',
    'improvementFeedback',
  ]) {
    assert.equal(property(field).type, 'string')
    assert.equal(property(field).maxLength, MAX_FEEDBACK_LENGTH)
  }
  assert.equal(MAX_FEEDBACK_LENGTH, 2000)
})

test('the schema contains no derived, transcript, or PII field', () => {
  const serialized = JSON.stringify(schema)
  for (const forbidden of SCHEMA_FORBIDDEN_FIELDS) {
    assert.equal(
      Object.keys(properties).includes(forbidden),
      false,
      `${forbidden} must not be a schema property`,
    )
    assert.equal(
      new RegExp(`"${forbidden}"\\s*:`).test(serialized),
      false,
      `${forbidden} must not appear as a schema key`,
    )
  }
  assert.equal(serialized.includes('groupedOutcome'), false)
  assert.equal(serialized.includes('overallScore'), false)
})

test('a metric entry accepts no free-form rationale text', () => {
  const items = property('metricScores').items as Json
  assert.deepEqual(Object.keys(items.properties as Json), ['metric', 'score'])
})

// ---------------------------------------------------------------------------
// OpenAI Structured Outputs subset compatibility
// ---------------------------------------------------------------------------

/** Every key used anywhere in the schema tree, with its owning node. */
function walk(node: unknown, visit: (record: Json) => void): void {
  if (!node || typeof node !== 'object') return
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit)
    return
  }
  const record = node as Json
  visit(record)
  for (const value of Object.values(record)) walk(value, visit)
}

test('uses no keyword outside the Structured Outputs subset', () => {
  // A generic JSON Schema check would pass on an unsupported schema; the API
  // rejects it only at request time, so the ban is asserted here instead.
  const seen = new Set<string>()
  walk(schema, (record) => {
    for (const key of Object.keys(record)) seen.add(key)
  })
  for (const forbidden of STRUCTURED_OUTPUT_FORBIDDEN_KEYWORDS) {
    assert.equal(
      seen.has(forbidden),
      false,
      `${forbidden} is outside the Structured Outputs subset`,
    )
  }
  for (const forbidden of [
    'prefixItems',
    'uniqueItems',
    'allOf',
    'not',
    'dependentRequired',
    'dependentSchemas',
    'if',
    'then',
    'else',
    'patternProperties',
    '$schema',
  ]) {
    assert.equal(seen.has(forbidden), false, `${forbidden} must not appear`)
  }
})

test('declares no root $schema dialect', () => {
  assert.equal(schema.$schema, undefined)
  assert.equal(JSON.stringify(schema).includes('$schema'), false)
  assert.equal(JSON.stringify(schema).includes('json-schema.org'), false)
})

test('carries no root title annotation', () => {
  assert.equal(schema.title, undefined)
  assert.equal(JSON.stringify(schema).includes('"title"'), false)
})

test('every string enum states its type explicitly', () => {
  // An untyped enum is valid generic JSON Schema but is not what the strict
  // validator expects, and the official examples always pair the two.
  for (const field of [
    'intent',
    'detailedOutcome',
    'qualification',
    'nextAction',
  ]) {
    const node = property(field)
    assert.ok(Array.isArray(node.enum), `${field} must be an enum`)
    assert.equal(node.type, 'string', `${field} must declare type string`)
  }

  const metric = ((property('metricScores').items as Json).properties as Json)
    .metric as Json
  assert.ok(Array.isArray(metric.enum))
  assert.equal(metric.type, 'string')

  const flagItems = property('issueFlags').items as Json
  assert.ok(Array.isArray(flagItems.enum))
  assert.equal(flagItems.type, 'string')
})

test('no enum or const node anywhere omits its type', () => {
  const untyped: string[] = []
  walk(schema, (record) => {
    if (!('enum' in record) && !('const' in record)) return
    if (typeof record.type !== 'string') {
      untyped.push(JSON.stringify(record).slice(0, 100))
    }
  })
  assert.deepEqual(untyped, [])
})

test('the NA branch is an explicitly typed string restriction', () => {
  const score = (
    (property('metricScores').items as Json).properties as Json
  ).score as Json
  const na = (score.anyOf as Json[])[1]
  assert.equal(na.type, 'string')
  assert.deepEqual(na.enum, ['NA'])
  // The exact accepted value is preserved; const is no longer used.
  assert.equal(na.const, undefined)
})

test('never uses items:false as a tuple terminator', () => {
  walk(schema, (record) => {
    if (!('items' in record)) return
    assert.notEqual(record.items, false, 'items:false is not supported')
    assert.notEqual(record.items, true, 'items:true is not supported')
  })
})

test('every array declares an object items schema', () => {
  let arrays = 0
  walk(schema, (record) => {
    if (record.type !== 'array') return
    arrays += 1
    const items = record.items
    assert.ok(items, 'an array must declare items')
    assert.equal(typeof items, 'object')
    assert.equal(Array.isArray(items), false, 'items must not be a tuple array')
  })
  assert.equal(arrays, 2, 'metricScores and issueFlags are the only arrays')
})

test('retains the supported numeric, length, and enum constraints', () => {
  // Supported for the non-fine-tuned models this application starts with.
  assert.equal(property('confidence').minimum, 0)
  assert.equal(property('confidence').maximum, 1)
  assert.equal(property('metricScores').minItems, 8)
  assert.equal(property('managementSummary').maxLength, MAX_FEEDBACK_LENGTH)
  assert.ok(Array.isArray(property('intent').enum))
})

test('the module records where fine-tuned capability checking belongs', () => {
  const source = readFileSync(
    new URL('./modelSchema.ts', import.meta.url),
    'utf8',
  )
  assert.match(source, /FINE-TUNED/)
  assert.match(source, /adapter \/ model selector/)
})

// ---------------------------------------------------------------------------
// The runtime validator remains the authority the subset cannot express
// ---------------------------------------------------------------------------

const CONTENT = { eligibility: 'content_auditable' } as const

function metricScores(
  overrides: Record<string, MetricScore> = {},
): Array<{ metric: string; score: MetricScore }> {
  return CALL_AUDIT_RUBRIC.map((metric) => ({
    metric: metric.code,
    score: Object.hasOwn(overrides, metric.code) ? overrides[metric.code] : 4,
  }))
}

function output(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    callConnected: true,
    customerSpoke: true,
    meaningfulConversation: true,
    intent: 'WARM',
    detailedOutcome: 'Individual Resort Booking',
    qualification: 'QUALIFIED',
    nextAction: 'SCHEDULE_BOOKING',
    confidence: 0.8,
    metricScores: metricScores(),
    issueFlags: ['WEAK_NEXT_STEP'],
    managementSummary: 'Caller asked about a resort stay.',
    kserveFeedback: 'Agent did not confirm the travel window.',
    improvementFeedback: 'Confirm dates before closing.',
    ...overrides,
  }
}

test('runtime still rejects a duplicated metric the schema now permits', () => {
  // With one items schema, the request schema alone would accept eight copies
  // of the same metric. The validator is what makes that impossible.
  const duplicated = metricScores()
  duplicated[7] = { metric: CALL_AUDIT_RUBRIC[0].code, score: 3 }
  assert.throws(
    () => validateContentAuditOutput(output({ metricScores: duplicated }), CONTENT),
    CallAuditOutputError,
  )
})

test('runtime still rejects a missing metric', () => {
  assert.throws(
    () =>
      validateContentAuditOutput(
        output({ metricScores: metricScores().slice(0, 7) }),
        CONTENT,
      ),
    CallAuditOutputError,
  )
})

test('runtime still rejects an unknown metric', () => {
  const unknown = metricScores()
  unknown[0] = { metric: 'AUDIO_VOLUME', score: 4 }
  assert.throws(
    () => validateContentAuditOutput(output({ metricScores: unknown }), CONTENT),
    CallAuditOutputError,
  )
})

test('runtime still normalizes accepted scores to canonical order', () => {
  const shuffled = [...metricScores()].reverse()
  const validated = validateContentAuditOutput(
    output({ metricScores: shuffled }),
    CONTENT,
  )
  assert.deepEqual(
    validated.metricScores.map((entry) => entry.metric),
    CALL_AUDIT_RUBRIC.map((metric) => metric.code),
  )
})

test('runtime still rejects duplicate issue flags without schema uniqueItems', () => {
  assert.equal(property('issueFlags').uniqueItems, undefined)
  assert.throws(
    () =>
      validateContentAuditOutput(
        output({ issueFlags: ['WEAK_NEXT_STEP', 'WEAK_NEXT_STEP'] }),
        CONTENT,
      ),
    CallAuditOutputError,
  )
  // A distinct set still passes.
  assert.deepEqual(
    [
      ...validateContentAuditOutput(
        output({ issueFlags: ['WEAK_NEXT_STEP', 'WEAK_DISCOVERY'] }),
        CONTENT,
      ).issueFlags,
    ],
    ['WEAK_NEXT_STEP', 'WEAK_DISCOVERY'],
  )
})
