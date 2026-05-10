// `ai_models` resolver.
//
// The table allows two kinds of rows:
//
//   - `subscription_id IS NOT NULL` — a per-tenant override.
//   - `subscription_id IS NULL`     — a platform-wide fallback.
//
// The RLS policy permits the current tenant to see both. Resolution prefers
// the tenant row when one exists; otherwise it falls back to the platform
// row. If neither row exists (or both are disabled), the route 403s with
// `model_unavailable`. We return only enabled models — disabled rows act
// like they were not configured at all.

import { withTenant, type TenantContext, type PgClient } from '../db.js'
import { Forbidden } from '../lib/errors.js'

export interface AiModelRow {
  id: string
  subscriptionId: string | null
  provider: string
  name: string
  displayName: string
  capabilities: Record<string, unknown>
  enabled: boolean
  defaultForKind: string | null
}

interface DbRow {
  id: string
  subscription_id: string | null
  provider: string
  name: string
  display_name: string
  capabilities: Record<string, unknown>
  enabled: boolean
  default_for_kind: string | null
}

function fromDb(row: DbRow): AiModelRow {
  return {
    id: row.id,
    subscriptionId: row.subscription_id,
    provider: row.provider,
    name: row.name,
    displayName: row.display_name,
    capabilities: row.capabilities,
    enabled: row.enabled,
    defaultForKind: row.default_for_kind,
  }
}

/**
 * Resolve a single model by name. Throws `Forbidden('model_unavailable')` if
 * neither a tenant override nor a platform default is enabled for the name.
 *
 * The query relies on RLS to scope `subscription_id = ctx.subscriptionId`
 * rows automatically; we explicitly include `subscription_id IS NULL` because
 * the policy allows that as well. Ordering by `subscription_id IS NULL ASC`
 * puts the tenant row first when both exist, which is what we want.
 */
export async function resolveModel(
  ctx: TenantContext,
  modelName: string,
): Promise<AiModelRow> {
  const result = await withTenant(ctx, (client) =>
    queryByName(client, modelName),
  )
  if (!result) throw Forbidden('model_unavailable')
  return result
}

async function queryByName(client: PgClient, name: string): Promise<AiModelRow | null> {
  const { rows } = await client.query<DbRow>(
    `SELECT id, subscription_id, provider, name, display_name, capabilities,
            enabled, default_for_kind
       FROM ai_models
      WHERE name = $1
        AND enabled = true
      ORDER BY (subscription_id IS NULL) ASC
      LIMIT 1`,
    [name],
  )
  return rows.length ? fromDb(rows[0]!) : null
}

/**
 * List every model the current tenant can use. Tenant overrides win on
 * collisions: if the same `name` exists both globally and for the
 * subscription, the subscription row appears in the result and the global
 * row is dropped. Disabled rows are omitted.
 */
export async function listModels(ctx: TenantContext): Promise<AiModelRow[]> {
  return withTenant(ctx, async (client) => {
    const { rows } = await client.query<DbRow>(
      `SELECT id, subscription_id, provider, name, display_name, capabilities,
              enabled, default_for_kind
         FROM ai_models
        WHERE enabled = true
        ORDER BY name ASC, (subscription_id IS NULL) ASC`,
    )
    return dedupeByName(rows.map(fromDb))
  })
}

function dedupeByName(rows: AiModelRow[]): AiModelRow[] {
  // Rows are sorted so the tenant row precedes the global row for the same
  // name. We keep the first occurrence of each name.
  const seen = new Set<string>()
  const out: AiModelRow[] = []
  for (const row of rows) {
    if (seen.has(row.name)) continue
    seen.add(row.name)
    out.push(row)
  }
  return out
}
