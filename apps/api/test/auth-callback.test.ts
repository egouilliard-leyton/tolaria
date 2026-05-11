// End-to-end behavioral tests for the auth route — start, callback, refresh,
// logout, and the dev-only password login. Postgres is mocked via a shared
// in-memory store, and the upstream OIDC interaction is mocked by stubbing
// `openid-client`'s grant / discovery functions so the suite never makes a
// real network call. The PKCE cookie cycle is exercised end-to-end through
// Hono so we get the same Set-Cookie / Cookie semantics as production.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_JWT_ACCESS_TTL_SECONDS = '600'
  process.env.AUTH_JWT_REFRESH_TTL_SECONDS = '120'
  process.env.AUTH_PROVIDER_SECRET_KEY = 'k'.repeat(32)
  process.env.AUTH_REFRESH_COOKIE_NAME = 'tolaria_refresh'
  process.env.AUTH_REFRESH_COOKIE_DOMAIN = 'localhost'
  process.env.LOCAL_PASSWORD_AUTH = '1'
  process.env.AUTHENTIK_ISSUER_URL = 'https://idp.example.test/realms/main'
  process.env.AUTHENTIK_CLIENT_ID = 'tolaria-web'
  process.env.AUTHENTIK_CLIENT_SECRET = 'shhhhh'
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

// ── In-memory pg store ──────────────────────────────────────────────────
interface RefreshRow {
  id: string
  user_id: string
  subscription_id: string
  hashed_token: string
  expires_at: Date
  revoked_at: Date | null
}
interface UserRow {
  id: string
  subscription_id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  display_name: string | null
  password_hash: string | null
}
interface SubscriptionRow {
  id: string
  name: string
  plan: string
}
interface AuditRow {
  subscription_id: string
  actor_user_id: string | null
  action: string
  target: string | null
  meta: unknown
}
const STORE: {
  refreshRows: RefreshRow[]
  users: UserRow[]
  subscriptions: SubscriptionRow[]
  audit: AuditRow[]
} = { refreshRows: [], users: [], subscriptions: [], audit: [] }

let _id = 0
function uuid(): string {
  _id += 1
  return `id-${_id.toString().padStart(6, '0')}`
}

