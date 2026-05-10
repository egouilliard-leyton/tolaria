// Role-gate middleware factory. Builds a Hono middleware that throws 403 if
// the authenticated user does not satisfy one of the supplied roles. Must be
// mounted *after* `requireAuth` — it relies on `c.get('user').role`.
//
// Roles are flat (`owner` > `admin` > `member`); the factory accepts the
// explicit set of roles that pass, so a route can opt in to "owner only" or
// "owner or admin" without us hard-coding a hierarchy here.

import type { MiddlewareHandler } from 'hono'
import { Forbidden } from '../lib/errors.js'

export type Role = 'owner' | 'admin' | 'member'

/**
 * Create middleware that allows the request only if `c.get('user').role` is
 * one of the supplied roles. Throws `Forbidden` (403) otherwise.
 *
 * Examples:
 *   requireRole('owner')              // owners only
 *   requireRole('owner', 'admin')     // owners or admins
 */
export function requireRole(...allowed: ReadonlyArray<Role>): MiddlewareHandler {
  if (allowed.length === 0) {
    throw new Error('requireRole(): supply at least one role')
  }
  const allowedSet = new Set<Role>(allowed)
  return async (c, next) => {
    const user = c.get('user')
    if (!user || !allowedSet.has(user.role)) {
      throw Forbidden(
        `This action requires role: ${allowed.join(' or ')}`,
      )
    }
    await next()
  }
}
