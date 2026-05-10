// Atomic rename — verifies that the rename SQL rewrites both bare and
// aliased wikilinks across an entire vault inside one transaction, and that
// a failure mid-flight rolls every change back together.
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
  // Same env priming as the other DB tests.
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

const escapeRegex = (s: string): string =>
  s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function runRenameSql(
  client: import('pg').PoolClient,
  vaultId: string,
  fromPath: string,
  toPath: string,
): Promise<{ affectedNoteIds: string[]; updatedLinkCount: number }> {
  const targetRes = await client.query<{ id: string }>(
    `SELECT id FROM notes
      WHERE vault_id = $1 AND slug = $2 AND deleted_at IS NULL
      FOR UPDATE`,
    [vaultId, fromPath],
  )
  if (targetRes.rowCount === 0) throw new Error('not_found')
  const targetId = targetRes.rows[0]!.id
  await client.query(
    `UPDATE notes SET slug = $2, title = $3,
        modified_at = now(), version = version + 1
      WHERE id = $1`,
    [targetId, toPath, toPath],
  )

  const pattern = `\\[\\[${escapeRegex(fromPath)}(\\|[^\\]]*)?\\]\\]`
  const replacement = `[[${toPath.replace(/\\/g, '\\\\').replace(/&/g, '\\&')}\\1]]`

  const upd = await client.query<{ id: string; rewritten: string }>(
    `WITH targets AS (
       SELECT id, body_md FROM notes
        WHERE vault_id = $1 AND id <> $2 AND deleted_at IS NULL AND body_md ~ $3
     ),
     match_counts AS (
       SELECT t.id, count(*)::bigint AS rewritten
         FROM targets t,
              LATERAL regexp_matches(t.body_md, $3, 'g') AS m
        GROUP BY t.id
     ),
     rewritten AS (
       SELECT t.id, regexp_replace(t.body_md, $3, $4, 'g') AS new_body
         FROM targets t
     )
     UPDATE notes n
        SET body_md = r.new_body,
            modified_at = now(),
            version = n.version + 1
       FROM rewritten r JOIN match_counts mc ON mc.id = r.id
      WHERE n.id = r.id
      RETURNING n.id, mc.rewritten`,
    [vaultId, targetId, pattern, replacement],
  )
  return {
    affectedNoteIds: [targetId, ...upd.rows.map((r) => r.id)],
    updatedLinkCount: upd.rows.reduce((s, r) => s + Number(r.rewritten), 0),
  }
}

describe.skipIf(!available)('rename — atomic wikilink rewrite', () => {
  let tenant: TestTenant
  let vaultId: string

  beforeEach(async () => {
    tenant = await createTenant()
    vaultId = await createVault(tenant)
  })

  it('rewrites bare and aliased wikilinks in one go', async () => {
    await createNote(tenant, vaultId, 'old-name', 'The original')
    const a = await createNote(
      tenant,
      vaultId,
      'a',
      'See [[old-name]] and [[old-name|alias text]] for context.',
    )
    const b = await createNote(
      tenant,
      vaultId,
      'b',
      'No links here, just prose. But [[old-name]] is mentioned twice — [[old-name]].',
    )
    const c = await createNote(tenant, vaultId, 'c', 'Talks about [[other]].')

    const result = await withTestTenant(tenant, (client) =>
      runRenameSql(client, vaultId, 'old-name', 'new-name'),
    )

    expect(result.updatedLinkCount).toBe(3) // 1 in `a` (bare) + 1 (alias) + 2 in `b`
    expect(result.affectedNoteIds.length).toBe(3) // target + a + b
    expect(result.affectedNoteIds).not.toContain(c)

    const bodies = await withTestTenant(tenant, async (client) => {
      const r = await client.query<{ id: string; body_md: string; slug: string }>(
        `SELECT id, body_md, slug FROM notes WHERE vault_id = $1 ORDER BY slug`,
        [vaultId],
      )
      return r.rows
    })
    const byId = new Map(bodies.map((row) => [row.id, row]))
    expect(byId.get(a)!.body_md).toBe(
      'See [[new-name]] and [[new-name|alias text]] for context.',
    )
    expect(byId.get(b)!.body_md).toBe(
      'No links here, just prose. But [[new-name]] is mentioned twice — [[new-name]].',
    )
    expect(byId.get(c)!.body_md).toBe('Talks about [[other]].')
    expect(bodies.find((r) => r.slug === 'new-name')).toBeTruthy()
    expect(bodies.find((r) => r.slug === 'old-name')).toBeUndefined()
  })

  it('leaves notes outside the vault untouched (RLS + WHERE both)', async () => {
    const otherVaultId = await createVault(tenant, 'Other', 'other-vault')
    await createNote(tenant, vaultId, 'old-name', 'x')
    const ext = await createNote(
      tenant,
      otherVaultId,
      'far',
      'still references [[old-name]]',
    )

    await withTestTenant(tenant, (client) =>
      runRenameSql(client, vaultId, 'old-name', 'new-name'),
    )

    const body = await withTestTenant(tenant, async (client) => {
      const r = await client.query<{ body_md: string }>(
        `SELECT body_md FROM notes WHERE id = $1`,
        [ext],
      )
      return r.rows[0]!.body_md
    })
    expect(body).toBe('still references [[old-name]]')
  })

  it('rolls everything back when the transaction throws mid-flight', async () => {
    await createNote(tenant, vaultId, 'foo', '')
    const partner = await createNote(tenant, vaultId, 'partner', 'See [[foo]].')

    await expect(
      withTestTenant(tenant, async (client) => {
        await runRenameSql(client, vaultId, 'foo', 'bar')
        // Simulate a downstream failure inside the same transaction.
        throw new Error('boom')
      }),
    ).rejects.toThrow(/boom/)

    const after = await withTestTenant(tenant, async (client) => {
      const r = await client.query<{ slug: string; body_md: string }>(
        `SELECT slug, body_md FROM notes WHERE vault_id = $1 ORDER BY slug`,
        [vaultId],
      )
      return r.rows
    })
    expect(after.find((row) => row.slug === 'foo')).toBeTruthy()
    expect(after.find((row) => row.slug === 'bar')).toBeUndefined()
    const partnerRow = after.find((row) => row.body_md.includes('[[foo]]'))
    expect(partnerRow).toBeTruthy()
    // partner unchanged
    void partner
  })

  it('does not rewrite substrings of longer wikilinks', async () => {
    await createNote(tenant, vaultId, 'foo', '')
    const decoy = await createNote(
      tenant,
      vaultId,
      'decoy',
      'these should not change: [[foobar]] [[foo-baz]]',
    )

    await withTestTenant(tenant, (client) =>
      runRenameSql(client, vaultId, 'foo', 'bar'),
    )

    const body = await withTestTenant(tenant, async (client) => {
      const r = await client.query<{ body_md: string }>(
        `SELECT body_md FROM notes WHERE id = $1`,
        [decoy],
      )
      return r.rows[0]!.body_md
    })
    expect(body).toBe('these should not change: [[foobar]] [[foo-baz]]')
  })

  afterEach(async () => {
    if (tenant) await dropTenant(tenant)
  })
})
