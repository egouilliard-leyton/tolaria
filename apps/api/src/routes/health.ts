import { Hono } from 'hono'
import { HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { pingDb } from '../db.js'
import { loadEnv } from '../env.js'

const env = loadEnv()
export const health = new Hono()

// Cap upstream probes so a slow/hung dependency cannot stall /readyz.
const PROBE_TIMEOUT_MS = 2_000

health.get('/healthz', (c) => c.json({ status: 'ok' }))

health.get('/readyz', async (c) => {
  const checks: Record<string, 'ok' | string> = {}

  try {
    await pingDb()
    checks.database = 'ok'
  } catch (err) {
    checks.database = (err as Error).message
  }

  checks.r2 = await probeR2()
  checks.litellm = await probeLiteLlm()

  const allOk = Object.values(checks).every((v) => v === 'ok')
  return c.json({ status: allOk ? 'ok' : 'degraded', checks }, allOk ? 200 : 503)
})

/**
 * HEAD the configured R2 bucket. Returns 'ok' on success, an error message
 * otherwise. Wrapped so that a missing/misconfigured S3 SDK module never
 * crashes the probe — degraded ≠ down.
 */
async function probeR2(): Promise<'ok' | string> {
  return withTimeout('r2', async () => {
    try {
      // Build a one-shot client. The hot-path `services/r2.ts` caches its own
      // singleton; we keep the probe self-contained so an env reload during
      // tests doesn't reuse a stale client.
      const client = new S3Client({
        region: 'auto',
        endpoint: env.R2_ENDPOINT,
        credentials: {
          accessKeyId: env.R2_ACCESS_KEY_ID,
          secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        },
        forcePathStyle: true,
      })
      await client.send(new HeadBucketCommand({ Bucket: env.R2_BUCKET }))
      return 'ok'
    } catch (err) {
      return (err as Error).message || 'r2 head failed'
    }
  })
}

/**
 * GET /health on LiteLLM via the canonical client. Defensive: if the client
 * module fails to import (e.g. partial env), report the message instead of
 * letting the probe throw.
 */
async function probeLiteLlm(): Promise<'ok' | string> {
  return withTimeout('litellm', async () => {
    try {
      const { createLiteLlmClient } = await import('../services/litellm.js')
      const result = await createLiteLlmClient().health()
      return result === 'ok' ? 'ok' : result
    } catch (err) {
      return (err as Error).message || 'litellm probe failed'
    }
  })
}

async function withTimeout(
  label: string,
  fn: () => Promise<'ok' | string>,
): Promise<'ok' | string> {
  const timeout = new Promise<string>((resolve) => {
    setTimeout(
      () => resolve(`${label} probe timed out after ${PROBE_TIMEOUT_MS}ms`),
      PROBE_TIMEOUT_MS,
    )
  })
  return Promise.race([fn(), timeout])
}
