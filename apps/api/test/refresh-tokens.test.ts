// Behavior tests for `auth/refresh-tokens.ts`. We mock the db module so the
// suite has no Postgres dependency. The mock's pool client is a dumb
// in-memory store keyed by row id, with the same shape as the real
// `refresh_tokens` table the production code touches.

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const ORIG_ENV = { ...process.env }

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = 'postgres://localhost/test'
  process.env.AUTH_JWT_SECRET = 'a'.repeat(48)
  process.env.AUTH_JWT_REFRESH_TTL_SECONDS = '60'
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

interface FakeRefreshRow {
  id: string
  user_id: string
  subscription_id: string
  hashed_token: string
  user_agent: string | null
  ip: string | null
  expires_at: Date
  revoked_at: Date | null
}

interface FakeUserRow {
  id: string
  role: 'owner' | 'admin' | 'member'
}

const STORE: { rows: FakeRefreshRow[]; users: FakeUserRow[] } = { rows: [], users: [] }

function uuid(): string {
  // Random enough for tests; not a real UUID.
  return Math.random().toString(36).slice(2, 12) + '-' + Date.now().toString(36)
}

function fakeQuery(text: string, params: unknown[] = []): { rows: unknown[] } {
  const t = text.trim()

  // INSERT INTO refresh_tokens RETURNING id
  if (t.startsWith('INSERT INTO refresh_tokens')) {
    const [user_id, subscription_id, hashed_token, user_agent, ip, expires_at] = params as [
      string, string, string, string | null, string | null, Date,
    ]
    const row: FakeRefreshRow = {
      id: uuid(),
      user_id,
      subscription_id,
      hashed_token,
      user_agent,
      ip,
      expires_at,
      revoked_at: null,
    }
    STORE.rows.push(row)
    return { rows: [{ id: row.id }] }
  }

  // SELECT … FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id WHERE rt.id = $1 AND rt.hashed_token = $2
  if (
    t.startsWith('SELECT rt.id, rt.user_id, rt.subscription_id, rt.hashed_token,') &&
    t.includes('FROM refresh_tokens rt')
  ) {
    const [id, hashed] = params as [string, string]
    const row = STORE.rows.find((r) => r.id === id && r.hashed_token === hashed)
    if (!row) return { rows: [] }
    const user = STORE.users.find((u) => u.id === row.user_id)
    return {
      rows: [
        {
          id: row.id,
          user_id: row.user_id,
          subscription_id: row.subscription_id,
          hashed_token: row.hashed_token,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          role: user?.role ?? 'member',
        },
      ],
    }
  }

  // UPDATE refresh_tokens SET revoked_at = now() … RETURNING …
  if (t.startsWith('UPDATE refresh_tokens') && t.includes('RETURNING')) {
    const [id, hashed] = params as [string, string]
    const row = STORE.rows.find(
      (r) =>
        r.id === id &&
        r.hashed_token === hashed &&
        r.revoked_at === null &&
        r.expires_at.getTime() > Date.now(),
    )
    if (!row) return { rows: [] }
    row.revoked_at = new Date()
    const user = STORE.users.find((u) => u.id === row.user_id)
    return {
      rows: [
        {
          id: row.id,
          user_id: row.user_id,
          subscription_id: row.subscription_id,
          hashed_token: row.hashed_token,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          role: user?.role ?? 'member',
        },
      ],
    }
  }

  // UPDATE refresh_tokens SET revoked_at = now() WHERE … (no RETURNING)
  if (t.startsWith('UPDATE refresh_tokens')) {
    const [id, hashed] = params as [string, string]
    const row = STORE.rows.find(
      (r) => r.id === id && r.hashed_token === hashed && r.revoked_at === null,
    )
    if (row) row.revoked_at = new Date()
    return { rows: [] }
  }

  // SELECT set_config(...) noop
  if (t.startsWith('SELECT set_config')) return { rows: [] }
  if (t === 'BEGIN' || t === 'COMMIT' || t === 'ROLLBACK') return { rows: [] }

  throw new Error(`fakeQuery: unrecognized SQL: ${t.slice(0, 80)}`)
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
    withTenant: async <T,>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>): Promise<T> =>
      fn(fakeClient),
    withPlatformContext: async <T,>(fn: (c: typeof fakeClient) => Promise<T>): Promise<T> =>
      fn(fakeClient),
    tenantQuery: async (_ctx: unknown, text: string, params?: unknown[]) =>
      Promise.resolve(fakeQuery(text, params)),
    pingDb: async () => undefined,
  }
})

