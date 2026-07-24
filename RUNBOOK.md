# RUNBOOK — W3 evidence integrity (migration → backfill → verify)

Operational sequence to populate `source_url` and run KServe-recording integrity
verification against the real database. Every step is **dry-run first**; nothing writes
until you set the explicit `EXECUTE` switch.

> Evidence is vendor-hosted (D-13): `source_url` stores the **canonical S3 object URL**;
> the unpod.ai proxy is re-called fresh at verify time. The sha256 gate only detects
> tampering while KServe still hosts the bytes — see `docs/W3_STORAGE_MIGRATION.md`.

---

## 0. Prerequisites

- **Node ≥ 24** and `npm install` in this repo.
- **`.env`** (gitignored — **never** put real values in `.env.example`), copied from
  `.env.example`, with real `DB_*`, `KAUDIT_SOURCE_RAW_ROOT`, and the allowlist/proxy set.
  The npm scripts auto-load `.env` (`--env-file-if-exists`); no manual `--env-file` needed.
- **Rotate the DB password** that was exposed earlier before using it here.
- Run against a **low-traffic window**; keep batches small at first.

## Safety model

| Command | Default | Writes only when |
|---|---|---|
| `npm run w3:backfill` | dry-run (resolve + report) | `KAUDIT_BACKFILL_MODE=EXECUTE` |
| `npm run w3:verify` | dry-run (fetch + report) | `KAUDIT_VERIFY_MODE=EXECUTE` |

Findings (`raw_missing`, `unrecognized_url`, `evidence_altered`, `source_missing`, …) are
written to `kaudit_audit_log` and quarantine the row — never silently skipped.

---

## Step 1 — Apply migration 0001 (adds `source_url`, `last_verified_at`)

File: `migrations/0001_evidence_add_source_url_and_last_verified_at.sql` (additive; INSTANT
column add + online index; reversible).

1. **Pre-flight** (read-only): run the PRE-FLIGHT `SELECT` in the file — expect **0 rows**.
2. **UP**: run the two `ALTER TABLE` statements.
3. **VERIFY**: run the VERIFY block — expect the two columns + `idx_evidence_last_verified`.

Run it with your MySQL client / a DBA — not from this app.

## Step 2 — Backfill `source_url` (dry-run → execute)

Populates `source_url` from the raw KServe export payloads (extracts `recordingUrl`,
normalizes plain/signed/proxy-wrapped → canonical S3 object URL).

```bash
# DRY-RUN — confirms KAUDIT_SOURCE_RAW_ROOT resolves the raw exports and shows what WOULD
# be populated + the finding breakdown. Writes nothing.
KAUDIT_BACKFILL_MODE=dry-run npm run w3:backfill
```

Review the summary:
- `backfilled` (would populate), `already_present` (skip)
- `raw_missing` → the `KAUDIT_SOURCE_RAW_ROOT` path/key convention needs adjusting
- `call_not_in_export` / `no_recording_url` / `unrecognized_url` → real data findings

When the dry-run looks right:

```bash
# EXECUTE — writes source_url; logs findings. Start with a small KAUDIT_BACKFILL_BATCH.
KAUDIT_BACKFILL_MODE=EXECUTE npm run w3:backfill
```

Re-run in batches until `backfilled` reaches 0 (all resolved or flagged).

## Step 3 — Verify integrity (dry-run → execute)

Fetches each recording fresh through the unpod.ai proxy and hashes it.

```bash
# DRY-RUN — fetches + reports resolved / source_missing / evidence_altered. Writes nothing.
KAUDIT_VERIFY_MODE=dry-run npm run w3:verify
```

Summary keys: `hashRecorded` (baseline set on first fetch), `verified`, `evidenceAltered`,
`sourceMissing`, `unsafeUrl`, `noUrl`.

When ready to persist baselines + findings:

```bash
# EXECUTE — records sha256 baselines + last_verified_at; quarantines + logs findings.
KAUDIT_VERIFY_MODE=EXECUTE npm run w3:verify
```

Ongoing: re-run `w3:verify` on a schedule. A **rising `sourceMissing` rate** means KServe
is expiring recordings you can no longer independently substantiate (the D-13 risk) —
escalate. `evidenceAltered` means a recording changed after its baseline — investigate.

---

## Rollback / stop conditions

- Migration rollback: the `DOWN` block in the migration file (drops the two columns + index).
- Backfill/verify never mutate raw evidence; they only set `source_url` / `sha256` /
  `last_verified_at` and write findings. Stop by omitting the `EXECUTE` switch.
- Stop and escalate on: unexpected `evidence_altered` spikes, `unrecognized_url` for calls
  that should have valid recordings, or `source_missing` above baseline.

## Done looks like

- Every recording row has a canonical `source_url`, or a logged finding explaining why not.
- A verify pass records baseline hashes; a later pass returns `verified` for unchanged
  recordings and findings for anything altered/missing.
