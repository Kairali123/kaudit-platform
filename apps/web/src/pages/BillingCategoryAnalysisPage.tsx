import { useQuery } from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  getJson,
  type BillingCategoryAnalysisData,
  type BillingCategoryKpi,
} from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'
import { money } from '../lib/money'

/**
 * Admin-only category analysis for the selected bill month.
 *
 * Selecting a category re-queries the table below without navigating, so the
 * KPI row and the table always describe the same scope. Every number on the
 * page is produced server-side: the browser formats text and never computes an
 * amount, a duration, or a total of its own.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** Server-computed minutes, shown as given. Absent stays absent, never 0.00. */
function minutes(value: string | null): string {
  return value == null ? '—' : `${value} min`
}

/** Read straight off the stored ISO instant, so no local clock can shift it. */
function callDate(value: string | null): string {
  if (!value) return '—'
  const [year, month, day] = value.slice(0, 10).split('-')
  const name = MONTHS[Number(month) - 1]
  return name ? `${Number(day)} ${name} ${year}` : value
}

function callTime(value: string | null): string {
  return value ? value.slice(11, 19) : '—'
}

function count(value: number): string {
  return value.toLocaleString('en-IN')
}

function CategoryCard({
  kpi,
  selected,
  onSelect,
}: {
  kpi: BillingCategoryKpi
  selected: boolean
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      // The button reports its own selected state, so the choice is announced
      // rather than only coloured in.
      aria-pressed={selected}
      onClick={onSelect}
      className={`metric-card category-kpi ${
        kpi.auditorMoneyComplete ? 'good' : 'warn'
      }${selected ? ' selected' : ''}`}
    >
      <span className="metric-label">
        <span>{kpi.label}</span>
        <i aria-hidden />
      </span>
      <strong>{count(kpi.auditedCallCount)}</strong>
      <p>
        audited calls · gap {minutes(kpi.gapMinutes)}
        <small className="cell-sub">
          KServe {money(kpi.kserveChargeInr)} · auditor{' '}
          {money(kpi.auditorFinalChargeInr)}
        </small>
        <small className="cell-sub">
          {count(kpi.auditorFinalPricedCalls)} finalized ·{' '}
          {count(kpi.auditorUnfinalizedCalls)} not finalized
        </small>
      </p>
    </button>
  )
}

