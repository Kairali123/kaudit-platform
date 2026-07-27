# Decision log

## 2026-07-27 — retire the K2/K3 automation gate

Leadership confirmed that the platform is an internal Kairali system and asked
for one automation path for all imported calls. K2/K3 is no longer an
activation, billing, or reporting barrier, and a named clinical owner is not a
runtime prerequisite.

This decision does not weaken authentication, role checks, evidence hashing,
access audit logging, calibration, retry handling, or rate-card approval.
Existing sensitivity columns remain in MySQL for backward compatibility but
are not used to decide whether a call can be processed.

## 2026-07-27 — verified bill waits for cycle audit completion

The platform must display `Audit pending` and must not release Kairali's
verified bill until every call has an explicit resolution. Calls without
recordings become resolved only through the approved, recorded cycle-close
`accepted_as_billed_unverified` fallback.
