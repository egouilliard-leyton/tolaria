// Bundle H §2 — `rotateRefreshToken` records an `auth.refresh.suspicious`
// audit_log row whenever the new request's UA or IP differs from the values
// stored on the prior token. Rotation itself still succeeds (a UA/IP change
// is a routine fact of life — new browser version, new mobile network — and
// hard-rejecting would lock real users out).

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

interface AuditRow {
  subscription_id: string
  actor_user_id: string | null
  action: string
  target: string | null
  meta: unknown
}

const STORE: {
  rows: FakeRefreshRow[]
  users: FakeUserRow[]
  audit: AuditRow[]
} = { rows: [], users: [], audit: [] }

let _id = 0
function uuid(): string {
  _id += 1
  return `id-${_id.toString().padStart(6, '0')}`
}

function fakeQuery(text: string, params: unknown[] = []): { rows: unknown[] } {
  const t = text.trim()

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

  if (
    t.startsWith('SELECT rt.id, rt.user_id, rt.subscription_id, rt.hashed_token,') &&
    t.includes('FROM refresh_tokens rt')
  ) {
    const [id, hashed] = params as [string, string]
    const row = STORE.rows.find((r) => r.id === id && r.hashed_token === hashed)
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
    const row = STORE.rows.find(
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
          user_agent: row.user_agent,
          ip: row.ip,
          expires_at: row.expires_at,
          revoked_at: row.revoked_at,
          role: u?.role ?? 'member',
        },
      ],
    }
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
    withTenant: async <T,>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) => fn(fakeClient),
    withPlatformContext: async <T,>(fn: (c: typeof fakeClient) => Promise<T>) => fn(fakeClient),
    tenantQuery: async (_ctx: unknown, text: string, params?: unknown[]) =>
      Promise.resolve(fakeQuery(text, params)),
    pingDb: async () => undefined,
  }
})

beforeEach(() => {
  STORE.rows.length = 0
  STORE.users.length = 0
  STORE.audit.length = 0
  _id = 0
})

const TENANT = {
  userId: 'user-1',
  subscriptionId: 'sub-1',
  role: 'owner' as const,
}

describe('rotateRefreshToken — audit on UA/IP mismatch (Bundle H §2)', () => {
  it('writes auth.refresh.suspicious when the user-agent changes', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'browser-A', '10.0.0.1')
    const { next } = await mod.rotateRefreshToken(
      issued.rawToken,
      'browser-B', // different UA
      '10.0.0.1',
    )
    expect(next.rawToken).not.toEqual(issued.rawToken)
    const suspicious = STORE.audit.find((a) => a.action === 'auth.refresh.suspicious')
    expect(suspicious).toBeDefined()
    expect(suspicious?.subscription_id).toBe(TENANT.subscriptionId)
    expect(suspicious?.actor_user_id).toBe(TENANT.userId)
    const meta = suspicious?.meta as Record<string, unknown>
    expect(meta.old_ua).toBe('browser-A')
    expect(meta.new_ua).toBe('browser-B')
    expect(meta.old_ip).toBe('10.0.0.1')
    expect(meta.new_ip).toBe('10.0.0.1')
  })

  it('writes auth.refresh.suspicious when the IP changes', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'browser-A', '10.0.0.1')
    await mod.rotateRefreshToken(issued.rawToken, 'browser-A', '203.0.113.7')
    const suspicious = STORE.audit.find((a) => a.action === 'auth.refresh.suspicious')
    expect(suspicious).toBeDefined()
    const meta = suspicious?.meta as Record<string, unknown>
    expect(meta.old_ip).toBe('10.0.0.1')
    expect(meta.new_ip).toBe('203.0.113.7')
  })

  it('does NOT write an audit row when UA and IP both match', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'browser-A', '10.0.0.1')
    await mod.rotateRefreshToken(issued.rawToken, 'browser-A', '10.0.0.1')
    expect(STORE.audit.find((a) => a.action === 'auth.refresh.suspicious')).toBeUndefined()
  })

  it('still rotates successfully on mismatch (does not reject)', async () => {
    STORE.users.push({ id: TENANT.userId, role: 'owner' })
    const mod = await import('../src/auth/refresh-tokens.js')
    const issued = await mod.issueRefreshToken(TENANT, 'old-ua', '10.0.0.1')
    const { next, ctx } = await mod.rotateRefreshToken(issued.rawToken, 'new-ua', '10.0.0.99')
    expect(next.rawToken).not.toEqual(issued.rawToken)
    expect(ctx.userId).toBe(TENANT.userId)
    // Old row revoked.
    expect(STORE.rows.find((r) => r.id === issued.id)?.revoked_at).toBeInstanceOf(Date)
    // New row live.
    expect(STORE.rows.find((r) => r.id === next.id)?.revoked_at).toBeNull()
  })
})
