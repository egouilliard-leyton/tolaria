// Thin pg-boss producer. Lazy-init a single process-wide instance against
// DATABASE_URL; route handlers only call `enqueue(name, payload)`.
//
// We keep the surface tiny: workers and the schedule wiring live in
// apps/worker. The API only writes jobs.

import PgBoss from 'pg-boss'
import { loadEnv } from '../env.js'
import { logger } from '../lib/logger.js'

let bossPromise: Promise<PgBoss> | null = null

async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const env = loadEnv()
    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      application_name: 'tolaria-api-jobs',
      // Producer-only — disable maintenance and supervision so the API does
      // not race the worker on housekeeping.
      supervise: false,
      schedule: false,
    })
    boss.on('error', (err) => logger.error({ err }, 'pg-boss error'))
    bossPromise = boss.start()
  }
  return bossPromise
}

export interface JobPayloads {
  'index-note': { subscriptionId: string; vaultId: string; noteId: string }
  'propagate-rename': {
    subscriptionId: string
    vaultId: string
    fromPath: string
    toPath: string
    // Slug-only forms used by the worker to refresh `note_links`/`ts_doc`
    // for every note touched by the rename SQL. The route already updated
    // the bodies; the worker just rebuilds derived state.
    fromSlug?: string
    toSlug?: string
    affectedNoteIds?: string[]
  }
  // Async R2 + metadata cleanup. The worker deletes the R2 object first, then
  // removes the attachments row only if the object delete succeeded. See
  // ADR-0116 §7. Cancellation: we never enqueue twice — pg-boss dedupes by
  // jobId in the consumer if needed.
  //
  // `mode: 'unverified-sweep'` switches the handler to a per-subscription
  // sweep over `attachments` rows whose `verified_at IS NULL` and whose
  // `created_at` is older than the grace window. In that mode `attachmentId`
  // and `keyR2` are unused (pass empty strings).
  'r2-gc': {
    subscriptionId: string
    attachmentId: string
    keyR2?: string
    mode?: 'single' | 'unverified-sweep'
  }
  // Long-running AI tool execution. Currently supports the `summarize-vault`
  // tool; `rebuild-graph` enqueues an index-note for every non-deleted note.
  // Other tool names fail with `unsupported_tool` so the SPA can show a
  // stable error.
  'ai-tool-run': {
    subscriptionId: string
    vaultId: string
    userId: string
    runId: string
    model: string
    tool: 'summarize-vault' | 'rebuild-graph' | string
    args: Record<string, unknown>
  }
  // Full vault reindex. The worker enumerates every non-deleted note in the
  // vault and enqueues `index-note` for each so `note_search`/`note_links`
  // converge to the latest content.
  'rebuild-vault-index': {
    subscriptionId: string
    vaultId: string
  }
}

export type JobName = keyof JobPayloads

export interface EnqueueOptions {
  // Direct passthrough of the few pg-boss options we actually need today.
  startAfter?: number | string | Date
  singletonKey?: string
  retryLimit?: number
}

export async function enqueue<N extends JobName>(
  name: N,
  payload: JobPayloads[N],
  opts: EnqueueOptions = {},
): Promise<string | null> {
  try {
    const boss = await getBoss()
    return await boss.send(name, payload as object, opts)
  } catch (err) {
    // Job enqueue failures must never break a successful write — log and
    // swallow. The indexer also runs a periodic sweep that picks up rows
    // missing from `note_search` so eventual consistency is preserved.
    logger.error({ err, job: name }, 'failed to enqueue job')
    return null
  }
}

/**
 * Convenience producer for the `rebuild-vault-index` queue. Single helper
 * so callers can ergonomically request a full reindex without spelling the
 * payload shape every time.
 */
export async function enqueueRebuildVaultIndex(
  subscriptionId: string,
  vaultId: string,
): Promise<string | null> {
  return enqueue('rebuild-vault-index', { subscriptionId, vaultId }, {
    // One reindex per (subscription, vault) at a time — pg-boss dedupes
    // identical singleton keys.
    singletonKey: `rebuild-vault-index:${subscriptionId}:${vaultId}`,
    retryLimit: 3,
  })
}

/**
 * For tests: stop the singleton so the process can exit cleanly. Not used
 * by production code.
 */
export async function stopJobs(): Promise<void> {
  if (!bossPromise) return
  const boss = await bossPromise
  bossPromise = null
  await boss.stop({ graceful: true, wait: false }).catch(() => undefined)
}
