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
  // Optional embedding model name routed through LiteLLM. When empty the
  // worker's embedding pipeline in `handleIndexNote` is disabled silently
  // and only the `to_tsvector` upsert runs (Bundle F).
  LITELLM_EMBEDDING_MODEL: z.string().default(''),
  // Output dimensionality of the embedding model. Must match the pgvector
  // column width on `note_search.embedding` (1536 per 0001_init.sql).
  EMBEDDING_DIMS: z.coerce.number().int().positive().default(1536),
  // Per-tenant daily budget cap for embedding spend, in cents. Enforced
  // via the `embedding_budgets` table in 0005_embedding_budgets.sql.
  EMBEDDING_BUDGET_CENTS_PER_TENANT_PER_DAY: z.coerce
    .number()
    .int()
    .positive()
    .default(100),
  // Grace window for the unverified-attachment sweep.
  R2_UNVERIFIED_GRACE_INTERVAL: z.string().default('1 hour'),
  // Audit log retention. The daily `audit-log-purge` job DELETEs rows older
  // than this many days. Default 365; lower in dev, raise for compliance.
  AUDIT_LOG_RETENTION_DAYS: z.coerce.number().int().positive().default(365),
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
