import type { Job } from 'pg-boss'
import { z } from 'zod'
import { withTenant } from '../lib/db.js'
import { enqueueIndexNote } from '../lib/jobs.js'

const RebuildVaultIndexPayload = z.object({
  subscriptionId: z.string().uuid(),
  vaultId: z.string().uuid(),
})
export type RebuildVaultIndexPayload = z.infer<typeof RebuildVaultIndexPayload>

/**
 * Enumerate every non-deleted note in the vault and enqueue an
 * `index-note` job for each. Idempotent: re-running just re-fans the
 * same set of `index-note` jobs and the index-note handler dedupes
 * against the latest note state on its own.
 */
export async function handleRebuildVaultIndex(
  job: Job<unknown>,
): Promise<void> {
  const payload = RebuildVaultIndexPayload.parse(job.data)

  const ids = await withTenant(
    { subscriptionId: payload.subscriptionId },
    async (client) => {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM notes
          WHERE vault_id = $1 AND deleted_at IS NULL`,
        [payload.vaultId],
      )
      return rows.map((r) => r.id)
    },
  )

  for (const id of ids) {
    await enqueueIndexNote({
      subscriptionId: payload.subscriptionId,
      vaultId: payload.vaultId,
      noteId: id,
    })
  }
}
