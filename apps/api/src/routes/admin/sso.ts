// /admin/sso/providers — owner-only CRUD over the per-subscription SSO
// providers a customer has registered. The platform-default Authentik row
// (subscription_id IS NULL) is read by RLS for any tenant but cannot be
// mutated through this surface; only the platform setup script touches it.
// See ADR-0117 §"Specifics" and docs/ARCHITECTURE-WEB-SAAS.md §5.

import { Hono } from 'hono'
import { z } from 'zod'
import { withTenant } from '../../db.js'
import { Conflict, InvalidInput, NotFound } from '../../lib/errors.js'
import { fetchDiscoveryDocument } from '../../lib/discovery-fetcher.js'
import { requireRole } from '../../middleware/require-role.js'
import { encryptToStorage } from '../../services/secret-encryption.js'

// ── Schemas ─────────────────────────────────────────────────────────────────

const RoleEnum = z.enum(['owner', 'admin', 'member'])

const CreateProviderSchema = z.object({
  name: z.string().min(1).max(120),
  issuerUrl: z.string().url(),
  clientId: z.string().min(1).max(255),
  clientSecret: z.string().min(1).max(2048),
  scopes: z.array(z.string().min(1)).min(1).max(20).optional(),
  defaultRole: RoleEnum.optional(),
  jitProvisioning: z.boolean().optional(),
})

const UpdateProviderSchema = z
  .object({
    name: z.string().min(1).max(120).optional(),
    issuerUrl: z.string().url().optional(),
    clientId: z.string().min(1).max(255).optional(),
    clientSecret: z.string().min(1).max(2048).optional(),
    scopes: z.array(z.string().min(1)).min(1).max(20).optional(),
    defaultRole: RoleEnum.optional(),
    jitProvisioning: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'At least one field is required' })

const UuidSchema = z.string().uuid()

// ── Row shape ───────────────────────────────────────────────────────────────

interface ProviderRow {
  id: string
  subscription_id: string | null
  name: string
  protocol: string
  issuer_url: string
  client_id: string
  client_secret_enc: Buffer | null
  scopes: string[]
  default_role: string
  jit_provisioning: boolean
  created_at: Date
}

interface ProviderResponse {
  id: string
  name: string
  protocol: string
  issuerUrl: string
  clientId: string
  clientSecretSet: boolean
  scopes: string[]
  defaultRole: string
  jitProvisioning: boolean
  createdAt: string
}

function rowToResponse(row: ProviderRow): ProviderResponse {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecretSet: row.client_secret_enc !== null && row.client_secret_enc.length > 0,
    scopes: row.scopes,
    defaultRole: row.default_role,
    jitProvisioning: row.jit_provisioning,
    createdAt: row.created_at.toISOString(),
  }
}

// ── Sub-app ─────────────────────────────────────────────────────────────────

export const ssoAdmin = new Hono()

ssoAdmin.use('*', requireRole('owner'))

ssoAdmin.get('/providers', async (c) => {
  const tenant = c.get('tenant')
  const rows = await withTenant(tenant, async (client) => {
    const r = await client.query<ProviderRow>(
      `SELECT id, subscription_id, name, protocol, issuer_url, client_id,
              client_secret_enc, scopes, default_role, jit_provisioning, created_at
         FROM sso_providers
        WHERE subscription_id = $1
        ORDER BY created_at ASC`,
      [tenant.subscriptionId],
    )
    return r.rows
  })
  // Bare array — the SPA's `listSsoProviders()` reads the response body as
  // `SsoProvider[]`. See src/lib/admin-api.ts.
  return c.json(rows.map(rowToResponse))
})

ssoAdmin.post('/providers', async (c) => {
  const tenant = c.get('tenant')
  const parsed = CreateProviderSchema.safeParse(await safeJson(c))
  if (!parsed.success) throw InvalidInput('Invalid provider payload', parsed.error.flatten())
  const input = parsed.data

  // Validate the issuer by fetching its discovery doc. Throws InvalidInput on
  // any failure mode — see lib/discovery-fetcher.ts.
  await fetchDiscoveryDocument(input.issuerUrl)

  const encryptedSecret = encryptToStorage(input.clientSecret)
  const scopes = input.scopes ?? ['openid', 'profile', 'email']
  const defaultRole = input.defaultRole ?? 'member'
  const jit = input.jitProvisioning ?? false

  const created = await withTenant(tenant, async (client) => {
    const insert = await client.query<ProviderRow>(
      `INSERT INTO sso_providers
         (subscription_id, name, protocol, issuer_url, client_id,
          client_secret_enc, scopes, default_role, jit_provisioning)
       VALUES ($1, $2, 'oidc', $3, $4, $5, $6, $7, $8)
       RETURNING id, subscription_id, name, protocol, issuer_url, client_id,
                 client_secret_enc, scopes, default_role, jit_provisioning, created_at`,
      [
        tenant.subscriptionId,
        input.name,
        input.issuerUrl,
        input.clientId,
        encryptedSecret,
        scopes,
        defaultRole,
        jit,
      ],
    )
    const row = insert.rows[0]
    if (!row) throw new Error('insert into sso_providers returned no row')
    await writeAudit(client, tenant, 'sso_provider.create', row.id, {
      name: row.name,
      issuerUrl: row.issuer_url,
    })
    return row
  })

  return c.json({ provider: rowToResponse(created) }, 201)
})

