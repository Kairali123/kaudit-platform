import {
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query'
import {
  BadgeCheck,
  Eraser,
  FileLock2,
  FlaskConical,
  History,
  Lock,
  Play,
  Save,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
} from 'lucide-react'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from 'react'
import { useSearchParams } from 'react-router-dom'
import { PageHeader, UpdatedAt } from '../components/Metrics'
import { ErrorState, LoadingState, Notice } from '../components/States'
import {
  ApiError,
  getJson,
  postJson,
  type CallAuditRuleTestResponse,
  type CallAuditRuleTestResult,
  type CallAuditRuleVersion,
  type CallAuditRuleVersionCreated,
  type CallAuditSettingsData,
} from '../lib/api'

/**
 * Admin-only Call Audit rule administration.
 *
 * This screen configures HOW the audit runs — version label, business prompt,
 * model, and fixed-precision temperature — and shows the immutable history of
 * every rule version. It is not an evidence surface: no transcript, source
 * record, lead identity, model output, or provider error prose is reachable
 * here, and Call Audit carries no amount, rate, or invoice value at all, which
 * stays with the separate Billing Audit module.
 *
 * The prompt shown under "Business prompt" is CONFIGURATION an administrator
 * wrote, labelled as such wherever it appears. It is fetched only when a version
 * is expanded, never as part of the ordinary list load.
 *
 * The one exception to "no transcript here" is the RULE TEST LAB below, and it
 * is an exception in one direction only: an administrator may type or paste a
 * synthetic transcript, which lives in component state and nowhere else. It
 * stays in the form after a test — the Clear action or leaving the screen is
 * what drops it — so the boundary that matters is where it may travel, not how
 * long it sits: it never reaches the URL, browser storage, a query cache key, a
 * title attribute, a log, or the result panel, and the readout takes the
 * server's sanitized result as its only prop, so it has no way to render the
 * submitted text even by accident.
 */

const ROUTE = '/api/v1/call-audit/settings'

/** Admin rule test lab. POST only, transient, and never a stored audit. */
const TEST_ROUTE = '/api/v1/call-audit/settings/test'

const MONTHS = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
]

const NAIVE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/

/**
 * Formats a UTC-naive control timestamp by reading its digits. It is never
 * parsed into a Date: the browser would apply the viewer's timezone and move an
 * activation stamp across a day boundary.
 */
function naiveDateTime(value: string | null): string {
  if (!value) return '—'
  const match = NAIVE.exec(value)
  if (!match) return value
  return `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}, ${match[4]}:${match[5]} UTC`
}

/** First twelve hex characters, which is all a human compares by eye. */
function shortHash(value: string): string {
  return value.length > 12 ? `${value.slice(0, 12)}…` : value
}

function count(value: number): string {
  return value.toLocaleString('en-IN')
}

interface DraftFields {
  versionLabel: string
  businessPrompt: string
  modelProvider: string
  modelName: string
  modelVersion: string
  temperature: string
  changeReason: string
}

const emptyDraft: DraftFields = {
  versionLabel: '',
  businessPrompt: '',
  modelProvider: '',
  modelName: '',
  modelVersion: '',
  temperature: '',
  changeReason: '',
}

/**
 * Mirrors the server rule so an obvious mistake is caught before a request.
 * The server remains the authority: it re-validates every field with the same
 * fixed-precision contract and rejects anything this check let through.
 */
function temperatureProblem(
  value: string,
  decimals: number,
  minimum: string,
  maximum: string,
): string | null {
  if (!value.trim()) return 'Temperature is required.'
  if (!/^\d+\.\d+$/.test(value.trim())) {
    return `Enter a plain decimal with ${decimals} places, for example 0.200.`
  }
  const [, fraction = ''] = value.trim().split('.')
  if (fraction.length > decimals) {
    return `At most ${decimals} decimal places are stored.`
  }
  const asThousandths = (text: string): number => {
    const [whole, part = ''] = text.split('.')
    return Number(whole) * 1000 + Number(part.padEnd(3, '0'))
  }
  const submitted = asThousandths(value.trim())
  if (
    submitted < asThousandths(minimum) ||
    submitted > asThousandths(maximum)
  ) {
    return `Temperature must be between ${minimum} and ${maximum}.`
  }
  return null
}

/**
 * The server's context bound, mirrored so a typo is caught before a request.
 * A day of seconds; the server re-validates and rejects anything past it.
 */
const MAX_DURATION_SECONDS = 86_400

/** ASCII digits only: no sign, decimal point, exponent, or separator. */
const DURATION_DIGITS = /^\d{1,7}$/

type LabDuration =
  | { ok: true; seconds: number | null }
  | { ok: false; message: string }

