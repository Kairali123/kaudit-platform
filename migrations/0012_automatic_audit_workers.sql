-- ============================================================================
-- Migration 0012 - automatic audit worker controls and Call Audit checkpoint
-- ============================================================================
-- EXPAND-ONLY. Adds Kaudit-owned orchestration state for the two independent
-- audit systems. It does not alter evidence, billing, Call Audit result, or
-- external source tables, and it performs no model work.

CREATE TABLE `kaudit_audit_worker_control` (
  `audit_system` varchar(20) NOT NULL
    COMMENT 'Closed system key: billing or call',
  `desired_state` varchar(20) NOT NULL DEFAULT 'running'
    COMMENT 'Administrator intent; running drains work and paused claims no new item',
  `observed_state` varchar(20) NOT NULL DEFAULT 'idle'
    COMMENT 'Last worker observation: idle, running, pausing, paused, or faulted',
  `state_version` bigint unsigned NOT NULL DEFAULT 1
    COMMENT 'Monotonic administrator-control revision',
  `work_sequence` bigint unsigned NOT NULL DEFAULT 0
    COMMENT 'Monotonic internal sequence for retry-safe work identities',
  `last_heartbeat_at` datetime(6) DEFAULT NULL,
  `last_progress_at` datetime(6) DEFAULT NULL,
  `last_error_code` varchar(80) DEFAULT NULL
    COMMENT 'Bounded application code only; never provider or thrown prose',
  `processed_total` bigint unsigned NOT NULL DEFAULT 0,
  `failed_total` bigint unsigned NOT NULL DEFAULT 0,
  `checkpoint_at` datetime(6) DEFAULT NULL
    COMMENT 'Call Audit source-change watermark; null for Billing Audit',
  `checkpoint_source_row_id` decimal(20,0) unsigned DEFAULT NULL
    COMMENT 'Internal Call Audit keyset tie-breaker; never returned by the API',
  `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    ON UPDATE current_timestamp(6),
  PRIMARY KEY (`audit_system`),
  CONSTRAINT `chk_audit_worker_system`
    CHECK (`audit_system` IN ('billing', 'call')),
  CONSTRAINT `chk_audit_worker_desired_state`
    CHECK (`desired_state` IN ('running', 'paused')),
  CONSTRAINT `chk_audit_worker_observed_state`
    CHECK (`observed_state` IN ('idle', 'running', 'pausing', 'paused', 'faulted')),
  CONSTRAINT `chk_audit_worker_checkpoint_pair`
    CHECK (
      (`checkpoint_at` IS NULL AND `checkpoint_source_row_id` IS NULL)
      OR
      (`checkpoint_at` IS NOT NULL AND `checkpoint_source_row_id` IS NOT NULL)
    )
) ENGINE=InnoDB
  COMMENT='Kaudit-owned automatic worker control and privacy-internal progress; no content or money';

-- Automatic is the default. Administrators may pause either worker after the
-- migration, and workers always re-read this durable intent before new work.
INSERT INTO `kaudit_audit_worker_control`
  (`audit_system`, `desired_state`, `observed_state`)
VALUES
  ('billing', 'running', 'idle'),
  ('call', 'running', 'idle');
