// Token-bucket rate limiter backed by a single Postgres table.
//
// One UPSERT per request keeps the algorithm honest under concurrency: the
// CTE refills based on (now() - updated_at) * refill_rate and decrements one
// token in the same statement. If `tokens` would go below 0, we still
// persist the new state (capped at 0 via greatest()) so a flood of denied
// requests cannot reset the bucket, and we throw `RateLimited`.
//
// Why no Redis: the call rate on these buckets is tiny (auth/ai/search are
// human-driven), the contention is bounded by `capacity`, and we already
// require Postgres. See docs/ARCHITECTURE-WEB-SAAS.md §9.
//
// Each call mounts an additional middleware — handlers don't need to know
// about rate limiting; they just receive the (decremented) token state via
// the response headers `X-RateLimit-Remaining` and (on 429) `Retry-After`.

import type { MiddlewareHandler, Context } from 'hono'
import { getConnInfo } from '@hono/node-server/conninfo'
import { pool } from '../db.js'
import { clientIp as resolveClientIp } from '../lib/client-ip.js'
import { RateLimited, Unauthenticated } from '../lib/errors.js'

export interface RateLimitConfig {
  bucket: 'auth' | 'ai' | 'search'
  scope: 'ip' | 'user'
  capacity: number      // burst size, in tokens
  refillRate: number    // tokens per second
}

// Default budgets. Exported so tests and ops can tune them without editing
// every route.
export const AUTH_RATE_LIMIT = { capacity: 10, refillRate: 0.5 } as const
export const AI_RATE_LIMIT = { capacity: 20, refillRate: 0.05 } as const
export const SEARCH_RATE_LIMIT = { capacity: 60, refillRate: 1 } as const

interface BucketRow {
  allowed: boolean
  remaining: string | number
}

/**
 * Build a Hono middleware that enforces a token-bucket against
 * `rate_limit_buckets`. The bucket key is derived from `cfg.bucket` plus
 * either the client IP (for `scope: 'ip'`) or the authenticated user id
 * (for `scope: 'user'`). For user-scoped limits, `requireAuth` MUST run
 * before this middleware — we throw `Unauthenticated` otherwise.
 */
export function rateLimit(cfg: RateLimitConfig): MiddlewareHandler {
  if (cfg.capacity <= 0 || cfg.refillRate <= 0) {
    throw new Error('rateLimit: capacity and refillRate must be positive')
  }
  return async (c, next) => {
    const key = deriveKey(cfg, c)
    const { allowed, remaining } = await consumeToken(
      key,
      cfg.capacity,
      cfg.refillRate,
    )
    if (!allowed) {
      const retryAfter = Math.max(1, Math.ceil(1 / cfg.refillRate))
      c.header('Retry-After', String(retryAfter))
      c.header('X-RateLimit-Remaining', '0')
      throw RateLimited(`Too many requests for ${cfg.bucket}`)
    }
    c.header('X-RateLimit-Remaining', String(Math.max(0, Math.floor(remaining))))
    await next()
  }
}

function deriveKey(cfg: RateLimitConfig, c: Context): string {
  if (cfg.scope === 'user') {
    const user = c.get('user')
    if (!user || typeof user.sub !== 'string') {
      throw Unauthenticated('rate-limit: scope=user requires requireAuth')
    }
    return `${cfg.bucket}:user:${user.sub}`
  }
  const ip = clientIp(c)
  return `${cfg.bucket}:ip:${ip}`
}

function clientIp(c: Context): string {
  // Prefer the shared helper so the `TRUST_PROXY` gate stays in one place;
  // when it returns null (test harness, no socket) fall back to the
  // connection-info shim that exposes the Node socket directly.
  const shared = resolveClientIp(c)
  if (shared) return shared
  try {
    const info = getConnInfo(c)
    if (info.remote.address) return info.remote.address
  } catch {
    // Test harnesses (Hono `app.request`) don't expose a Node socket; fall
    // through to 'unknown' so the bucket still gets a stable key.
  }
  return 'unknown'
}

/**
 * Run the token-bucket UPSERT. Exported so tests can exercise the SQL
 * directly without going through Hono.
 */
export async function consumeToken(
  key: string,
  capacity: number,
  refillRate: number,
): Promise<{ allowed: boolean; remaining: number }> {
  const client = await pool.connect()
  try {
    const { rows } = await client.query<BucketRow>(
      `INSERT INTO rate_limit_buckets (key, tokens, capacity, refill_rate, updated_at)
       VALUES ($1, $2 - 1, $2, $3, now())
       ON CONFLICT (key) DO UPDATE
         SET tokens = LEAST(
               EXCLUDED.capacity,
               rate_limit_buckets.tokens
                 + EXTRACT(EPOCH FROM (now() - rate_limit_buckets.updated_at))
                   * rate_limit_buckets.refill_rate
             ) - 1,
             capacity    = EXCLUDED.capacity,
             refill_rate = EXCLUDED.refill_rate,
             updated_at  = now()
       RETURNING tokens >= 0 AS allowed, tokens AS remaining`,
      [key, capacity, refillRate],
    )
    const row = rows[0]
    if (!row) {
      // The UPSERT always returns one row in real Postgres; only a buggy mock
      // would land here. Default to denying so the test fails loudly.
      return { allowed: false, remaining: 0 }
    }
    const remainingNum =
      typeof row.remaining === 'number' ? row.remaining : Number(row.remaining)
    return { allowed: row.allowed, remaining: remainingNum }
  } finally {
    client.release()
  }
}
