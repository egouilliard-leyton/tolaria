// Behavioral tests for the attachments routes. The DB layer (`withTenant`)
// and the R2 service (`presignPut`, `presignGet`, `headObject`) are mocked
// via `vi.mock()` so this file exercises the Hono handlers in isolation.
//
// We assemble a tiny Hono app that injects a fake tenant on every request,
// mounts the real `attachments` router, and routes errors through the same
// `errorHandler` middleware production uses, so the JSON shape is identical.

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

const SUB = '11111111-1111-1111-1111-111111111111'
const USER = '44444444-4444-4444-4444-444444444444'
const VAULT = '22222222-2222-2222-2222-222222222222'
const ATTACH = '33333333-3333-3333-3333-333333333333'
const NOTE = '55555555-5555-5555-5555-555555555555'

// ── Module mocks ──────────────────────────────────────────────────────────
// Mocks are hoisted by vitest, so the imports under test pick these up.

vi.mock('../src/db.js', () => {
  // A minimal stub of the pg client surface that handlers actually use.
  type QueryResult = { rows: unknown[]; rowCount: number }
  let nextResults: QueryResult[] = []
  const queries: Array<{ text: string; values: unknown[] }> = []

  const fakeClient = {
    query: async (text: string, values: unknown[] = []): Promise<QueryResult> => {
      queries.push({ text, values })
      return nextResults.shift() ?? { rows: [], rowCount: 0 }
    },
  }

  return {
    pool: {} as unknown,
    withTenant: async <T>(_ctx: unknown, fn: (c: typeof fakeClient) => Promise<T>) =>
      fn(fakeClient),
    tenantQuery: async (_ctx: unknown, text: string, values: unknown[] = []) => {
      queries.push({ text, values })
      return nextResults.shift() ?? { rows: [], rowCount: 0 }
    },
    pingDb: async () => undefined,
    __test: {
      reset() {
        nextResults = []
        queries.length = 0
      },
      pushResult(r: QueryResult) {
        nextResults.push(r)
      },
      queries() {
        return queries
      },
    },
  }
})

vi.mock('../src/services/r2.js', () => {
  return {
    buildKey: vi.fn(
      (parts: { subscriptionId: string; vaultId: string; attachmentId: string; filename: string }) =>
        `s/${parts.subscriptionId}/v/${parts.vaultId}/a/${parts.attachmentId}/${parts.filename}`,
    ),
    presignPut: vi.fn(async () => ({
      url: 'https://r2.example/put?sig=put',
      headers: {
        'content-type': 'image/png',
        'content-length': '1024',
        'x-amz-meta-sha256': 'a'.repeat(64),
      },
      expiresIn: 300,
    })),
    presignGet: vi.fn(async () => ({ url: 'https://r2.example/get?sig=get', expiresIn: 600 })),
    headObject: vi.fn(async () => ({ contentLength: 1024, sha256: 'a'.repeat(64) })),
    deleteObject: vi.fn(async () => undefined),
  }
})

vi.mock('../src/jobs/r2-gc.js', () => ({
  scheduleR2Gc: vi.fn(async () => 'job-id'),
}))

// ── Test harness ──────────────────────────────────────────────────────────

async function buildApp() {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { attachments } = await import('../src/routes/attachments.js')

  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('user', { sub: USER, sid: SUB, role: 'member', jti: 'jti' })
    c.set('tenant', { subscriptionId: SUB, userId: USER })
    await next()
  })
  app.route('/', attachments)
  return app
}

async function getDbMock() {
  const mod = (await import('../src/db.js')) as unknown as {
    __test: {
      reset(): void
      pushResult(r: { rows: unknown[]; rowCount: number }): void
      queries(): Array<{ text: string; values: unknown[] }>
    }
  }
  return mod.__test
}

async function getR2Mock() {
  return (await import('../src/services/r2.js')) as unknown as {
    presignPut: ReturnType<typeof vi.fn>
    presignGet: ReturnType<typeof vi.fn>
    headObject: ReturnType<typeof vi.fn>
    buildKey: ReturnType<typeof vi.fn>
    deleteObject: ReturnType<typeof vi.fn>
  }
}

