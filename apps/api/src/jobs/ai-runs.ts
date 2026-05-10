// `ai_runs` row helpers.
//
// Despite the file path under `jobs/`, this is not a pg-boss job — it is the
// CRUD wrapper used by the AI route handlers to record one row per AI call.
// The route opens a row before the LiteLLM stream starts and closes it (with
// status + token counts) inside its `finally` block. That guarantee is what
// lets the audit log be reliable even when the upstream call dies mid-stream.
//
// All queries run inside `withTenant`; RLS keeps each tenant scoped to their
// own runs. Errors here must never throw out of the route — callers should
// wrap them so a logging failure doesn't break a user-visible AI response.

import { withTenant, type TenantContext, type PgClient } from '../db.js'
import { logger } from '../lib/logger.js'

export type AiRunStatus = 'running' | 'succeeded' | 'failed' | 'aborted'

export interface AiRunStartArgs {
  vaultId: string | null
  model: string
}

export interface AiRunFinishArgs {
  status: AiRunStatus
  inputTokens?: number
  outputTokens?: number
  error?: string | null
}

/**
 * Insert a fresh `ai_runs` row in the `running` state. Returns the new
 * row id, which the route uses to (a) close the row in its `finally` block
 * and (b) key the per-run tool-result emitter queue.
 */
export async function startAiRun(
  ctx: TenantContext,
  args: AiRunStartArgs,
): Promise<string> {
  return withTenant(ctx, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO ai_runs (subscription_id, vault_id, user_id, model, status)
       VALUES ($1, $2, $3, $4, 'running')
       RETURNING id`,
      [ctx.subscriptionId, args.vaultId, ctx.userId, args.model],
    )
    return rows[0]!.id
  })
}

/**
 * Close an `ai_runs` row. Called from the route's `finally` block, so it is
 * defensive: any DB error is logged and swallowed rather than re-thrown — by
 * the time `finishAiRun` runs the response stream may already be closed.
 */
export async function finishAiRun(
  ctx: TenantContext,
  runId: string,
  args: AiRunFinishArgs,
): Promise<void> {
  try {
    await withTenant(ctx, (client) => updateRun(client, runId, args))
  } catch (err) {
    logger.error({ err, runId }, 'failed to close ai_runs row')
  }
}

async function updateRun(
  client: PgClient,
  runId: string,
  args: AiRunFinishArgs,
): Promise<void> {
  await client.query(
    `UPDATE ai_runs
        SET status        = $2,
            input_tokens  = COALESCE($3, input_tokens),
            output_tokens = COALESCE($4, output_tokens),
            error         = $5,
            finished_at   = now()
      WHERE id = $1`,
    [
      runId,
      args.status,
      args.inputTokens ?? null,
      args.outputTokens ?? null,
      args.error ?? null,
    ],
  )
}

/**
 * Decrement `subscriptions.ai_credits_remaining` by `n` (clamped at zero) and
 * return the post-update value. Atomic — a single UPDATE inside the tenant
 * transaction.
 */
export async function decrementCredits(
  ctx: TenantContext,
  amount: number,
): Promise<number> {
  if (!Number.isFinite(amount) || amount <= 0) {
    // Nothing to charge — just read the current balance.
    const result = await withTenant(ctx, async (client) => {
      const { rows } = await client.query<{ ai_credits_remaining: string }>(
        `SELECT ai_credits_remaining FROM subscriptions WHERE id = $1`,
        [ctx.subscriptionId],
      )
      return rows[0]?.ai_credits_remaining ?? '0'
    })
    return Number(result)
  }
  return withTenant(ctx, async (client) => {
    const { rows } = await client.query<{ ai_credits_remaining: string }>(
      `UPDATE subscriptions
          SET ai_credits_remaining = greatest(ai_credits_remaining - $1, 0),
              updated_at           = now()
        WHERE id = $2
        RETURNING ai_credits_remaining`,
      [Math.floor(amount), ctx.subscriptionId],
    )
    return Number(rows[0]?.ai_credits_remaining ?? '0')
  })
}

export interface AuditWriteArgs {
  action: string
  target?: string | null
  meta?: Record<string, unknown>
}

/**
 * Append an `audit_log` row inside the tenant transaction. Used for
 * `ai.run.{start,success,failure}` events. Failures are logged and swallowed
 * for the same reason as `finishAiRun`.
 */
export async function writeAudit(
  ctx: TenantContext,
  args: AuditWriteArgs,
): Promise<void> {
  try {
    await withTenant(ctx, (client) =>
      client.query(
        `INSERT INTO audit_log (subscription_id, actor_user_id, action, target, meta)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          ctx.subscriptionId,
          ctx.userId,
          args.action,
          args.target ?? null,
          args.meta ?? {},
        ],
      ),
    )
  } catch (err) {
    logger.error({ err, action: args.action }, 'failed to write audit_log')
  }
}
