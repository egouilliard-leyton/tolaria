// Behavior tests for rate-limit middleware. The pg pool is mocked so we can
// inspect the parameters of the UPSERT and stub the `tokens >= 0 / tokens`
// return value deterministically. We separately exercise the middleware's
// scope/key derivation to make sure IP- and user-scoped buckets do not
// collide and that the user scope refuses to run without `requireAuth`.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'k'.repeat(32)
  process.env.R2_ENDPOINT = 'http://localhost:9000'
  process.env.R2_ACCOUNT_ID = 'x'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  process.env.R2_BUCKET = 'x'
  process.env.LITELLM_BASE_URL = 'http://localhost:4000'
  process.env.LITELLM_TOKEN = 'x'
  process.env.TRUST_PROXY = '0'
})
afterAll(() => {
  process.env = { ...ORIG_ENV }
})

// ── Mock pg pool ───────────────────────────────────────────────────────────
// We model the table in-memory and keep the SQL semantics close to the real
// thing: a fresh key inserts at `capacity - 1`; an existing key refills at
// `(now - updated_at) * refill_rate` (capped at capacity), then decrements 1.
//
// `now()` reads from `currentTime` so tests can advance the clock with
// `vi.setSystemTime`. Using `vi.useFakeTimers` here lets us avoid real waits.

interface FakeBucket {
  key: string
  tokens: number
  capacity: number
  refillRate: number
  updatedAt: number
}

const STORE: { rows: Map<string, FakeBucket> } = { rows: new Map() }

function fakeQuery(text: string, params: unknown[] = []): { rows: unknown[] } {
  const t = text.trim()
  if (t.startsWith('INSERT INTO rate_limit_buckets')) {
    const [key, capacity, refillRate] = params as [string, number, number]
    const cap = Number(capacity)
    const rate = Number(refillRate)
    const now = Date.now()
    const existing = STORE.rows.get(key)
    let nextTokens: number
    if (!existing) {
      nextTokens = cap - 1
    } else {
      const refill = ((now - existing.updatedAt) / 1000) * existing.refillRate
      const refilled = Math.min(cap, existing.tokens + refill)
      nextTokens = refilled - 1
    }
    STORE.rows.set(key, {
      key,
      tokens: nextTokens,
      capacity: cap,
      refillRate: rate,
      updatedAt: now,
    })
    return {
      rows: [{ allowed: nextTokens >= 0, remaining: nextTokens }],
    }
  }
  throw new Error(`fakeQuery: unrecognized SQL: ${t.slice(0, 80)}`)
}

const FAKE_CLIENT = {
  query: vi.fn((text: string, params?: unknown[]) =>
    Promise.resolve(fakeQuery(text, params)),
  ),
  release: vi.fn(),
}

vi.mock('../src/db.js', () => ({
  pool: { connect: () => Promise.resolve(FAKE_CLIENT) },
  withTenant: async <T,>(_ctx: unknown, fn: (c: typeof FAKE_CLIENT) => Promise<T>): Promise<T> =>
    fn(FAKE_CLIENT),
  withPlatformContext: async <T,>(fn: (c: typeof FAKE_CLIENT) => Promise<T>): Promise<T> =>
    fn(FAKE_CLIENT),
  pingDb: async () => undefined,
}))

