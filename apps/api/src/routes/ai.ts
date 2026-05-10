// /ai/* — chat-completion proxy and per-subscription model registry.
//
// Tool execution choice (v1):
//   Tools are executed CLIENT-SIDE in the SPA. When the upstream model emits
//   a `tool_call`, we surface it 1:1 as an `AiStreamEvent` of type
//   `tool_call`. The SPA runs the tool (e.g. `search_vault`) using its own
//   `VaultAdapter`, then POSTs the result to `/ai/chat/tool-result`. The
//   route writes the result into a process-local emitter queue keyed by
//   runId; the in-flight SSE stream forwards it as a `tool_result` event so
//   the SPA's agent loop can include it in the next `/ai/chat` POST.
//
//   This is intentionally simpler than the eventual goal in
//   docs/ARCHITECTURE-WEB-SAAS.md §7 (server-side tools under RLS). The
//   server-side path requires a tighter LiteLLM message-loop integration
//   that is out of scope for v1; it is tracked under agent E follow-ups.
//   The wire format is forward-compatible: when we move tools server-side,
//   `tool_call` and `tool_result` events stay shaped the same way.
//
// Hard rules enforced here:
//   - LITELLM_TOKEN never crosses the request boundary.
//   - Every DB call goes through `withTenant`.
//   - The `ai_runs` row is closed in `finally` even on upstream failure.
//   - `subscriptions.ai_credits_remaining` is decremented atomically.

import { Hono } from 'hono'
import { withTenant } from '../db.js'
import { Forbidden, InvalidInput } from '../lib/errors.js'
import { AI_RATE_LIMIT, rateLimit } from '../middleware/rate-limit.js'
import {
  AiStreamRequestSchema,
  AiToolResultSchema,
  type AiStreamEvent,
} from '../lib/ai-events.js'
import { sseStreamResponse } from '../lib/sse.js'
import { readJson } from '../lib/validate.js'
import { liteLlm, type ChatMessage, type ChatTool, type RawSseFrame } from '../services/litellm.js'
import { listModels, resolveModel } from '../services/model-registry.js'
import {
  decrementCredits,
  finishAiRun,
  startAiRun,
  writeAudit,
} from '../jobs/ai-runs.js'
import { runQueues } from './ai-runs-queue.js'

export const ai = new Hono()

// ── GET /ai/models ────────────────────────────────────────────────────────
ai.get('/ai/models', async (c) => {
  const tenant = c.get('tenant')
  const rows = await listModels(tenant)
  return c.json({
    models: rows.map((r) => ({
      name: r.name,
      provider: r.provider,
      displayName: r.displayName,
      capabilities: r.capabilities,
      defaultForKind: r.defaultForKind,
      // Tenant-scoped overrides advertise themselves so the SPA can show
      // a "custom" badge in the picker.
      scope: r.subscriptionId ? 'subscription' : 'platform',
    })),
  })
})

// Per-user token-bucket on the streaming chat endpoint. Tool-result POSTs
// are exempt because they're driven 1:1 by an active /ai/chat stream — the
// upstream model already paced them, and counting them again would deny
// long agent loops. /ai/models is a cheap read; no limit needed.
const aiUserRateLimit = rateLimit({
  bucket: 'ai',
  scope: 'user',
  ...AI_RATE_LIMIT,
})

// ── POST /ai/chat ─────────────────────────────────────────────────────────
ai.post('/ai/chat', aiUserRateLimit, async (c) => {
  const tenant = c.get('tenant')
  const body = await readJson(c, AiStreamRequestSchema)

  const model = await resolveModel(tenant, body.model)

  const runId = await startAiRun(tenant, {
    vaultId: body.vault_id,
    model: model.name,
  })

  await writeAudit(tenant, {
    action: 'ai.run.start',
    target: runId,
    meta: { model: model.name, vaultId: body.vault_id },
  })

  const upstream = new AbortController()
  const queue = runQueues.create(runId)

  const iterable = streamForRoute({
    runId,
    model: model.name,
    body,
    upstream,
    tenant,
    queue,
  })

  // The SSE helper aborts `upstream` if the client disconnects, which closes
  // the LiteLLM socket. The iterable's `finally` block closes the ai_runs row.
  return sseStreamResponse(c, iterable, { upstream })
})

