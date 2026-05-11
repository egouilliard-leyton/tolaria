-- ai_runs.cost_cents — per-call cost attribution in whole cents.
--
-- The cost is computed in the API process via the static model-cost
-- table (apps/api/src/services/model-cost.ts) so it stays a code-time
-- decision; the column exists so finance/admin queries can roll up
-- spend per (subscription, day, model) without re-deriving the
-- pricing on every read. See audit-2026-05-10 Bundle K (G49).
--
-- Nullable so historical rows (pre-migration) and rows where the model
-- is missing from the static table both stay queryable.

BEGIN;

ALTER TABLE ai_runs
  ADD COLUMN IF NOT EXISTS cost_cents integer;

COMMIT;
