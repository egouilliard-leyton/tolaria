// /ai/agent/run — server-side agent loop with vault tools.
//
// Difference from `/ai/chat`: tools are executed SERVER-SIDE here. The
// model emits a `tool_call`, the route runs it under the requesting
// user's RLS context (`withTenant`), feeds the JSON result back into
// the conversation, and re-streams the next round. The loop exits when
// the model emits a non-tool response, or when the safety counter
// trips.
//
// Hard rules enforced:
//   - LITELLM_TOKEN never crosses the request boundary.
//   - Every tool execution runs inside `withTenant(...)`.
//   - The `ai_runs` row is closed in `finally` even on upstream failure.
//   - Each tool invocation is audit-logged with `ai.tool.run`.
//
// Wire format: identical event union as `/ai/chat`. Token deltas
// arrive as `event: token`; tool calls as `event: tool_call`; tool
// results (now produced server-side) as `event: tool_result`. The SPA
// can render an agent transcript with the same parser it already has
// for the synchronous chat route.

import { Hono } from 'hono'
import type { Context } from 'hono'
import { withTenant, type PgClient, type TenantContext } from '../db.js'
import { Forbidden, NotFound } from '../lib/errors.js'
import {
  AiStreamRequestSchema,
  type AiStreamEvent,
} from '../lib/ai-events.js'
import { sseStreamResponse } from '../lib/sse.js'
import { readJson } from '../lib/validate.js'
import {
  buildBudgetTags,
  liteLlm,
  type ChatMessage,
  type ChatTool,
} from '../services/litellm.js'
import { estimateCostCents } from '../services/model-cost.js'
import { resolveModel } from '../services/model-registry.js'
import {
  decrementCredits,
  finishAiRun,
  startAiRun,
  writeAudit,
} from '../jobs/ai-runs.js'
import { toNote, toNoteSummary, wordCount } from '../lib/mappers.js'
import { ensureUniqueSlug, slugify } from '../lib/slug.js'
import { AI_RATE_LIMIT, rateLimit } from '../middleware/rate-limit.js'

export const aiAgent = new Hono()

// ── route ────────────────────────────────────────────────────────────────

aiAgent.post(
  '/ai/agent/run',
  rateLimit({ bucket: 'ai', scope: 'user', ...AI_RATE_LIMIT }),
  async (c) => handleAgentRun(c),
)

async function handleAgentRun(c: Context): Promise<Response> {
  const tenant = c.get('tenant')
  const body = await readJson(c, AiStreamRequestSchema)
  const agentMode = body.agent_mode ?? 'sequential'

  const model = await resolveModel(tenant, body.model)

  const runId = await startAiRun(tenant, {
    vaultId: body.vault_id,
    model: model.name,
  })

  await writeAudit(tenant, {
    action: 'ai.run.start',
    target: runId,
    meta: {
      model: model.name,
      vaultId: body.vault_id,
      agent: true,
      agentMode,
    },
  })

  const upstream = new AbortController()

  const iterable = streamAgentLoop({
    runId,
    model: model.name,
    body,
    tenant,
    upstream,
    agentMode,
  })

  return sseStreamResponse(c, iterable, { upstream })
}

// ── agent loop ───────────────────────────────────────────────────────────

interface AgentLoopArgs {
  runId: string
  model: string
  body: ReturnType<typeof AiStreamRequestSchema.parse>
  tenant: TenantContext
  upstream: AbortController
  agentMode: 'sequential' | 'parallel'
}

const SAFETY_CEILING = 20

interface AccumulatedToolCall {
  id: string
  name: string
  arguments: string
}

