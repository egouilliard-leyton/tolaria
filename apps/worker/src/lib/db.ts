// Worker-side pg pool + withTenant helper.
//
// The worker shares the same database as the API but runs in a separate
// Node process, so it gets its own pg.Pool. Every handler that reads or
// writes tenant tables MUST call `withTenant` so the SET LOCAL session
// vars satisfy the RLS policies installed by `db/migrations/0001_init.sql`.
//
// The shape mirrors `apps/api/src/db.ts` so the two stay easy to reason
// about side-by-side. The worker's tenant context only requires a
// subscription id — the policies on note/vault/attachment tables never
// read `app.user_id` — but we still set both vars so the audit_log
// inserts (which DO read `app.user_id`) keep a stable actor.

import pg from 'pg'
import { loadEnv } from '../env.js'

const env = loadEnv()

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  application_name: 'tolaria-worker',
})

export type PgClient = pg.PoolClient

export interface TenantContext {
  subscriptionId: string
  // `app.user_id` is only consulted when the worker writes audit_log rows.
  // For the worker we use the zero-UUID by default so the actor column is
  // explicit ("system" rather than masquerading as a human user).
  userId?: string
}

export const SYSTEM_USER_ID = '00000000-0000-0000-0000-000000000000'

export async function withTenant<T>(
  ctx: TenantContext,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.subscription_id', $1, true)", [
      ctx.subscriptionId,
    ])
    await client.query("SELECT set_config('app.user_id', $1, true)", [
      ctx.userId ?? SYSTEM_USER_ID,
    ])
    const out = await fn(client)
    await client.query('COMMIT')
    return out
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined)
    throw err
  } finally {
    client.release()
  }
}
