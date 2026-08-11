import { useQuery } from '@tanstack/react-query'
import {
  Bot,
  CalendarRange,
  ChartColumn,
  ClipboardCheck,
  Inbox,
  ListChecks,
  ShieldCheck,
  TriangleAlert,
} from 'lucide-react'
import { useEffect, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { MetricGrid, PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState } from '../components/States'
import {
  getJson,
  type CallAuditBreakdownRow,
  type CallAuditCadence,
  type CallAuditMetricRow,
  type CallAuditReportData,
  type CallAuditReportSection,
  type CallAuditResultRow,
} from '../lib/api'

/**
 * The Kserve Call Audit Report — sanitized, anonymous, aggregate-first.
 *
 * Everything rendered here comes from the read-only reporting API, which
 * already dropped transcripts, lead identity, hashes, URLs, prompts, model
 * settings, and money. The only call identity on this page is the approved
 * anonymous Task ID. Call Audit is a separate module from Billing Audit: no
 * amount, rate, or currency appears anywhere on this screen.
 */

const CADENCES: Array<{ value: CallAuditCadence; label: string }> = [
  { value: 'daily', label: 'Daily' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'quarterly', label: 'Quarterly' },
  { value: 'yearly', label: 'Yearly' },
]

const ROW_CHOICES = [10, 25, 50, 100]

/** Mirrors the server bound, so an over-wide window is caught before a request. */
const MAX_PERIOD_DAYS = 400

const SCORE_VALUES = [1, 2, 3, 4, 5] as const

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/

/**
 * Formats a UTC-naive report datetime by reading its digits directly. It is
 * never parsed into a Date: the browser would apply the viewer's timezone and
 * silently move a call across a period boundary.
 */
function naiveDateTime(value: string | null): string {
  if (!value) return '—'
  const match = NAIVE.exec(value)
  if (!match) return value
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}, ${match[4]}:${match[5]}`
}

function naiveDay(value: string | null): string {
  if (!value) return '—'
  const match = NAIVE.exec(value)
  if (!match) return value.slice(0, 10)
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}`
}

function count(value: number): string {
  return value.toLocaleString('en-IN')
}

/** Trims trailing zeros off a fixed-precision string without touching floats. */
function decimal(value: string | null): string {
  if (value === null) return '—'
  return value.includes('.')
    ? value.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')
    : value
}

function bigCount(value: string): string {
  return value.length > 15
    ? value
    : Number(value).toLocaleString('en-IN')
}