async function getJobMock() {
  return (await import('../src/jobs/r2-gc.js')) as unknown as {
    scheduleR2Gc: ReturnType<typeof vi.fn>
  }
}

beforeEach(async () => {
  ;(await getDbMock()).reset()
  const r2 = await getR2Mock()
  r2.presignPut.mockClear()
  r2.presignGet.mockClear()
  r2.headObject.mockClear()
  r2.buildKey.mockClear()
  r2.deleteObject.mockClear()
  ;(await getJobMock()).scheduleR2Gc.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// Convenience: a fresh attachment row as it would come out of the INSERT.
function row(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: ATTACH,
    vault_id: VAULT,
    note_id: null,
    key_r2: '__pending__',
    mime: 'image/png',
    size_bytes: 1024,
    sha256: 'a'.repeat(64),
    verified_at: null,
    created_at: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  }
}

// ── POST /vaults/:vaultId/attachments ────────────────────────────────────

describe('POST /vaults/:vaultId/attachments', () => {
  it('inserts a row, presigns a PUT URL, and returns the wire shape', async () => {
    const db = await getDbMock()
    // 1. vault lookup
    db.pushResult({ rows: [{ id: VAULT }], rowCount: 1 })
    // 2. insert returning the row
    db.pushResult({ rows: [row()], rowCount: 1 })
    // 3. UPDATE attachments SET key_r2 = ... (no rows returned)
    db.pushResult({ rows: [], rowCount: 1 })

    const app = await buildApp()
    const res = await app.request(`/vaults/${VAULT}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mime: 'image/png',
        size: 1024,
        sha256: 'a'.repeat(64),
        filename: 'photo.png',
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      put_url: string
      key: string
      required_headers: Record<string, string>
      sha256_header: string
      size_limit: number
      expires_in: number
    }
    expect(body.id).toBe(ATTACH)
    expect(body.put_url).toBe('https://r2.example/put?sig=put')
    expect(body.key).toBe(`s/${SUB}/v/${VAULT}/a/${ATTACH}/photo.png`)
    expect(body.required_headers['x-amz-meta-sha256']).toBe('a'.repeat(64))
    expect(body.sha256_header).toBe('a'.repeat(64))
    expect(body.expires_in).toBe(300)

    const r2 = await getR2Mock()
    expect(r2.presignPut).toHaveBeenCalledTimes(1)
  })

  it('rejects MIME types outside the allowlist with 400', async () => {
    const app = await buildApp()
    const res = await app.request(`/vaults/${VAULT}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mime: 'application/x-msdownload',
        size: 1024,
        sha256: 'a'.repeat(64),
        filename: 'evil.exe',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invalid_input')
    expect(body.error.message).toMatch(/mime/i)
  })

  it('rejects oversized uploads with 400', async () => {
    const app = await buildApp()
    const res = await app.request(`/vaults/${VAULT}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mime: 'image/png',
        size: 100 * 1024 * 1024,
        sha256: 'a'.repeat(64),
        filename: 'huge.png',
      }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('invalid_input')
  })

  it('returns 404 when the vault is not visible to the tenant', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [], rowCount: 0 }) // no vault

    const app = await buildApp()
    const res = await app.request(`/vaults/${VAULT}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mime: 'image/png',
        size: 1024,
        sha256: 'a'.repeat(64),
        filename: 'photo.png',
      }),
    })
    expect(res.status).toBe(404)
  })
})

// ── POST /attachments/:id/verify ─────────────────────────────────────────