export function BillingCategoryAnalysisPage() {
  const period = useBillingPeriod()
  const [category, setCategory] = useState('all')
  const [page, setPage] = useState(1)
  const queryString = new URLSearchParams({
    page: String(page),
    pageSize: '25',
    category,
  }).toString()
  const query = useQuery({
    queryKey: ['billing-categories', period.month, category, page],
    queryFn: () =>
      getJson<BillingCategoryAnalysisData>(
        period.apiPath(`/api/v1/billing/categories?${queryString}`),
      ),
  })
  useEffect(() => {
    setCategory('all')
    setPage(1)
  }, [period.month])

  if (query.isLoading) return <LoadingState />
  if (query.error)
    return (
      <ErrorState error={query.error} retry={() => void query.refetch()} />
    )
  const data = query.data!
  const totals = data.totals
  return (
    <>
      <PageHeader
        eyebrow="Billing Audit"
        title="Category analysis"
        description={`Audited calls, charges, and duration gaps by outcome category for ${period.label}.`}
        badge={
          <span className="status-badge automated">
            <LockKeyhole size={13} aria-hidden /> Admin only
          </span>
        }
      />
      <Notice tone="warning" title="Two authorities, never one number">
        <strong>KServe charge</strong> comes from the vendor&apos;s own final
        billed minutes. <strong>Auditor amount</strong> totals only calls that
        already carry a current final billing calculation from the
        deterministic engine; audited calls without one release no auditor
        charge and are counted separately. {data.durationBasis.gapLabel}{' '}
        {data.durationBasis.aiAuditedDurationLabel} Call times are shown exactly
        as stored.
      </Notice>

      <section
        className="metric-grid category-kpi-grid"
        role="group"
        aria-label="Audit category"
      >
        {data.categories.map((kpi) => (
          <CategoryCard
            key={kpi.category}
            kpi={kpi}
            selected={kpi.category === data.scope.category}
            onSelect={() => {
              setCategory(kpi.category)
              setPage(1)
            }}
          />
        ))}
      </section>

      <section className="content-section audit-control-bar">
        <div>
          <ShieldCheck size={18} aria-hidden />
          <span>{data.contentBoundary}</span>
        </div>
      </section>

      <section className="data-table content-section audit-table category-table">
        <div className="table-heading">
          <div>
            <span className="eyebrow">{data.scope.categoryLabel}</span>
            <h2>Audited calls in this category</h2>
          </div>
          <span className="soft-chip">
            {count(data.pagination.totalRows)} results
          </span>
        </div>
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Task / call reference</th>
                <th>Call date</th>
                <th>Call start</th>
                <th>Call end</th>
                <th>Recording / admin review</th>
                <th>Category</th>
                <th>KServe charge time</th>
                <th>AI-audited duration</th>
                <th>Gap</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.callReference}>
                  <td><code>{row.callReference}</code></td>
                  <td>{callDate(row.callDate)}</td>
                  <td>{callTime(row.callStartAt)}</td>
                  <td>{callTime(row.callEndAt)}</td>
                  <td>
                    <Link
                      className="table-action"
                      to={period.routePath(
                        `/audits/call?task=${encodeURIComponent(
                          row.callReference,
                        )}`,
                      )}
                    >
                      Admin review
                    </Link>
                    <small className="cell-sub">
                      {row.recordingAvailable
                        ? 'Recording available'
                        : 'No recording'}
                    </small>
                  </td>
                  <td><code>{row.category}</code></td>
                  <td>{minutes(row.kserveChargeTimeMinutes)}</td>
                  <td>{minutes(row.aiAuditedDurationMinutes)}</td>
                  <td
                    className={
                      row.gapMs != null && row.gapMs > 60_000
                        ? 'cell-warn'
                        : ''
                    }
                  >
                    {minutes(row.gapMinutes)}
                  </td>
                </tr>
              ))}
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={9} className="table-empty">
                    No audited call in this category for {period.label}.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              {/* Totals for the whole selected category, not for this page. */}
              <tr>
                <th scope="row">
                  Total · {data.scope.categoryLabel}
                  <small className="cell-sub">
                    {count(totals.auditedCallCount)} audited calls in scope ·
                    KServe {money(totals.kserveChargeInr)} · auditor{' '}
                    {money(totals.auditorFinalChargeInr)} from{' '}
                    {count(totals.auditorFinalPricedCalls)} final calculations
                  </small>
                </th>
                <td>Not applicable</td>
                <td>Not applicable</td>
                <td>Not applicable</td>
                <td>Not applicable</td>
                <td>Not applicable</td>
                <td>
                  {minutes(totals.kserveChargeTimeMinutes)}
                  <small className="cell-sub">
                    {count(totals.kserveChargeTimeCalls)} of{' '}
                    {count(totals.auditedCallCount)} calls billed
                  </small>
                </td>
                <td>
                  {minutes(totals.aiAuditedDurationMinutes)}
                  <small className="cell-sub">
                    {count(totals.aiAuditedDurationCalls)} of{' '}
                    {count(totals.auditedCallCount)} calls audited
                  </small>
                </td>
                <td>
                  {minutes(totals.gapMinutes)}
                  <small className="cell-sub">
                    {count(totals.comparableCalls)} comparable calls
                  </small>
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
        <footer className="table-pagination">
          <span>
            Page {data.pagination.page} of {data.pagination.totalPages}
          </span>
          <div>
            <button
              type="button"
              disabled={data.pagination.page <= 1}
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={15} aria-hidden /> Previous
            </button>
            <button
              type="button"
              disabled={
                data.pagination.page >= data.pagination.totalPages
              }
              onClick={() => setPage((value) => value + 1)}
            >
              Next <ChevronRight size={15} aria-hidden />
            </button>
          </div>
        </footer>
      </section>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