async function* streamAgentLoop(
  args: AgentLoopArgs,
): AsyncIterable<AiStreamEvent> {
  const { runId, model, body, tenant, upstream, agentMode } = args

  let promptTokens = 0
  let completionTokens = 0
  let status: 'succeeded' | 'failed' | 'aborted' = 'succeeded'
  let errorMessage: string | null = null

  const messages: ChatMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }))

  // The agent route always advertises the built-in vault tool set. If the
  // caller supplied additional tool descriptors we honor them too — the
  // model will simply not be told about runners that don't exist locally,
  // but that lets future tool plumbing add new tools without changing the
  // wire.
  const tools: ChatTool[] = [
    ...AGENT_TOOL_SCHEMAS,
    ...(body.tools ?? []).map<ChatTool>((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.schema,
      },
    })),
  ]

  let safety = SAFETY_CEILING
  let safetyTripped = false

  try {
    while (safety-- > 0) {
      const upstreamFrames = liteLlm().streamChat(
        {
          model,
          messages,
          tools,
          // Per-tenant cost attribution. See litellm.ts header.
          metadataTags: buildBudgetTags({
            subscriptionId: tenant.subscriptionId,
            userId: tenant.userId,
            vaultId: body.vault_id,
            kind: 'agent',
          }),
        },
        upstream.signal,
      )

      const accumulated = new Map<string, AccumulatedToolCall>()
      let assistantText = ''

      for await (const frame of upstreamFrames) {
        if (frame.usage) {
          promptTokens += frame.usage.prompt_tokens ?? 0
          completionTokens += frame.usage.completion_tokens ?? 0
        }
        for (const choice of frame.choices ?? []) {
          const delta = choice.delta
          if (!delta) continue
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            assistantText += delta.content
            yield { type: 'token', delta: delta.content }
          }
          for (const tc of delta.tool_calls ?? []) {
            const id = tc.id ?? `tc_${tc.index ?? 0}`
            const prev =
              accumulated.get(id) ?? { id, name: '', arguments: '' }
            if (tc.function?.name) prev.name = tc.function.name
            if (tc.function?.arguments) prev.arguments += tc.function.arguments
            accumulated.set(id, prev)
          }
        }
      }

      // Emit one tool_call event per fully-formed call. Skip incomplete
      // accumulations (no name, or unparseable arguments) — those would be
      // unusable to the SPA and to the local runner alike.
      const toolCalls: Array<{
        id: string
        name: string
        args: Record<string, unknown>
      }> = []
      for (const [, acc] of accumulated) {
        if (!acc.name) continue
        let parsed: Record<string, unknown>
        try {
          parsed = acc.arguments
            ? (JSON.parse(acc.arguments) as Record<string, unknown>)
            : {}
        } catch {
          continue
        }
        toolCalls.push({ id: acc.id, name: acc.name, args: parsed })
        yield { type: 'tool_call', id: acc.id, name: acc.name, args: parsed }
      }

      // Persist what the assistant emitted so the next round has context.
      // The OpenAI shape allows `tool_calls` on assistant messages even
      // though our `ChatMessage` interface does not declare it. LiteLLM
      // accepts any extra fields, so we cast through unknown.
      messages.push({
        role: 'assistant',
        content: assistantText,
        ...(toolCalls.length
          ? {
              tool_calls: toolCalls.map((t) => ({
                id: t.id,
                type: 'function',
                function: {
                  name: t.name,
                  arguments: JSON.stringify(t.args),
                },
              })),
            }
          : {}),
      } as ChatMessage)

      if (toolCalls.length === 0) {
        // Model produced a final answer. We're done.
        break
      }

      // Run tools. `parallel` runs them concurrently; `sequential` (the
      // default) runs them one after another so a later tool can observe
      // the side effects of an earlier one (e.g. write_note then
      // get_note).
      const runOne = async (tc: {
        id: string
        name: string
        args: Record<string, unknown>
      }): Promise<{ id: string; result: unknown }> => {
        const result = await runTool(tc.name, tc.args, {
          tenant,
          runId,
        }).catch((err: unknown): ToolErrorResult => {
          const code =
            err && typeof err === 'object' && 'code' in err &&
            typeof (err as { code: unknown }).code === 'string'
              ? (err as { code: string }).code
              : 'tool_failed'
          const message =
            err instanceof Error ? err.message : String(err)
          return { error: { code, message } }
        })
        return { id: tc.id, result }
      }

      const results =
        agentMode === 'parallel'
          ? await Promise.all(toolCalls.map(runOne))
          : await runSequential(toolCalls, runOne)

      for (const r of results) {
        yield { type: 'tool_result', id: r.id, result: r.result }
        messages.push({
          role: 'tool',
          tool_call_id: r.id,
          content: JSON.stringify(r.result),
          // OpenAI requires `name` on tool messages; LiteLLM is more
          // forgiving but we set it for portability.
          name: toolCalls.find((t) => t.id === r.id)?.name ?? 'tool',
        } as ChatMessage)
      }

      if (safety === 0) {
        safetyTripped = true
        break
      }
    }

    if (safetyTripped) {
      status = 'failed'
      errorMessage = 'agent_safety_cap_exceeded'
      yield { type: 'error', message: errorMessage }
    } else {
      const charge = completionTokens + promptTokens
      const remaining = await decrementCredits(tenant, charge)
      yield {
        type: 'usage',
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        credits_remaining: remaining,
      }
      yield { type: 'done' }
    }
  } catch (err) {
    const aborted = upstream.signal.aborted
    status = aborted ? 'aborted' : 'failed'
    errorMessage = err instanceof Error ? err.message : 'stream failed'
    yield { type: 'error', message: errorMessage }
  } finally {
    // Bundle K (G49): record per-call cost on `ai_runs.cost_cents`.
    const costCents = estimateCostCents(model, promptTokens, completionTokens)
    await finishAiRun(tenant, runId, {
      status,
      inputTokens: promptTokens,
      outputTokens: completionTokens,
      error: errorMessage,
      costCents,
    })
    await writeAudit(tenant, {
      action: status === 'succeeded' ? 'ai.run.success' : 'ai.run.failure',
      target: runId,
      meta: {
        model,
        promptTokens,
        completionTokens,
        agent: true,
        ...(costCents !== null ? { costCents } : {}),
        ...(errorMessage ? { error: errorMessage } : {}),
      },
    })
  }
}