function fakeQuery(text: string, params: unknown[] = []): { rows: unknown[] } {
  const t = text.trim()

  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [] }
  if (t.startsWith('SELECT set_config')) return { rows: [] }

  if (t.startsWith('INSERT INTO subscriptions')) {
    const [name] = params as [string]
    const row: SubscriptionRow = { id: uuid(), name, plan: 'free' }
    STORE.subscriptions.push(row)
    return { rows: [{ id: row.id }] }
  }

  if (t.startsWith('INSERT INTO users')) {
    const [subscription_id, email, role, display_name] = params as [
      string, string, 'owner' | 'admin' | 'member', string | null,
    ]
    const row: UserRow = {
      id: uuid(),
      subscription_id,
      email: String(email).toLowerCase(),
      role,
      display_name,
      password_hash: null,
    }
    STORE.users.push(row)
    return { rows: [{ id: row.id }] }
  }

  if (t.startsWith('SELECT id, subscription_id, email::text AS email, role::text AS role, password_hash')) {
    const [email] = params as [string]
    const row = STORE.users.find((u) => u.email === String(email).toLowerCase())
    if (!row) return { rows: [] }
    return {
      rows: [
        {
          id: row.id,
          subscription_id: row.subscription_id,
          email: row.email,
          role: row.role,
          password_hash: row.password_hash,
        },
      ],
    }
  }

  if (t.startsWith('INSERT INTO refresh_tokens')) {
    const [user_id, subscription_id, hashed_token, , , expires_at] = params as [
      string, string, string, string | null, string | null, Date,
    ]
    const row: RefreshRow = {
      id: uuid(),
      user_id,
      subscription_id,
      hashed_token,
      expires_at,
      revoked_at: null,
    }
    STORE.refreshRows.push(row)
    return { rows: [{ id: row.id }] }
  }

  if (
    t.startsWith('SELECT rt.id, rt.user_id, rt.subscription_id, rt.hashed_token,') &&
    t.includes('FROM refresh_tokens rt')
  ) {
    const [id, hashed] = params as [string, string]
    const row = STORE.refreshRows.find((r) => r.id === id && r.hashed_token === hashed)
    if (!row) return { rows: [] }
    const u = STORE.users.find((x) => x.id === row.user_id)
    return {
      rows: [
        {
          id: row.id,
          user_id: row.user_id,
          subscription_id: row.subscription_id,
          hashed_token: row.hashed_token,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          role: u?.role ?? 'member',
        },
      ],
    }
  }

  if (t.startsWith('UPDATE refresh_tokens') && t.includes('RETURNING')) {
    const [id, hashed] = params as [string, string]
    const row = STORE.refreshRows.find(
      (r) =>
        r.id === id &&
        r.hashed_token === hashed &&
        r.revoked_at === null &&
        r.expires_at.getTime() > Date.now(),
    )
    if (!row) return { rows: [] }
    row.revoked_at = new Date()
    const u = STORE.users.find((x) => x.id === row.user_id)
    return {
      rows: [
        {
          id: row.id,
          user_id: row.user_id,
          subscription_id: row.subscription_id,
          hashed_token: row.hashed_token,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          role: u?.role ?? 'member',
        },
      ],
    }
  }

  if (t.startsWith('UPDATE refresh_tokens')) {
    const [id, hashed] = params as [string, string]
    const row = STORE.refreshRows.find(
      (r) => r.id === id && r.hashed_token === hashed && r.revoked_at === null,
    )
    if (row) row.revoked_at = new Date()
    return { rows: [] }
  }

  if (t.startsWith('INSERT INTO audit_log')) {
    const [subscription_id, actor_user_id, action, target, metaJson] = params as [
      string, string | null, string, string | null, string,
    ]
    STORE.audit.push({
      subscription_id,
      actor_user_id,
      action,
      target,
      meta: JSON.parse(metaJson),
    })
    return { rows: [] }
  }

  if (t.startsWith('SELECT id, name, plan')) {
    const [id] = params as [string]
    const row = STORE.subscriptions.find((s) => s.id === id)
    if (!row) return { rows: [] }
    return {
      rows: [
        {
          id: row.id,
          name: row.name,
          plan: row.plan,
          ai_credits_remaining: '0',
          created_at: new Date(),
        },
      ],
    }
  }

  if (t.startsWith('SELECT id, email::text AS email, role::text AS role')) {
    const [id] = params as [string]
    const row = STORE.users.find((u) => u.id === id)
    if (!row) return { rows: [] }
    return {
      rows: [
        {
          id: row.id,
          email: row.email,
          role: row.role,
          display_name: row.display_name,
          created_at: new Date(),
        },
      ],
    }
  }

  if (t.startsWith('SELECT id, subscription_id, name, issuer_url')) {
    // No platform-default row — force the env-only fallback path.
    return { rows: [] }
  }

  // The rate-limit middleware UPSERTs a row per request. Always allow with
  // a high `remaining` so the auth-flow tests are insulated from the bucket
  // semantics (those have their own dedicated suite in test/rate-limit.test.ts).
  if (t.startsWith('INSERT INTO rate_limit_buckets')) {
    return { rows: [{ allowed: true, remaining: 999 }] }
  }

  throw new Error(`fakeQuery: unrecognized SQL: ${t.slice(0, 100)}`)
}

vi.mock('../src/db.js', () => {
  const fakeClient = {
    query: vi.fn((text: string, params?: unknown[]) =>
      Promise.resolve(fakeQuery(text, params)),
    ),
    release: () => undefined,
  }
  return {
    pool: { connect: () => Promise.resolve(fakeClient) },
    withTenant: async <T,>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) => fn(fakeClient),
    withPlatformContext: async <T,>(fn: (c: typeof fakeClient) => Promise<T>) => fn(fakeClient),
    tenantQuery: async (_ctx: unknown, text: string, params?: unknown[]) =>
      Promise.resolve(fakeQuery(text, params)),
    pingDb: async () => undefined,
  }
})

