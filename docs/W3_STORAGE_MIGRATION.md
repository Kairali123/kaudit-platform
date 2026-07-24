# W3 — Evidence Storage Migration

Implements workstream **W3** in
`../voice-agent-call-audit-architecture/PHASE1_REMEDIATION_PLAN.md`: move evidence off
local-disk / local MinIO onto durable, versioned, Object-Lock (WORM), KMS-encrypted object
storage — **verify-then-migrate**, never overwriting raw bytes or trusting a copy blindly.

## Current state (from the reference KCRM repo)

- `kaudit_evidence_object.object_bucket` is a mix of `local-disk` (legacy, some with no
  recoverable bytes) and `kaudit-local` (local MinIO at `.data/kaudit-minio`).
- The existing `objectStore.ts` is already S3-shaped (region `ap-south-1`, KMS/SSE,
  `ChecksumSHA256`, captures `versionId`) — so this is a re-target + copy-verify, not a
  rewrite.

## Design

Pure, injectable core (`src/storage/migrateEvidenceStorage.ts`) with three ports:

- `SourceReader` — reads bytes from the current store (`localSourceReader.ts`).
- `DurableTarget` — versioned + Object-Lock + KMS bucket (`s3DurableTarget.ts`).
- `EvidenceRepo` — reads candidates, updates location, records issues (`mysqlEvidenceRepo.ts`).

### Per-object algorithm

1. Already on the durable bucket → **skip** (idempotent).
2. Read source bytes; missing → **`source_missing`** finding (not fatal).
3. **Integrity gate:** `sha256(bytes)` must equal the row's recorded `sha256`; mismatch →
   **`hash_mismatch`**, quarantined, **not** written to durable storage.
4. Match → put to durable (Object-Lock retention + SSE), capture `versionId`, update the row.
5. Resume-safe: if the object is already on the target (interrupted prior run), reuse its
   version instead of re-uploading.

Outcomes: `migrated | skipped_already_durable | would_migrate | source_missing | hash_mismatch`.

## Safety & gating

- **Infra precondition:** the durable bucket must be created with **Versioning + Object
  Lock** enabled first (the adapter sets per-object retention, not bucket-level lock).
- The CLI (`npm run w3:migrate`) defaults to **dry-run**; it writes only when
  `KAUDIT_MIGRATION_MODE=EXECUTE`.
- Even in EXECUTE mode this operates on **production** evidence + DB and must be run only as
  an approved, supervised operation — batch by batch, with the exception list reviewed.
- `hash_mismatch` / `source_missing` are **findings written to the audit log**, resolved by
  a human — the migration never fixes them silently.

## Verification (synthetic, runs now)

```
npm run test:w3
```

Covers: successful migrate + row update; hash-mismatch quarantine (no durable write);
missing source; idempotent already-durable skip; no duplicate upload on re-run; dry-run
writes nothing; batch outcome counting. No DB, no cloud, no real data.

## Before the real run (checklist)

- [ ] Durable bucket provisioned (India region, Versioning + Object Lock + KMS).
- [ ] `.env` set from `.env.example`; `KAUDIT_MIGRATION_MODE=dry-run` first.
- [ ] Dry-run a batch; confirm the `local-disk` key→path mapping resolves (or is reported
      `source_missing` honestly).
- [ ] Review `hash_mismatch` / `source_missing` findings with the owner.
- [ ] Run EXECUTE in bounded batches; keep local source as read fallback until 100% verified.
- [ ] Decommission local-disk / MinIO only after full verification.
