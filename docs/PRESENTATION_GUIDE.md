# Kairali AI Call Audit Platform — Presentation Guide

**Prepared:** 27 July 2026  
**Audience:** Kairali management, finance, operations, and engineering  
**Scope:** What the platform is, why it exists, how it works, what every visible
parameter means, what is live today, and what remains before an authoritative
bill can be released.

---

## 1. The simplest accurate description

Kairali uses KServe to place AI verification calls and receives a monthly usage
sheet and invoice from KServe. The Kaudit platform is Kairali's independent
control system: it imports KServe's task-level claims, obtains available call
recordings, verifies the recording bytes, transcribes and classifies each call,
estimates the genuine chargeable conversation window, applies Kairali's locked
billing rules deterministically, and compares the result with KServe's claim.
It then exposes evidence coverage, quality findings, billing readiness,
variance, operational health, and management summaries through a protected
dashboard.

The platform does **not** place calls and does not operate the KServe voicebot.
It audits the service after the event.

---

## 2. Why Kairali needs it

Without an independent auditor, Kairali must largely trust three vendor claims:

1. that a billed task corresponds to a real call;
2. that the duration used for billing represents genuine customer interaction;
3. that the monthly aggregate invoice follows the agreed rate and rounding
   rules.

Those claims can be wrong even without deliberate overbilling. A connected call
may contain silence, voicemail, one-sided AI speech, network failure, a long
post-conversation tail, or an incorrectly reported duration. KServe's invoice
contains aggregate duration-band totals rather than a per-call billed amount,
so Kairali must reconstruct the task-level calculation to explain a dispute.

The platform therefore solves four risks:

- **Evidence risk:** a row in a sheet is not proof that a useful conversation
  occurred.
- **Duration risk:** ringing time, connected time, recording length, speech
  time, and meaningful conversation time are different clocks.
- **Financial risk:** a plausible total may still be based on the wrong
  duration, rate-card version, or rounding rule.
- **Control risk:** without a reproducible trace, Kairali cannot convincingly
  explain a disputed amount later.

---

## 3. Who uses it

### Management

Management needs a short view of:

- how many calls were independently auditable;
- how much KServe claimed;
- how much Kaudit independently calculated;
- the variance identified;
- whether the result is authoritative or still pending;
- the direction of the trend against the previous period.

Management normally sees aggregate information, not call recordings or
transcripts.

### Finance

Finance needs:

- the imported invoice and task-level usage population;
- the approved rate-card version;
- the verified billable total;
- overstatement or understatement against the vendor claim;
- unresolved calls and their financial treatment;
- reconciliation and dispute status;
- downloadable evidence-backed reports once implemented.

### Developer/platform owner

The developer monitors whether automation is functioning:

- calls waiting for audit;
- completed, retrying, or terminally failed calls;
- model and ruleset versions;
- confidence and unusual duration outputs;
- evidence hashes;
- queue, outbox, idempotency, and audit-log health.

The developer is not expected to listen to and approve every call.

### Standard operational user

The simplified access model has two roles:

- `admin`: full access, including imports, configuration, audit inspection, and
  user/access management;
- `user`: day-to-day read/review/reconciliation/report permissions, excluding
  administrative controls.

Unknown or unassigned users receive no operational permissions.

---

## 4. The three truth layers

This is the most important conceptual slide.

| Layer | Meaning | Examples |
|---|---|---|
| Vendor claim | What KServe says happened or should be billed | Task ID, connected seconds, billed minutes, invoice total |
| Independent evidence | What Kaudit can verify from the recording and processing trail | Retrieved bytes, SHA-256, decoded duration, speech timestamps, detected language, final customer exchange |
| Contractual result | What the approved deterministic rules say is payable | Grace-adjusted duration, rounded minutes, INR amount, invoice variance |

The platform never silently turns a vendor claim into an independently verified
fact.

---

## 5. Complete monthly workflow

### Stage 1 — Upload KServe usage and invoice

An administrator opens `/imports/new`.

For the usage CSV:

1. The browser sends the selected file for a non-persistent preview.
2. The server validates every row deterministically.
3. It checks the required columns, duplicate task IDs, numeric duration values,
   recognized call dates, and recording-URL coverage.
4. It derives a suggested period start and period end.
5. The administrator may correct the period fields.
6. Nothing is written until **Submit usage** is pressed.

For the invoice PDF:

1. OpenAI reads the printed invoice metadata using a strict output schema.
2. It suggests invoice number, invoice date, period, subtotal, tax, and total.
3. Suggestions remain editable.
4. The AI extraction is not financially authoritative.
5. Nothing is written until **Submit invoice** is pressed.

### Stage 2 — Preserve and normalize the source files

On submission:

1. Kaudit calculates the file's SHA-256.
2. The original CSV or PDF is stored under Kaudit's private, gitignored import
   root using a content-addressed path.
3. The file is represented in SQL as an evidence object and source envelope.
4. The file hash becomes the idempotency identity. Uploading identical bytes
   returns the existing result instead of duplicating the cycle.
5. Each new task is normalized into call, external-reference, call-leg,
   provider-duration, and recording-artifact records.

The application does not read KCRM code or KCRM's local evidence folder.

### Stage 3 — Decide whether a call can enter audio audit

A call with an approved canonical recording URL becomes eligible.

A call without a recording URL remains in SQL but is explicitly not
independently auditable. It is not silently counted as a completed audit.

The current locked KServe sheet has eight standard columns and normally does
not contain a Recording URL. A separate recording manifest/API feed, or an
optional `Recording URL` column, is therefore needed for automatic audio audit
of newly imported calls.

### Stage 4 — Fetch and verify evidence

For each eligible call:

1. Kaudit stores the stable canonical KServe S3 object URL in
   `kaudit_call_artifact.source_url`.
