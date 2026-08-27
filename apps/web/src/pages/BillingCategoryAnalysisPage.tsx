import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  ChevronLeft,
  ChevronRight,
  LockKeyhole,
  ShieldCheck,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState } from '../components/States'
import {
  getJson,
  type BillingCategoryKpi,
  type BillingCategoryPageData,
  type BillingCategoryScopeKpi,
  type BillingCategorySummaryData,
} from '../lib/api'
import {
  useBillingPeriod,
  type BillingPeriodContextValue,
} from '../lib/billingPeriod'
import { money } from '../lib/money'

/**
 * Admin-only category analysis for the selected bill month.
 *
 * TWO reads, because the page holds two kinds of figure:
 *
 *   * the MONTH SUMMARY — the nine KPIs, the Issue/No issue counts and the
 *     Grand Total — describes the whole month and does not change when a
 *     category is selected, so it is read once per month and RETAINED while the
 *     reader clicks through the KPIs; and
 *   * the TABLE PAGE — twenty-five audited calls, and nothing that describes
 *     the month — is cached per month, category and page. A category's first
 *     page is prefetched when its KPI is hovered or focused, so an intended
 *     selection can render from cache without loading every category eagerly.
 *
 * How many results the selection holds is NOT read again per page: it is the
 * selected KPI's own `auditedCallCount`, already on the summary above, and the
 * pager's page count is the one piece of arithmetic the browser does — a whole
 * number of pages, never an amount, a duration or a share.
 *
 * Selecting a category re-queries only the table below and never navigates. The
 * KPI selection itself is applied immediately, from local state, so the choice
 * is acknowledged even while a table page is still arriving; the table keeps
 * the previous page's rows until the new page is ready, and the heading, the
 * footer and the pager all describe the page actually on screen rather than the
 * pending one. Nothing is filtered client-side: a page of rows is a page the
 * server selected, never a subset of one carved out in the browser.
 *
 * Every number on the page is produced server-side. The browser formats text,
 * chooses which server-computed object to show, and never computes an amount, a
 * duration, a share, or a total of its own.
 */

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

/** The two halves of the admin-only route, kept beside each other. */
const BILLING_CATEGORY_TABLE_ROUTE = '/api/v1/billing/categories'
const BILLING_CATEGORY_SUMMARY_ROUTE = '/api/v1/billing/categories/summary'

/**
 * BOUNDED page size, matching the server's own default. The table never asks
 * for a month of rows and then narrows them here: a month can hold tens of
 * thousands of audited calls, and a browser must not be handed all of them.
 */
const PAGE_SIZE = 25

const ALL_CATEGORIES = 'all'
const NO_RECORDING = 'NO_RECORDING'

/**
 * The month summary is stable: it moves only when audits complete, never when a
 * reader selects a category. Holding it well past a click is the whole point of
 * splitting the read, and the longer retention keeps it warm across a trip to
 * the admin review page and back.
 */
const SUMMARY_STALE_MS = 5 * 60_000
const SUMMARY_GC_MS = 30 * 60_000

/**
 * A prefetched table page has to still count as fresh when the reader actually
 * clicks, or the click would refetch what was just fetched and the prefetch
 * would buy nothing. The retention window keeps the pages a reader has already
 * visited, so moving back and forth between categories is instant.
 */
const TABLE_STALE_MS = 60_000
const TABLE_GC_MS = 10 * 60_000

/**
 * No Recording is a KPI, not a selection: those calls were never audited, so
 * there is no audited-call table to page through for them. Its tile is disabled
 * and, because the prefetch handlers hang off the same flag, never prefetched.
 */
function isSelectable(category: string): boolean {
  return category !== NO_RECORDING
}

/**
 * One table page, keyed by month, category and page so every selection a reader
 * makes is cached independently. Shared by the query and the prefetch, so a
 * prefetched page and a clicked page can never land under different keys.
 */
function tableQueryOptions(
  period: BillingPeriodContextValue,
  category: string,
  page: number,
) {
  const search = new URLSearchParams({
    page: String(page),
    pageSize: String(PAGE_SIZE),
    category,
  })
  return {
    queryKey: ['billing-category-page', period.month, category, page],
    queryFn: () =>
      getJson<BillingCategoryPageData>(
        period.apiPath(
          `${BILLING_CATEGORY_TABLE_ROUTE}?${search.toString()}`,
        ),
      ),
    staleTime: TABLE_STALE_MS,
    gcTime: TABLE_GC_MS,
  }
}

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

