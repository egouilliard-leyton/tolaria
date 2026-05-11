// Audit-log behavioural tests for the four call sites added per
// `docs/web-saas/verification-2026-05-09.md` defect #5 and ADR-0115
// §Consequences:
//
//   - vault.create        (POST   /vaults)
//   - vault.delete        (DELETE /vaults/:id)
//   - attachment.create   (POST   /vaults/:vaultId/attachments)
//   - rename.run          (POST   /vaults/:vaultId/rename)
//
// We mock `withTenant` so each request runs against the same recording fake
// pg client. The assertions intentionally check both the SQL fragment and
// the parameters so that a future refactor cannot quietly drop the audit
// row or downgrade its metadata.
//
// The fake `withTenant` invokes `fn(client)` synchronously — i.e. without
// any commit/rollback bookkeeping — which lets us assert that the audit
// INSERT was issued against the SAME client as the action it audits.

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

interface QueryResult { rows: unknown[]; rowCount: number }
interface QueryCall { text: string; values: unknown[] }

vi.mock('../src/db.js', () => {
  let nextResults: QueryResult[] = []
  const queries: QueryCall[] = []
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
      reset() { nextResults = []; queries.length = 0 },
      pushResult(r: QueryResult) { nextResults.push(r) },
      queries() { return queries },
    },
  }
})

// Attachments depend on the R2 service and the GC job; both are stubbed so
// the route can run without a network or pg-boss.
vi.mock('../src/services/r2.js', () => ({
  buildKey: vi.fn(
    (parts: { subscriptionId: string; vaultId: string; attachmentId: string; filename: string }) =>
      `s/${parts.subscriptionId}/v/${parts.vaultId}/a/${parts.attachmentId}/${parts.filename}`,
  ),
  presignPut: vi.fn(async () => ({
    url: 'https://r2.example/put?sig=put',
    headers: { 'content-type': 'image/png', 'content-length': '1024' },
    expiresIn: 300,
  })),
  presignGet: vi.fn(async () => ({ url: 'https://r2.example/get?sig=get', expiresIn: 600 })),
  headObject: vi.fn(async () => ({ contentLength: 1024, sha256: 'a'.repeat(64) })),
  deleteObject: vi.fn(async () => undefined),
}))

// Rename also enqueues a propagation job after the transaction commits.
vi.mock('../src/jobs/index.js', () => ({
  enqueue: vi.fn(async () => 'job-id'),
}))

vi.mock('../src/jobs/r2-gc.js', () => ({
  scheduleR2Gc: vi.fn(async () => 'job-id'),
}))

async function getDbMock() {
  const mod = (await import('../src/db.js')) as unknown as {
    __test: {
      reset(): void
      pushResult(r: QueryResult): void
      queries(): QueryCall[]
    }
  }
  return mod.__test
}

async function buildApp(routes: 'vaults' | 'attachments' | 'rename') {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('user', { sub: USER, sid: SUB, role: 'owner', jti: 'jti' })
    c.set('tenant', { subscriptionId: SUB, userId: USER })
    await next()
  })
  if (routes === 'vaults') {
    const { vaults } = await import('../src/routes/vaults.js')
    app.route('/', vaults)
  } else if (routes === 'attachments') {
    const { attachments } = await import('../src/routes/attachments.js')
    app.route('/', attachments)
  } else {
    const { rename } = await import('../src/routes/rename.js')
    app.route('/', rename)
  }
  return app
}

beforeEach(async () => {
  ;(await getDbMock()).reset()
})

afterEach(() => {
  vi.clearAllMocks()
})

function findAuditCall(calls: QueryCall[]): QueryCall | undefined {
  return calls.find((c) => /INSERT INTO audit_log/i.test(c.text))
}

// ── vault.create ───────────────────────────────────────────────────────────

describe('audit: vault.create', () => {
  it('writes vault.create with vault_id, slug, name in meta', async () => {
    const db = await getDbMock()
    // 1. ensureUniqueSlug probe → no collision
    db.pushResult({ rows: [], rowCount: 0 })
    // 2. INSERT INTO vaults RETURNING ...
    db.pushResult({
      rows: [{
        id: VAULT,
        slug: 'my-vault',
        name: 'My Vault',
        created_at: new Date('2026-05-09T00:00:00Z'),
        settings: {},
      }],
      rowCount: 1,
    })
    // 3. audit INSERT
    db.pushResult({ rows: [], rowCount: 1 })

    const app = await buildApp('vaults')
    const res = await app.request('/vaults', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Vault' }),
    })
    expect(res.status).toBe(201)

    const audit = findAuditCall(db.queries())
    expect(audit).toBeDefined()
    expect(audit!.values[0]).toBe(SUB)
    expect(audit!.values[1]).toBe(USER)
    expect(audit!.values[2]).toBe('vault.create')
    expect(audit!.values[3]).toBe(VAULT)
    const meta = JSON.parse(audit!.values[4] as string) as Record<string, unknown>
    expect(meta).toEqual({ vault_id: VAULT, slug: 'my-vault', name: 'My Vault' })
  })
})

