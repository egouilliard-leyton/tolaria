// Producer for the `backfill-embeddings` queue.
//
// Admins can re-run embedding indexing across an entire vault — for
// example after enabling `LITELLM_EMBEDDING_MODEL` for the first time,
// after swapping the model, or after a budget pause cleared. The worker
// fans the request out into one `index-note` job per non-deleted note in
// the vault; the per-tenant daily budget tracker in `embedding_budgets`
// keeps the spend bounded.
//
// See Bundle F in docs/web-saas/audit-2026-05-10.md.

import { enqueue, type JobPayloads } from './index.js'

export type BackfillEmbeddingsPayload = JobPayloads['backfill-embeddings']

/**
 * Schedule an embedding backfill for one vault. Returns the pg-boss job
 * id (or null if the producer is currently unavailable — the API never
 * blocks a route on enqueue success). One backfill per (subscription,
 * vault) is admitted at a time via a singleton key.
 */
export async function enqueueBackfillEmbeddings(
  subscriptionId: string,
  vaultId: string,
): Promise<string | null> {
  return enqueue(
    'backfill-embeddings',
    { subscriptionId, vaultId },
    {
      singletonKey: `backfill-embeddings:${subscriptionId}:${vaultId}`,
      retryLimit: 3,
    },
  )
}
