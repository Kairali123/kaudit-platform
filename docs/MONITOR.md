# Read-only monitoring dashboard

A zero-dependency status view of **evidence integrity + ingestion** across the platform.
Aggregate counts only — **no customer, phone, transcript, health content, and no billing /
financial / findings-quality figures** (those are non-authoritative pending D-03 +
calibration, so they are deliberately excluded).

## Preview the look now (no DB)

```bash
npm run ui:sample      # writes monitor-sample.html with representative numbers
open monitor-sample.html
```

## Live (real data)

Reads from `.env` (same DB as the CLIs). Only runs `SELECT COUNT(...)` — never writes.

```bash
npm run ui:monitor     # → http://localhost:4173  (refresh to update)
```

## What it shows

- Calls ingested; evidence objects; ingestion batches.
- **Recordings referenced** (`source_url` backfilled) with coverage %.
- **Integrity baselines recorded** (`sha256`) and **verified reachable** (`last_verified_at`)
  — i.e. W3 progress.
- **Users provisioned** (W1).
- **Integrity findings** — anomaly counts from the audit log (`evidence_*` / `backfill_*`);
  green when none, amber when present, with a breakdown table.

Metrics whose columns/tables aren't migrated yet show **pending** rather than a fake number.

## Design notes

Stat tiles, not charts (per the dataviz form heuristic). Status uses reserved colours
**with a text label + dot**, never colour alone; theme-aware (light/dark); self-contained
HTML (no external requests, no scripts); finding names are HTML-escaped.
