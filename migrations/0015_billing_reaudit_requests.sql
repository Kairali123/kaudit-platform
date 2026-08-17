-- ==========================================================================
-- Migration 0015 - administrator-requested Billing Audit re-audits
-- ==========================================================================
-- EXPAND-ONLY. Adds two Kaudit-owned control tables that carry the durable
-- queue behind the Audit Monitor's "Re-audit selected" action.
--
-- APPLY ONLY as an approved, supervised schema operation. This migration does
-- not alter or write evidence, transcripts, billing calculations, Call Audit,
-- or any external source table, and it performs no model work.
--
-- What these tables deliberately DO NOT store: displayed task references,
-- recording or provider URLs, transcripts, prompts, provider prose or raw
-- responses, money, credentials, and PII. Only internal ids, lifecycle,
-- provenance, hashes, counts, the classifier ruleset, and bounded application
-- error codes.

CREATE TABLE `kaudit_billing_reaudit_request` (
  `id` varchar(40) NOT NULL
    COMMENT 'Internal request handle; never a call, artifact, or audit-run id',
  `idempotency_key` varchar(80) NOT NULL
    COMMENT 'Bounded caller retry key; a repeat of it replays this row',
  `request_digest` char(64) NOT NULL
    COMMENT 'SHA-256 of the exact sorted selection; references are not stored',
  `requested_by_user_id` varchar(40) DEFAULT NULL
    COMMENT 'Authenticated administrator; provenance only',
  `correlation_id` varchar(120) DEFAULT NULL,
  `ruleset_version` varchar(80) NOT NULL
    COMMENT 'Classifier ruleset deployed when the request was accepted',
  `status` varchar(32) NOT NULL DEFAULT 'queued',
  `requested_count` int unsigned NOT NULL,
  `completed_count` int unsigned NOT NULL DEFAULT 0,
  `failed_count` int unsigned NOT NULL DEFAULT 0,
  `skipped_count` int unsigned NOT NULL DEFAULT 0
    COMMENT 'Items whose baseline audit run moved on before the worker arrived',
  `requested_at` datetime(6) NOT NULL,
  `started_at` datetime(6) DEFAULT NULL,
  `completed_at` datetime(6) DEFAULT NULL,
  `updated_at` datetime(6) NOT NULL DEFAULT current_timestamp(6)
    ON UPDATE current_timestamp(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_billing_reaudit_request_key` (`idempotency_key`),
  KEY `idx_billing_reaudit_request_status` (`status`, `requested_at`),
  CONSTRAINT `chk_billing_reaudit_request_status`
    CHECK (`status` IN
      ('queued','running','completed','completed_with_failures')),
  -- The API's own ceiling, restated where it cannot be bypassed by a caller.
  CONSTRAINT `chk_billing_reaudit_request_count`
    CHECK (`requested_count` BETWEEN 1 AND 100),
  CONSTRAINT `chk_billing_reaudit_request_progress`
    CHECK (`completed_count` + `failed_count` + `skipped_count`
           <= `requested_count`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Kaudit-owned admin Billing Audit re-audit request; control metadata only';

CREATE TABLE `kaudit_billing_reaudit_item` (
  `id` varchar(40) NOT NULL,
  `request_id` varchar(40) NOT NULL,
  `call_id` varchar(36) NOT NULL
    COMMENT 'Internal call id, resolved server-side from the displayed row',
  `baseline_audit_run_id` varchar(36) NOT NULL
    COMMENT 'Audit run current when queued; a change means skip, never respend',
  `status` varchar(24) NOT NULL DEFAULT 'queued',
  -- One ACTIVE request per internal call, enforced by the unique key below:
  -- the column is the call id while the item is live and NULL once it settles,
  -- and MySQL does not apply a unique key to NULL. This is what makes a second
  -- click, a second administrator, and a retried POST unable to double-spend.
  `active_call_id` varchar(36)
    GENERATED ALWAYS AS
      (CASE WHEN `status` IN ('queued','processing') THEN `call_id` ELSE NULL END)
    STORED,
  `attempt_count` tinyint unsigned NOT NULL DEFAULT 0
    COMMENT 'Claims made; interrupted paid work is never reclaimed automatically',
  `last_error_code` varchar(80) DEFAULT NULL
    COMMENT 'Bounded application code only; never provider or thrown prose',
  `created_at` datetime(6) NOT NULL DEFAULT current_timestamp(6),
  `started_at` datetime(6) DEFAULT NULL,
  `completed_at` datetime(6) DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_billing_reaudit_request_call` (`request_id`, `call_id`),
  UNIQUE KEY `uq_billing_reaudit_active_call` (`active_call_id`),
  KEY `idx_billing_reaudit_item_queue` (`status`, `created_at`),
  KEY `idx_billing_reaudit_item_call` (`call_id`, `status`),
  CONSTRAINT `fk_billing_reaudit_item_request`
    FOREIGN KEY (`request_id`)
    REFERENCES `kaudit_billing_reaudit_request` (`id`),
  CONSTRAINT `fk_billing_reaudit_item_call`
    FOREIGN KEY (`call_id`) REFERENCES `kaudit_call` (`id`),
  CONSTRAINT `fk_billing_reaudit_item_baseline`
    FOREIGN KEY (`baseline_audit_run_id`) REFERENCES `kaudit_audit_run` (`id`),
  CONSTRAINT `chk_billing_reaudit_item_status`
    CHECK (`status` IN ('queued','processing','completed','skipped','failed')),
  CONSTRAINT `chk_billing_reaudit_item_attempts`
    CHECK (`attempt_count` <= 1)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Exact internal calls selected for append-only Billing Audit re-audit';

-- Read-only verification after an approved application:
--   SHOW CREATE TABLE kaudit_billing_reaudit_request;
--   SHOW CREATE TABLE kaudit_billing_reaudit_item;
--
-- Rollback BEFORE USE only:
--   DROP TABLE kaudit_billing_reaudit_item;
--   DROP TABLE kaudit_billing_reaudit_request;
-- Once requests exist, retain them as operational audit history and forward-fix.
