// Route mounting. Each feature stream owns one file under routes/.
// The agents A–E shipped real implementations; this orchestrator file wires
// every sub-app into the public surface described in
// docs/ARCHITECTURE-WEB-SAAS.md §5.

import { Hono } from 'hono'
import { requireAuth } from '../middleware/auth.js'
import { withTenantContext } from '../middleware/tenant.js'
import { health } from './health.js'
import { auth } from './auth.js'
import { me } from './me.js'
import { vaults } from './vaults.js'
import { folders } from './folders.js'
import { notes } from './notes.js'
import { search } from './search.js'
import { rename } from './rename.js'
import { attachments } from './attachments.js'
import { ai } from './ai.js'
import { aiAgent } from './ai-agent.js'
import { ssoAdmin } from './admin/sso.js'
import { usersAdmin } from './admin/users.js'
import { vaultsAdmin } from './admin/vaults.js'

export function buildAppRoutes(): Hono {
  const app = new Hono()

  // Unauthenticated. Health probes for k8s/orchestrators and the OIDC/login
  // handshake live outside the bearer-token gate.
  app.route('/', health)
  app.route('/', auth)

  // Authed surface. Each route module is a Hono sub-app and is mounted under
  // requireAuth + withTenantContext. The route files declare their full
  // internal paths (e.g. `/vaults/:id`, `/notes/:id`, `/ai/chat`) so we mount
  // them at `/` to avoid double-prefixing. The admin sub-apps declare paths
  // relative to their own area (`/providers`, `/invite`, etc.) and are
  // therefore mounted at `/admin/sso` and `/admin/users`.
  const authed = new Hono().use('*', requireAuth, withTenantContext)
  authed.route('/', me)
  authed.route('/', vaults)
  authed.route('/', folders)
  authed.route('/', notes)
  authed.route('/', search)
  authed.route('/', rename)
  authed.route('/', attachments)
  authed.route('/', ai)
  authed.route('/', aiAgent)
  authed.route('/admin/sso', ssoAdmin)
  authed.route('/admin/users', usersAdmin)
  authed.route('/admin/vaults', vaultsAdmin)

  app.route('/', authed)
  return app
}