async function runSequential<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = []
  for (const item of items) {
    out.push(await fn(item))
  }
  return out
}

// ── tool registry ────────────────────────────────────────────────────────
//
// Each tool has (a) a JSON-schema descriptor we hand to LiteLLM in the
// `tools` array and (b) a runner that executes against the requesting
// tenant's RLS context. Adding a tool means appending to both lists.

const AGENT_TOOL_SCHEMAS: ChatTool[] = [
  {
    type: 'function',
    function: {
      name: 'vault.search',
      description:
        'Search the active vault for notes matching a query. Returns up to 25 results sorted by relevance.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search text.' },
          mode: {
            type: 'string',
            enum: ['full', 'prefix'],
            description:
              'full = phrase/keyword (default), prefix = quick-open style trigram match.',
          },
        },
        required: ['query'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vault.list_notes',
      description:
        'List the most recently modified notes in the active vault, optionally filtered to a folder.',
      parameters: {
        type: 'object',
        properties: {
          folder_id: {
            type: ['string', 'null'],
            description: 'Folder UUID, or null for root-level notes.',
          },
        },
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vault.get_note',
      description:
        'Fetch a single note by id, including its body and frontmatter.',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: 'Note UUID.' },
        },
        required: ['note_id'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vault.create_note',
      description:
        'Create a new note in the active vault. Returns the new note id and slug.',
      parameters: {
        type: 'object',
        properties: {
          folder_id: {
            type: ['string', 'null'],
            description: 'Folder UUID or null for the vault root.',
          },
          title: { type: 'string', description: 'Note title.' },
          body_md: { type: 'string', description: 'Markdown body.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'vault.write_note',
      description:
        'Replace a note body. Pass the current `expected_version` for optimistic concurrency.',
      parameters: {
        type: 'object',
        properties: {
          note_id: { type: 'string' },
          body_md: { type: 'string' },
          expected_version: { type: 'integer', minimum: 1 },
        },
        required: ['note_id', 'body_md', 'expected_version'],
        additionalProperties: false,
      },
    },
  },
]

interface ToolContext {
  tenant: TenantContext
  runId: string
}

interface ToolErrorResult {
  error: { code: string; message: string }
}

/**
 * Dispatch a server-side tool call. Every branch runs inside
 * `withTenant(...)` so RLS scopes the query to the requesting user. The
 * caller is responsible for catching errors and shaping them into a
 * `tool_result` payload — a thrown error from here becomes a
 * `tool_failed` error result.
 *
 * Exported so tests can drive the registry without going through the
 * full SSE round trip.
 */
export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  await writeAudit(ctx.tenant, {
    action: 'ai.tool.run',
    target: ctx.runId,
    meta: { run_id: ctx.runId, tool_name: name, tool_args: args },
  })

  switch (name) {
    case 'vault.search':
      return runVaultSearch(args, ctx)
    case 'vault.list_notes':
      return runVaultListNotes(args, ctx)
    case 'vault.get_note':
      return runVaultGetNote(args, ctx)
    case 'vault.create_note':
      return runVaultCreateNote(args, ctx)
    case 'vault.write_note':
      return runVaultWriteNote(args, ctx)
    default:
      throw Object.assign(new Error(`unknown tool: ${name}`), {
        code: 'unknown_tool',
      })
  }
}

function asString(v: unknown, field: string): string {
  if (typeof v !== 'string' || v.length === 0) {
    throw Object.assign(
      new Error(`tool argument ${field} must be a non-empty string`),
      { code: 'invalid_tool_args' },
    )
  }
  return v
}

function asInt(v: unknown, field: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw Object.assign(
      new Error(`tool argument ${field} must be an integer`),
      { code: 'invalid_tool_args' },
    )
  }
  return v
}

