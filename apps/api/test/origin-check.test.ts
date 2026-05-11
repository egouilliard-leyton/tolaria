// Bundle H §1 — defense-in-depth Origin / Sec-Fetch-Site check on the
// cookie-bearing endpoints. The refresh cookie is httpOnly + SameSite=Lax,
// but a cross-origin attempt to use a captured cookie must still be refused
// at the API boundary. We exercise the two acceptance paths (Origin match,
// Sec-Fetch-Site=same-origin/same-site) plus the rejection path.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'k'.repeat(32)
  process.env.AUTH_REFRESH_COOKIE_NAME = 'tolaria_refresh'
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

// Mock pg so the rate-limit middleware UPSERT always allows the request; we
// only want to exercise the Origin guard.
vi.mock('../src/db.js', () => {
  const fakeClient = {
    query: vi.fn(async (text: string) => {
      if (String(text).trim().startsWith('INSERT INTO rate_limit_buckets')) {
        return { rows: [{ allowed: true, remaining: 999 }] }
      }
      return { rows: [] }
    }),
    release: () => undefined,
  }
  return {
    pool: { connect: () => Promise.resolve(fakeClient) },
    withTenant: async <T,>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) => fn(fakeClient),
    withPlatformContext: async <T,>(fn: (c: typeof fakeClient) => Promise<T>) => fn(fakeClient),
    tenantQuery: async () => ({ rows: [] }),
    pingDb: async () => undefined,
  }
})

beforeEach(() => {
  vi.resetModules()
})

async function loadAuthApp() {
  const { Hono } = await import('hono')
  const { auth } = await import('../src/routes/auth.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler)
  app.route('/', auth)
  return app
}

describe('/auth/refresh + /auth/logout — Origin / Sec-Fetch-Site guard', () => {
  it('rejects /auth/refresh without Origin or Sec-Fetch-Site', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/refresh', { method: 'POST' }),
    )
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/cross_origin_refresh_denied/)
  })

  it('rejects /auth/logout when Origin is foreign and Sec-Fetch-Site is cross-site', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/logout', {
        method: 'POST',
        headers: {
          origin: 'https://evil.example',
          'sec-fetch-site': 'cross-site',
        },
      }),
    )
    expect(res.status).toBe(403)
  })

  it('accepts /auth/logout when Origin matches WEB_PUBLIC_URL (case-insensitive)', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/logout', {
        method: 'POST',
        headers: { origin: 'HTTP://LOCALHOST:5173' },
      }),
    )
    // Even without a cookie, /auth/logout returns 200 (idempotent). We only
    // care that the Origin guard let it pass.
    expect(res.status).toBe(200)
  })

  it('accepts /auth/logout when Sec-Fetch-Site is same-origin', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/logout', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-origin' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('accepts /auth/logout when Sec-Fetch-Site is same-site', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/logout', {
        method: 'POST',
        headers: { 'sec-fetch-site': 'same-site' },
      }),
    )
    expect(res.status).toBe(200)
  })

  it('rejects /auth/refresh when Origin is from a foreign scheme', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/refresh', {
        method: 'POST',
        headers: { origin: 'https://localhost:5173' },
      }),
    )
    expect(res.status).toBe(403)
  })
})
