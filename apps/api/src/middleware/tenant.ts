import type { MiddlewareHandler } from 'hono'
import type { TenantContext } from '../db.js'

/**
 * After requireAuth has run, expose a TenantContext on the request so
 * handlers can pass it straight to withTenant() / tenantQuery().
 *
 * No DB call is made here — the per-request transaction lives inside the
 * handler, scoped to whatever query it runs.
 */
export const withTenantContext: MiddlewareHandler = async (c, next) => {
  const user = c.get('user')
  const tenant: TenantContext = { subscriptionId: user.sid, userId: user.sub }
  c.set('tenant', tenant)
  await next()
}

declare module 'hono' {
  interface ContextVariableMap {
    tenant: TenantContext
  }
}