function duration(seconds: number | null): string {
  if (seconds === null) return '—'
  const minutes = Math.floor(seconds / 60)
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`
}

function latency(value: string | null): string {
  return value === null ? '—' : `${bigCount(value)} ms`
}

function share(value: string | null): string {
  return value === null ? '—' : `${value}%`
}

/** Days between two YYYY-MM-DD inputs, read as UTC so no local offset applies. */
function dayGap(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000
}

function isCadence(value: string | null): value is CallAuditCadence {
  return CADENCES.some((cadence) => cadence.value === value)
}

// ---------------------------------------------------------------------------
// Small presentational pieces
// ---------------------------------------------------------------------------

/**
 * A tri-state call fact. Null is "not determined" and is rendered as its own
 * state — never as a "no", which would assert something the audit never found.
 */
function Fact({
  label,
  value,
}: {
  label: string
  value: boolean | null
}) {
  const state = value === null ? 'unknown' : value ? 'yes' : 'no'
  const spoken =
    value === null ? 'not determined' : value ? 'yes' : 'no'
  return (
    <span className={`ca-fact ${state}`} title={`${label}: ${spoken}`}>
      {label}
    </span>
  )
}

function BreakdownList({
  section,
}: {
  section: CallAuditReportSection
}) {
  if (section.rows.length === 0) {
    return (
      <p className="ca-none">
        Nothing was recorded for this period.
      </p>
    )
  }
  return (
    <ul className="ca-breakdown">
      {section.rows.map((row: CallAuditBreakdownRow) => (
        <li
          key={row.code}
          className={row.code === 'undetermined' ? 'muted-row' : undefined}
        >
          <span className="ca-breakdown-label">{row.label}</span>
          <span className="ca-bar" aria-hidden>
            <i style={{ width: `${row.sharePercent ?? 0}%` }} />
          </span>
          <b>{count(row.count)}</b>
          <span className="ca-breakdown-share">
            {share(row.sharePercent)}
          </span>
        </li>
      ))}
    </ul>
  )
}

function ScoreDistribution({ row }: { row: CallAuditMetricRow }) {
  if (row.scoredCount === 0) {
    return <span className="ca-none">Not scored</span>
  }
  const description = SCORE_VALUES.map(
    (value) => `${value}: ${row.distribution[String(value)] ?? 0}`,
  ).join(', ')
  return (
    <div className="ca-dist" role="img" aria-label={`Score spread — ${description}`}>
      <span className="ca-dist-bar">
        {SCORE_VALUES.map((value) => {
          const scored = row.distribution[String(value)] ?? 0
          if (scored === 0) return null
          return (
            <i
              key={value}
              className={`score-${value}`}
              style={{ flexGrow: scored }}
              title={`Score ${value} · ${count(scored)}`}
            />
          )
        })}
      </span>
      <small aria-hidden>{description}</small>
    </div>
  )
}

function ResultRow({ row }: { row: CallAuditResultRow }) {
  return (
    <tr>
      <td>
        <strong>{row.taskId ?? 'No Task ID'}</strong>
        <span className="cell-sub">
          Audited {naiveDateTime(row.auditedAt)}
        </span>
      </td>
      <td>
        {naiveDateTime(row.effectiveCallAt)}
        <span className="cell-sub">
          {duration(row.callDurationSeconds)}
          {row.serviceCategory ? ` · ${row.serviceCategory}` : ''}
        </span>
      </td>
      <td>
        {row.processingStatusLabel}
        <span className="cell-sub">
          {row.eligibilityLabel}
          {row.ineligibilityReason ? ` · ${row.ineligibilityReason}` : ''}
        </span>
      </td>
      <td>
        <span className="ca-facts">
          <Fact label="Connected" value={row.callConnected} />
          <Fact label="Customer spoke" value={row.customerSpoke} />
          <Fact label="Conversation" value={row.meaningfulConversation} />
          <Fact label="Transcript" value={row.hasTranscript} />
        </span>
      </td>
      <td>
        {row.intentLabel ?? <span className="ca-none">Not determined</span>}
        <span className="cell-sub">
          {row.intentConfidence === null
            ? 'Confidence not recorded'
            : `Confidence ${decimal(row.intentConfidence)}`}
        </span>
      </td>
      <td>
        {row.detailedOutcome ?? (
          <span className="ca-none">Not determined</span>
        )}
        <span className="cell-sub">
          {row.groupedOutcomeLabel ?? 'No grouping'}
          {row.nextActionLabel ? ` · ${row.nextActionLabel}` : ''}
        </span>
      </td>
      <td>
        {row.overallScore === null ? (
          <span className="ca-none">Not scored</span>
        ) : (
          <strong>{decimal(row.overallScore)}</strong>
        )}
        <span className="cell-sub">
          {row.qualificationLabel ?? 'Qualification not determined'}
        </span>
      </td>
      <td>
        <span
          className={
            row.kserveComparisonLabel === 'mismatch'
              ? 'cell-warn'
              : undefined
          }
        >
          {row.kserveComparisonText ?? 'Not comparable'}
        </span>
        <span className="cell-sub">
          {row.kserveReportedOutcome ?? 'KServe label not recorded'}
          {row.mismatchSeverityText
            ? ` · ${row.mismatchSeverityText}`
            : ''}
        </span>
      </td>
      <td>
        {row.issueFlags.length === 0 ? (
          <span className="ca-none">None</span>
        ) : (
          <span className="ca-flags">
            {row.issueFlags.map((flag) => (
              <span className="soft-chip" key={flag.code}>
                {flag.label}
              </span>
            ))}
          </span>
        )}
      </td>
      <td className="ca-feedback">
        {row.managementFeedback ?? (
          <span className="ca-none">No management note</span>
        )}
        {row.improvementFeedback && (
          <span className="cell-sub">{row.improvementFeedback}</span>
        )}
        {row.kserveFeedback && (
          <span className="cell-sub">{row.kserveFeedback}</span>
        )}
      </td>
    </tr>
  )
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function CallAuditReportPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const cadenceParam = searchParams.get('cadence')
  const cadence: CallAuditCadence = isCadence(cadenceParam)
    ? cadenceParam
    : 'monthly'
  const start = searchParams.get('start') ?? ''
  const end = searchParams.get('end') ?? ''
  const limitParam = Number(searchParams.get('rows'))
  const limit = ROW_CHOICES.includes(limitParam) ? limitParam : 25
  /** Used until the server states the basis, so the strip never reads "monthly runs". */
  const cadenceLabel =
    CADENCES.find((option) => option.value === cadence)?.label ?? cadence

  const rangeError = useMemo(() => {
    if (!start && !end) return null
    if (!start || !end) {
      return 'Set both a start and an end date to scope the report period.'
    }
    if (end <= start) {
      return 'The end date must be after the start date. It is exclusive: a call at exactly that instant is outside the period.'
    }
    if (dayGap(start, end) > MAX_PERIOD_DAYS) {
      return `Choose a window of at most ${MAX_PERIOD_DAYS} days.`
    }
    return null
  }, [start, end])

  const apiPath = useMemo(() => {
    const params = new URLSearchParams({
      cadence,
      limit: String(limit),
    })
    if (start && end) {
      params.set('start', start)
      params.set('end', end)
    }
    return `/api/v1/call-audit/report?${params.toString()}`
  }, [cadence, end, limit, start])

  const query = useQuery({
    queryKey: ['call-audit-report', apiPath],
    queryFn: () => getJson<CallAuditReportData>(apiPath),
    enabled: rangeError === null,
  })

  // Once the server resolves a defaulted period, show it in the controls so the
  // dates on screen and the dates in the report are always the same dates.
  const basis = query.data?.reportBasis
  useEffect(() => {
    if (!basis?.periodDefaulted || start || end) return
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current)
        next.set('start', basis.periodStart.slice(0, 10))
        next.set('end', basis.periodEndExclusive.slice(0, 10))
        return next
      },
      { replace: true },
    )
  }, [basis, end, setSearchParams, start])

  const update = (
    changes: Record<string, string | null>,
  ): void => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      for (const [key, value] of Object.entries(changes)) {
        if (value === null || value === '') next.delete(key)
        else next.set(key, value)
      }
      return next
    })
  }

  const data = query.data
  return (
    <div className="callaudit">
      <PageHeader
        eyebrow="Call audit"
        title="Kserve Call Audit Report"
        description="Sanitized, anonymous audit of the KServe AI caller Saanvi: outcome accuracy against KServe, rubric scores, and audit reliability."
        badge={
          <span className="status-badge automated">
            <ShieldCheck size={13} aria-hidden /> Anonymous reporting
          </span>
        }
      />

      <form
        className="ca-controls"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          <span>Cadence</span>
          <select
            value={cadence}
            onChange={(event) =>
              // A new cadence gets its own default period; keeping the old
              // dates would report a month-long window as a daily report.
              update({
                cadence: event.target.value,
                start: null,
                end: null,
              })
            }
          >
            {CADENCES.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Period start (UTC)</span>
          <input
            type="date"
            value={start}
            max="2100-12-31"
            onChange={(event) => update({ start: event.target.value })}
          />
        </label>
        <label>
          <span>Period end (exclusive)</span>
          <input
            type="date"
            value={end}
            max="2100-12-31"
            onChange={(event) => update({ end: event.target.value })}
          />
        </label>
        <label>
          <span>Result rows</span>
          <select
            value={String(limit)}
            onChange={(event) => update({ rows: event.target.value })}
          >
            {ROW_CHOICES.map((choice) => (
              <option key={choice} value={String(choice)}>
                {choice} rows
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="ca-reset"
          onClick={() => update({ start: null, end: null })}
        >
          <CalendarRange size={15} aria-hidden />
          Current period
        </button>
      </form>

      {rangeError ? (
        <p className="ca-invalid" role="alert">
          <TriangleAlert size={16} aria-hidden />
          {rangeError}
        </p>
      ) : (
        <div className="ca-basis">
          <div>
            <span>Report period</span>
            <strong>
              {basis ? basis.periodLabel : 'Resolving…'}
            </strong>
          </div>
          <div>
            <span>Cadence</span>
            <strong>
              {basis
                ? `${basis.cadenceLabel} runs`
                : `${cadenceLabel} runs`}
            </strong>
          </div>
          <div>
            <span>AI caller</span>
            <strong>{data?.aiCaller ?? 'Saanvi'} · KServe</strong>
          </div>
          <div>
            <span>Boundary</span>
            <strong>UTC, end exclusive</strong>
          </div>
        </div>
      )}

      <p className="ca-boundary">
        <ShieldCheck size={15} aria-hidden />
        {data?.contentBoundary ??
          'Anonymous Task IDs and sanitized audit results only. Raw transcripts, source records, prompts, and model settings stay server-internal.'}
      </p>

      {rangeError ? null : query.error && !data ? (
        <ErrorState
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : !data ? (
        // Every state without data renders something. A request that is pending
        // between retries reports no error and is not fetching, so branching on
        // isLoading alone left the page blank below the header — a report that
        // was never measured must never look like a period with nothing in it.
        <>
          {query.fetchStatus === 'paused' && (
            <p className="ca-invalid" role="status">
              <TriangleAlert size={16} aria-hidden />
              The report request is waiting for a connection and has not run
              yet. Nothing below has been measured, so this is not an empty
              period.
            </p>
          )}
          <LoadingState />
        </>
      ) : !data.hasResults ? (
        <section className="ca-empty">
          <Inbox size={26} aria-hidden />
          <h2>No audited results in this period</h2>
          <p>
            No {basis?.cadenceLabel.toLowerCase()} audit run has produced
            result rows for {basis?.periodLabel}. This is an empty period,
            not a clean sheet: nothing here has been measured, so no score,
            agreement level, or issue count can be read as zero.
          </p>
          <p className="ca-empty-hint">
            Try another cadence or a wider period. Runs recorded for this
            window: {data.runs.length === 0 ? 'none' : count(data.runs.length)}.
          </p>
        </section>
      ) : (
        <>
          {query.error && (
            // The report below is the last one that loaded, not a fresh read.
            // Saying so is the only honest option: silently re-showing it would
            // date-stamp stale figures with a period the server never confirmed.
            <p className="ca-invalid" role="status">
              <TriangleAlert size={16} aria-hidden />
              The latest refresh did not complete, so these figures are the
              last ones that loaded.{' '}
              <button
                type="button"
                className="ca-retry"
                onClick={() => void query.refetch()}
              >
                Retry now
              </button>
            </p>
          )}
          <MetricGrid tiles={data.headline} />

          <section className="content-section">
            <div className="section-title">
              <div>
                <span className="eyebrow">Outcome profile</span>
                <h2>Grouped outcome, KServe comparison, and issue flags</h2>
              </div>
              <span className="muted">
                {count(data.summary.resultCount)} result rows ·{' '}
                {count(data.summary.auditedCallCount)} calls
              </span>
            </div>
            <div className="ca-sections">
              {data.sections.map((section) => (
                <article className="ca-panel" key={section.key}>
                  <header>
                    <h3>{section.title}</h3>
                    <span>{count(section.total)}</span>
                  </header>
                  <p>{section.caption}</p>
                  <BreakdownList section={section} />
                  {section.emptyBucketCount > 0 && (
                    <small>
                      {count(section.emptyBucketCount)} further categories had
                      no results.
                    </small>
                  )}
                </article>
              ))}
            </div>
          </section>

          <section className="content-section">
            <div className="section-title">
              <div>
                <span className="eyebrow">Rubric</span>
                <h2>Metric scores</h2>
              </div>
              <span className="muted">
                Weighted 1–5 rubric · NA is counted separately, never as zero
              </span>
            </div>
            <div className="data-table ca-metric-table">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Metric</th>
                      <th scope="col">Weight</th>
                      <th scope="col">Average</th>
                      <th scope="col">Scored</th>
                      <th scope="col">NA</th>
                      <th scope="col">Score spread (1 → 5)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.metrics.map((metric) => (
                      <tr key={metric.metricCode}>
                        <td>
                          {metric.label}
                          <span className="cell-sub">{metric.metricCode}</span>
                        </td>
                        <td>{metric.weight}</td>
                        <td>
                          {metric.averageScore === null ? (
                            <span className="ca-none">Not scored</span>
                          ) : (
                            <strong>{decimal(metric.averageScore)}</strong>
                          )}
                        </td>
                        <td>{count(metric.scoredCount)}</td>
                        <td>{count(metric.notApplicableCount)}</td>
                        <td>
                          <ScoreDistribution row={metric} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="content-section">
            <div className="section-title">
              <div>
                <span className="eyebrow">Drilldown</span>
                <h2>Audited calls in this period</h2>
              </div>
              <span className="muted">
                <Bot size={14} aria-hidden /> {data.aiCaller} spoke on every
                call · Task ID only
              </span>
            </div>
            <div className="data-table audit-table ca-results">
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Task ID</th>
                      <th scope="col">Call</th>
                      <th scope="col">Audit status</th>
                      <th scope="col">Call facts</th>
                      <th scope="col">Intent</th>
                      <th scope="col">Audited outcome</th>
                      <th scope="col">Score</th>
                      <th scope="col">KServe comparison</th>
                      <th scope="col">Issue flags</th>
                      <th scope="col">Sanitized feedback</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.results.length === 0 ? (
                      <tr>
                        <td className="table-empty" colSpan={10}>
                          The period has results, but none in this page of the
                          drilldown.
                        </td>
                      </tr>
                    ) : (
                      data.results.map((row) => (
                        <ResultRow key={row.resultId} row={row} />
                      ))
                    )}
                  </tbody>
                </table>
              </div>
              <footer className="table-pagination">
                <span>
                  Showing {count(data.results.length)} of{' '}
                  {count(data.summary.resultCount)} result rows
                  {data.resultsTruncated
                    ? ' — more rows exist in this period'
                    : ''}
                </span>
                <span>Ordered by call time, earliest first</span>
              </footer>
            </div>
          </section>

          <section className="content-section ca-split">
            <article className="ca-panel">
              <header>
                <h3>
                  <ChartColumn size={15} aria-hidden /> Audit reliability
                </h3>
                <span>{count(data.reliability.attemptCount)} attempts</span>
              </header>
              <p>
                Volume and reliability of the audit itself. Token and latency
                totals only — money is never derived on this page.
              </p>
              <dl className="ca-facts-grid">
                <div>
                  <dt>Results covered</dt>
                  <dd>{count(data.reliability.resultCount)}</dd>
                </div>
                <div>
                  <dt>Attempts with an error</dt>
                  <dd
                    className={
                      data.reliability.erroredCount > 0
                        ? 'cell-warn'
                        : undefined
                    }
                  >
                    {count(data.reliability.erroredCount)}
                  </dd>
                </div>
                <div>
                  <dt>Highest attempt number</dt>
                  <dd>{count(data.reliability.maxAttemptNumber)}</dd>
                </div>
                <div>
                  <dt>Total tokens</dt>
                  <dd>{bigCount(data.reliability.totalTokens)}</dd>
                </div>
                <div>
                  <dt>Average latency</dt>
                  <dd>{latency(data.reliability.averageLatencyMs)}</dd>
                </div>
                <div>
                  <dt>Slowest attempt</dt>
                  <dd>{latency(data.reliability.maxLatencyMs)}</dd>
                </div>
              </dl>
              {data.reliability.byAttemptOutcome.length === 0 ? (
                <p className="ca-none">
                  No model attempts were recorded for this period.
                </p>
              ) : (
                <ul className="ca-breakdown">
                  {data.reliability.byAttemptOutcome.map((row) => (
                    <li key={row.attemptOutcome}>
                      <span className="ca-breakdown-label">
                        {row.label}
                        <small>
                          {' '}
                          · {bigCount(row.totalTokens)} tokens ·{' '}
                          {latency(row.averageLatencyMs)} avg
                        </small>
                      </span>
                      <span className="ca-bar" aria-hidden>
                        <i
                          style={{
                            width: `${
                              data.reliability.attemptCount === 0
                                ? 0
                                : Math.round(
                                    (row.attemptCount * 100) /
                                      data.reliability.attemptCount,
                                  )
                            }%`,
                          }}
                        />
                      </span>
                      <b>{count(row.attemptCount)}</b>
                      <span className="ca-breakdown-share">
                        {count(row.erroredCount)} err
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </article>

            <article className="ca-panel">
              <header>
                <h3>
                  <ListChecks size={15} aria-hidden /> Runs in this period
                </h3>
                <span>{count(data.runs.length)}</span>
              </header>
              <p>
                {basis?.cadenceLabel} audit runs whose own calendar period
                starts inside the selected window.
              </p>
              {data.runs.length === 0 ? (
                <p className="ca-none">
                  No run of this cadence is recorded for the window. Results
                  above may come from a run scheduled outside it.
                </p>
              ) : (
                <ul className="ca-runs">
                  {data.runs.map((run) => (
                    <li key={run.runId}>
                      <div>
                        <strong>{naiveDay(run.periodStart)}</strong>
                        <span className="cell-sub">
                          Ruleset {run.ruleVersionLabel} ·{' '}
                          {run.periodTimezone}
                        </span>
                      </div>
                      <div>
                        <span
                          className={
                            run.status === 'failed'
                              ? 'soft-chip cell-warn'
                              : 'soft-chip'
                          }
                        >
                          {run.statusLabel}
                        </span>
                        <span className="cell-sub">
                          {run.progressPercent === null
                            ? 'No candidates recorded'
                            : `${run.progressPercent}% of ${count(
                                run.totalCandidates,
                              )} processed`}
                        </span>
                      </div>
                      <div>
                        <span>
                          {count(run.succeededCount)} ok ·{' '}
                          {count(run.failedCount)} failed ·{' '}
                          {count(run.skippedCount)} skipped
                        </span>
                        <span className="cell-sub">
                          {run.errorCode
                            ? `Error code ${run.errorCode}`
                            : `Finished ${naiveDateTime(run.finishedAt)}`}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </article>
          </section>

          <p className="ca-footnote">
            <ClipboardCheck size={15} aria-hidden />
            Result rows are counted per audit run, so a re-audited call appears
            once per run that audited it. Detailed outcomes are shown exactly as
            KServe defines them.
          </p>
          <UpdatedAt value={data.generatedAt} />
        </>
      )}
    </div>
  )
}
