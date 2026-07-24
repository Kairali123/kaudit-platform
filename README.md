# kaudit-platform

Decoupled application for the **Kairali Voice Agent Call Audit & Billing Platform**.

Separate from the KCRM Next.js app (per the architecture's "audit system is its own
system" principle). Connects to the **same MySQL** (`kaudit_*` tables) — a data-location
decision made by the director — but the audit logic lives here, not inside the CRM app.

Architecture package: `../voice-agent-call-audit-architecture`.

## Status

Greenfield. First workstream: **W3 — evidence integrity**.

> **⚠️ Trade-off in effect (D-13, cost-driven, made knowingly):** recordings are
> referenced by their **KServe URL** and are **not** copied into independent Kairali
> storage. Evidence is vendor-hosted. The sha256 gate is the only safeguard and works
> only while the URL resolves; if KServe expires/deletes a recording we keep a hash but
> cannot reproduce the bytes. This weakens dispute-evidence strength and the audit's
> independence for these recordings. See `docs/W3_STORAGE_MIGRATION.md`.

## Requirements

- **Node >= 24** — native TypeScript type-stripping; tests run with `node --test`, no build.

## Test (synthetic fixtures — no DB, no network, no real data)

```
npm run test:w3
```

Covers URL reachability/safety, hash-on-ingestion, hash-mismatch (evidence_altered)
detection, and missing-URL (source_missing) handling.

## Verification pass (gated)

`npm run w3:verify` defaults to **dry-run** (fetch + report, write nothing). It writes
hashes/verifications/findings only when `KAUDIT_VERIFY_MODE=EXECUTE`, touches the
production DB in that mode, and must be run as an approved, supervised pass.

## Local dashboards

Full aggregate preview without a database:

```bash
npm run ui:dashboard:sample
open dashboard-sample.html
```

Full live aggregate dashboard using the gitignored `.env`:

```bash
npm run ui:dashboard
```

Then open `http://127.0.0.1:4174`. The full dashboard is local-only and visibly
marks access control as unenforced, billing as provisional (D-03), and findings as
uncalibrated. It renders aggregate data only—never call audio, transcripts, phone
numbers, customer identifiers, or health content. See `docs/FULL_DASHBOARD.md`.
