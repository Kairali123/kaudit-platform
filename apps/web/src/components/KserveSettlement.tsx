import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CheckCircle2, History, LockKeyhole } from 'lucide-react'
import { useEffect, useState } from 'react'
import { Notice } from './States'
import {
  ApiError,
  getJson,
  postJson,
  type KserveSettlementData,
  type KserveSettlementSaved,
  type KserveSettlementVersion,
} from '../lib/api'
import { money } from '../lib/money'

/**
 * The MONTHLY KSERVE SETTLEMENT section of the Billing Audit screen.
 *
 * One business value for the selected bill month: the amount actually paid to
 * KServe after negotiation. Everything else on this panel is read back from the
 * server.
 *
 * What this component deliberately does NOT do:
 *
 *   * It never calculates savings. The subtraction is deterministic server-side
 *     money; the browser renders the string it is handed. There is no
 *     arithmetic operator applied to an amount anywhere in this file.
 *   * It never parses an amount into a number. Display goes through the shared
 *     integer/BigInt formatter, and the submitted text is sent as TEXT for the
 *     server to validate exactly.
 *   * It never treats absence as zero. A month with no settlement shows
 *     "Not recorded yet" and savings shows "Unavailable".
 *
 * Saving is deliberate and double-submit-safe: the button asks for a second,
 * explicit confirmation, it is disabled while a save is in flight, and every
 * attempt carries the SAME idempotency key until a save succeeds — so a
 * double-click, a retried fetch, or an impatient second press replays the
 * version already recorded instead of appending a duplicate correction.
 */

const ROUTE = '/api/v1/billing/settlement'

/**
 * The submitted text is validated for SHAPE here only so an obviously
 * unusable value never leaves the browser. The server re-validates exactly and
 * remains the authority; this is a courtesy, never a substitute.
 */
const AMOUNT_DRAFT = /^\d{1,12}(\.\d{1,8})?$/

/** Stored `YYYY-MM-DD HH:MM:SS.ffffff`, shown as stored. Never re-zoned. */
function recordedAt(value: string): string {
  return value.slice(0, 19)
}

function versionLabel(version: KserveSettlementVersion): string {
  return version.status === 'current' ? 'Current' : 'Superseded'
}

function newIdempotencyKey(): string {
  return `set-${crypto.randomUUID()}`
}

