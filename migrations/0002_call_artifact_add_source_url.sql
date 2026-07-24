-- ============================================================================
-- Migration 0002 — source_url + sha256 + last_verified_at on kaudit_call_artifact
-- ============================================================================
-- Purpose : the URL-reference integrity model (D-13) belongs on the RECORDING, which
--           is a `kaudit_call_artifact` row (1:1 per call, exists for all 43,245 calls) —
--           NOT `kaudit_evidence_object`. ~43,017 recordings have no evidence_object row,
--           and evidence_object.sha256 is NOT NULL (incompatible with the "hash recorded
--           on first verify" baseline logic). This migration supersedes 0001.
-- Type    : ADDITIVE, non-destructive. Three nullable columns + one index. INSTANT.
-- Privacy : `source_url` is a vendor URL — SERVER-ONLY; never exported to browser/logs.
-- Note    : `sha256` is NULLABLE here (unlike evidence_object) so verify can key its
--           baseline on sha256 IS NULL.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- PRE-FLIGHT (read-only) — expect 0 rows.
-- ---------------------------------------------------------------------------
-- SELECT COLUMN_NAME FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kaudit_call_artifact'
--    AND COLUMN_NAME IN ('source_url','sha256','last_verified_at');

-- ---------------------------------------------------------------------------
-- UP
-- ---------------------------------------------------------------------------
ALTER TABLE `kaudit_call_artifact`
  ADD COLUMN `source_url`       varchar(2048) DEFAULT NULL COMMENT 'Canonical S3 object URL of the recording; server-only, never exported',
  ADD COLUMN `sha256`           char(64)      DEFAULT NULL COMMENT 'Integrity baseline; NULL until the first successful verify fetch',
  ADD COLUMN `last_verified_at` datetime(6)   DEFAULT NULL COMMENT 'Last successful hash verification (W3)',
  ALGORITHM=INSTANT;

ALTER TABLE `kaudit_call_artifact`
  ADD KEY `idx_call_artifact_verify` (`last_verified_at`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- ---------------------------------------------------------------------------
-- VERIFY (read-only)
-- ---------------------------------------------------------------------------
-- SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE FROM information_schema.COLUMNS
--  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'kaudit_call_artifact'
--    AND COLUMN_NAME IN ('source_url','sha256','last_verified_at');

-- ---------------------------------------------------------------------------
-- DOWN (rollback)
-- ---------------------------------------------------------------------------
-- ALTER TABLE `kaudit_call_artifact` DROP INDEX `idx_call_artifact_verify`;
-- ALTER TABLE `kaudit_call_artifact`
--   DROP COLUMN `source_url`, DROP COLUMN `sha256`, DROP COLUMN `last_verified_at`;

-- ---------------------------------------------------------------------------
-- OPTIONAL CLEANUP of superseded migration 0001 (run only after confirming the
-- evidence_object columns are empty — the backfill never wrote them):
--   -- SELECT COUNT(*) FROM kaudit_evidence_object WHERE source_url IS NOT NULL; -- expect 0
--   -- ALTER TABLE kaudit_evidence_object DROP INDEX idx_evidence_last_verified;
--   -- ALTER TABLE kaudit_evidence_object DROP COLUMN source_url, DROP COLUMN last_verified_at;
-- ============================================================================
