import { Hono } from 'hono'
import { tenantQuery } from '../db.js'
import { Unauthenticated } from '../lib/errors.js'

// `GET /me` returns the smallest blob the SPA needs to render the chrome:
// the current user record, the subscription summary, and the user's role
// within that subscription. Mounted under `requireAuth + withTenantContext`
// in `routes/index.ts`, so the access-token claims are guaranteed to be on
// `c.get('user')` and the tenant transaction is always scoped to the right
// subscription via RLS.

export const me = new Hono()

interface UserRow {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  display_name: string | null
  created_at: Date
}

interface SubscriptionRow {
  id: string
  name: string
  plan: string
  ai_credits_remaining: string // bigint serialized as string by pg
  created_at: Date
}

me.get('/me', async (c) => {
  const tenant = c.get('tenant')
  const claims = c.get('user')

  const userResult = await tenantQuery<UserRow>(
    tenant,
    `SELECT id, email::text AS email, role::text AS role, display_name, created_at
       FROM users WHERE id = $1`,
    [claims.sub],
  )
  const userRow = userResult.rows[0]
  if (!userRow) throw Unauthenticated('User no longer exists')

  const subResult = await tenantQuery<SubscriptionRow>(
    tenant,
    `SELECT id, name, plan, ai_credits_remaining::text AS ai_credits_remaining, created_at
       FROM subscriptions WHERE id = $1`,
    [tenant.subscriptionId],
  )
  const subRow = subResult.rows[0]
  if (!subRow) throw Unauthenticated('Subscription no longer exists')

  return c.json({
    user: {
      id: userRow.id,
      email: userRow.email,
      role: userRow.role,
      display_name: userRow.display_name,
      created_at: userRow.created_at.toISOString(),
    },
    subscription: {
      id: subRow.id,
      name: subRow.name,
      plan: subRow.plan,
      ai_credits_remaining: Number(subRow.ai_credits_remaining),
      created_at: subRow.created_at.toISOString(),
    },
    role: userRow.role,
  })
})

// Auth flow note: this is the SPA's "did my access token still work?" probe.
// Combined with `POST /auth/refresh`, it is the only network call required to
// boot the app once the refresh cookie is in place — see plan §6.
