import { Hono } from 'hono'
import { pingDb } from '../db.js'
import { loadEnv } from '../env.js'

const env = loadEnv()
export const health = new Hono()

health.get('/healthz', (c) => c.json({ status: 'ok' }))

health.get('/readyz', async (c) => {
  const checks: Record<string, 'ok' | string> = {}
  try {
    await pingDb()
    checks.database = 'ok'
  } catch (err) {
    checks.database = (err as Error).message
  }

  // R2 and LiteLLM pings are intentionally lightweight: HEAD the bucket and
  // GET /health on LiteLLM. They're wired up in the respective service
  // modules; here we only check that the URLs are configured. The full pings
  // land with agent D (R2) and agent E (LiteLLM).
  checks.r2_endpoint = env.R2_ENDPOINT ? 'configured' : 'missing'
  checks.litellm_endpoint = env.LITELLM_BASE_URL ? 'configured' : 'missing'

  const allOk = Object.values(checks).every((v) => v === 'ok' || v === 'configured')
  return c.json({ status: allOk ? 'ok' : 'degraded', checks }, allOk ? 200 : 503)
})
