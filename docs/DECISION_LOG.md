# Decision log

## 2026-09-03 — explicit exhausted and no-recording fallbacks

Recording-backed calls retain normal AI retries. Only an exhausted recording
may receive the deterministic `accepted_as_billed_unverified` cycle-close
resolution using KServe's supplied time and amount. A call with no recording
receives `no_recording_zero`, zero audited time and amount, and the remark
`No Recording Found`. Neither resolution is represented as model output.

## 2026-07-29 — replace manual calibration with automated consensus

The owner explicitly approved zero manual labeling. Human-labeled
ground-truth calibration is therefore not a runtime prerequisite.

The replacement must not be described as measured accuracy or ground-truth
calibration. Each recording-backed call requires:

1. the primary classification;
2. an independent second classification pass;
3. an automated third adjudication pass when the first two disagree;
4. agreement by at least two passes on category, customer-speech state, and
   rounded billable duration; and
5. model confidence of at least 0.80 for the winning consensus.

Every pass, evidence hash, ruleset hash, selected outcome, and confidence is
stored in the automated-decision trace. Consensus-finalized findings are
marked confirmed/rejected by the system and produce an audit-log entry. If
consensus remains unresolved after automatic retries at cycle close, the
existing `accepted_as_billed_unverified` fallback applies rather than forcing
an AI-derived amount.

## 2026-07-27 — retire the K2/K3 automation gate

Leadership confirmed that the platform is an internal Kairali system and asked
for one automation path for all imported calls. K2/K3 is no longer an
activation, billing, or reporting barrier, and a named clinical owner is not a
runtime prerequisite.

This decision does not weaken authentication, role checks, evidence hashing,
access audit logging, automated validation, retry handling, or rate-card approval.
Existing sensitivity columns remain in MySQL for backward compatibility but
are not used to decide whether a call can be processed.

## 2026-07-27 — verified bill waits for cycle audit completion

The platform must display `Audit pending` and must not release Kairali's
verified bill until every call has an explicit resolution. Calls without
recordings become resolved only through the approved, recorded cycle-close
`no_recording_zero` fallback.
