-- ai_runs — one row per `/ai/chat` (or future `/ai/agent/run`) invocation.
--
-- We keep this table separate from `audit_log` because it's a high-cardinality
-- ledger with structured columns we want to query (token totals, error
-- messages, latency). RLS keeps every tenant scoped to their own runs.
--
-- See docs/ARCHITECTURE-WEB-SAAS.md §7 (AI proxy) and AGENT E's notes.

BEGIN;

CREATE TABLE ai_runs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id  uuid        NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  vault_id         uuid        REFERENCES vaults(id)  ON DELETE SET NULL,
  user_id          uuid        REFERENCES users(id)   ON DELETE SET NULL,
  model            text        NOT NULL,
  status           text        NOT NULL DEFAULT 'running'
                                CHECK (status IN ('running','succeeded','failed','aborted')),
  input_tokens     integer     NOT NULL DEFAULT 0,
  output_tokens    integer     NOT NULL DEFAULT 0,
  started_at       timestamptz NOT NULL DEFAULT now(),
  finished_at      timestamptz,
  error            text
);

CREATE INDEX ai_runs_sub_started_idx
  ON ai_runs (subscription_id, started_at DESC);
CREATE INDEX ai_runs_vault_started_idx
  ON ai_runs (vault_id, started_at DESC)
  WHERE vault_id IS NOT NULL;

ALTER TABLE ai_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_runs FORCE ROW LEVEL SECURITY;

CREATE POLICY ai_runs_tenant ON ai_runs
  USING (subscription_id = app_subscription_id())
  WITH CHECK (subscription_id = app_subscription_id());

GRANT SELECT, INSERT, UPDATE ON ai_runs TO tolaria_app;

COMMIT;
