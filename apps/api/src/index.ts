import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { loadEnv } from './env.js'
import { logger } from './lib/logger.js'
import { errorHandler } from './middleware/error-handler.js'
import { securityHeaders } from './middleware/security-headers.js'
import { buildAppRoutes } from './routes/index.js'

const env = loadEnv()

const app = new Hono()
app.onError(errorHandler)
// Mount security headers BEFORE the route tree so every response (including
// errors emitted by `errorHandler`) gets CSP + nosniff + frame-ancestors.
app.use('*', securityHeaders)
app.route('/', buildAppRoutes())

const server = serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  logger.info({ host: info.address, port: info.port }, 'tolaria-api listening')
})

const shutdown = (signal: string) => {
  logger.info({ signal }, 'received shutdown signal')
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
