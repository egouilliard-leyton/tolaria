import type { Job } from 'pg-boss'
import pino from 'pino'
import { z } from 'zod'
import { withTenant, type PgClient, type TenantContext } from '../lib/db.js'
import { enqueueIndexNote } from '../lib/jobs.js'
import { createLiteLlmClient, type ChatMessage } from '../lib/litellm.js'

const log = pino({ base: { app: 'tolaria-worker', queue: 'ai-tool-run' } })

const AiToolRunPayload = z.object({
  subscriptionId: z.string().uuid(),
  vaultId: z.string().uuid(),
  userId: z.string().uuid(),
  runId: z.string().uuid(),
  model: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
})
export type AiToolRunPayload = z.infer<typeof AiToolRunPayload>

const SUMMARIZE_NOTE_LIMIT = 50

interface SummarizeOptions {
  litellm?: ReturnType<typeof createLiteLlmClient>
  noteLimit?: number
}

/**
 * Long-running AI tool dispatcher. v1 implements two tools:
 *
 *   - `summarize-vault`  Read up to N most-recently-modified notes in the
 *                        vault and ask LiteLLM for a single summary.
 *                        Result lands in `ai_runs.output_text`.
 *   - `rebuild-graph`    Enumerate every non-deleted note in the vault and
 *                        enqueue an `index-note` job for each so the search
 *                        index and link graph converge to fresh state.
 *
 * Anything else fails the run with `unsupported_tool` so the SPA can show
 * a stable error and we don't end up silently completing a job that did
 * nothing.
 */
export async function handleAiToolRun(
  job: Job<unknown>,
  opts: SummarizeOptions = {},
): Promise<void> {
  const payload = AiToolRunPayload.parse(job.data)
  const ctx: TenantContext = {
    subscriptionId: payload.subscriptionId,
    userId: payload.userId,
  }

  log.info(
    { runId: payload.runId, tool: payload.tool, vaultId: payload.vaultId },
    'ai-tool-run start',
  )

  try {
    if (payload.tool === 'summarize-vault') {
      await summarizeVault(ctx, payload, opts)
      return
    }
    if (payload.tool === 'rebuild-graph') {
      await rebuildGraph(ctx, payload)
      return
    }
    await failRun(ctx, payload.runId, 'unsupported_tool')
  } catch (err) {
    const message = err instanceof Error ? err.message : 'unknown_error'
    log.error({ err, runId: payload.runId }, 'ai-tool-run failed')
    await failRun(ctx, payload.runId, message)
    // Re-throw so pg-boss tracks the failure for retries / metrics.
    throw err
  }
}

async function summarizeVault(
  ctx: TenantContext,
  payload: AiToolRunPayload,
  opts: SummarizeOptions,
): Promise<void> {
  const limit = opts.noteLimit ?? SUMMARIZE_NOTE_LIMIT
  const notes = await withTenant(ctx, async (client) => {
    const { rows } = await client.query<{ title: string; body_md: string }>(
      `SELECT title, body_md
         FROM notes
        WHERE vault_id = $1 AND deleted_at IS NULL
        ORDER BY modified_at DESC
        LIMIT $2`,
      [payload.vaultId, limit],
    )
    return rows
  })

  const litellm = opts.litellm ?? createLiteLlmClient()
  const messages: ChatMessage[] = [
    {
      role: 'system',
      content:
        'Summarize the following notes into a concise overview. Preserve any decisions, action items, and named entities.',
    },
    {
      role: 'user',
      content: notes
        .map((n) => `# ${n.title}\n\n${n.body_md ?? ''}`)
        .join('\n\n---\n\n'),
    },
  ]

  const result = await litellm.chat({ model: payload.model, messages })

  await withTenant(ctx, async (client) => {
    await client.query(
      `UPDATE ai_runs
          SET status        = 'succeeded',
              finished_at   = now(),
              input_tokens  = $2,
              output_tokens = $3,
              output_text   = $4
        WHERE id = $1`,
      [
        payload.runId,
        result.promptTokens,
        result.completionTokens,
        result.content,
      ],
    )
    await writeAudit(client, ctx, 'ai.tool_run.completed', payload.runId, {
      tool: payload.tool,
      vault_id: payload.vaultId,
      note_count: notes.length,
      prompt_tokens: result.promptTokens,
      completion_tokens: result.completionTokens,
    })
  })
}

async function rebuildGraph(
  ctx: TenantContext,
  payload: AiToolRunPayload,
): Promise<void> {
  const noteIds = await withTenant(ctx, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM notes
        WHERE vault_id = $1 AND deleted_at IS NULL`,
      [payload.vaultId],
    )
    return rows.map((r) => r.id)
  })

  for (const id of noteIds) {
    await enqueueIndexNote({
      subscriptionId: payload.subscriptionId,
      vaultId: payload.vaultId,
      noteId: id,
    })
  }

  await withTenant(ctx, async (client) => {
    await client.query(
      `UPDATE ai_runs
          SET status      = 'succeeded',
              finished_at = now()
        WHERE id = $1`,
      [payload.runId],
    )
    await writeAudit(client, ctx, 'ai.tool_run.completed', payload.runId, {
      tool: payload.tool,
      vault_id: payload.vaultId,
      enqueued_index_jobs: noteIds.length,
    })
  })
}

async function failRun(
  ctx: TenantContext,
  runId: string,
  error: string,
): Promise<void> {
  await withTenant(ctx, async (client) => {
    await client.query(
      `UPDATE ai_runs
          SET status      = 'failed',
              finished_at = now(),
              error       = $2
        WHERE id = $1`,
      [runId, error],
    )
  })
}

async function writeAudit(
  client: PgClient,
  ctx: TenantContext,
  action: string,
  target: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await client.query(
    `INSERT INTO audit_log (subscription_id, actor_user_id, action, target, meta)
     VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [
      ctx.subscriptionId,
      ctx.userId ?? null,
      action,
      target,
      JSON.stringify(meta),
    ],
  )
}
