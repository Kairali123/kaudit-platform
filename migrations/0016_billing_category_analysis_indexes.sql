-- Category Analysis read indexes matched to the bounded month/category queries.
--
-- APPLY ONLY as an approved, supervised schema operation after comparing these
-- definitions with SHOW INDEX and confirming the plans with EXPLAIN ANALYZE.
-- This migration is additive and schema-only: it does not rewrite evidence,
-- decide money, or access the external Call Audit source table.

ALTER TABLE `kaudit_call`
  ADD KEY `idx_call_period_category_started`
    (`billing_period_date`, `canonical_outcome_code`, `source_started_at`, `id`);

ALTER TABLE `kaudit_call_artifact`
  ADD KEY `idx_call_artifact_call_recording_final`
    (`call_id`, `artifact_type`, `is_final`);

ALTER TABLE `kaudit_provider_cost`
  ADD KEY `idx_provider_cost_call_sku_final`
    (`call_id`, `provider_sku`, `is_final`);

ALTER TABLE `kaudit_media_analysis`
  ADD KEY `idx_media_analysis_artifact_classified_latest`
    (`call_artifact_id`, `status`, `classification_status`,
     `created_at` DESC, `id` DESC);

ALTER TABLE `kaudit_transcript`
  ADD KEY `idx_transcript_artifact_status_call`
    (`call_artifact_id`, `status`, `call_id`);

ALTER TABLE `kaudit_call_external_reference`
  ADD KEY `idx_call_reference_call_type_first`
    (`call_id`, `reference_type`, `id`);

ALTER TABLE `kaudit_audit_finding`
  ADD KEY `idx_audit_finding_call_code_latest`
    (`call_id`, `finding_code`, `created_at` DESC, `id` DESC);

-- Read-only verification after an approved application:
--   SHOW INDEX FROM kaudit_call;
--   SHOW INDEX FROM kaudit_call_artifact;
--   SHOW INDEX FROM kaudit_provider_cost;
--   SHOW INDEX FROM kaudit_media_analysis;
--   SHOW INDEX FROM kaudit_transcript;
--   SHOW INDEX FROM kaudit_call_external_reference;
--   SHOW INDEX FROM kaudit_audit_finding;
--
-- Then run EXPLAIN ANALYZE for the month summary, no-recording aggregate, and
-- one category page. Retain only indexes selected by measured query plans.