// ── POST /ai/chat/tool-result ─────────────────────────────────────────────
ai.post('/ai/chat/tool-result', async (c) => {
  const tenant = c.get('tenant')
  const body = await readJson(c, AiToolResultSchema)
  // Belt-and-braces: even if a misbehaving client guesses another tenant's
  // runId, we re-check ownership against ai_runs before pushing the result.
  // RLS makes the SELECT return zero rows when the run belongs to a different
  // tenant, so the ownership check is implicit but explicit code is clearer.
  const ownerCheck = await withTenant(tenant, async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM ai_runs WHERE id = $1`,
      [body.run_id],
    )
    return rows.length > 0
  })
  if (!ownerCheck) throw Forbidden('run_not_found')

  const queue = runQueues.get(body.run_id)
  if (!queue) {
    // The run already ended (or was never on this server). Tell the SPA so
    // it can stop retrying; this is not an audit-worthy event.
    throw InvalidInput('run_not_active')
  }
  queue.push({ type: 'tool_result', id: body.tool_call_id, result: body.result })
  return c.json({ ok: true })
})

// ── stream orchestration ──────────────────────────────────────────────────

interface RouteStreamArgs {
  runId: string
  model: string
  body: ReturnType<typeof AiStreamRequestSchema.parse>
  upstream: AbortController
  tenant: { subscriptionId: string; userId: string }
  queue: ReturnType<typeof runQueues.create>
}

async function* streamForRoute(args: RouteStreamArgs): AsyncIterable<AiStreamEvent> {
  const { runId, model, body, upstream, tenant, queue } = args

  let promptTokens = 0
  let completionTokens = 0
  let status: 'succeeded' | 'failed' | 'aborted' = 'succeeded'
  let errorMessage: string | null = null

  const messages: ChatMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))
  const tools: ChatTool[] | undefined = body.tools?.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.schema },
  }))

  try {
    const upstreamFrames = liteLlm().streamChat(
      { model, messages, tools },
      upstream.signal,
    )

    // Interleave upstream frames with any tool-result events the SPA POSTs
    // back via /ai/chat/tool-result. The queue is drained between upstream
    // frames so a result issued mid-stream is relayed promptly.
    for await (const frame of upstreamFrames) {
      // Drain queued tool results first so they appear in source order.
      let queued = queue.shift()
      while (queued) {
        yield queued
        queued = queue.shift()
      }
      yield* translateFrame(frame, (delta) => {
        completionTokens += delta.completion ?? 0
        promptTokens += delta.prompt ?? 0
      })
    }

    // Final drain after upstream closes.
    let leftover = queue.shift()
    while (leftover) {
      yield leftover
      leftover = queue.shift()
    }

    // Decrement credits for any tokens we observed. If usage was never
    // reported (some providers omit it), we skip the deduction rather than
    // guessing.
    const charge = completionTokens + promptTokens
    const remaining = await decrementCredits(tenant, charge)

    yield {
      type: 'usage',
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      credits_remaining: remaining,
    }
    yield { type: 'done' }
  } catch (err) {
    const aborted = upstream.signal.aborted
    status = aborted ? 'aborted' : 'failed'
    errorMessage = err instanceof Error ? err.message : 'stream failed'
    yield { type: 'error', message: errorMessage }
  } finally {
    runQueues.dispose(runId)

    await finishAiRun(tenant, runId, {
      status,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      error: errorMessage,
    })
    await writeAudit(tenant, {
      action: status === 'succeeded' ? 'ai.run.success' : 'ai.run.failure',
      target: runId,
      meta: {
        model,
        promptTokens,
        completionTokens,
        ...(errorMessage ? { error: errorMessage } : {}),
      },
    })
  }
}

interface UsageDelta {
  prompt?: number
  completion?: number
}

/**
 * Translate one OpenAI-style chat-completion stream frame into zero or more
 * `AiStreamEvent`s. Token deltas become `token` events; tool-call deltas
 * accumulate into a `tool_call` event when they have a parseable arguments
 * JSON. Usage frames update the running counters.
 *
 * Exported for unit tests in `test/ai-chat-route.test.ts`.
 */
export function* translateFrame(
  frame: RawSseFrame,
  onUsage: (delta: UsageDelta) => void,
): Iterable<AiStreamEvent> {
  if (frame.usage) {
    onUsage({
      prompt: frame.usage.prompt_tokens,
      completion: frame.usage.completion_tokens,
    })
  }

  for (const choice of frame.choices ?? []) {
    const delta = choice.delta
    if (!delta) continue

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      yield { type: 'token', delta: delta.content }
    }

    for (const tc of delta.tool_calls ?? []) {
      const id = tc.id ?? `tc_${tc.index ?? 0}`
      const name = tc.function?.name
      if (!name) continue
      // LiteLLM streams arguments as concatenated chunks. We only emit when
      // we have a fully-formed JSON object — partial deltas would be
      // unusable to the SPA.
      const argsString = tc.function?.arguments ?? ''
      let parsed: Record<string, unknown> | null = null
      try {
        parsed = argsString ? (JSON.parse(argsString) as Record<string, unknown>) : {}
      } catch {
        parsed = null
      }
      if (parsed !== null) {
        yield { type: 'tool_call', id, name, args: parsed }
      }
    }
  }
}
