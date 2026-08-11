-- ============================================================================
-- Migration 0007 — append-only AI usage telemetry
-- ============================================================================
-- EXPAND ONLY. This migration does not alter or backfill any existing audit.
--
-- Historical warning:
--   OpenAI usage was not persisted before this migration. Existing audits must
--   remain "usage not recorded"; never estimate or fabricate historical tokens.
--
-- Semantics:
--   * GPT classifier passes record input/output/total tokens.
--   * Whisper-1 records billed audio seconds (its API reports duration usage,
--     not text tokens).
--   * one audit run + operation + pass is unique, making worker retries safe.
-- ============================================================================

CREATE TABLE `kaudit_ai_usage_event` (
  `id` varchar(40) NOT NULL,
  `audit_run_id` varchar(40) NOT NULL,
  `call_id` varchar(40) NOT NULL,
  `operation` varchar(40) NOT NULL
    COMMENT 'transcription or classification',
  `pass_name` varchar(40) NOT NULL
    COMMENT 'primary_asr, primary_classifier, consensus_secondary, consensus_adjudicator',
  `provider_name` varchar(80) NOT NULL,
  `model_name` varchar(100) NOT NULL,
  `model_version` varchar(100) NOT NULL,
  `input_tokens` bigint DEFAULT NULL,
  `output_tokens` bigint DEFAULT NULL,
  `total_tokens` bigint DEFAULT NULL,
  `audio_seconds` decimal(14,3) DEFAULT NULL,
  `request_id` varchar(120) DEFAULT NULL,
  `recorded_at` datetime(6) NOT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_ai_usage_audit_pass`
    (`audit_run_id`, `operation`, `pass_name`),
  KEY `idx_ai_usage_call_time` (`call_id`, `recorded_at`),
  KEY `idx_ai_usage_model_time`
    (`provider_name`, `model_name`, `recorded_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Existing installations can use a different utf8mb4 collation. Inherit the
-- parent key collation before adding foreign keys.
SET @kaudit_parent_collation = (
  SELECT `COLLATION_NAME`
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'kaudit_call'
    AND COLUMN_NAME = 'id'
);
SET @kaudit_convert_ai_usage_sql = CONCAT(
  'ALTER TABLE `kaudit_ai_usage_event` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ',
  @kaudit_parent_collation
);
PREPARE kaudit_convert_ai_usage
  FROM @kaudit_convert_ai_usage_sql;
EXECUTE kaudit_convert_ai_usage;
DEALLOCATE PREPARE kaudit_convert_ai_usage;

ALTER TABLE `kaudit_ai_usage_event`
  ADD CONSTRAINT `fk_ai_usage_audit_run`
    FOREIGN KEY (`audit_run_id`) REFERENCES `kaudit_audit_run` (`id`),
  ADD CONSTRAINT `fk_ai_usage_call`
    FOREIGN KEY (`call_id`) REFERENCES `kaudit_call` (`id`);

-- VERIFY (read-only):
--   SHOW CREATE TABLE kaudit_ai_usage_event;
--
-- Forward-fix policy:
--   Once usage rows exist, do not delete or rewrite them. Corrections are new
--   audit runs and therefore new usage events.
-- ============================================================================
