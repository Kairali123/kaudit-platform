## Outcome

Describe one demonstrable outcome and the architecture/acceptance items it addresses.

## Risk and control review

- [ ] No real recording, transcript, PII/health content, invoice, credential,
      signed URL, or production payload is committed.
- [ ] Authorization, sensitivity, idempotency/replay, audit logging, and failure
      behavior were considered.
- [ ] Financial behavior remains deterministic; no model output directly sets money.
- [ ] Database changes are additive/expand-first and include a forward-fix plan.
- [ ] Security/privacy/finance/safety owners required for this change are named.

## Verification

List exact commands and results. State every skipped or unavailable check.

## Release

State migration order, configuration, monitoring, rollback/forward-fix, and whether any
production or external effect is requested. A pull request does not itself authorize one.
