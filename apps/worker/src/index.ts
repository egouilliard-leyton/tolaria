import PgBoss from 'pg-boss'
import pino from 'pino'
import { loadEnv } from './env.js'
import { handleIndexNote, IndexNotePayload } from './handlers/index-note.js'

const env = loadEnv()
const logger = pino({ level: env.LOG_LEVEL, base: { app: 'tolaria-worker' } })

async function main(): Promise<void> {
  const boss = new PgBoss({ connectionString: env.DATABASE_URL })
  boss.on('error', (err) => logger.error({ err }, 'pg-boss error'))

  await boss.start()
  logger.info('pg-boss started')

  await boss.work<unknown>(
    'index-note',
    { teamSize: env.WORKER_CONCURRENCY, teamConcurrency: 1 },
    async ([job]) => {
      const payload = IndexNotePayload.parse(job.data)
      await handleIndexNote(payload)
    },
  )

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down worker')
    await boss.stop({ graceful: true, timeout: 10_000 })
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
}

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start')
  process.exit(1)
})
