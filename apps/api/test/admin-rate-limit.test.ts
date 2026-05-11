// Bundle H §4 — POST/PATCH/DELETE on /admin/sso/providers and /admin/users/*
// run through a per-user `rateLimit({ bucket: 'admin', burst: 30, refill: 0.5 })`.
// We fake the pg pool with an in-memory token bucket that mirrors the real
// SQL's UPSERT semantics so we can drain the bucket and observe the 429.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.LOG_LEVEL = 'fatal'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'b'.repeat(32)
  process.env.R2_ENDPOINT = 'http://localhost:9000'
  process.env.R2_ACCOUNT_ID = 'x'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  process.env.R2_BUCKET = 'x'
  process.env.LITELLM_BASE_URL = 'http://localhost:4000'
  process.env.LITELLM_TOKEN = 'x'
})
afterAll(() => {
  process.env = { ...ORIG_ENV }
})

interface FakeBucket {
  tokens: number
  capacity: number
  refillRate: number
  updatedAt: number
}

const BUCKETS = new Map<string, FakeBucket>()

function rateLimitUpsert(params: unknown[]): { rows: unknown[] } {
  const [key, capacity, refillRate] = params as [string, number, number]
  const cap = Number(capacity)
  const rate = Number(refillRate)
  const now = Date.now()
  const existing = BUCKETS.get(key)
  let nextTokens: number
  if (!existing) {
    nextTokens = cap - 1
  } else {
    const refill = ((now - existing.updatedAt) / 1000) * existing.refillRate
    const refilled = Math.min(cap, existing.tokens + refill)
    nextTokens = refilled - 1
  }
  BUCKETS.set(key, { tokens: nextTokens, capacity: cap, refillRate: rate, updatedAt: now })
  return { rows: [{ allowed: nextTokens >= 0, remaining: nextTokens }] }
}

interface FakeClient {
  query: (text: string, values?: ReadonlyArray<unknown>) => Promise<{ rows: unknown[]; rowCount: number }>
  release: () => void
}

function makeClient(): FakeClient {
  return {
    async query(text, values) {
      const t = String(text).trim()
      if (t.startsWith('INSERT INTO rate_limit_buckets')) {
        const r = rateLimitUpsert((values as unknown[]) ?? [])
        return { rows: r.rows, rowCount: r.rows.length }
      }
      // Pass-through swallow for non-rate-limit statements; handler-level
      // tests aren't checking these so we don't need fidelity here.
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(t) || t.includes('set_config(')) {
        return { rows: [], rowCount: 0 }
      }
      // Provide a dummy row for SELECT/INSERT/UPDATE so handlers don't blow
      // up on missing data — but they generally shouldn't run because the
      // rate-limit middleware will reject before the handler does anything.
      if (/^SELECT/i.test(t)) return { rows: [], rowCount: 0 }
      if (/^INSERT INTO users/i.test(t)) {
        return {
          rows: [
            {
              id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
              email: 'a@example.com',
              role: 'member',
              display_name: null,
              password_hash: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
          rowCount: 1,
        }
      }
      return { rows: [], rowCount: 0 }
    },
    release() {},
  }
}

let fakeClient: FakeClient

vi.mock('pg', () => {
  class Pool {
    connect = vi.fn()
  }
  return { default: { Pool }, Pool }
})

async function buildApp() {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { usersAdmin } = await import('../src/routes/admin/users.js')
  const db = await import('../src/db.js')

  fakeClient = makeClient()
  ;(db.pool as unknown as { connect: () => Promise<FakeClient> }).connect = async () =>
    fakeClient

  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('user', {
      sub: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      role: 'owner',
      jti: 'jti-1',
    })
    c.set('tenant', {
      subscriptionId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
    })
    await next()
  })
  app.route('/admin/users', usersAdmin)
  return app
}

beforeEach(() => {
  BUCKETS.clear()
  vi.resetModules()
})
afterEach(() => {
  vi.clearAllMocks()
})

describe('admin mutator rate limit (Bundle H §4)', () => {
  it('429s on the (burst+1)th invite from the same user', async () => {
    const app = await buildApp()
    // The mutator middleware is `burst: 30`. We don't care about reaching the
    // user-creation logic; any 4xx other than 429 still proves the bucket was
    // consumed because the bucket UPSERT happens before handler body runs.
    const burst = 30
    let denied: Response | null = null
    for (let i = 0; i < burst; i += 1) {
      const res = await app.request('/admin/users/invite', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: `u${i}@example.com`, role: 'member' }),
      })
      // The handler may 400/409/500 (we didn't queue every needed row); the
      // bucket only cares that the middleware ran for each request.
      expect([200, 201, 400, 404, 409, 500]).toContain(res.status)
    }
    denied = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'extra@example.com', role: 'member' }),
    })
    expect(denied.status).toBe(429)
    const body = (await denied.json()) as { error: { code: string } }
    expect(body.error.code).toBe('rate_limited')
    expect(denied.headers.get('Retry-After')).not.toBeNull()
  })

  it('GET /admin/users is not subject to the mutator rate limit', async () => {
    const app = await buildApp()
    // Issue many GETs — the bucket is for mutators only, so all must succeed.
    for (let i = 0; i < 60; i += 1) {
      const res = await app.request('/admin/users')
      expect(res.status).not.toBe(429)
    }
  })
})