// ── vault.delete ───────────────────────────────────────────────────────────

describe('audit: vault.delete', () => {
  it('writes vault.delete with vault_id and slug in meta', async () => {
    const db = await getDbMock()
    // 1. UPDATE vaults SET deleted_at ... RETURNING id, slug
    db.pushResult({ rows: [{ id: VAULT, slug: 'my-vault' }], rowCount: 1 })
    // 2. audit INSERT
    db.pushResult({ rows: [], rowCount: 1 })

    const app = await buildApp('vaults')
    const res = await app.request(`/vaults/${VAULT}`, { method: 'DELETE' })
    expect(res.status).toBe(204)

    const audit = findAuditCall(db.queries())
    expect(audit).toBeDefined()
    expect(audit!.values[2]).toBe('vault.delete')
    expect(audit!.values[3]).toBe(VAULT)
    const meta = JSON.parse(audit!.values[4] as string) as Record<string, unknown>
    expect(meta).toEqual({ vault_id: VAULT, slug: 'my-vault' })
  })

  it('does NOT write an audit row when nothing was deleted', async () => {
    const db = await getDbMock()
    // UPDATE returns no rows → 404, audit must not fire
    db.pushResult({ rows: [], rowCount: 0 })

    const app = await buildApp('vaults')
    const res = await app.request(`/vaults/${VAULT}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
    expect(findAuditCall(db.queries())).toBeUndefined()
  })
})

// ── attachment.create ──────────────────────────────────────────────────────

describe('audit: attachment.create', () => {
  it('writes attachment.create at presign time, not at verify time', async () => {
    const db = await getDbMock()
    // 1. SELECT id FROM vaults … (vault exists)
    db.pushResult({ rows: [{ id: VAULT }], rowCount: 1 })
    // 2. INSERT INTO attachments RETURNING …
    db.pushResult({
      rows: [{
        id: ATTACH,
        vault_id: VAULT,
        note_id: null,
        key_r2: '__pending__',
        mime: 'image/png',
        size_bytes: 1024,
        sha256: 'a'.repeat(64),
        verified_at: null,
        created_at: new Date('2026-05-09T00:00:00Z'),
      }],
      rowCount: 1,
    })
    // 3. UPDATE attachments SET key_r2 …
    db.pushResult({ rows: [], rowCount: 1 })
    // 4. audit INSERT
    db.pushResult({ rows: [], rowCount: 1 })

    const app = await buildApp('attachments')
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

    const audit = findAuditCall(db.queries())
    expect(audit).toBeDefined()
    expect(audit!.values[2]).toBe('attachment.create')
    expect(audit!.values[3]).toBe(ATTACH)
    const meta = JSON.parse(audit!.values[4] as string) as Record<string, unknown>
    expect(meta).toEqual({
      attachment_id: ATTACH,
      vault_id: VAULT,
      note_id: null,
      mime: 'image/png',
      size_bytes: 1024,
    })
  })
})

// ── rename.run ─────────────────────────────────────────────────────────────

describe('audit: rename.run', () => {
  it('writes rename.run with from/to/affected metadata', async () => {
    const db = await getDbMock()
    // 1. assertVaultExists SELECT
    db.pushResult({ rows: [{ id: VAULT }], rowCount: 1 })
    // 2. SELECT id FROM notes … FOR UPDATE  (target note)
    db.pushResult({ rows: [{ id: NOTE }], rowCount: 1 })
    // 3. SELECT 1 FROM notes …  (slug collision check — no collision)
    db.pushResult({ rows: [], rowCount: 0 })
    // 4. UPDATE notes (rename target slug/title)
    db.pushResult({ rows: [], rowCount: 1 })
    // 5. WITH targets … UPDATE notes RETURNING (link rewrites)
    db.pushResult({
      rows: [
        { id: '66666666-6666-6666-6666-666666666666', rewritten: '2' },
        { id: '77777777-7777-7777-7777-777777777777', rewritten: '1' },
      ],
      rowCount: 2,
    })
    // 6. audit INSERT
    db.pushResult({ rows: [], rowCount: 1 })

    const app = await buildApp('rename')
    const res = await app.request(`/vaults/${VAULT}/rename`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from_path: 'old-note', to_path: 'new-note' }),
    })
    expect(res.status).toBe(200)

    const audit = findAuditCall(db.queries())
    expect(audit).toBeDefined()
    expect(audit!.values[2]).toBe('rename.run')
    expect(audit!.values[3]).toBe(VAULT)
    const meta = JSON.parse(audit!.values[4] as string) as Record<string, unknown>
    expect(meta.vault_id).toBe(VAULT)
    expect(meta.from_path).toBe('old-note')
    expect(meta.to_path).toBe('new-note')
    expect(meta.affected_note_ids).toEqual([
      NOTE,
      '66666666-6666-6666-6666-666666666666',
      '77777777-7777-7777-7777-777777777777',
    ])
    expect(meta.updated_link_count).toBe(3)
  })
})
