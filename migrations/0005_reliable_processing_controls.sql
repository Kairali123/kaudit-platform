-- ============================================================================
-- Migration 0005 — reliable processing controls
-- ============================================================================
-- EXPAND-ONLY. Adds the fields required for at-least-once outbox publication,
-- inbox deduplication, visible retries/DLQ, and mutation idempotency. It does not
-- publish, retry, recalculate, or mutate any business/evidence/financial row.
--
-- Existing rows remain readable. New application writers require message_id and
-- payload_sha256, but those columns stay nullable until a separately approved
-- legacy-row audit/backfill proves every historical value.

ALTER TABLE `kaudit_outbox_message`
  ADD COLUMN `message_id` varchar(191) DEFAULT NULL AFTER `id`,
  ADD COLUMN `payload_sha256` char(64) DEFAULT NULL AFTER `payload_json`,
  ADD COLUMN `correlation_id` varchar(120) DEFAULT NULL AFTER `payload_sha256`,
  ADD COLUMN `available_at` datetime(6) NOT NULL DEFAULT current_timestamp(6) AFTER `status`,
  ADD COLUMN `lease_owner` varchar(120) DEFAULT NULL AFTER `available_at`,
  ADD COLUMN `lease_expires_at` datetime(6) DEFAULT NULL AFTER `lease_owner`,
  ADD COLUMN `last_error_code` varchar(80) DEFAULT NULL AFTER `lease_expires_at`,
  ADD COLUMN `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6) AFTER `published_at`,
  ADD UNIQUE KEY `uq_outbox_message_id` (`message_id`),
  ADD KEY `idx_outbox_claim` (`status`, `available_at`, `lease_expires_at`);

ALTER TABLE `kaudit_inbox_message`
  ADD COLUMN `payload_sha256` char(64) DEFAULT NULL AFTER `message_id`,
  ADD COLUMN `processed_at` datetime(6) DEFAULT NULL AFTER `received_at`,
  ADD COLUMN `error_code` varchar(80) DEFAULT NULL AFTER `processed_at`,
  ADD COLUMN `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6) AFTER `error_code`,
  ADD KEY `idx_inbox_lease` (`status`, `lease_expires_at`);

ALTER TABLE `kaudit_job_attempt`
  ADD COLUMN `message_id` varchar(191) DEFAULT NULL AFTER `job_type`,
  ADD COLUMN `idempotency_key` varchar(191) DEFAULT NULL AFTER `message_id`,
  ADD COLUMN `correlation_id` varchar(120) DEFAULT NULL AFTER `idempotency_key`,
  ADD COLUMN `error_code` varchar(80) DEFAULT NULL AFTER `status`,
  ADD COLUMN `next_retry_at` datetime(6) DEFAULT NULL AFTER `error_code`,
  ADD KEY `idx_job_message` (`message_id`, `attempt_no`),
  ADD KEY `idx_job_retry` (`status`, `next_retry_at`);

ALTER TABLE `kaudit_idempotency_record`
  ADD COLUMN `status` varchar(20) NOT NULL DEFAULT 'processing' AFTER `request_hash`,
  ADD COLUMN `http_status` smallint unsigned DEFAULT NULL AFTER `response_reference`,
  ADD COLUMN `response_hash` char(64) DEFAULT NULL AFTER `http_status`,
  ADD COLUMN `lock_owner` varchar(120) DEFAULT NULL AFTER `response_hash`,
  ADD COLUMN `locked_until` datetime(6) DEFAULT NULL AFTER `lock_owner`,
  ADD COLUMN `updated_at` datetime(6) DEFAULT NULL ON UPDATE current_timestamp(6) AFTER `created_at`,
  ADD KEY `idx_idempotency_expiry` (`status`, `expires_at`, `locked_until`);

-- Contract phase (future, only after legacy-row proof):
--   make outbox.message_id/payload_sha256 and inbox.payload_sha256 NOT NULL.
-- Never delete outbox/inbox/idempotency history merely to satisfy that contract.
