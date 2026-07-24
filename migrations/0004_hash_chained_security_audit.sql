-- ============================================================================
-- Migration 0004 — production identity/access audit foundation
-- ============================================================================
-- ADDITIVE ONLY. Review before applying. This migration does not backfill, alter,
-- or delete any existing business/evidence/billing row.
--
-- Existing kaudit_audit_log rows remain valid legacy entries. The cryptographic
-- chain begins with the first event written after this migration. A separately
-- approved backfill may anchor legacy rows later; this migration does not rewrite
-- historical audit evidence.

ALTER TABLE `kaudit_audit_log`
  ADD COLUMN `actor_user_id` varchar(40) DEFAULT NULL AFTER `actor_email`,
  ADD COLUMN `outcome` varchar(20) NOT NULL DEFAULT 'success' AFTER `correlation_id`,
  ADD COLUMN `purpose` varchar(80) NOT NULL DEFAULT 'unspecified' AFTER `outcome`,
  ADD COLUMN `previous_hash` char(64) DEFAULT NULL AFTER `purpose`,
  ADD COLUMN `entry_hash` char(64) DEFAULT NULL AFTER `previous_hash`,
  ADD UNIQUE KEY `uq_audit_log_entry_hash` (`entry_hash`),
  ADD KEY `idx_audit_log_actor_time` (`actor_user_id`, `occurred_at`),
  ADD KEY `idx_audit_log_resource_time` (`resource_type`, `resource_id`, `occurred_at`);

CREATE TABLE IF NOT EXISTS `kaudit_audit_chain_head` (
  `chain_name` varchar(40) NOT NULL,
  `head_hash` char(64) NOT NULL,
  `head_event_id` varchar(40) DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  PRIMARY KEY (`chain_name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `kaudit_audit_chain_head`
  (`chain_name`, `head_hash`, `head_event_id`)
VALUES
  ('primary', REPEAT('0', 64), NULL)
ON DUPLICATE KEY UPDATE `chain_name` = `chain_name`;

-- Forward-fix / rollback note:
-- Application rollback is safe: old writers ignore the additive columns.
-- Do not drop hash columns after chained events exist; that would destroy the
-- verifiable trail. A forward fix should preserve both log rows and chain head.
