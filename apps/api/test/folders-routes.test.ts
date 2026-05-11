// Contract tests for the folder routes. Postgres is not required.
// We intercept `pool.connect()` so the route walks its real code paths
// against a recording fake client. Each test scripts the responses the
// route's queries should see.

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
  responses: Array<{ rows: unknown[]; rowCount?: number; throws?: unknown }>
  query: (text: string, values?: ReadonlyArray<unknown>) => Promise<{ rows: unknown[]; rowCount: number }>
  release: () => void
}

function makeClient(): FakeClient {
  const calls: QueryCall[] = []
  const responses: Array<{ rows: unknown[]; rowCount?: number; throws?: unknown }> = []
  return {
    calls,
    responses,
    async query(text, values) {
      calls.push({ text, values })
      if (/^(BEGIN|COMMIT|ROLLBACK)/i.test(text.trim()) || text.includes('set_config(')) {
        return { rows: [], rowCount: 0 }
      }
      const next = responses.shift()
      if (!next) return { rows: [], rowCount: 0 }
      if (next.throws) throw next.throws
      return { rows: next.rows, rowCount: next.rowCount ?? next.rows.length }
    },
    release() {},
  }
}

vi.mock('pg', () => {
  class Pool { connect = vi.fn() }
  return { default: { Pool }, Pool }
})

const VAULT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FOLDER_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const SUB_ID = '22222222-2222-4222-8222-222222222222'
const USER_ID = '11111111-1111-4111-8111-111111111111'

let fakeClient: FakeClient

async function buildApp() {
  const { Hono } = await import('hono')
  const { errorHandler } = await import('../src/middleware/error-handler.js')
  const { folders } = await import('../src/routes/folders.js')
  const db = await import('../src/db.js')

  fakeClient = makeClient()
  ;(db.pool as unknown as { connect: () => Promise<FakeClient> }).connect = async () => fakeClient

  const app = new Hono()
  app.onError(errorHandler)
  app.use('*', async (c, next) => {
    c.set('user', { sub: USER_ID, sid: SUB_ID, role: 'owner', jti: 'jti-1' })
    c.set('tenant', { subscriptionId: SUB_ID, userId: USER_ID })
    await next()
  })
  app.route('/', folders)
  return app
}

beforeEach(() => {
  vi.resetModules()
})
afterEach(() => {
  vi.clearAllMocks()
})

function folderRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: FOLDER_ID,
    vault_id: VAULT_ID,
    parent_id: null,
    name: 'Inbox',
    position: 0,
    updated_at: new Date('2026-05-10T12:00:00Z'),
    ...over,
  }
}

// ── GET /vaults/:vaultId/folders ────────────────────────────────────────────

describe('GET /vaults/:vaultId/folders', () => {
  it('returns a bare array of folder DTOs', async () => {
    const app = await buildApp()
    // 1) assertVaultExists → returns 1 row
    fakeClient.responses.push({ rows: [{ '?column?': 1 }] })
    // 2) the list query
    fakeClient.responses.push({
      rows: [folderRow(), folderRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Archive' })],
    })
    const res = await app.request(`/vaults/${VAULT_ID}/folders`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(Array.isArray(body)).toBe(true)
    expect(body).toHaveLength(2)
    // wire shape: snake_case
    expect(body[0]).toHaveProperty('vault_id')
    expect(body[0]).toHaveProperty('parent_id')
    expect(body[0]!.updated_at).toBe('2026-05-10T12:00:00.000Z')
  })

  it('returns 404 when the vault does not exist', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [] }) // assertVaultExists empty
    const res = await app.request(`/vaults/${VAULT_ID}/folders`)
    expect(res.status).toBe(404)
  })
})

// ── POST /vaults/:vaultId/folders ──────────────────────────────────────────

describe('POST /vaults/:vaultId/folders', () => {
  it('creates a top-level folder and returns 201 with the DTO', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [{ '?column?': 1 }] }) // assertVaultExists
    fakeClient.responses.push({ rows: [folderRow()] }) // INSERT RETURNING
    const res = await app.request(`/vaults/${VAULT_ID}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Inbox' }),
    })
    expect(res.status).toBe(201)
    const body = (await res.json()) as Record<string, unknown>
    expect(body.id).toBe(FOLDER_ID)
    expect(body.parent_id).toBeNull()
  })

  it('maps unique-violation (23505) to 409 conflict with code', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [{ '?column?': 1 }] }) // assertVaultExists
    fakeClient.responses.push({
      rows: [],
      throws: Object.assign(new Error('duplicate'), { code: '23505' }),
    })
    const res = await app.request(`/vaults/${VAULT_ID}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Inbox' }),
    })
    expect(res.status).toBe(409)
    const body = (await res.json()) as { error: { code: string; details: { code: string } } }
    expect(body.error.code).toBe('conflict')
    expect(body.error.details.code).toBe('duplicate_folder')
  })

  it('validates parent_id is in the same vault before inserting', async () => {
    const app = await buildApp()
    const parentId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
    fakeClient.responses.push({ rows: [{ '?column?': 1 }] }) // assertVaultExists
    fakeClient.responses.push({ rows: [] }) // assertFolderInVault → not found
    const res = await app.request(`/vaults/${VAULT_ID}/folders`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sub', parent_id: parentId }),
    })
    expect(res.status).toBe(404)
  })
})

// ── PATCH /folders/:id ─────────────────────────────────────────────────────

describe('PATCH /folders/:id', () => {
  it('rejects setting a folder as its own parent', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [folderRow()] }) // loadFolder
    const res = await app.request(`/folders/${FOLDER_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parent_id: FOLDER_ID }),
    })
    expect(res.status).toBe(400)
  })

  it('returns 404 when the folder does not exist', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [] }) // loadFolder empty
    const res = await app.request(`/folders/${FOLDER_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(404)
  })

  it('rejects a parent move that would create a cycle', async () => {
    const app = await buildApp()
    const newParentId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
    // 1) loadFolder for the current folder
    fakeClient.responses.push({ rows: [folderRow()] })
    // 2) assertFolderInVault for the new parent
    fakeClient.responses.push({ rows: [{ '?column?': 1 }] })
    // 3) assertNoCycle recursive CTE — returns a row → cycle detected
    fakeClient.responses.push({ rows: [{ id: FOLDER_ID }] })
    const res = await app.request(`/folders/${FOLDER_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ parent_id: newParentId }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { message: string } }
    expect(body.error.message).toMatch(/cycle/i)
  })

  it('updates name and returns the new DTO', async () => {
    const app = await buildApp()
    // loadFolder + UPDATE
    fakeClient.responses.push({ rows: [folderRow()] })
    fakeClient.responses.push({ rows: [folderRow({ name: 'Renamed' })] })
    const res = await app.request(`/folders/${FOLDER_ID}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { name: string }
    expect(body.name).toBe('Renamed')
  })
})

// ── DELETE /folders/:id ────────────────────────────────────────────────────

describe('DELETE /folders/:id', () => {
  it('returns 404 when the folder does not exist', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [], rowCount: 0 }) // DELETE no row
    const res = await app.request(`/folders/${FOLDER_ID}`, { method: 'DELETE' })
    expect(res.status).toBe(404)
  })

  it('returns 204 on success', async () => {
    const app = await buildApp()
    fakeClient.responses.push({ rows: [], rowCount: 1 })
    const res = await app.request(`/folders/${FOLDER_ID}`, { method: 'DELETE' })
    expect(res.status).toBe(204)
    expect(await res.text()).toBe('')
  })
})
