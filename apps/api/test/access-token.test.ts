// Tests for `apps/api/src/middleware/auth.ts` — specifically the public
// `verifyAccessToken` plus the `requireAuth` middleware's claim-extraction
// branches:
//   - bearer header
//   - `?access_token=` query string (SSE-style transport)
//   - missing header & query → Unauthenticated
//   - malformed claim shapes (missing/typed wrong) → Unauthenticated
//   - wrong issuer / audience → Unauthenticated

import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

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

const SECRET = new TextEncoder().encode('a'.repeat(48))
const ISSUER = 'http://localhost:8787'
const AUDIENCE = 'tolaria-spa'

const SUB = '11111111-1111-4111-8111-111111111111'
const SID = '22222222-2222-4222-8222-222222222222'

async function mintToken(
  overrides: Record<string, unknown> = {},
  opts: { issuer?: string; audience?: string; secret?: Uint8Array } = {},
): Promise<string> {
  const base = { sid: SID, role: 'member', ...overrides }
  return new SignJWT(base)
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject((overrides.sub as string | undefined) ?? SUB)
    .setJti((overrides.jti as string | undefined) ?? 'jti-1')
    .setIssuer(opts.issuer ?? ISSUER)
    .setAudience(opts.audience ?? AUDIENCE)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(opts.secret ?? SECRET)
}

async function buildApp() {
  const { requireAuth } = await import('../src/middleware/auth.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', requireAuth)
  app.get('/who', (c) => c.json({ user: c.get('user') }))
  return app
}

describe('verifyAccessToken happy path via requireAuth', () => {
  it('accepts a valid Bearer token and exposes claims on c.set("user")', async () => {
    const app = await buildApp()
    const token = await mintToken()
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      user: { sub: string; sid: string; role: string; jti: string }
    }
    expect(body.user.sub).toBe(SUB)
    expect(body.user.sid).toBe(SID)
    expect(body.user.role).toBe('member')
    expect(body.user.jti).toBe('jti-1')
  })

  it('accepts a token passed as `?access_token=` (SSE transport)', async () => {
    const app = await buildApp()
    const token = await mintToken()
    const res = await app.request(`/who?access_token=${encodeURIComponent(token)}`)
    expect(res.status).toBe(200)
  })

  it('case-insensitively recognises the Bearer scheme', async () => {
    const app = await buildApp()
    const token = await mintToken()
    const res = await app.request('/who', {
      headers: { authorization: `bearer ${token}` },
    })
    expect(res.status).toBe(200)
  })
})

describe('verifyAccessToken malformed-claim branches', () => {
  it('rejects a token whose role is not one of owner/admin/member', async () => {
    const app = await buildApp()
    const token = await mintToken({ role: 'banana' })
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unauthenticated')
  })

  it('rejects a token missing the sid claim', async () => {
    // Override sid with a non-string so the typeof guard fails.
    const app = await buildApp()
    const token = await mintToken({ sid: 123 })
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  it('rejects a token whose sub is not a string', async () => {
    // jose's setSubject requires a string, so smuggle a non-string sub
    // through the payload directly without calling setSubject.
    const app = await buildApp()
    const token = await new SignJWT({ sub: 42, sid: SID, role: 'member' })
      .setProtectedHeader({ alg: 'HS256' })
      .setJti('jti-no-sub')
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(SECRET)
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).toBe(401)
  })

  // The next three cases hit jose's `jwtVerify` failure paths (bad signature,
  // wrong audience, wrong issuer). The middleware does NOT wrap those JOSE
  // errors into HttpError, so they reach the error handler as generic
  // exceptions and become 500. We pin the *negative* contract (the request
  // never succeeds) and flag the wrap-as-401 surface as a TODO so the next
  // pass can plumb a try/catch around `jwtVerify`.
  //
  // TODO: tighten to `toBe(401)` once `verifyAccessToken` wraps JOSE errors
  // as Unauthenticated. Source change is out of scope for this test bundle
  // (W1.4) per the dispatch brief.

  it('rejects a token signed by the wrong secret', async () => {
    const app = await buildApp()
    const wrongSecret = new TextEncoder().encode('z'.repeat(48))
    const token = await mintToken({}, { secret: wrongSecret })
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).not.toBe(200)
    expect([401, 500]).toContain(res.status)
  })

  it('rejects a token issued for the wrong audience', async () => {
    const app = await buildApp()
    const token = await mintToken({}, { audience: 'someone-else' })
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).not.toBe(200)
    expect([401, 500]).toContain(res.status)
  })

  it('rejects a token whose issuer does not match API_PUBLIC_URL', async () => {
    const app = await buildApp()
    const token = await mintToken({}, { issuer: 'https://other-issuer.example' })
    const res = await app.request('/who', {
      headers: { authorization: `Bearer ${token}` },
    })
    expect(res.status).not.toBe(200)
    expect([401, 500]).toContain(res.status)
  })
})

describe('requireAuth no-token branches', () => {
  it('rejects requests with no Authorization header and no access_token query', async () => {
    const app = await buildApp()
    const res = await app.request('/who')
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('unauthenticated')
  })

  it('ignores Authorization headers that are not the Bearer scheme', async () => {
    const app = await buildApp()
    const res = await app.request('/who', {
      headers: { authorization: 'Basic dXNlcjpwYXNz' },
    })
    expect(res.status).toBe(401)
  })
})
