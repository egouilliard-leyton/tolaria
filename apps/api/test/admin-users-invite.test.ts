// Contract tests for `POST /admin/users/invite`.
//
// The SPA (`src/lib/admin-api.ts`) reads the invite response as
// `InviteResult { inviteUrl, member }` — that shape is canonical because it
// is what the UI actually reads (see audit-2026-05-10 G03). This test pins
// the wire shape so a future server-side rename can't silently break the
// admin invite flow.
//
// Pattern mirrors `apps/api/test/sso-provider-crud.test.ts`: we mock the
// `pg` pool that `db.ts` consumes so the unit suite never needs a live
// Postgres.

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
      if (
        /^(BEGIN|COMMIT|ROLLBACK)/i.test(text.trim()) ||
        text.includes('set_config(')
      ) {
        return { rows: [], rowCount: 0 }
      }
      // The admin mutator rate-limit middleware (Bundle H §4) UPSERTs a
      // bucket row per request. Always reply with `allowed=true` here so
      // the auxiliary middleware is transparent to behavior tests.
      if (text.trim().startsWith('INSERT INTO rate_limit_buckets')) {
        return { rows: [{ allowed: true, remaining: 999 }], rowCount: 1 }
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

// ── App harness ─────────────────────────────────────────────────────────────

let fakeClient: FakeClient

async function buildApp(role: 'owner' | 'admin' | 'member' = 'owner') {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { usersAdmin } = await import('../src/routes/admin/users.js')
  const db = await import('../src/db.js')

  fakeClient = makeClient()
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
  app.route('/admin/users', usersAdmin)
  return app
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ── Tests ───────────────────────────────────────────────────────────────────

describe('POST /admin/users/invite', () => {
  it('rejects members with 403', async () => {
    const app = await buildApp('member')
    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', role: 'member' }),
    })
    expect(res.status).toBe(403)
  })

  it('rejects bodies missing required fields with 400', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'no-role@example.com' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects duplicate emails with 409', async () => {
    const app = await buildApp('owner')
    // Dup-check SELECT finds an existing row.
    fakeClient.responses.push({
      rows: [{ id: 'ffffffff-ffff-ffff-ffff-ffffffffffff' }],
      rowCount: 1,
    })
    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', role: 'member' }),
    })
    expect(res.status).toBe(409)
  })

  it('returns { inviteUrl, member } and writes an audit row', async () => {
    const app = await buildApp('owner')
    // 1) Dup-check returns nothing.
    fakeClient.responses.push({ rows: [], rowCount: 0 })
    // 2) Insert returns the new user row.
    fakeClient.responses.push({
      rows: [
        {
          id: '11111111-1111-1111-1111-111111111111',
          email: 'new@example.com',
          role: 'member',
          display_name: null,
          password_hash: null,
          created_at: new Date('2026-05-10T00:00:00Z'),
          updated_at: new Date('2026-05-10T00:00:00Z'),
        },
      ],
    })
    // 3) Audit insert.
    fakeClient.responses.push({ rows: [] })

    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', role: 'member' }),
    })
    expect(res.status).toBe(201)

    // G03: the SPA reads this as `InviteResult { inviteUrl, member }`. The
    // server vocabulary `{ user, acceptInviteUrl }` would silently break the
    // admin invite UI (it cannot show the URL or the new member).
    const body = (await res.json()) as Record<string, unknown>
    expect(body).toHaveProperty('inviteUrl')
    expect(body).toHaveProperty('member')
    expect(body).not.toHaveProperty('user')
    expect(body).not.toHaveProperty('acceptInviteUrl')

    expect(typeof body.inviteUrl).toBe('string')
    expect(body.inviteUrl as string).toContain('/invite/accept?token=')

    const member = body.member as Record<string, unknown>
    expect(member.id).toBe('11111111-1111-1111-1111-111111111111')
    expect(member.email).toBe('new@example.com')
    expect(member.role).toBe('member')
    // `displayName` is the camelCase wire field that the SPA reads.
    expect(member).toHaveProperty('displayName')

    // `expiresInSeconds` rides along so the UI can show "valid for N days".
    expect(typeof body.expiresInSeconds).toBe('number')
    expect(body.expiresInSeconds as number).toBeGreaterThan(0)

    // Audit row was written.
    const audits = fakeClient.calls.filter((c) =>
      c.text.includes('INSERT INTO audit_log'),
    )
    expect(audits).toHaveLength(1)
    expect(audits[0]!.values?.[2]).toBe('user.invite')
  })
})
