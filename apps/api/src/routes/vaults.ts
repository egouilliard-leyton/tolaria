// /vaults — list/create/get/update/soft-delete.
// Every query runs inside withTenant() so RLS gates the rows.

import { Hono } from 'hono'
import type { PgClient } from '../db.js'
import { withTenant } from '../db.js'
import { NotFound } from '../lib/errors.js'
import { toVault } from '../lib/mappers.js'
import {
  CreateVaultBody,
  UpdateVaultBody,
  VaultIdParam,
} from '../lib/schemas.js'
import { ensureUniqueSlug, slugify } from '../lib/slug.js'
import { readJson, readParams } from '../lib/validate.js'

export const vaults = new Hono()

vaults.get('/vaults', async (c) => {
  const tenant = c.get('tenant')
  const user = c.get('user')
  const rows = await withTenant(tenant, async (client) => {
    const r = await client.query(
      `SELECT id, slug, name, created_at, settings
         FROM vaults
        WHERE deleted_at IS NULL
          AND subscription_id = $1
        ORDER BY created_at ASC`,
      [user.sid],
    )
    return r.rows
  })
  return c.json({ items: rows.map(toVault) })
})

vaults.post('/vaults', async (c) => {
  const tenant = c.get('tenant')
  const user = c.get('user')
  const body = await readJson(c, CreateVaultBody)

  const baseSlug = slugify(body.slug ?? body.name)
  const settings = body.settings ?? {}

  const vault = await withTenant(tenant, async (client) => {
    const slug = await ensureUniqueSlug(baseSlug, async (candidate) => {
      const r = await client.query(
        `SELECT 1 FROM vaults
          WHERE subscription_id = $1 AND slug = $2`,
        [user.sid, candidate],
      )
      return r.rowCount !== null && r.rowCount > 0
    })
    const r = await client.query(
      `INSERT INTO vaults (subscription_id, name, slug, created_by, settings)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, slug, name, created_at, settings`,
      [user.sid, body.name, slug, user.sub, JSON.stringify(settings)],
    )
    return r.rows[0]
  })
  return c.json(toVault(vault), 201)
})

vaults.get('/vaults/:id', async (c) => {
  const { id } = readParams(c, VaultIdParam)
  const tenant = c.get('tenant')
  const row = await withTenant(tenant, async (client) => loadVault(client, id))
  return c.json(toVault(row))
})

vaults.patch('/vaults/:id', async (c) => {
  const { id } = readParams(c, VaultIdParam)
  const body = await readJson(c, UpdateVaultBody)
  const tenant = c.get('tenant')

  const row = await withTenant(tenant, async (client) => {
    // Confirm it exists (and isn't deleted) so we return 404 vs 200-no-op.
    await loadVault(client, id)
    const r = await client.query(
      `UPDATE vaults
          SET name = COALESCE($2, name),
              settings = COALESCE($3::jsonb, settings)
        WHERE id = $1 AND deleted_at IS NULL
        RETURNING id, slug, name, created_at, settings`,
      [
        id,
        body.name ?? null,
        body.settings === undefined ? null : JSON.stringify(body.settings),
      ],
    )
    if (r.rowCount === 0) throw NotFound('vault not found')
    return r.rows[0]
  })
  return c.json(toVault(row))
})

vaults.delete('/vaults/:id', async (c) => {
  const { id } = readParams(c, VaultIdParam)
  const tenant = c.get('tenant')
  await withTenant(tenant, async (client) => {
    const r = await client.query(
      `UPDATE vaults
          SET deleted_at = now()
        WHERE id = $1 AND deleted_at IS NULL`,
      [id],
    )
    if (r.rowCount === 0) throw NotFound('vault not found')
  })
  return c.body(null, 204)
})

async function loadVault(client: PgClient, id: string) {
  const r = await client.query(
    `SELECT id, slug, name, created_at, settings
       FROM vaults
      WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  )
  if (r.rowCount === 0) throw NotFound('vault not found')
  return r.rows[0]
}

// Re-export a tiny helper so the other route modules can verify a vault exists
// in the same tenant without re-implementing the same boilerplate.
export async function assertVaultExists(client: PgClient, id: string): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM vaults WHERE id = $1 AND deleted_at IS NULL`,
    [id],
  )
  if (r.rowCount === 0) throw NotFound('vault not found')
}