ssoAdmin.patch('/providers/:id', async (c) => {
  const tenant = c.get('tenant')
  const idParse = UuidSchema.safeParse(c.req.param('id'))
  if (!idParse.success) throw InvalidInput('Invalid provider id')
  const providerId = idParse.data

  const parsed = UpdateProviderSchema.safeParse(await safeJson(c))
  if (!parsed.success) throw InvalidInput('Invalid update payload', parsed.error.flatten())
  const input = parsed.data

  if (input.issuerUrl) {
    await fetchDiscoveryDocument(input.issuerUrl)
  }

  // Build a dynamic UPDATE so unspecified fields keep their existing bytes.
  const sets: string[] = []
  const params: unknown[] = []
  let i = 1
  if (input.name !== undefined) {
    sets.push(`name = $${i++}`)
    params.push(input.name)
  }
  if (input.issuerUrl !== undefined) {
    sets.push(`issuer_url = $${i++}`)
    params.push(input.issuerUrl)
  }
  if (input.clientId !== undefined) {
    sets.push(`client_id = $${i++}`)
    params.push(input.clientId)
  }
  if (input.clientSecret !== undefined) {
    sets.push(`client_secret_enc = $${i++}`)
    params.push(encryptToStorage(input.clientSecret))
  }
  if (input.scopes !== undefined) {
    sets.push(`scopes = $${i++}`)
    params.push(input.scopes)
  }
  if (input.defaultRole !== undefined) {
    sets.push(`default_role = $${i++}`)
    params.push(input.defaultRole)
  }
  if (input.jitProvisioning !== undefined) {
    sets.push(`jit_provisioning = $${i++}`)
    params.push(input.jitProvisioning)
  }

  // Refuse if all fields were absent — the schema already prevents this, but
  // belt-and-braces because the dynamic SQL would otherwise be invalid.
  if (sets.length === 0) throw InvalidInput('At least one field is required')

  // Tenant scope: id and subscription_id checks together prevent cross-tenant
  // updates even if RLS were misconfigured.
  params.push(providerId, tenant.subscriptionId)
  const idIdx = i++
  const subIdx = i

  const updated = await withTenant(tenant, async (client) => {
    const upd = await client.query<ProviderRow>(
      `UPDATE sso_providers
          SET ${sets.join(', ')}
        WHERE id = $${idIdx}
          AND subscription_id = $${subIdx}
        RETURNING id, subscription_id, name, protocol, issuer_url, client_id,
                  client_secret_enc, scopes, default_role, jit_provisioning, created_at`,
      params,
    )
    const row = upd.rows[0]
    if (!row) throw NotFound('SSO provider not found')
    await writeAudit(client, tenant, 'sso_provider.update', row.id, {
      // Audit field names that changed (NOT values; never log secrets).
      changed: Object.keys(input).filter((k) => k !== 'clientSecret'),
      clientSecretRotated: input.clientSecret !== undefined,
    })
    return row
  })

  return c.json({ provider: rowToResponse(updated) })
})

ssoAdmin.delete('/providers/:id', async (c) => {
  const tenant = c.get('tenant')
  const idParse = UuidSchema.safeParse(c.req.param('id'))
  if (!idParse.success) throw InvalidInput('Invalid provider id')
  const providerId = idParse.data

  const removed = await withTenant(tenant, async (client) => {
    const del = await client.query<ProviderRow>(
      `DELETE FROM sso_providers
        WHERE id = $1
          AND subscription_id = $2
        RETURNING id, name, issuer_url`,
      [providerId, tenant.subscriptionId],
    )
    const row = del.rows[0]
    if (!row) throw NotFound('SSO provider not found')
    await writeAudit(client, tenant, 'sso_provider.delete', row.id, {
      name: row.name,
      issuerUrl: row.issuer_url,
    })
    return row
  })

  return c.json({ deleted: { id: removed.id } })
})

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

// Conflict is re-exported for callers that hit the platform-default conflict
// path in the future; not used yet but referenced in the orchestrator's audit
// of import surface.
export { Conflict as _Conflict }
