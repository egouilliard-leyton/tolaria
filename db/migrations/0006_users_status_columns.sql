-- users.revoked_at / users.last_seen_at — the two columns the
-- `admin/users.ts` rowToResponse helper needs to derive the
-- `status: 'invited' | 'active' | 'revoked'` field. Before this migration
-- the route pinned status to 'active' because the columns did not exist
-- (see audit-2026-05-10.md gap G41 + Bundle I).
--
-- `revoked_at` is stamped when DELETE /admin/users/:id soft-revokes a
-- member; `last_seen_at` is stamped on every successful /auth/refresh
-- and /me response so an invited user who has never signed in stays at
-- 'invited' until their first session lands.
--
-- The composite index keeps the admin /admin/users listing fast even on
-- large subscriptions: the page sorts by recency-of-activity within a
-- tenant, and a partial-index DESC NULLS LAST matches the typical
-- "active first, never-seen at the bottom" ordering.

BEGIN;

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS revoked_at  timestamptz,
  ADD COLUMN IF NOT EXISTS last_seen_at timestamptz;

CREATE INDEX IF NOT EXISTS users_last_seen_idx
  ON users (subscription_id, last_seen_at DESC NULLS LAST);

COMMIT;
