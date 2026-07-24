# kaudit-platform

Decoupled application for the **Kairali Voice Agent Call Audit & Billing Platform**.

Separate from the KCRM Next.js app (per the architecture's "audit system is its own
system" principle). Connects to the **same MySQL** (`kaudit_*` tables) — a data-location
decision made by the director — but the audit ingestion, storage, tenancy, and automation
logic live here, not inside the CRM app.

Architecture package: `../voice-agent-call-audit-architecture` (see its
`PHASE1_REMEDIATION_PLAN.md`, `AGENTS.md`, and numbered docs).

## Status

Greenfield. First workstream: **W3 — evidence storage migration** (off local-disk / local
MinIO onto durable, versioned, Object-Lock, KMS-encrypted object storage). See
`docs/W3_STORAGE_MIGRATION.md`.

## Requirements

- **Node >= 24** — native TypeScript type-stripping; tests run with `node --test`, no build.

## Test (synthetic fixtures — no DB, no cloud, no real data)

```
npm run test:w3
```

Runs the storage-migration core against in-memory fixtures. No network, no real evidence.

## Running the real migration (gated)

`npm run w3:migrate` defaults to **dry-run**. It refuses to write unless
`KAUDIT_MIGRATION_MODE=EXECUTE`, and even then must only be run as an approved, supervised
W3 operation against provisioned durable storage — never casually. Build and verify on
synthetic fixtures first.
