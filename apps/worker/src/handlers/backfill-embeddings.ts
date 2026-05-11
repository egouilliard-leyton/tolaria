// `backfill-embeddings` worker handler.
//
// Re-fans every non-deleted note in the vault through the `index-note`
// queue so the embedding pipeline (gated by `LITELLM_EMBEDDING_MODEL`)
// gets a chance to populate `note_search.embedding`. Notes are read in
// fixed-size pages of 50 to keep memory pressure bounded for very large
// vaults — pg-boss serializes the enqueues anyway, but the page boundary
// also gives us a natural checkpoint if the worker is restarted mid-run.
//
// Idempotent: re-running this job re-fans the same set of `index-note`
// jobs and `handleIndexNote` is itself idempotent against the latest
// note state. The embedding write is additionally guarded by the
// per-tenant daily budget in `embedding_budgets`.

import type { Job } from 'pg-boss'
import { z } from 'zod'
import { withTenant } from '../lib/db.js'
import { enqueueIndexNote } from '../lib/jobs.js'

const BackfillEmbeddingsPayload = z.object({
  subscriptionId: z.string().uuid(),
  vaultId: z.string().uuid(),
})
export type BackfillEmbeddingsPayload = z.infer<typeof BackfillEmbeddingsPayload>

const PAGE_SIZE = 50

export async function handleBackfillEmbeddings(job: Job<unknown>): Promise<void> {
  const payload = BackfillEmbeddingsPayload.parse(job.data)

  let lastId: string | null = null
  for (;;) {
    const page: string[] = await withTenant(
      { subscriptionId: payload.subscriptionId },
      async (client) => {
        // Keyset pagination on `id` — the column is a uuid PK so it gives
        // us a stable cursor without needing a separate ORDER BY column.
        const { rows } = await client.query<{ id: string }>(
          lastId
            ? `SELECT id FROM notes
                WHERE vault_id = $1
                  AND deleted_at IS NULL
                  AND id > $2
                ORDER BY id ASC
                LIMIT ${PAGE_SIZE}`
            : `SELECT id FROM notes
                WHERE vault_id = $1
                  AND deleted_at IS NULL
                ORDER BY id ASC
                LIMIT ${PAGE_SIZE}`,
          lastId ? [payload.vaultId, lastId] : [payload.vaultId],
        )
        return rows.map((r) => r.id)
      },
    )

    if (page.length === 0) break

    for (const id of page) {
      await enqueueIndexNote({
        subscriptionId: payload.subscriptionId,
        vaultId: payload.vaultId,
        noteId: id,
      })
    }

    if (page.length < PAGE_SIZE) break
    lastId = page[page.length - 1] ?? null
  }
}
