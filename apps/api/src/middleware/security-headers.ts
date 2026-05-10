// Security headers — CSP plus the usual hardening pile.
//
// We mount this as the OUTERMOST middleware so it lands on every response,
// including 4xx/5xx error responses produced by `errorHandler`. The CSP is
// derived from configured env so the dev/staging/prod hosts are all covered
// without touching the middleware: connect-src expands to include the
// configured R2 endpoint and the LiteLLM base URL.
//
// Health endpoints are exempt: orchestrators (kube readiness probe, Tauri
// dev tunnel, uptime monitors) inspect those bodies/headers without a
// browser context, so CSP is irrelevant and only adds noise to the probe
// output. Everything else gets the headers.
//
// See docs/ARCHITECTURE-WEB-SAAS.md §9.

import type { MiddlewareHandler } from 'hono'
import { loadEnv } from '../env.js'

const env = loadEnv()

const HEALTH_PATHS = new Set<string>(['/healthz', '/readyz'])

const r2Origin = safeOrigin(env.R2_ENDPOINT)
const liteOrigin = safeOrigin(env.LITELLM_BASE_URL)

const CSP_VALUE = [
  "default-src 'self'",
  `img-src 'self' ${r2Origin} data:`,
  `connect-src 'self' ${r2Origin} ${liteOrigin}`,
  "script-src 'self'",
  // shadcn/ui ships inline `<style>` blocks for class-variance-authority
  // generated styles, so we allow inline styles. Inline scripts remain banned.
  "style-src 'self' 'unsafe-inline'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ')

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next()
  if (HEALTH_PATHS.has(c.req.path)) return
  c.header('Content-Security-Policy', CSP_VALUE)
  c.header('X-Content-Type-Options', 'nosniff')
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin')
  c.header('X-Frame-Options', 'DENY')
}

function safeOrigin(raw: string): string {
  try {
    return new URL(raw).origin
  } catch {
    // Env validation in env.ts already enforces .url(), but if a future
    // edit ever loosens that, fall through to a no-op origin instead of
    // crashing the whole process.
    return "''"
  }
}
