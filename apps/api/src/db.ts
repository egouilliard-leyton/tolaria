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

export async function pingDb(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query('SELECT 1')
  } finally {
    client.release()
  }
}
