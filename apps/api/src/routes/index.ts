// Route mounting. Each feature stream owns one file under routes/.
// Stubs are exported here so the main entry can mount them unconditionally
// once the corresponding agent ships its real implementation.

import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth.js'
import { withTenantContext } from '../middleware/tenant.js'
import { health } from './health.js'

export function buildAppRoutes(): Hono {
  const app = new Hono()
  app.route('/', health)

  // Authed surface. Each route module is a Hono sub-app and is mounted under
  // the requireAuth + withTenantContext gate. The placeholder modules
  // intentionally return 501 until their owning agent ships the real impl.
  const authed = new Hono().use('*', requireAuth, withTenantContext)
  authed.all('/me', notImplemented('agent A'))
  authed.all('/vaults', notImplemented('agent B'))
  authed.all('/vaults/*', notImplemented('agent B'))
  authed.all('/notes/*', notImplemented('agent B'))
  authed.all('/folders/*', notImplemented('agent B'))
  authed.all('/attachments/*', notImplemented('agent D'))
  authed.all('/ai/*', notImplemented('agent E'))
  authed.all('/admin/sso/*', notImplemented('agent C'))
  authed.all('/admin/users/*', notImplemented('agent C'))

  app.route('/', authed)
  return app
}

function notImplemented(owner: string) {
  return (c: import('hono').Context) =>
    c.json(
      {
        error: {
          code: 'not_implemented',
          message: `Route not yet implemented (owner: ${owner}); see docs/ARCHITECTURE-WEB-SAAS.md §5.`,
        },
      },
      501,
    )
}