function confidence(value: string | null): string {
  if (value == null) return 'Not stored'
  return `${(Number(value) * 100).toFixed(1)}%`
}

const CATEGORY_DESCRIPTIONS: Record<string, string> = {
  INCORRECT_CALL_DURATION:
    'System recorded a highly incorrect or excessive duration for the call.',
  AGENT_FAILURE:
    'AI agent failed to understand or respond to the customer.',
  INACTIVE_CALL:
    'AI did not detect an inactive or third-party call and let it run long.',
  AI_CONVERSATION_HANDLING:
    'AI could not handle the conversation flow properly with the customer.',
  VOICEMAIL: 'Call went to voicemail but was recorded as a talked call.',
  TIME_DURATION:
    'Mismatch between recorded and actual conversation duration.',
  AI_TO_AI:
    'AI agent ended up talking to another AI or IVR system, not a human.',
  CONNECT_NOT_FRUITFUL:
    'Agent gave intro but customer did not respond or engage.',
  NO_RECORDING:
    'KServe billed the log, but no recording URL was provided for audit.',
}

function CategoryCard({
  kpi,
  selected,
  selectable = true,
  onPrefetch,
  onSelect,
}: {
  kpi: BillingCategoryKpi
  selected: boolean
  selectable?: boolean
  onPrefetch: () => void
  onSelect: () => void
}) {
  return (
    <button
      type="button"
      // The button reports its own selected state, so the choice is announced
      // rather than only coloured in.
      aria-pressed={selected}
      disabled={!selectable}
      onPointerEnter={selectable ? onPrefetch : undefined}
      onFocus={selectable ? onPrefetch : undefined}
      onClick={onSelect}
      data-category={kpi.category}
      className={`category-kpi ${
        kpi.auditorMoneyComplete ? 'good' : 'warn'
      }${selected ? ' selected' : ''}`}
    >
      <span className="category-kpi-name">{kpi.label}</span>
      <span className="category-kpi-description">
        {CATEGORY_DESCRIPTIONS[kpi.category]}
      </span>
      <span className="category-kpi-top-row">
        <strong>{count(kpi.auditedCallCount)}</strong>
        <span>{kpi.sharePercent}%</span>
      </span>
      <span className="category-kpi-metrics">
        <span>
          <small>Original</small>
          <strong>{minutes(kpi.kserveChargeTimeMinutes)}</strong>
        </span>
        <span>
          <small>Audited</small>
          <strong>{minutes(kpi.aiAuditedDurationMinutes)}</strong>
        </span>
        <span>
          <small>Gap</small>
          <strong className="gap">{minutes(kpi.gapMinutes)}</strong>
        </span>
      </span>
      <span className="category-kpi-metrics amounts">
        <span>
          <small>Original amt</small>
          <strong>{money(kpi.kserveChargeInr)}</strong>
        </span>
        <span>
          <small>Audited amt</small>
          <strong>{money(kpi.auditorFinalChargeInr)}</strong>
        </span>
        <span>
          <small>Gap amt</small>
          <strong className="gap">{money(kpi.chargeGapInr)}</strong>
        </span>
      </span>
      {kpi.auditorUnfinalizedCalls > 0 && (
        <span className="category-kpi-note">
          {count(kpi.auditorUnfinalizedCalls)} missing duration
        </span>
      )}
    </button>
  )
}

/**
 * Totals for the whole selected category, not for this page.
 *
 * This is the SAME server-computed KPI the tile above displays, taken from the
 * month summary rather than re-derived from the rows on screen, so the footer,
 * the tile and the pager cannot describe three different scopes. A selection the
 * month summary does not describe reports "—" rather than an invented zero.
 */