beforeEach(() => {
  STORE.rows.length = 0
  STORE.users.length = 0
})

const TENANT = {
  userId: 'user-1',
  subscriptionId: 'sub-1',
  role: 'owner' as const,
}

describe('issueRefreshToken', () => {
  it('returns an opaque token shaped <rowId>.<raw>', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'test-ua', '127.0.0.1')
    expect(issued.rawToken).toMatch(/^[^.]+\.[A-Za-z0-9_-]+$/)
    expect(issued.expiresAt.getTime()).toBeGreaterThan(Date.now())
    expect(STORE.rows).toHaveLength(1)
    // The raw token must NOT be stored verbatim — only its hash.
    const storedHash = STORE.rows[0]?.hashed_token ?? ''
    expect(storedHash).not.toContain(issued.rawToken)
  })
})

describe('rotateRefreshToken', () => {
  it('revokes the old row and issues a new one', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const first = await mod.issueRefreshToken(TENANT, 'ua', null)
    const { next, ctx } = await mod.rotateRefreshToken(first.rawToken, 'ua', null)
    expect(next.rawToken).not.toEqual(first.rawToken)
    expect(ctx.userId).toBe(TENANT.userId)
    expect(ctx.subscriptionId).toBe(TENANT.subscriptionId)
    // Old row revoked, new row live.
    const oldRow = STORE.rows.find((r) => r.id === first.id)
    expect(oldRow?.revoked_at).toBeInstanceOf(Date)
    const newRow = STORE.rows.find((r) => r.id === next.id)
    expect(newRow?.revoked_at).toBeNull()
  })

  it('rejects an already-rotated token', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const first = await mod.issueRefreshToken(TENANT, 'ua', null)
    await mod.rotateRefreshToken(first.rawToken, 'ua', null)
    await expect(mod.rotateRefreshToken(first.rawToken, 'ua', null)).rejects.toThrow()
  })

  it('rejects a malformed cookie value', async () => {
    const mod = await import('../src/auth/refresh-tokens.js')
    await expect(mod.rotateRefreshToken('not-a-valid-token', null, null)).rejects.toThrow()
  })

  it('rejects an unknown row id', async () => {
    const mod = await import('../src/auth/refresh-tokens.js')
    await expect(
      mod.rotateRefreshToken('does-not-exist.AAAAA', null, null),
    ).rejects.toThrow()
  })
})

describe('revokeRefreshToken', () => {
  it('marks the row revoked', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'ua', null)
    await mod.revokeRefreshToken(issued.rawToken)
    const row = STORE.rows.find((r) => r.id === issued.id)
    expect(row?.revoked_at).toBeInstanceOf(Date)
  })

  it('is idempotent on a malformed input', async () => {
    const mod = await import('../src/auth/refresh-tokens.js')
    await expect(mod.revokeRefreshToken('garbage')).resolves.toBeUndefined()
  })

  it('is idempotent on an unknown row id', async () => {
    const mod = await import('../src/auth/refresh-tokens.js')
    await expect(mod.revokeRefreshToken('nope.also-nope')).resolves.toBeUndefined()
  })
})

describe('verifyRefreshToken', () => {
  it('returns the resolved tenant context for a live token', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'admin' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'ua', null)
    const verified = await mod.verifyRefreshToken(issued.rawToken)
    expect(verified.userId).toBe(TENANT.userId)
    expect(verified.subscriptionId).toBe(TENANT.subscriptionId)
    expect(verified.role).toBe('admin')
  })

  it('rejects a revoked token', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'ua', null)
    await mod.revokeRefreshToken(issued.rawToken)
    await expect(mod.verifyRefreshToken(issued.rawToken)).rejects.toThrow()
  })
})
