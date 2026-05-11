// /vaults/:vaultId/search — full vs prefix mode.
//
// These tests run the same SQL the route handler emits, against a real
// Postgres so the gin/tsvector and pg_trgm planners are real. We don't go
// through the HTTP layer because it would otherwise require minting a JWT
// per call; the SQL is the actual contract under test.
//
// Skipped when DATABASE_URL is unset.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  available,
  closePool,
  createNote,
  createTenant,
  createVault,
  dropTenant,
  type TestTenant,
  withTestTenant,
} from './helpers/db.js'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  process.env.API_PUBLIC_URL = 'http://localhost:8787'
  process.env.WEB_PUBLIC_URL = 'http://localhost:5173'
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://localhost/test'
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

afterAll(async () => {
  await closePool()
})

async function fullSearch(
  client: import('pg').PoolClient,
  vaultId: string,
  q: string,
  limit = 25,
): Promise<Array<{ note_id: string; title: string; score: number }>> {
  const r = await client.query<{ note_id: string; title: string; score: string }>(
    `WITH q AS (SELECT websearch_to_tsquery('simple', $2) AS tsq)
     SELECT n.id AS note_id,
            n.title,
            ts_rank(
              COALESCE(s.ts_doc,
                       to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.body_md, ''))),
              q.tsq
            ) AS score
       FROM notes n
       CROSS JOIN q
       LEFT JOIN note_search s ON s.note_id = n.id
      WHERE n.vault_id = $1
        AND n.deleted_at IS NULL
        AND COALESCE(s.ts_doc,
                     to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.body_md, '')))
            @@ q.tsq
      ORDER BY score DESC, n.modified_at DESC
      LIMIT $3`,
    [vaultId, q, limit],
  )
  return r.rows.map((row) => ({
    note_id: row.note_id,
    title: row.title,
    score: Number(row.score),
  }))
}

async function prefixSearch(
  client: import('pg').PoolClient,
  vaultId: string,
  q: string,
  limit = 25,
): Promise<Array<{ note_id: string; title: string; score: number }>> {
  const r = await client.query<{ note_id: string; title: string; score: string }>(
    `SELECT n.id AS note_id, n.title,
            GREATEST(
              similarity(n.title, $2),
              similarity(n.slug, $2),
              CASE WHEN n.title ILIKE $2 || '%' OR n.slug ILIKE $2 || '%'
                   THEN 1.0 ELSE 0.0 END
            ) AS score
       FROM notes n
      WHERE n.vault_id = $1
        AND n.deleted_at IS NULL
        AND (n.title ILIKE $2 || '%'
             OR n.slug ILIKE $2 || '%'
             OR n.title % $2
             OR n.slug % $2)
      ORDER BY score DESC, n.modified_at DESC
      LIMIT $3`,
    [vaultId, q, limit],
  )
  return r.rows.map((row) => ({
    note_id: row.note_id,
    title: row.title,
    score: Number(row.score),
  }))
}

describe.skipIf(!available)('search modes', () => {
  let tenant: TestTenant
  let vaultId: string

  beforeEach(async () => {
    tenant = await createTenant()
    vaultId = await createVault(tenant)
  })

  it('full mode finds words anywhere in body or title and ranks them', async () => {
    await createNote(tenant, vaultId, 'recipes', 'mushroom risotto with white wine', 'Recipes')
    const target = await createNote(
      tenant,
      vaultId,
      'risotto',
      'a thorough how-to for risotto including stock and stirring technique',
      'Risotto Notes',
    )
    await createNote(tenant, vaultId, 'unrelated', 'lorem ipsum dolor sit', 'Unrelated')

    const rows = await withTestTenant(tenant, (client) =>
      fullSearch(client, vaultId, 'risotto'),
    )
    expect(rows.length).toBeGreaterThanOrEqual(2)
    expect(rows[0]!.note_id).toBe(target) // title hit ranks higher
    expect(rows.every((r) => r.score > 0)).toBe(true)
    expect(rows.find((r) => r.title === 'Unrelated')).toBeUndefined()
  })

  it('full mode supports websearch operators (negation, phrases)', async () => {
    await createNote(tenant, vaultId, 'a', 'cats and dogs are common pets', 'Pets')
    const dogs = await createNote(
      tenant,
      vaultId,
      'b',
      'dogs are loyal and energetic, walked daily',
      'Dogs',
    )
    const rows = await withTestTenant(tenant, (client) =>
      fullSearch(client, vaultId, 'dogs -cats'),
    )
    expect(rows.map((r) => r.note_id)).toEqual([dogs])
  })

  it('prefix mode finds quick-open matches by title/slug prefix', async () => {
    const a = await createNote(tenant, vaultId, 'roadmap', '', 'Product Roadmap')
    const b = await createNote(tenant, vaultId, 'road-trip', '', 'Road Trip')
    await createNote(tenant, vaultId, 'highway', '', 'Highway')
    const rows = await withTestTenant(tenant, (client) =>
      prefixSearch(client, vaultId, 'road'),
    )
    expect(rows.map((r) => r.note_id).sort()).toEqual([a, b].sort())
    // Both prefix-match → both score 1.0.
    expect(rows[0]!.score).toBeCloseTo(1.0, 3)
  })

  it('prefix mode falls back to trigram similarity for typos', async () => {
    await createNote(tenant, vaultId, 'recipes-collection', '', 'Recipes Collection')
    // Typo: user typed "recipies".
    const rows = await withTestTenant(tenant, (client) =>
      prefixSearch(client, vaultId, 'recipies'),
    )
    expect(rows.length).toBeGreaterThanOrEqual(1)
    expect(rows[0]!.title).toBe('Recipes Collection')
  })

  it('skips soft-deleted notes in both modes', async () => {
    const noteId = await createNote(tenant, vaultId, 'gone', 'soon to vanish words', 'Vanishing')
    await withTestTenant(tenant, async (c) => {
      await c.query(`UPDATE notes SET deleted_at = now() WHERE id = $1`, [noteId])
    })
    const full = await withTestTenant(tenant, (c) => fullSearch(c, vaultId, 'vanish'))
    expect(full).toEqual([])
    const pre = await withTestTenant(tenant, (c) => prefixSearch(c, vaultId, 'vanish'))
    expect(pre).toEqual([])
  })

  afterEach(async () => {
    if (tenant) await dropTenant(tenant)
  })
})
