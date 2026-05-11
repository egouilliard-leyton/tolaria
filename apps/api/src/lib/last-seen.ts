// Stamps `users.last_seen_at = now()` for the calling user. Called from
// `/auth/refresh` (every successful refresh-token rotation) and from
// `/me` (every successful "did my access token still work?" probe).
//
// Failures are swallowed and logged: this column is a UX hint for the
// admin listing's `status: 'invited' | 'active' | 'revoked'` derivation
// (see migration 0006, audit-2026-05-10 Bundle I), not a correctness
// invariant. A failed UPDATE simply leaves the user looking like they
// have not yet signed in.
//
// Both call sites already run inside `withTenant`, so RLS pins the
// UPDATE to the requesting subscription. We accept a `PgClient`-or-
// `TenantContext` shape so the helper can be called either inline in
// an existing transaction or as a one-shot.

import { withTenant, type PgClient, type TenantContext } from '../db.js'
import { logger } from './logger.js'

/**
 * Stamp `last_seen_at = now()` for the given user inside the caller's
 * already-open transaction. Use this form when you already have a
 * `withTenant` client on hand — it avoids spending an extra pool
 * round-trip.
 */
export async function stampLastSeenInTransaction(
  client: PgClient,
  userId: string,
): Promise<void> {
  try {
    await client.query(
      `UPDATE users SET last_seen_at = now() WHERE id = $1`,
      [userId],
    )
  } catch (err) {
    logger.warn({ err, userId }, 'stampLastSeen (in-tx) failed; ignoring')
  }
}

/**
 * Stamp `last_seen_at = now()` for the given user in a fresh tenant
 * transaction. Used from routes that have not already opened a
 * transaction for unrelated work.
 */
export async function stampLastSeen(ctx: TenantContext): Promise<void> {
  try {
    await withTenant(ctx, (client) =>
      stampLastSeenInTransaction(client, ctx.userId),
    )
  } catch (err) {
    logger.warn({ err, userId: ctx.userId }, 'stampLastSeen failed; ignoring')
  }
}