2. At processing time, it calls the configured unpod proxy afresh.
3. The proxy streams the audio bytes directly.
4. Kaudit rejects non-HTTPS sources, unapproved source hosts, redirects,
   non-audio responses, empty bodies, and files above the configured size
   limit.
5. Kaudit calculates the SHA-256 of the downloaded bytes.
6. The first successful pass establishes the baseline hash.
7. A later pass must reproduce the same hash.

Possible evidence outcomes:

- `hash_recorded`: first successful hash baseline;
- `verified`: fetched bytes match the stored baseline;
- `source_missing`: the source cannot be fetched;
- `evidence_altered`: the fetched bytes no longer match;
- `unsafe_url`: URL policy rejected the source;
- `no_url`: no source reference exists.

### Stage 5 — Transcribe the call

The current auditor sends the audio to OpenAI Whisper:

- provider: `openai`;
- model: `whisper-1`;
- output: verbose JSON with segment timestamps;
- detected language: normalized to lower case;
- recorded duration: decoded duration reported by Whisper;
- speech duration: sum of transcript segment durations.

The raw transcript is not displayed in the aggregate dashboard.

### Stage 6 — Merge transcript segments into natural blocks

Whisper segments are merged into numbered speech blocks. A new block starts
when any of these is true:

- the pause from the previous block is at least **1,000 ms**;
- the resulting block would exceed **15,000 ms**;
- the resulting text would exceed **250 characters**.

This produces a concise timestamped structure such as:

```text
#1 [0.0–4.8] Saanvi introduction...
#2 [5.9–8.4] Customer response...
#3 [9.5–14.2] Saanvi follow-up...
```

No speaker labels are supplied by Whisper in this flow.

### Stage 7 — Classify the conversation

`gpt-4o-mini-2024-07-18` receives:

- detected language;
- vendor connected duration, when available;
- independently decoded recording duration;
- detected speech duration;
- whether vendor-connected and recorded duration differ materially;
- numbered timestamped transcript blocks.

The model must return a strict JSON object containing:

- one category from the 12-category catalog;
- confidence from 0 to 1;
- customer block numbers;
- unclear block numbers;
- whether the customer spoke;
- timestamp of the last meaningful customer exchange;
- remarks;
- a dispute-recommendation signal.

Temperature is zero for more stable output. The transcript passed to the model
is capped at 60,000 characters.

The model does **not** calculate rates, rounding, tax, or money.

### Stage 8 — Build independent duration facts

Kaudit derives:

- decoded recording duration;
- total detected speech;
- estimated customer speech;
- estimated agent speech;
- last meaningful customer exchange;
- whether the vendor duration and recording duration differ by more than five
  seconds;
- the grace-adjusted chargeable window;
- remaining one-way tail.

### Stage 9 — Persist the audit trail

On success, one transaction writes:

- completed audit run;
- media-analysis record;
- transcript identity and timestamped segments;
- finding with category, confidence, origin, evidence references, and ruleset;
- call outcome and processing status;
- recording hash and verification time;
- `call.audit_completed` outbox event.

The trace records the model, engine, ruleset, evidence hash, and timestamp.

### Stage 10 — Apply the authority gates

The AI output is not automatically a final financial fact merely because the
model returned a high confidence.

A final verified charge requires:

1. calibration completed;
2. a threshold configured for that language and finding type;
3. confidence meeting the threshold;
4. a resolved conversation assessment;
5. a published rate card with named approver and approval time;
6. rate-card ruleset hash matching the locked code ruleset;
7. hashed evidence and a completed audit identity.

Below-threshold output must remain unresolved and request an automated secondary
pass. The billing core already produces that unresolved state and next-action
code; the secondary-pass scheduler/orchestrator is not live yet. No human review
queue is required by the current leadership direction.

### Stage 11 — Calculate each call deterministically

Once the gates pass, the deterministic billing engine:

1. calculates the grace-adjusted duration;
2. applies the locked rounding rule;
3. calculates the INR amount using fixed-precision integer/decimal arithmetic;
4. records every intermediate;
5. writes a final billing decision trace.

### Stage 12 — Release the billing cycle

The monthly verified bill is withheld until every imported call has one
explicit resolution:

- `independent_conversation_end`, or
- `accepted_as_billed_unverified` at cycle close when no usable recording can
  be obtained after the automated retry policy.

The fallback must be explicitly recorded. It is not called independently
verified.

Cycle sequence:

```text
no data
  → audit pending
  → calibration pending
  → rate card pending
  → final calculation pending
  → ready
```

Only `ready` releases verified revenue and variance.

### Stage 13 — Reconcile and report

The intended final comparison is:

```text
variance = vendor claim − independently verified amount
```

- Positive variance: vendor claimed more than the verified amount.
- Negative variance: verified amount is higher than the vendor claim.
- Zero/within tolerance: aligned.

The current dashboard withholds verified revenue and variance while the cycle
is not ready.

---

## 6. Audit Monitor — every column explained

The `/audits` page is an **admin-only monitoring surface**. It is not a manual
approval queue.

### Task / call reference

The preferred display identity is KServe's task ID from
`kaudit_call_external_reference`. If none exists, the platform falls back to
the internal logical call key.

The small date below it is the call's billing-period date.

### Audited

The timestamp at which the completed audit run or latest completed media
analysis was recorded.

### Category

The single primary outcome produced by the current classifier. Category is a
reason label; it is not a price multiplier.

### Language

The language detected by Whisper, for example `english`, `hindi`,
`malayalam`, or another returned value.

This matters because model performance can differ by language and
code-switching style. Final thresholds must be calibrated by language and
finding type.

### Confidence

The model's self-reported certainty from 0 to 1, displayed as a percentage.

Example:

```text
stored confidence = 0.85000000
displayed confidence = 85.0%
```