// ── openid-client stub ─────────────────────────────────────────────────
// The auth callback path relies on:
//   discovery, randomPKCECodeVerifier, calculatePKCECodeChallenge,
//   randomState, randomNonce, buildAuthorizationUrl, authorizationCodeGrant.
// We stub each so tests are deterministic.

let lastAuthorizeParams: Record<string, string> | URLSearchParams | null = null
let stubbedClaims: Record<string, unknown> = {
  sub: 'idp-sub-abc',
  email: 'alice@example.test',
  email_verified: true,
  name: 'Alice Example',
}

vi.mock('openid-client', () => ({
  discovery: vi.fn(async () => ({ __fake: true })),
  randomPKCECodeVerifier: vi.fn(() => 'verifier-fixed'),
  calculatePKCECodeChallenge: vi.fn(async () => 'challenge-fixed'),
  randomState: vi.fn(() => 'state-fixed'),
  randomNonce: vi.fn(() => 'nonce-fixed'),
  buildAuthorizationUrl: vi.fn((_config: unknown, params: Record<string, string>) => {
    lastAuthorizeParams = params
    const u = new URL('https://idp.example.test/realms/main/authorize')
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    return u
  }),
  authorizationCodeGrant: vi.fn(async () => ({
    access_token: 'fake-access',
    token_type: 'bearer',
    id_token: 'fake-id-token',
    claims: () => stubbedClaims,
    expiresIn: () => 3600,
  })),
}))

// Reset state per test.
beforeEach(() => {
  STORE.refreshRows.length = 0
  STORE.users.length = 0
  STORE.subscriptions.length = 0
  STORE.audit.length = 0
  _id = 0
  lastAuthorizeParams = null
  stubbedClaims = {
    sub: 'idp-sub-abc',
    email: 'alice@example.test',
    email_verified: true,
    name: 'Alice Example',
  }
})

// ── helpers ────────────────────────────────────────────────────────────

async function loadAuthApp() {
  const { Hono } = await import('hono')
  const { auth } = await import('../src/routes/auth.js')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  // The production wiring mounts `auth` inside an app whose `onError` is the
  // shared HttpError → JSON converter. Replicate that here so HttpErrors
  // surface as the right status codes instead of bubbling to a 500.
  const app = new Hono()
  app.onError(errorHandler)
  app.route('/', auth)
  return app
}

function parseSetCookies(headers: Headers): Map<string, { value: string; flags: string[] }> {
  const out = new Map<string, { value: string; flags: string[] }>()
  // Web Headers folds multiple Set-Cookie into one with comma separators,
  // but Hono's getSetCookie() and the Headers spec preserve them via the
  // raw headers list. We use getSetCookie if present, fall back to splitting.
  const raw = (headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? []
  const cookies = raw.length > 0 ? raw : (headers.get('set-cookie')?.split(/, (?=[A-Za-z0-9_-]+=)/) ?? [])
  for (const c of cookies) {
    const [pair, ...flagParts] = c.split(';').map((s) => s.trim())
    const eq = pair?.indexOf('=') ?? -1
    if (!pair || eq < 0) continue
    const name = pair.slice(0, eq)
    const value = pair.slice(eq + 1)
    out.set(name, { value, flags: flagParts })
  }
  return out
}

describe('GET /auth/oidc/default/start', () => {
  it('redirects to the IdP with a PKCE S256 challenge and stores a signed cookie', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(new Request('http://localhost:8787/auth/oidc/default/start'))
    expect(res.status).toBe(302)
    const loc = res.headers.get('location') ?? ''
    expect(loc).toContain('https://idp.example.test/')
    expect(loc).toContain('code_challenge_method=S256')
    expect(loc).toContain('response_type=code')
    expect(loc).toContain('state=state-fixed')
    const setCookies = parseSetCookies(res.headers)
    const pkce = setCookies.get('tolaria_pkce')
    expect(pkce).toBeDefined()
    expect(pkce?.flags.some((f) => /HttpOnly/i.test(f))).toBe(true)
    expect(pkce?.flags.some((f) => /SameSite=Lax/i.test(f))).toBe(true)
    // The PKCE verifier must NEVER appear plaintext anywhere in the response.
    const body = await res.text().catch(() => '')
    expect(loc).not.toContain('verifier-fixed')
    expect(body).not.toContain('verifier-fixed')
  })

  it('rejects when no platform-default provider is configured', async () => {
    const origIssuer = process.env.AUTHENTIK_ISSUER_URL
    delete process.env.AUTHENTIK_ISSUER_URL
    vi.resetModules()
    try {
      const app = await loadAuthApp()
      const res = await app.fetch(new Request('http://localhost:8787/auth/oidc/default/start'))
      expect(res.status).toBe(400)
    } finally {
      process.env.AUTHENTIK_ISSUER_URL = origIssuer
      vi.resetModules()
    }
  })
})

