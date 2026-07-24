# W3 — Evidence Integrity (vendor-hosted / KServe-URL reference)

Supersedes the original W3 "migrate bytes to durable storage" design.

## ⚠️ Conscious trade-off (D-13) — read this first

**Decision (cost-driven, made knowingly by leadership, 2026-07-24):** recordings are
referenced by their **KServe URL**. Bytes are **not** copied into independent,
Kairali-controlled object storage.

This is a deliberate override of the architecture's intent. It means:

- The evidence used to audit KServe now lives on **KServe's own infrastructure** — the
  exact situation ADR-018 and the launch-gate non-negotiable warn against ("a supplier
  cannot be the sole custodian of the evidence used to verify its own invoice").
- The sha256 integrity gate is **our only safeguard**, and it can only detect alteration
  **while the URL still resolves**. If KServe expires or deletes a recording, we keep a
  hash but **cannot reproduce the bytes** — which is weak evidence against a counterparty
  in a dispute.
- It also stores a long-lived vendor URL in the DB (server-side only), contrary to the
  "no long-lived recording URLs in the DB" rule. `source_url` must never reach the
  browser, logs, or exports.

**Net:** dispute-evidence strength and the audit's independence are materially reduced for
these recordings. Recorded as **D-13** in the architecture package's `DECISIONS_NEEDED.md`.
Recommended mitigation: a contractual KServe obligation to preserve recordings through the
dispute window, plus monitoring of `source_missing` / `evidence_altered` rates.

## What W3 now does

Integrity by **fetch-and-hash**, not by moving bytes:

1. **Ingestion baseline** — on the first successful fetch of a recording URL, hash the
   bytes and store `sha256` + `last_verified_at`. → `hash_recorded`
2. **Re-verification pass** — refetch the URL and compare:
   - matches baseline → `verified` (update `last_verified_at`)
   - differs → **`evidence_altered`** finding (quarantine + audit log) — never a silent pass
3. **Missing evidence** — URL 404 / expired / unreachable → **`source_missing`** finding.
4. **URL safety** — every fetch is preceded by an allowlist + SSRF guard
   (`isSafeVendorUrl`): HTTPS only, host on the approved allowlist, no loopback/private/
   link-local; the fetch adapter also uses `redirect: 'error'`. A failure → `unsafe_url`.
5. Rows with no URL → `no_url` finding.

Outcomes: `hash_recorded | verified | evidence_altered | source_missing | unsafe_url | no_url`.

## Design

Pure, injectable core (`src/storage/verifyEvidenceUrl.ts`) with two ports:

- `UrlFetcher` — fetches vendor bytes. Production adapter: `proxyResolvingFetcher.ts`.
- `EvidenceRepo` — reads rows, records hash/verified/findings (`mysqlEvidenceRepo.ts`).

Plus `isSafeVendorUrl` (`src/security/urlSafety.ts`) as a pure pre-fetch guard.

## Fetch path — unpod.ai proxy (verified behavior)

`source_url` stores the **stable S3 object URL** (e.g.
`https://cdr-storage-recs.s3.ap-south-1.amazonaws.com/.../call_x.ogg`) — never a signed/
expiring URL. Each verification re-calls the proxy fresh.

Observed 2026-07-24 against a live sample: `GET {KAUDIT_UNPOD_PROXY_BASE}?url={s3ObjectUrl}`
returns **200, `content-type: audio/ogg`, ~33 KB, `redirects=0`** — the audio bytes
directly (no JSON, no signed-URL to follow, no second request). The `proxyResolvingFetcher`
matches this: one GET, `redirect:'error'`, rejects a 200 whose content-type is not `audio/*`
(error page ≠ evidence), plus empty/oversize guards.

SSRF posture: the row-controlled value (`source_url`'s S3 host) is constrained by
`isSafeVendorUrl` against `KAUDIT_ALLOWED_RECORDING_HOSTS`; the egress host (the proxy) is
fixed config; `redirect:'error'` blocks redirect bounces.

> ⚠️ The proxy is **unauthenticated** — anyone with the S3 path can download a private
> recording. That is a data-exposure finding to raise with KServe/unpod separately; it does
> not change W3's integrity logic.

## Schema note (additive migration 0002)

`source_url`, `sha256` (nullable), and `last_verified_at` live on **`kaudit_call_artifact`**
(the recording is a call_artifact — 1:1 per call, present for all 43,245). Migration 0002
supersedes 0001, which targeted `kaudit_evidence_object` — the wrong table, because ~43,017
recordings have no evidence_object row and its `sha256` is NOT NULL (incompatible with the
"hash recorded on first verify" baseline). `source_url` is server-only — never exported.

## Verification (synthetic, runs now)

```
npm run test:w3
```

Covers: ingestion hash recording; re-verify match; **hash-mismatch → evidence_altered**;
**404/expired → source_missing**; unsafe/private URL rejected before fetch; no-URL; dry-run
writes nothing; batch counting; plus the URL-safety guard matrix. No DB, no network.

## Before a real verification pass (checklist)

- [ ] `.env` set from `.env.example`; `KAUDIT_ALLOWED_RECORDING_HOSTS` = the real KServe hosts.
- [ ] Add `source_url` + `last_verified_at` columns (additive migration).
- [ ] `KAUDIT_VERIFY_MODE=dry-run` first; review reachability + would-be findings.
- [ ] Run EXECUTE in bounded batches; review `evidence_altered` / `source_missing` findings.
- [ ] Track the `source_missing` rate — a rising rate means KServe is expiring evidence we
      can no longer independently substantiate.
