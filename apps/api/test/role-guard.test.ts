// Behavioral tests for `requireRole`. We mount a tiny Hono app with a mock
// `requireAuth` that injects a fixed claim, then exercise the gate with each
// role.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ORIG_ENV = { ...process.env }
beforeAll(() => {
  process.env.NODE_ENV = 'test'
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

type Role = 'owner' | 'admin' | 'member'

async function buildApp(role: Role | null, allowed: Role[]) {
  const { Hono } = await import('hono')
  const { requireRole } = await import('../src/middleware/require-role.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    if (role) {
      c.set('user', {
        sub: '00000000-0000-0000-0000-000000000001',
        sid: '00000000-0000-0000-0000-000000000002',
        role,
        jti: 'test-jti',
      })
    }
    await next()
  })
  app.use('/guarded', requireRole(...allowed))
  app.get('/guarded', (c) => c.json({ ok: true }))
  return app
}

describe('requireRole', () => {
  it('allows requests whose role is in the allowed set', async () => {
    const app = await buildApp('owner', ['owner'])
    const res = await app.request('/guarded')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(true)
  })

  it('allows requests when any of multiple allowed roles match', async () => {
    const app = await buildApp('admin', ['owner', 'admin'])
    const res = await app.request('/guarded')
    expect(res.status).toBe(200)
  })

  it('rejects requests whose role is not in the allowed set with 403', async () => {
    const app = await buildApp('member', ['owner', 'admin'])
    const res = await app.request('/guarded')
    expect(res.status).toBe(403)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('forbidden')
  })

  it('rejects requests with no user context with 403', async () => {
    const app = await buildApp(null, ['owner'])
    const res = await app.request('/guarded')
    expect(res.status).toBe(403)
  })

  it('refuses to construct an empty role set', async () => {
    const { requireRole } = await import('../src/middleware/require-role.js')
    expect(() => requireRole(...([] as Role[]))).toThrow()
  })

  it('owner-only gate rejects admin', async () => {
    const app = await buildApp('admin', ['owner'])
    const res = await app.request('/guarded')
    expect(res.status).toBe(403)
  })
})
