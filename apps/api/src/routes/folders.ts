// /vaults/:vaultId/folders + /folders/:id
// Folder hierarchy is unique on (vault_id, parent_id, name); we surface 409 on
// collisions so the UI can prompt the user.

import { Hono } from 'hono'
import type { PgClient } from '../db.js'
import { withTenant } from '../db.js'
import { Conflict, InvalidInput, NotFound } from '../lib/errors.js'
import { toFolder } from '../lib/mappers.js'
import {
  CreateFolderBody,
  FolderIdParam,
  UpdateFolderBody,
  VaultIdRouteParam,
} from '../lib/schemas.js'
import { readJson, readParams } from '../lib/validate.js'
import { assertVaultExists } from './vaults.js'

export const folders = new Hono()

folders.get('/vaults/:vaultId/folders', async (c) => {
  const { vaultId } = readParams(c, VaultIdRouteParam)
  const tenant = c.get('tenant')
  const rows = await withTenant(tenant, async (client) => {
    await assertVaultExists(client, vaultId)
    const r = await client.query(
      `SELECT id, vault_id, parent_id, name, position, updated_at
         FROM folders
        WHERE vault_id = $1
        ORDER BY parent_id NULLS FIRST, position ASC, name ASC`,
      [vaultId],
    )
    return r.rows
  })
  // Bare array per the SPA contract: `HttpVaultAdapter.listFolders` does
  // `dtos.map(toFolder)` directly on the response. Do not wrap in `{ items }`.
  return c.json(rows.map(toFolder))
})

folders.post('/vaults/:vaultId/folders', async (c) => {
  const { vaultId } = readParams(c, VaultIdRouteParam)
  const body = await readJson(c, CreateFolderBody)
  const tenant = c.get('tenant')

  const row = await withTenant(tenant, async (client) => {
    await assertVaultExists(client, vaultId)
    if (body.parent_id) await assertFolderInVault(client, body.parent_id, vaultId)

    try {
      const r = await client.query(
        `INSERT INTO folders (vault_id, parent_id, name, position)
         VALUES ($1, $2, $3, COALESCE($4, 0))
         RETURNING id, vault_id, parent_id, name, position, updated_at`,
        [vaultId, body.parent_id ?? null, body.name, body.position ?? null],
      )
      return r.rows[0]
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  })
  return c.json(toFolder(row), 201)
})

folders.patch('/folders/:id', async (c) => {
  const { id } = readParams(c, FolderIdParam)
  const body = await readJson(c, UpdateFolderBody)
  const tenant = c.get('tenant')

  const row = await withTenant(tenant, async (client) => {
    const existing = await loadFolder(client, id)
    if (body.parent_id !== undefined && body.parent_id !== null) {
      if (body.parent_id === id) throw InvalidInput('folder cannot be its own parent')
      await assertFolderInVault(client, body.parent_id, existing.vault_id)
      // Cycle prevention: walk the proposed parent chain upward and reject if
      // we re-encounter `id`.
      await assertNoCycle(client, body.parent_id, id)
    }
    try {
      const r = await client.query(
        `UPDATE folders
            SET name = COALESCE($2, name),
                parent_id = CASE WHEN $4::boolean THEN $3 ELSE parent_id END,
                position = COALESCE($5, position),
                updated_at = now()
          WHERE id = $1
          RETURNING id, vault_id, parent_id, name, position, updated_at`,
        [
          id,
          body.name ?? null,
          body.parent_id ?? null,
          body.parent_id !== undefined,
          body.position ?? null,
        ],
      )
      if (r.rowCount === 0) throw NotFound('folder not found')
      return r.rows[0]
    } catch (err) {
      throw mapUniqueViolation(err)
    }
  })
  return c.json(toFolder(row))
})

folders.delete('/folders/:id', async (c) => {
  const { id } = readParams(c, FolderIdParam)
  const tenant = c.get('tenant')
  await withTenant(tenant, async (client) => {
    const r = await client.query(`DELETE FROM folders WHERE id = $1`, [id])
    if (r.rowCount === 0) throw NotFound('folder not found')
  })
  return c.body(null, 204)
})

async function loadFolder(client: PgClient, id: string) {
  const r = await client.query(
    `SELECT id, vault_id, parent_id, name, position, updated_at
       FROM folders WHERE id = $1`,
    [id],
  )
  if (r.rowCount === 0) throw NotFound('folder not found')
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

async function assertNoCycle(
  client: PgClient,
  startId: string,
  forbiddenId: string,
): Promise<void> {
  // Recursive CTE up the parent chain.
  const r = await client.query<{ id: string }>(
    `WITH RECURSIVE chain AS (
       SELECT id, parent_id FROM folders WHERE id = $1
       UNION ALL
       SELECT f.id, f.parent_id
         FROM folders f
         JOIN chain c ON c.parent_id = f.id
     )
     SELECT id FROM chain WHERE id = $2 LIMIT 1`,
    [startId, forbiddenId],
  )
  if (r.rowCount !== null && r.rowCount > 0) {
    throw InvalidInput('move would create a folder cycle')
  }
}

function mapUniqueViolation(err: unknown): Error {
  if (err && typeof err === 'object' && (err as { code?: string }).code === '23505') {
    return Conflict('folder name already exists at this level', { code: 'duplicate_folder' })
  }
  return err as Error
}
