import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { pool } from './db.js'
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
// Cross-origin requests from the web SPA (typically served on a different
// origin from the API in dev — :5201 vs :8787) need an explicit CORS allow.
// Without this, every fetch from the SPA fails the browser preflight or the
// `credentials: 'include'` cookie attachment. The allowed origin is pinned
// to `env.WEB_PUBLIC_URL` (validated as a URL by env.ts) so we never echo an
// arbitrary `Origin` header back. Mounted before `buildAppRoutes()` so the
// CORS headers are present on every authed and unauthed route.
app.use(
  '*',
  cors({
    origin: env.WEB_PUBLIC_URL,
    credentials: true,
    allowHeaders: ['Authorization', 'Content-Type'],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  }),
)
app.route('/', buildAppRoutes())

const server = serve({ fetch: app.fetch, hostname: env.API_HOST, port: env.API_PORT }, (info) => {
  logger.info({ host: info.address, port: info.port }, 'tolaria-api listening')
})

const shutdown = (signal: string) => {
  logger.info({ signal }, 'received shutdown signal')
  // Close the HTTP listener first so we stop accepting new connections, then
  // drain the pg pool so in-flight `pool.connect()` calls cannot keep the
  // process pinned past the listener close. Without `pool.end()` the process
  // would idle until the 10s force-exit fallback below fires.
  server.close(() => {
    pool
      .end()
      .catch((err) => logger.error({ err }, 'failed to drain pg pool on shutdown'))
      .finally(() => process.exit(0))
  })
  setTimeout(() => process.exit(1), 10_000).unref()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
