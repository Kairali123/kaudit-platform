-- Billing-cycle read index matched to the per-call completed-audit probe.
--
-- APPLY ONLY as an approved, supervised schema operation after comparing this
-- definition with SHOW INDEX and confirming the plan with EXPLAIN ANALYZE.
-- This migration is additive and schema-only: it does not rewrite evidence,
-- decide money, or access the external Call Audit source table.

ALTER TABLE `kaudit_audit_run`
  ADD KEY `idx_audit_run_call_engine_status`
    (`call_id`, `engine_version`, `status`);

-- Read-only verification after an approved application:
--   SHOW INDEX FROM kaudit_audit_run
--     WHERE Key_name = 'idx_audit_run_call_engine_status';