function ScopeTotalsRow({
  label,
  totals,
}: {
  label: string
  totals: BillingCategoryScopeKpi | null
}) {
  return (
    <tr>
      <th scope="row">
        Total · {label}
        {totals && (
          <small className="cell-sub">
            {count(totals.auditedCallCount)} audited calls in scope ·
            KServe {money(totals.kserveChargeInr)} · auditor capped{' '}
            {money(totals.auditorFinalChargeInr)} from{' '}
            {count(totals.auditorFinalPricedCalls)} priced calls
          </small>
        )}
      </th>
      <td>Not applicable</td>
      <td>Not applicable</td>
      <td>Not applicable</td>
      <td>Not applicable</td>
      <td>
        {totals ? minutes(totals.kserveChargeTimeMinutes) : '—'}
        {totals && (
          <small className="cell-sub">
            {count(totals.kserveChargeTimeCalls)} of{' '}
            {count(totals.auditedCallCount)} calls billed
          </small>
        )}
      </td>
      <td>{totals ? money(totals.kserveChargeInr) : '—'}</td>
      <td>{totals ? money(totals.auditorFinalChargeInr) : '—'}</td>
      <td>
        {totals ? minutes(totals.aiAuditedDurationMinutes) : '—'}
        {totals && (
          <small className="cell-sub">
            {count(totals.aiAuditedDurationCalls)} of{' '}
            {count(totals.auditedCallCount)} calls audited
          </small>
        )}
      </td>
      <td>{totals ? minutes(totals.gapMinutes) : '—'}</td>
      <td>Not applicable</td>
      <td>Not applicable</td>
      <td>Not applicable</td>
    </tr>
  )
}

