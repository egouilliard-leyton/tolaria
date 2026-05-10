// Worker-side R2 client. Mirrors the env-derived layout in
// `apps/api/src/services/r2.ts` — separate copy because the worker package
// does not import from `@tolaria/api` (the API has no `exports` field, and
// keeping the worker self-contained avoids accidentally pulling Hono / route
// transitive deps into the worker bundle).
//
// Surface kept minimal: just `deleteObject` because that is the only thing
// the `r2-gc` handler needs. A 404 from R2 is treated as success so the
// handler is retry-safe — pg-boss may re-deliver a job after we already
// reaped the object on a previous attempt.

import { DeleteObjectCommand, S3Client } from '@aws-sdk/client-s3'
import { loadEnv } from '../env.js'

let cachedClient: S3Client | null = null
let cachedBucket: string | null = null

function getClient(): { client: S3Client; bucket: string } {
  if (!cachedClient) {
    const env = loadEnv()
    cachedClient = new S3Client({
      region: 'auto',
      endpoint: env.R2_ENDPOINT,
      credentials: {
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
      },
      forcePathStyle: true,
    })
    cachedBucket = env.R2_BUCKET
  }
  return { client: cachedClient, bucket: cachedBucket as string }
}

export async function deleteObject(key: string): Promise<void> {
  const { client, bucket } = getClient()
  try {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
  } catch (err) {
    if (isNotFound(err)) return // already gone — treat as success
    throw err
  }
}

function isNotFound(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } }
  if (e.name === 'NotFound' || e.name === 'NoSuchKey') return true
  return e.$metadata?.httpStatusCode === 404
}

// Test-only: drop the cached client so module mocks can re-init env.
export function __resetR2ClientForTests(): void {
  cachedClient = null
  cachedBucket = null
}