beforeEach(() => {
  STORE.rows.clear()
  FAKE_CLIENT.query.mockClear()
  FAKE_CLIENT.release.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

// ── Tiny helper to mount the middleware for IP-scope tests ────────────────
async function buildIpApp(opts?: { user?: { sub: string; sid: string; role: 'owner' } }) {
  const { Hono } = await import('hono')
  const { rateLimit, AUTH_RATE_LIMIT } = await import('../src/middleware/rate-limit.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler)
  if (opts?.user) {
    app.use('*', async (c, next) => {
      c.set('user', { ...opts.user!, jti: 'jti-test' })
      await next()
    })
  }
  app.use(
    '/limited',
    rateLimit({ bucket: 'auth', scope: 'ip', ...AUTH_RATE_LIMIT }),
  )
  app.get('/limited', (c) => c.json({ ok: true }))
  return app
}

async function buildUserApp(opts: { user: { sub: string; sid: string; role: 'owner' } | null }) {
  const { Hono } = await import('hono')
  const { rateLimit, AI_RATE_LIMIT } = await import('../src/middleware/rate-limit.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    if (opts.user) c.set('user', { ...opts.user, jti: 'jti-test' })
    await next()
  })
  app.use(
    '/ai',
    rateLimit({ bucket: 'ai', scope: 'user', ...AI_RATE_LIMIT }),
  )
  app.get('/ai', (c) => c.json({ ok: true }))
  return app
}

// ── Direct token-bucket SQL behavior ──────────────────────────────────────
describe('consumeToken', () => {
  it('allows the first N requests, denies the (N+1)th', async () => {
    const { consumeToken } = await import('../src/middleware/rate-limit.js')
    const N = 3
    for (let i = 0; i < N; i += 1) {
      const r = await consumeToken('test:burst', N, 0.0001)
      expect(r.allowed).toBe(true)
    }
    const denied = await consumeToken('test:burst', N, 0.0001)
    expect(denied.allowed).toBe(false)
  })

  it('refills tokens after enough wall-clock has passed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    const { consumeToken } = await import('../src/middleware/rate-limit.js')
    // Drain the bucket: capacity 2, refill 1/s.
    expect((await consumeToken('test:refill', 2, 1)).allowed).toBe(true)
    expect((await consumeToken('test:refill', 2, 1)).allowed).toBe(true)
    expect((await consumeToken('test:refill', 2, 1)).allowed).toBe(false)
    // Advance 2 seconds → 2 tokens worth of refill, capped at capacity.
    vi.setSystemTime(new Date('2026-01-01T00:00:02Z'))
    const refilled = await consumeToken('test:refill', 2, 1)
    expect(refilled.allowed).toBe(true)
    expect(refilled.remaining).toBeGreaterThanOrEqual(0)
  })
})

// ── Middleware scope/key derivation ───────────────────────────────────────
describe('rateLimit middleware', () => {
  it('serves up to capacity, then 429s with Retry-After + X-RateLimit-Remaining', async () => {
    const app = await buildIpApp()
    // capacity=10 from AUTH_RATE_LIMIT
    let last: Response | null = null
    for (let i = 0; i < 10; i += 1) {
      last = await app.request('/limited')
      expect(last.status).toBe(200)
    }
    const denied = await app.request('/limited')
    expect(denied.status).toBe(429)
    expect(denied.headers.get('Retry-After')).not.toBeNull()
    expect(denied.headers.get('X-RateLimit-Remaining')).toBe('0')
    // The allowed response also exposes the remaining count.
    expect(last?.headers.get('X-RateLimit-Remaining')).not.toBeNull()
  })

  it('IP scope and user scope produce different bucket keys', async () => {
    // Issue an IP-scoped request; the bucket key should start with `auth:ip:`.
    const ipApp = await buildIpApp()
    await ipApp.request('/limited')
    // Issue a user-scoped request; the bucket key should start with `ai:user:`.
    const userApp = await buildUserApp({
      user: { sub: 'user-xyz', sid: 'sub-xyz', role: 'owner' },
    })
    await userApp.request('/ai')
    const keys = Array.from(STORE.rows.keys())
    expect(keys.some((k) => k.startsWith('auth:ip:'))).toBe(true)
    expect(keys.some((k) => k === 'ai:user:user-xyz')).toBe(true)
  })

  it('throws Unauthenticated when scope=user without c.get("user")', async () => {
    const app = await buildUserApp({ user: null })
    const res = await app.request('/ai')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unauthenticated')
  })
})
