// Behavioral tests for the SSO admin sub-app. Postgres is not available in
// the unit suite, so we mock the `pg` pool that `db.ts` consumes and the
// discovery fetcher that the route calls before insert. These tests verify:
//   - role gating (owner-only)
//   - input validation (missing/invalid fields)
//   - response shape (clientSecretSet is a boolean, never the bytes)
//   - audit log writes happen on every mutation
//   - the create path encrypts the supplied client secret

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

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

// ── pg mock ─────────────────────────────────────────────────────────────────
//
// We intercept `pool.connect()` and return an object that records every
// query and replies with a configurable set of fixtures. Each test sets
// `client.responses` ahead of calling the route.

interface QueryCall {
  text: string
  values?: ReadonlyArray<unknown>
}

interface FakeClient {
  calls: QueryCall[]
  responses: Array<{ rows: unknown[]; rowCount?: number }>
  query: (text: string, values?: ReadonlyArray<unknown>) => Promise<{ rows: unknown[]; rowCount: number }>
  release: () => void
}

function makeClient(): FakeClient {
  const calls: QueryCall[] = []
  const responses: Array<{ rows: unknown[]; rowCount?: number }> = []
  return {
    calls,
    responses,
    async query(text: string, values?: ReadonlyArray<unknown>) {
      calls.push({ text, values })
      // The route uses BEGIN/COMMIT/ROLLBACK and `SELECT set_config(...)`
      // bookends. Return an empty result for those control statements.
      if (
        /^(BEGIN|COMMIT|ROLLBACK)/i.test(text.trim()) ||
        text.includes('set_config(')
      ) {
        return { rows: [], rowCount: 0 }
      }
      const next = responses.shift()
      if (!next) return { rows: [], rowCount: 0 }
      return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length }
    },
    release() {},
  }
}

vi.mock('pg', () => {
  const Pool = class {
    connect = vi.fn()
  }
  return {
    default: { Pool },
    Pool,
  }
})

vi.mock('../src/lib/discovery-fetcher.js', () => ({
  fetchDiscoveryDocument: vi.fn(async (issuerUrl: string) => ({
    issuer: issuerUrl,
    authorization_endpoint: `${issuerUrl}/auth`,
    token_endpoint: `${issuerUrl}/token`,
    jwks_uri: `${issuerUrl}/jwks`,
  })),
}))

// ── App harness ─────────────────────────────────────────────────────────────

let fakeClient: FakeClient

async function buildApp(role: 'owner' | 'admin' | 'member' = 'owner') {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { ssoAdmin } = await import('../src/routes/admin/sso.js')
  const db = await import('../src/db.js')

  fakeClient = makeClient()
  // Re-point the pool's `connect` at our fake.
  // db.pool is a fresh pg.Pool instance from the mocked module above.
  ;(db.pool as unknown as { connect: () => Promise<FakeClient> }).connect = async () => fakeClient

  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('user', {
      sub: '00000000-0000-0000-0000-000000000001',
      sid: '00000000-0000-0000-0000-000000000002',
      role,
      jti: 'test-jti',
    })
    c.set('tenant', {
      subscriptionId: '00000000-0000-0000-0000-000000000002',
      userId: '00000000-0000-0000-0000-000000000001',
    })
    await next()
  })
  app.route('/admin/sso', ssoAdmin)
  return app
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('GET /admin/sso/providers', () => {
  it('rejects non-owners with 403', async () => {
    const app = await buildApp('admin')
    const res = await app.request('/admin/sso/providers')
    expect(res.status).toBe(403)
  })

  it('returns providers with clientSecretSet boolean and never the bytes', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({
      rows: [
        {
          id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
          subscription_id: '00000000-0000-0000-0000-000000000002',
          name: 'Acme Okta',
          protocol: 'oidc',
          issuer_url: 'https://acme.okta.com',
          client_id: 'client-123',
          client_secret_enc: Buffer.from([1, 2, 3, 4]),
          scopes: ['openid', 'profile', 'email'],
          default_role: 'member',
          jit_provisioning: true,
          created_at: new Date('2026-05-01T00:00:00Z'),
        },
      ],
    })
    const res = await app.request('/admin/sso/providers')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      providers: Array<Record<string, unknown>>
    }
    expect(body.providers).toHaveLength(1)
    const p = body.providers[0]!
    expect(p.clientSecretSet).toBe(true)
    expect(JSON.stringify(p)).not.toContain('client_secret_enc')
    expect(p).not.toHaveProperty('clientSecret')
  })
})