describe('GET /auth/oidc/default/callback', () => {
  it('exchanges code, JIT-provisions a user, sets a refresh cookie, and redirects to the SPA', async () => {
    const app = await loadAuthApp()
    // 1. start to obtain the signed PKCE cookie.
    const startRes = await app.fetch(
      new Request('http://localhost:8787/auth/oidc/default/start'),
    )
    const setCookies = parseSetCookies(startRes.headers)
    const pkceCookie = setCookies.get('tolaria_pkce')
    expect(pkceCookie).toBeDefined()

    // 2. callback with the same cookie + the IdP-supplied code/state.
    const cbRes = await app.fetch(
      new Request(
        'http://localhost:8787/auth/oidc/default/callback?code=fake-code&state=state-fixed',
        {
          headers: { cookie: `tolaria_pkce=${pkceCookie?.value}` },
        },
      ),
    )
    expect(cbRes.status).toBe(302)
    const loc = cbRes.headers.get('location') ?? ''
    expect(loc.startsWith('http://localhost:5173/auth/complete')).toBe(true)
    expect(loc).toContain('access_token=')
    // A user row was provisioned.
    expect(STORE.users).toHaveLength(1)
    expect(STORE.users[0]?.email).toBe('alice@example.test')
    // A subscription was created (env-only mode bootstraps a personal one).
    expect(STORE.subscriptions).toHaveLength(1)
    // A refresh token was issued.
    expect(STORE.refreshRows).toHaveLength(1)
    // A login.success audit event was written.
    expect(STORE.audit.some((a) => a.action === 'auth.login.success')).toBe(true)
    // The refresh cookie is HttpOnly + scoped to /auth.
    const cbCookies = parseSetCookies(cbRes.headers)
    const refresh = cbCookies.get('tolaria_refresh')
    expect(refresh).toBeDefined()
    expect(refresh?.flags.some((f) => /HttpOnly/i.test(f))).toBe(true)
    expect(refresh?.flags.some((f) => /Path=\/auth/i.test(f))).toBe(true)
  })

  it('rejects when the PKCE cookie is missing', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request(
        'http://localhost:8787/auth/oidc/default/callback?code=fake-code&state=state-fixed',
      ),
    )
    expect(res.status).toBe(401)
  })

  it('refuses JIT provisioning when email_verified is false', async () => {
    stubbedClaims = {
      sub: 'idp-sub-xyz',
      email: 'mallory@example.test',
      email_verified: false,
    }
    const app = await loadAuthApp()
    const startRes = await app.fetch(
      new Request('http://localhost:8787/auth/oidc/default/start'),
    )
    const pkceCookie = parseSetCookies(startRes.headers).get('tolaria_pkce')
    const cbRes = await app.fetch(
      new Request(
        'http://localhost:8787/auth/oidc/default/callback?code=fake-code&state=state-fixed',
        {
          headers: { cookie: `tolaria_pkce=${pkceCookie?.value}` },
        },
      ),
    )
    expect(cbRes.status).toBe(403)
  })
})