Confidence is **not measured accuracy**. A model may be confidently wrong.
Accuracy is obtained only by comparing model outputs with an authorized,
human-labeled calibration set.

### Recorded

The independently decoded recording duration:

```text
recordedDurationMs = Whisper/decoder duration of the fetched audio bytes
```

This is not taken from KServe's spreadsheet.

### Speech

The sum of the durations of timestamped Whisper segments:

```text
speechDurationMs =
  Σ max(0, transcriptSegment.endMs − transcriptSegment.startMs)
```

It represents detected speech across the recording, not necessarily customer
speech and not necessarily billable time.

### Customer end

The timestamp at the end of the last speech block that the classifier
identifies as a meaningful customer response:

```text
conversationEndMs = lastMeaningfulCustomerExchangeMs
```

If no meaningful customer speech is established, the value is absent.

This value is an AI-derived fact and remains uncalibrated today.

### Grace-adjusted

This is the central chargeable-duration candidate.

Leadership decided that a normal Saanvi wrap-up after the customer's last
meaningful response should still count, up to 60 seconds. The formula is:

```text
graceAdjustedDurationMs =
  min(
    recordedDurationMs,
    lastMeaningfulCustomerExchangeMs + 60,000
  )
```

If there is no meaningful customer exchange:

```text
graceAdjustedDurationMs = 0
```

It is called “grace-adjusted” because it takes the customer end and adds the
approved 60-second AI goodbye/wrap-up allowance without extending beyond the
actual recording.

#### Grace-adjusted example A

```text
recording length         = 50 seconds
last customer exchange   = 10 seconds
configured grace         = 60 seconds
10 + 60                  = 70 seconds
min(50, 70)              = 50 seconds
grace-adjusted duration  = 50 seconds
```

The full 50-second recording is inside the allowed customer-plus-wrap-up
window.

#### Grace-adjusted example B

```text
recording length         = 200 seconds
last customer exchange   = 40 seconds
configured grace         = 60 seconds
40 + 60                  = 100 seconds
min(200, 100)            = 100 seconds
grace-adjusted duration  = 100 seconds
```

The final 100 seconds are outside the chargeable conversation window.

#### Grace-adjusted example C

```text
recording length         = 90 seconds
meaningful customer speech = none
grace-adjusted duration  = 0 seconds
```

The 60-second grace is not granted when no meaningful customer exchange was
established.

### Vendor connected

KServe's `Duration (Seconds) Without Ringing`, converted to milliseconds:

```text
vendorConnectedDurationMs =
  duration_without_ringing_sec × 1,000
```

This remains a vendor claim.

### Difference

The Audit Monitor calculates:

```text
displayedDifferenceMs =
  vendorConnectedDurationMs − graceAdjustedDurationMs
```

- Positive: KServe connected duration is longer than Kaudit's
  grace-adjusted duration.
- Negative: KServe connected duration is shorter.
- Above +60 seconds: highlighted as a suspicious positive duration gap.

This is a diagnostic duration difference, not the final rupee variance.

### Evidence

`Hashed` means a SHA-256 exists on the recording artifact used for analysis.

`Not hashed` means that row does not yet carry the required recording hash.

A hash proves whether two byte sequences are identical; it does not prove that
the vendor-hosted file will remain available forever.

### Model / engine

The main label is the ASR model, currently `whisper-1`.

The secondary label is the audit-engine or outcome-taxonomy version, for
example:

```text
kairali-independent-reaudit/2.0.0
```

Versioning is essential because results must be reproducible and model/rule
changes must not silently rewrite history.

### State

Typical values include:

- `Model output`: model-generated result, not calibrated final truth;
- `system_observed`: deterministic infrastructure/evidence condition;
- legacy values such as `candidate`.

The current V2 writer stores successful classification findings as
`model_output`. Automatic final confirmation based on calibrated thresholds is
not live yet.

---

## 7. Duration glossary

| Duration | Meaning | Current source |
|---|---|---|
| Attempt duration | Dial request to terminal state | Vendor/carrier events when available |
| Ringing duration | Call initiation/ringing before answer | `Duration With Ringing − Duration Without Ringing`, conceptually |
| Vendor connected duration | KServe's answer-to-end claim | CSV `Duration (Seconds) Without Ringing` |
| Vendor billed minutes | KServe's task-level minute quantity | CSV `Duration (Minutes) - Actual Billing Mins` |
| Vendor billed amount | KServe's task-level money claim | CSV `Actual Billing Amount` |
| Recorded duration | Length of fetched and decoded audio | Independent Whisper/decoder output |
| Speech duration | Sum of timestamped speech segments | Whisper timestamps |
| Customer speech | Sum of blocks attributed to customer | Classifier speaker attribution |
| Agent speech | Sum of non-customer, non-unclear blocks | Classifier speaker attribution |
| Customer end | End timestamp of last meaningful customer exchange | Classifier |
| Grace-adjusted duration | Customer end + 60-second wrap-up, capped at recording length | Deterministic rule over AI fact |
| One-way tail | Recording after the grace-adjusted point | Independent deterministic formula |
| Displayed difference | Vendor connected minus grace-adjusted | Audit Monitor comparison |
| Billable duration | Grace-adjusted duration after contractual rounding | Deterministic billing engine |

### Five-second duration mismatch

Kaudit sets a duration-mismatch signal when:

```text
abs(vendorConnectedDurationMs − recordedDurationMs) > 5,000
```

The model sees this signal. It may select `INCORRECT_CALL_DURATION`, but the
underlying numeric fact is retained separately.

### One-way tail

The billing engine calculates:

```text
oneWayTailMs =
  max(0, recordedDurationMs − graceAdjustedDurationMs)
```

An alert is raised only when:

```text
oneWayTailMs > 60,000
```

Exactly 60 seconds is not alerted; anything above 60 seconds is.

Do not confuse one-way tail with the Audit Monitor's displayed Difference:

