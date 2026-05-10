// Shared client-IP resolver used by both the auth route (for audit-log
// `ip` recording) and the rate-limit middleware. Honoring `TRUST_PROXY`
// in only one of the two callers leads to a divergence where rate limits
// see one IP and the audit log records another — a malicious client
// behind a non-trusted edge could spoof their audit identity even though
// the rate limiter would not be fooled. See verification report 2026-05-10
// §3.3.
//
// When TRUST_PROXY=1 we honor the leftmost entry of `x-forwarded-for`,
// matching the existing rate-limit behavior. Otherwise we read the
// underlying Node socket via `@hono/node-server`'s `incoming` shim.
// Returns `null` when neither source is available (most commonly inside
// the `app.request(...)` test harness, where there is no real socket).

import type { Context } from 'hono'
import { loadEnv } from '../env.js'

const env = loadEnv()

/**
 * Resolve the best-known client IP for the current request.
 *
 * - If `TRUST_PROXY=1` and `X-Forwarded-For` is present, use its leftmost entry.
 * - Otherwise fall back to the Node socket remote address exposed by
 *   `@hono/node-server` on `c.env.incoming`.
 * - Returns `null` when neither is available.
 */
export function clientIp(c: Context): string | null {
  if (env.TRUST_PROXY) {
    const fwd = c.req.header('x-forwarded-for')?.split(',')[0]?.trim()
    if (fwd) return fwd
  }
  // @hono/node-server exposes the underlying http.IncomingMessage on
  // `c.env.incoming`; the socket carries the peer's remote address.
  const remote = (
    c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined
  )?.incoming?.socket?.remoteAddress
  return remote ?? null
}
