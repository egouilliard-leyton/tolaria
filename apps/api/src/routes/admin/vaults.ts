// /admin/vaults/:id/reindex — admin-triggered embedding backfill for an
// entire vault. The route enqueues a `backfill-embeddings` job; the
// worker enumerates every non-deleted note in pages of 50 and fans them
// out through the `index-note` queue so the embedding pipeline (gated by
// `LITELLM_EMBEDDING_MODEL` + per-tenant daily budget) gets a chance to
// populate `note_search.embedding`.
//
// Owner-or-admin role gate. The vault must belong to the calling
// tenant's subscription; RLS enforces this implicitly but we also do a
// SELECT inside `withTenant` so we can return a clean 404 instead of an
// opaque pg-boss failure when an attacker probes someone else's vaults.

import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../../db.js'
import { enqueueBackfillEmbeddings } from '../../jobs/backfill-embeddings.js'
import { writeAudit } from '../../lib/audit.js'
import { InvalidInput, NotFound } from '../../lib/errors.js'
import { requireRole } from '../../middleware/require-role.js'

const UuidSchema = z.string().uuid()

export const vaultsAdmin = new Hono()

vaultsAdmin.use('*', requireRole('owner', 'admin'))

vaultsAdmin.post('/:id/reindex', async (c) => {
  const idParse = UuidSchema.safeParse(c.req.param('id'))
  if (!idParse.success) throw InvalidInput('Invalid vault id')
  const vaultId = idParse.data
  const tenant = c.get('tenant')

  await withTenant(tenant, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM vaults
        WHERE id = $1 AND subscription_id = $2 AND deleted_at IS NULL`,
      [vaultId, tenant.subscriptionId],
    )
    if (rows.length === 0) throw NotFound('Vault not found')
    await writeAudit(client, tenant, 'vault.reindex', vaultId, { vault_id: vaultId })
  })

  const jobId = await enqueueBackfillEmbeddings(tenant.subscriptionId, vaultId)
  return c.json({ accepted: true, jobId }, 202)
})
