import type { Job } from 'pg-boss'
import { z } from 'zod'
import { withTenant } from '../lib/db.js'
import { deleteObject } from '../lib/r2.js'
import { loadEnv } from '../env.js'

const R2GcPayload = z.object({
  subscriptionId: z.string().uuid(),
  attachmentId: z.string().uuid().or(z.string().length(0)),
  keyR2: z.string().optional(),
  mode: z.enum(['single', 'unverified-sweep']).optional(),
})
export type R2GcPayload = z.infer<typeof R2GcPayload>

/**
 * Delete an attachment's R2 bytes and metadata row.
 *
 * Order matters: we delete the R2 object first, then the row, so a crash
 * between the two leaves us with a row pointing at an already-gone key —
 * harmless because the next pass is idempotent. Doing it the other way
 * around would leak orphaned bytes if the row delete succeeded but R2
 * blew up.
 *
 * `mode: 'unverified-sweep'` switches into a per-subscription sweep over
 * `attachments` rows whose `verified_at IS NULL` and `created_at` is older
 * than `R2_UNVERIFIED_GRACE_INTERVAL`. That is what the producer schedules
 * on a periodic timer so abandoned uploads do not pile up forever.
 */
export async function handleR2Gc(job: Job<unknown>): Promise<void> {
  const payload = R2GcPayload.parse(job.data)

  if (payload.mode === 'unverified-sweep') {
    await runUnverifiedSweep(payload.subscriptionId)
    return
  }

  await deleteOne(payload.subscriptionId, payload.attachmentId, payload.keyR2)
}

async function deleteOne(
  subscriptionId: string,
  attachmentId: string,
  keyOverride: string | undefined,
): Promise<void> {
  if (!attachmentId) return
  const ctx = { subscriptionId }

  // Resolve the R2 key from the row when the producer didn't supply one.
  // We do this before the R2 delete so a partial cleanup on retry still
  // finds the right key.
  const key = await withTenant(ctx, async (client) => {
    if (keyOverride) return keyOverride
    const { rows } = await client.query<{ key_r2: string }>(
      `SELECT key_r2 FROM attachments WHERE id = $1`,
      [attachmentId],
    )
    return rows[0]?.key_r2 ?? null
  })

  if (key) {
    // deleteObject treats a 404 as success internally so a retry after a
    // partially-completed run does not blow up.
    await deleteObject(key)
  }

  await withTenant(ctx, async (client) => {
    await client.query(`DELETE FROM attachments WHERE id = $1`, [attachmentId])
  })
}

async function runUnverifiedSweep(subscriptionId: string): Promise<void> {
  const env = loadEnv()
  const ctx = { subscriptionId }

  const candidates = await withTenant(ctx, async (client) => {
    const { rows } = await client.query<{ id: string; key_r2: string }>(
      `SELECT id, key_r2
         FROM attachments
        WHERE verified_at IS NULL
          AND created_at < now() - $1::interval`,
      [env.R2_UNVERIFIED_GRACE_INTERVAL],
    )
    return rows
  })

  for (const row of candidates) {
    await deleteOne(subscriptionId, row.id, row.key_r2)
  }
}
