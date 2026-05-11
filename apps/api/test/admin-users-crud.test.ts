// Contract test for /admin/users — list, invite, role change, revoke.
//
// No Postgres dependency. We intercept `pool.connect()` and respond with a
// queue of canned results so the route walks the same code paths it
// would against a real database. The fake client also records every
// query so we can assert audit rows landed inside the transaction.

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

interface QueryCall { text: string; values?: ReadonlyArray<unknown> }
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
    async query(text, values) {
      calls.push({ text, values })
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text.trim()) || text.includes('set_config(')) {
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
  class Pool {
    connect = vi.fn()
  }
  return { default: { Pool }, Pool }
})

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
      sub: '11111111-1111-4111-8111-111111111111',
      sid: '22222222-2222-4222-8222-222222222222',
      role,
      jti: 'jti-1',
    })
    c.set('tenant', {
      subscriptionId: '22222222-2222-4222-8222-222222222222',
      userId: '11111111-1111-4111-8111-111111111111',
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

function userRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    email: 'a@example.com',
    role: 'member',
    display_name: null,
    password_hash: null,
    created_at: new Date('2026-05-01T00:00:00Z'),
    updated_at: new Date('2026-05-01T00:00:00Z'),
    ...over,
  }
}

// ── List ────────────────────────────────────────────────────────────────────

describe('GET /admin/users', () => {
  it('rejects non-owner/non-admin with 403', async () => {
    const app = await buildApp('member')
    const res = await app.request('/admin/users')
    expect(res.status).toBe(403)
  })

  it('returns a bare array with response-shaped rows', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({
      rows: [
        userRow({ email: 'one@example.com' }),
        userRow({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', email: 'two@example.com', role: 'owner' }),
      ],
    })
    const res = await app.request('/admin/users')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    expect(body[0]!.email).toBe('one@example.com')
    // Response shape: camelCase + status field, no password_hash leak.
    expect(body[0]).toHaveProperty('displayName')
    expect(body[0]).toHaveProperty('createdAt')
    expect(body[0]).toHaveProperty('updatedAt')
    expect(body[0]).toHaveProperty('status')
    expect(JSON.stringify(body)).not.toContain('password_hash')
  })
})

// ── Invite ──────────────────────────────────────────────────────────────────

describe('POST /admin/users/invite', () => {
  it('rejects an invalid email', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', role: 'member' }),
    })
    expect(res.status).toBe(400)
  })

  it('rejects role=owner (owners are promoted, not invited)', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', role: 'owner' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 409 when an email already exists in the subscription', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({ rows: [{ id: 'existing' }] })
    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'dup@example.com', role: 'member' }),
    })
    expect(res.status).toBe(409)
  })

  it('inserts, writes audit, and returns 201 with `inviteUrl`, `member`, `expiresInSeconds`', async () => {
    const app = await buildApp('owner')
    // 1) existence check returns no rows
    fakeClient.responses.push({ rows: [] })
    // 2) INSERT returning the new user row
    fakeClient.responses.push({
      rows: [
        userRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', email: 'new@example.com', role: 'admin' }),
      ],
    })
    // 3) audit insert
    fakeClient.responses.push({ rows: [] })

    const res = await app.request('/admin/users/invite', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'new@example.com', role: 'admin' }),
    })
    expect(res.status).toBe(201)
    // Per Bundle A (gap G03): SPA reads `{ inviteUrl, member, expiresInSeconds }`.
    const body = (await res.json()) as {
      member: { id: string; email: string; role: string }
      inviteUrl: string
      expiresInSeconds: number
    }
    expect(body.member.email).toBe('new@example.com')
    expect(body.member.role).toBe('admin')
    expect(body.inviteUrl).toMatch(/\/invite\/accept\?token=/)
    expect(body.expiresInSeconds).toBe(60 * 60 * 24 * 7)

    const audit = fakeClient.calls.find((c) => c.text.includes('INSERT INTO audit_log'))
    expect(audit?.values?.[2]).toBe('user.invite')
    expect(audit?.values?.[3]).toBe('cccccccc-cccc-4ccc-8ccc-cccccccccccc')
  })
})

