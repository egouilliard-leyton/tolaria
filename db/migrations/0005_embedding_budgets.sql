-- embedding_budgets — per-tenant daily spend ledger for the embedding
-- pipeline. The worker bumps the row before each embedding call and skips
-- the call when the day's total would exceed the configured cap (env
-- `EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY`). One row per
-- (subscription_id, day) keeps reads cheap and `INSERT … ON CONFLICT DO
-- UPDATE … RETURNING` keeps the bump atomic.
--
-- RLS is on so a leaked client connection cannot enumerate other tenants'
-- spend. The worker runs every query inside `withTenant`, which sets
-- `app.subscription_id` — matching the policy below.
--
-- See Bundle F in docs/web-saas/audit-2026-05-10.md.

BEGIN;

CREATE TABLE IF NOT EXISTS embedding_budgets (
  subscription_id  uuid NOT NULL,
  day              date NOT NULL,
  cents_spent      bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (subscription_id, day)
);

GRANT SELECT, INSERT, UPDATE ON embedding_budgets TO tolaria_app;

ALTER TABLE embedding_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE embedding_budgets FORCE ROW LEVEL SECURITY;

CREATE POLICY embedding_budgets_tenant ON embedding_budgets
  USING (subscription_id = app_subscription_id())
  WITH CHECK (subscription_id = app_subscription_id());

COMMIT;
