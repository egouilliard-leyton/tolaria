import type * as oidc from 'openid-client'
import { withPlatformContext, withTenant, type PgClient, type TenantContext } from '../db.js'
import { decryptFromStorage } from '../lib/crypto.js'
import { NotFound } from '../lib/errors.js'
import {
  buildAuthorizeStart,
  exchangeCallback,
  getProviderConfig,
  type AuthorizeStartResult,
  type CallbackResult,
  type ProviderConfigInput,
} from './authentik.js'

// Resolves an `sso_providers` row into a usable OIDC configuration. The same
// row shape covers the platform-default Authentik provider
// (`subscription_id IS NULL`) and per-subscription rows added later through
// agent C's admin UI. Both paths funnel through the same `openid-client`
// primitives in `services/authentik.ts`.

export interface SsoProviderRow {
  id: string
  subscriptionId: string | null
  name: string
  issuerUrl: string
  clientId: string
  clientSecretPlain: string
  scopes: string[]
  defaultRole: 'owner' | 'admin' | 'member'
  jitProvisioning: boolean
}

interface RawRow {
  id: string
  subscription_id: string | null
  name: string
  issuer_url: string
  client_id: string
  client_secret_enc: Buffer
  scopes: string[]
  default_role: string
  jit_provisioning: boolean
}

const ROLE_VALUES = new Set(['owner', 'admin', 'member'] as const)

function rowToProvider(row: RawRow): SsoProviderRow {
  const role = ROLE_VALUES.has(row.default_role as 'owner' | 'admin' | 'member')
    ? (row.default_role as 'owner' | 'admin' | 'member')
    : 'member'
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    name: row.name,
    issuerUrl: row.issuer_url,
    clientId: row.client_id,
    clientSecretPlain: decryptFromStorage(row.client_secret_enc),
    scopes: row.scopes,
    defaultRole: role,
    jitProvisioning: row.jit_provisioning,
  }
}

function toConfigInput(provider: SsoProviderRow): ProviderConfigInput {
  return {
    issuerUrl: provider.issuerUrl,
    clientId: provider.clientId,
    clientSecret: provider.clientSecretPlain,
    scopes: provider.scopes,
  }
}

/**
 * Load a provider row by id. Lookup runs without tenant context (platform
 * scope) because:
 *   - the platform-default row has `subscription_id IS NULL` and is the
 *     public login fallback (RLS allows any session to read it).
 *   - per-subscription rows are read here only at the start/callback of the
 *     OIDC flow, before we know the user's subscription. The RLS policy on
 *     `sso_providers` permits this read because it OR's
 *     `subscription_id IS NULL` with the tenant match — but a missing tenant
 *     var here means we can only read the platform-default. To pick up
 *     per-subscription rows we re-run the query under that tenant once we
 *     know it.
 */
export async function loadProviderById(providerId: string): Promise<SsoProviderRow> {
  const row = await withPlatformContext(async (client) => {
    const r = await client.query<RawRow>(
      `SELECT id, subscription_id, name, issuer_url, client_id,
              client_secret_enc, scopes, default_role, jit_provisioning
         FROM sso_providers WHERE id = $1`,
      [providerId],
    )
    return r.rows[0] ?? null
  })
  if (row) return rowToProvider(row)
  throw NotFound(`SSO provider ${providerId} not found`)
}

/**
 * Load the platform-default Authentik provider row, if one exists. Returns
 * null when the platform has not been seeded yet — the route layer can fall
 * back to env-only configuration (`defaultAuthentikFromEnv`) for first boot.
 */
export async function loadPlatformDefaultProvider(): Promise<SsoProviderRow | null> {
  const row = await withPlatformContext(async (client) => {
    const r = await client.query<RawRow>(
      `SELECT id, subscription_id, name, issuer_url, client_id,
              client_secret_enc, scopes, default_role, jit_provisioning
         FROM sso_providers
         WHERE subscription_id IS NULL
         LIMIT 1`,
    )
    return r.rows[0] ?? null
  })
  return row ? rowToProvider(row) : null
}

/**
 * Lookup a provider that belongs to a known subscription. Used by callers
 * that already have tenant context (e.g. the admin UI editing its own row).
 */
export async function loadTenantProviderById(
  ctx: TenantContext,
  providerId: string,
): Promise<SsoProviderRow> {
  const row = await withTenant(ctx, async (client: PgClient) => {
    const r = await client.query<RawRow>(
      `SELECT id, subscription_id, name, issuer_url, client_id,
              client_secret_enc, scopes, default_role, jit_provisioning
         FROM sso_providers WHERE id = $1`,
      [providerId],
    )
    return r.rows[0] ?? null
  })
  if (row) return rowToProvider(row)
  throw NotFound(`SSO provider ${providerId} not found in subscription`)
}

/**
 * Convenience: get the configured `openid-client` Configuration for a row.
 * Most callers want `startProviderFlow` / `completeProviderFlow` instead.
 */
export async function getConfigForProvider(
  provider: SsoProviderRow,
): Promise<oidc.Configuration> {
  return getProviderConfig(toConfigInput(provider))
}

export async function startProviderFlow(
  provider: SsoProviderRow,
  redirectUri: string,
): Promise<AuthorizeStartResult> {
  return buildAuthorizeStart(toConfigInput(provider), redirectUri)
}

export async function completeProviderFlow(
  provider: SsoProviderRow,
  currentUrl: URL,
  expected: { state: string; codeVerifier: string; nonce: string },
): Promise<CallbackResult> {
  return exchangeCallback(toConfigInput(provider), currentUrl, expected)
}

// Auth flow note: this module is the bridge between the database row that
// represents an OIDC provider and the `openid-client` primitives that drive
// PKCE authorize / callback exchanges. Routes pass the provider id from the
// URL through `loadProviderById` to obtain a fully-decrypted, validated
// `SsoProviderRow`, then call `startProviderFlow` / `completeProviderFlow`.
// Decryption happens here exactly once per request — see `lib/crypto.ts`.
