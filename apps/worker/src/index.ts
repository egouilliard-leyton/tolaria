import PgBoss from 'pg-boss'
import pino from 'pino'
import { loadEnv } from './env.js'
import { handleIndexNote, IndexNotePayload } from './handlers/index-note.js'
import { handlePropagateRename } from './handlers/propagate-rename.js'
import { handleR2Gc } from './handlers/r2-gc.js'
import { handleAiToolRun } from './handlers/ai-tool-run.js'
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

  logger.info(
    {
      queues: [
        'index-note',
        'propagate-rename',
        'r2-gc',
        'ai-tool-run',
        'rebuild-vault-index',
      ],
    },
    'worker handlers registered',
  )

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await boss.stop({ graceful: true, timeout: 10_000 })
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
