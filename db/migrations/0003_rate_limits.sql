-- rate_limit_buckets — token-bucket counters for /auth/*, /ai/*, /search.
--
-- See docs/ARCHITECTURE-WEB-SAAS.md §9 ("Rate limits: per-IP on /auth/*,
-- per-user on /ai/* and /search. Stored in Postgres (no Redis dep) using a
-- token-bucket table.").
--
-- Intentionally NOT scoped by tenant — these counters protect the platform
-- itself, and the `key` column already namespaces by bucket + scope + ip/user
-- (e.g. "auth:ip:1.2.3.4", "ai:user:<uuid>"). RLS would actively prevent the
-- per-IP `auth:*` rows from working, since at the moment they are created
-- there is no authenticated session. The migration is additive and idempotent
-- so it is safe to re-run during dev.

BEGIN;

CREATE TABLE IF NOT EXISTS rate_limit_buckets (
  key          text        PRIMARY KEY,
  tokens       numeric     NOT NULL,
  capacity     numeric     NOT NULL,
  refill_rate  numeric     NOT NULL,                       -- tokens per second
  updated_at   timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON rate_limit_buckets TO tolaria_app;

COMMIT;
