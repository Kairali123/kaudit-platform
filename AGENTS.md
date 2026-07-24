# AGENTS.md — kaudit-platform

This project inherits the durable engineering rules in the architecture package
`../voice-agent-call-audit-architecture/AGENTS.md`. Read it before planning or editing.

Project-specific rules:

- **Decoupled from KCRM.** Do not import CRM app code. The only shared resource is the
  MySQL database (`kaudit_*` tables).
- **Synthetic fixtures only** for tests and development. Never commit real recordings,
  transcripts, PII, health data, invoices, secrets, or `.env` files.
- **Short-lived feature branches**; reviewable changes; do not run data-mutating migrations
  against production evidence except as an approved, supervised operation.
- **Invariants carry over:** raw evidence is immutable, money uses fixed-precision decimals,
  an LLM never decides money, and every automated decision is logged with model/version/
  ruleset/confidence/evidence-hash.
