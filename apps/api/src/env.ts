import { z } from 'zod'

// Single source of truth for every server env var used by apps/api.
// Anything missing or weak makes the process refuse to start — see ADR-0115
// for why we treat env as a hard boundary.

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),

  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().positive().default(8787),
  API_PUBLIC_URL: z.string().url(),
  WEB_PUBLIC_URL: z.string().url(),

  DATABASE_URL: z.string().min(1),
  DATABASE_MIGRATOR_URL: z.string().min(1).optional(),
  DATABASE_POOL_MAX: z.coerce.number().int().positive().default(10),

  AUTH_JWT_SECRET: z
    .string()
    .min(32, 'AUTH_JWT_SECRET must be at least 32 bytes; generate with `openssl rand -base64 48`'),
  AUTH_JWT_ACCESS_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  AUTH_JWT_REFRESH_TTL_SECONDS: z.coerce.number().int().positive().default(60 * 60 * 24 * 30),
  AUTH_REFRESH_COOKIE_NAME: z.string().default('tolaria_refresh'),
  AUTH_REFRESH_COOKIE_DOMAIN: z.string().default('localhost'),
  AUTH_PROVIDER_SECRET_KEY: z
    .string()
    .min(32, 'AUTH_PROVIDER_SECRET_KEY must be exactly 32 bytes for AES-256-GCM'),
  LOCAL_PASSWORD_AUTH: z.coerce.boolean().default(false),

  AUTHENTIK_ISSUER_URL: z.string().url().optional(),
  AUTHENTIK_CLIENT_ID: z.string().optional(),
  AUTHENTIK_CLIENT_SECRET: z.string().optional(),
  AUTHENTIK_DEFAULT_SCOPES: z.string().default('openid profile email'),

  R2_ENDPOINT: z.string().url(),
  R2_ACCOUNT_ID: z.string().min(1),
  R2_ACCESS_KEY_ID: z.string().min(1),
  R2_SECRET_ACCESS_KEY: z.string().min(1),
  R2_BUCKET: z.string().min(1),
  R2_PRESIGN_PUT_TTL_SECONDS: z.coerce.number().int().positive().default(300),
  R2_PRESIGN_GET_TTL_SECONDS: z.coerce.number().int().positive().default(600),

  LITELLM_BASE_URL: z.string().url(),
  LITELLM_TOKEN: z.string().min(1),
})

export type Env = z.infer<typeof Schema>

let cached: Env | null = null

export function loadEnv(): Env {
  if (cached) return cached
  const parsed = Schema.safeParse(process.env)
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n')
    throw new Error(`Invalid environment configuration:\n${issues}`)
  }
  cached = parsed.data
  return cached
}
