import pg from 'pg'
import { loadEnv } from './env.js'

const env = loadEnv()

export const pool = new pg.Pool({
  connectionString: env.DATABASE_URL,
  max: env.DATABASE_POOL_MAX,
  application_name: 'tolaria-api',
})

export type PgClient = pg.PoolClient

export interface TenantContext {
  subscriptionId: string
  userId: string
}

/**
 * Run `fn` inside a transaction with the per-request RLS variables set.
 * `SET LOCAL` is bound to the transaction, so the connection cannot leak
 * tenant context once it is returned to the pool. See ADR-0115.
 */
export async function withTenant<T>(
  ctx: TenantContext,
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.subscription_id', $1, true)", [ctx.subscriptionId])
    await client.query("SELECT set_config('app.user_id', $1, true)", [ctx.userId])
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

/**
 * Convenience for a single read inside a tenant transaction.
 */
export async function tenantQuery<T extends pg.QueryResultRow = pg.QueryResultRow>(
  ctx: TenantContext,
  text: string,
  params: ReadonlyArray<unknown> = [],
): Promise<pg.QueryResult<T>> {
  return withTenant(ctx, (client) => client.query<T>(text, params as unknown[]))
}

/**
 * Run `fn` inside a transaction with NO tenant context set.
 *
 * This is a tightly-scoped escape hatch for the auth path only. During an
 * OIDC callback we need to:
 *   1. read `sso_providers` rows where `subscription_id IS NULL` (the
 *      platform-default Authentik fallback) — RLS already permits this for
 *      any session because the platform-default row is the public login
 *      handshake.
 *   2. look up an existing `users` row by SSO subject across subscriptions,
 *      since the JIT-provisioning logic decides which `subscription_id` to
 *      bind to *during* the lookup.
 *
 * After the user identity is resolved, every subsequent query MUST switch to
 * `withTenant({ subscriptionId, userId }, …)`. Do NOT call this helper from
 * any feature route — it is reserved for `auth/*` and `services/sso-*`.
 *
 * The `subscription_id IS NULL` policy on `sso_providers` and the
 * `subscription_id = app_subscription_id()` policy on `users` together mean
 * that without a session var set, we can read platform-default providers and
 * NOTHING ELSE. That is the intended safety margin.
 */
export async function withPlatformContext<T>(
  fn: (client: PgClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect()
  try {
    await client.query('BEGIN')
    // Explicitly clear any lingering vars; SET LOCAL would not leak to the
    // pool but a misbehaving prior caller (e.g. test harness) could have set
    // a session-wide var. set_config(_, _, true) is transaction-local.
    await client.query("SELECT set_config('app.subscription_id', '', true)")
    await client.query("SELECT set_config('app.user_id', '', true)")
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

export async function pingDb(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}
