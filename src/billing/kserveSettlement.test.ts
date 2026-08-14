import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  DEFAULT_SETTLEMENT_HISTORY,
  KSERVE_SETTLEMENT_CURRENCY,
  KserveSettlementConflictError,
  KserveSettlementInputError,
  KserveSettlementUnavailableError,
  MAX_AMOUNT_TEXT_LENGTH,
  MAX_FINAL_PAID_AMOUNT_INR,
  MAX_IDEMPOTENCY_KEY_LENGTH,
  MAX_SETTLEMENT_HISTORY,
  asSafeSettlementError,
  buildSettlementId,
  buildSettlementRequestDigest,
  calculateSettlementSavings,
  formatScaledMoney,
  parseExactDecimal,
  parseFinalPaidAmount,
  parseHistoryLimit,
  parseIdempotencyKey,
  parseSettlementMonth,
  readStoredDecimal,
  settlementMonthBounds,
  validateRecordSettlementRequest,
} from './kserveSettlement.ts'

/**
 * Domain rules for the monthly KServe settlement.
 *
 * Every amount, month, and key in this file is SYNTHETIC. Nothing here reads a
 * database, a network, or a fixture taken from real billing.
 */

const VALID_KEY = 'set-0000-1111-2222'

function request(overrides: Record<string, unknown> = {}) {
  return {
    month: '2026-08',
    finalPaidAmountInr: '1234.50',
    idempotencyKey: VALID_KEY,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Exact decimal text
// ---------------------------------------------------------------------------

test('exact decimal text is read digit by digit, never through a float', () => {
  // 0.1 + 0.2 is the canonical float failure; scaled integers do not have it.
  assert.equal(
    formatScaledMoney(
      parseExactDecimal('0.1', 'a') + parseExactDecimal('0.2', 'a'),
    ),
    '0.30000000',
  )
  // Eight places survive intact, including the last one.
  assert.equal(parseFinalPaidAmount('12.00000001'), '12.00000001')
  assert.equal(parseFinalPaidAmount('0'), '0.00000000')
  assert.equal(parseFinalPaidAmount(' 42.5 '), '42.50000000')
})

test('the module itself never calls Number or parseFloat on an amount', () => {
  const source = readFileSync(
    fileURLToPath(new URL('./kserveSettlement.ts', import.meta.url)),
    'utf8',
  )
  // Number() is used only on the calendar integers of a YYYY-MM month and on a
  // bounded history count, never on money. Pin that no money field reaches it.
  assert.equal(/parseFloat\(/.test(source), false)
  assert.equal(/Number\([^)]*[Aa]mount/.test(source), false)
  assert.equal(/Number\([^)]*Inr\)/.test(source), false)
})

test('anything that is not a plain decimal is refused, not coerced', () => {
  for (const value of [
    '1e3',
    '1,234.50',
    '+12.00',
    '.5',
    '5.',
    '12.5 INR',
    '₹12.50',
    'NaN',
    'Infinity',
    '0x10',
    '12.000000001',
    '',
    '   ',
    null,
    undefined,
    12.5,
    {},
    [],
  ]) {
    assert.throws(
      () => parseFinalPaidAmount(value),
      (error: unknown) => {
        assert.ok(error instanceof KserveSettlementInputError)
        assert.equal(error.field, 'finalPaidAmountInr')
        assert.equal(error.status, 400)
        return true
      },
      `accepted ${String(value)}`,
    )
  }
})

test('a negative paid amount is refused', () => {
  assert.throws(
    () => parseFinalPaidAmount('-0.00000001'),
    (error: unknown) =>
      error instanceof KserveSettlementInputError &&
      /must not be negative/.test(error.message),
  )
})

test('the amount and its input length are both bounded', () => {
  assert.equal(
    parseFinalPaidAmount(MAX_FINAL_PAID_AMOUNT_INR),
    MAX_FINAL_PAID_AMOUNT_INR,
  )
  assert.throws(
    () => parseFinalPaidAmount('100000000000.00000000'),
    KserveSettlementInputError,
  )
  assert.throws(
    () => parseFinalPaidAmount('1'.repeat(MAX_AMOUNT_TEXT_LENGTH + 1)),
    (error: unknown) =>
      error instanceof KserveSettlementInputError &&
      /at most \d+ characters/.test(error.message),
  )
})

test('a stored decimal is normalized, and absence stays absent', () => {
  assert.equal(readStoredDecimal('19', 'x'), '19.00000000')
  assert.equal(readStoredDecimal('19.00000000', 'x'), '19.00000000')
  assert.equal(readStoredDecimal(null, 'x'), null)
  assert.equal(readStoredDecimal(undefined, 'x'), null)
})

// ---------------------------------------------------------------------------
// Savings
// ---------------------------------------------------------------------------

test('savings is billed minus paid, in exact fixed precision', () => {
  assert.equal(
    calculateSettlementSavings('100000.00000000', '87500.25000000'),
    '12499.75000000',
  )
  // A difference of one paisa survives; a float would not preserve it here.
  assert.equal(
    calculateSettlementSavings('0.30000000', '0.10000000'),
    '0.20000000',
  )
})

test('savings preserves a negative result when the payment exceeded the bill', () => {
  assert.equal(
    calculateSettlementSavings('1000.00000000', '1250.00000000'),
    '-250.00000000',
  )
})

test('savings is unavailable — never zero — when either side is missing', () => {
  assert.equal(calculateSettlementSavings(null, '10.00000000'), null)
  assert.equal(calculateSettlementSavings('10.00000000', null), null)
  assert.equal(calculateSettlementSavings(null, null), null)
})

// ---------------------------------------------------------------------------
// Period identity
// ---------------------------------------------------------------------------

test('a settlement covers one whole month and nothing else', () => {
  assert.equal(parseSettlementMonth('2026-08'), '2026-08')
  assert.deepEqual(settlementMonthBounds('2026-08'), {
    periodStart: '2026-08-01',
    periodEnd: '2026-08-31',
  })
  // February in a leap year, so the end is derived and not assumed.
  assert.deepEqual(settlementMonthBounds('2028-02'), {
    periodStart: '2028-02-01',
    periodEnd: '2028-02-29',
  })
  for (const value of ['all', '', '2026-13', '2026-00', '1999-01', '2026-8', null]) {
    assert.throws(
      () => parseSettlementMonth(value),
      (error: unknown) =>
        error instanceof KserveSettlementInputError && error.field === 'month',
      `accepted ${String(value)}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Idempotency identity
// ---------------------------------------------------------------------------

test('the retry key is bounded and restricted to a machine token', () => {
  assert.equal(parseIdempotencyKey(VALID_KEY), VALID_KEY)
  for (const value of [
    'short',
    'a'.repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1),
    'has spaces here',
    'semi;colon;key',
    "quote'key'here",
    null,
  ]) {
    assert.throws(
      () => parseIdempotencyKey(value),
      (error: unknown) =>
        error instanceof KserveSettlementInputError &&
        error.field === 'idempotencyKey',
      `accepted ${String(value)}`,
    )
  }
})

test('the row id is deterministic in the month and the key alone', () => {
  const id = buildSettlementId('2026-08', VALID_KEY)
  assert.equal(id, buildSettlementId('2026-08', VALID_KEY))
  assert.match(id, /^kms_[0-9a-f]{36}$/)
  assert.notEqual(id, buildSettlementId('2026-09', VALID_KEY))
  assert.notEqual(id, buildSettlementId('2026-08', `${VALID_KEY}-b`))
})

test('the request digest changes with the amount, so a retry cannot drift', () => {
  const base = {
    billMonth: '2026-08',
    currency: KSERVE_SETTLEMENT_CURRENCY,
    finalPaidAmountInr: '100.00000000',
    idempotencyKey: VALID_KEY,
  }
  assert.equal(
    buildSettlementRequestDigest(base),
    buildSettlementRequestDigest({ ...base }),
  )
  assert.notEqual(
    buildSettlementRequestDigest(base),
    buildSettlementRequestDigest({
      ...base,
      finalPaidAmountInr: '100.00000001',
    }),
  )
})

test('validation normalizes the whole request and never echoes a value', () => {
  const validated = validateRecordSettlementRequest(
    request({ recordedByUserId: 'user-1', correlationId: 'corr-1' }),
  )
  assert.equal(validated.billMonth, '2026-08')
  assert.equal(validated.periodStart, '2026-08-01')
  assert.equal(validated.periodEnd, '2026-08-31')
  assert.equal(validated.currency, 'INR')
  assert.equal(validated.finalPaidAmountInr, '1234.50000000')
  assert.match(validated.settlementId, /^kms_/)
  assert.match(validated.requestDigest, /^[0-9a-f]{64}$/)

  try {
    validateRecordSettlementRequest(
      request({ finalPaidAmountInr: '-987654.32' }),
    )
    assert.fail('a negative amount was accepted')
  } catch (error) {
    assert.ok(error instanceof KserveSettlementInputError)
    // The refused amount never appears in the message.
    assert.equal(error.message.includes('987654'), false)
  }
})

// ---------------------------------------------------------------------------
// Bounded history
// ---------------------------------------------------------------------------

test('history has a server-side maximum and a default', () => {
  assert.equal(parseHistoryLimit(null), DEFAULT_SETTLEMENT_HISTORY)
  assert.equal(parseHistoryLimit(''), DEFAULT_SETTLEMENT_HISTORY)
  assert.equal(parseHistoryLimit(String(MAX_SETTLEMENT_HISTORY)), MAX_SETTLEMENT_HISTORY)
  for (const value of ['0', '-1', '51', '9999', 'all', '1.5']) {
    assert.throws(
      () => parseHistoryLimit(value),
      (error: unknown) =>
        error instanceof KserveSettlementInputError &&
        error.field === 'history',
      `accepted ${value}`,
    )
  }
})

// ---------------------------------------------------------------------------
// Bounded failure
// ---------------------------------------------------------------------------

test('an unknown thrown value becomes one bounded unavailable error', () => {
  for (const thrown of [
    new Error(
      "ER_DUP_ENTRY: Duplicate entry 'kms_abc' for key 'uq_x' amount 1234.50",
    ),
    { code: 'ECONNRESET', sqlMessage: 'connection lost near SELECT `id`' },
    'a bare string with 9,87,654 rupees in it',
    undefined,
  ]) {
    const safe = asSafeSettlementError(thrown)
    assert.ok(safe instanceof KserveSettlementUnavailableError)
    assert.equal(safe.message, 'Monthly settlement storage is unavailable')
    for (const leak of ['kms_', 'uq_', '1234.50', 'SELECT', '987654']) {
      assert.equal(safe.message.includes(leak), false, leak)
    }
  }
})

test('typed failures pass through unchanged', () => {
  const input = new KserveSettlementInputError('month', 'must use YYYY-MM')
  const conflict = new KserveSettlementConflictError('idempotencyKey', 'reused')
  assert.equal(asSafeSettlementError(input), input)
  assert.equal(asSafeSettlementError(conflict), conflict)
  assert.equal(input.status, 400)
  assert.equal(conflict.status, 409)
})
