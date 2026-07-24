-- ============================================================================
-- Migration 0001 — add source_url + last_verified_at to kaudit_evidence_object
-- ============================================================================
-- Purpose : support the W3 vendor-hosted-URL integrity approach (D-13). Stores the
--           KServe recording URL server-side (`source_url`) and the timestamp of the
--           last successful hash verification (`last_verified_at`).
-- Type    : ADDITIVE, non-destructive. Two nullable columns + one supporting index.
--           No existing column or row is modified.
-- Safety  : nullable columns added at end of table → INSTANT algorithm (no table
--           rebuild); index added INPLACE/LOCK=NONE (online). ~43k rows: negligible.
-- Privacy : `source_url` is a long-lived vendor URL. It is SERVER-ONLY and must NEVER
--           be sent to the browser, logs, or exports (see verifyEvidenceUrl.ts).
-- Scope   : SCHEMA ONLY. Populating `source_url` for the ~43k existing rows (from the
--           raw KServe export payloads) is a SEPARATE backfill, not part of this file.
-- Review  : run the PRE-FLIGHT block first; expect 0 rows. Then run UP. Then VERIFY.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT (read-only) — confirm the columns do NOT already exist (expect 0).
-- ---------------------------------------------------------------------------
-- SELECT COLUMN_NAME
--   FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE()
--    AND TABLE_NAME   = 'kaudit_evidence_object'
--    AND COLUMN_NAME IN ('source_url', 'last_verified_at');

-- ---------------------------------------------------------------------------
-- UP
-- ---------------------------------------------------------------------------
ALTER TABLE `kaudit_evidence_object`
  ADD COLUMN `source_url`       varchar(2048) DEFAULT NULL COMMENT 'Vendor-hosted (KServe) recording URL; server-only, never exported',
  ADD COLUMN `last_verified_at` datetime(6)   DEFAULT NULL COMMENT 'Timestamp of last successful hash verification (W3)',
  ALGORITHM=INSTANT;

ALTER TABLE `kaudit_evidence_object`
  ADD KEY `idx_evidence_last_verified` (`last_verified_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- ---------------------------------------------------------------------------
-- VERIFY (read-only) — expect the two columns + the index to be present.
-- ---------------------------------------------------------------------------
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE
--   FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE()
--    AND TABLE_NAME   = 'kaudit_evidence_object'
--    AND COLUMN_NAME IN ('source_url', 'last_verified_at');
-- SHOW INDEX FROM `kaudit_evidence_object` WHERE Key_name = 'idx_evidence_last_verified';

-- ---------------------------------------------------------------------------
-- DOWN (rollback) — additive, so rollback is a clean drop of only the new objects.
-- ---------------------------------------------------------------------------
-- ALTER TABLE `kaudit_evidence_object` DROP INDEX `idx_evidence_last_verified`;
-- ALTER TABLE `kaudit_evidence_object`
--   DROP COLUMN `source_url`,
--   DROP COLUMN `last_verified_at`;

-- ---------------------------------------------------------------------------
-- NOTES
--  * If the server rejects ALGORITHM=INSTANT (older engine), remove that clause and
--    it will pick a safe default; adding nullable end-columns is still fast.
--  * MySQL 8 does not support `ADD COLUMN IF NOT EXISTS`; rely on the PRE-FLIGHT check.
--    (MariaDB does support IF NOT EXISTS if you prefer a re-runnable variant.)
--  * Follow-up (separate): backfill `source_url` from raw KServe export payloads, then
--    run `npm run w3:verify` (dry-run) to establish `sha256` / `last_verified_at`.
-- ============================================================================
