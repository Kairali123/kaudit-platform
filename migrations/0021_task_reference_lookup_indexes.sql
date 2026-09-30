-- Task ID lookup indexes for the Sheet reconciliation path.
--
-- Production timing (2026-09-30) attributed 4-21 s per statement to the Task ID
-- lookups (resolveTaskCalls, re-audit resolveSelection, failureReceipts). Both
-- lookup columns were only reachable as non-leading index columns:
--   kaudit_call.logical_call_key            -> 2nd column of uq_call_logical_key
--   kaudit_call_external_reference.external_id
--                                           -> 3rd column of uq_call_ext_ref,
--                                              after provider_name
-- so every lookup scanned. The re-audit lookup runs under the enqueue lock,
-- which also made parallel batches fail as REAUDIT_QUEUE_BUSY.
--
-- APPLY ONLY as an approved, supervised schema operation after comparing this
-- definition with SHOW INDEX. Additive and schema-only: it does not rewrite
-- evidence, decide money, or access the external Call Audit source table.

ALTER TABLE `kaudit_call`
  ADD INDEX `idx_call_logical_key` (`logical_call_key`, `billing_period_date`),
  ALGORITHM=INPLACE, LOCK=NONE;

ALTER TABLE `kaudit_call_external_reference`
  ADD INDEX `idx_call_reference_external`
    (`external_id`, `reference_type`, `call_id`),
  ALGORITHM=INPLACE, LOCK=NONE;

-- Read-only verification after an approved application:
--   SHOW INDEX FROM kaudit_call WHERE Key_name = 'idx_call_logical_key';
--   SHOW INDEX FROM kaudit_call_external_reference
--     WHERE Key_name = 'idx_call_reference_external';