describe('POST /admin/sso/providers', () => {
  it('rejects bodies missing required fields with 400', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/sso/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'No issuer' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects non-URL issuer with 400', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/sso/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad',
        issuerUrl: 'not-a-url',
        clientId: 'a',
        clientSecret: 'b',
      }),
    })
    expect(res.status).toBe(400)
  })

  it('inserts an encrypted secret and writes an audit row', async () => {
    const app = await buildApp('owner')
    // Insert response, then audit insert response.
    fakeClient.responses.push({
      rows: [
        {
          id: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
          subscription_id: '00000000-0000-0000-0000-000000000002',
          name: 'Acme Entra',
          protocol: 'oidc',
          issuer_url: 'https://login.microsoftonline.com/acme',
          client_id: 'client-xyz',
          client_secret_enc: Buffer.from([9, 9, 9]),
          scopes: ['openid', 'profile', 'email'],
          default_role: 'member',
          jit_provisioning: false,
          created_at: new Date('2026-05-09T00:00:00Z'),
        },
      ],
    })
    fakeClient.responses.push({ rows: [] }) // audit insert

    const res = await app.request('/admin/sso/providers', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'Acme Entra',
        issuerUrl: 'https://login.microsoftonline.com/acme',
        clientId: 'client-xyz',
        clientSecret: 'super-secret',
      }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as { provider: { clientSecretSet: boolean } }
    expect(body.provider.clientSecretSet).toBe(true)

    // The body of the request must never round-trip into the response.
    const text = JSON.stringify(body)
    expect(text).not.toContain('super-secret')

    // The first non-control SQL is the INSERT, with an encrypted Buffer in
    // position 5 (1-based: subscription, name, issuer, clientId, secret_enc).
    const inserts = fakeClient.calls.filter((c) =>
      c.text.includes('INSERT INTO sso_providers'),
    )
    expect(inserts).toHaveLength(1)
    const secretArg = inserts[0]!.values?.[4]
    expect(Buffer.isBuffer(secretArg)).toBe(true)
    // Plaintext must not appear in the encrypted bytes.
    expect((secretArg as Buffer).toString('utf8')).not.toContain('super-secret')

    // Audit row written.
    const audits = fakeClient.calls.filter((c) => c.text.includes('INSERT INTO audit_log'))
    expect(audits).toHaveLength(1)
    expect(audits[0]!.values?.[2]).toBe('sso_provider.create')
  })
})

describe('PATCH /admin/sso/providers/:id', () => {
  it('returns 400 on a bad UUID', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/sso/providers/not-a-uuid', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when no row matches', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({ rows: [], rowCount: 0 }) // UPDATE returning nothing
    const res = await app.request(
      '/admin/sso/providers/cccccccc-cccc-cccc-cccc-cccccccccccc',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'New name' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('writes audit metadata noting whether the secret rotated', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({
      rows: [
        {
          id: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
          subscription_id: '00000000-0000-0000-0000-000000000002',
          name: 'Updated',
          protocol: 'oidc',
          issuer_url: 'https://issuer.example',
          client_id: 'cid',
          client_secret_enc: Buffer.from([1]),
          scopes: ['openid'],
          default_role: 'member',
          jit_provisioning: false,
          created_at: new Date('2026-05-09T00:00:00Z'),
        },
      ],
    })
    fakeClient.responses.push({ rows: [] }) // audit
    const res = await app.request(
      '/admin/sso/providers/dddddddd-dddd-dddd-dddd-dddddddddddd',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Updated' }),
      },
    )
    expect(res.status).toBe(200)
    const audit = fakeClient.calls.find((c) => c.text.includes('INSERT INTO audit_log'))
    expect(audit?.values?.[2]).toBe('sso_provider.update')
    const meta = audit?.values?.[4] as Record<string, unknown>
    expect(meta.clientSecretRotated).toBe(false)
  })
})

describe('DELETE /admin/sso/providers/:id', () => {
  it('returns 404 when nothing was deleted', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({ rows: [], rowCount: 0 })
    const res = await app.request(
      '/admin/sso/providers/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(404)
  })

  it('writes a sso_provider.delete audit row on success', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({
      rows: [{ id: 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', name: 'Old', issuer_url: 'https://x' }],
    })
    fakeClient.responses.push({ rows: [] })
    const res = await app.request(
      '/admin/sso/providers/eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(200)
    const audit = fakeClient.calls.find((c) => c.text.includes('INSERT INTO audit_log'))
    expect(audit?.values?.[2]).toBe('sso_provider.delete')
  })
})