```text
one-way tail = recorded − grace-adjusted
Difference   = vendor connected − grace-adjusted
```

---

## 8. The 12 call categories

| Code | Plain-language meaning | Typical signal |
|---|---|---|
| `TIME_DURATION` | Call continued too long or ended too early for the conversational outcome | Unproductive tail or premature end |
| `AGENT_FAILURE` | Saanvi misunderstood, repeated, stopped, gave incorrect information, missed required questions, or mishandled a do-not-call request | Agent behavior failure |
| `CONNECT_NOT_FRUITFUL` | A person answered but no meaningful outcome resulted | Busy, not interested, callback, early hang-up, language mismatch |
| `INACTIVE_CALL` | Little or no meaningful interaction after connection | Silence/background noise/no detectable speech |
| `INCORRECT_CALL_DURATION` | Vendor duration materially differs from decoded recording duration | Greater than five-second mismatch signal |
| `AI_CONVERSATION_HANDLING` | Conversation technically ran but was awkwardly handled | Interruptions, ignored answers, duplicated questions, abrupt topic change |
| `VOICEMAIL` | Voicemail or answering machine answered | Recorded message/machine cues |
| `AI_TO_AI` | Saanvi interacted with an IVR or another automated assistant | No human joined |
| `NETWORK_FAILURE_TELECOM` | Telecom/network impairment harmed the call | Distortion, one-way audio, drop |
| `USER_SILENCE` | A person appears to have answered but did not respond while Saanvi spoke | One-sided agent speech |
| `JUNK_CALL` | No legitimate customer interaction | Wrong number, test, spam pickup machine |
| `OK` | Normal, legitimate, properly handled two-way conversation | Meaningful exchange without material issue |

Category describes the reason or quality outcome. The amount is calculated
from the verified duration and rate rules, not from a category multiplier.

### System/evidence failure findings

The persistent worker also creates infrastructure findings:

| Finding | Meaning | Retry treatment |
|---|---|---|
| `SOURCE_MISSING` | Recording cannot be fetched | Retried until attempt limit |
| `EVIDENCE_ALTERED` | Current bytes do not match baseline SHA-256 | Terminal, visible finding |
| `UNSAFE_SOURCE_URL` | URL violates approved-source policy | Terminal, visible finding |
| `TRANSCRIPTION_FAILED` | Whisper processing failed | Retried |
| `CLASSIFICATION_FAILED` | Structured classification failed | Retried |

A call with no recording URL is retained as an explicitly unauditable call; it
does not enter the worker queue.

---

## 9. Billing rules and exact formulas

### Locked rate interpretation

- adjusted duration = 0: INR 0;
- 0 < adjusted duration < 30 seconds: 0.5 minute, flat INR 4.75;
- exactly 30 seconds: 1 minute, INR 9.50;
- 30–60 seconds: 1 minute, INR 9.50;
- every new minute entered rounds up:
  - more than 60 and up to 120 seconds: 2 minutes, INR 19.00;
  - more than 120 and up to 180 seconds: 3 minutes, INR 28.50;
  - and so on.

The code operates in milliseconds. Therefore 60,001 ms enters the second
minute.

### Rounding formula

```text
if adjusted_ms = 0:
    billable_minutes = 0
    rule = ZERO_DURATION_NOT_BILLED

else if adjusted_ms < 30,000:
    billable_minutes = 0.5
    rule = SHORT_CALL_FLAT

else:
    billable_minutes = ceil(adjusted_ms / 60,000)
    rule = PER_MINUTE_CEIL
```

### Amount formula

```text
verified amount = billable minutes × INR 9.50
```

The implementation uses paise and `BigInt`/fixed-precision decimal strings.
It does not use binary floating point for money.

### Boundary examples

| Grace-adjusted duration | Billable minutes | Amount | Rule |
|---:|---:|---:|---|
| 0 sec | 0 | INR 0.00 | `ZERO_DURATION_NOT_BILLED` |
| 1 sec | 0.5 | INR 4.75 | `SHORT_CALL_FLAT` |
| 29.999 sec | 0.5 | INR 4.75 | `SHORT_CALL_FLAT` |
| 30 sec | 1 | INR 9.50 | `PER_MINUTE_CEIL` |
| 60 sec | 1 | INR 9.50 | `PER_MINUTE_CEIL` |
| 60.001 sec | 2 | INR 19.00 | `PER_MINUTE_CEIL` |
| 120 sec | 2 | INR 19.00 | `PER_MINUTE_CEIL` |
| 120.001 sec | 3 | INR 28.50 | `PER_MINUTE_CEIL` |

### Tax and TDS

The locked commercial interpretation records 18% IGST and 2% TDS as
invoice-level concerns. The current per-call billing core stores zero per-call
tax and does not yet perform the final IGST/TDS/round-off reconciliation.
The invoice importer stores the printed subtotal, tax, and total.

---

## 10. Confidence, calibration, and automatic re-check

### Why a global 85% threshold is not automatically used

Hindi, English, Hinglish, and Malayalam can have different transcription and
classification performance. A threshold must be selected from measured
calibration results by:

- language;
- finding type;
- model/ruleset version.

### Required calibration process

1. Draw an authorized, stratified sample of already processed calls.
2. Have competent labelers establish ground truth.
3. Compare category, customer/agent attribution, and conversation-end output.
4. Measure precision, recall, error rate, and duration error by language and
   finding type.
5. Choose thresholds that meet the approved business risk level.
6. Publish a calibration version.

### Low-confidence behavior

Under the approved policy, if confidence is below the calibrated threshold:

1. decision becomes `unresolved`;
2. next action is an automated secondary model pass;
3. retries are bounded;
4. if retries are exhausted, the call remains unresolved until cycle close;
5. the approved cycle-close fallback may accept KServe's supplied minutes,
   explicitly labeled `accepted_as_billed_unverified`.

