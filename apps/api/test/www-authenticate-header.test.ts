// Bundle H §5 — 401 responses must carry `WWW-Authenticate: Bearer realm="tolaria"`
// per RFC 7235 §4.1. The header is set by the shared error handler whenever
// it serializes an Unauthenticated HttpError.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.LOG_LEVEL = 'fatal'
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
})
afterAll(() => {
  process.env = { ...ORIG_ENV }
})

beforeEach(() => {
  vi.resetModules()
})

describe('errorHandler WWW-Authenticate (Bundle H §5)', () => {
  it('sets WWW-Authenticate: Bearer realm="tolaria" on a 401 response', async () => {
    const { Hono } = await import('hono')
    const { errorHandler } = await import('../src/middleware/error-handler.js')
    const { Unauthenticated } = await import('../src/lib/errors.js')
    const app = new Hono()
    app.onError(errorHandler)
    app.get('/needs-auth', () => {
      throw Unauthenticated()
    })
    const res = await app.request('/needs-auth')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="tolaria"')
  })

  it('does NOT add WWW-Authenticate on a 403 response', async () => {
    const { Hono } = await import('hono')
    const { errorHandler } = await import('../src/middleware/error-handler.js')
    const { Forbidden } = await import('../src/lib/errors.js')
    const app = new Hono()
    app.onError(errorHandler)
    app.get('/forbidden', () => {
      throw Forbidden()
    })
    const res = await app.request('/forbidden')
    expect(res.status).toBe(403)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('does NOT add WWW-Authenticate on a 400 response', async () => {
    const { Hono } = await import('hono')
    const { errorHandler } = await import('../src/middleware/error-handler.js')
    const { InvalidInput } = await import('../src/lib/errors.js')
    const app = new Hono()
    app.onError(errorHandler)
    app.get('/bad', () => {
      throw InvalidInput()
    })
    const res = await app.request('/bad')
    expect(res.status).toBe(400)
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('the integration path through requireAuth surfaces the header', async () => {
    const { Hono } = await import('hono')
    const { errorHandler } = await import('../src/middleware/error-handler.js')
    const { requireAuth } = await import('../src/middleware/auth.js')
    const app = new Hono()
    app.onError(errorHandler)
    app.use('*', requireAuth)
    app.get('/protected', (c) => c.json({ ok: true }))
    const res = await app.request('/protected')
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe('Bearer realm="tolaria"')
  })
})
