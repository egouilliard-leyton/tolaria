// Shared DB harness for the data-plane tests.
//
// We talk to a real Postgres because the routes are tightly coupled to RLS
// and to a few SQL features (regexp_replace, gin tsvector, pg_trgm). When
// DATABASE_URL isn't set the tests are skipped via the helper's `available`
// flag — the consumer just calls `it.skipIf(!available)`.
//
// For each test we pick a fresh `subscription_id` (a random UUID) and set
// it on the connection via the same SET LOCAL we use in production. This
// way RLS policies behave exactly like they do for a real request.

import { randomUUID } from 'node:crypto'
import pg from 'pg'

export const DATABASE_URL = process.env.DATABASE_URL ?? ''
export const available = !!DATABASE_URL

// Lazy singleton pool. Tests that need RLS open a transaction and roll it
// back; tests that need cross-tx assertions explicitly commit.
let pool: pg.Pool | null = null

export function getPool(): pg.Pool {
  if (!pool) {
    pool = new pg.Pool({ connectionString: DATABASE_URL, max: 4 })
  }
  return pool
}

export async function closePool(): Promise<void> {
  if (pool) {
    await pool.end()
    pool = null
  }
}

export interface TestTenant {
  subscriptionId: string
  userId: string
}

/**
 * Insert a fresh subscription + owner user, returning the IDs ready to be
 * fed into withTestTenant.
 */
export async function createTenant(): Promise<TestTenant> {
  const p = getPool()
  const subId = randomUUID()
  const userId = randomUUID()
  await p.query(
    `INSERT INTO subscriptions (id, name, plan) VALUES ($1, 'test', 'free')`,
    [subId],
  )
  await p.query(
    `INSERT INTO users (id, subscription_id, email, role)
     VALUES ($1, $2, $3, 'owner')`,
    [userId, subId, `t-${userId}@example.test`],
  )
  return { subscriptionId: subId, userId }
}

/**
 * Strip every row this tenant created so the test database stays small.
 * We rely on ON DELETE CASCADE from subscriptions → users → vaults → notes.
 */
export async function dropTenant(t: TestTenant): Promise<void> {
  const p = getPool()
  await p.query(`DELETE FROM subscriptions WHERE id = $1`, [t.subscriptionId])
}

/**
 * Run `fn` inside a transaction with the per-request RLS variables set.
 * Mirrors `apps/api/src/db.ts:withTenant`.
 */
export async function withTestTenant<T>(
  t: TestTenant,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query("SELECT set_config('app.subscription_id', $1, true)", [
      t.subscriptionId,
    ])
    await client.query("SELECT set_config('app.user_id', $1, true)", [t.userId])
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

export async function createVault(
  t: TestTenant,
  name = 'Test',
  slug = `vault-${randomUUID().slice(0, 8)}`,
): Promise<string> {
  return withTestTenant(t, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO vaults (subscription_id, name, slug, created_by)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [t.subscriptionId, name, slug, t.userId],
    )
    return r.rows[0]!.id
  })
}

export async function createNote(
  t: TestTenant,
  vaultId: string,
  slug: string,
  body = '',
  title = slug,
): Promise<string> {
  return withTestTenant(t, async (c) => {
    const r = await c.query<{ id: string }>(
      `INSERT INTO notes (vault_id, slug, title, body_md, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [vaultId, slug, title, body, t.userId],
    )
    return r.rows[0]!.id
  })
}