Low-confidence calls do not silently disappear.

The pure billing decision core implements these unresolved reason/next-action
outputs. The production automated secondary-model runner and cycle-close
fallback writer remain to be implemented.

### Current status

Calibration is not complete. Current model outputs are useful for monitoring
and anomaly inspection, but they are not authoritative billing ground truth.

---

## 11. Evidence integrity and its limitation

### What SHA-256 provides

SHA-256 creates a 64-character fingerprint of the audio bytes.

```text
same bytes       → same hash
different bytes  → overwhelmingly likely different hash
```

It supports:

- proving which bytes were analyzed;
- detecting later replacement or modification;
- linking transcript, media analysis, finding, and billing trace to one input.

### What SHA-256 does not provide

It does not guarantee future availability. Recordings remain hosted by KServe,
not in Kairali-controlled object storage.

If KServe removes a recording:

- Kaudit keeps the old hash;
- Kaudit can show that the source is missing;
- Kaudit cannot reproduce the original bytes from the hash.

This was a conscious cost-driven decision. It weakens dispute-grade custody
relative to independent Kairali object storage.

### Proxy behavior

The unpod proxy is called fresh for every fetch. The platform stores the
canonical S3 URL, not an expiring signed URL.

Current safeguards:

- fixed HTTPS proxy base;
- approved source-host allowlist;
- redirect rejection;
- audio content-type requirement;
- 120-second timeout;
- 32 MB maximum response;
- non-empty body requirement.

---

## 12. Retry and worker behavior

### Candidate selection

The worker selects only calls where:

- final recording artifact exists;
- `source_url` exists;
- attempt count is below eight;
- next retry time is due;
- processing status is not completed or exhausted;
- no completed legacy/V2 audit already satisfies the skip rule.

### Skip-completed guarantee

Before processing and again before persistence, the worker checks whether the
call already has a completed audit. This protects against re-auditing calls
that have already been successfully completed.

### Retry schedule

Retryable failures use exponential backoff:

```text
attempt 1 → 1 minute
attempt 2 → 2 minutes
attempt 3 → 4 minutes
attempt 4 → 8 minutes
...
maximum delay → 6 hours
maximum attempts → 8
```

Altered evidence and unsafe URLs are terminal immediately.

### Concurrency protection

A MySQL advisory lock permits only one full-call audit worker at a time.

The worker processes each selected batch sequentially. Current local
`app:operate` configuration requests batches of ten and watches for new/due
calls every 15 seconds.

### Start-command distinction

- `npm run app:start`: dashboard only; does not spend OpenAI money.
- `npm run app:operate`: dashboard plus continuous audit worker.
- opening a page never starts the audit by itself.

At the time this guide was prepared, the combined process had been stopped at
the user's request.

---

## 13. Dashboard pages and parameters

### `/login` — Sign in

Purpose:

- authenticate a Kairali user before any protected page or API is available.

Current local mode:

- verifies a one-way scrypt password hash server-side;
- stores no plaintext password in browser storage or SQL;
- issues a signed, expiring, `HttpOnly`, `SameSite=Strict` session cookie;
- works only on loopback development.

Production requires Kairali OIDC/SSO and MFA; that integration is not yet
configured.

### `/` — Home/Profile

Displays:

- signed-in email;
- authentication mode;
- assigned role;
- effective permissions;
- aggregate-only content boundary.

`admin:all` means the admin role passes every application permission check.

### `/overview` — Platform Overview

Shows only headline platform counts and release gates.

Headline tiles:

- **Calls ingested:** count of `kaudit_call`.
- **Recordings referenced:** recording artifacts with `source_url`.
- **Integrity baselines recorded:** recording artifacts with SHA-256.
- **Recordings verified reachable:** recording artifacts with
  `last_verified_at`.

Authority gates:

- access control;
- rate-card approval;
- AI calibration;
- billing-cycle audit completion;
- management-reporting approval.

### `/evidence` — Calls & Evidence

Additional tiles:

- **Evidence objects:** imported source files and evidence records.
- **Ingestion batches:** completed batches versus total batches.
- **Users provisioned:** users in `kaudit_user`.
- **Integrity findings:** evidence/backfill anomaly events in the audit log.

The page does not mean every recording is independently stored. It explicitly
states that recording bytes remain vendor-hosted.

### `/findings` — Findings

Tiles:

- **Calls analyzed:** distinct calls with completed audit runs.
- **Findings generated:** all audit-finding records.
- **Average model confidence:** average stored confidence, excluding null
  confidence values; not measured accuracy.
- **Audit runs:** all audit execution records, including statuses represented
  in the table.

Tables:

- top finding codes and counts;
- average model confidence per finding code;
- confirmation/decision states;
- finding origin, such as model or deterministic rule;
- active quality-catalog version/status when present.

Current authority label: `uncalibrated`.

### `/billing` — Billing

Before readiness, tiles show:

- **Verified bill:** `Audit pending`, calibration pending, rate-card pending,
  or calculation pending;
- **Billing cycle:** current call period and call count;
- **Audit resolved:** independently completed plus explicit accepted-as-billed
  fallbacks;
- **Audit pending:** remaining unresolved calls.

Once ready, tiles become:

- verified bill;
- invoice/vendor claim;
- variance identified;
- billable minutes.

Other facts:

- rate-card version/status;
- formal approval state;
- latest reconciliation status;
- percentage of cycle calls resolved.

### `/reports` — D-12 Revenue Snapshots

Cadences:

- weekly: most recently completed ISO Monday–Sunday week;
- monthly: most recently completed calendar month;
- quarterly: most recently completed Indian fiscal quarter;
- yearly: most recently completed Indian fiscal year, April–March.

Default headline:

- verified billable;
- vendor claim;
- variance identified;
- trend versus prior same-cadence period.