async function runVaultSearch(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const query = asString(args.query, 'query')
  const modeRaw = typeof args.mode === 'string' ? args.mode : 'full'
  const mode: 'full' | 'prefix' = modeRaw === 'prefix' ? 'prefix' : 'full'
  const limit = 25

  return withTenant(ctx.tenant, async (client) => {
    if (mode === 'prefix') {
      const { rows } = await client.query<{
        note_id: string
        title: string
        body_md: string
        score: string | number
      }>(
        `SELECT n.id AS note_id,
                n.title,
                n.body_md,
                GREATEST(
                  similarity(n.title, $1),
                  similarity(n.slug, $1),
                  CASE WHEN n.title ILIKE $1 || '%' OR n.slug ILIKE $1 || '%'
                       THEN 1.0 ELSE 0.0 END
                ) AS score
           FROM notes n
          WHERE n.deleted_at IS NULL
            AND (n.title ILIKE $1 || '%'
                 OR n.slug ILIKE $1 || '%'
                 OR n.title % $1
                 OR n.slug % $1)
          ORDER BY score DESC, n.modified_at DESC
          LIMIT $2`,
        [query, limit],
      )
      return {
        mode,
        query,
        results: rows.map((r) => ({
          note_id: r.note_id,
          title: r.title,
          snippet: makeSnippet(r.body_md ?? '', query),
          score: typeof r.score === 'number' ? r.score : Number(r.score),
        })),
      }
    }
    const { rows } = await client.query<{
      note_id: string
      title: string
      snippet: string
      score: string | number
    }>(
      `WITH q AS (SELECT websearch_to_tsquery('simple', $1) AS tsq)
       SELECT n.id AS note_id,
              n.title,
              ts_headline(
                'simple',
                n.body_md,
                q.tsq,
                'MaxWords=20, MinWords=5, ShortWord=3, MaxFragments=2'
              ) AS snippet,
              ts_rank(
                COALESCE(s.ts_doc,
                         to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.body_md, ''))),
                q.tsq
              ) AS score
         FROM notes n
         CROSS JOIN q
         LEFT JOIN note_search s ON s.note_id = n.id
        WHERE n.deleted_at IS NULL
          AND COALESCE(s.ts_doc,
                       to_tsvector('simple', coalesce(n.title, '') || ' ' || coalesce(n.body_md, '')))
              @@ q.tsq
        ORDER BY score DESC, n.modified_at DESC
        LIMIT $2`,
      [query, limit],
    )
    return {
      mode,
      query,
      results: rows.map((r) => ({
        note_id: r.note_id,
        title: r.title,
        snippet: r.snippet,
        score: typeof r.score === 'number' ? r.score : Number(r.score),
      })),
    }
  })
}

function makeSnippet(body: string, q: string): string {
  if (!body) return ''
  const idx = body.toLowerCase().indexOf(q.toLowerCase())
  if (idx < 0) return body.slice(0, 120)
  const start = Math.max(0, idx - 40)
  const end = Math.min(body.length, idx + q.length + 80)
  const prefix = start > 0 ? '…' : ''
  const suffix = end < body.length ? '…' : ''
  return prefix + body.slice(start, end).replace(/\s+/g, ' ').trim() + suffix
}

async function runVaultListNotes(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const folderId =
    args.folder_id === undefined || args.folder_id === null
      ? null
      : asString(args.folder_id, 'folder_id')

  return withTenant(ctx.tenant, async (client) => {
    const params: unknown[] = [50]
    let where = `deleted_at IS NULL`
    if (folderId !== null) {
      params.push(folderId)
      where += ` AND folder_id = $${params.length}`
    }
    const { rows } = await client.query(
      `SELECT id, vault_id, folder_id, slug, title, modified_at, word_count
         FROM notes
        WHERE ${where}
        ORDER BY modified_at DESC, id DESC
        LIMIT $1`,
      params,
    )
    return { items: rows.map(toNoteSummary) }
  })
}

