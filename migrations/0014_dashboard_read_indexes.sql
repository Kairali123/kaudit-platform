-- Dashboard read indexes measured against the production query shapes.
--
-- APPLY ONLY as an approved, supervised production schema operation. This
-- migration is additive: it does not rewrite evidence, decide money, or touch
-- the external Call Audit source table.

ALTER TABLE `kaudit_call`
  ADD KEY `idx_call_billing_period_id` (`billing_period_date`, `id`);

ALTER TABLE `kaudit_billing_calculation`
  ADD KEY `idx_billing_calc_supersedes` (`supersedes_calculation_id`);

-- Read-only verification after an approved application:
--   SHOW INDEX FROM kaudit_call;
--   SHOW INDEX FROM kaudit_billing_calculation;