Current implementation uses the invoice total when an invoice exactly matches
the requested period. Otherwise it uses KServe's supplied per-log billed
amounts. A blank amount falls back to vendor-asserted minutes and the available
unit rate. The result remains clearly labeled as no invoice.

Trend uses verified revenue and a 2% dead-band:

```text
change within ±2% → flat
above +2%         → up
below −2%         → down
```

When the cycle is audit-pending, verified values, variance, and trend are
withheld.

PDF/Excel generation and automatic recipient notification are not live.

### `/operations` — Reliability

Shows aggregate statuses for:

- **Outbox:** events waiting to be published, retrying, published, or
  dead-lettered.
- **Inbox:** consumed message identities used to prevent duplicate work.
- **Job attempts:** worker execution/retry history.
- **Idempotency:** whether a write is processing, completed/replayable, or in
  conflict.
- **Audit events:** security and access events.
- **Audit-chain configured:** whether the tamper-evident chain head exists.

Current audit completions create outbox messages. A production queue publisher
is not currently running, so `pending` outbox records are expected.

### `/imports/new` — Import Billing Cycle

Usage preview parameters:

- row count;
- period start/end;
- recording URL count;
- missing recording URL count;
- recognized columns;
- validation warnings.

Usage result:

- received;
- accepted;
- duplicates;
- audit jobs queued;
- missing recording URLs.

Invoice fields:

- invoice number;
- invoice date;
- period start/end;
- subtotal;
- tax;
- total;
- extraction model;
- extraction confidence;
- warnings.

The user must press separate submit buttons for usage and invoice.

### `/audits` — Audit Monitor

Summary:

- **AI-audited calls:** strict count requiring completed media analysis,
  completed classification, completed transcript, and a canonical category.
- **Eligible, still pending:** recording-backed calls minus strict completed
  audits.
- **No recording:** calls without a recording URL.
- **New V2 re-audit:** completed runs from
  `kairali-independent-reaudit/2.0.0`.

The page refreshes every 15 seconds; the server caches the result for five
seconds to reduce repeated database load.

---

## 14. Import field glossary

| KServe column | Meaning in Kaudit |
|---|---|
| Task ID | Stable external call identity and deduplication key |
| Destination Number | Source customer endpoint; stored but never exposed in the aggregate UI |
| Call Start Time | Dial/initiation timestamp |
| Call Connected Time | Vendor's answer/connect timestamp |
| Call End Time | Vendor's terminal timestamp |
| Duration (Seconds) With Ringing | Vendor attempt duration including ringing |
| Duration (Seconds) Without Ringing | Vendor connected-duration claim |
| Duration (Minutes) - Actual Billing Mins | Vendor task-level billed-minute quantity |
| Actual Billing Amount | Vendor task-level billed-amount claim |
| Recording URL, optional | Canonical recording evidence source |

Required validations:

- exactly the locked required headers;
- non-empty Task ID;
- no repeated Task ID inside the file;
- non-negative numeric duration fields;
- recognizable call dates for period suggestion;
- approved URL host and canonical format when a URL is present.

Maximum HTTP upload size is currently 25 MB.

---

## 15. Billing-cycle authority explained

### Resolved audit calls

```text
resolvedAuditCalls =
  min(
    totalCalls,
    completedV2AuditCalls + acceptedAsBilledFallbackCalls
  )
```

### Audit pending calls

```text
auditPendingCalls =
  max(0, totalCalls − resolvedAuditCalls)
```

### Coverage percentage

```text
auditCoveragePercent =
  resolvedAuditCalls / totalCalls × 100
```

### Why a completed legacy billing row is not enough

The existing 43,245 billing rows were produced under a draft rate card and lack
the V2 independent-duration decision trace. Their existence does not make the
new verified cycle complete.

An authoritative current calculation must be final and carry:

- approved calculation basis;
- audit-run identity;
- input-manifest hash;
- billing ruleset hash;
- decision-trace hash;
- finalization timestamp;
- no newer superseding row.

---

## 16. Reconciliation and dispute lifecycle

### Intended reconciliation

1. import usage population;
2. import original invoice;
3. audit every call or explicitly record the fallback;
4. calculate one current verified amount per call;
5. aggregate by the contract's duration bands;
6. compare with invoice lines/aggregate;
7. classify the difference;
8. open a dispute when the configured materiality rule is met.

### Variance sign

```text
net variance = vendor claimed − verified
```

Use “identified variance,” not “savings,” until KServe accepts a credit or the
amount is otherwise recovered.

### Business dispute states

```text
Pending Review
  → Disputed
  → Under Negotiation
  → Resolved — Credited
  → Resolved — Accepted
```

The system may automatically identify and prepare a dispute. Finance/management
records the negotiation and resolution state because those are real-world
events outside the calculation engine.

### Current status

The schema exists, and the dashboard can read the latest reconciliation
aggregate. Full automatic matching, dispute writer, evidence bundle, and
resolution workflow are not yet live.

---

## 17. Management reporting

Each D-12 snapshot is designed to show only three headline decisions:

1. independently verified billable amount;
2. variance against vendor claim;
3. direction versus the prior period.

Full detail remains available for drill-down.

The report must preserve:

- cadence and period boundaries;
- whether claim basis was invoice or provider usage;
- source manifest/evidence hash;
- ruleset and calculation versions;
- unresolved amount excluded;
- generated timestamp;
- provisional/authoritative status.

Current UI provides live projections. Persisted
`kaudit_management_snapshot` generation, PDF/Excel exports, and automated
delivery remain pending.

---

## 18. Security and access boundaries

### Authentication

- local email/password mode: loopback development only;
- production target: Kairali OIDC/SSO with MFA;
- unauthenticated browser routes redirect to `/login`;
- protected APIs return 401/403, not business data.

### Authorization