/**
 * Reads the optional duration into a value that can only be a whole number of
 * seconds or a deliberate "unknown".
 *
 * The distinction is the point. `Number('abc')` is NaN, and `JSON.stringify`
 * writes NaN as `null`, so converting without checking would send typed
 * nonsense to the server as an indistinguishable "duration unknown" and test a
 * different context than the administrator asked for. Blank is the ONLY input
 * that yields null here; anything unreadable is refused before the POST, and
 * the request body is built from `seconds`, which no failing input can reach.
 */
function readLabDuration(value: string): LabDuration {
  const text = value.trim()
  if (!text) return { ok: true, seconds: null }
  if (!DURATION_DIGITS.test(text)) {
    return {
      ok: false,
      message:
        'Enter whole seconds in digits only, for example 180 — or leave blank for unknown.',
    }
  }
  const seconds = Number(text)
  if (!Number.isSafeInteger(seconds) || seconds > MAX_DURATION_SECONDS) {
    return {
      ok: false,
      message: `Duration must be between 0 and ${count(MAX_DURATION_SECONDS)} seconds.`,
    }
  }
  return { ok: true, seconds }
}

/**
 * One-line display for a value with no length bound — an actor id, a model
 * name, a version label. The cell keeps its column width and the full value
 * stays reachable in the title, instead of wrapping a column down to one word
 * per line and dragging every row in the table to the same height.
 */
function Ellipsized({
  value,
  className,
}: {
  value: string | null
  className?: string
}) {
  const classes = className ? `cas-trunc ${className}` : 'cas-trunc'
  if (!value) return <span className={classes}>—</span>
  return (
    <span className={classes} title={value}>
      {value}
    </span>
  )
}

function StatusChip({ version }: { version: CallAuditRuleVersion }) {
  return (
    <span className={`cas-status ${version.status}`}>
      {version.isActive && <BadgeCheck size={12} aria-hidden />}
      {version.statusLabel}
    </span>
  )
}

function ContractFacts({ version }: { version: CallAuditRuleVersion }) {
  return (
    <dl className="cas-facts">
      <div>
        <dt>Model</dt>
        <dd>
          {version.modelName}
          <small>
            {version.modelProvider} · {version.modelVersion}
          </small>
        </dd>
      </div>
      <div>
        <dt>Temperature</dt>
        <dd className="cas-mono">{version.temperature}</dd>
      </div>
      <div>
        <dt>Rule contract</dt>
        <dd className="cas-mono">{version.ruleContractVersion}</dd>
      </div>
      <div>
        <dt>Output schema</dt>
        <dd className="cas-mono">{version.outputSchemaVersion}</dd>
      </div>
      <div>
        <dt>Taxonomy</dt>
        <dd className="cas-mono">{version.taxonomyVersion}</dd>
      </div>
      <div>
        <dt>Scoring</dt>
        <dd className="cas-mono">{version.scoringConfigVersion}</dd>
      </div>
      <div>
        <dt>Prompt digest</dt>
        <dd className="cas-mono" title={version.promptSha256}>
          {shortHash(version.promptSha256)}
        </dd>
      </div>
      <div>
        <dt>Config digest</dt>
        <dd className="cas-mono" title={version.configSha256}>
          {shortHash(version.configSha256)}
        </dd>
      </div>
    </dl>
  )
}

function yesNo(value: boolean): string {
  return value ? 'Yes' : 'No'
}

/**
 * The sanitized test readout.
 *
 * It takes the server's result and NOTHING else — no transcript, no draft, no
 * page state — so the submitted text is structurally out of reach here rather
 * than merely left unrendered. Every value below is a count, a coded enum, a
 * fixed-precision decimal, or a bounded error code.
 */
