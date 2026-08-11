export interface BillingMonthScope {
  month: string
  start: string
  end: string
  label: string
}

export class BillingMonthError extends Error {
  readonly code = 'INVALID_BILLING_MONTH'
  readonly status = 400
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

export function parseBillingMonth(
  value: string | null | undefined,
): BillingMonthScope | null {
  if (value == null || value === '' || value === 'all') return null
  const match = /^(\d{4})-(\d{2})$/.exec(value)
  if (!match) {
    throw new BillingMonthError('month must use YYYY-MM or all')
  }
  const year = Number(match[1])
  const month = Number(match[2])
  if (year < 2000 || year > 2100 || month < 1 || month > 12) {
    throw new BillingMonthError('month is outside the supported range')
  }
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(year, month, 0))
  return {
    month: value,
    start: isoDate(start),
    end: isoDate(end),
    label: start.toLocaleString('en-IN', {
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }),
  }
}

export function previousBillingMonth(
  scope: BillingMonthScope,
): BillingMonthScope {
  const [year, month] = scope.month.split('-').map(Number)
  const previous = new Date(Date.UTC(year, month - 2, 1))
  return parseBillingMonth(
    `${previous.getUTCFullYear()}-${String(
      previous.getUTCMonth() + 1,
    ).padStart(2, '0')}`,
  ) as BillingMonthScope
}