- every protected API checks a permission;
- `/audits` requires `audit:inspect`, which is admin-only;
- `/imports/new` requires `import:write`, which is admin-only;
- reports require `snapshot:read`;
- aggregate pages require `metrics:read`.

### Content boundary

The current UI excludes:

- phone numbers;
- audio playback;
- transcript text;
- source URLs;
- health/customer content;
- free-text model remarks/explanations.

The Audit Monitor shows task reference and privacy-safe processing metadata
only.

### Access audit

Successful and denied access events are written to a hash-chained audit log.
Each entry includes actor, action, resource, outcome, purpose, correlation ID,
client/IP metadata, timestamp, previous hash, and current hash.

### Secrets

Database and OpenAI credentials are loaded from ignored local environment
files. They are not placed in Git or browser storage.

---

## 19. Reliability controls

### Idempotency

The same file or mutation should not create duplicate business results.

- usage/invoice file identity: SHA-256;
- call identity: KServe task ID;
- outbox message identity: deterministic event key;
- API idempotency: request hash and replayable response reference.

### Transactional outbox

Business state and its event are written in one MySQL transaction. This avoids:

- business data saved but event lost;
- event published but business transaction rolled back.

### Inbox

Consumers record `consumer + message_id` so duplicate delivery becomes a no-op.

### Dead-letter behavior

Messages that fail beyond the configured attempt limit become visible
dead-letter records. Payload hashes are checked before publication.

### Correlation IDs

HTTP responses carry a correlation ID. Errors use privacy-safe problem
responses without exposing SQL, secrets, transcripts, or stack traces.

---

## 20. Current real-data snapshot

Read-only aggregate snapshot taken on 27 July 2026 after the latest controlled
worker run:

| Measure | Current value | Interpretation |
|---|---:|---|
| Calls in SQL | 43,245 | Full known legacy population |
| Recording URLs | 16,371 | Maximum currently eligible for independent audio audit |
| No recording URL | 26,874 | Cannot currently be independently audio-audited |
| Strict completed audio/classification rows | 234 | Completed recording-backed monitor population |
| New V2 completed audits | 10 | Results from the new standalone auditor |
| Pending recording-backed rows | 16,129 | Still waiting |
| Transcription failures currently marked | 4 | Retry/error population |
| Classification failures currently marked | 1 | Retry/error population |
| Existing billing calculations | 43,245 | Legacy, not authoritative V2 |
| Invoices in SQL | 1 | Imported invoice population |
| Rate card | 1 draft, no formal approval | D-03 publication still blocks authority |
| V2 completion outbox messages | 10 | Trace events written by completed V2 audits |

There are also three older rows marked `processing`; they remain eligible for
worker recovery. The audit worker is currently stopped.

### Why some counts may appear inconsistent

`kaudit_audit_run` contains legacy execution history. A completed audit-run row
alone is not the strict dashboard definition of an audited call. The Audit
Monitor requires the complete set:

- final recording artifact;
- completed media analysis;
- completed classification;
- completed transcript;
- canonical outcome code.

Use the Audit Monitor's strict count when presenting “AI-audited calls.”

---

## 21. What is implemented, gated, and missing

### Implemented and working

- protected page-based React application;
- local development login and logout;
- two-role permission model;
- monthly CSV/PDF import UI;
- deterministic CSV validation and period suggestion;
- AI-assisted editable invoice extraction;
- SQL normalization and file/task deduplication;
- KServe URL retrieval and SHA-256 verification;
- Whisper timestamp transcription;
- 12-category GPT classification;
- conversation-end and 60-second grace calculation;
- persistent skip-completed worker with retries;
- model/ruleset/evidence audit trail;
- audit-pending bill withholding;
- fixed-precision V2 billing core;
- weekly/monthly/quarterly/yearly dashboard projection;
- operations, idempotency, outbox/inbox, and access-audit foundations.

### Implemented but not activated as authoritative

- V2 final billing writer and decision trace depend on migration 0006;
- automated threshold gate depends on calibration;
- billing depends on a newly published immutable rate card;
- report authority depends on full cycle completion and D-12 approval.

### Not yet complete

- per-language/per-finding calibration results and thresholds;
- formal D-03 rate-card publication;
- full audit of the remaining recording-backed calls;
- explicit cycle-close accepted-as-billed fallback writer;
- authoritative regeneration of all call-level billing;
- complete invoice reconciliation and dispute workflow;
- persisted D-12 snapshots;
- PDF/Excel report generation and recipient delivery;
- production queue publisher/DLQ service deployment;
- production OIDC/SSO;
- retention, legal hold, redaction, backup/restore, observability, and production
  infrastructure approval.

---

## 22. Architecture decisions intentionally overridden

The original architecture required human review and independent
Kairali-controlled object storage. Leadership later changed those requirements.

Current intentional overrides:

- zero routine human review for findings and billing;
- no K2/K3-specific processing barrier;
- Kairali-only single-company application, not multi-tenant;
- vendor-hosted recording URLs instead of independent Kairali object storage;
- OpenAI Whisper/GPT data flow approved by leadership.

Controls that were **not** removed:

- calibration before financial authority;
- rate-card approval before final billing;
- evidence hashing;
- model/ruleset/version trace;
- retry and unresolved handling;
- access control and audit logging;
- bill withholding until every cycle call is explicitly resolved.

---

## 23. What not to overclaim in the presentation

Do not say:

- “All 43,245 calls are AI-audited.”
- “The INR 2,12,244.25 legacy total is the verified bill.”
- “Confidence of 90% means the model is 90% accurate.”
- “The recordings are stored independently by Kairali.”
- “Identified variance is money saved.”
- “Reports are already delivered automatically by email.”
- “The application is production deployed.”

Safe alternatives:

- “The complete population is in SQL; 16,371 calls currently have recording
  references and are eligible for independent audio audit.”
