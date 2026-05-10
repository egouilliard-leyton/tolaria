// /admin/users — owner-or-admin team management. Listing, inviting, role
// changes, and soft-revocation. The "invite" in v1 is best-effort: we insert
// a `users` row with no `password_hash` and return a one-shot signed
// `acceptInviteUrl`. The web auth shell (agent F) will own the
// `/invite/accept` page; we only mint the token here.
//
// See docs/ARCHITECTURE-WEB-SAAS.md §5 and ADR-0117 §"JIT provisioning" for
// the broader provisioning model.

import { Hono } from 'hono'
import { SignJWT } from 'jose'
import { z } from 'zod'
import { withTenant } from '../../db.js'
import { loadEnv } from '../../env.js'
import { Conflict, InvalidInput, NotFound } from '../../lib/errors.js'
import { requireRole } from '../../middleware/require-role.js'

const env = loadEnv()
const JWT_SECRET = new TextEncoder().encode(env.AUTH_JWT_SECRET)
const INVITE_TTL_SECONDS = 60 * 60 * 24 * 7 // 7 days

// ── Schemas ─────────────────────────────────────────────────────────────────

const RoleEnum = z.enum(['owner', 'admin', 'member'])
const InviteRoleEnum = z.enum(['admin', 'member']) // owners are not invited; promoted instead

const InviteSchema = z.object({
  email: z.string().email().max(254),
  role: InviteRoleEnum,
})

const UpdateUserSchema = z.object({
  role: RoleEnum,
})

const UuidSchema = z.string().uuid()

// ── Row shapes ──────────────────────────────────────────────────────────────

interface UserRow {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  display_name: string | null
  password_hash: string | null
  created_at: Date
  updated_at: Date
}

interface UserResponse {
  id: string
  email: string
  role: 'owner' | 'admin' | 'member'
  displayName: string | null
  status: 'active' | 'invited' | 'revoked'
  createdAt: string
  updatedAt: string
}

function rowToResponse(row: UserRow): UserResponse {
  return {
    id: row.id,
    email: row.email,
    role: row.role,
    displayName: row.display_name,
    // TODO: derive status properly once `users.revoked_at` and
    // `users.last_seen_at` columns exist. The intended derivation is:
    //   revoked_at IS NOT NULL                       → 'revoked'
    //   password_hash IS NULL AND last_seen_at IS NULL → 'invited'
    //   else                                          → 'active'
    // Neither column is present in the v1 schema, so per the contract
    // alignment plan we surface everyone as 'active' for now.
    status: 'active',
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  }
}

// ── Sub-app ─────────────────────────────────────────────────────────────────

export const usersAdmin = new Hono()

usersAdmin.use('*', requireRole('owner', 'admin'))

usersAdmin.get('/', async (c) => {
  const tenant = c.get('tenant')
  const rows = await withTenant(tenant, async (client) => {
    const r = await client.query<UserRow>(
      `SELECT id, email, role, display_name, password_hash, created_at, updated_at
         FROM users
        WHERE subscription_id = $1
        ORDER BY created_at ASC`,
      [tenant.subscriptionId],
    )
    return r.rows
  })
  // Bare array — the SPA's `listUsers()` reads the response body as
  // `Member[]`. See src/lib/admin-api.ts.
  return c.json(rows.map(rowToResponse))
})

usersAdmin.post('/invite', async (c) => {
  const tenant = c.get('tenant')
  const parsed = InviteSchema.safeParse(await safeJson(c))
  if (!parsed.success) throw InvalidInput('Invalid invite payload', parsed.error.flatten())
  const { email, role } = parsed.data

  const created = await withTenant(tenant, async (client) => {
    // Reject duplicate emails inside the same subscription. The DB has a
    // UNIQUE (subscription_id, email) constraint; we surface the conflict
    // explicitly so the SPA can show a helpful message.
    const existing = await client.query<{ id: string }>(
      `SELECT id FROM users WHERE subscription_id = $1 AND email = $2`,
      [tenant.subscriptionId, email],
    )
    if (existing.rowCount && existing.rowCount > 0) {
      throw Conflict('A user with this email already belongs to your subscription')
    }

    const insert = await client.query<UserRow>(
      `INSERT INTO users (subscription_id, email, role, password_hash)
       VALUES ($1, $2, $3, NULL)
       RETURNING id, email, role, display_name, password_hash, created_at, updated_at`,
      [tenant.subscriptionId, email, role],
    )
    const row = insert.rows[0]
    if (!row) throw new Error('insert into users returned no row')

    await writeAudit(client, tenant, 'user.invite', row.id, {
      email: row.email,
      role: row.role,
    })
    return row
  })

  const token = await mintInviteToken({
    userId: created.id,
    subscriptionId: tenant.subscriptionId,
    email: created.email,
  })
  const inviteUrl = `${env.WEB_PUBLIC_URL.replace(/\/$/, '')}/invite/accept?token=${encodeURIComponent(token)}`

  // Wire shape matches what the SPA reads in `src/lib/admin-api.ts`
  // (`InviteResult { inviteUrl, member }`). `expiresInSeconds` rides along as
  // an optional sibling so the UI can show a "valid for N days" hint without
  // having to decode the JWT itself.
  return c.json(
    {
      inviteUrl,
      member: rowToResponse(created),
      expiresInSeconds: INVITE_TTL_SECONDS,
    },
    201,
  )
})

