import { z } from 'zod'

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  DATABASE_URL: z.string().min(1),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(4),
  // R2 — required for the `r2-gc` handler. Uses the same env names as the
  // API's `services/r2.ts` so a single deployment env file works for both.
  R2_ENDPOINT: z.string().min(1).default(''),
  R2_ACCESS_KEY_ID: z.string().min(1).default(''),
  R2_SECRET_ACCESS_KEY: z.string().min(1).default(''),
  R2_BUCKET: z.string().min(1).default(''),
  // LiteLLM — required for the `ai-tool-run` handler.
  LITELLM_BASE_URL: z.string().url().default('http://litellm.invalid'),
  LITELLM_TOKEN: z.string().min(1).default(''),
  // Grace window for the unverified-attachment sweep.
  R2_UNVERIFIED_GRACE_INTERVAL: z.string().default('1 hour'),
})

export type WorkerEnv = z.infer<typeof Schema>

let cached: WorkerEnv | null = null

export function loadEnv(): WorkerEnv {
  if (cached) return cached
  const parsed = Schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid worker environment:\n${issues}`)
  }
  cached = parsed.data
  return cached
}