- “The new V2 audit is running in controlled batches; current results are
  uncalibrated monitoring output.”
- “The platform withholds the verified bill until calibration, approved rate
  card, cycle completion, and traced calculations are all present.”
- “Recording bytes remain vendor-hosted; Kaudit protects integrity through
  repeatable SHA-256 checks while the source remains available.”
- “Variance shown by the future authoritative report will mean identified
  difference, not recovered savings.”

---

## 24. Suggested presentation structure

### Slide 1 — The business problem

“KServe tells us which tasks ran, the minutes they are charging, and the monthly
invoice. We need an independent answer to whether those minutes represent
genuine customer interaction and whether the invoice follows the agreement.”

### Slide 2 — What Kaudit is

Use the one-paragraph description from section 1.

### Slide 3 — The three truth layers

Show vendor claim → independent evidence → contractual result.

### Slide 4 — End-to-end flow

```text
CSV + invoice
→ SQL ingestion
→ recording retrieval + hash
→ Whisper transcript
→ GPT category/customer end
→ 60-second grace
→ deterministic rate/rounding
→ cycle gate
→ reconciliation/report
```

### Slide 5 — Why duration is not one number

Show vendor connected, recording, speech, customer end, grace-adjusted, and
billable duration.

### Slide 6 — Grace-adjusted example

Use example B:

```text
200-second recording
last customer exchange at 40 seconds
+ 60-second wrap-up
= 100-second chargeable candidate
100-second unproductive tail excluded
```

### Slide 7 — Locked billing rule

Show the boundary table from section 9.

### Slide 8 — Automation with controls

Show:

- AI supplies category, speaker blocks, customer end, confidence;
- deterministic engine supplies grace, rounding, rate, amount;
- calibration and rate-card approval gate authority.

### Slide 9 — Evidence and traceability

Show model/version + ruleset/hash + confidence/threshold + evidence SHA-256 +
timestamp.

### Slide 10 — Dashboard pages

Home, Overview, Evidence, Findings, Billing, Reports, Operations, Imports, Audit
Monitor.

### Slide 11 — Current position

Use the current snapshot from section 20 and clearly label it “controlled build,
not authoritative billing.”

### Slide 12 — What must happen next

1. finish calibration;
2. publish approved rate card;
3. finish V2 audit population;
4. implement explicit fallback for calls without evidence;
5. recalculate and reconcile;
6. generate official PDF/Excel dispute package;
7. complete production identity/infrastructure controls.

---

## 25. Two-minute explanation

“Kairali pays KServe for AI lead-verification calls. KServe supplies a task-level
usage sheet and a monthly invoice, but its connected minutes do not necessarily
equal genuine customer conversation. A call can include ringing, voicemail,
silence, one-sided AI speech, network problems, or a long tail after the
customer has stopped engaging.

Kaudit is our independent auditor. We import KServe's sheet and invoice into
SQL, fetch every available recording, hash the bytes so we can detect changes,
transcribe it with timestamps, and use a versioned AI classifier to identify
the call outcome and the last meaningful customer response. A deterministic
rule then adds the approved 60-second Saanvi wrap-up grace, caps that at the
recording length, applies the agreed 30-second and whole-minute rounding rules,
and calculates the amount using fixed-precision INR arithmetic.

The AI never chooses the price. Every result records the model, version,
ruleset, confidence, evidence hash, and timestamp. Low-confidence or failed
calls remain visible and retry automatically. The system does not release a
verified bill until the full cycle is explicitly resolved, calibration is
complete, the rate card is formally published, and every amount has a trace.
Management and finance then receive the verified amount, KServe's claim, the
variance identified, and the trend over time.” 

---

## 26. Likely questions and concise answers

### “Why not just use KServe's connected duration?”

Because connected time can include silence, voicemail, one-way AI speech, or a
post-conversation tail. It is a vendor claim, not independent proof of genuine
interaction.

### “Why do we add 60 seconds after the customer stops?”

Leadership approved a 60-second allowance so a natural Saanvi goodbye or
wrap-up is not unfairly excluded. The allowance cannot exceed the actual
recording.

### “Does GPT calculate the bill?”

No. GPT identifies conversational facts and provides confidence. A
deterministic fixed-precision engine applies grace, rounding, rate, and amount.

### “What if GPT is uncertain?”

The call becomes unresolved and receives a bounded automated re-check. It does
not silently become accepted or disputed.

### “What happens when there is no recording?”

The call remains explicitly unaudited. At cycle close, the approved automated
fallback may accept KServe's minutes, labeled
`accepted_as_billed_unverified`.

### “Is a 90% confidence result 90% accurate?”

No. Confidence is the model's own certainty. Accuracy must be measured against
ground truth during calibration.

### “Can KServe replace a recording?”

Because storage remains vendor-controlled, deletion/replacement is possible.
Kaudit detects replacement when the new bytes produce a different SHA-256, but
cannot recover deleted bytes from the hash.

### “Why is the bill still Audit pending?”

Most calls are not yet resolved by V2, calibration is incomplete, and the
database rate card is still draft. The system correctly refuses to label the
legacy amount as authoritative.

### “What does positive variance mean?”

`vendor claim − verified amount` is positive, so the vendor claimed more than
the independent calculation. It is identified potential overbilling, not yet
recovered savings.

### “Why can verified amount sometimes exceed the invoice?”

The sign can legitimately be negative if Kairali's independent calculation is
higher. It can also expose a calculation/rate/source bug. This is why the
platform keeps both directions and requires reproducible traces instead of
assuming every audit must find an overcharge.

### “Is the platform finished?”

The monitoring, import, evidence, audit, and billing foundations are working.
It is not yet production-authoritative: calibration, formal rate-card
publication, complete V2 processing, cycle-close fallback, reconciliation,
official report generation, OIDC, and production infrastructure remain.