describe('POST /attachments/:id/verify', () => {
  it('verifies size + sha256 then returns the attachment shape with a fresh GET URL', async () => {
    const db = await getDbMock()
    // 1. SELECT row
    db.pushResult({ rows: [row({ key_r2: 'some/key' })], rowCount: 1 })
    // 2. UPDATE ... RETURNING ... (verified_at now set)
    db.pushResult({
      rows: [row({ key_r2: 'some/key', verified_at: new Date() })],
      rowCount: 1,
    })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}/verify`, { method: 'POST' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      id: string
      vault_id: string
      url: string
      mime: string
      size_bytes: number
      sha256: string
    }
    expect(body.id).toBe(ATTACH)
    expect(body.vault_id).toBe(VAULT)
    expect(body.url).toBe('https://r2.example/get?sig=get')
    expect(body.size_bytes).toBe(1024)

    const r2 = await getR2Mock()
    expect(r2.headObject).toHaveBeenCalledWith('some/key')
    expect(r2.presignGet).toHaveBeenCalledWith('some/key')
  })

  it('returns 409 verification_failed on size mismatch', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [row({ key_r2: 'some/key' })], rowCount: 1 })

    const r2 = await getR2Mock()
    r2.headObject.mockResolvedValueOnce({ contentLength: 999, sha256: 'a'.repeat(64) })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}/verify`, { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string; message: string; details: { reason: string } }
    }
    expect(body.error.code).toBe('conflict')
    expect(body.error.details.reason).toBe('size_mismatch')
  })

  it('returns 409 verification_failed on sha256 mismatch', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [row({ key_r2: 'some/key' })], rowCount: 1 })

    const r2 = await getR2Mock()
    r2.headObject.mockResolvedValueOnce({ contentLength: 1024, sha256: 'b'.repeat(64) })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}/verify`, { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { details: { reason: string } }
    }
    expect(body.error.details.reason).toBe('sha256_mismatch')
  })

  it('returns 409 verification_failed when the object is missing in R2', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [row({ key_r2: 'some/key' })], rowCount: 1 })

    const r2 = await getR2Mock()
    const { NotFound } = await import('../src/lib/errors.js')
    r2.headObject.mockRejectedValueOnce(NotFound('Object not found in R2'))

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}/verify`, { method: 'POST' })
    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { details: { reason: string } }
    }
    expect(body.error.details.reason).toBe('object_missing')
  })

  it('returns 404 when the attachment row is hidden by RLS', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [], rowCount: 0 })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}/verify`, { method: 'POST' })
    expect(res.status).toBe(404)
  })
})

// ── GET /attachments/:id ─────────────────────────────────────────────────

describe('GET /attachments/:id', () => {
  it('redirects 302 to a presigned GET URL when verified', async () => {
    const db = await getDbMock()
    db.pushResult({
      rows: [row({ key_r2: 'some/key', verified_at: new Date() })],
      rowCount: 1,
    })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}`)
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://r2.example/get?sig=get')
  })

  it('returns 409 not_verified when verified_at is null', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [row({ key_r2: 'some/key' })], rowCount: 1 })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}`)
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('conflict')
    expect(body.error.message).toBe('not_verified')
  })

  it('returns 404 when row is missing', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [], rowCount: 0 })
    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}`)
    expect(res.status).toBe(404)
  })
})

// ── DELETE /attachments/:id ──────────────────────────────────────────────

describe('DELETE /attachments/:id', () => {
  it('detaches the row and enqueues an r2-gc job', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [{ id: ATTACH }], rowCount: 1 })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}`, { method: 'DELETE' })
    expect(res.status).toBe(204)

    const jobs = await getJobMock()
    expect(jobs.scheduleR2Gc).toHaveBeenCalledWith({
      subscriptionId: SUB,
      attachmentId: ATTACH,
    })
  })

  it('returns 404 when the row is hidden by RLS', async () => {
    const db = await getDbMock()
    db.pushResult({ rows: [], rowCount: 0 })

    const app = await buildApp()
    const res = await app.request(`/attachments/${ATTACH}`, { method: 'DELETE' })
    expect(res.status).toBe(404)

    const jobs = await getJobMock()
    expect(jobs.scheduleR2Gc).not.toHaveBeenCalled()
  })
})

// ── note_id reference ─────────────────────────────────────────────────────

describe('POST /vaults/:vaultId/attachments with note_id', () => {
  it('verifies the note exists in the same vault before insert', async () => {
    const db = await getDbMock()
    // 1. vault
    db.pushResult({ rows: [{ id: VAULT }], rowCount: 1 })
    // 2. note lookup (hidden / wrong vault)
    db.pushResult({ rows: [], rowCount: 0 })

    const app = await buildApp()
    const res = await app.request(`/vaults/${VAULT}/attachments`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mime: 'image/png',
        size: 1024,
        sha256: 'a'.repeat(64),
        filename: 'photo.png',
        note_id: NOTE,
      }),
    })
    expect(res.status).toBe(404)
  })
})