function RuleTestReadout({ result }: { result: CallAuditRuleTestResult }) {
  const { metadata } = result
  // Present for every outcome except a thrown port, which reports null rather
  // than a zero that would read as a real measurement.
  const usage = result.usage
  return (
    <div className="cas-lab-result">
      <div className="cas-lab-head">
        <span
          className={`cas-status ${
            result.status === 'succeeded' ? 'completed' : 'failed'
          }`}
        >
          {result.status === 'succeeded'
            ? 'Produced a result'
            : result.status === 'refused'
              ? 'Model refused'
              : 'No valid output'}
        </span>
        <span className="muted">
          Test outcome only — not recorded as an audit of any call
        </span>
      </div>
      <dl className="cas-facts">
        <div>
          <dt>Version tested</dt>
          <dd>
            <Ellipsized value={metadata.versionLabel} />
            <small>
              {metadata.modelProvider} · {metadata.modelName} ·{' '}
              {metadata.modelVersion}
            </small>
          </dd>
        </div>
        <div>
          <dt>Temperature</dt>
          <dd className="cas-mono">{metadata.temperature}</dd>
        </div>
        <div>
          <dt>Submitted size</dt>
          <dd>
            {count(metadata.transcriptCharacterCount)} characters
            <small>{count(metadata.transcriptLineCount)} lines</small>
          </dd>
        </div>
        <div>
          <dt>Context sent</dt>
          <dd>
            {metadata.context.language ?? 'Language unknown'}
            <small>
              {metadata.context.durationSeconds === null
                ? 'Duration unknown'
                : `${count(metadata.context.durationSeconds)} seconds`}
            </small>
          </dd>
        </div>
      </dl>

      {result.status === 'succeeded' ? (
        <>
          <dl className="cas-facts">
            <div>
              <dt>Intent</dt>
              <dd>{result.output.intent}</dd>
            </div>
            <div>
              <dt>Detailed outcome</dt>
              <dd>{result.output.detailedOutcome}</dd>
            </div>
            <div>
              <dt>Grouped outcome</dt>
              <dd>{result.output.groupedOutcome}</dd>
            </div>
            <div>
              <dt>Qualification</dt>
              <dd>{result.output.qualification}</dd>
            </div>
            <div>
              <dt>Next action</dt>
              <dd>{result.output.nextAction}</dd>
            </div>
            <div>
              <dt>Confidence</dt>
              <dd className="cas-mono">{result.output.confidence}</dd>
            </div>
            <div>
              <dt>Overall score</dt>
              <dd className="cas-mono">{result.output.overallScore ?? '—'}</dd>
            </div>
            <div>
              <dt>Call reached</dt>
              <dd>
                Connected {yesNo(result.output.callConnected)}
                <small>
                  Customer spoke {yesNo(result.output.customerSpoke)} ·
                  Meaningful {yesNo(result.output.meaningfulConversation)}
                </small>
              </dd>
            </div>
          </dl>

          <div className="cas-lab-block">
            <h3>Metric scores</h3>
            <ul className="cas-chips">
              {result.output.metricScores.map((entry) => (
                <li key={entry.metric}>
                  {entry.metric}
                  <strong>{entry.score}</strong>
                </li>
              ))}
            </ul>
          </div>

          <div className="cas-lab-block">
            <h3>Issue flags</h3>
            {result.output.issueFlags.length === 0 ? (
              <p className="cas-lab-none">No issue flag was raised.</p>
            ) : (
              <ul className="cas-chips">
                {result.output.issueFlags.map((flag) => (
                  <li key={flag}>{flag}</li>
                ))}
              </ul>
            )}
          </div>

          {/* Lengths only. The three narrative fields the model wrote stay
              server-side; a character count shows a field was produced without
              putting model prose about a call onto an admin screen. */}
          <div className="cas-lab-block">
            <h3>Written feedback produced</h3>
            <ul className="cas-chips">
              <li>
                Management summary
                <strong>
                  {count(
                    result.output.feedbackLengths
                      .managementSummaryCharacterCount,
                  )}
                </strong>
              </li>
              <li>
                KServe feedback
                <strong>
                  {count(
                    result.output.feedbackLengths.kserveFeedbackCharacterCount,
                  )}
                </strong>
              </li>
              <li>
                Improvement feedback
                <strong>
                  {count(
                    result.output.feedbackLengths
                      .improvementFeedbackCharacterCount,
                  )}
                </strong>
              </li>
            </ul>
            <p className="cas-lab-none">
              Character counts, not the text. The written fields are not
              readable on this surface.
            </p>
          </div>
        </>
      ) : (
        <p className="cas-drift" role="status">
          <TriangleAlert size={14} aria-hidden />
          <span>
            {result.status === 'refused'
              ? 'The model declined to answer this transcript. '
              : 'The attempt produced no valid output. '}
            Kind <strong className="cas-mono">{result.failure.kind}</strong> ·
            code <strong className="cas-mono">{result.failure.errorCode}</strong>
            . No provider message is available here, by design.
          </span>
        </p>
      )}

      <div className="cas-lab-block">
        <h3>Attempt facts</h3>
        {usage === null ? (
          <p className="cas-lab-none">
            The provider call produced no usage facts at all, so none are shown
            rather than an invented zero.
          </p>
        ) : (
          <dl className="cas-facts">
            <div>
              <dt>Input tokens</dt>
              <dd className="cas-mono">{usage.inputTokens ?? '—'}</dd>
            </div>
            <div>
              <dt>Output tokens</dt>
              <dd className="cas-mono">{usage.outputTokens ?? '—'}</dd>
            </div>
            <div>
              <dt>Total tokens</dt>
              <dd className="cas-mono">{usage.totalTokens ?? '—'}</dd>
            </div>
            <div>
              <dt>Elapsed</dt>
              <dd className="cas-mono">{usage.latencyMs} ms</dd>
            </div>
            <div>
              <dt>Provider reference</dt>
              <dd className="cas-mono">
                <Ellipsized value={usage.requestId} />
              </dd>
            </div>
          </dl>
        )}
      </div>
    </div>
  )
}