describe('POST /auth/refresh', () => {
  it('rotates the refresh cookie and returns a new access token', async () => {
    const app = await loadAuthApp()
    // First, run a full callback to obtain a refresh cookie.
    const startRes = await app.fetch(
      new Request('http://localhost:8787/auth/oidc/default/start'),
    )
    const pkceCookie = parseSetCookies(startRes.headers).get('tolaria_pkce')
    const cbRes = await app.fetch(
      new Request(
        'http://localhost:8787/auth/oidc/default/callback?code=fake-code&state=state-fixed',
        {
          headers: { cookie: `tolaria_pkce=${pkceCookie?.value}` },
        },
      ),
    )
    const refresh = parseSetCookies(cbRes.headers).get('tolaria_refresh')
    expect(refresh).toBeDefined()
    const refRes = await app.fetch(
      new Request('http://localhost:8787/auth/refresh', {
        method: 'POST',
        headers: {
          cookie: `tolaria_refresh=${refresh?.value}`,
          origin: 'http://localhost:5173',
        },
      }),
    )
    expect(refRes.status).toBe(200)
    const body = (await refRes.json()) as { access_token: string }
    expect(typeof body.access_token).toBe('string')
    expect(body.access_token.length).toBeGreaterThan(20)
    // The previous refresh row is now revoked.
    expect(STORE.refreshRows.filter((r) => r.revoked_at !== null)).toHaveLength(1)
    // A new row was issued.
    expect(STORE.refreshRows).toHaveLength(2)
    // An auth.refresh audit row was written.
    expect(STORE.audit.some((a) => a.action === 'auth.refresh')).toBe(true)
  })

  it('rejects when no refresh cookie is present', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/refresh', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      }),
    )
    expect(res.status).toBe(401)
  })
})

describe('POST /auth/logout', () => {
  it('revokes the refresh row and clears the cookie', async () => {
    const app = await loadAuthApp()
    const startRes = await app.fetch(
      new Request('http://localhost:8787/auth/oidc/default/start'),
    )
    const pkceCookie = parseSetCookies(startRes.headers).get('tolaria_pkce')
    const cbRes = await app.fetch(
      new Request(
        'http://localhost:8787/auth/oidc/default/callback?code=fake-code&state=state-fixed',
        {
          headers: { cookie: `tolaria_pkce=${pkceCookie?.value}` },
        },
      ),
    )
    const refresh = parseSetCookies(cbRes.headers).get('tolaria_refresh')
    const out = await app.fetch(
      new Request('http://localhost:8787/auth/logout', {
        method: 'POST',
        headers: {
          cookie: `tolaria_refresh=${refresh?.value}`,
          origin: 'http://localhost:5173',
        },
      }),
    )
    expect(out.status).toBe(200)
    // Row is revoked.
    expect(STORE.refreshRows[0]?.revoked_at).toBeInstanceOf(Date)
    // A Set-Cookie wipes the cookie.
    const cleared = parseSetCookies(out.headers).get('tolaria_refresh')
    expect(cleared?.value).toBe('')
  })

  it('returns 200 even with no cookie (idempotent)', async () => {
    const app = await loadAuthApp()
    const out = await app.fetch(
      new Request('http://localhost:8787/auth/logout', {
        method: 'POST',
        headers: { origin: 'http://localhost:5173' },
      }),
    )
    expect(out.status).toBe(200)
  })
})

describe('POST /auth/login (LOCAL_PASSWORD_AUTH=1)', () => {
  it('returns 401 for an unknown email without leaking which field is wrong', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'nobody@example.test', password: 'whatever' }),
      }),
    )
    expect(res.status).toBe(401)
    const body = (await res.json()) as { error?: { message?: string } }
    // Generic message — does not point at which of email/password is wrong.
    expect(body.error?.message ?? '').toMatch(/invalid email or password/i)
  })

  it('returns 400 when the body is missing fields', async () => {
    const app = await loadAuthApp()
    const res = await app.fetch(
      new Request('http://localhost:8787/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'bob@example.test' }),
      }),
    )
    expect(res.status).toBe(400)
  })

  it('rejects in production regardless of LOCAL_PASSWORD_AUTH', async () => {
    process.env.NODE_ENV = 'production'
    vi.resetModules()
    try {
      const app = await loadAuthApp()
      const res = await app.fetch(
        new Request('http://localhost:8787/auth/login', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'a@b', password: 'c' }),
        }),
      )
      expect(res.status).toBe(403)
    } finally {
      process.env.NODE_ENV = 'test'
      vi.resetModules()
    }
  })
})