export function BillingCategoryAnalysisPage() {
  const period = useBillingPeriod()
  const queryClient = useQueryClient()
  const [category, setCategory] = useState(ALL_CATEGORIES)
  const [page, setPage] = useState(1)

  const summaryQuery = useQuery({
    queryKey: ['billing-category-summary', period.month],
    queryFn: () =>
      getJson<BillingCategorySummaryData>(
        period.apiPath(BILLING_CATEGORY_SUMMARY_ROUTE),
      ),
    staleTime: SUMMARY_STALE_MS,
    gcTime: SUMMARY_GC_MS,
  })
  const tableQuery = useQuery({
    ...tableQueryOptions(period, category, page),
    // The previous page stays on screen while an uncached page is fetched, so
    // the table does not blank out between selections. It is the page the
    // server sent, never a client-side slice of one.
    placeholderData: keepPreviousData,
  })

  useEffect(() => {
    setCategory(ALL_CATEGORIES)
    setPage(1)
  }, [period.month])

  const summary = summaryQuery.data

  if (summaryQuery.isLoading) return <LoadingState />
  if (summaryQuery.error)
    return (
      <ErrorState
        error={summaryQuery.error}
        retry={() => void summaryQuery.refetch()}
      />
    )
  const data = summary!
  const grandTotal = data.grandTotal
  const table = tableQuery.data ?? null
  // The heading, the footer and the pager describe the page ON SCREEN. While an
  // uncached page loads that is still the previous selection, and saying so is
  // more honest than labelling old rows with the new category's name.
  const shownCategory = table?.scope.category ?? category
  const totals =
    data.categories.find((kpi) => kpi.category === shownCategory) ?? null
  const shownLabel = table?.scope.categoryLabel ?? totals?.label ?? shownCategory
  const shownTotalRows = totals?.auditedCallCount ?? 0
  const shownTotalPages = Math.max(1, Math.ceil(shownTotalRows / PAGE_SIZE))
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

      <section className="category-summary" aria-label="Audit summary">
        <div>
          <span>Total audited calls</span>
          <strong>{count(data.summary.totalAuditedCalls)}</strong>
        </div>
        <div>
          <span>Issue found</span>
          <strong className="danger">
            {count(data.summary.issueFoundCalls)}
          </strong>
        </div>
        <div>
          <span>No issue found</span>
          <strong className="success">
            {count(data.summary.noIssueFoundCalls)}
          </strong>
        </div>
      </section>

      {category !== ALL_CATEGORIES && (
        <button
          type="button"
          className="category-kpi-reset"
          onClick={() => {
            setCategory(ALL_CATEGORIES)
            setPage(1)
          }}
        >
          View all categories
        </button>
      )}
      <section
        className="category-kpi-grid"
        role="group"
        aria-label="Audit category"
      >
        {data.categories
          .filter((kpi) => !kpi.isAllCategories)
          .map((kpi) => (
            <CategoryCard
              key={kpi.category}
              kpi={kpi}
              // Local state, not the table response: the choice is acknowledged
              // the moment it is made, even if its page is still arriving.
              selected={kpi.category === category}
              selectable={isSelectable(kpi.category)}
              onPrefetch={() => {
                if (!isSelectable(kpi.category)) return
                void queryClient.prefetchQuery(
                  tableQueryOptions(period, kpi.category, 1),
                )
              }}
              onSelect={() => {
                setCategory(kpi.category)
                setPage(1)
              }}
            />
          ))}
      </section>

      <section className="category-grand-total">
        <h2>
          Grand total across {count(grandTotal.auditedCallCount)} calls
        </h2>
        <div className="category-grand-time">
          <span>
            <small>Total calls</small>
            <strong>{count(grandTotal.auditedCallCount)}</strong>
          </span>
          <span>
            <small>Total original time</small>
            <strong>{minutes(grandTotal.kserveChargeTimeMinutes)}</strong>
          </span>
          <span>
            <small>Total audited time</small>
            <strong>{minutes(grandTotal.aiAuditedDurationMinutes)}</strong>
          </span>
          <span>
            <small>Total time gap</small>
            <strong className="danger">{minutes(grandTotal.gapMinutes)}</strong>
          </span>
        </div>
        <div className="category-grand-amount">
          <span>
            <small>Total original amount</small>
            <strong>{money(grandTotal.kserveChargeInr)}</strong>
          </span>
          <span>
            <small>Total audited amount</small>
            <strong>{money(grandTotal.auditorFinalChargeInr)}</strong>
          </span>
          <span>
            <small>Total gap amount</small>
            <strong className="danger">{money(grandTotal.chargeGapInr)}</strong>
          </span>
        </div>
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
            <span className="eyebrow">{shownLabel}</span>
            <h2>Audited calls in this category</h2>
          </div>
          <span className="table-heading-status">
            {tableQuery.isFetching && (
              <span className="soft-chip" role="status">
                Updating
              </span>
            )}
            <span className="soft-chip">
              {table
                ? `${count(shownTotalRows)} results`
                : 'Loading results'}
            </span>
          </span>
        </div>
        {tableQuery.error && (
          <ErrorState
            error={tableQuery.error}
            retry={() => void tableQuery.refetch()}
          />
        )}
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>Task ID</th>
                <th>Call Date</th>
                <th>Call Start</th>
                <th>Call end</th>
                <th>Category</th>
                <th>Call Duration (Kserve)</th>
                <th>Amount Charged (Kserve)</th>
                <th>AI Audit Amt</th>
                <th>AI Audit Time</th>
                <th>Gap</th>
                <th>AI Confidence</th>
                <th>AI Audit Remark</th>
                <th>Recording / admin review</th>
              </tr>
            </thead>
            <tbody>
              {table?.rows.map((row) => (
                <tr key={row.callReference}>
                  <td><code>{row.callReference}</code></td>
                  <td>{callDate(row.callDate)}</td>
                  <td>{callTime(row.callStartAt)}</td>
                  <td>{callTime(row.callEndAt)}</td>
                  <td><code>{row.category}</code></td>
                  <td>{minutes(row.kserveChargeTimeMinutes)}</td>
                  <td>{money(row.kserveChargeInr)}</td>
                  <td>{money(row.auditorFinalChargeInr)}</td>
                  <td>{minutes(row.aiAuditedDurationMinutes)}</td>
                  <td className="cell-warn">{minutes(row.gapMinutes)}</td>
                  <td>{confidence(row.aiConfidence)}</td>
                  <td className="category-audit-remark">
                    <span
                      className="category-audit-remark-text"
                      title={row.aiAuditRemark ?? 'No AI remark recorded'}
                    >
                      {row.aiAuditRemark ?? 'No AI remark recorded'}
                    </span>
                  </td>
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
                </tr>
              ))}
              {table && table.rows.length === 0 && (
                <tr>
                  <td colSpan={13} className="table-empty">
                    No audited call in this category for {period.label}.
                  </td>
                </tr>
              )}
              {!table && (
                <tr>
                  <td colSpan={12} className="table-empty">
                    Loading audited calls for {period.label}.
                  </td>
                </tr>
              )}
            </tbody>
            <tfoot>
              <ScopeTotalsRow label={shownLabel} totals={totals} />
            </tfoot>
          </table>
        </div>
        <footer className="table-pagination">
          <span>
            Page {table?.pagination.page ?? page} of{' '}
            {shownTotalPages}
          </span>
          <div>
            <button
              type="button"
              disabled={
                !table ||
                tableQuery.isPlaceholderData ||
                table.pagination.page <= 1
              }
              onClick={() => setPage((value) => Math.max(1, value - 1))}
            >
              <ChevronLeft size={15} aria-hidden /> Previous
            </button>
            <button
              type="button"
              disabled={
                !table ||
                tableQuery.isPlaceholderData ||
                table.pagination.page >= shownTotalPages
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