// ── Patch ───────────────────────────────────────────────────────────────────

describe('PATCH /admin/users/:id', () => {
  it('returns 400 for a non-UUID id', async () => {
    const app = await buildApp('owner')
    const res = await app.request('/admin/users/not-uuid', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'admin' }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the user is not in this subscription', async () => {
    const app = await buildApp('owner')
    // Lookup returns nothing.
    fakeClient.responses.push({ rows: [] })
    const res = await app.request(
      '/admin/users/dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    )
    expect(res.status).toBe(404)
  })

  it('refuses to demote the sole owner', async () => {
    const app = await buildApp('owner')
    // Lookup current user as owner.
    fakeClient.responses.push({
      rows: [userRow({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', role: 'owner' })],
    })
    // Owner count returns 1.
    fakeClient.responses.push({ rows: [{ count: '1' }] })
    const res = await app.request(
      '/admin/users/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'member' }),
      },
    )
    expect(res.status).toBe(409)
  })

  it('writes a user.role_change audit on success', async () => {
    const app = await buildApp('owner')
    // 1) Lookup current row.
    fakeClient.responses.push({
      rows: [userRow({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: 'member' })],
    })
    // 2) UPDATE returning new row.
    fakeClient.responses.push({
      rows: [userRow({ id: 'ffffffff-ffff-4fff-8fff-ffffffffffff', role: 'admin' })],
    })
    // 3) audit insert
    fakeClient.responses.push({ rows: [] })

    const res = await app.request(
      '/admin/users/ffffffff-ffff-4fff-8fff-ffffffffffff',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ role: 'admin' }),
      },
    )
    expect(res.status).toBe(200)
    const audit = fakeClient.calls.find((c) => c.text.includes('INSERT INTO audit_log'))
    expect(audit?.values?.[2]).toBe('user.role_change')
  })
})

// ── Delete (soft-revoke) ────────────────────────────────────────────────────

describe('DELETE /admin/users/:id', () => {
  it('returns 404 when the user is not in this subscription', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({ rows: [] })
    const res = await app.request(
      '/admin/users/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(404)
  })

  it('refuses to revoke the sole owner', async () => {
    const app = await buildApp('owner')
    fakeClient.responses.push({
      rows: [userRow({ id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', role: 'owner' })],
    })
    fakeClient.responses.push({ rows: [{ count: '1' }] })
    const res = await app.request(
      '/admin/users/eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
      { method: 'DELETE' },
    )
    expect(res.status).toBe(409)
  })

  it('clears tokens, drops memberships, demotes the user, audits, and returns 204', async () => {
    const app = await buildApp('owner')
    const target = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
    // 1) lookup user as member (so the owner count branch is skipped).
    fakeClient.responses.push({ rows: [userRow({ id: target, role: 'member' })] })
    // 2) UPDATE refresh_tokens
    fakeClient.responses.push({ rows: [] })
    // 3) DELETE vault_members
    fakeClient.responses.push({ rows: [] })
    // 4) UPDATE users RETURNING new row
    fakeClient.responses.push({ rows: [userRow({ id: target, role: 'member' })] })
    // 5) audit insert
    fakeClient.responses.push({ rows: [] })

    const res = await app.request(`/admin/users/${target}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')

    expect(
      fakeClient.calls.find((c) => c.text.includes('UPDATE refresh_tokens')),
    ).toBeTruthy()
    expect(
      fakeClient.calls.find((c) => c.text.includes('DELETE FROM vault_members')),
    ).toBeTruthy()
    const audit = fakeClient.calls.find((c) => c.text.includes('INSERT INTO audit_log'))
    expect(audit?.values?.[2]).toBe('user.revoke')
  })
})
