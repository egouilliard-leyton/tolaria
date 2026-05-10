// Shared audit-log writer.
//
// Per ADR-0115 §Consequences, every mutation that affects tenant data must
// land an `audit_log` row inside the SAME transaction as the action it
// audits — otherwise an action could commit but its audit row could fail to
// land (or vice versa), defeating the point of the log.
//
// `routes/admin/sso.ts` and `routes/admin/users.ts` already use this exact
// shape locally; this module hoists it so the four "data plane" routes
// (vaults, attachments, rename) can use one helper instead of duplicating it.
//
// NOTE: do NOT use the `writeAudit` exported from `jobs/ai-runs.ts` for the
// data-plane call sites — that variant opens its own `withTenant(...)`, which
// means audit + action commit on different transactions. That is acceptable
// for the AI-run lifecycle because the run row is itself the source of truth,
// but it is wrong for vault/attachment/rename mutations.

import type { PoolClient } from 'pg'

export interface AuditTenant {
  subscriptionId: string
  userId: string
}

/**
 * Insert an `audit_log` row using the caller's existing transaction. The
 * caller is responsible for opening that transaction via `withTenant(...)`
 * so RLS sees the right tenant.
 */
export async function writeAudit(
  client: PoolClient,
  tenant: AuditTenant,
  action: string,
  target: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (subscription_id, actor_user_id, action, target, meta)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [tenant.subscriptionId, tenant.userId, action, target, JSON.stringify(meta)],
  )
}
