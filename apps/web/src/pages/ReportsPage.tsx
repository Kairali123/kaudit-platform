import { useMutation, useQuery } from '@tanstack/react-query'
import {
  ArrowDownRight,
  ArrowRight,
  ArrowUpRight,
  FileSpreadsheet,
  FileText,
  Minus,
} from 'lucide-react'
import { ErrorState, LoadingState, Notice } from '../components/States'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import {
  downloadFile,
  getJson,
  type Profile,
  type ReportsData,
} from '../lib/api'
import { useBillingPeriod } from '../lib/billingPeriod'
import { money } from '../lib/money'

export function ReportsPage() {
  const period = useBillingPeriod()
  const query = useQuery({
    queryKey: ['reports', period.month],
    queryFn: () =>
      getJson<ReportsData>(period.apiPath('/api/v1/reports')),
  })
  /**
   * One month, one document. The download is deliberately not offered for
   * "All periods": a file whose totals span cadences belongs to no billing
   * cycle the vendor could reconcile against their own invoice.
   */
  const profileQuery = useQuery({
    queryKey: ['me'],
    queryFn: () => getJson<Profile>('/api/v1/me'),
  })
  const restrictedEnabled =
    profileQuery.data?.restrictedExportEnabled === true
  const restricted = useMutation({
    mutationFn: () =>
      downloadFile(
        period.apiPath('/api/v1/reports/monthly-restricted.csv'),
        `kairali-RESTRICTED-${period.month}.csv`,
      ),
  })
  const download = useMutation({
    mutationFn: (format: 'pdf' | 'csv') =>
      downloadFile(
        period.apiPath(`/api/v1/reports/monthly.${format}`),
        `kairali-audit-${period.month}.${format}`,
      ),
  })
  if (query.isLoading) return <LoadingState />
  if (query.error)
    return <ErrorState error={query.error} retry={() => void query.refetch()} />
  const data = query.data!
  return (
    <>
      <PageHeader
        eyebrow="D-12"
        title="Revenue snapshots"
        description={
          period.month === 'all'
            ? 'Short management views at weekly, monthly, quarterly, and yearly cadence.'
            : `Monthly revenue snapshot for ${period.label}; choose All periods for cross-cadence reporting.`
        }
        badge={
          <span className={`status-badge ${data.authority}`}>
            {data.authority === 'audit_pending'
              ? 'Audit pending'
              : data.authority}
          </span>
        }
      />
      {period.month !== 'all' && (
        <section className="content-section report-downloads">
          <div>
            <span className="eyebrow">Vendor review pack</span>
            <h2>Download {period.label}</h2>
            <p>
              The PDF summarises how the month resolved and what the variance
              is made of. The CSV is one row per call — the vendor's figures
              beside ours, with the reason each call resolved as it did.
            </p>
          </div>
          <div className="report-download-actions">
            <button
              type="button"
              className="button-primary"
              disabled={download.isPending}
              onClick={() => download.mutate('pdf')}
            >
              <FileText size={16} aria-hidden />
              {download.isPending ? 'Preparing…' : 'PDF summary'}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={download.isPending}
              onClick={() => download.mutate('csv')}
            >
              <FileSpreadsheet size={16} aria-hidden />
              {download.isPending ? 'Preparing…' : 'CSV, per call'}
            </button>
          </div>
          {download.error && (
            <ErrorState
              error={download.error}
              retry={() => download.reset()}
            />
          )}
        </section>
      )}
      {period.month !== 'all' && restrictedEnabled && (
        <section className="content-section restricted-export">
          <Notice tone="warning" title="Restricted — internal review only">
            This file contains call transcripts and recording locations. It is
            not the vendor pack and must not be sent to KServe or any third
            party. Rows you are not cleared to see are withheld and counted in
            the file. Every download is logged against your account.
          </Notice>
          <div className="report-download-actions">
            <button
              type="button"
              className="button-secondary"
              disabled={restricted.isPending}
              onClick={() => restricted.mutate()}
            >
              <FileSpreadsheet size={16} aria-hidden />
              {restricted.isPending
                ? 'Preparing…'
                : 'Restricted CSV — transcripts'}
            </button>
          </div>
          {restricted.error && (
            <ErrorState
              error={restricted.error}
              retry={() => restricted.reset()}
            />
          )}
        </section>
      )}
      {data.authority === 'audit_pending' && (
        <Notice tone="warning" title="Report generation waiting for audit">
          Verified revenue and variance are withheld until all{' '}
          {data.billingCycle.totalCalls.toLocaleString('en-IN')} calls in the
          billing cycle are resolved. Vendor-claimed values may be visible, but
          they are not Kairali&apos;s verified bill.
        </Notice>
      )}
      {data.authority === 'provisional' && (
        <Notice tone="warning" title="Projection—not an approved management snapshot">
          D-03 and D-12-A remain open. Periods and values are live aggregates, not
          signed financial statements.
        </Notice>
      )}
      <Notice
        tone={
          data.emailDelivery?.status === 'published'
            ? 'success'
            : data.emailDelivery?.status === 'dead_letter'
              ? 'warning'
              : 'info'
        }
        title="Automated PDF + Excel email delivery"
      >
        {period.month === 'all'
          ? 'Choose one bill month to see its delivery status.'
          : data.emailDelivery?.status === 'published'
            ? `Sent ${data.emailDelivery.sentAt ? new Date(data.emailDelivery.sentAt).toLocaleString('en-IN') : ''}.`
            : data.emailDelivery?.status === 'pending' ||
                data.emailDelivery?.status === 'retry' ||
                data.emailDelivery?.status === 'publishing'
              ? `Delivery is ${data.emailDelivery.status}; ${data.emailDelivery.attempts} failed attempt(s).`
              : data.emailDelivery?.status === 'dead_letter'
                ? `Delivery stopped after ${data.emailDelivery.attempts} attempt(s): ${data.emailDelivery.lastErrorCode || 'unknown failure'}.`
                : 'Not queued. Email is created automatically only after the full audit, final traced billing, published rate card, uploaded invoice, and reporting approval are all present.'}
      </Notice>
      {data.settlement && (
        /**
         * Monthly settlement, beside the revenue snapshots and never mixed
         * into them: verified revenue is what the audit calculated, this is
         * what was actually paid. Both amounts and the savings between them
         * are server-calculated fixed-precision text; this page formats and
         * never subtracts.
         *
         * Three states, never two. 'recorded' shows the money; 'pending' says
         * the month has no settlement; 'unavailable' says the settlement could
         * not be READ, which is a statement about this request and not about
         * the month. A failed read is never dressed up as "not recorded".
         */
        <section className="content-section settlement-summary">
          <div className="section-title">
            <div>
              <h2>Final amount paid to KServe</h2>
              <span className="muted">{period.label}</span>
            </div>
          </div>
          {data.settlement.status === 'unavailable' && (
            <Notice tone="warning" title="Settlement temporarily unavailable">
              The settlement for this period could not be read just now. This is
              not a statement that none was recorded, and no amount below has
              been estimated. Retry the page to read it again.
            </Notice>
          )}
          <dl className="cas-facts">
            <div>
              <dt>Finally paid</dt>
              <dd>
                {data.settlement.status === 'recorded'
                  ? money(data.settlement.finallyPaidInr)
                  : data.settlement.status === 'unavailable'
                    ? 'Unavailable'
                    : 'Not recorded'}
                <small>
                  {data.settlement.status === 'recorded'
                    ? `Version ${data.settlement.finallyPaidVersion ?? '—'}`
                    : data.settlement.status === 'unavailable'
                      ? 'Settlement temporarily unavailable'
                      : 'No settlement exists for this period'}
                </small>
              </dd>
            </div>
            <div>
              <dt>KServe billed</dt>
              <dd>
                {data.settlement.vendorBilledChargeInr == null
                  ? 'Unavailable'
                  : money(data.settlement.vendorBilledChargeInr)}
                <small>
                  {data.settlement.status === 'unavailable'
                    ? 'Settlement temporarily unavailable'
                    : 'Vendor final billed minutes at the contract rate'}
                </small>
              </dd>
            </div>
            <div>
              <dt>Savings</dt>
              <dd
                className={
                  data.settlement.savingsDirection === 'overpaid'
                    ? 'cell-warn'
                    : ''
                }
              >
                {data.settlement.savingsAvailable
                  ? money(data.settlement.savingsInr)
                  : 'Unavailable'}
                <small>
                  {data.settlement.status === 'unavailable'
                    ? 'Settlement temporarily unavailable'
                    : data.settlement.savingsDirection === 'overpaid'
                      ? 'Paid more than KServe billed'
                      : data.settlement.savingsAvailable
                        ? 'KServe billed minus finally paid'
                        : 'Needs a recorded payment and vendor billed evidence'}
                </small>
              </dd>
            </div>
          </dl>
          <p className="settlement-basis">{data.settlement.basis}</p>
        </section>
      )}
      <div className="snapshot-grid">
        {data.snapshots.map((snapshot) => {
          const TrendIcon =
            snapshot.trend === 'up'
              ? ArrowUpRight
              : snapshot.trend === 'down'
                ? ArrowDownRight
                : snapshot.trend === 'flat'
                  ? ArrowRight
                  : Minus
          return (
            <article className="snapshot-card" key={snapshot.cadence}>
              <header>
                <div>
                  <span className="eyebrow">{snapshot.cadence}</span>
                  <h2>{snapshot.label}</h2>
                  <p>{snapshot.period}</p>
                </div>
                <span className={`trend ${snapshot.trend}`}>
                  <TrendIcon size={15} aria-hidden />
                  {snapshot.trendLabel}
                </span>
              </header>
              <dl>
                <div>
                  <dt>Verified billable</dt>
                  <dd>{snapshot.verified}</dd>
                </div>
                <div>
                  <dt>Vendor claim</dt>
                  <dd>{snapshot.vendorClaimed}</dd>
                  <small>{snapshot.basisLabel}</small>
                </div>
                <div>
                  <dt>Variance identified</dt>
                  <dd>{snapshot.variance}</dd>
                  <small>not recovered savings</small>
                </div>
              </dl>
            </article>
          )
        })}
      </div>
      <UpdatedAt value={data.generatedAt} />
    </>
  )
}
