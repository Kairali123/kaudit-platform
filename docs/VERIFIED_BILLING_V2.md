# Independently verified KServe billing — V2

Status: calculation core implemented with synthetic fixtures; production persistence and
rate-card publication are not active.

## Locked rule

The verifier supplies a timestamp for the final meaningful customer exchange. The
deterministic billing engine—not the model—then applies:

```text
adjusted_chargeable_ms =
  min(recorded_duration_ms, last_customer_exchange_ms + 60000)

billable_minutes =
  0                         when adjusted_chargeable_ms = 0
  0.5                       when 0 < adjusted_chargeable_ms < 30000
  ceil(adjusted_chargeable_ms / 60000) otherwise

verified_amount = billable_minutes × INR 9.50
```

The under-30-second result is a flat INR 4.75 charge. Exactly 30 seconds is one
minute/INR 9.50. Every new minute entered rounds up. Per-call tax is zero; IGST and
invoice adjustments remain invoice-level reconciliation concerns.

The one-way tail is `recorded_duration_ms - adjusted_chargeable_ms`. It alerts only
when strictly greater than 60 seconds.

## Authority gates

A calculation can become `final` only when all of these are true:

1. the selected database rate card is `published`, has approval identity/time, and its
   ruleset hash exactly matches the code ruleset;
2. the audit input has hashed evidence and a completed audit run identity;
3. calibration is complete and a language/finding-specific threshold exists;
4. model confidence meets that threshold; and
5. K2/K3 automation additionally has its named clinical/safety owner and explicit
   activation.

Below-threshold calls become `unresolved` and request a secondary automated pass. When
the configured automated attempts are exhausted, they remain unresolved until cycle
close. The separately approved close policy may then accept KServe's claimed minutes,
but that fallback must be labeled `accepted_as_billed_unverified`; it must never be
stored as an independently verified result.

## Trace and legacy isolation

Every decision trace contains:

- model provider/name/version;
- classifier and deterministic ruleset versions/hashes;
- confidence and applied threshold;
- opaque evidence references and hashes;
- input-manifest hash;
- conversation, grace, rounding, tail, rate, and amount intermediates; and
- decision time, status, reason, and next action.

Migration `0006_verified_billing_trace.sql` is additive. Existing 43,245 calculations
remain unchanged with a null calculation basis. New authoritative rows use
`calculation_basis = independent_conversation_end` and supersede—not overwrite—the
current calculation for that call.

## Intentional architecture overrides

Leadership has overridden the original mandatory human-review flow for automated
K0/K1 findings and billing. K2/K3 code may be built, but activation remains gated until
the named clinical/safety owner signs off. This document does not authorize payment,
vendor communication, production deployment, or mutation of existing financial rows.
