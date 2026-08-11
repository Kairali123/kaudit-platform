-- ============================================================================
-- Migration 0006 — independently verified billing trace + automated decisions
-- ============================================================================
-- EXPAND ONLY. This migration does not update, finalize, supersede, or delete any
-- existing calculation. The 43,245 legacy rows remain intact and distinguishable
-- because their new calculation_basis / trace fields remain NULL.
--
-- Purpose:
--   1. make independently verified billing reproducible from the conversation-end
--      fact, approved ruleset, model/classifier identity, confidence, and evidence;
--   2. make new calculations append-only and idempotent by input manifest; and
--   3. provide one per-call automated-decision trail for billing and later findings.
--
-- Safety:
--   * schema only; do not combine this migration with rate-card publication;
--   * run on a disposable database first;
--   * do not apply to production until Data + Finance CODEOWNERS approve it.
-- ============================================================================

ALTER TABLE `kaudit_billing_calculation`
  ADD COLUMN `calculation_basis` varchar(60) DEFAULT NULL
    COMMENT 'independent_conversation_end, accepted_as_billed_unverified, or legacy NULL'
    AFTER `status`,
  ADD COLUMN `conversation_end_ms` bigint DEFAULT NULL
    COMMENT 'Final meaningful customer exchange timestamp from recording start'
    AFTER `speech_duration_ms`,
  ADD COLUMN `wrap_up_grace_ms` bigint DEFAULT NULL
    COMMENT 'Approved AI goodbye/wrap-up grace applied after conversation_end_ms'
    AFTER `conversation_end_ms`,
  ADD COLUMN `adjusted_chargeable_duration_ms` bigint DEFAULT NULL
    COMMENT 'Pre-rounding verified duration after grace and recording-duration cap'
    AFTER `wrap_up_grace_ms`,
  ADD COLUMN `one_way_tail_ms` bigint DEFAULT NULL
    COMMENT 'Recording duration minus adjusted chargeable duration'
    AFTER `billable_duration_ms`,
  ADD COLUMN `one_way_tail_alert` tinyint(1) DEFAULT NULL
    COMMENT '1 only when one-way tail is strictly greater than the published threshold'
    AFTER `one_way_tail_ms`,
  ADD COLUMN `ruleset_sha256` char(64) DEFAULT NULL
    COMMENT 'Hash of the immutable deterministic billing ruleset'
    AFTER `currency`,
  ADD COLUMN `decision_trace_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    DEFAULT NULL
    COMMENT 'Canonical privacy-safe calculation trace; no transcript, URL, or phone data'
    CHECK (json_valid(`decision_trace_json`))
    AFTER `trace_object_id`,
  ADD COLUMN `decision_trace_sha256` char(64) DEFAULT NULL
    COMMENT 'SHA-256 of canonical decision_trace_json'
    AFTER `decision_trace_json`,
  ADD COLUMN `finalized_at` datetime(6) DEFAULT NULL
    COMMENT 'Set only for an authoritative final calculation'
    AFTER `calculated_at`,
  ADD UNIQUE KEY `uq_billing_calc_manifest`
    (`call_id`, `rate_card_version_id`, `engine_version`, `input_manifest_sha256`),
  ADD KEY `idx_billing_calc_authority`
    (`calculation_basis`, `status`, `finalized_at`);

CREATE TABLE `kaudit_automated_decision` (
  `id` varchar(40) NOT NULL,
  `call_id` varchar(40) NOT NULL,
  `audit_run_id` varchar(40) DEFAULT NULL,
  `billing_calculation_id` varchar(40) DEFAULT NULL,
  `decision_type` varchar(60) NOT NULL,
  `decision_status` varchar(30) NOT NULL,
  `reason_code` varchar(80) NOT NULL,
  `next_action` varchar(80) DEFAULT NULL,
  `sensitivity_tier` char(2) NOT NULL,
  `language_code` varchar(30) NOT NULL,
  `finding_type` varchar(80) NOT NULL,
  `decision_engine_name` varchar(100) NOT NULL,
  `decision_engine_version` varchar(60) NOT NULL,
  `model_provider` varchar(80) NOT NULL,
  `model_name` varchar(100) NOT NULL,
  `model_version` varchar(80) NOT NULL,
  `ruleset_version` varchar(80) NOT NULL,
  `ruleset_sha256` char(64) NOT NULL,
  `classifier_ruleset_version` varchar(80) NOT NULL,
  `classifier_ruleset_sha256` char(64) NOT NULL,
  `calibration_version` varchar(80) DEFAULT NULL,
  `confidence` decimal(9,8) NOT NULL,
  `confidence_threshold` decimal(9,8) DEFAULT NULL,
  `evidence_manifest_sha256` char(64) NOT NULL,
  `evidence_refs_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    NOT NULL
    COMMENT 'Opaque reference IDs and hashes only; no URLs, transcript text, or PII'
    CHECK (json_valid(`evidence_refs_json`)),
  `input_manifest_sha256` char(64) NOT NULL,
  `decision_output_json` longtext CHARACTER SET utf8mb4 COLLATE utf8mb4_bin
    NOT NULL CHECK (json_valid(`decision_output_json`)),
  `decision_output_sha256` char(64) NOT NULL,
  `recheck_attempt` int NOT NULL DEFAULT 0,
  `decided_at` datetime(6) NOT NULL,
  `supersedes_decision_id` varchar(40) DEFAULT NULL,
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_automated_decision_manifest`
    (`call_id`, `decision_type`, `input_manifest_sha256`, `ruleset_sha256`),
  KEY `idx_automated_decision_call_time` (`call_id`, `decided_at`),
  KEY `idx_automated_decision_status`
    (`decision_type`, `decision_status`, `next_action`, `decided_at`),
  KEY `fk_automated_decision_audit_run` (`audit_run_id`),
  KEY `fk_automated_decision_billing` (`billing_calculation_id`),
  KEY `fk_automated_decision_supersedes` (`supersedes_decision_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