export function KserveSettlementPanel({
  month,
  monthLabel,
  isAdmin,
}: {
  /** 'all' means no single bill month is selected. */
  month: string
  monthLabel: string
  isAdmin: boolean
}) {
  const client = useQueryClient()
  const singleMonth = month !== 'all'
  const [amount, setAmount] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [idempotencyKey, setIdempotencyKey] = useState(newIdempotencyKey)
  const [saved, setSaved] = useState<KserveSettlementSaved | null>(null)

  const query = useQuery({
    queryKey: ['kserve-settlement', month],
    queryFn: () =>
      getJson<KserveSettlementData>(
        `${ROUTE}?month=${encodeURIComponent(month)}`,
      ),
    enabled: isAdmin && singleMonth,
  })

  // A new month is a different negotiation: the draft, the confirmation, the
  // success banner and the retry key all belong to the month they were started
  // in and none of them may carry over.
  useEffect(() => {
    setAmount('')
    setConfirming(false)
    setSaved(null)
    setIdempotencyKey(newIdempotencyKey())
  }, [month])

  const save = useMutation({
    mutationFn: () =>
      postJson<KserveSettlementSaved>(ROUTE, {
        month,
        finalPaidAmountInr: amount.trim(),
        // The SAME key for every attempt at this draft. It is replaced only
        // after a save succeeds, so a retry can never append a second version.
        idempotencyKey,
      }),
    onSuccess: (result) => {
      setSaved(result)
      setAmount('')
      setConfirming(false)
      setIdempotencyKey(newIdempotencyKey())
      void client.invalidateQueries({ queryKey: ['kserve-settlement'] })
      void client.invalidateQueries({ queryKey: ['reports'] })
    },
  })

  if (!isAdmin) return null

  if (!singleMonth) {
    return (
      <section className="content-section settlement">
        <div className="section-title">
          <h2>Final amount paid to KServe</h2>
          <span className="muted">
            <LockKeyhole size={13} aria-hidden /> Admin only
          </span>
        </div>
        <p className="settlement-empty">
          A settlement covers one bill month. Choose a month to record or
          review what was finally paid.
        </p>
      </section>
    )
  }

  const data = query.data
  const draftValid = AMOUNT_DRAFT.test(amount.trim())
  const pending = save.isPending
  const failure = save.error
  const failureMessage =
    failure instanceof ApiError
      ? failure.message
      : failure
        ? 'The settlement could not be saved.'
        : null

  return (
    <section className="content-section settlement">
      <div className="section-title">
        <div>
          <h2>Final amount paid to KServe</h2>
          <span className="muted">
            {monthLabel} · the amount actually paid after negotiation
          </span>
        </div>
        <span className="muted">
          <LockKeyhole size={13} aria-hidden /> Admin only
        </span>
      </div>

      {query.isLoading && (
        <p className="settlement-empty">Loading the settlement record…</p>
      )}
      {query.error && (
        <Notice tone="warning" title="Settlement could not be read">
          {query.error instanceof ApiError
            ? query.error.message
            : 'The settlement record is temporarily unavailable.'}
        </Notice>
      )}

      {data && (
        <>
          <dl className="cas-facts settlement-facts">
            <div>
              <dt>Finally paid</dt>
              <dd>
                {data.current
                  ? money(data.current.finalPaidAmountInr)
                  : 'Not recorded yet'}
                <small>
                  {data.current
                    ? `Version ${data.current.versionNo} · recorded ` +
                      `${recordedAt(data.current.recordedAt)}`
                    : 'Pending — a settlement has not been entered for ' +
                      'this month'}
                </small>
              </dd>
            </div>
            <div>
              <dt>KServe billed this month</dt>
              <dd>
                {data.vendorBilled.available
                  ? money(data.vendorBilled.chargeInr)
                  : 'Unavailable'}
                <small>
                  {data.vendorBilled.available
                    ? `${data.vendorBilled.billedCalls.toLocaleString(
                        'en-IN',
                      )} calls with final vendor billed-minute evidence`
                    : 'No final vendor billed-minute evidence for this month'}
                </small>
              </dd>
            </div>
            <div>
              <dt>Savings</dt>
              {/* Server-calculated. The browser never subtracts. */}
              <dd className={data.savings.direction === 'overpaid' ? 'cell-warn' : ''}>
                {data.savings.available
                  ? money(data.savings.amountInr)
                  : 'Unavailable'}
                <small>
                  {data.savings.direction === 'overpaid'
                    ? 'Paid more than KServe billed'
                    : data.savings.direction === 'level'
                      ? 'Paid exactly what KServe billed'
                      : data.savings.direction === 'saved'
                        ? 'Below the KServe billed charge'
                        : 'Needs both a recorded payment and vendor billed ' +
                          'evidence'}
                </small>
              </dd>
            </div>
            <div>
              <dt>Versions</dt>
              <dd>
                {data.history.length.toLocaleString('en-IN')}
                <small>
                  {data.historyTruncated
                    ? `Showing the newest ${data.history.length}; older ` +
                      'versions are retained'
                    : 'Corrections append a new version; nothing is ' +
                      'overwritten'}
                </small>
              </dd>
            </div>
          </dl>

          <p className="settlement-basis">{data.savings.basis}</p>

          {saved && (
            <Notice
              tone="success"
              title={
                saved.outcome === 'replayed'
                  ? 'Already recorded — nothing was duplicated'
                  : `Version ${saved.current?.versionNo ?? ''} recorded`
              }
            >
              <CheckCircle2 size={14} aria-hidden />{' '}
              {saved.outcome === 'replayed'
                ? 'This exact save had already been applied, so it was ' +
                  'replayed instead of creating a second version.'
                : 'The previous version was superseded and remains in the ' +
                  'history below.'}
            </Notice>
          )}
          {failureMessage && (
            <Notice tone="warning" title="Settlement was not saved">
              {failureMessage}
            </Notice>
          )}

          <form
            className="cas-form settlement-form"
            onSubmit={(event) => {
              event.preventDefault()
              // Saving takes a second, explicit press. A submit that arrives
              // before the confirmation, while one is in flight, or with an
              // unusable draft never becomes a request.
              if (!confirming) {
                setConfirming(true)
                return
              }
              if (pending || !draftValid) return
              save.mutate()
            }}
          >
            <label>
              <span>Final amount paid to KServe (INR)</span>
              <input
                name="finalPaidAmountInr"
                value={amount}
                inputMode="decimal"
                autoComplete="off"
                placeholder="0.00"
                aria-invalid={amount.trim() !== '' && !draftValid}
                aria-describedby="settlement-amount-hint"
                onChange={(event) => {
                  setAmount(event.target.value)
                  // Editing the amount withdraws the confirmation, so a
                  // confirmed press can only ever save the value that was
                  // confirmed.
                  setConfirming(false)
                }}
              />
              <small id="settlement-amount-hint">
                {data.current
                  ? 'Saving records a correction: a new version that ' +
                    'supersedes the current one. Prior versions are never ' +
                    'changed or removed.'
                  : 'Rupees, up to eight decimal places. Negative amounts ' +
                    'are refused.'}
              </small>
            </label>
            <div className="cas-actions settlement-actions">
              <button
                type="submit"
                className={`cas-activate${confirming ? ' confirm' : ''}`}
                disabled={pending || !draftValid}
              >
                {pending
                  ? 'Saving…'
                  : confirming
                    ? `Confirm ${data.current ? 'correction' : 'save'}`
                    : 'Save'}
              </button>
              <button
                type="button"
                className={`cas-cancel cas-link${confirming ? ' shown' : ''}`}
                onClick={() => setConfirming(false)}
              >
                Cancel
              </button>
            </div>
          </form>

          <div className="data-table settlement-history">
            <div className="table-heading">
              <div>
                <span className="eyebrow">
                  <History size={13} aria-hidden /> Append-only history
                </span>
                <h3>Settlement versions for {data.monthLabel}</h3>
              </div>
            </div>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>Version</th>
                    <th>Status</th>
                    <th>Amount paid</th>
                    <th>Recorded</th>
                  </tr>
                </thead>
                <tbody>
                  {data.history.map((version) => (
                    <tr key={version.versionNo}>
                      <td>{version.versionNo}</td>
                      <td>
                        <span
                          className={`cas-status ${
                            version.status === 'current' ? 'active' : 'retired'
                          }`}
                        >
                          {versionLabel(version)}
                        </span>
                      </td>
                      <td>{money(version.finalPaidAmountInr)}</td>
                      <td>{recordedAt(version.recordedAt)}</td>
                    </tr>
                  ))}
                  {data.history.length === 0 && (
                    <tr>
                      <td colSpan={4} className="table-empty">
                        No settlement has been recorded for {data.monthLabel}.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
          <p className="settlement-basis">{data.contentBoundary}</p>
        </>
      )}
    </section>
  )
}
