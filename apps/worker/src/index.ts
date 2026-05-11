import PgBoss from 'pg-boss'
import pino from 'pino'
import { loadEnv } from './env.js'
import { pool } from './lib/db.js'
import { handleIndexNote, IndexNotePayload } from './handlers/index-note.js'
import { handlePropagateRename } from './handlers/propagate-rename.js'
import { handleR2Gc } from './handlers/r2-gc.js'
import { handleAiToolRun } from './handlers/ai-tool-run.js'
import { handleAuditLogPurge } from './handlers/audit-log-purge.js'
import { handleRebuildVaultIndex } from './handlers/rebuild-vault-index.js'

const env = loadEnv()
const logger = pino({ level: env.LOG_LEVEL, base: { app: 'tolaria-worker' } })

async function main(): Promise<void> {
  // pg-boss v10 installs / migrates its own `pgboss` schema on `start()` using
  // the supplied connection string. The default schema name is `pgboss`; pass
  // `{ schema: '...' }` if a different namespace is required. See
  // https://github.com/timgit/pg-boss/blob/master/docs/configuration.md
  const boss = new PgBoss({ connectionString: env.DATABASE_URL })
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'))

  const schemaVersionBefore = await safeSchemaVersion(boss)
  await boss.start()
  const schemaVersionAfter = await safeSchemaVersion(boss)
  logger.info(
    {
      schemaVersionBefore,
      schemaVersionAfter,
      installed: schemaVersionBefore === null && schemaVersionAfter !== null,
    },
    'pg-boss started',
  )

  // pg-boss v10 dispatches a *batch* of jobs to each handler invocation;
  // `batchSize` replaces the v9 `teamSize` / `teamConcurrency` knobs. We still
  // process one job per call by destructuring the head of the array.
  const workOptions = { batchSize: env.WORKER_CONCURRENCY }

  await boss.work<unknown>('index-note', workOptions, async ([job]) => {
    if (!job) return
    const payload = IndexNotePayload.parse(job.data)
    await handleIndexNote(payload)
  })

  await boss.work<unknown>('propagate-rename', workOptions, async ([job]) => {
    if (!job) return
    await handlePropagateRename(job)
  })

  await boss.work<unknown>('r2-gc', workOptions, async ([job]) => {
    if (!job) return
    await handleR2Gc(job)
  })

  await boss.work<unknown>('ai-tool-run', workOptions, async ([job]) => {
    if (!job) return
    await handleAiToolRun(job)
  })

  await boss.work<unknown>('rebuild-vault-index', workOptions, async ([job]) => {
    if (!job) return
    await handleRebuildVaultIndex(job)
  })

  await boss.work<unknown>('audit-log-purge', workOptions, async ([job]) => {
    if (!job) return
    await handleAuditLogPurge(job)
  })

  // Periodic sweep for abandoned uploads (ADR-0116 §4). The handler is
  // idempotent and reads the grace interval from
  // `R2_UNVERIFIED_GRACE_INTERVAL` (default '1 hour'). When invoked with
  // no `subscriptionId` it enumerates the tenants that currently have
  // stale unverified rows and runs the sweep once per tenant under the
  // appropriate `withTenant` scope so RLS stays honest. `singletonKey`
  // keeps a slow sweep from being dispatched twice concurrently.
  await boss.schedule(
    'r2-gc',
    '*/10 * * * *',
    { mode: 'unverified-sweep' },
    { singletonKey: 'unverified-sweep' },
  )

  // Daily audit-log retention sweep (Bundle H §6). Runs at 03:00 UTC under a
  // singleton key so a slow purge never gets dispatched concurrently. The
  // handler reads AUDIT_LOG_RETENTION_DAYS at execution time so tuning the
  // env var is a redeploy-free knob.
  await boss.schedule(
    'audit-log-purge',
    '0 3 * * *',
    {},
    { singletonKey: 'audit-log-purge' },
  )

  logger.info(
    {
      queues: [
        'index-note',
        'propagate-rename',
        'r2-gc',
        'ai-tool-run',
        'rebuild-vault-index',
        'audit-log-purge',
      ],
    },
    'worker handlers registered',
  )

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await boss.stop({ graceful: true, timeout: 10_000 })
    // Drain the worker's pg pool after pg-boss releases its own clients so
    // in-flight handlers cannot keep the process pinned past `boss.stop()`.
    try {
      await pool.end()
    } catch (err) {
      logger.error({ err }, 'failed to drain pg pool on shutdown')
    }
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

/**
 * `schemaVersion()` throws if the pgboss schema does not yet exist. Treat that
 * as "fresh install" and return null so the boot log can surface it.
 */
async function safeSchemaVersion(boss: PgBoss): Promise<number | null> {
  try {
    const v = await boss.schemaVersion()
    return Number(v)
  } catch {
    return null
  }
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start')
  process.exit(1)
})
