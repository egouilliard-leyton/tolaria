// Contract test for `GET /me`. The SPA's auth boot calls this immediately
// after refresh; the shape is `{ user, subscription, role }`.
// No Postgres dependency — we mock the `db.tenantQuery` helper that the
// route uses for both reads.

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

// We mock db.ts so the route reads through a queue of canned results without
// touching Postgres.
interface FakeResult {
  rows: unknown[]
  rowCount?: number
}
const responses: FakeResult[] = []

vi.mock('../src/db.js', () => ({
  tenantQuery: vi.fn(async () => {
    const next = responses.shift()
    if (!next) return { rows: [], rowCount: 0 }
    return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length }
  }),
  withTenant: vi.fn(),
  pool: { connect: vi.fn() },
}))

const USER_ID = '11111111-1111-4111-8111-111111111111'
const SUB_ID = '22222222-2222-4222-8222-222222222222'

async function buildApp(opts: { authed: boolean } = { authed: true }) {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { me } = await import('../src/routes/me.js')
  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    if (opts.authed) {
      c.set('user', {
        sub: USER_ID,
        sid: SUB_ID,
        role: 'owner',
        jti: 'test-jti',
      })
      c.set('tenant', { subscriptionId: SUB_ID, userId: USER_ID })
    }
    await next()
  })
  app.route('/', me)
  return app
}

beforeEach(() => {
  responses.length = 0
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('GET /me', () => {
  it('returns 200 with `{ user, subscription, role }` when the user and subscription exist', async () => {
    const app = await buildApp()
    // First read: the user row.
    responses.push({
      rows: [
        {
          id: USER_ID,
          email: 'alice@example.com',
          role: 'owner',
          display_name: 'Alice',
          created_at: new Date('2026-05-01T00:00:00Z'),
        },
      ],
    })
    // Second read: the subscription row.
    responses.push({
      rows: [
        {
          id: SUB_ID,
          name: 'Alice Personal',
          plan: 'pro',
          ai_credits_remaining: '12345',
          created_at: new Date('2026-04-01T00:00:00Z'),
        },
      ],
    })

    const res = await app.request('/me')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { id: string; email: string; role: string; display_name: string | null; created_at: string }
      subscription: { id: string; name: string; plan: string; ai_credits_remaining: number; created_at: string }
      role: string
    }
    expect(body.user.id).toBe(USER_ID)
    expect(body.user.email).toBe('alice@example.com')
    expect(body.user.role).toBe('owner')
    expect(body.user.display_name).toBe('Alice')
    expect(body.user.created_at).toBe('2026-05-01T00:00:00.000Z')
    expect(body.subscription.id).toBe(SUB_ID)
    expect(body.subscription.name).toBe('Alice Personal')
    expect(body.subscription.plan).toBe('pro')
    // bigint string is coerced to a number on the wire.
    expect(body.subscription.ai_credits_remaining).toBe(12345)
    expect(body.role).toBe('owner')
  })

  it('responds 401 when the user record has been deleted', async () => {
    const app = await buildApp()
    // Empty user lookup.
    responses.push({ rows: [] })
    const res = await app.request('/me')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('unauthenticated')
    expect(body.error.message).toMatch(/no longer exists/i)
  })

  it('responds 401 when the subscription has been deleted', async () => {
    const app = await buildApp()
    responses.push({
      rows: [
        {
          id: USER_ID,
          email: 'a@b',
          role: 'member',
          display_name: null,
          created_at: new Date('2026-05-01T00:00:00Z'),
        },
      ],
    })
    // Empty subscription lookup.
    responses.push({ rows: [] })
    const res = await app.request('/me')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unauthenticated')
  })
})
