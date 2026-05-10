// /vaults/:vaultId/notes (list/create) + /notes/:id (get/save/delete).
//
// Cursor pagination is keyset on (modified_at DESC, id DESC). The `version`
// column drives optimistic concurrency on PUT — a mismatch is a 409 with
// the canonical current version in `details`.

import { Hono } from 'hono'
import type { PgClient } from '../db.js'
import { withTenant } from '../db.js'
import { enqueue } from '../jobs/index.js'
import { decodeCursor, encodeCursor } from '../lib/cursor.js'
import { Conflict, NotFound } from '../lib/errors.js'
import { logger } from '../lib/logger.js'
import { toNote, toNoteSummary, wordCount } from '../lib/mappers.js'
import {
  CreateNoteBody,
  ListNotesQuery,
  NoteIdParam,
  SaveNoteBody,
  VaultIdRouteParam,
} from '../lib/schemas.js'
import { ensureUniqueSlug, slugify } from '../lib/slug.js'
import { readJson, readParams, readQuery } from '../lib/validate.js'
import { assertVaultExists } from './vaults.js'

export const notes = new Hono()

notes.get('/vaults/:vaultId/notes', async (c) => {
  const { vaultId } = readParams(c, VaultIdRouteParam)
  const q = readQuery(c, ListNotesQuery)
  const tenant = c.get('tenant')

  const limit = q.limit
  const cursor = q.cursor ? decodeCursor(q.cursor) : null
  const folderFilter = parseFolderFilter(q.folderId)

  const rows = await withTenant(tenant, async (client) => {
    await assertVaultExists(client, vaultId)
    // We over-fetch one to know whether there's a next page without a
    // separate count query.
    const params: unknown[] = [vaultId, limit + 1]
    let where = `vault_id = $1 AND deleted_at IS NULL`
    if (folderFilter.kind === 'null') {
      where += ` AND folder_id IS NULL`
    } else if (folderFilter.kind === 'id') {
      params.push(folderFilter.id)
      where += ` AND folder_id = $${params.length}`
    }
    if (cursor) {
      params.push(cursor.modifiedAt, cursor.id)
      where += ` AND (modified_at, id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`
    }
    const r = await client.query(
      `SELECT id, vault_id, folder_id, slug, title, modified_at, word_count
         FROM notes
        WHERE ${where}
        ORDER BY modified_at DESC, id DESC
        LIMIT $2`,
      params,
    )
    return r.rows
  })

  let nextCursor: string | null = null
  if (rows.length > limit) {
    const last = rows[limit - 1]
    nextCursor = encodeCursor({
      modifiedAt: new Date(last.modified_at).toISOString(),
      id: last.id,
    })
    rows.length = limit
  }
  return c.json({ items: rows.map(toNoteSummary), nextCursor })
})

notes.post('/vaults/:vaultId/notes', async (c) => {
  const { vaultId } = readParams(c, VaultIdRouteParam)
  const body = await readJson(c, CreateNoteBody)
  const tenant = c.get('tenant')
  const user = c.get('user')

  const baseSlug = slugify(body.title)
  const bodyMd = body.bodyMd ?? ''
  const frontmatter = body.frontmatter ?? {}

  const note = await withTenant(tenant, async (client) => {
    await assertVaultExists(client, vaultId)
    if (body.folderId) await assertFolderInVault(client, body.folderId, vaultId)

    const slug = await ensureUniqueSlug(baseSlug, async (candidate) => {
      const r = await client.query(
        `SELECT 1 FROM notes WHERE vault_id = $1 AND slug = $2`,
        [vaultId, candidate],
      )
      return r.rowCount !== null && r.rowCount > 0
    })
    const r = await client.query(
      `INSERT INTO notes
         (vault_id, folder_id, slug, title, body_md, frontmatter, word_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, vault_id, folder_id, slug, title, body_md, frontmatter,
                 word_count, version, created_at, modified_at`,
      [
        vaultId,
        body.folderId ?? null,
        slug,
        body.title,
        bodyMd,
        JSON.stringify(frontmatter),
        wordCount(bodyMd),
        user.sub,
      ],
    )
    return r.rows[0]
  })

  await enqueueIndex(user.sid, vaultId, note.id)
  return c.json(toNote(note), 201)
})

notes.get('/notes/:id', async (c) => {
  const { id } = readParams(c, NoteIdParam)
  const tenant = c.get('tenant')
  const row = await withTenant(tenant, async (client) => loadNote(client, id))
  return c.json(toNote(row))
})

notes.put('/notes/:id', async (c) => {
  const { id } = readParams(c, NoteIdParam)
  const body = await readJson(c, SaveNoteBody)
  const tenant = c.get('tenant')
  const user = c.get('user')

  const updated = await withTenant(tenant, async (client) => {
    // Lock the row so the version check + bump is atomic against concurrent
    // PUTs from the same tenant.
    const cur = await client.query<{
      vault_id: string
      version: number
    }>(
      `SELECT vault_id, version FROM notes
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [id],
    )
    const current = cur.rows[0]
    if (!current) throw NotFound('note not found')
    if (current.version !== body.expectedVersion) {
      throw Conflict('version_mismatch', { current: current.version })
    }
    const r = await client.query(
      `UPDATE notes
          SET body_md = $2,
              frontmatter = $3::jsonb,
              word_count = $4,
              version = version + 1,
              modified_at = now()
        WHERE id = $1
        RETURNING id, vault_id, folder_id, slug, title, body_md, frontmatter,
                  word_count, version, created_at, modified_at`,
      [id, body.bodyMd, JSON.stringify(body.frontmatter), wordCount(body.bodyMd)],
    )
    return r.rows[0]
  })

  await enqueueIndex(user.sid, updated.vault_id, updated.id)
  return c.json(toNote(updated))
})

notes.delete('/notes/:id', async (c) => {
  const { id } = readParams(c, NoteIdParam)
  const tenant = c.get('tenant')
  await withTenant(tenant, async (client) => {
    const r = await client.query(
      `UPDATE notes
          SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    if (r.rowCount === 0) throw NotFound('note not found')
  })
  return c.body(null, 204)
})

// ── helpers ─────────────────────────────────────────────────────────────────

async function loadNote(client: PgClient, id: string) {
  const r = await client.query(
    `SELECT id, vault_id, folder_id, slug, title, body_md, frontmatter,
            word_count, version, created_at, modified_at
       FROM notes WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  )
  if (r.rowCount === 0) throw NotFound('note not found')
  return r.rows[0]
}

async function assertFolderInVault(
  client: PgClient,
  folderId: string,
  vaultId: string,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM folders WHERE id = $1 AND vault_id = $2`,
    [folderId, vaultId],
  )
  if (r.rowCount === 0) throw NotFound('folder not found')
}

function parseFolderFilter(
  raw: string | undefined,
): { kind: 'any' } | { kind: 'null' } | { kind: 'id'; id: string } {
  if (raw === undefined) return { kind: 'any' }
  if (raw === 'null') return { kind: 'null' }
  return { kind: 'id', id: raw }
}

async function enqueueIndex(
  subscriptionId: string,
  vaultId: string,
  noteId: string,
): Promise<void> {
  try {
    await enqueue('index-note', { subscriptionId, vaultId, noteId })
  } catch (err) {
    // Belt-and-braces: enqueue() already swallows internally, but double-log
    // here in case a future change reintroduces a throw.
    logger.error({ err, noteId }, 'index-note enqueue failed')
  }
}