-- Existing installations differ between utf8mb4_general_ci and
-- utf8mb4_0900_ai_ci. Foreign-key string columns must use the exact parent
-- collation, so inherit kaudit_call.id's collation instead of assuming one.
SET @kaudit_parent_collation = (
  SELECT `COLLATION_NAME`
  FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'kaudit_call'
    AND COLUMN_NAME = 'id'
);
SET @kaudit_convert_decision_sql = CONCAT(
  'ALTER TABLE `kaudit_automated_decision` ',
  'CONVERT TO CHARACTER SET utf8mb4 COLLATE ',
  @kaudit_parent_collation
);
PREPARE kaudit_convert_decision
  FROM @kaudit_convert_decision_sql;
EXECUTE kaudit_convert_decision;
DEALLOCATE PREPARE kaudit_convert_decision;

ALTER TABLE `kaudit_automated_decision`
  ADD
  CONSTRAINT `fk_automated_decision_call`
    FOREIGN KEY (`call_id`) REFERENCES `kaudit_call` (`id`),
  ADD
  CONSTRAINT `fk_automated_decision_audit_run`
    FOREIGN KEY (`audit_run_id`) REFERENCES `kaudit_audit_run` (`id`),
  ADD
  CONSTRAINT `fk_automated_decision_billing`
    FOREIGN KEY (`billing_calculation_id`)
    REFERENCES `kaudit_billing_calculation` (`id`),
  ADD
  CONSTRAINT `fk_automated_decision_supersedes`
    FOREIGN KEY (`supersedes_decision_id`)
    REFERENCES `kaudit_automated_decision` (`id`);

-- VERIFY (read-only):
--   SELECT COLUMN_NAME
--   FROM information_schema.COLUMNS
--   WHERE TABLE_SCHEMA = DATABASE()
--     AND TABLE_NAME = 'kaudit_billing_calculation'
--     AND COLUMN_NAME IN (
--       'calculation_basis','conversation_end_ms','wrap_up_grace_ms',
--       'adjusted_chargeable_duration_ms','one_way_tail_ms',
--       'one_way_tail_alert','ruleset_sha256','decision_trace_json',
--       'decision_trace_sha256','finalized_at'
--     );
--   SHOW CREATE TABLE kaudit_automated_decision;
--
-- Forward-fix policy:
--   Once new calculation/decision rows exist, do not drop these columns or this
--   table. Correct schema defects additively so the financial audit trail survives.
-- ============================================================================