usersAdmin.patch('/:id', async (c) => {
  const tenant = c.get('tenant')
  const idParse = UuidSchema.safeParse(c.req.param('id'))
  if (!idParse.success) throw InvalidInput('Invalid user id')
  const userId = idParse.data

  const parsed = UpdateUserSchema.safeParse(await safeJson(c))
  if (!parsed.success) throw InvalidInput('Invalid user payload', parsed.error.flatten())
  const { role: newRole } = parsed.data

  const updated = await withTenant(tenant, async (client) => {
    const current = await client.query<UserRow>(
      `SELECT id, email, role, display_name, password_hash, created_at, updated_at
         FROM users
        WHERE id = $1
          AND subscription_id = $2`,
      [userId, tenant.subscriptionId],
    )
    const before = current.rows[0]
    if (!before) throw NotFound('User not found')

    // Prevent the only owner from demoting themselves and stranding the
    // subscription. We only check when the change is owner -> non-owner on
    // the actor themselves; cross-user demotion of a different owner is
    // allowed only if at least one other owner remains.
    if (before.role === 'owner' && newRole !== 'owner') {
      const ownerCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM users
          WHERE subscription_id = $1
            AND role = 'owner'`,
        [tenant.subscriptionId],
      )
      const remaining = Number(ownerCount.rows[0]?.count ?? '0') - 1
      if (remaining < 1) {
        throw Conflict(
          'Cannot demote the sole owner of this subscription',
          { ownersRemainingIfApplied: remaining },
        )
      }
    }

    const upd = await client.query<UserRow>(
      `UPDATE users
          SET role = $1,
              updated_at = now()
        WHERE id = $2
          AND subscription_id = $3
        RETURNING id, email, role, display_name, password_hash, created_at, updated_at`,
      [newRole, userId, tenant.subscriptionId],
    )
    const row = upd.rows[0]
    if (!row) throw NotFound('User not found')

    await writeAudit(client, tenant, 'user.role_change', row.id, {
      from: before.role,
      to: row.role,
    })
    return row
  })

  return c.json(rowToResponse(updated))
})

usersAdmin.delete('/:id', async (c) => {
  const tenant = c.get('tenant')
  const idParse = UuidSchema.safeParse(c.req.param('id'))
  if (!idParse.success) throw InvalidInput('Invalid user id')
  const userId = idParse.data

  const result = await withTenant(tenant, async (client) => {
    const current = await client.query<UserRow>(
      `SELECT id, email, role, display_name, password_hash, created_at, updated_at
         FROM users
        WHERE id = $1
          AND subscription_id = $2`,
      [userId, tenant.subscriptionId],
    )
    const before = current.rows[0]
    if (!before) throw NotFound('User not found')

    // Same sole-owner protection on revoke.
    if (before.role === 'owner') {
      const ownerCount = await client.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count
           FROM users
          WHERE subscription_id = $1
            AND role = 'owner'`,
        [tenant.subscriptionId],
      )
      const remaining = Number(ownerCount.rows[0]?.count ?? '0') - 1
      if (remaining < 1) {
        throw Conflict('Cannot revoke the sole owner of this subscription')
      }
    }

    // Soft-revoke: clear refresh tokens, drop vault memberships, downgrade to
    // member. We never hard-delete a user — the audit log references them.
    await client.query(
      `UPDATE refresh_tokens
          SET revoked_at = now()
        WHERE user_id = $1
          AND subscription_id = $2
          AND revoked_at IS NULL`,
      [userId, tenant.subscriptionId],
    )
    await client.query(
      `DELETE FROM vault_members
        WHERE user_id = $1`,
      [userId],
    )
    const upd = await client.query<UserRow>(
      `UPDATE users
          SET role = 'member',
              updated_at = now()
        WHERE id = $1
          AND subscription_id = $2
        RETURNING id, email, role, display_name, password_hash, created_at, updated_at`,
      [userId, tenant.subscriptionId],
    )
    const after = upd.rows[0]
    if (!after) throw NotFound('User not found')

    await writeAudit(client, tenant, 'user.revoke', after.id, {
      previousRole: before.role,
    })
    return after
  })

  // Bind `result` so the audit-side effects above remain typed; the SPA
  // expects 204 No Content, not the soft-revoked row.
  void result
  return c.body(null, 204)
})

// ── Invite token ────────────────────────────────────────────────────────────

interface InviteClaims {
  userId: string
  subscriptionId: string
  email: string
}

async function mintInviteToken(claims: InviteClaims): Promise<string> {
  return new SignJWT({
    sid: claims.subscriptionId,
    email: claims.email,
    purpose: 'invite',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(env.API_PUBLIC_URL)
    .setAudience('tolaria-invite')
    .setIssuedAt()
    .setExpirationTime(`${INVITE_TTL_SECONDS}s`)
    .sign(JWT_SECRET)
}

// ── Helpers ─────────────────────────────────────────────────────────────────

async function safeJson(c: import('hono').Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw InvalidInput('Request body must be valid JSON')
  }
}

async function writeAudit(
  client: import('pg').PoolClient,
  tenant: { subscriptionId: string; userId: string },
  action: string,
  target: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (subscription_id, actor_user_id, action, target, meta)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenant.subscriptionId, tenant.userId, action, target, meta],
  )
}