export function CallAuditSettingsPage() {
  const client = useQueryClient()
  const [searchParams, setSearchParams] = useSearchParams()
  const detailId = searchParams.get('detail')
  const [draft, setDraft] = useState<DraftFields>(emptyDraft)
  const [created, setCreated] =
    useState<CallAuditRuleVersionCreated | null>(null)
  const [confirmActivate, setConfirmActivate] = useState(false)
  const promptRef = useRef<HTMLElement | null>(null)

  /**
   * Test-lab state. `labTranscript` is the administrator's transient text. It
   * is held here and nowhere else: never lifted into the URL, browser storage,
   * a query key, or the result below. It is NOT cleared on success — the text
   * stays in the form so a run can be repeated or amended, and it leaves state
   * only when "Clear transcript and result" is used or the screen unmounts.
   */
  const [labTranscript, setLabTranscript] = useState('')
  const [labLanguage, setLabLanguage] = useState('')
  const [labDuration, setLabDuration] = useState('')
  const [labVersion, setLabVersion] = useState('')
  const [labResult, setLabResult] = useState<CallAuditRuleTestResponse | null>(
    null,
  )

  const query = useQuery({
    queryKey: ['call-audit-settings', detailId ?? ''],
    queryFn: () =>
      getJson<CallAuditSettingsData>(
        detailId
          ? `${ROUTE}?detail=${encodeURIComponent(detailId)}`
          : ROUTE,
      ),
  })

  const create = useMutation({
    mutationFn: (activate: boolean) =>
      postJson<CallAuditRuleVersionCreated>(ROUTE, {
        versionLabel: draft.versionLabel,
        businessPrompt: draft.businessPrompt,
        modelProvider: draft.modelProvider,
        modelName: draft.modelName,
        modelVersion: draft.modelVersion,
        temperature: draft.temperature,
        changeReason: draft.changeReason,
        activate,
      }),
    onSuccess: (result) => {
      setCreated(result)
      setDraft(emptyDraft)
      setConfirmActivate(false)
      void client.invalidateQueries({ queryKey: ['call-audit-settings'] })
    },
  })

  /**
   * A mutation, deliberately: `useQuery` would put the submitted text into a
   * cache key and keep it alive across navigations. A mutation has no key and
   * no cache, so the request body exists only for the call.
   */
  const runTest = useMutation({
    mutationFn: () => {
      // Re-read rather than trust the disabled button: a refused duration must
      // not be able to reach the body, where NaN would serialize to the same
      // `null` a blank field means.
      const duration = readLabDuration(labDuration)
      if (!duration.ok) throw new Error(duration.message)
      return postJson<CallAuditRuleTestResponse>(TEST_ROUTE, {
        transcript: labTranscript,
        ruleVersionId: labVersion || null,
        context: {
          language: labLanguage.trim() || null,
          durationSeconds: duration.seconds,
        },
      })
    },
    onSuccess: (response) => setLabResult(response),
  })

  /** Drops the submitted text and everything derived from it in one action. */
  function clearTest() {
    setLabTranscript('')
    setLabLanguage('')
    setLabDuration('')
    setLabResult(null)
    runTest.reset()
  }

  const data = query.data
  const contract = data?.contract
  const openedVersionId = data?.detail?.ruleVersionId ?? null

  /**
   * The prompt panel sits with the active version, but 'View' is also at the
   * bottom of the history table. Without this the panel opens off-screen and
   * the click looks like it did nothing. 'nearest' leaves an already-visible
   * panel where it is, so expanding from the active card does not jump.
   */
  useEffect(() => {
    if (!openedVersionId) return
    promptRef.current?.scrollIntoView({
      behavior: 'smooth',
      block: 'nearest',
    })
  }, [openedVersionId])

  const field = (name: keyof DraftFields) => ({
    value: draft[name],
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      setCreated(null)
      setDraft((current) => ({
        ...current,
        [name]: event.target.value,
      }))
    },
  })

  const temperatureError = useMemo(() => {
    if (!contract || !draft.temperature) return null
    return temperatureProblem(
      draft.temperature,
      contract.temperatureDecimals,
      contract.minTemperature,
      contract.maxTemperature,
    )
  }, [contract, draft.temperature])

  const incomplete =
    !draft.versionLabel.trim() ||
    !draft.businessPrompt.trim() ||
    !draft.modelProvider.trim() ||
    !draft.modelName.trim() ||
    !draft.modelVersion.trim() ||
    !draft.temperature.trim()
  const blocked = incomplete || temperatureError !== null || create.isPending
  const labDurationError = useMemo(() => {
    const parsed = readLabDuration(labDuration)
    return parsed.ok ? null : parsed.message
  }, [labDuration])

  const labBlocked =
    !labTranscript.trim() ||
    labDurationError !== null ||
    runTest.isPending ||
    (data?.versions.length ?? 0) === 0

  function submit(event: FormEvent, activate: boolean) {
    event.preventDefault()
    if (blocked) return
    create.mutate(activate)
  }

  function openDetail(ruleVersionId: string | null) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current)
      if (ruleVersionId) next.set('detail', ruleVersionId)
      else next.delete('detail')
      return next
    })
  }

  return (
    <div className="callaudit casettings">
      <PageHeader
        eyebrow="Call audit · administration"
        title="Call Audit Rule Settings"
        description="Rule versions that govern how the KServe AI caller Saanvi is audited. Every version is an immutable snapshot: a correction is a new version, never an edit."
        badge={
          <span className="status-badge automated">
            <Lock size={13} aria-hidden /> Administrators only
          </span>
        }
      />

      <p className="ca-boundary">
        <ShieldCheck size={15} aria-hidden />
        {data?.boundary ??
          'Administrator configuration only. No transcript, source record, model output, or billing value is available on this surface.'}
      </p>

      {query.error && !data ? (
        <ErrorState
          error={query.error}
          retry={() => void query.refetch()}
        />
      ) : !data || !contract ? (
        <LoadingState />
      ) : (
        <>
          {query.error && (
            /* A failed refresh must not pass silently: the screen would keep
               showing a configuration that may no longer be what is live. */
            <p className="ca-invalid" role="alert">
              <TriangleAlert size={16} aria-hidden />
              <span>
                Showing the configuration loaded earlier — the last refresh
                failed.
              </span>
              <button
                type="button"
                className="ca-retry"
                onClick={() => void query.refetch()}
              >
                Retry
              </button>
            </p>
          )}

          {created && (
            <Notice
              tone={created.activated ? 'success' : 'info'}
              title={
                created.outcome === 'replayed'
                  ? 'This exact version already existed'
                  : created.activated
                    ? 'Rule version created and activated'
                    : 'Draft rule version created'
              }
            >
              {created.versionLabel} · {created.statusLabel} · prompt digest{' '}
              {shortHash(created.promptSha256)}.
              {created.outcome === 'replayed' &&
                ' The stored snapshot matched byte for byte, so nothing was rewritten.'}
            </Notice>
          )}

          <section className="cas-active">
            <div className="section-title">
              <h2>
                <BadgeCheck size={16} aria-hidden /> Active rule version
              </h2>
              <span className="muted">
                {data.activeVersion
                  ? `Live since ${naiveDateTime(data.activeVersion.activatedAt)}`
                  : 'No version is live'}
              </span>
            </div>
            {data.activeVersion ? (
              <article className="cas-card active">
                <header>
                  <div>
                    <strong>{data.activeVersion.versionLabel}</strong>
                    <span>
                      Created {naiveDateTime(data.activeVersion.createdAt)}
                    </span>
                  </div>
                  <StatusChip version={data.activeVersion} />
                </header>
                <ContractFacts version={data.activeVersion} />
                {!data.activeVersion.matchesApplicationContract && (
                  <p className="cas-drift" role="status">
                    <TriangleAlert size={14} aria-hidden />
                    This version was activated under an earlier locked contract
                    than the one this build compiles. Create a new version to
                    adopt the current schema, taxonomy, and rubric.
                  </p>
                )}
                <button
                  type="button"
                  className="cas-link"
                  onClick={() =>
                    openDetail(
                      detailId === data.activeVersion?.ruleVersionId
                        ? null
                        : data.activeVersion?.ruleVersionId ?? null,
                    )
                  }
                >
                  <FileLock2 size={14} aria-hidden />
                  {detailId === data.activeVersion.ruleVersionId
                    ? 'Hide business prompt'
                    : 'Show business prompt'}
                </button>
              </article>
            ) : (
              <p className="ca-none cas-empty-line">
                Nothing is auditing yet. Create a version below and activate it
                to put a rule contract live.
              </p>
            )}
          </section>

          {/* Always present, so 'nothing selected' is stated rather than left
              as an absence, and so opening a prompt does not shuffle the
              sections below it into new positions. */}
          <section className="cas-prompt" ref={promptRef}>
            <div className="section-title">
              <h2>
                <FileLock2 size={16} aria-hidden /> Business prompt
              </h2>
              <span className="muted">
                {data.detail
                  ? `${count(data.detail.businessPromptLength)} characters · administrator configuration, not call evidence`
                  : 'Administrator configuration, not call evidence'}
              </span>
            </div>
            {data.detail ? (
              <>
                <p className="cas-prompt-note">
                  Guidance an administrator wrote and stored with{' '}
                  <Ellipsized
                    value={data.detail.versionLabel}
                    className="cas-inline"
                  />
                  . It contains no customer content, no transcript, and no
                  model output, and it is never shown outside this admin
                  screen.
                </p>
                <pre className="cas-prompt-body">
                  {data.detail.businessPrompt}
                </pre>
                <button
                  type="button"
                  className="cas-link"
                  onClick={() => openDetail(null)}
                >
                  Close
                </button>
              </>
            ) : detailId ? (
              <p className="ca-none cas-empty-line">
                That rule version is not in this list, so no prompt could be
                opened.{' '}
                <button
                  type="button"
                  className="cas-link cas-inline"
                  onClick={() => openDetail(null)}
                >
                  Clear selection
                </button>
              </p>
            ) : data.versions.length === 0 ? (
              <p className="ca-none cas-empty-line">
                No rule version exists yet, so no prompt has been stored.
              </p>
            ) : (
              <p className="ca-none cas-empty-line">
                No version selected. Use “Show business prompt” above, or
                “View” in the version history, to read the prompt stored with a
                version.
              </p>
            )}
          </section>

          {/* Sits with the active version and the prompt it belongs to: what
              a rule version does is only legible next to what it is. */}
          <section className="cas-lab">
            <div className="section-title">
              <h2>
                <FlaskConical size={16} aria-hidden /> Rule test lab
              </h2>
              <span className="muted">
                Transient · nothing is stored and no call is audited
              </span>
            </div>
            <p className="cas-note">
              <Lock size={14} aria-hidden />
              Use synthetic or already-approved text. What you submit stays in
              this form until you clear it or leave the screen, and is never
              stored, logged, or returned — only its size, the coded result, and
              the attempt facts come back.
            </p>
            <form
              className="cas-form cas-lab-form"
              onSubmit={(event) => {
                event.preventDefault()
                if (labBlocked) return
                runTest.mutate()
              }}
            >
              <label>
                <span>Rule version</span>
                <select
                  value={labVersion}
                  onChange={(event) => setLabVersion(event.target.value)}
                >
                  <option value="">
                    {data.activeVersion
                      ? `Active — ${data.activeVersion.versionLabel}`
                      : 'Active version'}
                  </option>
                  {data.versions.map((version) => (
                    <option
                      key={version.ruleVersionId}
                      value={version.ruleVersionId}
                    >
                      {version.versionLabel} · {version.statusLabel}
                    </option>
                  ))}
                </select>
                <small>
                  Leave on Active to test what is live. Any listed version can
                  be exercised without changing what is live.
                </small>
              </label>
              <label>
                <span>Language (optional)</span>
                <input
                  value={labLanguage}
                  onChange={(event) => setLabLanguage(event.target.value)}
                  placeholder="hi"
                />
                <small>Detected language label sent as context.</small>
              </label>
              <label>
                <span>Duration seconds (optional)</span>
                <input
                  value={labDuration}
                  onChange={(event) => setLabDuration(event.target.value)}
                  inputMode="numeric"
                  placeholder="180"
                  aria-invalid={labDurationError !== null}
                />
                <small>
                  {labDurationError ?? 'Whole seconds. Blank means unknown.'}
                </small>
              </label>
              <label className="cas-wide">
                <span>Transcript for this test</span>
                <textarea
                  value={labTranscript}
                  onChange={(event) => setLabTranscript(event.target.value)}
                  rows={9}
                  spellCheck={false}
                  autoComplete="off"
                />
                <small>
                  {count(labTranscript.length)} characters. Held in this form
                  only, until you clear it or leave.
                </small>
              </label>

              {runTest.error && (
                <p
                  className={
                    runTest.error instanceof ApiError &&
                    runTest.error.status === 503
                      ? 'cas-drift cas-wide'
                      : 'ca-invalid cas-wide'
                  }
                  role="alert"
                >
                  <TriangleAlert size={16} aria-hidden />
                  <span>
                    {runTest.error.message}
                    {runTest.error instanceof ApiError &&
                      runTest.error.status === 503 &&
                      ' Nothing was sent to a model and nothing was audited.'}
                  </span>
                </p>
              )}

              <div className="cas-actions cas-wide">
                <button
                  type="submit"
                  className="primary-action"
                  disabled={labBlocked}
                >
                  <Play size={15} aria-hidden />
                  {runTest.isPending ? 'Running…' : 'Run test'}
                </button>
                <button
                  type="button"
                  className="cas-link"
                  onClick={clearTest}
                  disabled={runTest.isPending}
                >
                  <Eraser size={14} aria-hidden />
                  Clear transcript and result
                </button>
              </div>
              <p className="cas-hint cas-wide" role="status">
                {data.versions.length === 0
                  ? 'No rule version exists yet, so there is nothing to test.'
                  : runTest.isPending
                    ? 'Running one model call against the selected version.'
                    : !labTranscript.trim()
                      ? 'Paste or type text above to enable the test.'
                      : labDurationError
                        ? 'Fix the duration above to enable the test. A duration that cannot be read is refused here rather than sent as “unknown”.'
                        : 'Ready. Running does not create a rule version, a run, or an audit record.'}
              </p>
            </form>

            {labResult ? (
              <RuleTestReadout result={labResult.result} />
            ) : (
              <p className="ca-none cas-empty-line">
                No test has been run on this screen. A result appears here and
                is discarded when you leave or clear it.
              </p>
            )}
          </section>

          <section className="cas-create">
            <div className="section-title">
              <h2>
                <SlidersHorizontal size={16} aria-hidden /> New rule version
              </h2>
              <span className="muted">
                {data.activationAvailable
                  ? 'A draft can be created, or created and activated'
                  : 'A draft can be created; a version is already live'}
              </span>
            </div>
            <form
              className="cas-form"
              onSubmit={(event) => submit(event, false)}
            >
              <label>
                <span>Version label</span>
                <input
                  {...field('versionLabel')}
                  maxLength={contract.maxVersionLabelLength}
                  placeholder="call-audit/2026.08.1"
                  required
                />
              </label>
              <label>
                <span>Model provider</span>
                <input
                  {...field('modelProvider')}
                  maxLength={contract.maxModelProviderLength}
                  placeholder="openai"
                  required
                />
              </label>
              <label>
                <span>Model name</span>
                <input
                  {...field('modelName')}
                  maxLength={contract.maxModelNameLength}
                  required
                />
              </label>
              <label>
                <span>Model version</span>
                <input
                  {...field('modelVersion')}
                  maxLength={contract.maxModelVersionLength}
                  placeholder="2026-08-01"
                  required
                />
              </label>
              <label>
                <span>
                  Temperature ({contract.temperatureDecimals} decimals)
                </span>
                <input
                  {...field('temperature')}
                  inputMode="decimal"
                  placeholder="0.200"
                  aria-invalid={temperatureError !== null}
                  required
                />
                <small>
                  {temperatureError ??
                    `Fixed precision, ${contract.minTemperature}–${contract.maxTemperature}. Stored exactly as typed.`}
                </small>
              </label>
              <label>
                <span>Change reason</span>
                <input
                  {...field('changeReason')}
                  maxLength={contract.maxChangeReasonLength}
                  placeholder="Why this version exists"
                />
              </label>
              <label className="cas-wide">
                <span>Business prompt</span>
                <textarea
                  {...field('businessPrompt')}
                  maxLength={contract.maxBusinessPromptLength}
                  rows={9}
                  required
                />
                <small>
                  {count(draft.businessPrompt.length)} /{' '}
                  {count(contract.maxBusinessPromptLength)} characters.
                  Business guidance only — the output schema, outcome taxonomy,
                  scoring rubric, and privacy rules are locked by the
                  application and cannot be overridden here.
                </small>
              </label>

              {create.error && (
                <p className="ca-invalid cas-wide" role="alert">
                  <TriangleAlert size={16} aria-hidden />
                  {create.error.message}
                </p>
              )}

              {/* One activate button that changes state in place, and a cancel
                  that keeps its slot when hidden, so arming the confirmation
                  never reflows the row under the pointer. */}
              <div className="cas-actions cas-wide">
                <button
                  type="submit"
                  className="primary-action"
                  disabled={blocked}
                >
                  <Save size={15} aria-hidden />
                  {create.isPending && !confirmActivate
                    ? 'Saving…'
                    : 'Save as draft'}
                </button>
                <button
                  type="button"
                  className={
                    confirmActivate ? 'cas-activate confirm' : 'cas-activate'
                  }
                  disabled={
                    blocked || (!confirmActivate && !data.activationAvailable)
                  }
                  onClick={(event) => {
                    if (confirmActivate) submit(event, true)
                    else setConfirmActivate(true)
                  }}
                >
                  <Play size={15} aria-hidden />
                  {create.isPending && confirmActivate
                    ? 'Activating…'
                    : confirmActivate
                      ? 'Confirm: create and put live'
                      : 'Create and activate…'}
                </button>
                <span
                  className={
                    confirmActivate ? 'cas-cancel shown' : 'cas-cancel'
                  }
                >
                  <button
                    type="button"
                    className="cas-link"
                    tabIndex={confirmActivate ? undefined : -1}
                    aria-hidden={!confirmActivate}
                    onClick={() => setConfirmActivate(false)}
                  >
                    Cancel
                  </button>
                </span>
              </div>
              {/* Says why the activate button is in the state it is in. A
                  tooltip would hide the reason from every touch device. */}
              <p className="cas-hint cas-wide" role="status">
                {!data.activationAvailable
                  ? 'A version is already live, so this form can only add a draft. Activation is refused while another version is active.'
                  : confirmActivate
                    ? 'Confirm to create this version and make it the live rule contract in one append-only step.'
                    : 'Save as draft to store the snapshot without changing what is live.'}
              </p>
              <p className="cas-note cas-wide">
                <Lock size={14} aria-hidden />
                Saving writes an immutable snapshot. Activation is an append-only
                action, not an edit: it never rewrites an existing version, and
                it is refused while another version is live.
              </p>
            </form>
          </section>

          <section className="cas-history">
            <div className="section-title">
              <h2>
                <History size={16} aria-hidden /> Version history
              </h2>
              <span className="muted">
                {count(data.versionCount)} versions
              </span>
            </div>
            {data.versions.length === 0 ? (
              <p className="ca-none cas-empty-line">
                No rule version has been created yet.
              </p>
            ) : (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th className="cas-col-label">Version</th>
                      <th className="cas-col-status">Status</th>
                      <th className="cas-col-model">Model</th>
                      <th className="cas-col-temp">Temp.</th>
                      <th className="cas-col-contract">Contract</th>
                      <th className="cas-col-digest">Prompt digest</th>
                      <th className="cas-col-digest">Config digest</th>
                      <th className="cas-col-actor">Created</th>
                      <th className="cas-col-actor">Activated</th>
                      <th className="cas-col-actor">Retired</th>
                      <th className="cas-reason">Change reason</th>
                      <th className="cas-col-open">Prompt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.versions.map((version) => (
                      <tr key={version.ruleVersionId}>
                        <td className="cas-col-label">
                          <Ellipsized value={version.versionLabel} />
                        </td>
                        <td className="cas-col-status">
                          <StatusChip version={version} />
                        </td>
                        <td className="cas-col-model">
                          <Ellipsized value={version.modelName} />
                          <Ellipsized
                            value={`${version.modelProvider} · ${version.modelVersion}`}
                            className="cas-sub"
                          />
                        </td>
                        <td className="cas-mono cas-col-temp">
                          {version.temperature}
                        </td>
                        <td className="cas-mono cas-col-contract">
                          {version.ruleContractVersion}
                          {!version.matchesApplicationContract && (
                            <small className="cas-sub warn">
                              differs from this build
                            </small>
                          )}
                        </td>
                        <td
                          className="cas-mono cas-col-digest"
                          title={version.promptSha256}
                        >
                          {shortHash(version.promptSha256)}
                        </td>
                        <td
                          className="cas-mono cas-col-digest"
                          title={version.configSha256}
                        >
                          {shortHash(version.configSha256)}
                        </td>
                        <td className="cas-col-actor">
                          {naiveDateTime(version.createdAt)}
                          <Ellipsized
                            value={version.createdBy ?? 'unrecorded author'}
                            className="cas-sub"
                          />
                        </td>
                        <td className="cas-col-actor">
                          {naiveDateTime(version.activatedAt)}
                          <Ellipsized
                            value={version.activatedBy}
                            className="cas-sub"
                          />
                        </td>
                        <td className="cas-col-actor">
                          {naiveDateTime(version.retiredAt)}
                          <Ellipsized
                            value={version.retiredBy}
                            className="cas-sub"
                          />
                        </td>
                        <td
                          className="cas-reason"
                          title={version.changeReason ?? undefined}
                        >
                          {version.changeReason ?? '—'}
                        </td>
                        <td className="cas-col-open">
                          <button
                            type="button"
                            className="cas-link"
                            onClick={() =>
                              openDetail(
                                detailId === version.ruleVersionId
                                  ? null
                                  : version.ruleVersionId,
                              )
                            }
                          >
                            {detailId === version.ruleVersionId
                              ? 'Hide'
                              : 'View'}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="cas-runs">
            <div className="section-title">
              <h2>
                <History size={16} aria-hidden /> Recent audit runs
              </h2>
              <span className="muted">
                Operational context · counters and coded outcomes only
              </span>
            </div>
            {data.recentRuns.length === 0 ? (
              <p className="ca-none cas-empty-line">
                No audit run has been recorded yet.
              </p>
            ) : (
              <ul className="ca-runs">
                {data.recentRuns.map((run) => (
                  <li key={run.runId}>
                    <div>
                      <strong
                        title={run.ruleVersionLabel ?? run.ruleVersionId}
                      >
                        {run.ruleVersionLabel ?? run.ruleVersionId}
                      </strong>
                      <span>
                        {run.runType} · {run.periodTimezone}
                      </span>
                    </div>
                    <div>
                      <span className={`cas-status ${run.status}`}>
                        {run.statusLabel}
                      </span>
                      <span>
                        {run.errorCode ? `Code ${run.errorCode}` : '—'}
                      </span>
                    </div>
                    <div>
                      <span>
                        {count(run.processedCount)} of{' '}
                        {count(run.totalCandidates)} processed ·{' '}
                        {count(run.succeededCount)} succeeded ·{' '}
                        {count(run.failedCount)} failed ·{' '}
                        {count(run.skippedCount)} skipped
                      </span>
                      <span>
                        {naiveDateTime(run.startedAt)} →{' '}
                        {naiveDateTime(run.finishedAt)}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="cas-locked">
            <div className="section-title">
              <h2>
                <Lock size={16} aria-hidden /> Locked by the application
              </h2>
              <span className="muted">
                Config digest {shortHash(contract.configSha256)}
              </span>
            </div>
            <p className="cas-prompt-note">
              These are pinned in code and versioned with the contract. An
              administrator owns {contract.editableFields.join(', ')}; the
              application owns everything below.
            </p>
            <ul className="cas-locked-list">
              {contract.lockedFields.map((name) => (
                <li key={name}>{name}</li>
              ))}
            </ul>
          </section>

          <UpdatedAt value={data.generatedAt} />
        </>
      )}
    </div>
  )
}