async function runVaultGetNote(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const noteId = asString(args.note_id, 'note_id')
  return withTenant(ctx.tenant, async (client) => {
    const r = await client.query(
      `SELECT id, vault_id, folder_id, slug, title, body_md, frontmatter,
              word_count, version, created_at, modified_at
         FROM notes WHERE id = $1 AND deleted_at IS NULL`,
      [noteId],
    )
    if (r.rowCount === 0) throw NotFound('note not found')
    return toNote(r.rows[0])
  })
}

async function runVaultCreateNote(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const title = asString(args.title, 'title')
  const folderId =
    args.folder_id === undefined || args.folder_id === null
      ? null
      : asString(args.folder_id, 'folder_id')
  const bodyMd = typeof args.body_md === 'string' ? args.body_md : ''
  const baseSlug = slugify(title)

  return withTenant(ctx.tenant, async (client) => {
    const vaultId = await pickVaultId(client, folderId)
    if (folderId) await assertFolderInVault(client, folderId, vaultId)

    const slug = await ensureUniqueSlug(baseSlug, async (candidate) => {
      const r = await client.query(
        `SELECT 1 FROM notes WHERE vault_id = $1 AND slug = $2`,
        [vaultId, candidate],
      )
      return r.rowCount !== null && r.rowCount > 0
    })
    const r = await client.query(
      `INSERT INTO notes
         (vault_id, folder_id, slug, title, body_md, frontmatter, word_count, created_by)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
       RETURNING id, vault_id, folder_id, slug, title, body_md, frontmatter,
                 word_count, version, created_at, modified_at`,
      [
        vaultId,
        folderId,
        slug,
        title,
        bodyMd,
        JSON.stringify({}),
        wordCount(bodyMd),
        ctx.tenant.userId,
      ],
    )
    return toNote(r.rows[0])
  })
}

async function runVaultWriteNote(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<unknown> {
  const noteId = asString(args.note_id, 'note_id')
  const bodyMd = asString(args.body_md, 'body_md')
  const expectedVersion = asInt(args.expected_version, 'expected_version')

  return withTenant(ctx.tenant, async (client) => {
    const cur = await client.query<{
      version: number
      frontmatter: Record<string, unknown>
    }>(
      `SELECT version, frontmatter FROM notes
        WHERE id = $1 AND deleted_at IS NULL
        FOR UPDATE`,
      [noteId],
    )
    const current = cur.rows[0]
    if (!current) throw NotFound('note not found')
    if (current.version !== expectedVersion) {
      throw Object.assign(new Error('version_mismatch'), {
        code: 'version_mismatch',
      })
    }
    const r = await client.query(
      `UPDATE notes
          SET body_md = $2,
              word_count = $3,
              version = version + 1,
              modified_at = now()
        WHERE id = $1
        RETURNING id, vault_id, folder_id, slug, title, body_md, frontmatter,
                  word_count, version, created_at, modified_at`,
      [noteId, bodyMd, wordCount(bodyMd)],
    )
    return toNote(r.rows[0])
  })
}

async function pickVaultId(
  client: PgClient,
  folderId: string | null,
): Promise<string> {
  if (folderId) {
    const f = await client.query<{ vault_id: string }>(
      `SELECT vault_id FROM folders WHERE id = $1`,
      [folderId],
    )
    if (f.rowCount === 0) throw NotFound('folder not found')
    return f.rows[0]!.vault_id
  }
  // Without an explicit folder, pick the tenant's first vault. RLS scopes
  // this to the requesting subscription, so there's no risk of writing
  // into another tenant's vault.
  const v = await client.query<{ id: string }>(
    `SELECT id FROM vaults WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`,
  )
  if (v.rowCount === 0) throw Forbidden('no_vault')
  return v.rows[0]!.id
}

async function assertFolderInVault(
  client: PgClient,
  folderId: string,
  vaultId: string,
): Promise<void> {
  const r = await client.query(
    `SELECT 1 FROM folders WHERE id = $1 AND vault_id = $2`,
    [folderId, vaultId],
  )
  if (r.rowCount === 0) throw NotFound('folder not found')
}
