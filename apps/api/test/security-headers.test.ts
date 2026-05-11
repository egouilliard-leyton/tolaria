// Behavior tests for the security-headers middleware.
//
// We mount the middleware on a tiny Hono app with two routes — `/healthz`
// (exempt) and `/echo` (gets all the headers) — and assert the CSP value is
// derived from configured `R2_ENDPOINT` and `LITELLM_BASE_URL`. We do not
// re-import the production app entry point because that would also pull in
// pg/jose/etc; the middleware is the unit under test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_PROVIDER_SECRET_KEY = 'k'.repeat(32)
  process.env.R2_ENDPOINT = 'https://r2.example.test'
  process.env.R2_ACCOUNT_ID = 'x'
  process.env.R2_ACCESS_KEY_ID = 'x'
  process.env.R2_SECRET_ACCESS_KEY = 'x'
  process.env.R2_BUCKET = 'x'
  process.env.LITELLM_BASE_URL = 'https://litellm.example.test'
  process.env.LITELLM_TOKEN = 'x'
})
afterAll(() => {
  process.env = { ...ORIG_ENV }
})

async function buildApp() {
  const { Hono } = await import('hono')
  const { securityHeaders } = await import('../src/middleware/security-headers.js')
  const app = new Hono()
  app.use('*', securityHeaders)
  app.get('/echo', (c) => c.json({ ok: true }))
  app.get('/healthz', (c) => c.json({ status: 'ok' }))
  app.get('/readyz', (c) => c.json({ status: 'ok' }))
  return app
}

describe('securityHeaders', () => {
  it('sets CSP and the hardening trio on a normal response', async () => {
    const app = await buildApp()
    const res = await app.request('/echo')
    expect(res.status).toBe(200)
    const csp = res.headers.get('Content-Security-Policy') ?? ''
    expect(csp).toContain("default-src 'self'")
    expect(csp).toContain('https://r2.example.test')
    expect(csp).toContain('https://litellm.example.test')
    expect(csp).toContain("frame-ancestors 'none'")
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Referrer-Policy')).toBe('strict-origin-when-cross-origin')
    expect(res.headers.get('X-Frame-Options')).toBe('DENY')
  })

  it('skips CSP on /healthz and /readyz', async () => {
    const app = await buildApp()
    for (const path of ['/healthz', '/readyz']) {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Security-Policy')).toBeNull()
      expect(res.headers.get('X-Frame-Options')).toBeNull()
    }
  })
})
