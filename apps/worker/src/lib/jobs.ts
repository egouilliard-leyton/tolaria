// Worker-side pg-boss producer.
//
// Some handlers fan out by enqueueing more jobs (e.g. propagate-rename
// re-enqueues index-note for every affected note; rebuild-vault-index
// enqueues an index-note per note in the vault). We keep our own thin
// producer instead of borrowing from `@tolaria/api` so the worker stays
// self-contained and there is no cross-package import path tying us to
// the API's bundle layout.
//
// Like the API's producer, this is supervise/schedule disabled — the
// worker's main pg-boss instance handles maintenance.

import PgBoss from 'pg-boss'
import { loadEnv } from '../env.js'

let bossPromise: Promise<PgBoss> | null = null

async function getBoss(): Promise<PgBoss> {
  if (!bossPromise) {
    const env = loadEnv()
    const boss = new PgBoss({
      connectionString: env.DATABASE_URL,
      application_name: 'tolaria-worker-jobs',
      supervise: false,
      schedule: false,
    })
    bossPromise = boss.start()
  }
  return bossPromise
}

export interface IndexNoteJob {
  subscriptionId: string
  vaultId: string
  noteId: string
}

export interface EnqueueOptions {
  startAfter?: number | string | Date
  singletonKey?: string
  retryLimit?: number
}

export async function enqueue(
  name: string,
  payload: Record<string, unknown>,
  opts: EnqueueOptions = {},
): Promise<string | null> {
  const boss = await getBoss()
  return boss.send(name, payload, opts)
}

export async function enqueueIndexNote(job: IndexNoteJob): Promise<string | null> {
  return enqueue('index-note', job as unknown as Record<string, unknown>, {
    // Coalesce repeated index requests for the same note while one is
    // still queued so we don't re-index a hot note dozens of times.
    singletonKey: `index-note:${job.noteId}`,
  })
}

/** Test-only: stop the boss so vitest can exit cleanly. */
export async function stopJobsForTests(): Promise<void> {
  if (!bossPromise) return
  const boss = await bossPromise
  bossPromise = null
  await boss.stop({ graceful: true, wait: false }).catch(() => undefined)
}
