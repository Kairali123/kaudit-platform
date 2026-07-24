export type SnapshotCadence = 'weekly' | 'monthly' | 'quarterly' | 'yearly'

export interface DatePeriod {
  cadence: SnapshotCadence
  label: string
  start: string // inclusive YYYY-MM-DD
  end: string // inclusive YYYY-MM-DD
  priorStart: string
  priorEnd: string
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10)
}
function utc(y: number, m: number, d: number): Date {
  return new Date(Date.UTC(y, m, d))
}
function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setUTCDate(out.getUTCDate() + n)
  return out
}
function endOfMonth(y: number, m: number): Date {
  return utc(y, m + 1, 0)
}

// Returns the most recently COMPLETED period for each cadence. Quarter/year use
// Kairali's recommended Indian fiscal calendar (Apr-Mar); weekly is ISO Mon-Sun.
// Date-only arithmetic avoids DST/timezone drift. The live adapter supplies today's
// Asia/Kolkata calendar date.
export function completedPeriods(today: string): DatePeriod[] {
  const [year, month, day] = today.split('-').map(Number)
  if (!year || !month || !day) throw new Error(`Invalid date: ${today}`)
  const t = utc(year, month - 1, day)

  // Previous completed ISO week (Mon-Sun).
  const weekday = t.getUTCDay() || 7
  const thisMonday = addDays(t, 1 - weekday)
  const weekEnd = addDays(thisMonday, -1)
  const weekStart = addDays(weekEnd, -6)
  const priorWeekEnd = addDays(weekStart, -1)
  const priorWeekStart = addDays(priorWeekEnd, -6)

  // Previous completed calendar month.
  const monthEnd = utc(year, month - 1, 0)
  const monthStart = utc(monthEnd.getUTCFullYear(), monthEnd.getUTCMonth(), 1)
  const priorMonthEnd = addDays(monthStart, -1)
  const priorMonthStart = utc(priorMonthEnd.getUTCFullYear(), priorMonthEnd.getUTCMonth(), 1)

  // Previous completed Indian fiscal quarter: Apr-Jun, Jul-Sep, Oct-Dec, Jan-Mar.
  const currentMonth0 = month - 1
  const fiscalIndex = (currentMonth0 + 9) % 12 // Apr=0 ... Mar=11
  const currentQuarterStartMonth = (currentMonth0 - (fiscalIndex % 3) + 12) % 12
  let currentQuarterStartYear = year
  if (currentQuarterStartMonth > currentMonth0) currentQuarterStartYear--
  const currentQuarterStart = utc(currentQuarterStartYear, currentQuarterStartMonth, 1)
  const quarterEnd = addDays(currentQuarterStart, -1)
  const quarterStart = utc(
    quarterEnd.getUTCFullYear(),
    quarterEnd.getUTCMonth() - 2,
    1,
  )
  const priorQuarterEnd = addDays(quarterStart, -1)
  const priorQuarterStart = utc(
    priorQuarterEnd.getUTCFullYear(),
    priorQuarterEnd.getUTCMonth() - 2,
    1,
  )

  // Previous completed Indian fiscal year (Apr 1 - Mar 31).
  const currentFyStartYear = currentMonth0 >= 3 ? year : year - 1
  const currentFyStart = utc(currentFyStartYear, 3, 1)
  const yearEnd = addDays(currentFyStart, -1)
  const yearStart = utc(yearEnd.getUTCFullYear() - 1, 3, 1)
  const priorYearEnd = addDays(yearStart, -1)
  const priorYearStart = utc(priorYearEnd.getUTCFullYear() - 1, 3, 1)

  return [
    {
      cadence: 'weekly',
      label: `Week ending ${iso(weekEnd)}`,
      start: iso(weekStart), end: iso(weekEnd),
      priorStart: iso(priorWeekStart), priorEnd: iso(priorWeekEnd),
    },
    {
      cadence: 'monthly',
      label: monthEnd.toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' }),
      start: iso(monthStart), end: iso(monthEnd),
      priorStart: iso(priorMonthStart), priorEnd: iso(priorMonthEnd),
    },
    {
      cadence: 'quarterly',
      label: `Fiscal quarter ending ${iso(quarterEnd)}`,
      start: iso(quarterStart), end: iso(quarterEnd),
      priorStart: iso(priorQuarterStart), priorEnd: iso(priorQuarterEnd),
    },
    {
      cadence: 'yearly',
      label: `FY ${yearStart.getUTCFullYear()}–${String(yearEnd.getUTCFullYear()).slice(-2)}`,
      start: iso(yearStart), end: iso(yearEnd),
      priorStart: iso(priorYearStart), priorEnd: iso(priorYearEnd),
    },
  ]
}
